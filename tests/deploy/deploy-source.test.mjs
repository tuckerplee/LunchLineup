import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function exists(path) {
  return existsSync(join(root, path));
}

test('deploy-source verification scripts exist for Windows and Linux operators', () => {
  assert.equal(exists('scripts/verify-deploy-source.ps1'), true);
  assert.equal(exists('scripts/verify-deploy-source.sh'), true);
  assert.equal(exists('scripts/bootstrap-vm107-dev.sh'), true);
});

test('deploy-source scripts require clean Git state and upstream push proof', () => {
  const ps1 = read('scripts/verify-deploy-source.ps1');
  const sh = read('scripts/verify-deploy-source.sh');

  for (const script of [ps1, sh]) {
    assert.match(script, /git status/);
    assert.match(script, /rev-parse/);
    assert.match(script, /@{u}/);
    assert.match(script, /DEPLOYED_GIT_SHA/);
  }
});

test('deployment docs keep GitHub and server artifact discipline explicit', () => {
  const doc = read('docs/testing/README.md');
  assert.match(doc, /server deploy/i);
  assert.match(doc, /GitHub/i);
  assert.match(doc, /DEPLOYED_GIT_SHA/);
});

test('disposable VM107 restore is documented and tied to GitHub deploy proof', () => {
  const script = read('scripts/bootstrap-vm107-dev.sh');
  const runbook = read('docs/runbooks/disposable-dev-server.md');
  const runbooksReadme = read('docs/runbooks/README.md');
  const scriptsReadme = read('scripts/README.md');

  assert.match(script, /migration-testing-baseline/);
  assert.match(script, /DEPLOYED_GIT_SHA/);
  assert.match(script, /BACKUP_FILE/);
  assert.match(script, /dev\.lunchlineup\.com/);
  assert.match(runbook, /15 minutes/i);
  assert.match(runbook, /GitHub/i);
  assert.match(runbook, /DEPLOYED_GIT_SHA/);
  assert.match(runbooksReadme, /disposable-dev-server\.md/);
  assert.match(scriptsReadme, /bootstrap-vm107-dev\.sh/);
});
