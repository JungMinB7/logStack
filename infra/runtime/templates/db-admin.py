#!/usr/bin/env python3
"""EC2-only helper. Never print command output/errors containing runtime secrets.

Pure validators are imported by workstation tests; __main__ is never executed
by those tests. No external Python dependencies or Terraform secret lookup.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import stat
import subprocess
import sys

CONFIG = Path('/etc/logstack-db.json')
MOUNT = Path('/srv/logstack-db')
DATA = MOUNT / 'pgdata'
SOCKET = '/run/logstack-db-private'


def require(condition):
    if not condition:
        raise RuntimeError('DB safety check failed')


def run(args, input_text=None):
    # No inherited PG env, AWS debug or arbitrary executable search paths.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('PG', 'AWS_', 'BASH_', 'LD_', 'PYTHON'))}
    env.update(PATH='/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin',
               AWS_PAGER='', AWS_CLI_AUTO_PROMPT='off', LC_ALL='C')
    result = subprocess.run(args, input=input_text, text=True, capture_output=True,
                            env=env, timeout=180, check=False)
    require(result.returncode == 0)
    return result.stdout


def safe_name(value):
    require(isinstance(value, str) and re.fullmatch('[a-z][a-z0-9_]{1,39}', value))
    require(not value.startswith('pg_') and value not in ('postgres', 'template0', 'template1', 'public'))
    return value


def choose_device(tree, volume_id):
    require(re.fullmatch('vol-[0-9a-f]{17}', volume_id))
    expected = volume_id.replace('-', '')
    found = []
    def visit(node):
        if (node.get('serial') or '').strip().replace('-', '') == expected:
            require(node.get('type') == 'disk' and not node.get('children'))
            require(re.fullmatch('/dev/nvme[0-9]+n[0-9]+', node.get('path', '')))
            mounts = [m for m in node.get('mountpoints', []) if m]
            require(not mounts or mounts == [str(MOUNT)])
            found.append(node['path'])
        for child in node.get('children', []):
            visit(child)
    for node in tree['blockdevices']:
        visit(node)
    require(len(found) == 1)
    return found[0]


def blank_signatures(value):
    require(value.get('signatures') == [])


def validate_config(c):
    for field in ('database', 'migration_role', 'application_role'):
        safe_name(c[field])
    require(c['migration_role'] != c['application_role'])
    require(c['region'] == 'ap-northeast-2')
    for field in ('migration_secret_arn', 'application_secret_arn'):
        require(re.fullmatch(r'arn:aws:ssm:ap-northeast-2:[0-9]{12}:parameter/[A-Za-z0-9_./-]+', c[field]))
    require(re.fullmatch('/[A-Za-z0-9_/-]+', c['pg_bin']))
    require(c['app_cidrs'] == ['10.0.10.0/24', '10.0.11.0/24'])


def identity(c):
    return {k: c[k] for k in ('volume_id', 'database', 'migration_role', 'application_role')}


def check_identity(c, prepare=False):
    marker = MOUNT / '.logstack-volume.json'
    require(not marker.is_symlink())
    if not marker.exists():
        require(prepare and c['allow_blank_volume_init'] is True)
        # Arbitrary ext4/backup data is never adopted automatically.
        require(set(p.name for p in MOUNT.iterdir()) <= {'lost+found'})
        if (MOUNT / 'lost+found').exists():
            require(not (MOUNT / 'lost+found').is_symlink())
            require(not any((MOUNT / 'lost+found').iterdir()))
        with marker.open('x', encoding='utf8') as target:
            os.chmod(marker, 0o600)
            json.dump(identity(c), target)
            target.flush()
            os.fsync(target.fileno())
        result = 'new'
    else:
        result = 'existing'
    require(json.loads(marker.read_text()) == identity(c))
    require(marker.stat().st_uid == 0 and stat.S_IMODE(marker.stat().st_mode) == 0o600)
    return result


def write_pg(path, content):
    require(not path.is_symlink())
    # Replace, never append duplicate or drifted security settings.
    temporary = path.with_name(path.name + '.logstack-new')
    require(not temporary.exists() and not temporary.is_symlink())
    with temporary.open('x', encoding='utf8') as target:
        os.chmod(temporary, 0o600)
        target.write(content)
        target.flush()
        os.fsync(target.fileno())
    user = pwd.getpwnam('postgres')
    os.chown(temporary, user.pw_uid, user.pw_gid)
    os.replace(temporary, path)


def configure(c):
    # Auto-conf overrides postgresql.conf. Unknown overrides are never erased.
    auto = DATA / 'postgresql.auto.conf'
    require(not auto.is_symlink())
    if auto.exists():
        require(all(not line.strip() or line.lstrip().startswith('#') for line in auto.read_text().splitlines()))
    write_pg(DATA / 'postgresql.conf', """listen_addresses = '*'
