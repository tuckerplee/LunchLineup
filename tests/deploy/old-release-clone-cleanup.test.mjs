import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const helper = join(root, 'scripts', 'destroy-old-release-compatibility-clone.sh');
const bashPath = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const bashAvailable = spawnSync(bashPath, ['--version'], { encoding: 'utf8' }).status === 0;

function bashPathFor(path) {
  if (process.platform !== 'win32') return path;
  return path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');
}

test('failed clone destroy preserves its driver for the always-run retry', { skip: !bashAvailable }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-clone-cleanup-'));
  const driver = join(scratch, 'clone-driver.sh');
  const cloneEnv = join(scratch, 'clone.env');
  const survivor = join(scratch, 'clone-survivor');
  const attempts = join(scratch, 'destroy-attempts');
  try {
    writeFileSync(cloneEnv, 'DATABASE_URL=postgres://clone\n');
    writeFileSync(survivor, 'present\n');
    writeFileSync(driver, `#!/usr/bin/env bash
set -euo pipefail
[[ "$OLD_RELEASE_COMPATIBILITY_CLONE_OPERATION" == "destroy" ]]
count=0
[[ ! -f '${bashPathFor(attempts)}' ]] || count="$(cat '${bashPathFor(attempts)}')"
count=$((count + 1))
printf '%s\n' "$count" > '${bashPathFor(attempts)}'
if (( count == 1 )); then exit 42; fi
rm -f '${bashPathFor(survivor)}'
`);
    chmodSync(driver, 0o700);
    const args = [
      bashPathFor(helper),
      '--driver', bashPathFor(driver),
      '--clone-env', bashPathFor(cloneEnv),
      '--clone-id', 'llc-12345-1-fixture123456',
      '--production-runtime-env', '/tmp/production-runtime.env',
      '--timeout-seconds', '10',
    ];

    const first = spawnSync(bashPath, args, { cwd: root, encoding: 'utf8' });
    assert.equal(first.status, 42, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stderr, /preserving the driver and clone environment for the always-run retry/);
    assert.equal(existsSync(driver), true);
    assert.equal(existsSync(cloneEnv), true);
    assert.equal(existsSync(survivor), true);

    const second = spawnSync(bashPath, args, { cwd: root, encoding: 'utf8' });
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(readFileSync(attempts, 'utf8').trim(), '2');
    assert.equal(existsSync(driver), false);
    assert.equal(existsSync(cloneEnv), false);
    assert.equal(existsSync(survivor), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
