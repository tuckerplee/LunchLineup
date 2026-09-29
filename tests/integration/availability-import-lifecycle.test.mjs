import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';

process.env.TS_NODE_PROJECT = fileURLToPath(new URL('../../apps/api/tsconfig.json', import.meta.url));
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { AvailabilityImportPublisher } = require('../../apps/api/src/availability-imports/availability-imports.publisher.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');

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
  const ids = Object.fromEntries(['orphan', 'live', 'expired', 'cancelled'].map(kind => [kind, `${kind}-${suffix}`]));
  const published = [];
  const publisher = new AvailabilityImportPublisher(new TenantPrismaService(app));
  publisher.publishMessage = async (_tenantId, id) => {
    published.push(id);
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
          UPDATE "AvailabilityImportJob" SET "status" = 'RUNNING', "publicationStatus" = 'PUBLISHED', "attempts" = 1,
            "startedAt" = CURRENT_TIMESTAMP, "executionToken" = 'crashed-worker',
            "executionLeaseUntil" = CASE WHEN ${kind} = 'live' THEN CURRENT_TIMESTAMP + INTERVAL '1 hour' ELSE CURRENT_TIMESTAMP - INTERVAL '1 second' END,
            "expiresAt" = CASE WHEN ${kind} = 'expired' THEN CURRENT_TIMESTAMP - INTERVAL '1 second' ELSE "expiresAt" END
          WHERE "id" = ${id}
        `;
      }
    }
    const before = await prisma.availabilityImportJob.findMany({ where: { tenantId }, orderBy: { id: 'asc' } });
    await publisher.publishPending();
    assert.deepEqual(published.filter(id => Object.values(ids).includes(id)), [ids.orphan]);
    const recovered = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.orphan } });
    assert.equal(recovered.status, 'PENDING');
    assert.equal(recovered.publicationStatus, 'FAILED');
    assert.equal(recovered.executionToken, null);
    assert.equal(recovered.executionLeaseUntil, null);
    assert.deepEqual(Buffer.from(recovered.encryptedSourcePayload), source);
    assert.deepEqual(recovered.creditConsumption, { consumedCredits: 1, newBalance: 4 });
    for (const kind of ['live', 'expired', 'cancelled']) {
      assert.deepEqual(await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids[kind] } }), before.find(row => row.id === ids[kind]));
    }
    // The next reconciliation must not mistake the old startedAt for successful
    // delivery: an uncertain republish still goes through the normal retry path.
    await prisma.$executeRaw`UPDATE "AvailabilityImportJob" SET "nextPublishAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = ${ids.orphan}`;
    publisher.publishMessage = async (_tenantId, id) => { published.push(id); };
    await publisher.publishPending();
    const retry = await prisma.availabilityImportJob.findUniqueOrThrow({ where: { id: ids.orphan } });
    assert.equal(retry.publicationStatus, 'PUBLISHED');
    assert.equal(retry.status, 'PENDING');
    assert.equal(retry.publishAttempts, 2);
    assert.equal(published.filter(id => id === ids.orphan).length, 2);
    assert.equal(await prisma.creditTransaction.count({ where: { tenantId } }), 4);
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
          tenantId, id: { in: Object.values(ids).map(id => `feature-usage-availability-import:${id}`) },
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