port = 5432
unix_socket_directories = '/run/logstack-db-private'
unix_socket_permissions = 0700
password_encryption = 'scram-sha-256'
timezone = 'UTC'
log_timezone = 'UTC'
log_statement = 'none'
log_min_error_statement = 'panic'
log_parameter_max_length = 0
log_parameter_max_length_on_error = 0
logging_collector = off
""")
    rules = ['local all postgres peer', 'local all all reject']
    for cidr in c['app_cidrs']:
        rules.append(f"host {c['database']} {c['migration_role']},{c['application_role']} {cidr} scram-sha-256")
    rules += ['host all all 0.0.0.0/0 reject', 'host all all ::/0 reject']
    write_pg(DATA / 'pg_hba.conf', '\n'.join(rules) + '\n')


def scram(password, salt):
    # Explicit password contract avoids client/server SASLprep ambiguity.
    require(isinstance(password, str) and 16 <= len(password) <= 1024)
    require(all(32 <= ord(char) <= 126 for char in password))
    salted = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 4096)
    client = hmac.new(salted, b'Client Key', hashlib.sha256).digest()
    server = hmac.new(salted, b'Server Key', hashlib.sha256).digest()
    b64 = lambda value: base64.b64encode(value).decode('ascii')
    return f'SCRAM-SHA-256$4096:{b64(salt)}${b64(hashlib.sha256(client).digest())}:{b64(server)}'


def secret(c, arn):
    response = json.loads(run(['aws', 'ssm', 'get-parameter', '--region', c['region'],
                               '--name', arn, '--with-decryption', '--output', 'json', '--no-cli-pager']))
    require(response['Parameter']['ARN'] == arn and response['Parameter']['Type'] == 'SecureString')
    return response['Parameter']['Value']


def sql(c, statement, db='postgres'):
    return run(['runuser', '-u', 'postgres', '--', c['pg_bin'] + '/psql',
                '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', SOCKET, '-U', 'postgres', '-d', db], statement)


def roles(c):
    # SQL goes via stdin, no passwords/verifiers in argv, files, stdout/stderr.
    for role, field in [(c['migration_role'], 'migration_secret_arn'),
                        (c['application_role'], 'application_secret_arn')]:
        verifier = scram(secret(c, c[field]), os.urandom(16))
        if not sql(c, f"SELECT 1 FROM pg_roles WHERE rolname='{role}';").strip():
            sql(c, f'CREATE ROLE "{role}";')
        sql(c, f'''ALTER ROLE "{role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '{verifier}';''')
        require(sql(c, f"SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='{role}');").strip() == '0')
    db, owner, app = c['database'], c['migration_role'], c['application_role']
    actual_owner = sql(c, f"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='{db}';").strip()
    if actual_owner:
        require(actual_owner == owner)
    else:
        sql(c, f'CREATE DATABASE "{db}" OWNER "{owner}" ENCODING \'UTF8\' TEMPLATE template0;')
    sql(c, f'''REVOKE ALL ON DATABASE "{db}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "{db}" TO "{app}";
''')
    sql(c, f'''REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO "{app}";
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "{app}";
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "{app}";
ALTER DEFAULT PRIVILEGES FOR ROLE "{owner}" IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO "{app}";
ALTER DEFAULT PRIVILEGES FOR ROLE "{owner}" IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO "{app}";
''', db)


def check_os(c):
    require(sys.version_info >= (3, 9))
    release = {}
    for line in Path('/etc/os-release').read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            parsed = shlex.split(value)
            release[key] = parsed[0] if parsed else ''
    require(release.get('ID') == 'amzn' and release.get('VERSION_ID') == '2023')
    require(release.get('BUILD_ID') == c['al2023_release'])
    require(c['architecture'] == 'x86_64' and run(['uname', '-m']).strip() == 'x86_64')


def check_image(c):
    # Actual OS/RPM/binary checks replace the old custom-AMI manifest contract.
    check_os(c)
    require(c['pg_bin'] == '/usr/bin')
    for name, version in c['packages'].items():
        require(re.fullmatch('[a-z0-9-]+', name) and re.fullmatch('[A-Za-z0-9_.+-]+', version))
        require(run(['rpm', '-q', '--qf', '%{VERSION}-%{RELEASE}.%{ARCH}', name]).strip() == version)
    for binary in ('postgres', 'initdb', 'pg_ctl', 'pg_controldata', 'pg_dump', 'pg_restore', 'psql'):
        require(re.search(r'\(PostgreSQL\) 16\.', run([c['pg_bin'] + '/' + binary, '--version'])))
    require(pwd.getpwnam('postgres').pw_uid != 0)
    for unit in ('postgresql.service', 'postgresql@.service'):
        status = subprocess.run(['systemctl', 'is-enabled', unit], text=True,
                                capture_output=True, check=False, timeout=10)
        require(status.stdout.strip() == 'masked')
    path = Path('/var/lib/pgsql/data')
    require(not path.is_symlink() and (not path.exists() or (path.is_dir() and not any(path.iterdir()))))
    require(run(['aws', '--version']).startswith('aws-cli/2.'))
    require('4.3' in run(['chronyc', '-v']))
    require('3.3.4624.0' in run(['/usr/bin/amazon-ssm-agent', '-version']))


def install_contract(c):
    return {'release': c['al2023_release'], 'packages': c['packages']}


def install_marker(c, create=False):
    marker = Path('/var/lib/logstack-db-install.json')
    require(not marker.is_symlink())
    if create:
        with marker.open('x') as target:
            os.chmod(marker, 0o600)
            json.dump(install_contract(c), target)
            target.flush()
            os.fsync(target.fileno())
    require(marker.stat().st_uid == 0 and stat.S_IMODE(marker.stat().st_mode) == 0o600)
    require(json.loads(marker.read_text()) == install_contract(c))


def configure_time():
    target = Path('/etc/chrony.conf')
    require(not target.is_symlink())
    target.write_text('server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4\n'
                      'driftfile /var/lib/chrony/drift\nmakestep 1.0 3\nrtcsync\n')
    os.chmod(target, 0o644)


def time_source(text):
    sources = [line.split() for line in text.splitlines() if line.startswith(('^', '=', '#'))]
    # Amazon Time Sync IPv4 link-local requires no SG/NAT/VPC endpoint rule.
    require(len(sources) == 1 and sources[0][0] == '^*' and sources[0][1] == '169.254.169.123')


def main():
    require(os.geteuid() == 0 and sys.platform == 'linux')
    command = sys.argv[1]
    if command == 'blank-signatures':
        blank_signatures(json.load(sys.stdin)); return
    if command == 'time-source':
        time_source(sys.stdin.read()); return
    c = json.loads(CONFIG.read_text())
    validate_config(c)
    if command == 'setting':
        value = c[sys.argv[2]]
        print(json.dumps(value) if isinstance(value, bool) else value)
    elif command == 'device':
        print(choose_device(json.loads(run(['lsblk', '--json', '--paths', '--output', 'PATH,TYPE,SERIAL,MOUNTPOINTS'])), c['volume_id']))
    elif command == 'check-image': check_image(c)
    elif command == 'check-os': check_os(c)
    elif command == 'package-nevras':
        for name, version in c['packages'].items():
            require(re.fullmatch('[a-z0-9-]+', name) and re.fullmatch('[A-Za-z0-9_.+-]+', version))
            print(name + '-' + version)
    elif command == 'install-check': install_marker(c)
    elif command == 'install-record': install_marker(c, True)
    elif command == 'configure-time': configure_time()
    elif command == 'check-no-server':
        require(not run(['ss', '-H', '-ltn', 'sport = :5432']).strip())
        process = subprocess.run(['pgrep', '-x', 'postgres'], capture_output=True, check=False, timeout=10)
        require(process.returncode == 1)
    elif command == 'identity-prepare': print(check_identity(c, True))
    elif command == 'identity-check': check_identity(c)
    elif command == 'config': configure(c)
    elif command == 'roles': roles(c)
    else: require(False)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never emit exception text, subprocess output or a traceback.
        print('{"component":"db-admin","status":"failed"}', file=sys.stderr)
        sys.exit(1)
