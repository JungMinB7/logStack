#!/usr/bin/env python3
"""Approved daily EC2 runtime dump to the dedicated seven-day S3 prefix.

The systemd timer and exact IAM/endpoint are provisioned by T5 Terraform.
Local failed/successful artifacts remain until a separate local cleanup policy;
the seven-day S3 lifecycle is not local disk cleanup or restore verification.
Never runs on a workstation; tests inject the command runner.
"""
from datetime import datetime, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid


def execute(args, **kwargs):
    return subprocess.run(args, check=True, stderr=subprocess.DEVNULL,
                          timeout=3600, **({'stdout': subprocess.DEVNULL} | kwargs))


def backup(config, destination, runner=execute):
    # UUID prevents overwriting a previous success, even under clock correction.
    name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex
    partial = destination / (name + '.partial')
    complete = destination / (name + '.dump')
    with partial.open('xb') as output:
        os.chmod(partial, 0o600)
        # stdout is deliberately a protected binary file, never journal output.
        runner(['runuser', '-u', 'postgres', '--', config['pg_bin'] + '/pg_dump',
                '-h', '/run/logstack-db-private', '-U', 'postgres',
                '-d', config['database'], '--format=custom'], stdout=output)
        output.flush()
        os.fsync(output.fileno())
    runner([config['pg_bin'] + '/pg_restore', '--list', str(partial)])
    os.replace(partial, complete)
    directory_fd = os.open(destination, os.O_RDONLY)
    try: os.fsync(directory_fd)
    finally: os.close(directory_fd)
    key = config['prefix'] + complete.name
    # s3api PutObject has no implicit multipart/ACL/ListBucket permissions.
    # Strict size guard: larger dumps need a separately approved multipart design.
    if complete.stat().st_size >= 5 * 1024**3:
        raise RuntimeError('Single PutObject limit exceeded; preserve dump')
    args = ['aws', 's3api', 'put-object', '--region', 'ap-northeast-2',
            '--bucket', config['bucket'], '--key', key, '--body', str(complete),
            '--expected-bucket-owner', config['bucket_owner'],
            '--server-side-encryption', 'AES256', '--no-cli-pager']
    runner(args)
    # A marker means the API acknowledged upload, not that restore was tested.
    marker = complete.with_suffix('.uploaded.json')
    with marker.open('x') as output:
        os.chmod(marker, 0o600)
        json.dump({'key': key, 'status': 'upload-acknowledged-not-restore-tested'}, output)
        output.flush()
        os.fsync(output.fileno())
    # Local artifacts are preserved. Seven-day remote expiration is S3 lifecycle,
    # not local cleanup; operators must monitor disk occupancy and failures.
    return complete


def main():
    if os.geteuid() != 0 or sys.platform != 'linux':
        raise RuntimeError('EC2 runtime only')
    os.umask(0o077)
    spec = importlib.util.spec_from_file_location('dbadmin', '/usr/local/lib/logstack/db-admin.py')
    admin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(admin)
    c = json.loads(Path('/etc/logstack-db.json').read_text())
    admin.validate_config(c)
    extra = json.loads(Path('/etc/logstack-backup.json').read_text())
    admin.require(extra['approved'] is True and extra['encryption'] == 'AES256')
    admin.require(re.fullmatch('[0-9]{12}', extra['bucket_owner']))
    admin.require(re.fullmatch('[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', extra['bucket']))
    admin.require(extra['bucket'] != 'logstack-bucket')
    admin.require(re.fullmatch('[A-Za-z0-9_/-]+/', extra['prefix']) and not extra['prefix'].startswith('/'))
    c.update(extra)
    execute(['/usr/local/lib/logstack/db-bootstrap.sh', 'verify'])
    destination = Path('/srv/logstack-db/backups')
    admin.require(not destination.is_symlink())
    destination.mkdir(mode=0o700, exist_ok=True)
    with Path('/run/logstack-db-backup.lock').open('a') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        backup(c, destination, lambda args, **kwargs: subprocess.run(
            args, check=True, stderr=subprocess.DEVNULL, timeout=3600,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin',
                 'LC_ALL': 'C', 'AWS_PAGER': '', 'AWS_CLI_AUTO_PROMPT': 'off'},
            **({'stdout': subprocess.DEVNULL} | kwargs)))
    print('{"component":"db-backup","status":"upload-acknowledged"}')


if __name__ == '__main__':
    try: main()
    except Exception:
        print('{"component":"db-backup","status":"failed","action":"retain-and-inspect"}', file=sys.stderr)
        sys.exit(1)
