import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { FeatureAccessService } = require('../../apps/api/src/billing/feature-access.service.ts');
const { MeteringService } = require('../../apps/api/src/billing/metering.service.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');
const { PayrollExportService } = require('../../apps/api/src/payroll/payroll-export.service.ts');
const { materializeLockedSnapshots } = require('../../apps/api/src/payroll/payroll-lock-snapshot.ts');
const { TimeCardsController } = require('../../apps/api/src/time-cards/time-cards.controller.ts');

function bounded(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
}

function namedDatabaseUrl(base, applicationName) {
  const url = new URL(base);
  url.searchParams.set('application_name', applicationName);
  url.searchParams.set('connection_limit', '1');
  return url.toString();
}

async function waitForLockWait(observer, applicationName, label) {
  const deadline = Date.now() + 8_000;
  let state = [];
  while (Date.now() < deadline) {
    state = await observer.$queryRawUnsafe(`
      SELECT "wait_event_type" AS "waitEventType", "wait_event" AS "waitEvent", "query"
      FROM pg_stat_activity
      WHERE "application_name" = $1 AND "datname" = current_database()
    `, applicationName);
    if (state.some((row) => row.waitEventType === 'Lock')) return;
    await delay(25);
  }
  throw new Error(`${label} did not reach a database lock barrier: ${JSON.stringify(state)}`);
}

async function holdTableBarrier(prisma, tableName, ready, release) {
  assert.ok(['User', 'TimeCard'].includes(tableName));
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`LOCK TABLE "${tableName}" IN ACCESS EXCLUSIVE MODE`);
    ready.resolve();
    await release.promise;
  }, { timeout: 20_000 });
}

function fixture(prefix) {
  const suffix = randomUUID();
  return {
    tenantId: `tenant-${prefix}-${suffix}`,
    tenantSlug: `${prefix}-${suffix}`,
    managerId: `manager-${prefix}-${suffix}`,
    employeeId: `employee-${prefix}-${suffix}`,
    locationId: `location-${prefix}-${suffix}`,
    policyId: `policy-${prefix}-${suffix}`,
    openPeriodId: `period-open-${prefix}-${suffix}`,
    lockedPeriodId: `period-locked-${prefix}-${suffix}`,
    lockedEntryId: `entry-${prefix}-${suffix}`,
    correctionCardId: `card-correction-${prefix}-${suffix}`,
    suffix,
  };
}

