import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';

function migrationDatabaseUrl() {
  const value = process.env.MIGRATION_DATABASE_URL;
  assert.ok(value, 'MIGRATION_DATABASE_URL is required for availability lifecycle integration proof');
  return value;
}

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
