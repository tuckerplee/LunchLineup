import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';

const payrollTables = [
  'PayrollPolicyVersion',
  'PayrollPeriod',
  'PayrollTimeCardApproval',
  'PayrollLockedEntry',
  'PayrollAmendment',
  'PayrollAmendmentDecision',
  'PayrollOperation',
  'PayrollExportBatch',
  'PayrollExportLine',
  'PayrollReconciliationReceipt',
  'PayrollReconciliationLineEvent',
  'PayrollReconciliationLineState',
];

const hash = (character) => character.repeat(64);

function serviceUrl(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required for payroll integration proof`);
  return value;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function databaseError(error) {
  return [error?.message, error?.code, error?.meta?.message].filter(Boolean).join('\n');
}

async function rejectsDatabase(operation, expected) {
  await assert.rejects(operation, (error) => {
    assert.match(databaseError(error), expected);
    return true;
  });
}

async function asTenant(prisma, tenantId, operation) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT set_current_tenant($1)', tenantId);
    return operation(tx);
  });
}

async function asPlatformAdmin(prisma, operation) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`
      SELECT pg_catalog.set_config(
        'app.platform_admin_proof',
        (SELECT secret_hash
         FROM lunchlineup_private.platform_admin_capability
         WHERE singleton = TRUE),
        TRUE
      )
    `);
    return operation(tx);
  });
}

async function phase(name, operation) {
  try {
    return await operation();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

function fixture() {
  const suffix = randomUUID();
  return {
    primaryTenantId: `tenant-payroll-primary-${suffix}`,
    isolatedTenantId: `tenant-payroll-isolated-${suffix}`,
    primarySlug: `payroll-primary-${suffix}`,
    isolatedSlug: `payroll-isolated-${suffix}`,
    staffId: `staff-payroll-${suffix}`,
    managerId: `manager-payroll-${suffix}`,
    reviewerId: `reviewer-payroll-${suffix}`,
    locationId: `location-payroll-${suffix}`,
    firstPolicyId: `policy-1-${suffix}`,
    secondPolicyId: `policy-2-${suffix}`,
    isolatedPolicyId: `policy-isolated-${suffix}`,
    sourcePeriodId: `period-source-${suffix}`,
    adjustmentPeriodId: `period-adjustment-${suffix}`,
    cardId: `card-payroll-${suffix}`,
    deletedUnsnapshottedCardId: `card-deleted-unsnapshotted-${suffix}`,
    breakId: `break-payroll-${suffix}`,
    approvalRevision2Id: `approval-rev-2-${suffix}`,
    approvalRevision3Id: `approval-rev-3-${suffix}`,
    sourceEntryId: `entry-source-${suffix}`,
    amendmentId: `amendment-${suffix}`,
    amendmentDecisionId: `amendment-decision-${suffix}`,
    amendmentEntryId: `entry-amendment-${suffix}`,
    batchId: `batch-payroll-${suffix}`,
    exportOperationId: `export-op-${suffix}`,
    exportCreditTransactionId: `feature-usage-payroll-export:export-op-${suffix}`,
    lineId: `line-payroll-${suffix}`,
    firstReceiptId: `receipt-1-${suffix}`,
    secondReceiptId: `receipt-2-${suffix}`,
    firstEventId: `event-1-${suffix}`,
    secondEventId: `event-2-${suffix}`,
    lineStateId: `line-state-${suffix}`,
    suffix,
  };
}

async function forceCleanup(owner, values) {
  const tenantIds = [values.primaryTenantId, values.isolatedTenantId];
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    for (const table of [
      'PayrollReconciliationLineState',
      'PayrollReconciliationLineEvent',
      'PayrollReconciliationReceipt',
      'PayrollExportLine',
      'PayrollExportBatch',
      'PayrollAmendmentDecision',
      'PayrollAmendment',
      'PayrollLockedEntry',
      'PayrollOperation',
      'PayrollTimeCardApproval',
      'TimeCardBreak',
      'TimeCard',
      'PayrollPeriod',
      'PayrollPolicyVersion',
      'CreditTransaction',
    ]) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenantIds);
    }
    await tx.$executeRawUnsafe('DELETE FROM "Location" WHERE "tenantId" = ANY($1::text[])', tenantIds);
    await tx.$executeRawUnsafe('DELETE FROM "User" WHERE "tenantId" = ANY($1::text[])', tenantIds);
    await tx.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = ANY($1::text[])', tenantIds);
  });
}

test('payroll controls enforce tenant, workflow, evidence, reconciliation, and retention boundaries', { timeout: 60_000 }, async () => {
  const owner = client(serviceUrl('MIGRATION_DATABASE_URL'));
  const app = client(serviceUrl('DATABASE_URL'));
  const values = fixture();
  const contractFailures = [];

  try {
    await owner.$executeRawUnsafe(`
      INSERT INTO "Tenant" ("id", "name", "slug", "status", "usageCredits", "createdAt", "updatedAt")
      VALUES
        ($1, 'Payroll Primary', $2, 'ACTIVE'::"TenantStatus", 9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, 'Payroll Isolated', $4, 'ACTIVE'::"TenantStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, values.primaryTenantId, values.primarySlug, values.isolatedTenantId, values.isolatedSlug);
    await owner.$executeRawUnsafe(`
      INSERT INTO "User"
        ("id", "tenantId", "name", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
      VALUES
        ($1, $4, 'Payroll Staff', 'STAFF'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($2, $4, 'Payroll Manager', 'MANAGER'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'Payroll Reviewer', 'MANAGER'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, values.staffId, values.managerId, values.reviewerId, values.primaryTenantId);
    await owner.$executeRawUnsafe(`
      INSERT INTO "Location" ("id", "tenantId", "name", "timezone", "createdAt", "updatedAt")
      VALUES ($1, $2, 'Payroll Location', 'America/Los_Angeles', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, values.locationId, values.primaryTenantId);

    await phase('the exact 12-model catalog, forced RLS, composite tenant keys, and ADOPT enum are live', async () => {
      const enumRows = await owner.$queryRawUnsafe(`
        SELECT enum_value.enumlabel
        FROM pg_type type
        JOIN pg_enum enum_value ON enum_value.enumtypid = type.oid
        WHERE type.typname = 'PayrollOperationKind'
        ORDER BY enum_value.enumsortorder
      `);
      assert.deepEqual(enumRows.map((row) => row.enumlabel), [
        'POLICY_CREATE', 'PERIOD_CREATE', 'ADOPT', 'REVIEW', 'APPROVAL', 'LOCK',
        'AMENDMENT_CREATE', 'AMENDMENT_DECISION', 'EXPORT', 'RECONCILE',
      ]);

      const rlsRows = await owner.$queryRawUnsafe(`
        SELECT class.relname
        FROM pg_class class
        WHERE class.relname IN (
          'PayrollPolicyVersion', 'PayrollPeriod', 'PayrollTimeCardApproval', 'PayrollLockedEntry',
          'PayrollAmendment', 'PayrollAmendmentDecision', 'PayrollOperation', 'PayrollExportBatch',
          'PayrollExportLine', 'PayrollReconciliationReceipt', 'PayrollReconciliationLineEvent',
          'PayrollReconciliationLineState'
        ) AND class.relrowsecurity AND class.relforcerowsecurity
        ORDER BY class.relname
      `);
      assert.deepEqual(rlsRows.map((row) => row.relname), [...payrollTables].sort());

      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "PayrollPolicyVersion"
          ("id", "tenantId", "version", "timeZone", "cadence", "anchorDate", "effectiveFrom",
           "operationId", "requestHash", "createdByUserId", "createdAt")
        VALUES ($1, $2, 2, 'UTC', 'WEEKLY'::"PayrollCadence", DATE '2026-05-25', DATE '2026-05-25',
                $3, $4, 'isolated-actor', CURRENT_TIMESTAMP)
      `, `invalid-first-${values.suffix}`, values.isolatedTenantId, `invalid-first-op-${values.suffix}`, hash('0')), /first payroll policy version must be version 1/i);

      await owner.$executeRawUnsafe(`
        INSERT INTO "PayrollPolicyVersion"
          ("id", "tenantId", "version", "timeZone", "cadence", "anchorDate", "effectiveFrom",
           "operationId", "requestHash", "createdByUserId", "createdAt")
        VALUES ($1, $2, 1, 'UTC', 'WEEKLY'::"PayrollCadence", DATE '2026-05-25', DATE '2026-05-25',
                $3, $4, 'isolated-actor', CURRENT_TIMESTAMP)
      `, values.isolatedPolicyId, values.isolatedTenantId, `isolated-policy-op-${values.suffix}`, hash('1'));
    });

    await phase('historical version 1 is accepted and successors stay sequential, timezone-stable, and aligned', async () => {
      await owner.$executeRawUnsafe(`
        INSERT INTO "PayrollPolicyVersion"
          ("id", "tenantId", "version", "timeZone", "cadence", "anchorDate", "effectiveFrom",
           "operationId", "requestHash", "createdByUserId", "createdAt")
        VALUES ($1, $2, 1, 'America/Los_Angeles', 'WEEKLY'::"PayrollCadence", DATE '2026-06-01', DATE '2026-06-01',
                $3, $4, $5, CURRENT_TIMESTAMP)
      `, values.firstPolicyId, values.primaryTenantId, `policy-1-op-${values.suffix}`, hash('2'), values.managerId);
      await owner.$executeRawUnsafe(`
        INSERT INTO "PayrollPolicyVersion"
          ("id", "tenantId", "version", "timeZone", "cadence", "anchorDate", "effectiveFrom",
           "operationId", "requestHash", "createdByUserId", "createdAt")
        VALUES ($1, $2, 2, 'America/Los_Angeles', 'WEEKLY'::"PayrollCadence", DATE '2026-06-01', DATE '2026-06-08',
                $3, $4, $5, CURRENT_TIMESTAMP)
      `, values.secondPolicyId, values.primaryTenantId, `policy-2-op-${values.suffix}`, hash('3'), values.managerId);

      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "PayrollPolicyVersion"
          ("id", "tenantId", "version", "timeZone", "cadence", "anchorDate", "effectiveFrom",
           "operationId", "requestHash", "createdByUserId", "createdAt")
        VALUES ($1, $2, 4, 'America/Los_Angeles', 'WEEKLY'::"PayrollCadence", DATE '2026-06-01', DATE '2026-06-15',
                $3, $4, $5, CURRENT_TIMESTAMP)
      `, `policy-skipped-${values.suffix}`, values.primaryTenantId, `policy-skipped-op-${values.suffix}`, hash('4'), values.managerId), /payroll policy versions must be sequential/i);
      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "PayrollPolicyVersion"
          ("id", "tenantId", "version", "timeZone", "cadence", "anchorDate", "effectiveFrom",
           "operationId", "requestHash", "createdByUserId", "createdAt")
        VALUES ($1, $2, 3, 'UTC', 'WEEKLY'::"PayrollCadence", DATE '2026-06-01', DATE '2026-06-15',
                $3, $4, $5, CURRENT_TIMESTAMP)
      `, `policy-timezone-${values.suffix}`, values.primaryTenantId, `policy-timezone-op-${values.suffix}`, hash('5'), values.managerId), /payroll policy versions must be sequential/i);

      const primaryRows = await asTenant(app, values.primaryTenantId, (tx) => tx.$queryRawUnsafe(
        'SELECT "id" FROM "PayrollPolicyVersion" ORDER BY "version"',
      ));
      assert.deepEqual(primaryRows.map((row) => row.id), [values.firstPolicyId, values.secondPolicyId]);
    });

    await phase('periods reject cross-tenant policies and overlap, then move only OPEN to REVIEW to LOCKED', async () => {
      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "PayrollPeriod"
          ("id", "tenantId", "policyVersionId", "localStartDate", "localEndDateExclusive", "startsAt", "endsAt",
           "timeZone", "cadence", "status", "revision", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, DATE '2026-06-01', DATE '2026-06-08', TIMESTAMPTZ '2026-06-01 07:00:00+00',
                TIMESTAMPTZ '2026-06-08 07:00:00+00', 'America/Los_Angeles', 'WEEKLY'::"PayrollCadence",
                'OPEN'::"PayrollPeriodStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, `cross-tenant-period-${values.suffix}`, values.isolatedTenantId, values.firstPolicyId), /PayrollPeriod_policy_tenant_fkey/);

      await owner.$executeRawUnsafe(`
        INSERT INTO "PayrollPeriod"
          ("id", "tenantId", "policyVersionId", "localStartDate", "localEndDateExclusive", "startsAt", "endsAt",
           "timeZone", "cadence", "status", "revision", "createdAt", "updatedAt")
        VALUES
          ($1, $3, $4, DATE '2026-06-01', DATE '2026-06-08', TIMESTAMPTZ '2026-06-01 07:00:00+00',
           TIMESTAMPTZ '2026-06-08 07:00:00+00', 'America/Los_Angeles', 'WEEKLY'::"PayrollCadence",
           'OPEN'::"PayrollPeriodStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ($2, $3, $5, DATE '2026-06-08', DATE '2026-06-15', TIMESTAMPTZ '2026-06-08 07:00:00+00',
           TIMESTAMPTZ '2026-06-15 07:00:00+00', 'America/Los_Angeles', 'WEEKLY'::"PayrollCadence",
           'OPEN'::"PayrollPeriodStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, values.sourcePeriodId, values.adjustmentPeriodId, values.primaryTenantId, values.firstPolicyId, values.secondPolicyId);

      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "PayrollPeriod"
          ("id", "tenantId", "policyVersionId", "localStartDate", "localEndDateExclusive", "startsAt", "endsAt",
           "timeZone", "cadence", "status", "revision", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, DATE '2026-06-07', DATE '2026-06-14', TIMESTAMPTZ '2026-06-07 07:00:00+00',
                TIMESTAMPTZ '2026-06-14 07:00:00+00', 'America/Los_Angeles', 'WEEKLY'::"PayrollCadence",
                'OPEN'::"PayrollPeriodStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, `overlap-period-${values.suffix}`, values.primaryTenantId, values.firstPolicyId), /PayrollPeriod_tenant_no_overlap/);

      await asTenant(app, values.primaryTenantId, (tx) => tx.$executeRawUnsafe(`
        INSERT INTO "PayrollOperation" ("operationId", "tenantId", "periodId", "kind", "requestHash", "response", "createdAt")
        VALUES ($1, $2, $3, 'ADOPT'::"PayrollOperationKind", $4, '{"adopted":0}'::jsonb, CURRENT_TIMESTAMP)
      `, `adopt-op-${values.suffix}`, values.primaryTenantId, values.sourcePeriodId, hash('6')));

      await rejectsDatabase(owner.$executeRawUnsafe(`
        UPDATE "PayrollPeriod"
        SET "status" = 'LOCKED', "revision" = 1,
            "reviewStartedAt" = TIMESTAMPTZ '2026-06-08 08:00:00+00', "reviewStartedByUserId" = $2,
            "lockedAt" = TIMESTAMPTZ '2026-06-08 09:00:00+00', "lockedByUserId" = $2,
            "lockOperationId" = $3, "lockRequestHash" = $4, "lockedEntrySha256" = $5,
            "lockedEntryCount" = 0, "totalPayableMinutes" = 0, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.sourcePeriodId, values.managerId, `invalid-direct-lock-${values.suffix}`, hash('7'), hash('8')), /invalid payroll period status transition/i);
    });

    await phase('time cards bind period, timezone, revision, and review-frozen membership', async () => {
      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "TimeCard"
          ("id", "tenantId", "userId", "locationId", "clockInAt", "clockOutAt", "payrollPeriodId",
           "workTimeZone", "revision", "breakMinutes", "status", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, TIMESTAMPTZ '2026-06-02 16:00:00+00', TIMESTAMPTZ '2026-06-02 23:00:00+00',
                $5, 'UTC', 1, 30, 'CLOSED'::"TimeCardStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, `wrong-zone-card-${values.suffix}`, values.primaryTenantId, values.staffId, values.locationId, values.sourcePeriodId), /time-card work timezone must match its location snapshot/i);

      await owner.$executeRawUnsafe(`
        INSERT INTO "TimeCard"
          ("id", "tenantId", "userId", "locationId", "clockInAt", "clockOutAt", "payrollPeriodId",
           "workTimeZone", "revision", "breakMinutes", "status", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, TIMESTAMPTZ '2026-06-02 16:00:00+00', TIMESTAMPTZ '2026-06-02 23:00:00+00',
                $5, 'America/Los_Angeles', 1, 30, 'CLOSED'::"TimeCardStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, values.cardId, values.primaryTenantId, values.staffId, values.locationId, values.sourcePeriodId);
      await owner.$executeRawUnsafe(`
        INSERT INTO "TimeCardBreak" ("id", "tenantId", "timeCardId", "startAt", "endAt", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, TIMESTAMPTZ '2026-06-02 19:00:00+00', TIMESTAMPTZ '2026-06-02 19:30:00+00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, values.breakId, values.primaryTenantId, values.cardId);

      await rejectsDatabase(owner.$executeRawUnsafe(
        'UPDATE "TimeCard" SET "notes" = \'changed without revision\', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
        values.cardId,
      ), /time-card business changes must advance one revision/i);
      await owner.$executeRawUnsafe(
        'UPDATE "TimeCard" SET "notes" = \'revision two\', "revision" = 2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
        values.cardId,
      );
      await rejectsDatabase(owner.$executeRawUnsafe(`
        UPDATE "TimeCard"
        SET "payrollPeriodId" = $2, "revision" = 3, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.cardId, values.adjustmentPeriodId), /time card must belong to its open payroll period/i);

      await owner.$executeRawUnsafe(`
        UPDATE "PayrollPeriod"
        SET "status" = 'REVIEW', "revision" = 1,
            "reviewStartedAt" = TIMESTAMPTZ '2026-06-08 08:00:00+00', "reviewStartedByUserId" = $2,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.sourcePeriodId, values.managerId);
      await rejectsDatabase(owner.$executeRawUnsafe(`
        UPDATE "PayrollPeriod"
        SET "status" = 'OPEN', "revision" = 2, "reviewStartedAt" = NULL, "reviewStartedByUserId" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.sourcePeriodId), /invalid payroll period status transition/i);
      await rejectsDatabase(owner.$executeRawUnsafe(`
        UPDATE "TimeCard"
        SET "payrollPeriodId" = $2, "revision" = 3, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.cardId, values.adjustmentPeriodId), /time-card period membership is immutable once payroll review starts/i);
      await rejectsDatabase(owner.$executeRawUnsafe(`
        UPDATE "TimeCard"
        SET "workTimeZone" = 'UTC', "revision" = 3, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.cardId), /time-card work timezone snapshots are immutable/i);
    });

    await phase('approvals bind the current revision and require an independent decision maker', async () => {
      await rejectsDatabase(asTenant(app, values.primaryTenantId, (tx) => tx.$executeRawUnsafe(`
        INSERT INTO "PayrollTimeCardApproval"
          ("id", "tenantId", "periodId", "timeCardId", "timeCardRevision", "decision", "operationId",
           "requestHash", "decidedAt", "decidedByUserId")
        VALUES ($1, $2, $3, $4, 1, 'APPROVED'::"PayrollApprovalDecision", $5, $6,
                TIMESTAMPTZ '2026-06-08 08:10:00+00', $7)
      `, `stale-approval-${values.suffix}`, values.primaryTenantId, values.sourcePeriodId, values.cardId,
      `stale-approval-op-${values.suffix}`, hash('9'), values.managerId)), /approval requires the current closed card revision in review/i);
      await rejectsDatabase(asTenant(app, values.primaryTenantId, (tx) => tx.$executeRawUnsafe(`
        INSERT INTO "PayrollTimeCardApproval"
          ("id", "tenantId", "periodId", "timeCardId", "timeCardRevision", "decision", "operationId",
           "requestHash", "decidedAt", "decidedByUserId")
        VALUES ($1, $2, $3, $4, 2, 'APPROVED'::"PayrollApprovalDecision", $5, $6,
                TIMESTAMPTZ '2026-06-08 08:11:00+00', $7)
      `, `self-approval-${values.suffix}`, values.primaryTenantId, values.sourcePeriodId, values.cardId,
      `self-approval-op-${values.suffix}`, hash('a'), values.staffId)), /employees cannot approve their own time cards/i);

      await asTenant(app, values.primaryTenantId, (tx) => tx.$executeRawUnsafe(`
        INSERT INTO "PayrollTimeCardApproval"
          ("id", "tenantId", "periodId", "timeCardId", "timeCardRevision", "decision", "operationId",
           "requestHash", "decidedAt", "decidedByUserId")
        VALUES ($1, $2, $3, $4, 2, 'APPROVED'::"PayrollApprovalDecision", $5, $6,
                TIMESTAMPTZ '2026-06-08 08:12:00+00', $7)
      `, values.approvalRevision2Id, values.primaryTenantId, values.sourcePeriodId, values.cardId,
      `approval-rev-2-op-${values.suffix}`, hash('b'), values.managerId));

      await owner.$executeRawUnsafe(
        'UPDATE "TimeCard" SET "notes" = \'revision three\', "revision" = 3, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
        values.cardId,
      );
      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "PayrollLockedEntry"
          ("id", "tenantId", "periodId", "sequence", "sourceType", "sourceId", "sourceRevision", "employeeId",
           "locationId", "workTimeZone", "clockInAt", "clockOutAt", "breakMinutes", "payableMinutes",
           "approvedAt", "approvedByUserId", "canonicalSha256", "createdAt")
        VALUES ($1, $2, $3, 0, 'TIME_CARD'::"PayrollSourceType", $4, 3, $5, $6, 'America/Los_Angeles',
                TIMESTAMPTZ '2026-06-02 16:00:00+00', TIMESTAMPTZ '2026-06-02 23:00:00+00', 30, 390,
                TIMESTAMPTZ '2026-06-08 08:12:00+00', $7, $8, CURRENT_TIMESTAMP)
      `, `missing-current-approval-${values.suffix}`, values.primaryTenantId, values.sourcePeriodId, values.cardId,
      values.staffId, values.locationId, values.managerId, hash('c')), /payroll locked entry must exactly snapshot an approved source revision/i);

      await asTenant(app, values.primaryTenantId, (tx) => tx.$executeRawUnsafe(`
        INSERT INTO "PayrollTimeCardApproval"
          ("id", "tenantId", "periodId", "timeCardId", "timeCardRevision", "decision", "operationId",
           "requestHash", "decidedAt", "decidedByUserId")
        VALUES ($1, $2, $3, $4, 3, 'APPROVED'::"PayrollApprovalDecision", $5, $6,
                TIMESTAMPTZ '2026-06-08 08:20:00+00', $7)
      `, values.approvalRevision3Id, values.primaryTenantId, values.sourcePeriodId, values.cardId,
      `approval-rev-3-op-${values.suffix}`, hash('d'), values.reviewerId));
    });

    await phase('locking accepts only exact current source snapshots and exact terminal totals', async () => {
      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "PayrollLockedEntry"
          ("id", "tenantId", "periodId", "sequence", "sourceType", "sourceId", "sourceRevision", "employeeId",
           "locationId", "workTimeZone", "clockInAt", "clockOutAt", "breakMinutes", "payableMinutes",
           "approvedAt", "approvedByUserId", "canonicalSha256", "createdAt")
        VALUES ($1, $2, $3, 0, 'TIME_CARD'::"PayrollSourceType", $4, 3, $5, $6, 'America/Los_Angeles',
                TIMESTAMPTZ '2026-06-02 16:00:00+00', TIMESTAMPTZ '2026-06-02 23:00:00+00', 30, 389,
                TIMESTAMPTZ '2026-06-08 08:20:00+00', $7, $8, CURRENT_TIMESTAMP)
      `, `wrong-source-entry-${values.suffix}`, values.primaryTenantId, values.sourcePeriodId, values.cardId,
      values.staffId, values.locationId, values.reviewerId, hash('e')), /payroll locked entry must exactly snapshot an approved source revision/i);

      await owner.$executeRawUnsafe(`
        INSERT INTO "PayrollLockedEntry"
          ("id", "tenantId", "periodId", "sequence", "sourceType", "sourceId", "sourceRevision", "employeeId",
           "locationId", "workTimeZone", "clockInAt", "clockOutAt", "breakMinutes", "payableMinutes",
           "approvedAt", "approvedByUserId", "canonicalSha256", "createdAt")
        VALUES ($1, $2, $3, 0, 'TIME_CARD'::"PayrollSourceType", $4, 3, $5, $6, 'America/Los_Angeles',
                TIMESTAMPTZ '2026-06-02 16:00:00+00', TIMESTAMPTZ '2026-06-02 23:00:00+00', 30, 390,
                TIMESTAMPTZ '2026-06-08 08:20:00+00', $7, $8, CURRENT_TIMESTAMP)
      `, values.sourceEntryId, values.primaryTenantId, values.sourcePeriodId, values.cardId,
      values.staffId, values.locationId, values.reviewerId, hash('f'));

      await rejectsDatabase(owner.$executeRawUnsafe(`
        UPDATE "PayrollPeriod"
        SET "status" = 'LOCKED', "revision" = 2, "lockedAt" = TIMESTAMPTZ '2026-06-08 09:00:00+00',
            "lockedByUserId" = $2, "lockOperationId" = $3, "lockRequestHash" = $4,
            "lockedEntrySha256" = $5, "lockedEntryCount" = 2, "totalPayableMinutes" = 390,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.sourcePeriodId, values.managerId, `source-lock-op-${values.suffix}`, hash('0'), hash('1')), /locked payroll totals do not match immutable entries/i);
      await owner.$executeRawUnsafe(`
        UPDATE "PayrollPeriod"
        SET "status" = 'LOCKED', "revision" = 2, "lockedAt" = TIMESTAMPTZ '2026-06-08 09:00:00+00',
            "lockedByUserId" = $2, "lockOperationId" = $3, "lockRequestHash" = $4,
            "lockedEntrySha256" = $5, "lockedEntryCount" = 1, "totalPayableMinutes" = 390,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.sourcePeriodId, values.managerId, `source-lock-op-${values.suffix}`, hash('0'), hash('1'));

      await rejectsDatabase(owner.$executeRawUnsafe(
        'UPDATE "TimeCard" SET "notes" = \'locked change\', "revision" = 4, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
        values.cardId,
      ), /time card must belong to its open payroll period/i);
      await rejectsDatabase(owner.$executeRawUnsafe(`
        UPDATE "TimeCardBreak" SET "endAt" = TIMESTAMPTZ '2026-06-02 19:31:00+00', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.breakId), /time-card breaks belong to an immutable payroll period/i);
    });

    await phase('signed amendments target only a future open adjustment period and require an independent reviewer', async () => {
      const amendmentInsert = (id, adjustmentPeriodId, requesterId, operationId) => owner.$executeRawUnsafe(`
        INSERT INTO "PayrollAmendment"
          ("id", "tenantId", "lockedEntryId", "adjustmentPeriodId", "operationId", "requestHash",
           "requestedByUserId", "reason", "replacementClockInAt", "replacementClockOutAt",
           "replacementBreakMinutes", "replacementPayableMinutes", "minuteDelta", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'Correct provider rounding',
                TIMESTAMPTZ '2026-06-02 16:00:00+00', TIMESTAMPTZ '2026-06-02 22:45:00+00',
                30, 375, -15, CURRENT_TIMESTAMP)
      `, id, values.primaryTenantId, values.sourceEntryId, adjustmentPeriodId, operationId, hash('2'), requesterId);

      await rejectsDatabase(amendmentInsert(
        `self-amendment-${values.suffix}`, values.adjustmentPeriodId, values.staffId, `self-amendment-op-${values.suffix}`,
      ), /payroll amendment must be a valid correction of a locked original entry into an open adjustment period/i);
      await rejectsDatabase(amendmentInsert(
        `past-amendment-${values.suffix}`, values.sourcePeriodId, values.managerId, `past-amendment-op-${values.suffix}`,
      ), /payroll amendment must be a valid correction of a locked original entry into an open adjustment period/i);
      await amendmentInsert(values.amendmentId, values.adjustmentPeriodId, values.managerId, `amendment-op-${values.suffix}`);

      await owner.$executeRawUnsafe(`
        UPDATE "PayrollPeriod"
        SET "status" = 'REVIEW', "revision" = 1,
            "reviewStartedAt" = TIMESTAMPTZ '2026-06-15 08:00:00+00', "reviewStartedByUserId" = $2,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.adjustmentPeriodId, values.managerId);

      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "PayrollAmendmentDecision"
          ("id", "tenantId", "amendmentId", "decision", "operationId", "requestHash", "decidedByUserId", "decidedAt")
        VALUES ($1, $2, $3, 'APPROVED'::"PayrollApprovalDecision", $4, $5, $6,
                TIMESTAMPTZ '2026-06-15 08:10:00+00')
      `, `requester-decision-${values.suffix}`, values.primaryTenantId, values.amendmentId,
      `requester-decision-op-${values.suffix}`, hash('3'), values.managerId), /amendment decisions require an independent approver/i);

      await owner.$executeRawUnsafe(`
        INSERT INTO "PayrollAmendmentDecision"
          ("id", "tenantId", "amendmentId", "decision", "operationId", "requestHash", "decidedByUserId", "decidedAt")
        VALUES ($1, $2, $3, 'APPROVED'::"PayrollApprovalDecision", $4, $5, $6,
                TIMESTAMPTZ '2026-06-15 08:20:00+00')
      `, values.amendmentDecisionId, values.primaryTenantId, values.amendmentId,
      `amendment-decision-op-${values.suffix}`, hash('4'), values.reviewerId);

      await rejectsDatabase(owner.$executeRawUnsafe(`
        INSERT INTO "PayrollLockedEntry"
          ("id", "tenantId", "periodId", "sequence", "sourceType", "sourceId", "sourceRevision", "employeeId",
           "locationId", "workTimeZone", "clockInAt", "clockOutAt", "breakMinutes", "payableMinutes",
           "approvedAt", "approvedByUserId", "canonicalSha256", "createdAt")
        VALUES ($1, $2, $3, 0, 'AMENDMENT'::"PayrollSourceType", $4, 1, $5, $6, 'America/Los_Angeles',
                TIMESTAMPTZ '2026-06-02 16:00:00+00', TIMESTAMPTZ '2026-06-02 22:45:00+00', 30, 15,
                TIMESTAMPTZ '2026-06-15 08:20:00+00', $7, $8, CURRENT_TIMESTAMP)
      `, `unsigned-amendment-entry-${values.suffix}`, values.primaryTenantId, values.adjustmentPeriodId,
      values.amendmentId, values.staffId, values.locationId, values.reviewerId, hash('5')), /payroll locked entry must exactly snapshot an approved source revision/i);

      await owner.$executeRawUnsafe(`
        INSERT INTO "PayrollLockedEntry"
          ("id", "tenantId", "periodId", "sequence", "sourceType", "sourceId", "sourceRevision", "employeeId",
           "locationId", "workTimeZone", "clockInAt", "clockOutAt", "breakMinutes", "payableMinutes",
           "approvedAt", "approvedByUserId", "canonicalSha256", "createdAt")
        VALUES ($1, $2, $3, 0, 'AMENDMENT'::"PayrollSourceType", $4, 1, $5, $6, 'America/Los_Angeles',
                TIMESTAMPTZ '2026-06-02 16:00:00+00', TIMESTAMPTZ '2026-06-02 22:45:00+00', 30, -15,
                TIMESTAMPTZ '2026-06-15 08:20:00+00', $7, $8, CURRENT_TIMESTAMP)
      `, values.amendmentEntryId, values.primaryTenantId, values.adjustmentPeriodId,
      values.amendmentId, values.staffId, values.locationId, values.reviewerId, hash('6'));
      await owner.$executeRawUnsafe(`
        UPDATE "PayrollPeriod"
        SET "status" = 'LOCKED', "revision" = 2, "lockedAt" = TIMESTAMPTZ '2026-06-15 09:00:00+00',
            "lockedByUserId" = $2, "lockOperationId" = $3, "lockRequestHash" = $4,
            "lockedEntrySha256" = $5, "lockedEntryCount" = 1, "totalPayableMinutes" = -15,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.adjustmentPeriodId, values.managerId, `adjustment-lock-op-${values.suffix}`, hash('7'), hash('8'));
    });

    await phase('export rows exactly snapshot locked evidence and remain immutable', async () => {
      await owner.$executeRawUnsafe(`
        INSERT INTO "CreditTransaction"
          ("id", "tenantId", "amount", "debtAmount", "reason", "balanceAfter", "debtAfter", "createdAt")
        VALUES ($1, $2, -1, 0, $3, 9, 0, CURRENT_TIMESTAMP)
      `, values.exportCreditTransactionId, values.primaryTenantId,
      `Payroll export (${values.sourcePeriodId})`);
      const insertBatch = (tx) => tx.$executeRawUnsafe(`
        INSERT INTO "PayrollExportBatch"
          ("id", "tenantId", "periodId", "operationId", "requestHash", "creditTransactionId",
           "formatVersion", "status",
           "contentSha256", "rowCount", "totalPayableMinutes", "consumedCredits", "newBalance", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, 1, 'GENERATED'::"PayrollExportStatus", $7, 1, 390, 1, 9,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, values.batchId, values.primaryTenantId, values.sourcePeriodId,
      values.exportOperationId, hash('9'), values.exportCreditTransactionId, hash('a'));
      const insertLine = (tx, payableMinutes) => tx.$executeRawUnsafe(`
        INSERT INTO "PayrollExportLine"
          ("id", "tenantId", "batchId", "lineNumber", "lockedEntryId", "sourceType", "sourceId", "employeeId",
           "locationId", "workTimeZone", "clockInAt", "clockOutAt", "breakMinutes", "payableMinutes",
           "canonicalSha256", "createdAt")
        VALUES ($1, $2, $3, 1, $4, 'TIME_CARD'::"PayrollSourceType", $5, $6, $7, 'America/Los_Angeles',
                TIMESTAMPTZ '2026-06-02 16:00:00+00', TIMESTAMPTZ '2026-06-02 23:00:00+00', 30, $8, $9,
                CURRENT_TIMESTAMP)
      `, values.lineId, values.primaryTenantId, values.batchId, values.sourceEntryId, values.cardId,
      values.staffId, values.locationId, payableMinutes, hash('f'));

      await rejectsDatabase(owner.$transaction(async (tx) => {
        await insertBatch(tx);
        await insertLine(tx, 389);
      }), /payroll export line must exactly snapshot a locked entry from its batch period/i);
      await owner.$transaction(async (tx) => {
        await insertBatch(tx);
        await insertLine(tx, 390);
      });

      await rejectsDatabase(owner.$executeRawUnsafe(
        'UPDATE "PayrollExportLine" SET "payableMinutes" = 389 WHERE "id" = $1', values.lineId,
      ), /retained payroll evidence is immutable/i);
      await rejectsDatabase(owner.$executeRawUnsafe(
        'UPDATE "PayrollExportBatch" SET "contentSha256" = $2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
        values.batchId, hash('b'),
      ), /payroll export batch content is immutable/i);

      await owner.$executeRawUnsafe(`
        UPDATE "PayrollExportBatch"
        SET "status" = 'DOWNLOADED', "downloadedAt" = TIMESTAMPTZ '2026-06-15 10:00:00+00',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.batchId);
      await owner.$executeRawUnsafe(`
        UPDATE "PayrollExportBatch" SET "status" = 'RECONCILING', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1
      `, values.batchId);
    });

    await phase('reconciliation state projects the latest event while identity and deletion stay purge-only', async () => {
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`
          INSERT INTO "PayrollReconciliationReceipt"
            ("id", "tenantId", "batchId", "provider", "providerEventId", "payloadSha256",
             "providerTotalMinutes", "acceptedCount", "rejectedCount", "pendingCount", "receivedByUserId", "receivedAt")
          VALUES ($1, $2, $3, 'test-provider', $4, $5, 390, 1, 0, 0, $6,
                  TIMESTAMPTZ '2026-06-15 11:00:00+00')
        `, values.firstReceiptId, values.primaryTenantId, values.batchId,
        `provider-event-1-${values.suffix}`, hash('c'), values.managerId);
        await tx.$executeRawUnsafe(`
          INSERT INTO "PayrollReconciliationLineEvent"
            ("id", "tenantId", "receiptId", "batchId", "lineId", "status", "reason", "createdAt")
          VALUES ($1, $2, $3, $4, $5, 'ACCEPTED'::"PayrollReconciliationLineStatus", NULL, CURRENT_TIMESTAMP)
        `, values.firstEventId, values.primaryTenantId, values.firstReceiptId, values.batchId, values.lineId);
        await tx.$executeRawUnsafe(`
          INSERT INTO "PayrollReconciliationLineState"
            ("id", "tenantId", "batchId", "lineId", "status", "latestReceiptId", "reason", "updatedAt")
          VALUES ($1, $2, $3, $4, 'ACCEPTED'::"PayrollReconciliationLineStatus", $5, NULL, CURRENT_TIMESTAMP)
        `, values.lineStateId, values.primaryTenantId, values.batchId, values.lineId, values.firstReceiptId);
      });

      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`
          INSERT INTO "PayrollReconciliationReceipt"
            ("id", "tenantId", "batchId", "provider", "providerEventId", "payloadSha256",
             "providerTotalMinutes", "acceptedCount", "rejectedCount", "pendingCount", "receivedByUserId", "receivedAt")
          VALUES ($1, $2, $3, 'test-provider', $4, $5, 390, 0, 1, 0, $6,
                  TIMESTAMPTZ '2026-06-15 12:00:00+00')
        `, values.secondReceiptId, values.primaryTenantId, values.batchId,
        `provider-event-2-${values.suffix}`, hash('d'), values.reviewerId);
        await tx.$executeRawUnsafe(`
          INSERT INTO "PayrollReconciliationLineEvent"
            ("id", "tenantId", "receiptId", "batchId", "lineId", "status", "reason", "createdAt")
          VALUES ($1, $2, $3, $4, $5, 'REJECTED'::"PayrollReconciliationLineStatus", 'Provider correction', CURRENT_TIMESTAMP)
        `, values.secondEventId, values.primaryTenantId, values.secondReceiptId, values.batchId, values.lineId);
        await tx.$executeRawUnsafe(`
          UPDATE "PayrollReconciliationLineState"
          SET "status" = 'REJECTED', "latestReceiptId" = $2, "reason" = 'Provider correction',
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1
        `, values.lineStateId, values.secondReceiptId);
      });

      await rejectsDatabase(owner.$executeRawUnsafe(`
        UPDATE "PayrollReconciliationLineState"
        SET "status" = 'ACCEPTED', "latestReceiptId" = $2, "reason" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.lineStateId, values.firstReceiptId), /payroll reconciliation state must project its exact latest immutable event/i);
      await rejectsDatabase(owner.$executeRawUnsafe(`
        UPDATE "PayrollReconciliationLineState" SET "id" = $2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1
      `, values.lineStateId, `changed-state-${values.suffix}`), /payroll reconciliation state identity is immutable/i);
      await rejectsDatabase(owner.$executeRawUnsafe(
        'DELETE FROM "PayrollReconciliationLineState" WHERE "id" = $1', values.lineStateId,
      ), /payroll reconciliation state requires the controlled retained-record purge/i);
      await rejectsDatabase(owner.$executeRawUnsafe(
        'UPDATE "PayrollReconciliationLineEvent" SET "reason" = \'changed\' WHERE "id" = $1', values.secondEventId,
      ), /retained payroll evidence is immutable/i);

      await owner.$executeRawUnsafe(`
        UPDATE "PayrollExportBatch"
        SET "status" = 'RECONCILED', "reconciledAt" = TIMESTAMPTZ '2026-06-15 12:10:00+00',
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.batchId);
    });

    await phase('active complete legal hold blocks tenant tampering, tenant deletion, and both purge stages', async () => {
      await asPlatformAdmin(owner, (tx) => tx.$executeRawUnsafe(`
        UPDATE "Tenant"
        SET "status" = 'PURGED'::"TenantStatus", "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
            "applicationDataPurgedAt" = NULL,
            "retentionLegalHoldAt" = TIMESTAMPTZ '2026-07-16 17:30:00+00',
            "retentionLegalHoldReason" = 'Active payroll litigation preservation',
            "retentionLegalHoldByUserId" = 'platform-payroll-test', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.primaryTenantId));

      let tenantTamperBlocked = false;
      try {
        const affected = await asTenant(app, values.primaryTenantId, (tx) => tx.$executeRawUnsafe(`
          UPDATE "Tenant"
          SET "retentionLegalHoldAt" = NULL, "retentionLegalHoldReason" = NULL,
              "retentionLegalHoldByUserId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1
        `, values.primaryTenantId));
        assert.equal(affected, 1, 'tenant-role legal-hold probe did not reach the target row');
      } catch (error) {
        assert.match(databaseError(error), /Retention legal hold changes require platform admin capability/);
        tenantTamperBlocked = true;
      }
      if (!tenantTamperBlocked) {
        contractFailures.push('restricted tenant role changed an active retention legal hold');
      }
      const restoredAfterTamper = await asPlatformAdmin(owner, (tx) => tx.$executeRawUnsafe(`
        UPDATE "Tenant"
        SET "retentionLegalHoldAt" = TIMESTAMPTZ '2026-07-16 17:30:00+00',
            "retentionLegalHoldReason" = 'Active payroll litigation preservation',
            "retentionLegalHoldByUserId" = 'platform-payroll-test', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.primaryTenantId));
      assert.equal(restoredAfterTamper, 1);

      let partialHoldBlocked = false;
      try {
        const affected = await asPlatformAdmin(owner, (tx) => tx.$executeRawUnsafe(`
          UPDATE "Tenant" SET "retentionLegalHoldReason" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1
        `, values.primaryTenantId));
        assert.equal(affected, 1, 'partial legal-hold probe did not reach the target row');
      } catch (error) {
        assert.match(databaseError(error), /Tenant_retention_legal_hold_valid|violates check constraint/i);
        partialHoldBlocked = true;
      }
      if (!partialHoldBlocked) {
        contractFailures.push('partial legal-hold state with a missing reason was accepted');
      }
      const restoredAfterPartial = await asPlatformAdmin(owner, (tx) => tx.$executeRawUnsafe(`
        UPDATE "Tenant"
        SET "retentionLegalHoldReason" = 'Active payroll litigation preservation',
            "retentionLegalHoldByUserId" = 'platform-payroll-test', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.primaryTenantId));
      assert.equal(restoredAfterPartial, 1);
      await rejectsDatabase(owner.$executeRawUnsafe(
        'DELETE FROM "Tenant" WHERE "id" = $1', values.primaryTenantId,
      ), /tenant records cannot be deleted while a retention legal hold is active/i);
      await rejectsDatabase(asPlatformAdmin(owner, (tx) => tx.$queryRawUnsafe(
        'SELECT purge_payroll_operational_time_cards($1) AS purged', values.primaryTenantId,
      )), /tenant is not eligible for payroll operational purge/);

      await asPlatformAdmin(owner, (tx) => tx.$executeRawUnsafe(`
        UPDATE "Tenant" SET "applicationDataPurgedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1
      `, values.primaryTenantId));
      await rejectsDatabase(asPlatformAdmin(owner, (tx) => tx.$queryRawUnsafe(
        'SELECT purge_expired_payroll_records($1) AS purged', values.primaryTenantId,
      )), /tenant retained payroll records are not eligible for purge/);
    });

    await phase('clearing the hold permits FK-safe operational then retained-evidence purge', async () => {
      await asPlatformAdmin(owner, (tx) => tx.$executeRawUnsafe(`
        UPDATE "Tenant"
        SET "applicationDataPurgedAt" = NULL, "retentionLegalHoldAt" = NULL,
            "retentionLegalHoldReason" = NULL, "retentionLegalHoldByUserId" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.primaryTenantId));
      await owner.$executeRawUnsafe(`
        INSERT INTO "TimeCard"
          ("id", "tenantId", "userId", "clockInAt", "clockOutAt", "workTimeZone", "revision",
           "breakMinutes", "status", "createdAt", "updatedAt", "deletedAt")
        VALUES ($1, $2, $3, TIMESTAMPTZ '2025-01-02 16:00:00+00', TIMESTAMPTZ '2025-01-02 17:00:00+00',
                'UTC', 1, 0, 'CLOSED'::"TimeCardStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, values.deletedUnsnapshottedCardId, values.primaryTenantId, values.staffId);
      await rejectsDatabase(asPlatformAdmin(owner, (tx) => tx.$queryRawUnsafe(
        'SELECT purge_payroll_operational_time_cards($1) AS purged', values.primaryTenantId,
      )), /time cards require current immutable payroll snapshots before purge/i);
      await owner.$executeRawUnsafe('DELETE FROM "TimeCard" WHERE "id" = $1', values.deletedUnsnapshottedCardId);
      const operational = await asPlatformAdmin(owner, (tx) => tx.$queryRawUnsafe(
        'SELECT purge_payroll_operational_time_cards($1) AS purged', values.primaryTenantId,
      ));
      assert.equal(Number(operational[0].purged), 1);

      await asPlatformAdmin(owner, (tx) => tx.$executeRawUnsafe(`
        UPDATE "Tenant" SET "applicationDataPurgedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1
      `, values.primaryTenantId));
      const retained = await asPlatformAdmin(owner, (tx) => tx.$queryRawUnsafe(
        'SELECT purge_expired_payroll_records($1) AS purged', values.primaryTenantId,
      ));
      assert.ok(Number(retained[0].purged) >= 12);

      await owner.$executeRawUnsafe('DELETE FROM "Location" WHERE "tenantId" = $1', values.primaryTenantId);
      await owner.$executeRawUnsafe('DELETE FROM "User" WHERE "tenantId" = $1', values.primaryTenantId);
      await owner.$executeRawUnsafe('DELETE FROM "CreditTransaction" WHERE "tenantId" = $1', values.primaryTenantId);
      await owner.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', values.primaryTenantId);

      await asPlatformAdmin(owner, (tx) => tx.$executeRawUnsafe(`
        UPDATE "Tenant"
        SET "status" = 'PURGED'::"TenantStatus", "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
            "applicationDataPurgedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1
      `, values.isolatedTenantId));
      await asPlatformAdmin(owner, (tx) => tx.$queryRawUnsafe(
        'SELECT purge_expired_payroll_records($1)', values.isolatedTenantId,
      ));
      await owner.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', values.isolatedTenantId);
      assert.deepEqual(contractFailures, [], 'payroll legal-hold contract failures');
    });
  } finally {
    await forceCleanup(owner, values).catch(() => undefined);
    await app.$disconnect();
    await owner.$disconnect();
  }
});

test('the shared payroll lock serializes clock-in assignment against OPEN to REVIEW', { timeout: 30_000 }, async () => {
  const owner = client(serviceUrl('MIGRATION_DATABASE_URL'));
  const contender = client(serviceUrl('MIGRATION_DATABASE_URL'));
  const suffix = randomUUID();
  const tenantId = `tenant-payroll-race-${suffix}`;
  const userId = `user-payroll-race-${suffix}`;
  const locationId = `location-payroll-race-${suffix}`;
  const policyId = `policy-payroll-race-${suffix}`;
  const periodId = `period-payroll-race-${suffix}`;
  const cardId = `card-payroll-race-${suffix}`;
  const lockKey = `lunchlineup:payroll:${tenantId}:${periodId}`;

  try {
    await owner.$executeRawUnsafe(`
      INSERT INTO "Tenant" ("id", "name", "slug", "status", "createdAt", "updatedAt")
      VALUES ($1, 'Payroll Race', $2, 'ACTIVE'::"TenantStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, tenantId, `payroll-race-${suffix}`);
    await owner.$executeRawUnsafe(`
      INSERT INTO "User" ("id", "tenantId", "name", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
      VALUES ($1, $2, 'Payroll Race Staff', 'STAFF'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, userId, tenantId);
    await owner.$executeRawUnsafe(`
      INSERT INTO "Location" ("id", "tenantId", "name", "timezone", "createdAt", "updatedAt")
      VALUES ($1, $2, 'Payroll Race Location', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, locationId, tenantId);
    await owner.$executeRawUnsafe(`
      INSERT INTO "PayrollPolicyVersion"
        ("id", "tenantId", "version", "timeZone", "cadence", "anchorDate", "effectiveFrom",
         "operationId", "requestHash", "createdByUserId", "createdAt")
      VALUES ($1, $2, 1, 'UTC', 'WEEKLY'::"PayrollCadence", DATE '2026-06-01', DATE '2026-06-01',
              $3, $4, $5, CURRENT_TIMESTAMP)
    `, policyId, tenantId, `policy-race-op-${suffix}`, hash('a'), userId);
    await owner.$executeRawUnsafe(`
      INSERT INTO "PayrollPeriod"
        ("id", "tenantId", "policyVersionId", "localStartDate", "localEndDateExclusive", "startsAt", "endsAt",
         "timeZone", "cadence", "status", "revision", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, DATE '2026-06-01', DATE '2026-06-08', TIMESTAMPTZ '2026-06-01 00:00:00+00',
              TIMESTAMPTZ '2026-06-08 00:00:00+00', 'UTC', 'WEEKLY'::"PayrollCadence",
              'OPEN'::"PayrollPeriodStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, periodId, tenantId, policyId);

    let releaseClockIn;
    let clockInLocked;
    const holdClockIn = new Promise((resolve) => { releaseClockIn = resolve; });
    const clockInHasLock = new Promise((resolve) => { clockInLocked = resolve; });
    const clockIn = owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', lockKey);
      clockInLocked();
      await holdClockIn;
      await tx.$executeRawUnsafe(`
        INSERT INTO "TimeCard"
          ("id", "tenantId", "userId", "locationId", "clockInAt", "payrollPeriodId", "workTimeZone",
           "revision", "breakMinutes", "status", "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, TIMESTAMPTZ '2026-06-02 12:00:00+00', $5, 'UTC', 1, 0,
                'OPEN'::"TimeCardStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, cardId, tenantId, userId, locationId, periodId);
    });
    await clockInHasLock;

    const reviewAfterClockIn = contender.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', lockKey);
      const candidates = await tx.$queryRawUnsafe(`
        SELECT "id", "status"::text AS "status" FROM "TimeCard"
        WHERE "tenantId" = $1 AND "payrollPeriodId" = $2 FOR UPDATE
      `, tenantId, periodId);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, 'OPEN');
      throw new Error('review rejected the concurrently committed open card');
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseClockIn();
    await clockIn;
    await assert.rejects(reviewAfterClockIn, /review rejected the concurrently committed open card/);
    const stillOpen = await owner.$queryRawUnsafe('SELECT "status"::text AS "status" FROM "PayrollPeriod" WHERE "id" = $1', periodId);
    assert.equal(stillOpen[0].status, 'OPEN');
    await owner.$executeRawUnsafe('DELETE FROM "TimeCard" WHERE "id" = $1', cardId);

    let releaseReview;
    let reviewLocked;
    const holdReview = new Promise((resolve) => { releaseReview = resolve; });
    const reviewHasLock = new Promise((resolve) => { reviewLocked = resolve; });
    const reviewWins = owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', lockKey);
      await tx.$executeRawUnsafe(`
        UPDATE "PayrollPeriod"
        SET "status" = 'REVIEW'::"PayrollPeriodStatus", "revision" = 1,
            "reviewStartedAt" = CURRENT_TIMESTAMP, "reviewStartedByUserId" = $2, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "status" = 'OPEN'::"PayrollPeriodStatus"
      `, periodId, userId);
      reviewLocked();
      await holdReview;
    });
    await reviewHasLock;

    let clockCandidateRead;
    const candidateWasRead = new Promise((resolve) => { clockCandidateRead = resolve; });
    const clockInAfterReview = contender.$transaction(async (tx) => {
      const candidate = await tx.$queryRawUnsafe(`
        SELECT "id" FROM "PayrollPeriod"
        WHERE "id" = $1 AND "tenantId" = $2 AND "status" = 'OPEN'::"PayrollPeriodStatus"
      `, periodId, tenantId);
      assert.equal(candidate.length, 1);
      clockCandidateRead();
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', lockKey);
      const current = await tx.$queryRawUnsafe(`
        SELECT "id" FROM "PayrollPeriod"
        WHERE "id" = $1 AND "tenantId" = $2 AND "status" = 'OPEN'::"PayrollPeriodStatus"
        FOR UPDATE
      `, periodId, tenantId);
      assert.equal(current.length, 0);
      throw new Error('clock-in rejected the reviewed payroll period');
    });
    await candidateWasRead;
    releaseReview();
    await reviewWins;
    await assert.rejects(clockInAfterReview, /clock-in rejected the reviewed payroll period/);
    const finalState = await owner.$queryRawUnsafe(`
      SELECT period."status"::text AS "status", COUNT(card."id")::integer AS "cardCount"
      FROM "PayrollPeriod" period
      LEFT JOIN "TimeCard" card ON card."tenantId" = period."tenantId" AND card."payrollPeriodId" = period."id"
      WHERE period."id" = $1
      GROUP BY period."status"
    `, periodId);
    assert.deepEqual(finalState, [{ status: 'REVIEW', cardCount: 0 }]);
  } finally {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      for (const table of ['TimeCard', 'PayrollPeriod', 'PayrollPolicyVersion', 'Location', 'User']) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = $1`, tenantId);
      }
      await tx.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', tenantId);
    }).catch(() => undefined);
    await contender.$disconnect();
    await owner.$disconnect();
  }
});
