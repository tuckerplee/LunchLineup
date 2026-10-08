"""Pure closed-adapter regressions. No engine/container/runtime is contacted."""
import importlib.util
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('c08_adapter', ROOT / 'scripts/ci-container-bin/c08-adapter.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
IMAGES = json.loads((ROOT / '.ci/development-c08-cases.json').read_text())['images']
PROJECT = 'lunchlineup-beta-fixture'
ALIAS = 'lunchlineup-legacy-credit-123-01234567-0123-0123-0123-0123456789ab'


class C08AdapterTests(unittest.TestCase):
    def test_c08_phase_refuses_mismatched_authenticated_source_binding(self):
        spec = importlib.util.spec_from_file_location('fixed_phase', ROOT / 'scripts/read-fixed-browser-phase.py')
        phase_reader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(phase_reader)
        phase = {'cohort': 'c08', 'pipelineSha256': 'a' * 64}
        record = {'runId': 'fixture', 'materializerSha256': 'b' * 64, 'sourceProfile': {
            'version': 2, 'sourcePurpose': 'disposable-development', 'repository': 'tuckerplee/LunchLineup',
            'pipelinePath': '.ci/development-c08.pipeline.json', 'pipelineSha256': 'a' * 64,
            'sourceSha': 'c' * 40, 'sourceRef': 'refs/heads/fixture'}}
        phase_reader.validate_c08_source_binding(phase, record, 'fixture', 'c' * 40, 'refs/heads/fixture')
        for field, changed in [('pipelinePath', '.ci/development-staff.pipeline.json'),
                               ('pipelineSha256', 'd' * 64), ('sourceSha', 'd' * 40),
                               ('sourceRef', 'refs/heads/foreign')]:
            altered = copy.deepcopy(record); altered['sourceProfile'][field] = changed
            with self.subTest(field=field), self.assertRaises(ValueError):
                phase_reader.validate_c08_source_binding(phase, altered, 'fixture', 'c' * 40, 'refs/heads/fixture')
        with self.assertRaises(ValueError):
            phase_reader.validate_c08_source_binding({'cohort': 'browser'}, record, 'fixture', 'c' * 40, 'refs/heads/fixture')

    def test_postgres_closed_slot_tmpfs_private_network_fixed_port(self):
        result = adapter.run_plan(['run', '--detach', '--rm', '--name', ALIAS,
            '--env', 'POSTGRES_PASSWORD=disposable-test-only', '--env', 'POSTGRES_DB=legacy_credit_cleanup_test',
            '--publish', '127.0.0.1::5432', IMAGES['postgres']], IMAGES, PROJECT, ROOT)
        argv = result['argv']
        self.assertIn('--pull=never', argv)
        self.assertEqual(argv[argv.index('--name') + 1], PROJECT + '-postgres')
        self.assertEqual(argv[argv.index('--network') + 1], PROJECT + '_c08')
        self.assertIn('/var/lib/postgresql/data:rw,nosuid,nodev,size=1g,mode=0700', argv)
        self.assertIn('127.0.0.1:54329:5432', argv)
        self.assertIn('com.docker.compose.service=postgres', argv)
        self.assertNotIn('--rm', argv)

    def test_validator_forces_no_network_and_readonly_source_mount(self):
        path = ROOT / 'infrastructure/prometheus/prometheus.yml'
        result = adapter.run_plan(['run', '--rm', '-v', str(path) + ':/etc/prometheus/prometheus.yml:ro',
            '--entrypoint', '/bin/promtool', IMAGES['prometheus'], 'check', 'config', '/etc/prometheus/prometheus.yml'],
            IMAGES, PROJECT, ROOT)
        self.assertIn('--network=none', result['argv'])
        self.assertFalse(result['detached'])
        for hostile in [
            ['--network', 'host'], ['--privileged'], ['--label', 'foreign=yes'],
            ['-v', '/etc/passwd:/etc/passwd:ro'], ['-v', str(path) + ':/etc/prometheus/prometheus.yml:rw'],
            ['--publish', '0.0.0.0:5432:5432'], ['--env', 'SECRET=unapproved'],
        ]:
            with self.subTest(hostile=hostile), self.assertRaises(ValueError):
                adapter.run_plan(['run', *hostile, IMAGES['prometheus'], 'check'], IMAGES, PROJECT, ROOT)

    def test_acquisition_refuses_execution_and_unknown_pulls(self):
        owner = object.__new__(adapter.Adapter)
        owner.phase = {'phase': 'acquisition'}
        owner.images = IMAGES
        calls = []
        owner.podman = lambda args, **kwargs: calls.append(args) or SimpleNamespace(returncode=0)
        self.assertEqual(owner.dispatch(['pull', IMAGES['postgres']]), 0)
        self.assertEqual(len(calls), 1)
        for args in [['run', IMAGES['postgres']], ['pull', 'postgres:latest'], ['version'], ['c08-cleanup']]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                owner.dispatch(args)
        self.assertEqual(len(calls), 1)

    def test_occupied_slot_refuses_before_create(self):
        owner = object.__new__(adapter.Adapter)
        owner.phase = {'phase': 'runtime', 'buildRoot': str(ROOT)}
        owner.images = IMAGES
        owner.project = PROJECT
        calls = []
        owner.podman = lambda args, **kwargs: calls.append(args) or SimpleNamespace(returncode=0)
        with self.assertRaisesRegex(ValueError, 'slot occupied'):
            owner.dispatch(['run', '--rm', '--entrypoint', '/bin/promtool', IMAGES['prometheus'], '--version'])
        self.assertEqual(calls, [['container', 'exists', PROJECT + '-prometheus']])

    def test_cleanup_rejects_changed_owner_before_removal(self):
        owner = object.__new__(adapter.Adapter)
        owner.images = IMAGES
        owner.project = PROJECT
        calls = []
        entry = {'id': 'a' * 64, 'name': PROJECT + '-postgres', 'key': 'postgres'}
        def engine(args, **kwargs):
            calls.append(args)
            if args[0] == 'inspect':
                value = [{'Id': entry['id'], 'Name': entry['name'], 'Image': 'b' * 64,
                          'Config': {'Labels': {'com.docker.compose.project': 'foreign',
                                               'com.docker.compose.service': 'postgres'}}}]
            else:
                value = [{'Id': 'b' * 64}]
            return SimpleNamespace(returncode=0, stdout=json.dumps(value))
        owner.podman = engine
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            owner.remove(entry)
        self.assertTrue(all(call[0] != 'rm' for call in calls))


if __name__ == '__main__':
    unittest.main()
