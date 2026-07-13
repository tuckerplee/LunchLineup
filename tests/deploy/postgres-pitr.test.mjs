import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bash = process.platform === 'win32' && existsSync('C:\\Program Files\\Git\\bin\\bash.exe')
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function serviceBlock(compose, serviceName) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(start, -1, `missing Compose service: ${serviceName}`);
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join('\n');
}

test('Compose wires remote-confirmed WAL archiving and isolated PITR services', () => {
  const compose = read('docker-compose.yml');
  const postgres = serviceBlock(compose, 'postgres');
  const tools = serviceBlock(compose, 'pitr-tools');
  const baseBackup = serviceBlock(compose, 'pitr-base-backup');
  const restore = serviceBlock(compose, 'pitr-restore');
  const migrate = serviceBlock(compose, 'migrate');
  const deploy = read('scripts/deploy-vm217-remote.sh');

  assert.match(tools, /minio\/mc:RELEASE\.2025-08-13T08-35-41Z@sha256:[a-f0-9]{64}/);
  assert.match(tools, /pitr_tools:\/tools/);
  assert.match(postgres, /infrastructure\/postgres:\/opt\/lunchlineup\/pitr:ro/);
  assert.match(postgres, /pitr_tools:\/opt\/lunchlineup\/tools:ro/);
  assert.match(postgres, /PITR_ENABLED=\$\{PITR_ENABLED:-false\}/);
  assert.match(postgres, /PITR_WAL_OBJECT_STORE_SECRETS_DIR.*:\/run\/secrets\/pitr-wal-object-store:ro/);
  assert.match(postgres, /PITR_ACCESS_KEY_FILE=\/run\/secrets\/pitr-wal-object-store\/access_key/);
  assert.match(baseBackup, /PITR_BASE_BACKUP_OBJECT_STORE_SECRETS_DIR.*:\/run\/secrets\/pitr-base-backup-object-store:ro/);
  assert.match(baseBackup, /PITR_ACCESS_KEY_FILE=\/run\/secrets\/pitr-base-backup-object-store\/access_key/);
  assert.match(restore, /PITR_RESTORE_OBJECT_STORE_SECRETS_DIR.*:\/run\/secrets\/pitr-restore-object-store:ro/);
  assert.match(restore, /PITR_ACCESS_KEY_FILE=\/run\/secrets\/pitr-restore-object-store\/access_key/);
  assert.doesNotMatch(postgres, /pitr-base-backup-object-store|pitr-restore-object-store/);
  assert.doesNotMatch(baseBackup, /pitr-wal-object-store|pitr-restore-object-store/);
  assert.doesNotMatch(restore, /pitr-wal-object-store|pitr-base-backup-object-store/);
  assert.doesNotMatch(migrate, /PITR_|pitr-.*object-store|lifecycle/);
  assert.doesNotMatch(compose, /PITR_LIFECYCLE.*SECRETS|pitr-lifecycle-object-store/);
  assert.match(postgres, /PITR_WAL_METRICS_FILE=\/metrics\/lunchlineup_pitr_wal\.prom/);
  assert.match(postgres, /NODE_EXPORTER_TEXTFILE_DIR:-\/var\/lib\/node_exporter\/textfile_collector\}:\/metrics/);
  assert.match(postgres, /condition: service_completed_successfully/);
  assert.match(baseBackup, /pitr-base-backup\.sh/);
  assert.match(baseBackup, /PITR_OBJECT_LOCK_RETENTION_DAYS/);
  assert.match(baseBackup, /lunchlineup_pitr\.prom/);
  assert.match(restore, /profiles:\s*\n\s*- recovery/);
  assert.match(restore, /PITR_ARCHIVED_WAL_SEGMENT=\$\{PITR_ARCHIVED_WAL_SEGMENT:-\}/);
  assert.match(restore, /postgres_pitr_restore_data:\/restore/);
  assert.doesNotMatch(restore, /postgres_data:\/restore/);
  assert.match(compose, /^  pitr-egress:\s*$/m);
  assert.match(compose, /^  pitr_tools:\s*$/m);
  assert.match(compose, /^  pitr_staging:\s*$/m);
  assert.match(compose, /^  postgres_pitr_restore_data:\s*$/m);
  const storagePreflight = deploy.indexOf('bash scripts/pitr-verify-storage.sh');
  const stackMutation = deploy.indexOf('compose_release up -d --no-build --pull never');
  assert.ok(storagePreflight > 0 && storagePreflight < stackMutation);
});

