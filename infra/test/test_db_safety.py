"""Offline-only: import validators and inject every command runner.

No user_data execution, AWS calls, DB connection, mount, mkfs or systemctl.
Temporary backup fixtures contain only non-secret test bytes.
"""
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'runtime/templates' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


admin = load('db-admin')
dump = load('db-backup')
VOL = 'vol-0123456789abcdef0'  # mock fixture only; never Terraform inputs/plan
NODE = {'path': '/dev/nvme1n1', 'type': 'disk', 'serial': VOL.replace('-', ''), 'mountpoints': [None]}


class DeviceTests(unittest.TestCase):
    def choose(self, node):
        return admin.choose_device({'blockdevices': [node]}, VOL)

    def test_exact_id_not_device_name(self):
        self.assertEqual(self.choose(copy.deepcopy(NODE)), '/dev/nvme1n1')

    def test_wrong_id(self):
        node = dict(NODE, serial='volfffffffffffffffff')
        with self.assertRaises(RuntimeError): self.choose(node)

    def test_missing_device(self):
        with self.assertRaises(RuntimeError): admin.choose_device({'blockdevices': []}, VOL)

    def test_ambiguous_identity(self):
        with self.assertRaises(RuntimeError): admin.choose_device({'blockdevices': [NODE, NODE]}, VOL)

    def test_root_and_other_mounts_rejected(self):
        for mount in ['/', '/boot', '/var/lib/postgresql', '/srv/logstack-db-other']:
            with self.subTest(mount=mount), self.assertRaises(RuntimeError):
                self.choose(dict(NODE, mountpoints=[mount]))

    def test_expected_mount_accepted(self):
        self.choose(dict(NODE, mountpoints=['/srv/logstack-db']))

    def test_partition_and_nested_root_rejected(self):
        for node in [dict(NODE, type='part'), dict(NODE, children=[{'mountpoints': ['/']}])]:
            with self.subTest(node=node), self.assertRaises(RuntimeError): self.choose(node)

    def test_non_nvme_not_guessed(self):
        with self.assertRaises(RuntimeError): self.choose(dict(NODE, path='/dev/xvdf'))

    def test_no_signature_only(self):
        admin.blank_signatures({'signatures': []})
        for value in [{}, {'signatures': None}, {'signatures': [{'type': 'gpt'}]}]:
            with self.subTest(value=value), self.assertRaises(RuntimeError): admin.blank_signatures(value)

    def test_only_selected_amazon_ntp(self):
        admin.time_source('^* 169.254.169.123 3 6 377 1 +0ns[+0ns] +/- 1ms\n')
        for text in ['', '^? 169.254.169.123', '^* 1.2.3.4', '^* 169.254.169.123\n^+ 1.2.3.4']:
            with self.subTest(text=text), self.assertRaises(RuntimeError): admin.time_source(text)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mount = Path(self.tmp.name)
        self.config = dict(volume_id=VOL, database='game', migration_role='migrator', application_role='app', allow_blank_volume_init=True)
        self.patcher = patch.object(admin, 'MOUNT', self.mount)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_unknown_existing_data_preserved(self):
        (self.mount / 'unknown').write_text('keep')
        with self.assertRaises(RuntimeError): admin.check_identity(self.config, True)
        self.assertEqual((self.mount / 'unknown').read_text(), 'keep')

    def test_nonempty_lost_found_preserved(self):
        (self.mount / 'lost+found').mkdir()
        (self.mount / 'lost+found/inode').write_text('keep')
        with self.assertRaises(RuntimeError): admin.check_identity(self.config, True)

    def test_wrong_volume_marker_rejected(self):
        (self.mount / '.logstack-volume.json').write_text(json.dumps(dict(self.config, volume_id='wrong')))
        with self.assertRaises(RuntimeError): admin.check_identity(self.config)

    def test_missing_marker_not_adopted(self):
        with self.assertRaises(RuntimeError): admin.check_identity(self.config)

    def test_blank_init_requires_explicit_approval_even_for_ext4(self):
        with self.assertRaises(RuntimeError): admin.check_identity(dict(self.config, allow_blank_volume_init=False), True)
        self.assertEqual(list(self.mount.iterdir()), [])


