import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = join(root, 'tests', 'deploy', 'runtime-permission-access.fixture.sh');
const deployScript = join(root, 'scripts', 'deploy-vm217-remote.sh');
const rollbackActivator = join(root, 'scripts', 'activate-retained-rollback.sh');

function wslPath(path) {
  return path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/host/${drive.toLowerCase()}`);
}

const wslAvailable = process.platform === 'win32'
  && spawnSync('wsl.exe', ['--exec', 'sh', '-lc', 'test "$(id -u)" = 0 && command -v setpriv >/dev/null'], { encoding: 'utf8' }).status === 0;
const nativeRootAvailable = process.platform !== 'win32'
  && spawnSync('sh', ['-c', 'test "$(id -u)" = 0 && command -v setpriv >/dev/null'], { encoding: 'utf8' }).status === 0;

test('service-group permissions allow backup, PITR, probe, and marker access as a real non-root identity', {
  skip: !wslAvailable && !nativeRootAvailable,
}, () => {
  const result = wslAvailable
    ? spawnSync('wsl.exe', ['--exec', 'sh', wslPath(fixture), wslPath(deployScript), wslPath(rollbackActivator)], { encoding: 'utf8' })
    : spawnSync('sh', [fixture, deployScript, rollbackActivator], { encoding: 'utf8' });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /runtime_permission_access_fixture_ok uid=[1-9][0-9]* gid=[1-9][0-9]*/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /RUNTIME_PERMISSION_FIXTURE/);
});

test('permission fixture and production scripts are present', () => {
  assert.equal(existsSync(fixture), true);
  assert.equal(existsSync(deployScript), true);
  assert.equal(existsSync(rollbackActivator), true);
});
