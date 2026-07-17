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
const { SchedulesController } = require('../../apps/api/src/schedules/schedules.controller.ts');

function bounded(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function createController(prisma) {
  const tenantDb = new TenantPrismaService(prisma);
  const metering = new MeteringService(tenantDb);
  const controller = new SchedulesController(
    { deliverPendingNow: async () => ({}) },
    new FeatureAccessService(metering, tenantDb),
    tenantDb,
    metering,
  );
  controller.scheduleOutbox.publishPendingNow = async () => false;
  return controller;
}

test('same-key PostgreSQL race reserves one solve job and one immutable post-debit balance', {
  timeout: 30_000,
}, async () => {
  const databaseUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  const firstPrisma = createPrisma(databaseUrl);
  const secondPrisma = createPrisma(databaseUrl);
  const runId = randomUUID();
  const fixture = {
    tenantId: `tenant-solve-race-${runId}`,
    tenantSlug: `solve-race-${runId}`,
    locationId: `location-solve-race-${runId}`,
    staffId: `staff-solve-race-${runId}`,
    scheduleId: `schedule-solve-race-${runId}`,
  };
  const request = { user: { tenantId: fixture.tenantId } };
  const idempotencyKey = `same-solve-${runId}`;

  try {
    await firstPrisma.$transaction(async (tx) => {
      await tx.tenant.create({
        data: {
          id: fixture.tenantId,
          name: 'Schedule Solve Race',
          slug: fixture.tenantSlug,
          planTier: 'GROWTH',
          status: 'ACTIVE',
          stripeSubscriptionId: `sub_solve_race_${runId}`,
          stripeSubscriptionCurrentPeriodEnd: new Date(Date.now() + 86_400_000),
          usageCredits: 2,
        },
      });
      await tx.location.create({
        data: {
          id: fixture.locationId,
          tenantId: fixture.tenantId,
          name: 'Schedule Solve Race Location',
          timezone: 'UTC',
        },
      });
      await tx.user.create({
        data: {
          id: fixture.staffId,
          tenantId: fixture.tenantId,
          name: 'Schedule Solve Race Staff',
          role: 'STAFF',
          mfaBackupCodes: [],
        },
      });
      await tx.staffAvailability.create({
        data: {
          id: `availability-${runId}`,
          tenantId: fixture.tenantId,
          userId: fixture.staffId,
          locationId: fixture.locationId,
          dayOfWeek: 1,
          startTimeMinutes: 480,
          endTimeMinutes: 1080,
        },
      });
      await tx.schedule.create({
        data: {
          id: fixture.scheduleId,
          tenantId: fixture.tenantId,
          locationId: fixture.locationId,
          startDate: new Date('2026-08-03T00:00:00.000Z'),
          endDate: new Date('2026-08-04T00:00:00.000Z'),
          status: 'DRAFT',
          revision: 0,
        },
      });
      await tx.scheduleDemandWindow.create({
        data: {
          id: `demand-${runId}`,
          tenantId: fixture.tenantId,
          scheduleId: fixture.scheduleId,
          locationId: fixture.locationId,
          startTime: new Date('2026-08-03T09:00:00.000Z'),
          endTime: new Date('2026-08-03T13:00:00.000Z'),
          requiredStaff: 1,
        },
      });
    });

    const firstController = createController(firstPrisma);
    const secondController = createController(secondPrisma);
    const responses = await bounded(Promise.all([
      firstController.autoSchedule(fixture.scheduleId, request, { constraints: {} }, idempotencyKey),
      secondController.autoSchedule(fixture.scheduleId, request, { constraints: {} }, idempotencyKey),
    ]), 10_000, 'same-key auto-schedule race did not serialize');

    assert.equal(responses[0].jobId, responses[1].jobId);
    assert.deepEqual(responses.map((response) => response.reused).sort(), [false, true]);
    const settlement = await firstPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_tenant(${fixture.tenantId})`;
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: fixture.tenantId },
        select: { usageCredits: true },
      });
      const jobs = await tx.$queryRaw`
        SELECT "id", "creditConsumption"
        FROM "ScheduleSolveJob"
        WHERE "tenantId" = ${fixture.tenantId}
          AND "scheduleId" = ${fixture.scheduleId}
        ORDER BY "id"
      `;
      const debits = await tx.$queryRaw`
        SELECT "id", "amount", "balanceAfter"
        FROM "CreditTransaction"
        WHERE "tenantId" = ${fixture.tenantId}
        ORDER BY "id"
      `;
      return { usageCredits: tenant.usageCredits, jobs, debits };
    });
    assert.equal(settlement.usageCredits, 1, 'the wallet must decrement exactly once');
    assert.equal(settlement.jobs.length, 1, 'the same key must own exactly one durable job');
    assert.deepEqual(settlement.jobs[0].creditConsumption, {
      consumedCredits: 1,
      newBalance: 1,
      source: 'credits',
    });
    assert.deepEqual(settlement.debits, [{
      id: `schedule-credit-${responses[0].jobId}`,
      amount: -1,
      balanceAfter: 1,
    }]);

    const replayResponses = await bounded(Promise.all([
      firstController.autoSchedule(fixture.scheduleId, request, { constraints: {} }, idempotencyKey),
      secondController.autoSchedule(fixture.scheduleId, request, { constraints: {} }, idempotencyKey),
    ]), 10_000, 'same-key settlement replay did not serialize');
    assert.ok(replayResponses.every((response) => response.jobId === responses[0].jobId && response.reused));
    const replaySettlement = await firstPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_tenant(${fixture.tenantId})`;
      return {
        usageCredits: (await tx.tenant.findUniqueOrThrow({
          where: { id: fixture.tenantId },
          select: { usageCredits: true },
        })).usageCredits,
        jobs: await tx.$queryRaw`
          SELECT "id", "creditConsumption"
          FROM "ScheduleSolveJob"
          WHERE "tenantId" = ${fixture.tenantId}
            AND "scheduleId" = ${fixture.scheduleId}
          ORDER BY "id"
        `,
        debits: await tx.$queryRaw`
          SELECT "id", "amount", "balanceAfter"
          FROM "CreditTransaction"
          WHERE "tenantId" = ${fixture.tenantId}
          ORDER BY "id"
        `,
      };
    });
    assert.deepEqual(replaySettlement, settlement, 'deterministic replay must preserve immutable balances');
  } finally {
    await firstPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "ScheduleSolveJob" WHERE "tenantId" = ${fixture.tenantId}`;
      await tx.$executeRaw`DELETE FROM "CreditTransaction" WHERE "tenantId" = ${fixture.tenantId}`;
      await tx.$executeRaw`DELETE FROM "ScheduleDemandWindow" WHERE "tenantId" = ${fixture.tenantId}`;
      await tx.$executeRaw`DELETE FROM "Schedule" WHERE "tenantId" = ${fixture.tenantId}`;
      await tx.$executeRaw`DELETE FROM "StaffAvailability" WHERE "tenantId" = ${fixture.tenantId}`;
      await tx.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${fixture.tenantId}`;
      await tx.$executeRaw`DELETE FROM "Location" WHERE "tenantId" = ${fixture.tenantId}`;
      await tx.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${fixture.tenantId}`;
    }).catch(() => undefined);
    await Promise.allSettled([firstPrisma.$disconnect(), secondPrisma.$disconnect()]);
  }
});
