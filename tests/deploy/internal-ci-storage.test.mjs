import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('storage admission enforces independent parent, project, freshness and guest boundaries', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync('python3', ['-B', '-c', `
import importlib.util
spec = importlib.util.spec_from_file_location('admission', 'scripts/check-internal-ci-storage.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
G = m.GIB
budget = dict(version=1, vmid=218, project_id=218, dataset='data/zd0',
              observed_at_epoch=1000, quota_bytes=60*G, used_bytes=24*G,
              dataset_available_bytes=52*G, pool_free_bytes=72*G)
m.require_backing_capacity(budget, 1090)
m.require_capacity(52*G)
for changes, now in [
    ({'dataset_available_bytes': 52*G-1}, 1000),
    ({'used_bytes': 24*G+1}, 1000),
    ({'pool_free_bytes': 60*G-1}, 1000),
    ({}, 1091), ({}, 999), ({'vmid': 107}, 1000),
]:
    try:
        m.require_backing_capacity(dict(budget, **changes), now)
    except ValueError:
        pass
    else:
        raise AssertionError((changes, now))
try:
    m.require_capacity(52*G-1)
except ValueError:
    pass
else:
    raise AssertionError('guest floor ignored')
env = dict(CI_REPOSITORY='lunchlineup', CI_RUN_ID='controller-123',
           CI_WORKSPACE='/var/lib/custom-ci/workspaces/controller-123',
           RUNNER_TEMP='/var/lib/custom-ci/runs/controller-123/tmp/job-tmp',
           CONTAINERS_STORAGE_CONF='/var/lib/custom-ci/runs/controller-123/tmp/step-inputs/container-storage.conf')
m.validate_context(env, 'custom-ci', m.Path(env['CI_WORKSPACE']))
for changes in [dict(DOCKER_HOST='unix:///var/run/docker.sock'),
                dict(CONTAINER_HOST='ssh://shared'), dict(CI_RUN_ID='../escape'),
                dict(RUNNER_TEMP='/tmp/shared')]:
    try:
        m.validate_context(dict(env, **changes), 'custom-ci', m.Path(env['CI_WORKSPACE']))
    except ValueError:
        pass
    else:
        raise AssertionError(changes)
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('QA target checks reject external volumes, foreign prefixes and occupied browser ports', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import importlib.util
import socket
spec = importlib.util.spec_from_file_location('target', 'scripts/check-internal-ci-target.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
project = 'lunchlineup-beta-controller123'
valid = {'volumes': {'postgres_data': {'name': project + '_postgres_data'}}}
assert m.validate_volumes(valid, project) == [project + '_postgres_data']
for invalid in [
    {'volumes': {'postgres_data': {'external': True, 'name': project + '_postgres_data'}}},
    {'volumes': {'postgres_data': {'name': 'retained_postgres_data'}}},
    {'volumes': {}},
]:
    try:
        m.validate_volumes(invalid, project)
    except ValueError:
        pass
    else:
        raise AssertionError(invalid)
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    try:
        m.require_ports_free([port])
    except OSError:
        pass
    else:
        raise AssertionError('occupied port admitted')
m.require_ports_free([port])
`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
