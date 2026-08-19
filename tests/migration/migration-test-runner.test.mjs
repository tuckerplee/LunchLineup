import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const runner = join(root, 'scripts', 'run-migration-tests.mjs');

test('migration test runner produces a complete deterministic dry-run plan', () => {
  const result = spawnSync(process.execPath, [runner, '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LUNCHLINEUP_MIGRATION_TEST_GROUPS: '',
      LUNCHLINEUP_MIGRATION_TEST_FILE_TIMEOUT_MS: '120000',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migration-test-runner plan=\d+ file_timeout_ms=120000 total_timeout_ms=3600000 overridden_files=0 mode=dry-run/);
  for (const group of ['deploy', 'hygiene', 'migration', 'terraform']) {
    assert.match(result.stdout, new RegExp(`migration-test-runner group=${group} files=\\d+`));
  }
  assert.doesNotMatch(result.stdout, /start=\d+\//);
});

test('migration test runner gives comprehensive recovery, VM217 transport, cutover, and durable-runtime files bounded larger defaults', () => {
  const result = spawnSync(process.execPath, [runner, '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LUNCHLINEUP_MIGRATION_TEST_GROUPS: '',
      LUNCHLINEUP_MIGRATION_TEST_FILE_TIMEOUT_MS: '',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /file_timeout_ms=120000 total_timeout_ms=3600000 overridden_files=5 mode=dry-run/);
});

test('migration test runner serializes tests inside each owned file', () => {
  const source = readFileSync(runner, 'utf8');
  assert.match(source, /\['--test', '--test-concurrency=1', entry\.file\]/);
  assert.match(source, /const WINDOWS_ATTACHED_TESTS = new Set\(\[[\s\S]*deploy-vm217-transport\.test\.mjs[\s\S]*initial-vm217-cutover\.test\.mjs[\s\S]*\]\)/);
  assert.match(source, /detached: process\.platform !== 'win32' \|\| !WINDOWS_ATTACHED_TESTS\.has\(entry\.file\)/);
});

test('migration test runner rejects an unbounded file timeout', () => {
  const result = spawnSync(process.execPath, [runner, '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LUNCHLINEUP_MIGRATION_TEST_GROUPS: '',
      LUNCHLINEUP_MIGRATION_TEST_FILE_TIMEOUT_MS: '0',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /LUNCHLINEUP_MIGRATION_TEST_FILE_TIMEOUT_MS must be between 10000 and 600000/);
});

test('migration test runner rejects an unbounded aggregate timeout', () => {
  const result = spawnSync(process.execPath, [runner, '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      LUNCHLINEUP_MIGRATION_TEST_GROUPS: '',
      LUNCHLINEUP_MIGRATION_TEST_TOTAL_TIMEOUT_MS: '0',
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /LUNCHLINEUP_MIGRATION_TEST_TOTAL_TIMEOUT_MS must be between 60000 and 7200000/);
});
