import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const shellPath = (path) => process.platform === 'win32'
  ? path.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/') : path;

const cases = [
  ['2026-02-30T12:00:00Z', false],
  ['1900-02-29T12:00:00Z', false],
  ['2026-13-01T12:00:00Z', false],
  ['2026-01-01T25:00:00Z', false],
  ['2026-01-01T12:60:00Z', false],
  ['2026-01-01T12:00:99Z', false],
  ['0000-01-01T12:00:00Z', false],
  ['2026-01-01T12:00:00.Z', false],
  ['2026-01-01T12:00:00.not-a-fractionZ', false],
  ["2026-01-01T12:00:00.1'\nport=1\n#Z", false],
  ['2026-01-01T12:00:00Z\n', false],
  ['2026-01-01T12:00:00Z', true],
  ['2000-02-29T12:00:00Z', true],
  ['2024-02-29T23:59:59.123456Z', true],
  ['2026-01-01T12:00:00.123456789Z', true],
];

for (const [timestamp, valid] of cases) {
  test(`PITR recovery time preflight ${valid ? 'accepts' : 'rejects'} ${JSON.stringify(timestamp)}`, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-pitr-time-'));
    const target = join(scratch, 'restore');
    try {
      const result = spawnSync(bash, [shellPath(join(root, 'scripts/pitr-restore.sh'))], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: {
          ...process.env,
          PITR_BASE_BACKUP_ID: '20261008T120000Z-123',
          PITR_RECOVERY_TARGET_TIME: timestamp,
          // Stop at the next existing gate, before tools, providers, or mkdir.
          PITR_ARCHIVED_WAL_SEGMENT: 'invalid-wal',
          PITR_STAGING_DIR: shellPath(join(scratch, 'staging')),
          PITR_RESTORE_DATA_DIR: shellPath(target),
        },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, valid ? /PITR_ARCHIVED_WAL_SEGMENT/ : /PITR_RECOVERY_TARGET_TIME/);
      assert.equal(existsSync(target), false, 'preflight must not materialize storage');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
