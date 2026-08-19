import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('retention scheduler publishes password-reset token dry-run proof and metrics', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'lunchlineup-reset-retention-'));
  const tokenPath = join(scratch, 'retention-token');
  const proofPath = join(scratch, 'retention-proof.json');
  const metricsPath = join(scratch, 'retention.prom');
  const lockPath = join(scratch, 'retention.lock');
  let requestBody;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requestBody = JSON.parse(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      candidates: [],
      passwordResetTokenRetention: {
        terminalGraceHours: 24,
        batchLimit: 5000,
        terminalBefore: '2026-07-13T12:00:00.000Z',
        eligibleCount: 11,
        purgedCount: 0,
      },
      processedTenantCount: 0,
      failedTenantCount: 0,
      skippedTenantCount: 0,
      nextContinuation: null,
    }));
  });

  try {
    writeFileSync(tokenPath, 'test-retention-token\n');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();

    await execFileAsync(process.execPath, ['scripts/invoke-retained-record-purge.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        RETENTION_PURGE_URL: `http://127.0.0.1:${port}/api/v2/admin/retention/purge-expired`,
        RETENTION_PURGE_TOKEN_FILE: tokenPath,
        RETENTION_PURGE_DRY_RUN: 'true',
        RETENTION_PURGE_STAGE: 'application_data',
        RETENTION_PURGE_PROOF_FILE: proofPath,
        RETENTION_PURGE_METRICS_FILE: metricsPath,
        RETENTION_PURGE_LOCK_FILE: lockPath,
      },
    });

    assert.deepEqual(requestBody, { dryRun: true, stage: 'application_data' });
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    assert.equal(proof.passwordResetTokenEligibleCount, 11);
    assert.equal(proof.passwordResetTokenPurgedCount, 0);
    assert.deepEqual(proof.passwordResetTokenRetention, {
      terminalGraceHours: 24,
      batchLimit: 5000,
      terminalBefore: '2026-07-13T12:00:00.000Z',
      eligibleCount: 11,
      purgedCount: 0,
    });
    const metrics = readFileSync(metricsPath, 'utf8');
    assert.match(metrics, /lunchlineup_retention_purge_last_eligible_password_reset_tokens\{mode="dry_run",stage="application_data"\} 11/);
    assert.match(metrics, /lunchlineup_retention_purge_last_purged_password_reset_tokens\{mode="dry_run",stage="application_data"\} 0/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(scratch, { recursive: true, force: true });
  }
});