async function createFixture(owner, values) {
  const source = {
    sourceType: 'TIME_CARD',
    sourceId: `locked-source-${values.suffix}`,
    sourceRevision: 1,
    employeeId: values.employeeId,
    locationId: values.locationId,
    workTimeZone: 'UTC',
    clockInAt: new Date('2026-06-10T09:00:00.000Z'),
    clockOutAt: new Date('2026-06-10T17:00:00.000Z'),
    breakMinutes: 0,
    payableMinutes: 480,
    approvedAt: new Date('2026-06-30T12:00:00.000Z'),
    approvedByUserId: values.managerId,
  };
  const snapshot = materializeLockedSnapshots({
    tenantId: values.tenantId,
    periodId: values.lockedPeriodId,
    sources: [source],
  });
  const correctionClockIn = new Date('2026-07-10T09:00:00.000Z');

  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.tenant.create({
      data: {
        id: values.tenantId,
        name: 'Payroll lock order integration',
        slug: values.tenantSlug,
        planTier: 'GROWTH',
        status: 'ACTIVE',
        stripeSubscriptionId: `sub-${values.suffix}`,
        stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        usageCredits: 5,
      },
    });
    await tx.tenantSetting.create({
      data: {
        id: `setting-${values.suffix}`,
        tenantId: values.tenantId,
        key: 'feature_access',
        value: { features: { time_cards: { enabled: true, source: 'manual' } } },
      },
    });
    await tx.user.createMany({
      data: [{
        id: values.managerId,
        tenantId: values.tenantId,
        name: 'Payroll Manager',
        role: 'ADMIN',
        mfaEnabled: false,
        mfaBackupCodes: [],
      }, {
        id: values.employeeId,
        tenantId: values.tenantId,
        name: 'Payroll Employee',
        role: 'STAFF',
        mfaEnabled: false,
        mfaBackupCodes: [],
      }],
    });
    await tx.location.create({
      data: { id: values.locationId, tenantId: values.tenantId, name: 'UTC Location', timezone: 'UTC' },
    });
    await tx.payrollPolicyVersion.create({
      data: {
        id: values.policyId,
        tenantId: values.tenantId,
        version: 1,
        timeZone: 'UTC',
        cadence: 'WEEKLY',
        anchorDate: new Date('2026-06-01T00:00:00.000Z'),
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        operationId: `policy-${values.suffix}`,
        requestHash: 'a'.repeat(64),
        createdByUserId: values.managerId,
      },
    });
    await tx.payrollPeriod.createMany({
      data: [{
        id: values.openPeriodId,
        tenantId: values.tenantId,
        policyVersionId: values.policyId,
        localStartDate: new Date('2026-07-01T00:00:00.000Z'),
        localEndDateExclusive: new Date('2026-08-01T00:00:00.000Z'),
        startsAt: new Date('2026-07-01T00:00:00.000Z'),
        endsAt: new Date('2026-08-01T00:00:00.000Z'),
        timeZone: 'UTC',
        cadence: 'WEEKLY',
        status: 'OPEN',
        revision: 0,
      }, {
        id: values.lockedPeriodId,
        tenantId: values.tenantId,
        policyVersionId: values.policyId,
        localStartDate: new Date('2026-06-01T00:00:00.000Z'),
        localEndDateExclusive: new Date('2026-07-01T00:00:00.000Z'),
        startsAt: new Date('2026-06-01T00:00:00.000Z'),
        endsAt: new Date('2026-07-01T00:00:00.000Z'),
        timeZone: 'UTC',
        cadence: 'WEEKLY',
        status: 'LOCKED',
        revision: 2,
        reviewStartedAt: new Date('2026-06-30T10:00:00.000Z'),
        reviewStartedByUserId: values.managerId,
        lockedAt: new Date('2026-06-30T12:00:00.000Z'),
        lockedByUserId: values.managerId,
        lockOperationId: `lock-${values.suffix}`,
        lockRequestHash: 'b'.repeat(64),
        lockedEntrySha256: snapshot.aggregateSha256,
        lockedEntryCount: 1,
        totalPayableMinutes: snapshot.totalPayableMinutes,
      }],
    });
    await tx.payrollLockedEntry.create({
      data: {
        id: values.lockedEntryId,
        tenantId: values.tenantId,
        periodId: values.lockedPeriodId,
        sequence: 0,
        ...source,
        canonicalSha256: snapshot.entries[0].canonicalSha256,
      },
    });
    await tx.timeCard.create({
      data: {
        id: values.correctionCardId,
        tenantId: values.tenantId,
        userId: values.employeeId,
        locationId: values.locationId,
        clockInAt: correctionClockIn,
        clockOutAt: new Date('2026-07-10T17:00:00.000Z'),
        payrollPeriodId: values.openPeriodId,
        workTimeZone: 'UTC',
        revision: 1,
        breakMinutes: 0,
        status: 'CLOSED',
      },
    });
  });
  return owner.timeCard.findUniqueOrThrow({ where: { id: values.correctionCardId } });
}

async function cleanup(owner, tenantIds) {
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    for (const table of [
      'PayrollExportLine', 'PayrollExportBatch', 'PayrollLockedEntry', 'TimeCardBreak',
      'TimeCard', 'PayrollPeriod', 'PayrollPolicyVersion', 'AuditLog', 'CreditTransaction',
      'TenantSetting', 'Location', 'User',
    ]) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, tenantIds);
    }
    await tx.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = ANY($1::text[])', tenantIds);
  });
}

function runtime(prisma) {
  const tenantDb = new TenantPrismaService(prisma);
  const metering = new MeteringService(tenantDb);
  const featureAccess = new FeatureAccessService(metering, tenantDb);
  return { tenantDb, featureAccess };
}

function managerRequest(values) {
  return {
    user: {
      tenantId: values.tenantId,
      sub: values.managerId,
      role: 'ADMIN',
      permissions: ['users:read', 'shifts:read'],
    },
  };
}

async function assertRaceState(owner, values, expected) {
  const [tenant, credits, batches, lines, audits, cards] = await Promise.all([
    owner.tenant.findUniqueOrThrow({ where: { id: values.tenantId }, select: { usageCredits: true } }),
    owner.creditTransaction.findMany({ where: { tenantId: values.tenantId }, orderBy: { id: 'asc' } }),
    owner.payrollExportBatch.count({ where: { tenantId: values.tenantId } }),
    owner.payrollExportLine.count({ where: { tenantId: values.tenantId } }),
    owner.auditLog.findMany({ where: { tenantId: values.tenantId }, select: { action: true } }),
    owner.timeCard.count({ where: { tenantId: values.tenantId } }),
  ]);
  assert.equal(tenant.usageCredits, expected.balance);
  assert.equal(credits.length, expected.chargeCount);
  assert.equal(credits.reduce((sum, row) => sum + row.amount, 0), -expected.chargeCount);
  assert.equal(new Set(credits.map((row) => row.id)).size, expected.chargeCount);
  assert.equal(batches, 1);
  assert.equal(lines, 1);
  assert.equal(cards, expected.cardCount);
  for (const action of expected.auditActions) {
    assert.equal(audits.filter((audit) => audit.action === action).length, 1, `${action} must commit once`);
  }
}

