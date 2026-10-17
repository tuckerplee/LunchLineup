import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const systemdRoot = join(root, 'infrastructure', 'systemd');

function readUnit(name) {
  return readFileSync(join(systemdRoot, name), 'utf8');
}

test('restart target survives rollback staging cleanup through the durable current pointer', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'll-active-release-'));
  try {
    const sourceSha = '3'.repeat(40);
    const stage = join(scratch, 'stage');
    const release = join(scratch, 'releases', sourceSha);
    const current = join(scratch, 'current');
    mkdirSync(stage);
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, 'DEPLOYED_GIT_SHA'), `${sourceSha}\n`);
    writeFileSync(join(release, 'restart-marker.txt'), 'retained-release\n');
    symlinkSync(release, current, process.platform === 'win32' ? 'junction' : 'dir');

    rmSync(stage, { recursive: true });

    assert.equal(realpathSync(current), realpathSync(release));
    const restart = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:fs').readFileSync('restart-marker.txt','utf8'))"], {
      cwd: current,
      encoding: 'utf8',
    });
    assert.equal(restart.status, 0, restart.stderr);
    assert.equal(restart.stdout, 'retained-release\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('probe and retention jobs intentionally follow the active current pointer', () => {

  for (const unit of [
    'lunchlineup-public-web-probe.service',
    'lunchlineup-retained-record-review.service',
    'lunchlineup-retention-purge.service',
  ]) {
    assert.match(readUnit(unit), /\/opt\/lunchlineup\/current/);
  }
  assert.match(
    readFileSync(join(systemdRoot, 'lunchlineup-public-web-probe.env.example'), 'utf8'),
    /PUBLIC_WEB_PROBE_EXPECTED_RELEASE_FILE=\/opt\/lunchlineup\/current\/DEPLOYED_GIT_SHA/,
  );
});
