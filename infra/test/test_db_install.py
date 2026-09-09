"""Exercise installer branches with every external runtime command replaced.
No dnf, RPM transaction, systemctl, AWS, Linux mount or DB process is executed.
"""
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'runtime/templates/db-install.sh'


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'gpg-key').write_text('non-secret-test-fixture')

    def run_branch(self, changes=''):
        shell = '''source "$1"
exec 3>&1
MARKER="$2/marker"
VENDOR_DATA="$2/data"
GPG_KEY="$2/gpg-key"
python3() {
  printf 'ADMIN:%s\\n' "$2" >&3
  case "$2" in
    package-nevras) printf 'postgresql16-server-16.15-1.amzn2023.0.1.x86_64\\n';;
    setting) printf '2023.12.20260831\\n';;
  esac
}
pgrep() { return 1; }
find() { printf 'existing-data\\n'; }
systemctl() { printf 'SYSTEMCTL:%s\\n' "$*" >&3; }
dnf() { printf 'DNF:%s\\n' "$*" >&3; }
''' + changes + '\ninstall_runtime\n'
        return subprocess.run(['bash', '--noprofile', '--norc', '-c', shell,
                               'offline-install-test', str(SCRIPT), str(self.root)],
                              text=True, capture_output=True, timeout=5)

    def test_first_install_masks_before_pinned_dnf(self):
        result = self.run_branch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(result.stdout.index('SYSTEMCTL:mask'), result.stdout.index('DNF:'))
        self.assertIn('--disablerepo=* --enablerepo=logstack-approved', result.stdout)
        self.assertIn('--releasever=2023.12.20260831', result.stdout)
        self.assertIn('--setopt=install_weak_deps=False', result.stdout)
        self.assertIn('ADMIN:install-record', result.stdout)

    def test_marker_reboot_verifies_without_dnf_or_service_changes(self):
        (self.root / 'marker').write_text('mock')
        result = self.run_branch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ADMIN:install-check', result.stdout)
        self.assertNotIn('DNF:', result.stdout)
        self.assertNotIn('SYSTEMCTL:', result.stdout)

    def test_wrong_os_stops_before_install(self):
        result = self.run_branch('python3() { return 1; }')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('DNF:', result.stdout)

    def test_existing_pg_process_is_not_stopped(self):
        result = self.run_branch('pgrep() { return 0; }')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('SYSTEMCTL:', result.stdout)
        self.assertNotIn('DNF:', result.stdout)

    def test_unknown_vendor_data_preserved(self):
        (self.root / 'data').mkdir()
        (self.root / 'data/existing').write_text('preserve')
        result = self.run_branch()
        self.assertEqual(result.returncode, 1)
        self.assertEqual((self.root / 'data/existing').read_text(), 'preserve')
        self.assertNotIn('DNF:', result.stdout)

    def test_failed_dnf_no_success_marker_or_pg_init(self):
        result = self.run_branch('dnf() { return 1; }')
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('ADMIN:install-record', result.stdout)
        self.assertNotIn('initdb', result.stdout)

    def test_bad_installed_rpm_no_success_marker(self):
        result = self.run_branch('''python3() {
          case "$2" in
            check-image) return 1;;
            package-nevras) printf 'mock-package\\n';;
            setting) printf '2023.12.20260831\\n';;
          esac
        }''')
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.root / 'marker').exists())


if __name__ == '__main__': unittest.main()
