import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
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
const { LunchBreaksController } = require('../../apps/api/src/lunch-breaks/lunch-breaks.controller.ts');
const { LunchBreaksService } = require('../../apps/api/src/lunch-breaks/lunch-breaks.service.ts');
const { ShiftsController } = require('../../apps/api/src/shifts/shifts.controller.ts');

function createTwoPartyBarrier(timeoutMs = 5_000) {
  let arrivals = 0;
  let release;
  let reject;
  const gate = new Promise((resolveGate, rejectGate) => {
    release = resolveGate;
    reject = rejectGate;
  });
  const timer = setTimeout(() => reject(new Error('Timed out waiting for both Tenant-lock contenders.')), timeoutMs);
  return {
    async arrive() {
      arrivals += 1;
      if (arrivals === 2) {
        clearTimeout(timer);
        release();
      }
      await gate;
    },
    get arrivals() {
      return arrivals;
    },
  };
}

function installFirstTenantLockBarrier(featureAccess, barrier) {
  const lockTenant = featureAccess.lockTenantInTransaction.bind(featureAccess);
  let firstLock = true;
  featureAccess.lockTenantInTransaction = async (...args) => {
    if (firstLock) {
      firstLock = false;
      await barrier.arrive();
    }
    return lockTenant(...args);
  };
}

function transactionCode(error) {
  return error?.code
    ?? error?.meta?.code
    ?? error?.cause?.code
    ?? error?.cause?.meta?.code
    ?? null;
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('real PostgreSQL semantically deduplicates concurrent unassigned setup under different keys', { timeout: 30_000 }, async () => {
  const appPrisma = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const ownerPrisma = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `tenant-lunch-setup-${runId}`,
    managerId: `manager-lunch-setup-${runId}`,
    locationId: `location-lunch-setup-${runId}`,
  };

  try {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.tenant.create({
        data: {
          id: fixture.tenantId,
          name: 'Lunch Setup Idempotency',
          slug: `lunch-setup-${runId}`,
          planTier: 'STARTER',
          status: 'ACTIVE',
          stripeSubscriptionId: `sub_lunch_setup_${runId}`,
          stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
          usageCredits: 5,
        },
      });
      await tx.location.create({
        data: {
          id: fixture.locationId,
          tenantId: fixture.tenantId,
          name: 'Lunch Setup Location',
          timezone: 'UTC',
        },
      });
      await tx.user.create({
        data: {
          id: fixture.managerId,
          tenantId: fixture.tenantId,
          name: 'Lunch Setup Manager',
          role: 'MANAGER',
          mfaBackupCodes: [],
        },
      });
    });

    const tenantDb = new TenantPrismaService(appPrisma);
    const metering = new MeteringService(tenantDb);
    const featureAccess = new FeatureAccessService(metering, tenantDb);
    const controller = new LunchBreaksController(new LunchBreaksService(featureAccess, tenantDb));
    const request = {
      user: {
        tenantId: fixture.tenantId,
        sub: fixture.managerId,
        role: 'MANAGER',
      },
    };
    const omittedUserBody = {
      locationId: fixture.locationId,
      rows: [{
        startTime: '2026-08-20T09:00:00.000Z',
        endTime: '2026-08-20T17:00:00.000Z',
      }],
    };
    const explicitNullBody = {
      ...omittedUserBody,
      rows: [{ ...omittedUserBody.rows[0], userId: null }],
    };

    const concurrent = await Promise.all([
      controller.persistSetupShifts(request, omittedUserBody, `setup-tab-a-${runId}`),
      controller.persistSetupShifts(request, explicitNullBody, `setup-tab-b-${runId}`),
    ]);
    const storageLossReplay = await controller.persistSetupShifts(
      request,
      omittedUserBody,
      `setup-storage-loss-${runId}`,
    );

    assert.deepEqual(concurrent[1], concurrent[0]);
    assert.deepEqual(storageLossReplay, concurrent[0]);
    assert.equal(concurrent[0].shiftIds.length, 1);

    const [tenant, shifts, ledger, exactAudits, semanticAudits] = await Promise.all([
      ownerPrisma.tenant.findUniqueOrThrow({
        where: { id: fixture.tenantId },
        select: { usageCredits: true },
      }),
      ownerPrisma.shift.findMany({
        where: {
          tenantId: fixture.tenantId,
          locationId: fixture.locationId,
          scheduleId: null,
          userId: null,
          startTime: new Date(omittedUserBody.rows[0].startTime),
          endTime: new Date(omittedUserBody.rows[0].endTime),
          deletedAt: null,
        },
        select: { id: true },
      }),
      ownerPrisma.creditTransaction.findMany({
        where: { tenantId: fixture.tenantId },
        select: { amount: true },
      }),
      ownerPrisma.auditLog.count({
        where: {
          tenantId: fixture.tenantId,
          action: 'LUNCH_BREAK_SETUP_SHIFTS_PERSISTED',
          resource: 'LunchBreakSetupShiftsRequest',
        },
      }),
      ownerPrisma.auditLog.count({
        where: {
          tenantId: fixture.tenantId,
          action: 'LUNCH_BREAK_SETUP_SHIFTS_PERSISTED',
          resource: 'LunchBreakSetupShiftsSemanticRequest',
        },
      }),
    ]);

    assert.deepEqual(shifts, [{ id: concurrent[0].shiftIds[0] }]);
    assert.equal(tenant.usageCredits, 4);
    assert.deepEqual(ledger, [{ amount: -1 }]);
    assert.equal(exactAudits, 1);
    assert.equal(semanticAudits, 1);
  } finally {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.auditLog.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.creditTransaction.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.break.deleteMany({ where: { shift: { tenantId: fixture.tenantId } } });
      await tx.shift.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.location.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.user.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.tenant.deleteMany({ where: { id: fixture.tenantId } });
    }).catch(() => {});
    await Promise.allSettled([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});

