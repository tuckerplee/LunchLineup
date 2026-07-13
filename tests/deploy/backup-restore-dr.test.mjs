import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0;
}

function findBash() {
  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    return existsSync(gitBash) ? gitBash : undefined;
  }
  return commandWorks('bash', ['--version']) ? 'bash' : undefined;
}

function bashPath(path) {
  return path.replaceAll('\\', '/');
}

function createBackupFixture(name = 'lunchlineup-20260709000000.sql.zst.gpg', withChecksum = true) {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-backup-dr-'));
  const backupFile = join(scratch, name);
  const payload = 'encrypted fixture placeholder\n';
  writeFileSync(backupFile, payload);

  if (withChecksum) {
    const hash = createHash('sha256').update(payload).digest('hex');
    writeFileSync(`${backupFile}.sha256`, `${hash}  ${name}\n`);
  }

  return { scratch, backupFile: bashPath(backupFile) };
}

function runBashScript(bash, script, env = {}, args = []) {
  return spawnSync(bash, [join(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const bash = findBash();
const bashSkip = bash ? false : 'Bash is not available';

test('backup, restore, DR, and retention purge scripts expose machine-checkable proof contracts', () => {
  const backup = read('scripts/backup.sh');
  const restore = read('scripts/restore.sh');
  const drill = read('scripts/dr-drill.sh');
  const retentionPurge = read('scripts/invoke-retained-record-purge.mjs');

  assert.match(backup, /backup_ok backup_file=/);
  assert.match(backup, /BACKUP_RETENTION_DAYS="\$\{BACKUP_RETENTION_DAYS:-35\}"/);
  assert.match(backup, /BACKUP_OFFSITE_RETENTION_DAYS="\$\{BACKUP_OFFSITE_RETENTION_DAYS:-35\}"/);
  assert.match(backup, /offsite_retention_ok mode=/);
  assert.match(backup, /aws s3 rm "\$\{object_uri\}"/);
  assert.match(backup, /rclone deletefile "\$\{object_uri\}"/);
  assert.doesNotMatch(backup, /aws s3 rm[^\n]*--recursive|rclone purge|rclone delete\s/);
  assert.match(backup, /printf '%s  %s\\n' "\$\{BACKUP_SHA256\}" "\$\(basename "\$\{BACKUP_FILE\}"\)"/);

  assert.match(restore, /RESTORE_REQUIRE_CHECKSUM/);
  assert.match(restore, /restore_ok target_env=/);
  assert.match(restore, /restored_table_count=/);
  assert.match(restore, /RESTORE_REHYDRATE_DURABLE_QUEUES/);
  assert.match(restore, /rehydrate-durable-queues\.sql/);

  const rehydrate = read('scripts/rehydrate-durable-queues.sql');
  assert.match(rehydrate, /"publicationStatus" = 'PUBLISHED'/);
  assert.match(rehydrate, /"status" IN \('QUEUED', 'RUNNING', 'RETRYING'\)/);
  assert.match(rehydrate, /"status" = 'QUEUED'::"WebhookDeliveryStatus"/);
  assert.doesNotMatch(rehydrate, /DELIVERED|DEAD_LETTERED/);

  assert.match(drill, /DR_OFFHOST_SOURCE_URI/);
  assert.match(drill, /DR_REQUIRE_OFFHOST_SOURCE/);
  assert.match(drill, /DR_REQUIRE_CHECKSUM/);
  assert.match(drill, /DR_PROOF_FILE/);
  assert.match(drill, /dr_drill_ok backup_sha256=/);
  assert.match(drill, /"completed_at": "\$\(json_escape "\$\{completed_at\}"\)"/);
  assert.match(drill, /"checked_at": "\$\(json_escape "\$\{completed_at\}"\)"/);
  assert.match(drill, /"source_sha": "\$\(json_escape "\$\{DR_SOURCE_SHA\}"\)"/);
  assert.match(drill, /DR_CONTAINER must start with lunchlineup-dr-drill-/);
  assert.match(drill, /postgres:16-alpine@sha256:/);
  assert.match(drill, /DR_IMAGE must include an immutable @sha256 digest/);

  assert.match(retentionPurge, /RETENTION_PURGE_URL/);
  assert.match(retentionPurge, /RETENTION_PURGE_TOKEN_FILE/);
  assert.match(retentionPurge, /purge-expired-retained-records/);
  assert.match(retentionPurge, /lunchlineup_retention_purge_last_attempt_timestamp_seconds/);
  assert.match(retentionPurge, /candidateSchedule/);
  assert.match(retentionPurge, /retention_purge_ok/);
});

test('retained-record purge dry-run invocation writes proof and Prometheus metrics', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-retention-purge-'));
  const tokenPath = join(scratch, 'retention-token');
  const proofPath = join(scratch, 'retention-proof.json');
  const metricsPath = join(scratch, 'retention.prom');
  const lockPath = join(scratch, 'retention.lock');
  const seen = {};
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.method = request.method;
      seen.url = request.url;
      seen.authorization = request.headers.authorization;
      seen.body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        candidates: [
          {
            id: 'tenant_123',
            slug: 'acme-dining',
            eligibleForDatabasePurge: true,
            retention: {
              deletionRequestedAt: '2019-07-09T00:00:00.000Z',
              fullDatabasePurgeEligibleAt: '2026-07-09T00:00:00.000Z',
            },
          },
        ],
        deletedCounts: {
          tenants: 0,
          users: 0,
        },
      }));
    });
  });

  try {
    writeFileSync(tokenPath, 'test-retention-token\n');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    const result = await execFileAsync(process.execPath, ['scripts/invoke-retained-record-purge.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        RETENTION_PURGE_URL: `http://127.0.0.1:${port}/api/v1/admin/retention/purge-expired`,
        RETENTION_PURGE_TOKEN_FILE: tokenPath,
        RETENTION_PURGE_PROOF_FILE: proofPath,
        RETENTION_PURGE_METRICS_FILE: metricsPath,
        RETENTION_PURGE_LOCK_FILE: lockPath,
      },
    });

    assert.match(result.stdout, /retention_purge_ok mode=dry_run/);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/v1/admin/retention/purge-expired');
    assert.equal(seen.authorization, 'Bearer test-retention-token');
    assert.deepEqual(JSON.parse(seen.body), { dryRun: true, stage: 'retained_records' });

    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    assert.equal(proof.status, 'ok');
    assert.equal(proof.mode, 'dry_run');
    assert.equal(proof.candidateTenantCount, 1);
    assert.equal(proof.deletedRecordCount, 0);
    assert.deepEqual(proof.candidateSchedule, [
      {
        tenantId: 'tenant_123',
        deletionRequestedAt: '2019-07-09T00:00:00.000Z',
        eligibleAt: '2026-07-09T00:00:00.000Z',
      },
    ]);
    assert.match(proof.responseSha256, /^[a-f0-9]{64}$/);

    const metrics = readFileSync(metricsPath, 'utf8');
    assert.match(metrics, /lunchlineup_retention_purge_last_attempt_timestamp_seconds\{mode="dry_run"\}/);
    assert.match(metrics, /lunchlineup_retention_purge_last_success\{mode="dry_run"\} 1/);
    assert.match(metrics, /lunchlineup_retention_purge_last_candidate_tenants\{mode="dry_run"\} 1/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('retained-record purge execution sends API confirmation', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-retention-purge-execute-'));
  const tokenPath = join(scratch, 'retention-token');
  const proofPath = join(scratch, 'retention-proof.json');
  const lockPath = join(scratch, 'retention.lock');
  const seen = {};
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.method = request.method;
      seen.body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        candidates: [],
        purgedTenants: [
          {
            id: 'tenant_123',
            deleted: true,
            deletedRecordCounts: {
              users: 1,
              sessions: 2,
            },
          },
        ],
      }));
    });
  });

  try {
    writeFileSync(tokenPath, 'test-retention-token\n');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    const result = await execFileAsync(process.execPath, ['scripts/invoke-retained-record-purge.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        RETENTION_PURGE_URL: `http://127.0.0.1:${port}/api/v1/admin/retention/purge-expired`,
        RETENTION_PURGE_TOKEN_FILE: tokenPath,
        RETENTION_PURGE_DRY_RUN: 'false',
        RETENTION_PURGE_EXECUTE_CONFIRM: 'purge-expired-retained-records',
        RETENTION_PURGE_PROOF_FILE: proofPath,
        RETENTION_PURGE_LOCK_FILE: lockPath,
      },
    });

    assert.match(result.stdout, /retention_purge_ok mode=execute/);
    assert.equal(seen.method, 'POST');
    assert.deepEqual(JSON.parse(seen.body), {
      dryRun: false,
      stage: 'retained_records',
      executeConfirmation: 'purge-expired-retained-records',
    });

    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    assert.equal(proof.status, 'ok');
    assert.equal(proof.mode, 'execute');
    assert.equal(proof.deletedRecordCount, 3);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('retention purge continues past failed oldest tenants and fails the overall bounded run', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-retention-purge-pages-'));
  const tokenPath = join(scratch, 'retention-token');
  const proofPath = join(scratch, 'retention-proof.json');
  const metricsPath = join(scratch, 'retention.prom');
  const lockPath = join(scratch, 'retention.lock');
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      if (!body.continuation) {
        response.end(JSON.stringify({
          candidates: [{ id: 'tenant-old', deletedAt: '2026-01-01T00:00:00.000Z' }],
          failedTenants: [{ id: 'tenant-old', error: 'simulated timeout' }],
          failedTenantCount: 1,
          processedTenantCount: 1,
          pendingDeletionBillingCandidates: [{ id: 'tenant-pending', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }],
          reconciledDeletionTenants: [{ id: 'tenant-recovered', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }],
          nextContinuation: { deletedAt: '2026-01-01T00:00:00.000Z', id: 'tenant-old' },
        }));
      } else {
        response.end(JSON.stringify({
          candidates: [{ id: 'tenant-new', deletedAt: '2026-02-01T00:00:00.000Z' }],
          applicationDataPurgedTenants: [{ id: 'tenant-new', deletedRecordCounts: { users: 2 } }],
          processedTenantCount: 1,
          skippedTenants: [{ id: 'tenant-busy', reason: 'already claimed' }],
          skippedTenantCount: 1,
          nextContinuation: null,
        }));
      }
    });
  });

  try {
    writeFileSync(tokenPath, 'test-retention-token\n');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    let failure;
    try {
      await execFileAsync(process.execPath, ['scripts/invoke-retained-record-purge.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          RETENTION_PURGE_URL: `http://127.0.0.1:${port}/api/v1/admin/retention/purge-expired`,
          RETENTION_PURGE_TOKEN_FILE: tokenPath,
          RETENTION_PURGE_DRY_RUN: 'false',
          RETENTION_PURGE_STAGE: 'application_data',
          RETENTION_PURGE_EXECUTE_CONFIRM: 'purge-expired-application-data',
          RETENTION_PURGE_PROOF_FILE: proofPath,
          RETENTION_PURGE_METRICS_FILE: metricsPath,
          RETENTION_PURGE_LOCK_FILE: lockPath,
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'failedTenants must make the wrapper exit nonzero');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].continuation, { deletedAt: '2026-01-01T00:00:00.000Z', id: 'tenant-old' });
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    assert.equal(proof.status, 'failed');
    assert.equal(proof.pageCount, 2);
    assert.equal(proof.failedTenantCount, 1);
    assert.equal(proof.skippedTenantCount, 1);
    assert.equal(proof.processedTenantCount, 2);
    assert.deepEqual(proof.pendingDeletionBillingCandidates, [{ id: 'tenant-pending', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }]);
    assert.deepEqual(proof.reconciledDeletionTenants, [{ id: 'tenant-recovered', deletionRequestedAt: '2026-01-01T00:00:00.000Z' }]);
    assert.deepEqual(proof.failedTenants, [{ id: 'tenant-old', error: 'simulated timeout' }]);
    const metrics = readFileSync(metricsPath, 'utf8');
    assert.match(metrics, /lunchlineup_retention_purge_last_success\{mode="execute"\} 0/);
    assert.match(metrics, /lunchlineup_retention_purge_last_failed_tenants\{mode="execute"\} 1/);
    assert.match(metrics, /lunchlineup_retention_purge_last_skipped_tenants\{mode="execute"\} 1/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('retained-record purge execution fails closed without confirmation before network', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-retention-purge-confirm-'));
  const tokenPath = join(scratch, 'retention-token');
  const proofPath = join(scratch, 'retention-proof.json');
  const metricsPath = join(scratch, 'retention.prom');
  const lockPath = join(scratch, 'retention.lock');

  try {
    writeFileSync(tokenPath, 'test-retention-token\n');
    const result = spawnSync(process.execPath, ['scripts/invoke-retained-record-purge.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RETENTION_PURGE_URL: 'http://127.0.0.1:1/api/v1/admin/retention/purge-expired',
        RETENTION_PURGE_TOKEN_FILE: tokenPath,
        RETENTION_PURGE_DRY_RUN: 'false',
        RETENTION_PURGE_PROOF_FILE: proofPath,
        RETENTION_PURGE_METRICS_FILE: metricsPath,
        RETENTION_PURGE_LOCK_FILE: lockPath,
      },
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /RETENTION_PURGE_EXECUTE_CONFIRM=purge-expired-retained-records is required for retained_records execution/);

    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    assert.equal(proof.status, 'failed');
    assert.equal(proof.mode, 'execute');
    assert.equal(proof.httpStatus, 0);

    const metrics = readFileSync(metricsPath, 'utf8');
    assert.match(metrics, /lunchlineup_retention_purge_last_success\{mode="execute"\} 0/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('DR drill rejects missing off-host source before Docker is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture();
  try {
    const result = runBashScript(bash, 'scripts/dr-drill.sh', {
      BACKUP_FILE: backupFile,
      BACKUP_ENCRYPTION_KEY: 'test-key',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /DR_OFFHOST_SOURCE_URI is required/);
    assert.doesNotMatch(output, /Required command is missing: docker/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('backup rejects unsafe backup directories before pg_dump is required', { skip: bashSkip }, () => {
  const result = runBashScript(bash, 'scripts/backup.sh', {
    BACKUP_DIR: '/',
    BACKUP_ENCRYPTION_KEY: 'test-key',
  });

  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /BACKUP_DIR must be a dedicated backup directory/);
  assert.doesNotMatch(output, /Required command is missing: pg_dump/);
});

test('DR drill rejects vague latest backup aliases before Docker is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture('latest.sql.zst.gpg');
  try {
    const result = runBashScript(bash, 'scripts/dr-drill.sh', {
      BACKUP_FILE: backupFile,
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_OFFHOST_SOURCE_URI: 's3://lunchlineup-prod/db-backups/latest.sql.zst.gpg',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /Refusing vague drill target/);
    assert.doesNotMatch(output, /Required command is missing: docker/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('DR drill rejects unsafe container names before Docker is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture();
  try {
    const result = runBashScript(bash, 'scripts/dr-drill.sh', {
      BACKUP_FILE: backupFile,
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_CONTAINER: 'postgres',
      DR_OFFHOST_SOURCE_URI: 's3://lunchlineup-prod/db-backups/lunchlineup-20260709000000.sql.zst.gpg',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /DR_CONTAINER must start with lunchlineup-dr-drill-/);
    assert.doesNotMatch(output, /Required command is missing: docker/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('DR drill rejects unpinned images before Docker is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture();
  try {
    const result = runBashScript(bash, 'scripts/dr-drill.sh', {
      BACKUP_FILE: backupFile,
      BACKUP_ENCRYPTION_KEY: 'test-key',
      DR_IMAGE: 'postgres:16-alpine',
      DR_OFFHOST_SOURCE_URI: 's3://lunchlineup-prod/db-backups/lunchlineup-20260709000000.sql.zst.gpg',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /DR_IMAGE must include an immutable @sha256 digest/);
    assert.doesNotMatch(output, /Required command is missing: docker/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('restore requires checksum proof before psql is required', { skip: bashSkip }, () => {
  const { scratch, backupFile } = createBackupFixture('lunchlineup-20260709000000.sql.zst.gpg', false);
  try {
    const result = runBashScript(bash, 'scripts/restore.sh', {
      BACKUP_ENCRYPTION_KEY: 'test-key',
      RESTORE_TARGET_ENV: 'disposable',
      RESTORE_CONFIRM: 'restore-lunchlineup',
    }, [backupFile]);

    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /Checksum file is required by default/);
    assert.doesNotMatch(output, /Required command is missing: psql/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('restore forces an atomic rollback when decryption or decompression fails', () => {
  const backup = read('scripts/backup.sh');
  const restore = read('scripts/restore.sh');

  assert.match(backup, /pg_dump[\s\S]*--clean[\s\S]*--if-exists/);
  assert.match(restore, /if ! gpg[\s\S]*\| zstd -d -c; then/);
  assert.match(restore, /RAISE EXCEPTION 'backup stream validation failed'/);
  assert.match(restore, /--single-transaction/);
  for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    assert.match(restore, new RegExp(`has_table_privilege\\(current_user, relation\\.oid, '${privilege}'\\)`));
  }
});
