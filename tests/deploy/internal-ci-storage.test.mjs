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


test('bounded QA port handoff retains exclusive binds and refuses persistent contention', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import errno
import importlib.util
import socket
import threading
import time
spec = importlib.util.spec_from_file_location('target', 'scripts/check-internal-ci-target.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
for budget in (-1, 66, float('inf'), float('nan')):
    try:
        m.require_ports_free([], wait_seconds=budget)
    except ValueError:
        pass
    else:
        raise AssertionError('unbounded retry admitted')
# Even a SO_REUSEADDR listener must not be admitted by the guard's normal bind.
with socket.socket() as occupied:
    occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    occupied.bind(('127.0.0.1', 0))
    occupied.listen()
    port = occupied.getsockname()[1]
    started = time.monotonic()
    try:
        m.require_ports_free([port], wait_seconds=0.1)
    except OSError as failure:
        assert failure.errno == errno.EADDRINUSE
    else:
        raise AssertionError('listening port admitted')
    assert 0.09 <= time.monotonic() - started < 1
# Hold the first bind while the second remains occupied; then release the
# occupied non-listening socket. Only a genuinely exclusive rebind may pass.
with socket.socket() as first:
    first.bind(('127.0.0.1', 0))
    first_port = first.getsockname()[1]
second = socket.socket()
second.bind(('127.0.0.1', 0))
second_port = second.getsockname()[1]
observed = []
def release():
    time.sleep(0.05)
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', first_port))
        except OSError as failure:
            observed.append(failure.errno)
        else:
            observed.append('first bind lost')
    second.close()
thread = threading.Thread(target=release)
thread.start()
try:
    m.require_ports_free([first_port, second_port], wait_seconds=0.75)
finally:
    thread.join()
    second.close()
assert observed == [errno.EADDRINUSE]
# Both held sockets must be closed after success and after a later-port error.
m.require_ports_free([first_port, second_port])
with socket.socket() as occupied:
    occupied.bind(('127.0.0.1', second_port))
    try:
        m.require_ports_free([first_port, second_port], wait_seconds=0.02)
    except OSError:
        pass
    else:
        raise AssertionError('bound non-listening port admitted')
    m.require_ports_free([first_port])
# A retry at the second port receives only the remainder of the shared budget.
first = socket.socket()
second = socket.socket()
first.bind(('127.0.0.1', 0))
second.bind(('127.0.0.1', 0))
ports = [first.getsockname()[1], second.getsockname()[1]]
thread = threading.Thread(target=lambda: (time.sleep(0.05), first.close()))
thread.start()
started = time.monotonic()
try:
    try:
        m.require_ports_free(ports, wait_seconds=0.4)
    except OSError as failure:
        assert failure.errno == errno.EADDRINUSE
    else:
        raise AssertionError('second occupied port admitted')
    assert 0.35 <= time.monotonic() - started < 0.6
finally:
    thread.join()
    first.close()
    second.close()
# Other bind failures must be propagated immediately and the socket closed.
from unittest.mock import Mock, patch
failure = OSError(errno.EACCES, 'synthetic bind denial')
probe = Mock()
probe.bind.side_effect = failure
with patch.object(m.socket, 'socket', return_value=probe), patch.object(m.time, 'sleep') as sleeping:
    try:
        m.require_ports_free([8080], wait_seconds=65)
    except OSError as caught:
        assert caught is failure
    else:
        raise AssertionError('non-contention bind failure admitted')
    probe.close.assert_called_once()
    sleeping.assert_not_called()
# Scheduler oversleep must not admit a newly free port after the deadline.
probe = Mock()
probe.bind.side_effect = [OSError(errno.EADDRINUSE, 'synthetic contention'), None]
with patch.object(m.socket, 'socket', return_value=probe), patch.object(m.time, 'sleep'), patch.object(m.time, 'monotonic', side_effect=[0, 0, 2]):
    try:
        m.require_ports_free([8080], wait_seconds=1)
    except OSError as caught:
        assert caught.errno == errno.EADDRINUSE
    else:
        raise AssertionError('port admitted after the deadline')
    probe.bind.assert_called_once()
    probe.close.assert_called_once()
`], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
