import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';

function requiredUrl(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for tenant-governance migration replay proof`);
  return new URL(value);
}

function databaseUrl(base, databaseName) {
  const value = new URL(base);
  value.pathname = `/${databaseName}`;
  return value.toString();
}

function runFullMigration(env) {
  const result = spawnSync(process.execPath, ['scripts/apply-db-migrations.mjs'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `full migration replay failed\n${result.stdout}\n${result.stderr}`,
  );
}

test('full migration runner replays on a fresh database without changing a PENDING cleanup row', { timeout: 180_000 }, async () => {
  const ownerBase = requiredUrl('MIGRATION_DATABASE_URL');
  const appBase = requiredUrl('DATABASE_URL');
  const appRole = decodeURIComponent(appBase.username);
  const dropDisposableAppRole = process.env.TENANT_GOVERNANCE_REPLAY_DROP_APP_ROLE === 'true';
  if (dropDisposableAppRole) {
    assert.match(appRole, /^lunchlineup_governance_app_[a-f0-9]+$/);
  }
  const databaseName = `lunchlineup_governance_${randomUUID().replaceAll('-', '')}`;
  const maintenanceUrl = databaseUrl(ownerBase, 'postgres');
  const ownerUrl = databaseUrl(ownerBase, databaseName);
  const appUrl = databaseUrl(appBase, databaseName);
  const maintenance = new PrismaClient({ datasources: { db: { url: maintenanceUrl } } });
  let database;

  const migrationEnvironment = {
    ...process.env,
    DATABASE_URL: appUrl,
    MIGRATION_DATABASE_URL: ownerUrl,
    APP_DB_USER: appRole,
    APP_DB_PASSWORD: decodeURIComponent(appBase.password),
    POSTGRES_USER: decodeURIComponent(ownerBase.username),
    POSTGRES_PASSWORD: decodeURIComponent(ownerBase.password),
    PLATFORM_ADMIN_DB_CONTEXT_SECRET:
      process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET
      ?? 'tenant-governance-replay-capability-20260716',
    WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT:
      process.env.WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT
      ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    DATA_TARGET_ENV: 'test',
    NODE_ENV: 'test',
  };
  const suffix = randomUUID();
  const tenantId = `tenant-migration-replay-${suffix}`;
  const jobId = `export-migration-replay-${suffix}`;
  const deliveredId = `webhook-delivered-${suffix}`;
  const deadLetteredId = `webhook-dead-lettered-${suffix}`;
  const queuedId = `webhook-queued-${suffix}`;

  try {
    await maintenance.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    runFullMigration(migrationEnvironment);
    database = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    await database.$executeRaw`
      INSERT INTO "Tenant"
        ("id", "name", "slug", "status", "usageCredits", "createdAt", "updatedAt")
      VALUES
        (${tenantId}, 'Governance Migration Replay', ${`governance-migration-${suffix}`},
         'ACTIVE'::"TenantStatus", 0,
         '2026-07-16T12:00:00.000Z'::timestamptz,
         '2026-07-16T12:00:00.000Z'::timestamptz)
    `;
    await database.$executeRaw`
      INSERT INTO "TenantExportJob"
        ("id", "tenantId", "requestedByUserId", "tenantSlug", "state", "watermark",
         "expiresAt", "artifactKey", "bytes", "rowCounts", "progressCollection",
         "progressRows", "claimToken", "claimExpiresAt", "attempts", "error",
         "completedAt", "artifactCleanupState", "artifactCleanupOwner",
         "artifactCleanupLeaseExpiresAt", "artifactCleanupAttempts", "createdAt", "updatedAt")
      VALUES
        (${jobId}, ${tenantId}, 'migration-replay-user', ${`governance-migration-${suffix}`},
         'FAILED', '2026-07-16T12:01:00.000Z'::timestamptz,
         '2026-07-16T13:01:00.000Z'::timestamptz, ${`${jobId}.ndjson`}, 4096,
         '{"tenant":1}'::jsonb, 'users', 7, ${`claim-${suffix}`},
         '2026-07-16T12:06:00.000Z'::timestamptz, 3, 'retained failure evidence',
         '2026-07-16T12:02:00.000Z'::timestamptz, 'PENDING', ${`cleanup-${suffix}`},
         '2026-07-16T12:07:00.000Z'::timestamptz, 2,
         '2026-07-16T12:00:00.000Z'::timestamptz,
         '2026-07-16T12:03:00.000Z'::timestamptz)
    `;
    const before = await database.$queryRaw`
      SELECT to_jsonb(job) AS "snapshot"
      FROM "TenantExportJob" job
      WHERE "id" = ${jobId}
    `;

    for (const [id, terminalStatus] of [
      [deliveredId, 'DELIVERED'],
      [deadLetteredId, 'DEAD_LETTERED'],
    ]) {
      await database.$executeRaw`
        INSERT INTO "WebhookDelivery"
          ("id", "tenantId", "status", "endpointRef", "payloadDigest", "payloadBytes",
           "encryptedUrl", "encryptedPayload", "encryptionKeyRef", "attempts",
           "lastError", "createdAt", "updatedAt")
        VALUES
          (${id}, ${tenantId}, 'SENDING'::"WebhookDeliveryStatus", 'synthetic-endpoint',
           'synthetic-digest', 1, 'synthetic-encrypted-url', 'synthetic-encrypted-payload',
           'synthetic-key', 1, 'synthetic-terminal-error', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await database.$executeRaw`
        UPDATE "WebhookDelivery"
        SET "status" = ${terminalStatus}::"WebhookDeliveryStatus"
        WHERE "id" = ${id} AND "tenantId" = ${tenantId}
      `;
      const rows = await database.$queryRaw`
        SELECT "status"::text AS "status", "encryptedUrl", "encryptedPayload",
               "encryptionKeyRef", "lastError", "endpointRef", "payloadDigest"
        FROM "WebhookDelivery"
        WHERE "id" = ${id} AND "tenantId" = ${tenantId}
      `;
      assert.deepEqual(rows, [{
        status: terminalStatus,
        encryptedUrl: '',
        encryptedPayload: '',
        encryptionKeyRef: 'erased-v1',
        lastError: null,
        endpointRef: 'synthetic-endpoint',
        payloadDigest: 'synthetic-digest',
      }]);
    }

    await database.$executeRaw`
      INSERT INTO "WebhookDelivery"
        ("id", "tenantId", "status", "endpointRef", "payloadDigest", "payloadBytes",
         "encryptedUrl", "encryptedPayload", "encryptionKeyRef", "attempts", "createdAt", "updatedAt")
      VALUES
        (${queuedId}, ${tenantId}, 'QUEUED'::"WebhookDeliveryStatus", 'synthetic-endpoint',
         'synthetic-digest', 1, 'synthetic-encrypted-url', 'synthetic-encrypted-payload',
         'synthetic-key', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    const queuedRows = await database.$queryRaw`
      SELECT "status"::text AS "status", "encryptedUrl", "encryptedPayload", "encryptionKeyRef"
      FROM "WebhookDelivery" WHERE "id" = ${queuedId} AND "tenantId" = ${tenantId}
    `;
    assert.deepEqual(queuedRows, [{
      status: 'QUEUED', encryptedUrl: 'synthetic-encrypted-url',
      encryptedPayload: 'synthetic-encrypted-payload', encryptionKeyRef: 'synthetic-key',
    }]);

    const invalidInputs = [
      { field: 'encryptedUrl', value: '', status: 'QUEUED', code: '23514' },
      { field: 'encryptedPayload', value: '', status: 'QUEUED', code: '23514' },
      { field: 'encryptedUrl', value: null, status: 'QUEUED', code: '23502' },
      { field: 'encryptedPayload', value: null, status: 'QUEUED', code: '23502' },
      ...['endpointRef', 'payloadDigest', 'encryptionKeyRef'].map((field) => (
        { field, value: '', status: 'QUEUED', code: '23514' }
      )),
      ...['DELIVERED', 'DEAD_LETTERED'].flatMap((status) => (
        ['endpointRef', 'payloadDigest'].map((field) => ({ field, value: '', status, code: '23514' }))
      )),
    ];
    for (const [index, invalid] of invalidInputs.entries()) {
      const id = `webhook-invalid-${index}-${suffix}`;
      const values = {
        endpointRef: 'synthetic-endpoint', payloadDigest: 'synthetic-digest',
        encryptedUrl: 'synthetic-encrypted-url', encryptedPayload: 'synthetic-encrypted-payload',
        encryptionKeyRef: 'synthetic-key', [invalid.field]: invalid.value,
      };
      await assert.rejects(database.$executeRaw`
        INSERT INTO "WebhookDelivery"
          ("id", "tenantId", "status", "endpointRef", "payloadDigest", "payloadBytes",
           "encryptedUrl", "encryptedPayload", "encryptionKeyRef", "attempts", "createdAt", "updatedAt")
        VALUES
          (${id}, ${tenantId}, ${invalid.status}::"WebhookDeliveryStatus", ${values.endpointRef},
           ${values.payloadDigest}, 1, ${values.encryptedUrl}, ${values.encryptedPayload},
           ${values.encryptionKeyRef}, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, (error) => error?.code === 'P2010' && error.meta?.code === invalid.code,
      `${invalid.status} must reject ${invalid.field}=${JSON.stringify(invalid.value)}`);
      const rows = await database.$queryRaw`
        SELECT "id" FROM "WebhookDelivery" WHERE "id" = ${id} AND "tenantId" = ${tenantId}
      `;
      assert.deepEqual(rows, [], 'rejected webhook insert must leave no fixture row');
    }

    // Synthetic nonterminal strings prove database presence requirements only;
    // remove this exact row before the real migration encryption-key preflight.
    await database.$executeRaw`
      DELETE FROM "WebhookDelivery" WHERE "id" = ${queuedId} AND "tenantId" = ${tenantId}
    `;
    const queuedAfterDelete = await database.$queryRaw`
      SELECT "id" FROM "WebhookDelivery" WHERE "id" = ${queuedId} AND "tenantId" = ${tenantId}
    `;
    assert.deepEqual(queuedAfterDelete, [], 'synthetic queued row must be absent before encryption preflight');
    const webhookBeforeReplay = await database.$queryRaw`
      SELECT to_jsonb(delivery) AS "snapshot" FROM "WebhookDelivery" delivery
      WHERE "tenantId" = ${tenantId} AND "id" IN (${deliveredId}, ${deadLetteredId})
      ORDER BY "id"
    `;
    assert.equal(webhookBeforeReplay.length, 2);

    runFullMigration(migrationEnvironment);

    const webhookAfterReplay = await database.$queryRaw`
      SELECT to_jsonb(delivery) AS "snapshot" FROM "WebhookDelivery" delivery
      WHERE "tenantId" = ${tenantId} AND "id" IN (${deliveredId}, ${deadLetteredId})
      ORDER BY "id"
    `;
    assert.deepEqual(webhookAfterReplay, webhookBeforeReplay);

    const after = await database.$queryRaw`
      SELECT to_jsonb(job) AS "snapshot"
      FROM "TenantExportJob" job
      WHERE "id" = ${jobId}
    `;
    assert.deepEqual(after, before);
    const indexes = await database.$queryRaw`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'TenantExportJob_artifact_cleanup_idx'
    `;
    assert.equal(indexes.length, 1);
    assert.match(
      indexes[0].indexdef,
      /\("artifactCleanupState", "artifactCleanupLeaseExpiresAt", "updatedAt"\)/,
    );
  } finally {
    await database?.$disconnect();
    await maintenance.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    if (dropDisposableAppRole) {
      await maintenance.$executeRawUnsafe(`DROP ROLE IF EXISTS "${appRole}"`);
    }
    await maintenance.$disconnect();
  }
});