class SecretTests(unittest.TestCase):
    def test_scram_no_plaintext(self):
        password = 'test-only-password-123!'
        value = admin.scram(password, b'fixed-test-salt!')
        self.assertTrue(value.startswith('SCRAM-SHA-256$4096:'))
        self.assertNotIn(password, value)

    def test_password_contract(self):
        for value in ['', 'short', '\n' * 20, '한' * 20]:
            with self.subTest(value=value), self.assertRaises(RuntimeError): admin.scram(value, b'salt')

    def test_names_reject_sql_metacharacters_and_system_roles(self):
        for value in ['postgres', 'pg_superuser', 'x;drop', 'x\nxx', 'public']:
            with self.subTest(value=value), self.assertRaises(RuntimeError): admin.safe_name(value)

    def test_secret_wrong_type_rejected(self):
        c = {'region': 'ap-northeast-2'}
        with patch.object(admin, 'run', return_value=json.dumps({'Parameter': {'ARN': 'expected', 'Type': 'String', 'Value': 'test'}})):
            with self.assertRaises(RuntimeError): admin.secret(c, 'expected')

    def test_sql_only_stdin(self):
        with patch.object(admin, 'run', return_value='') as runner:
            admin.sql({'pg_bin': '/usr/pgsql-16/bin'}, 'test-sensitive-sql')
            args, stdin = runner.call_args.args
            self.assertNotIn('test-sensitive-sql', ' '.join(args))
            self.assertEqual(stdin, 'test-sensitive-sql')
            self.assertIn('-X', args)

    def test_failed_subprocess_does_not_reflect_stderr(self):
        failed = subprocess.CompletedProcess(['mock'], 1, 'test-secret', 'test-secret')
        with patch.object(admin.subprocess, 'run', return_value=failed):
            with self.assertRaisesRegex(RuntimeError, '^DB safety check failed$'):
                admin.run(['mock'])


class ShellBranchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / 'pgdata'

    def shell(self, body):
        # Functions override every external command reachable by the tested
        # branch. The main() entry point is never invoked.
        script = '''source "$1"
exec 3>&1
DATA="$2"
PG_BIN=/mock/pg
DEVICE=/mock/device
verify_mount() { :; }
as_pg() { printf 'MOCK_PG:%s\\n' "$*" >&3; }
install() { printf 'MOCK_INSTALL\\n'; }
python3() { if [[ $2 == identity-prepare ]]; then printf 'existing\\n'; fi; }
''' + body
        return subprocess.run(['bash', '--noprofile', '--norc', '-c', script, 'offline-test',
                               str(ROOT / 'runtime/templates/db-bootstrap.sh'), str(self.data)],
                              text=True, capture_output=True, timeout=5)

    def test_existing_marker_missing_data_never_init(self):
        result = self.shell('prepare_cluster')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('initdb', result.stdout)
        self.assertNotIn('MOCK_INSTALL', result.stdout)

    def test_wrong_pg_major_never_init(self):
        self.data.mkdir()
        (self.data / 'PG_VERSION').write_text('15')
        result = self.shell('prepare_cluster')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('initdb', result.stdout)

    def test_partial_pg_directory_never_init(self):
        self.data.mkdir()
        (self.data / 'partial').write_text('preserved')
        result = self.shell('prepare_cluster')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('initdb', result.stdout)
        self.assertEqual((self.data / 'partial').read_text(), 'preserved')

    def test_mount_failure_never_init(self):
        result = self.shell('verify_mount() { die; }; prepare_cluster')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('initdb', result.stdout)

    def test_valid_existing_pg16_skips_init(self):
        self.data.mkdir()
        (self.data / 'PG_VERSION').write_text('16')
        result = self.shell('prepare_cluster')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('initdb', result.stdout)
        self.assertIn('pg_controldata', result.stdout)

    def test_stale_pid_left_for_pg_ctl_not_deleted(self):
        self.data.mkdir()
        (self.data / 'PG_VERSION').write_text('16')
        pid = self.data / 'postmaster.pid'
        pid.write_text('123456')
        result = self.shell('prepare_cluster')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(pid.read_text(), '123456')
        self.assertNotIn('initdb', result.stdout)

    def test_verify_never_mounts_or_initializes(self):
        self.data.mkdir()
        (self.data / 'PG_VERSION').write_text('16')
        result = self.shell('mount() { exit 99; }; mkfs.ext4() { exit 99; }; verify_cluster')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('initdb', result.stdout)

    def test_new_identity_initializes_once(self):
        result = self.shell('''python3() { if [[ $2 == identity-prepare ]]; then printf 'new\\n'; fi; }
verify_cluster() { :; }
prepare_cluster''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('/initdb'), 1)

    def test_control_data_failure_preserves_cluster(self):
        self.data.mkdir()
        (self.data / 'PG_VERSION').write_text('16')
        result = self.shell('as_pg() { return 1; }; prepare_cluster')
        self.assertEqual(result.returncode, 1)
        self.assertTrue((self.data / 'PG_VERSION').exists())


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.old = self.directory / 'previous.dump'
        self.old.write_bytes(b'previous-success')
        self.config = dict(pg_bin='/pg/bin', database='game', prefix='approved/', bucket='test-only', bucket_owner='000000000000')
        self.calls = []

    def runner(self, args, **kwargs):
        self.calls.append(args)
        if 'stdout' in kwargs: kwargs['stdout'].write(b'test-only-dump-bytes')

    def test_success_orders_dump_verify_upload_marker(self):
        result = dump.backup(self.config, self.directory, self.runner)
        self.assertTrue(result.with_suffix('.uploaded.json').exists())
        self.assertEqual(len(self.calls), 3)
        self.assertIn('/pg/bin/pg_dump', self.calls[0])
        self.assertEqual(self.calls[1][0], '/pg/bin/pg_restore')
        self.assertIn('put-object', self.calls[2])
        self.assertEqual(self.old.read_bytes(), b'previous-success')

    def test_default_runner_allows_dump_stdout_override(self):
        with patch.object(dump.subprocess, 'run') as runner:
            with io.BytesIO() as target:
                dump.execute(['mock-pg-dump'], stdout=target)
                self.assertIs(runner.call_args.kwargs['stdout'], target)

    def test_each_failure_preserves_previous_and_new_artifact(self):
        for fail in range(3):
            with self.subTest(fail=fail):
                self.calls = []
                def runner(args, **kwargs):
                    self.runner(args, **kwargs)
                    if len(self.calls) == fail + 1: raise RuntimeError('mock failure')
                before = set(self.directory.iterdir())
                with self.assertRaises(RuntimeError): dump.backup(self.config, self.directory, runner)
                created = set(self.directory.iterdir()) - before
                self.assertEqual(len(created), 1)
                self.assertIn(next(iter(created)).suffix, ['.partial', '.dump'])
                self.assertEqual(self.old.read_bytes(), b'previous-success')
                self.assertEqual(len(self.calls), fail + 1)

    def test_unique_names_no_overwrite(self):
        first = dump.backup(self.config, self.directory, self.runner)
        second = dump.backup(self.config, self.directory, self.runner)
        self.assertNotEqual(first, second)

    def test_lock_exclusion(self):
        with (self.directory / 'lock').open('a') as first, (self.directory / 'lock').open('a') as second:
            dump.fcntl.flock(first, dump.fcntl.LOCK_EX | dump.fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError): dump.fcntl.flock(second, dump.fcntl.LOCK_EX | dump.fcntl.LOCK_NB)


if __name__ == '__main__': unittest.main()