test('real PostgreSQL serializes setup and normal shift writes in Tenant-then-advisory order', { timeout: 45_000 }, async () => {
  const setupPrisma = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const shiftPrisma = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const ownerPrisma = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `tenant-lunch-lock-order-${runId}`,
    managerId: `manager-lunch-lock-order-${runId}`,
    staffId: `staff-lunch-lock-order-${runId}`,
    locationId: `location-lunch-lock-order-${runId}`,
  };

  try {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.tenant.create({
        data: {
          id: fixture.tenantId,
          name: 'Lunch Lock Order',
          slug: `lunch-lock-order-${runId}`,
          planTier: 'STARTER',
          status: 'ACTIVE',
          stripeSubscriptionId: `sub_lunch_lock_order_${runId}`,
          stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
          usageCredits: 5,
        },
      });
      await tx.location.create({
        data: {
          id: fixture.locationId,
          tenantId: fixture.tenantId,
          name: 'Lunch Lock Order Location',
          timezone: 'UTC',
        },
      });
      await tx.user.createMany({
        data: [
          {
            id: fixture.managerId,
            tenantId: fixture.tenantId,
            name: 'Lunch Lock Order Manager',
            role: 'MANAGER',
            mfaBackupCodes: [],
          },
          {
            id: fixture.staffId,
            tenantId: fixture.tenantId,
            name: 'Lunch Lock Order Staff',
            role: 'STAFF',
            mfaBackupCodes: [],
          },
        ],
      });
    });

    const setupTenantDb = new TenantPrismaService(setupPrisma);
    const setupFeatureAccess = new FeatureAccessService(new MeteringService(setupTenantDb), setupTenantDb);
    const lunchController = new LunchBreaksController(new LunchBreaksService(setupFeatureAccess, setupTenantDb));
    const shiftTenantDb = new TenantPrismaService(shiftPrisma);
    const shiftFeatureAccess = new FeatureAccessService(new MeteringService(shiftTenantDb), shiftTenantDb);
    const shiftsController = new ShiftsController(shiftFeatureAccess, shiftTenantDb);
    const tenantLockBarrier = createTwoPartyBarrier();
    installFirstTenantLockBarrier(setupFeatureAccess, tenantLockBarrier);
    installFirstTenantLockBarrier(shiftFeatureAccess, tenantLockBarrier);
    const request = {
      user: {
        tenantId: fixture.tenantId,
        sub: fixture.managerId,
        role: 'MANAGER',
      },
    };

    const outcomes = await bounded(Promise.allSettled([
      lunchController.persistSetupShifts(request, {
        locationId: fixture.locationId,
        rows: [{
          userId: fixture.staffId,
          startTime: '2026-08-21T09:00:00.000Z',
          endTime: '2026-08-21T17:00:00.000Z',
        }],
      }, `setup-lock-order-${runId}`),
      shiftsController.create({
        locationId: fixture.locationId,
        userId: fixture.staffId,
        startTime: '2026-08-21T18:00:00.000Z',
        endTime: '2026-08-21T20:00:00.000Z',
      }, request, `shift-lock-order-${runId}`),
    ]), 20_000, 'setup/normal-shift lock race');

    assert.equal(tenantLockBarrier.arrivals, 2);
    assert.equal(
      outcomes.some((outcome) => outcome.status === 'rejected' && ['40P01', 'P2034'].includes(transactionCode(outcome.reason))),
      false,
      'the canonical lock race must expose neither PostgreSQL deadlock nor Prisma write-conflict codes',
    );
    assert.equal(
      outcomes.every((outcome) => outcome.status === 'fulfilled'),
      true,
      outcomes.map((outcome) => outcome.status === 'fulfilled'
        ? 'fulfilled'
        : `${transactionCode(outcome.reason) ?? 'unknown'}:${outcome.reason?.message ?? outcome.reason}`).join(', '),
    );

    const [tenant, shifts, ledger, audits] = await Promise.all([
      ownerPrisma.tenant.findUniqueOrThrow({
        where: { id: fixture.tenantId },
        select: { status: true, stripeSubscriptionId: true, usageCredits: true },
      }),
      ownerPrisma.shift.findMany({
        where: { tenantId: fixture.tenantId, locationId: fixture.locationId, deletedAt: null },
        select: { startTime: true, endTime: true },
        orderBy: { startTime: 'asc' },
      }),
      ownerPrisma.creditTransaction.findMany({
        where: { tenantId: fixture.tenantId },
        select: { amount: true, reason: true },
        orderBy: { reason: 'asc' },
      }),
      ownerPrisma.auditLog.findMany({
        where: {
          tenantId: fixture.tenantId,
          action: { in: ['LUNCH_BREAK_SETUP_SHIFTS_PERSISTED', 'SHIFT_CREATED'] },
        },
        select: { action: true, resource: true },
        orderBy: { action: 'asc' },
      }),
    ]);

    assert.deepEqual(tenant, {
      status: 'ACTIVE',
      stripeSubscriptionId: `sub_lunch_lock_order_${runId}`,
      usageCredits: 3,
    });
    assert.deepEqual(shifts, [
      {
        startTime: new Date('2026-08-21T09:00:00.000Z'),
        endTime: new Date('2026-08-21T17:00:00.000Z'),
      },
      {
        startTime: new Date('2026-08-21T18:00:00.000Z'),
        endTime: new Date('2026-08-21T20:00:00.000Z'),
      },
    ]);
    assert.deepEqual(ledger.map(({ amount }) => amount), [-1, -1]);
    assert.equal(ledger.filter(({ reason }) => reason.startsWith('Lunch/break setup shift persistence')).length, 1);
    assert.equal(ledger.filter(({ reason }) => reason.startsWith('Manual shift creation')).length, 1);
    assert.deepEqual(audits, [
      { action: 'LUNCH_BREAK_SETUP_SHIFTS_PERSISTED', resource: 'LunchBreakSetupShiftsRequest' },
      { action: 'SHIFT_CREATED', resource: 'ShiftCreationRequest' },
    ]);
  } finally {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.auditLog.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.creditTransaction.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.break.deleteMany({ where: { shift: { tenantId: fixture.tenantId } } });
      await tx.shift.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.schedule.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.location.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.user.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.tenant.deleteMany({ where: { id: fixture.tenantId } });
    }).catch(() => {});
    await Promise.allSettled([
      setupPrisma.$disconnect(),
      shiftPrisma.$disconnect(),
      ownerPrisma.$disconnect(),
    ]);
  }
});
