import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';

process.env.TS_NODE_PROJECT = fileURLToPath(new URL('../../apps/api/tsconfig.json', import.meta.url));
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { AvailabilityImportPublisher } = require('../../apps/api/src/availability-imports/availability-imports.publisher.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');

const execute = promisify(execFile);
const workerRoot = fileURLToPath(new URL('../../apps/worker', import.meta.url));
async function workerProbe(mode, tenantId, importId, identityHash, applicationName = `ll-pdf-${randomUUID()}`) {
  assert.ok(process.env.PYTHON, 'Integration wrapper installed PYTHON is required; no global interpreter fallback');
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.searchParams.set('application_name', applicationName);
  const { stdout } = await execute(process.env.PYTHON, ['-c', `
import json, sys
from concurrent.futures import ThreadPoolExecutor
from src.availability_import_store import ImportPayload, claim_import, complete_import, terminalize_import, mark_retrying, _sweep_expired_import, AvailabilityImportRejected, AvailabilityImportBusy, _connect
mode, tenant, job, identity, expected_application_name = sys.argv[1:]
with _connect() as connection:
    with connection.cursor() as cursor:
        cursor.execute("SELECT rolsuper, rolbypassrls, current_setting('application_name') FROM pg_roles WHERE rolname = current_user")
        assert cursor.fetchone() == (False, False, expected_application_name)
payload = ImportPayload(job, tenant)
def settle(_):
    return terminalize_import(payload, None, 'FAILED', 'EXPIRED')
try:
    if mode == 'settle-race':
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(settle, range(2)))
        settle(None)
    elif mode == 'retry-lowered':
        mark_retrying(payload, 'new-owner', 1)
    elif mode == 'retention':
        _sweep_expired_import(payload, None, 'RUNNING')
    elif mode == 'hard-only':
        _sweep_expired_import(payload, None, 'RUNNING', False)
    elif mode == 'claim':
        claimed = claim_import(payload, 0, 'new-owner')
        print(json.dumps({'status': 'claimed', 'effective': claimed.effective_retry_count}))
        sys.exit(0)
    else:
        complete_import(payload, 'crashed-worker', identity, [{'dayOfWeek': 1, 'startTimeMinutes': 540, 'endTimeMinutes': 1020}])
    print(json.dumps({'status': 'ok'}))
except (AvailabilityImportRejected, AvailabilityImportBusy) as failure:
    print(json.dumps({'status': 'rejected', 'reason': str(failure)}))
`, mode, tenantId, importId, identityHash, applicationName], {
    cwd: workerRoot, env: { ...process.env, DATABASE_URL: databaseUrl.toString() }, timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

function migrationDatabaseUrl() {
  const value = process.env.MIGRATION_DATABASE_URL;
  assert.ok(value, 'MIGRATION_DATABASE_URL is required for availability lifecycle integration proof');
  return value;
}

test('publisher automatically republishes expired execution owners without touching live, expired or cancelled work', async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: migrationDatabaseUrl() } } });
  assert.ok(process.env.DATABASE_URL, 'restricted DATABASE_URL is required for publisher mutation proof');
  const app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const suffix = randomUUID();
  const tenantId = `tenant-orphan-${suffix}`;
  const userId = `user-orphan-${suffix}`;
  const username = `orphan-${suffix}`;
  const source = Buffer.concat([Buffer.from('LLAI\x03', 'binary'), Buffer.alloc(29, 0x5a)]);
  const ids = Object.fromEntries(['orphan', 'live', 'expired', 'cancelled', 'nulllease', 'retrying',
    'freshnull', 'freshretry', 'retrylive', 'exhausted'].map(kind => [kind, `${kind}-${suffix}`]));
  const published = [];
  const publisher = new AvailabilityImportPublisher(new TenantPrismaService(app));
  publisher.publishMessage = async (_tenantId, id, retryCount) => {
    published.push({ id, retryCount });
    throw new Error('first publication is uncertain');
  };
  let originalFailure;
  try {
    const [role] = await app.$queryRaw`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    assert.notEqual(role.name, new URL(migrationDatabaseUrl()).username);
    // Owner credentials create synthetic fixtures only. The actual publisher
    // runs through the production context owner on the restricted app role.
    await prisma.$executeRaw`
      INSERT INTO "Tenant" ("id", "name", "slug", "status", "planTier", "stripeSubscriptionId", "stripeSubscriptionCurrentPeriodEnd", "createdAt", "updatedAt")
      VALUES (${tenantId}, 'Orphan Recovery', ${`orphan-${suffix}`}, 'ACTIVE'::"TenantStatus", 'GROWTH'::"PlanTier", ${`sub-${suffix}`}, CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    await prisma.$executeRaw`
      INSERT INTO "User" ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
      VALUES (${userId}, ${tenantId}, 'Orphan Staff', ${username}, 'STAFF'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    for (const [kind, id] of Object.entries(ids)) {
      await prisma.$executeRaw`
        INSERT INTO "CreditTransaction" ("id", "tenantId", "amount", "reason", "balanceAfter", "createdAt")
        VALUES (${'feature-usage-availability-import:' + id}, ${tenantId}, -1, ${`Availability PDF import (${id})`}, 4, CURRENT_TIMESTAMP)
      `;
      await prisma.$executeRaw`
        INSERT INTO "AvailabilityImportJob" ("id", "tenantId", "userId", "requestKeyHash", "requestHash", "targetIdentityHash", "encryptedSourcePayload", "fileSha256", "fileSize", "creditConsumption", "expiresAt", "createdAt", "updatedAt")
        VALUES (${id}, ${tenantId}, ${userId}, ${createHash('sha256').update(id).digest('hex')}, ${'2'.repeat(64)},
          ${createHash('sha256').update(username).digest('hex')}, ${source}, ${'4'.repeat(64)}, 9, '{"consumedCredits":1,"newBalance":4}'::jsonb,
          CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      if (kind === 'cancelled') {
        await prisma.$executeRaw`
          UPDATE "AvailabilityImportJob" SET "status" = 'CANCELLED', "encryptedSourcePayload" = NULL,
            "resultErasedAt" = CURRENT_TIMESTAMP, "completedAt" = CURRENT_TIMESTAMP, "publicationStatus" = 'FAILED'
          WHERE "id" = ${id}
        `;
      } else {
        await prisma.$executeRaw`
          UPDATE "AvailabilityImportJob" SET
            "status" = CASE WHEN ${kind} IN ('retrying', 'freshretry', 'retrylive') THEN 'RETRYING'::"AvailabilityImportStatus" ELSE 'RUNNING'::"AvailabilityImportStatus" END,
            "publicationStatus" = 'PUBLISHED', "attempts" = CASE WHEN ${kind} = 'exhausted' THEN 4 ELSE 2 END,
            "startedAt" = CURRENT_TIMESTAMP,
            "executionToken" = CASE WHEN ${kind} IN ('retrying', 'freshretry') THEN NULL ELSE 'crashed-worker' END,
            "executionLeaseUntil" = CASE WHEN ${kind} IN ('live', 'retrylive') THEN CURRENT_TIMESTAMP + INTERVAL '1 hour'
              WHEN ${kind} IN ('nulllease', 'freshnull', 'retrying', 'freshretry') THEN NULL ELSE CURRENT_TIMESTAMP - INTERVAL '1 second' END,
            "updatedAt" = CASE WHEN ${kind} IN ('freshnull', 'freshretry') THEN CURRENT_TIMESTAMP ELSE CURRENT_TIMESTAMP - INTERVAL '20 minutes' END,
            "expiresAt" = CASE WHEN ${kind} = 'expired' THEN CURRENT_TIMESTAMP - INTERVAL '1 second' ELSE "expiresAt" END
          WHERE "id" = ${id}
        `;
      }
    }
    const before = await prisma.availabilityImportJob.findMany({ where: { tenantId }, orderBy: { id: 'asc' } });
    await publisher.publishPending();
    const recoveredKinds = ['orphan', 'nulllease', 'retrying', 'exhausted'];
    assert.deepEqual(published.filter(row => Object.values(ids).includes(row.id)).map(row => row.id).sort(), recoveredKinds.map(kind => ids[kind]).sort());
    for (const kind of recoveredKinds) {
      const row = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids[kind] } });
      assert.equal(row.executionToken, null);
      assert.equal(row.executionLeaseUntil, null);
      assert.equal(row.attempts, kind === 'exhausted' ? 4 : 2);
      assert.equal(published.find(item => item.id === row.id).retryCount, kind === 'exhausted' ? 3 : 2);
      assert.deepEqual(Buffer.from(row.encryptedSourcePayload), source);
    }
    const recovered = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.orphan } });
    assert.equal(recovered.status, 'PENDING');
    assert.equal(recovered.publicationStatus, 'FAILED');
    assert.equal(recovered.executionToken, null);
    assert.equal(recovered.executionLeaseUntil, null);
    assert.deepEqual(Buffer.from(recovered.encryptedSourcePayload), source);
    assert.deepEqual(recovered.creditConsumption, { consumedCredits: 1, newBalance: 4 });
    for (const kind of ['live', 'expired', 'cancelled', 'freshnull', 'freshretry', 'retrylive']) {
      assert.deepEqual(await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids[kind] } }), before.find(row => row.id === ids[kind]));
    }
    // v3 completion binds to requestHash; targetIdentityHash remains the account
    // username hash and is independently checked under the target lock.
    const identity = '2'.repeat(64);
    const stale = await workerProbe('complete', tenantId, ids.nulllease, identity);
    assert.equal(stale.status, 'rejected');
    assert.match(stale.reason, /execution ownership changed/);
    const exhausted = await workerProbe('claim', tenantId, ids.exhausted, identity);
    assert.equal(exhausted.status, 'rejected');
    assert.match(exhausted.reason, /durable retry budget/);
    const resumed = await workerProbe('claim', tenantId, ids.retrying, identity);
    assert.deepEqual(resumed, { status: 'claimed', effective: 2 });
    assert.equal((await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.retrying } })).attempts, 3);
    assert.deepEqual(await workerProbe('retry-lowered', tenantId, ids.retrying, identity), { status: 'ok' });
    assert.equal((await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.retrying } })).attempts, 3);
    // The next reconciliation must not mistake the old startedAt for successful
    // delivery: an uncertain republish still goes through the normal retry path.
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "nextPublishAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = ${ids.orphan}`;
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "nextPublishAt" = CURRENT_TIMESTAMP + INTERVAL '1 hour'
      WHERE "tenantId" = ${tenantId} AND "id" <> ${ids.orphan}`;
    publisher.publishMessage = async (_tenantId, id, retryCount) => { published.push({ id, retryCount }); };
    await publisher.publishPending();
    const retry = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.orphan } });
    assert.equal(retry.publicationStatus, 'PUBLISHED');
    assert.equal(retry.status, 'PENDING');
    assert.equal(retry.publishAttempts, 2);
    assert.equal(published.filter(row => row.id === ids.orphan).length, 2);
    assert.equal(await prisma.creditTransaction.count({ where: { tenantId } }), 10);
    const debitBefore = await prisma.creditTransaction.findMany({ where: { tenantId }, orderBy: { id: 'asc' } });

    // Hold the job lock using the restricted role, start real worker completion,
    // and independently observe its database lock wait before sweeping. SKIP
    // LOCKED must leave completion's row alone; no owner/private bypass is used.
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "executionLeaseUntil" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = ${ids.freshnull}`;
    let completion;
    let barrierFailure;
    const completionApplicationName = `ll-pdf-${randomUUID()}`;
    try { await new TenantPrismaService(app).withTenant(tenantId, async tx => {
      await tx.$queryRaw`SELECT "id" FROM "AvailabilityImportJob" WHERE "id" = ${ids.freshnull} FOR UPDATE`;
      const [holder] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      completion = workerProbe('complete', tenantId, ids.freshnull, identity, completionApplicationName);
      // Retain rejection handling while the child is intentionally blocked.
      void completion.catch(() => undefined);
      // Activity query text may be truncated before the table name. Match the
      // verified worker identity and exact blocker instead of SQL substrings.
      let waiting = false;
      let completionBackendPid;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await app.$queryRaw`SELECT pid FROM pg_stat_activity
          WHERE usename = current_user AND application_name = ${completionApplicationName}
            AND wait_event_type = 'Lock'
            AND ${holder.pid} = ANY(pg_blocking_pids(pid))`;
        assert.ok(rows.length <= 1, 'The uniquely named completion probe must have at most one blocked backend');
        if (rows.length === 1) { completionBackendPid = rows[0].pid; waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true, 'Real worker completion must reach the owned row-lock barrier');
      assert.ok(Number.isInteger(completionBackendPid) && completionBackendPid > 0);
      await publisher.recoverExpiredExecutions();
      const [stillBlocked] = await app.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE pid = ${completionBackendPid} AND application_name = ${completionApplicationName}
          AND usename = current_user AND wait_event_type = 'Lock'
          AND ${holder.pid} = ANY(pg_blocking_pids(pid))) AS waiting`;
      assert.equal(stillBlocked.waiting, true, 'The exact completion backend must remain blocked by this fixture transaction until release');
      assert.equal((await tx.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.freshnull } })).status, 'RUNNING');
    }, { timeout: 15_000 }); }
    catch (failure) { barrierFailure = failure; }
    let completionResult;
    try { completionResult = await completion; }
    catch (failure) {
      if (barrierFailure) throw new AggregateError([barrierFailure, failure], 'Recovery barrier and worker completion both failed');
      throw failure;
    }
    if (barrierFailure) throw barrierFailure;
    assert.deepEqual(completionResult, { status: 'ok' });
    assert.equal((await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.freshnull } })).status, 'SUCCEEDED');
    assert.deepEqual(await prisma.creditTransaction.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), debitBefore);

    // Expired malformed ownership settles atomically, even with two real worker
    // transactions racing. A genuinely live lease still blocks settlement.
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "executionLeaseUntil" = NULL WHERE "id" = ${ids.expired}`;
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "creditConsumption" = '{"consumedCredits":1,"newBalance":999}'::jsonb WHERE "id" = ${ids.expired}`;
    assert.equal((await workerProbe('retention', tenantId, ids.expired, identity)).status, 'rejected');
    const unsettled = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.expired } });
    assert.equal(unsettled.status, 'RUNNING');
    assert.deepEqual(Buffer.from(unsettled.encryptedSourcePayload), source);
    assert.equal(await prisma.creditTransaction.count({ where: { tenantId, id: `feature-refund-availability-import:${ids.expired}` } }), 0);
    const unrelatedBeforeHardExpiry = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.live } });
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL '24 hours' WHERE "id" = ${ids.expired}`;
    const beforeHardExpiry = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.expired } });
    const hardExpiryFailure = await workerProbe('retention', tenantId, ids.expired, identity);
    assert.equal(hardExpiryFailure.status, 'rejected');
    assert.match(hardExpiryFailure.reason, /debit provenance/);
    const hardErased = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.expired } });
    assert.deepEqual(hardErased, { ...beforeHardExpiry, storageKey: null, encryptedSourcePayload: null });
    assert.deepEqual(await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.live } }), unrelatedBeforeHardExpiry);
    assert.equal(await prisma.creditTransaction.count({ where: { tenantId, id: `feature-refund-availability-import:${ids.expired}` } }), 0);
    // Credit provenance can be repaired after the raw-source deadline: durable
    // job/debit evidence still supports the same exactly-once refund below.
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "creditConsumption" = '{"consumedCredits":1,"newBalance":4}'::jsonb WHERE "id" = ${ids.expired}`;
    assert.deepEqual(await workerProbe('settle-race', tenantId, ids.expired, identity), { status: 'ok' });
    assert.deepEqual(await workerProbe('settle-race', tenantId, ids.exhausted, identity), { status: 'ok' });
    for (const kind of ['expired', 'exhausted']) {
      const settled = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids[kind] } });
      assert.equal(settled.status, 'FAILED');
      assert.equal(settled.encryptedSourcePayload, null);
      assert.equal(await prisma.creditTransaction.count({ where: { tenantId, id: `feature-refund-availability-import:${ids[kind]}` } }), 1);
      assert.equal((await prisma.creditTransaction.findUniqueOrThrow({ where: { id: `feature-refund-availability-import:${ids[kind]}` } })).amount, 1);
    }
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = ${ids.live}`;
    assert.equal((await workerProbe('settle-race', tenantId, ids.live, identity)).status, 'rejected');
    assert.deepEqual(Buffer.from((await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.live } })).encryptedSourcePayload), source);
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "createdAt" = CURRENT_TIMESTAMP - INTERVAL '25 hours',
      "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 hour' WHERE "id" = ${ids.live}`;
    const liveOwnerBeforeHardExpiry = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.live } });
    assert.deepEqual(await workerProbe('hard-only', tenantId, ids.live, identity), { status: 'ok' });
    assert.deepEqual(await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.live } }), {
      ...liveOwnerBeforeHardExpiry, encryptedSourcePayload: null, storageKey: null,
    });
    assert.deepEqual(await prisma.creditTransaction.findMany({ where: { tenantId, id: { in: debitBefore.map(row => row.id) } }, orderBy: { id: 'asc' } }), debitBefore);
  } catch (error) {
    originalFailure = error;
    throw error;
  } finally {
    try {
      // Exact synthetic fixture teardown only; ledger rows do not cascade.
      // Session-local owner bypass is never used by the publisher being proved.
      await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.availabilityImportJob.deleteMany({ where: { tenantId, id: { in: Object.values(ids) } } });
        await tx.creditTransaction.deleteMany({ where: {
          tenantId, id: { in: Object.values(ids).flatMap(id => [`feature-usage-availability-import:${id}`, `feature-refund-availability-import:${id}`]) },
        } });
        await tx.user.deleteMany({ where: { tenantId, id: userId } });
        await tx.tenant.deleteMany({ where: { id: tenantId } });
      });
    } catch (cleanupFailure) {
      if (originalFailure) throw new AggregateError([originalFailure, cleanupFailure], 'Publisher proof and synthetic cleanup both failed');
      throw cleanupFailure;
    } finally {
      await Promise.all([prisma.$disconnect(), app.$disconnect()]);
    }
  }
});

