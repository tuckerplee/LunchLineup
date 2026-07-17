import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';

function required(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for tenant data-governance integration proof`);
  return value;
}

function databaseError(error) {
  return `${error?.meta?.code ?? ''} ${error?.message ?? error}`;
}

async function rejects42501(operation) {
  await assert.rejects(operation, (error) => {
    assert.match(databaseError(error), /42501|insufficient_privilege/i);
    return true;
  });
}

test('retention owners fail closed without proof and audit legal holds survive valid proof', { timeout: 20_000 }, async () => {
  const capability = required('PLATFORM_ADMIN_DB_CONTEXT_SECRET');
  const prisma = new PrismaClient({
    datasources: { db: { url: required('MIGRATION_DATABASE_URL') } },
  });
  const restricted = new PrismaClient({
    datasources: { db: { url: required('DATABASE_URL') } },
  });
  const suffix = randomUUID();
  const tenantId = `tenant-governance-${suffix}`;
  const userId = `user-governance-${suffix}`;
  const auditId = `audit-governance-${suffix}`;
  const userAuditId = `audit-user-governance-${suffix}`;
  const asPlatformAdmin = (operation) => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
    return operation(tx);
  });

  try {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "Tenant"
          ("id", "name", "slug", "status", "usageCredits", "deletedAt", "createdAt", "updatedAt")
        VALUES
          (${tenantId}, 'Governance Proof', ${`governance-${suffix}`},
           'PURGED'::"TenantStatus", 0, CURRENT_TIMESTAMP - INTERVAL '8 years',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        INSERT INTO "User"
          ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
        VALUES
          (${userId}, ${tenantId}, 'Governance User', ${`governance-user-${suffix}`},
           'STAFF'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        INSERT INTO "AuditLog"
          ("id", "tenantId", "action", "resource", "resourceId", "oldValue", "newValue",
           "ipAddress", "userAgent", "createdAt")
        VALUES
          (${auditId}, ${tenantId}, 'GOVERNANCE_PROOF', 'Tenant', ${tenantId},
           '{"before":"preserved"}'::jsonb, '{"after":"preserved"}'::jsonb,
           '203.0.113.40', 'node-test', CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        INSERT INTO "AuditLog"
          ("id", "tenantId", "userId", "actorUserId", "action", "resource", "resourceId",
           "oldValue", "newValue", "createdAt")
        VALUES
          (${userAuditId}, ${tenantId}, ${userId}, ${userId}, 'USER_GOVERNANCE_PROOF', 'User', ${userId},
           '{"user":"preserved"}'::jsonb, '{"user":"preserved"}'::jsonb, CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        UPDATE "Tenant"
        SET "retentionLegalHoldAt" = CURRENT_TIMESTAMP,
            "retentionLegalHoldReason" = 'Preserve records for integration litigation proof',
            "retentionLegalHoldByUserId" = 'integration-platform-admin',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${tenantId}
      `;
    });

    const noProofCalls = [
      () => prisma.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`,
      () => prisma.$queryRaw`SELECT public.redact_retained_tenant_audit_logs(${tenantId})`,
      () => prisma.$queryRaw`SELECT public.redact_deleted_user_audit_records(${tenantId}, ${userId})`,
      () => prisma.$queryRaw`SELECT public.purge_expired_onboarding_signup_attempts(LOCALTIMESTAMP)`,
      () => prisma.$queryRaw`SELECT public.purge_expired_password_reset_tokens(LOCALTIMESTAMP, 1)`,
      () => prisma.$queryRaw`SELECT public.purge_dormant_sessions(LOCALTIMESTAMP, 1)`,
      () => prisma.$queryRaw`SELECT public.purge_staff_invitation_outbox_diagnostics(LOCALTIMESTAMP, 1)`,
      () => prisma.$queryRaw`SELECT public.purge_payroll_operational_time_cards(${tenantId})`,
      () => prisma.$queryRaw`SELECT public.purge_expired_payroll_records(${tenantId})`,
    ];
    for (const operation of noProofCalls) await rejects42501(operation());
    await rejects42501(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_catalog.set_config('app.platform_admin_proof', 'invalid', TRUE)`;
      await tx.$queryRaw`SELECT public.purge_dormant_sessions(LOCALTIMESTAMP, 1)`;
    }));

    for (const operation of [
      (tx) => tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`,
      (tx) => tx.$queryRaw`SELECT public.redact_retained_tenant_audit_logs(${tenantId})`,
      (tx) => tx.$queryRaw`SELECT public.redact_deleted_user_audit_records(${tenantId}, ${`missing-${suffix}`})`,
    ]) {
      await rejects42501(asPlatformAdmin(operation));
    }
    await rejects42501(restricted.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_tenant(${tenantId})`;
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: new Date() },
      });
    }));
    assert.equal((await prisma.user.findUnique({ where: { id: userId }, select: { deletedAt: true } })).deletedAt, null);
    assert.deepEqual(await prisma.auditLog.findUnique({
      where: { id: auditId },
      select: { oldValue: true, newValue: true, ipAddress: true, userAgent: true },
    }), {
      oldValue: { before: 'preserved' },
      newValue: { after: 'preserved' },
      ipAddress: '203.0.113.40',
      userAgent: 'node-test',
    });

    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`
        UPDATE "Tenant"
        SET "retentionLegalHoldAt" = NULL,
            "retentionLegalHoldReason" = NULL,
            "retentionLegalHoldByUserId" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${tenantId}
      `;
      const redacted = await tx.$queryRaw`
        SELECT public.redact_retained_tenant_audit_logs(${tenantId}) AS "count"
      `;
      assert.equal(Number(redacted[0].count), 2);
    });
    assert.deepEqual(await prisma.auditLog.findUnique({
      where: { id: auditId },
      select: { oldValue: true, newValue: true, ipAddress: true, userAgent: true },
    }), { oldValue: null, newValue: null, ipAddress: null, userAgent: null });
    await restricted.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_tenant(${tenantId})`;
      await tx.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
    });
    assert.ok((await prisma.user.findUnique({ where: { id: userId }, select: { deletedAt: true } })).deletedAt);

    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`
        UPDATE "Tenant"
        SET "applicationDataPurgedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${tenantId}
      `;
      const purged = await tx.$queryRaw`
        SELECT public.purge_expired_audit_logs(${tenantId}) AS "count"
      `;
      assert.equal(Number(purged[0].count), 2);
    });
    assert.equal(await prisma.auditLog.count({ where: { tenantId } }), 0);
  } finally {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`
        UPDATE "Tenant"
        SET "retentionLegalHoldAt" = NULL,
            "retentionLegalHoldReason" = NULL,
            "retentionLegalHoldByUserId" = NULL,
            "status" = 'PURGED'::"TenantStatus",
            "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
            "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${tenantId}
      `;
      await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
    }).catch(() => undefined);
    await prisma.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${tenantId}`.catch(() => undefined);
    await prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`.catch(() => undefined);
    await restricted.$disconnect();
    await prisma.$disconnect();
  }
});

test('a winning legal hold fences a concurrent restricted-role user deletion before auth or audit redaction', { timeout: 20_000 }, async () => {
  const capability = required('PLATFORM_ADMIN_DB_CONTEXT_SECRET');
  const owner = new PrismaClient({
    datasources: { db: { url: required('MIGRATION_DATABASE_URL') } },
  });
  const restricted = new PrismaClient({
    datasources: { db: { url: required('DATABASE_URL') } },
  });
  const suffix = randomUUID();
  const tenantId = `tenant-hold-delete-${suffix}`;
  const userId = `user-hold-delete-${suffix}`;
  const auditId = `audit-hold-delete-${suffix}`;
  let releaseHold;
  const holdRelease = new Promise((resolve) => { releaseHold = resolve; });
  let signalHold;
  const holdLocked = new Promise((resolve) => { signalHold = resolve; });
  const asPlatformAdmin = (operation) => owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
    return operation(tx);
  });

  try {
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "Tenant"
          ("id", "name", "slug", "status", "usageCredits", "createdAt", "updatedAt")
        VALUES
          (${tenantId}, 'Hold Delete Proof', ${`hold-delete-${suffix}`},
           'ACTIVE'::"TenantStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        INSERT INTO "User"
          ("id", "tenantId", "name", "email", "username", "passwordHash", "role",
           "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
        VALUES
          (${userId}, ${tenantId}, 'Preserved User', ${`preserved-${suffix}@example.test`},
           ${`preserved-${suffix}`}, 'preserved-password-proof', 'STAFF'::"UserRole",
           FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        INSERT INTO "AuditLog"
          ("id", "tenantId", "userId", "actorUserId", "action", "resource", "resourceId",
           "oldValue", "newValue", "ipAddress", "userAgent", "createdAt")
        VALUES
          (${auditId}, ${tenantId}, ${userId}, ${userId}, 'HOLD_DELETE_PROOF', 'User', ${userId},
           '{"identity":"preserved"}'::jsonb, '{"auth":"preserved"}'::jsonb,
           '203.0.113.90', 'restricted-role-proof', CURRENT_TIMESTAMP)
      `;
    });

    const holdPlacement = asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${tenantId})`;
      await tx.$executeRaw`
        UPDATE "Tenant"
        SET "retentionLegalHoldAt" = CURRENT_TIMESTAMP,
            "retentionLegalHoldReason" = 'Winning concurrent litigation preservation hold',
            "retentionLegalHoldByUserId" = 'integration-platform-admin',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${tenantId}
      `;
      signalHold();
      await holdRelease;
    });
    await holdLocked;

    let deletionSettled = false;
    const deletion = restricted.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_tenant(${tenantId})`;
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt: new Date() },
      });
    }).finally(() => { deletionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(deletionSettled, false);
    releaseHold();
    await holdPlacement;
    await rejects42501(deletion);

    assert.deepEqual(await owner.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        email: true,
        username: true,
        passwordHash: true,
        deletedAt: true,
      },
    }), {
      name: 'Preserved User',
      email: `preserved-${suffix}@example.test`,
      username: `preserved-${suffix}`,
      passwordHash: 'preserved-password-proof',
      deletedAt: null,
    });
    assert.deepEqual(await owner.auditLog.findUnique({
      where: { id: auditId },
      select: {
        userId: true,
        actorUserId: true,
        oldValue: true,
        newValue: true,
        ipAddress: true,
        userAgent: true,
      },
    }), {
      userId,
      actorUserId: userId,
      oldValue: { identity: 'preserved' },
      newValue: { auth: 'preserved' },
      ipAddress: '203.0.113.90',
      userAgent: 'restricted-role-proof',
    });
  } finally {
    releaseHold?.();
    await asPlatformAdmin(async (tx) => {
      await tx.$executeRaw`
        UPDATE "Tenant"
        SET "retentionLegalHoldAt" = NULL,
            "retentionLegalHoldReason" = NULL,
            "retentionLegalHoldByUserId" = NULL,
            "status" = 'PURGED'::"TenantStatus",
            "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
            "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${tenantId}
      `;
      await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
    }).catch(() => undefined);
    await owner.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${tenantId}`.catch(() => undefined);
    await owner.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`.catch(() => undefined);
    await restricted.$disconnect();
    await owner.$disconnect();
  }
});
