#!/bin/bash
# EC2 runtime only. Tests source functions; never execute this on a workstation.
set -euo pipefail
set +x
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin
export AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
unset PGOPTIONS PGPASSWORD PGSERVICE PGSERVICEFILE PGHOST PGPORT PGUSER PGDATABASE
CONFIG=/etc/logstack-db.json
ADMIN=/usr/local/lib/logstack/db-admin.py
MOUNT=/srv/logstack-db
DATA=/srv/logstack-db/pgdata

die() { printf '%s\n' '{"component":"db-bootstrap","status":"failed","action":"inspect-protected-runtime-diagnostics"}' >&2; exit 1; }
setting() { python3 "$ADMIN" setting "$1"; }
as_pg() { runuser -u postgres -- "$@"; }

verify_mount() {
  [[ ! -L "$MOUNT" && -d "$MOUNT" ]] || die
  local source fstype options
  source=$(findmnt -rn --mountpoint "$MOUNT" -o SOURCE) || die
  fstype=$(findmnt -rn --mountpoint "$MOUNT" -o FSTYPE) || die
  options=$(findmnt -rn --mountpoint "$MOUNT" -o OPTIONS) || die
  [[ $(readlink -f "$source") == "$DEVICE" && "$fstype" == ext4 ]] || die
  [[ ",$options," == *,rw,* && ",$options," == *,nodev,* && ",$options," == *,nosuid,* && ",$options," == *,noexec,* ]] || die
  [[ $(findmnt -rn --mountpoint / -o SOURCE | xargs readlink -f) != "$DEVICE" ]] || die
}

prepare_mount() {
  [[ ! -L "$MOUNT" ]] || die
  mkdir -p "$MOUNT"
  if findmnt -rn --mountpoint "$MOUNT" >/dev/null; then verify_mount; return; fi
  [[ -z $(find "$MOUNT" -mindepth 1 -maxdepth 1 -print -quit) ]] || die
  # Device selector rejects partitions, root devices and mounts anywhere else.
  local fs
  fs=$(blkid -p -o value -s TYPE "$DEVICE") || {
    [[ $? == 2 ]] || die
    fs=''
  }
  if [[ -z "$fs" ]]; then
    [[ $(setting allow_blank_volume_init) == true ]] || die
    # No signature of ANY type, not merely no recognised filesystem.
    wipefs --no-act --json "$DEVICE" | python3 "$ADMIN" blank-signatures || die
    mkfs.ext4 -m 0 "$DEVICE" >/dev/null 2>&1 || die
  elif [[ "$fs" != ext4 ]]; then die; fi
  mount -t ext4 -o nodev,nosuid,noexec "$DEVICE" "$MOUNT" || die
  verify_mount
}

verify_cluster() {
  verify_mount
  [[ ! -L "$DATA" && -f "$DATA/PG_VERSION" && $(<"$DATA/PG_VERSION") == 16 ]] || die
  python3 "$ADMIN" identity-check || die
  as_pg "$PG_BIN/pg_controldata" "$DATA" >/dev/null 2>&1 || die
}

prepare_cluster() {
  verify_mount
  local identity
  identity=$(python3 "$ADMIN" identity-prepare) || die
  if [[ ! -e "$DATA" ]]; then
    [[ "$identity" == new ]] || die
    install -d -m 0700 -o postgres -g postgres "$DATA"
    # A failed/partial init is preserved and will not be retried destructively.
    as_pg "$PG_BIN/initdb" -D "$DATA" --encoding=UTF8 --locale=C --data-checksums --auth-local=peer --auth-host=scram-sha-256 >/dev/null 2>&1 || die
  fi
  verify_cluster
  python3 "$ADMIN" config || die
  install -d -m 0700 -o postgres -g postgres /run/logstack-db-private
  # Only a private Unix socket while roles are configured. No TCP even if an old
  # postgres config was recovered. pg_ctl supplies explicit log overrides.
  as_pg "$PG_BIN/pg_ctl" -D "$DATA" -l /run/logstack-db-private/bootstrap.log -w -t 60 -o "-c listen_addresses='' -c unix_socket_directories=/run/logstack-db-private -c log_statement=none -c log_min_error_statement=panic -c log_min_messages=panic -c logging_collector=off" start >/dev/null 2>&1 || die
  trap 'as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w -t 60 stop >/dev/null 2>&1 || true' EXIT
  python3 "$ADMIN" roles || die
  as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w -t 60 stop >/dev/null 2>&1 || die
  trap - EXIT
}

main() {
  [[ $EUID == 0 && $(uname -s) == Linux ]] || die
  [[ $# == 1 && ( $1 == prepare || $1 == verify ) ]] || die
  for command in python3 aws lsblk blkid wipefs mount findmnt readlink runuser flock chronyc systemctl ss pgrep mkfs.ext4 cloud-init; do command -v "$command" >/dev/null || die; done
  exec 9>/run/logstack-db-bootstrap.lock
  flock -n 9 || die
  python3 "$ADMIN" check-image || die
  PG_BIN=$(setting pg_bin)
  DEVICE=''
  # Attachment follows instance creation in Terraform. Bounded wait does not
  # guess a different disk and uses no EC2 API/network request.
  for ((attempt=0; attempt<120; attempt++)); do
    if DEVICE=$(python3 "$ADMIN" device 2>/dev/null); then break; fi
    sleep 2
  done
  [[ -n "$DEVICE" && -b "$DEVICE" ]] || die
  if [[ $1 == verify ]]; then verify_cluster; return; fi
  python3 "$ADMIN" check-no-server || die
  systemctl is-active --quiet "$(setting ssm_service)" || die
  systemctl is-active --quiet "$(setting chrony_service)" || die
  # The AMI must already configure only Amazon Time Sync; no internet NTP.
  chronyc waitsync 30 0.1 >/dev/null 2>&1 || die
  chronyc -n sources | python3 "$ADMIN" time-source || die
  prepare_mount
  prepare_cluster
  printf '%s\n' '{"component":"db-bootstrap","status":"prepared","pg_major":16}'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