test('Postgres rejects terminal cancellation until encrypted source state is atomically erased', async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: migrationDatabaseUrl() } } });
  const suffix = randomUUID();
  const tenantId = `tenant-availability-${suffix}`;
  const userId = `user-availability-${suffix}`;
  const importId = `import-availability-${suffix}`;
  const completedAt = new Date('2026-07-16T12:00:00.000Z');
  const sourceEnvelope = Buffer.concat([Buffer.from('LLAI\x03', 'binary'), Buffer.alloc(29, 0x5a)]);

  try {
    await prisma.$executeRaw`
      INSERT INTO "Tenant"
        ("id", "name", "slug", "status", "stripeSubscriptionId", "createdAt", "updatedAt")
      VALUES
        (${tenantId}, 'Availability Lifecycle Proof', ${`availability-${suffix}`},
         'ACTIVE'::"TenantStatus", ${`sub-availability-${suffix}`}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    await prisma.$executeRaw`
      INSERT INTO "User"
        ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
      VALUES
        (${userId}, ${tenantId}, 'Availability Staff', ${`staff-${suffix}`},
         'STAFF'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    await prisma.$executeRaw`
      INSERT INTO "AvailabilityImportJob"
        ("id", "tenantId", "userId", "requestKeyHash", "requestHash", "targetIdentityHash",
         "storageKey", "encryptedSourcePayload", "fileSha256", "fileSize", "expiresAt", "createdAt", "updatedAt")
      VALUES
        (${importId}, ${tenantId}, ${userId}, ${'1'.repeat(64)}, ${'2'.repeat(64)}, ${'3'.repeat(64)},
         ${`${suffix}.pdf`}, ${sourceEnvelope}, ${'4'.repeat(64)}, 9,
         CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    await assert.rejects(prisma.$executeRaw`
      UPDATE "AvailabilityImportJob"
      SET "status" = 'CANCELLED',
          "publicationStatus" = 'FAILED',
          "resultErasedAt" = ${completedAt},
          "completedAt" = ${completedAt},
          "updatedAt" = ${completedAt}
      WHERE "id" = ${importId}
    `);

    const preserved = await prisma.$queryRaw`
      SELECT "status"::text AS "status", "storageKey", "encryptedSourcePayload"
      FROM "AvailabilityImportJob"
      WHERE "id" = ${importId}
    `;
    assert.equal(preserved[0].status, 'PENDING');
    assert.equal(preserved[0].storageKey, `${suffix}.pdf`);
    assert.deepEqual(Buffer.from(preserved[0].encryptedSourcePayload), sourceEnvelope);

    await prisma.$executeRaw`
      UPDATE "AvailabilityImportJob"
      SET "storageKey" = NULL,
          "encryptedSourcePayload" = NULL,
          "parsedAvailability" = NULL,
          "resultErasedAt" = ${completedAt},
          "status" = 'CANCELLED',
          "publicationStatus" = 'FAILED',
          "publishToken" = NULL,
          "publishLeaseUntil" = NULL,
          "publicationAmbiguous" = FALSE,
          "publishLastError" = NULL,
          "failureCode" = 'TENANT_DELETED',
          "executionToken" = NULL,
          "executionLeaseUntil" = NULL,
          "completedAt" = ${completedAt},
          "updatedAt" = ${completedAt}
      WHERE "id" = ${importId}
    `;

    const cancelled = await prisma.$queryRaw`
      SELECT "status"::text AS "status", "storageKey", "encryptedSourcePayload",
             "parsedAvailability", "resultErasedAt", "completedAt"
      FROM "AvailabilityImportJob"
      WHERE "id" = ${importId}
    `;
    assert.deepEqual(cancelled, [{
      status: 'CANCELLED',
      storageKey: null,
      encryptedSourcePayload: null,
      parsedAvailability: null,
      resultErasedAt: completedAt,
      completedAt,
    }]);
  } finally {
    await prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`.catch(() => undefined);
    await prisma.$disconnect();
  }
});