test('Tenant-first payroll hierarchy serializes clock-in/export and correction/export without deadlock or partial settlement', {
  timeout: 60_000,
}, async () => {
  const baseUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const clockValues = fixture('clock-export-race');
  const correctionValues = fixture('correction-export-race');
  const owner = createPrisma(namedDatabaseUrl(baseUrl, `lock-order-owner-${process.pid}`));
  const observer = createPrisma(namedDatabaseUrl(baseUrl, `lock-order-observer-${process.pid}`));
  const barrierPrisma = createPrisma(namedDatabaseUrl(baseUrl, `lock-order-barrier-${process.pid}`));
  const mutationName = `time-card-mutation-${process.pid}`;
  const exportName = `payroll-export-${process.pid}`;
  const mutationPrisma = createPrisma(namedDatabaseUrl(baseUrl, mutationName));
  const exportPrisma = createPrisma(namedDatabaseUrl(baseUrl, exportName));
  let release;
  try {
    const [, correctionCard] = await Promise.all([
      createFixture(owner, clockValues),
      createFixture(owner, correctionValues),
    ]);
    const mutationRuntime = runtime(mutationPrisma);
    const exportRuntime = runtime(exportPrisma);
    const timeCards = new TimeCardsController(mutationRuntime.featureAccess, mutationRuntime.tenantDb);
    const exports = new PayrollExportService(exportRuntime.tenantDb, exportRuntime.featureAccess);

    let ready = deferred();
    release = deferred();
    let barrier = holdTableBarrier(barrierPrisma, 'User', ready, release);
    await ready.promise;
    const clockIn = timeCards.clockIn(
      { userId: clockValues.employeeId, locationId: clockValues.locationId },
      managerRequest(clockValues),
      `clock-in-${clockValues.suffix}`,
    );
    await waitForLockWait(observer, mutationName, 'clock-in');
    const clockExport = exports.create(
      { tenantId: clockValues.tenantId, userId: clockValues.managerId },
      clockValues.lockedPeriodId,
      { expectedCreditCost: 1 },
      `export-${clockValues.suffix}`,
    );
    await waitForLockWait(observer, exportName, 'clock-in race export');
    release.resolve();
    const clockResults = await bounded(
      Promise.all([clockIn, clockExport, barrier]),
      15_000,
      'clock-in/export race',
    );
    assert.doesNotMatch(JSON.stringify(clockResults), /40P01|deadlock detected/i);
    await assertRaceState(owner, clockValues, {
      balance: 3,
      chargeCount: 2,
      cardCount: 2,
      auditActions: ['TIME_CARD_CLOCKED_IN', 'PAYROLL_EXPORT_GENERATED'],
    });

    ready = deferred();
    release = deferred();
    barrier = holdTableBarrier(barrierPrisma, 'TimeCard', ready, release);
    await ready.promise;
    const correction = timeCards.correct(correctionValues.correctionCardId, {
      clockOutAt: '2026-07-10T18:00:00.000Z',
      expectedUpdatedAt: correctionCard.updatedAt.toISOString(),
      reason: 'Barrier-controlled payroll correction race.',
    }, managerRequest(correctionValues));
    await waitForLockWait(observer, mutationName, 'time-card correction');
    const correctionExport = exports.create(
      { tenantId: correctionValues.tenantId, userId: correctionValues.managerId },
      correctionValues.lockedPeriodId,
      { expectedCreditCost: 1 },
      `export-${correctionValues.suffix}`,
    );
    await waitForLockWait(observer, exportName, 'correction race export');
    release.resolve();
    const correctionResults = await bounded(
      Promise.all([correction, correctionExport, barrier]),
      15_000,
      'correction/export race',
    );
    assert.doesNotMatch(JSON.stringify(correctionResults), /40P01|deadlock detected/i);
    await assertRaceState(owner, correctionValues, {
      balance: 4,
      chargeCount: 1,
      cardCount: 1,
      auditActions: ['TIME_CARD_CORRECTED', 'PAYROLL_EXPORT_GENERATED'],
    });
    const corrected = await owner.timeCard.findUniqueOrThrow({ where: { id: correctionValues.correctionCardId } });
    assert.equal(corrected.revision, 2);
    assert.equal(corrected.clockOutAt.toISOString(), '2026-07-10T18:00:00.000Z');
  } finally {
    release?.resolve();
    await cleanup(owner, [clockValues.tenantId, correctionValues.tenantId]).catch(() => undefined);
    await Promise.allSettled([
      owner.$disconnect(), observer.$disconnect(), barrierPrisma.$disconnect(),
      mutationPrisma.$disconnect(), exportPrisma.$disconnect(),
    ]);
  }
});
