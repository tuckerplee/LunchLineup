import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = process.env.GIT || (existsSync('C:/Program Files/Git/cmd/git.exe') ? 'C:/Program Files/Git/cmd/git.exe' : 'git');

function trackedFiles() {
  return execFileSync(git, ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'));
}

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('repository does not track deploy secrets or local environment files', () => {
  const forbidden = trackedFiles().filter((file) => {
    if (file.endsWith('.env.example')) return false;
    return (
      /(^|\/)\.env(\.|$)/.test(file) ||
      /^secrets\//.test(file) ||
      /\.(pem|key)$/.test(file)
    );
  });

  assert.deepEqual(forbidden, [], `Tracked secret-like files: ${forbidden.join(', ')}`);
});

test('legacy public backup directory contains no backup payloads', () => {
  const backupFiles = trackedFiles().filter((file) => file.startsWith('old/public/backups/'));
  const allowed = new Set(['old/public/backups/.gitignore', 'old/public/backups/README.md']);
  const payloads = backupFiles.filter((file) => !allowed.has(file));

  assert.deepEqual(payloads, [], `Tracked public backup payloads: ${payloads.join(', ')}`);
});

test('root ignore rules cover generated and sensitive rebuild artifacts', () => {
  const gitignore = read('.gitignore');
  for (const expected of [
    '.env',
    '.env.local',
    'secrets/',
    'node_modules/',
    'apps/web/.next/',
    'apps/api/dist/',
    'packages/*/dist/',
    '.turbo/',
    '*.log',
  ]) {
    assert.match(gitignore, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('CI runs migration hygiene before build and deploy stages', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /npm run typecheck/);
  assert.match(ci, /npm run test:migration/);
  assert.match(ci, /github\.sha/);
});

test('folder-level documentation covers the migration test files', () => {
  const readme = read('tests/README.md');
  for (const expected of [
    'hygiene/repository-hygiene.test.mjs',
    'migration/legacy-parity-inventory.test.mjs',
    'deploy/deploy-source.test.mjs',
    'integration/ephemeral-stack.test.mjs',
  ]) {
    assert.match(readme, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
