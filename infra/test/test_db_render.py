"""Actual Terraform templatefile rendering only in an empty temp directory.

No providers, backend, resource plan, credentials, init, or mocked provider.
Fixtures exercise escaping, not approved AWS deployment inputs.
"""
import gzip
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

TEMPLATES = Path(__file__).resolve().parents[1] / 'runtime/templates'
TF = '/Users/ljm/.local/share/terraform/1.14.9/terraform'


def render(name, values):
    literal = json.dumps(json.dumps(values)).replace('${', '$${').replace('%{', '%%{')
    expression = f'jsonencode(templatefile({json.dumps(str(TEMPLATES / name))}, jsondecode({literal})))\n'
    with tempfile.TemporaryDirectory(prefix='logstack-static-render-') as directory:
        result = subprocess.run([TF, 'console', '-no-color'], input=expression,
                                text=True, capture_output=True, cwd=directory, timeout=20,
                                env={'PATH': '/usr/bin:/bin', 'CHECKPOINT_DISABLE': '1'})
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(json.loads(result.stdout))


class RenderTests(unittest.TestCase):
    def test_complete_cloud_config_and_syntax(self):
        prepare = render('db-prepare.service.tftpl', {'ssm_service': 'amazon-ssm-agent.service', 'chrony_service': 'chronyd.service'})
        postgres = render('db-postgresql.service.tftpl', {'pg_bin': '/usr/pgsql-16/bin'})
        for text in (prepare, postgres):
            self.assertNotIn('${', text)
        self.assertIn('Requires=logstack-db-install.service amazon-ssm-agent.service chronyd.service', prepare)
        self.assertIn('ExecStartPre=+/usr/local/lib/logstack/db-bootstrap.sh verify', postgres)
        contents = {name: (TEMPLATES / name).read_text() for name in ('db-bootstrap.sh', 'db-admin.py', 'db-backup.py', 'db-install.sh')}
        files = [dict(path='/etc/logstack-db.json', permissions='0600', owner='root:root', content=json.dumps({'escape_fixture': 'quotes" newline\n dollar${do_not_expand} unicode한글'}))]
        files += [dict(path='/usr/local/lib/logstack/' + name, permissions='0700', owner='root:root', content=body) for name, body in contents.items()]
        files += [dict(path='/etc/systemd/system/' + name, permissions='0644', owner='root:root', content=body) for name, body in [('logstack-db-prepare.service', prepare), ('logstack-postgresql.service', postgres)]]
        files += [dict(path='/etc/systemd/system/logstack-' + name, permissions='0644', owner='root:root', content=(TEMPLATES / name).read_text()) for name in ('db-install.service', 'db-backup.service', 'db-backup.timer')]
        repo = render('db-repository.repo.tftpl', {'repository_url': 'https://example.invalid/static-render-only/'})
        self.assertIn('gpgcheck=1', repo)
        self.assertIn('repo_gpgcheck=1', repo)
        self.assertIn('skip_if_unavailable=False', repo)
        files.append(dict(path='/etc/yum.repos.d/logstack-approved.repo', permissions='0644', owner='root:root', content=repo))
        files.append(dict(path='/etc/logstack-backup.json', permissions='0600', owner='root:root', content=json.dumps({'approved': True, 'prefix': 'pg-dump/'})))
        cloud = render('db-cloud-config.tftpl', {'files': files})
        self.assertTrue(cloud.startswith('#cloud-config\n'))
        parsed = json.loads(cloud.split('\n', 1)[1])
        self.assertFalse(parsed['package_update'])
        self.assertFalse(parsed['package_upgrade'])
        self.assertEqual(len(parsed['runcmd']), 1)
        self.assertIn('systemctl enable --now logstack-db-backup.timer', parsed['runcmd'][0][-1])
        self.assertEqual(parsed['write_files'], files)
        self.assertLess(len(gzip.compress(cloud.encode())), 16384)
        for item in parsed['write_files']:
            if item['path'].endswith('.sh'):
                result = subprocess.run(['bash', '-n'], input=item['content'], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            elif item['path'].endswith('.py'):
                compile(item['content'], item['path'], 'exec')  # parse only, no execution

    def test_template_missing_variable_rejected(self):
        with self.assertRaises(AssertionError): render('db-prepare.service.tftpl', {'ssm_service': 'only.service'})

    def test_rendered_runcmd_preserves_failure_and_stops_later_steps(self):
        cloud = render('db-cloud-config.tftpl', {'files': []})
        command = json.loads(cloud.split('\n', 1)[1])['runcmd'][0]
        for failure in ('daemon-reload', 'logstack-postgresql.service', 'none'):
            with self.subTest(failure=failure):
                harness = '''systemctl() {
                  printf 'MOCK_SYSTEMCTL:%s\\n' "$*"
                  if [[ "$*" == *"$MOCK_FAILURE"* ]]; then return 1; fi
                  return 0
                }
                export -f systemctl
                export MOCK_FAILURE
                exec "$@"'''
                result = subprocess.run(['bash', '-c', harness, 'offline-runcmd', *command],
                                        env={'PATH': '/usr/bin:/bin', 'MOCK_FAILURE': failure},
                                        text=True, capture_output=True, timeout=5)
                self.assertEqual(result.returncode, 0 if failure == 'none' else 1)
                if failure != 'none': self.assertNotIn('logstack-db-backup.timer', result.stdout)
                if failure == 'daemon-reload': self.assertNotIn('logstack-postgresql.service', result.stdout)


if __name__ == '__main__': unittest.main()