test('Postgres only acknowledges production WAL after encrypted remote durability proof', () => {
  const config = read('infrastructure/postgres/postgresql.conf');
  const archive = read('infrastructure/postgres/archive-wal.sh');
  const common = read('infrastructure/postgres/pitr-object-store.sh');

  assert.match(config, /^wal_level = replica$/m);
  assert.match(config, /^archive_mode = on$/m);
  assert.match(config, /archive_command = 'sh \/opt\/lunchlineup\/pitr\/archive-wal\.sh/);
  assert.match(config, /^archive_timeout = 60s$/m);
  assert.match(archive, /pitr_mc stat/);
  assert.match(archive, /cmp -s/);
  assert.match(archive, /Remote WAL object exists with different bytes/);
  assert.match(archive, /pitr_upload_encrypted/);
  assert.match(common, /--checksum SHA256/);
  assert.match(common, /--disable-multipart/);
  assert.match(common, /--enc-s3/);
  assert.match(common, /--retention-mode COMPLIANCE/);
  assert.match(common, /--retention-duration "\$\{PITR_OBJECT_LOCK_RETENTION_DAYS\}d"/);
  assert.match(common, /PITR_S3_ENDPOINT must use HTTPS/);
});

test('PITR shell scripts parse and disabled development archiving is explicit', (t) => {
  const scripts = [
    'infrastructure/postgres/pitr-object-store.sh',
    'infrastructure/postgres/archive-wal.sh',
    'infrastructure/postgres/restore-wal.sh',
    'infrastructure/postgres/pitr-verify-object-store.sh',
    'scripts/pitr-base-backup.sh',
    'scripts/pitr-verify-storage.sh',
    'scripts/pitr-restore.sh',
  ];
  const version = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    t.skip('bash is not available');
    return;
  }

  for (const path of scripts) {
    const result = spawnSync(bash, ['-n', join(root, path)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-pitr-'));
  try {
    const wal = join(scratch, '000000010000000000000001');
    writeFileSync(wal, 'wal-fixture');
    const disabled = spawnSync(bash, [join(root, 'infrastructure/postgres/archive-wal.sh'), wal, '000000010000000000000001'], {
      encoding: 'utf8',
      env: { ...process.env, PITR_ENABLED: 'false' },
    });
    assert.equal(disabled.status, 0, disabled.stderr);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('archive and restore commands accept only exact PostgreSQL archive names', (t) => {
  const version = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    t.skip('bash is not available');
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-wal-names-'));
  const source = join(scratch, 'source');
  writeFileSync(source, 'archive-fixture');
  try {
    const valid = [
      '000000010000000000000001',
      '00000002.history',
      '000000010000000000000001.00000020.backup',
    ];
    const invalid = [
      '00000001000000000000001',
      '000000010000000000000001.partial',
      '0000000A0000000000000001.backup',
      '000000010000000000000001.0000002.backup',
      '000000010000000000000001.00000020.backup.extra',
      '0000000a.history',
      '../000000010000000000000001',
    ];

    for (const name of valid) {
      const archived = spawnSync(
        bash,
        [join(root, 'infrastructure/postgres/archive-wal.sh'), source, name],
        { encoding: 'utf8', env: { ...process.env, PITR_ENABLED: 'false' } },
      );
      assert.equal(archived.status, 0, `archive should accept ${name}: ${archived.stderr}`);

      const restored = spawnSync(
        bash,
        [join(root, 'infrastructure/postgres/restore-wal.sh'), name, join(scratch, 'restore')],
        { encoding: 'utf8', env: { ...process.env, PITR_ENABLED: 'false' } },
      );
      assert.doesNotMatch(restored.stderr, /Unexpected WAL restore filename/, name);
    }

    for (const name of invalid) {
      const archived = spawnSync(
        bash,
        [join(root, 'infrastructure/postgres/archive-wal.sh'), source, name],
        { encoding: 'utf8', env: { ...process.env, PITR_ENABLED: 'false' } },
      );
      assert.notEqual(archived.status, 0, `archive should reject ${name}`);
      assert.match(archived.stderr, /Unexpected WAL archive filename/);

      const restored = spawnSync(
        bash,
        [join(root, 'infrastructure/postgres/restore-wal.sh'), name, join(scratch, 'restore')],
        { encoding: 'utf8', env: { ...process.env, PITR_ENABLED: 'false' } },
      );
      assert.notEqual(restored.status, 0, `restore should reject ${name}`);
      assert.match(restored.stderr, /Unexpected WAL restore filename/);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test('base backup, retention, restore, timer, and runbook form a machine-checkable PITR chain', () => {
  const base = read('scripts/pitr-base-backup.sh');
  const restore = read('scripts/pitr-restore.sh');
  const timer = read('infrastructure/systemd/lunchlineup-pitr-base-backup.timer');
  const service = read('infrastructure/systemd/lunchlineup-pitr-base-backup.service');
  const runbook = read('docs/runbooks/postgres-pitr-recovery.md');
  const storageVerifier = read('infrastructure/postgres/pitr-verify-object-store.sh');

  assert.match(base, /pg_basebackup/);
  assert.match(base, /--format=plain/);
  assert.match(base, /--wal-method=stream/);
  assert.match(base, /--manifest-checksums=SHA256/);
  assert.match(base, /pg_verifybackup --no-parse-wal --exit-on-error "\$\{BACKUP_DATA_DIR\}"/);
  assert.doesNotMatch(base, /pg_verifybackup --format=tar/);
  assert.ok(base.indexOf('pg_verifybackup') < base.indexOf('tar -czf'));
  assert.ok(base.indexOf('COMPLETE is the commit marker') < base.indexOf('pitr_upload_encrypted "${BACKUP_DIR}/COMPLETE"'));
  assert.doesNotMatch(base, /pitr_mc rm|--older-than|PITR_(?:BASE_BACKUP|WAL)_RETENTION_DAYS/);
  assert.match(restore, /PITR_BASE_BACKUP_ID/);
  assert.match(restore, /PITR_RECOVERY_TARGET_TIME/);
  assert.match(restore, /PITR_ARCHIVED_WAL_SEGMENT/);
  assert.match(restore, /PITR_RESTORE_CONFIRM/);
  assert.match(restore, /Remote base backup has no COMPLETE commit marker/);
  assert.match(restore, /COMPLETE marker does not match the named base backup/);
  assert.match(restore, /Named archived WAL segment is not remotely durable/);
  assert.match(restore, /PITR_RESTORE_DATA_DIR must be empty/);
  assert.match(restore, /pg_verifybackup --no-parse-wal --exit-on-error "\$\{PITR_RESTORE_DATA_DIR\}"/);
  assert.doesNotMatch(restore, /pg_verifybackup --format=tar/);
  assert.ok(
    restore.indexOf('tar -xzf')
      < restore.indexOf('pg_verifybackup --no-parse-wal --exit-on-error "${PITR_RESTORE_DATA_DIR}"'),
  );
  assert.match(restore, /recovery\.signal/);
  assert.match(restore, /recovery_target_action = 'pause'/);
  assert.match(service, /--pull never pitr-base-backup/);
  assert.match(timer, /Persistent=true/);
  assert.match(storageVerifier, /version info/);
  assert.match(storageVerifier, /retention info --default/);
  assert.match(storageVerifier, /identity can create delete markers/);
  assert.match(storageVerifier, /pitr_mc rm --force/);
  assert.match(storageVerifier, /pitr_mc rm --versions --force/);
  assert.match(storageVerifier, /pitr_mc stat "\$\{PROBE_REMOTE\}"/);
  assert.match(runbook, /pg_stat_archiver/);
  assert.match(runbook, /postgres_pitr_restore_data/);
  assert.match(runbook, /pg_wal_replay_resume/);
  assert.match(runbook, /Do not delete or reuse the original volume/);
});
