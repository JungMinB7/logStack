#!/bin/bash
# EC2 runtime only; never execute on a developer machine.
set -euo pipefail
set +x
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin
ADMIN=/usr/local/lib/logstack/db-admin.py
MARKER=/var/lib/logstack-db-install.json
VENDOR_DATA=/var/lib/pgsql/data
GPG_KEY=/etc/pki/rpm-gpg/RPM-GPG-KEY-amazon-linux-2023
fail() { printf '%s\n' '{"component":"db-install","status":"failed","action":"inspect-pinned-repository-and-rpm-state"}' >&2; exit 1; }

install_runtime() {
  python3 "$ADMIN" check-os || fail
  if [[ -e "$MARKER" ]]; then
    python3 "$ADMIN" install-check || fail
    python3 "$ADMIN" check-image || fail
    return
  fi
  # A partial package transaction may be retried, but no existing PG process or
  # vendor cluster is stopped, removed, or re-initialized by this installer.
  if pgrep -x postgres >/dev/null; then fail; else [[ $? == 1 ]] || fail; fi
  [[ ! -L "$VENDOR_DATA" ]] || fail
  if [[ -d "$VENDOR_DATA" ]]; then
    [[ -z $(find "$VENDOR_DATA" -mindepth 1 -maxdepth 1 -print -quit) ]] || fail
  fi
  systemctl mask postgresql.service postgresql@.service >/dev/null || fail
  [[ -f "$GPG_KEY" ]] || fail
  local package_lines release package
  package_lines=$(python3 "$ADMIN" package-nevras) || fail
  packages=()
  while IFS= read -r package; do packages+=("$package"); done <<< "$package_lines"
  [[ ${#packages[@]} -gt 0 ]] || fail
  release=$(python3 "$ADMIN" setting al2023_release)
  # Only pinned repository/NEVRAs; no global upgrade, no unsigned RPM install,
  # no internet fallback, and no weak-dependency expansion.
  dnf -y --releasever="$release" --disablerepo='*' --enablerepo=logstack-approved \
    --setopt=install_weak_deps=False --setopt=ip_resolve=4 install "${packages[@]}" || fail
  python3 "$ADMIN" check-image || fail
  python3 "$ADMIN" configure-time || fail
  systemctl enable --now amazon-ssm-agent.service >/dev/null || fail
  systemctl enable chronyd.service >/dev/null || fail
  systemctl restart chronyd.service >/dev/null || fail
  python3 "$ADMIN" install-record || fail
  printf '%s\n' '{"component":"db-install","status":"installed","pg_major":16}'
}

main() {
  [[ $EUID == 0 && $(uname -s) == Linux ]] || fail
  exec 8>/run/logstack-db-install.lock
  flock -n 8 || fail
  install_runtime
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
