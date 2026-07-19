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

const { ConflictException, ForbiddenException } = require('@nestjs/common');
const { FeatureAccessService } = require('../../apps/api/src/billing/feature-access.service.ts');
const { MeteringService } = require('../../apps/api/src/billing/metering.service.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');
const { LunchBreaksService } = require('../../apps/api/src/lunch-breaks/lunch-breaks.service.ts');

const explicitIntent = {
  shifts: [{
    startTime: '2026-09-10T09:00:00.000Z',
    endTime: '2026-09-10T17:00:00.000Z',
    employeeName: 'Recovery Staff',
  }],
};

test('real PostgreSQL reclaims only recoverable FAILED generation intents with one committed debit', { timeout: 45_000 }, async (t) => {
  const appPrisma = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const ownerPrisma = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `tenant-generation-recovery-${runId}`,
    managerId: `manager-generation-recovery-${runId}`,
    locationId: `location-generation-recovery-${runId}`,
    scheduleId: `schedule-generation-recovery-${runId}`,
    shiftId: `shift-generation-recovery-${runId}`,
  };

  try {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.tenant.create({
        data: {
          id: fixture.tenantId,
          name: 'Generation Recovery',
          slug: `generation-recovery-${runId}`,
          planTier: 'GROWTH',
          status: 'PAST_DUE',
          stripeSubscriptionId: `sub_generation_recovery_${runId}`,
          stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
          usageCredits: 5,
        },
      });
      await tx.location.create({
        data: {
          id: fixture.locationId,
          tenantId: fixture.tenantId,
          name: 'Generation Recovery Location',
          timezone: 'UTC',
        },
      });
      await tx.user.create({
        data: {
          id: fixture.managerId,
          tenantId: fixture.tenantId,
          name: 'Generation Recovery Manager',
          role: 'MANAGER',
          mfaBackupCodes: [],
        },
      });
      await tx.schedule.create({
        data: {
          id: fixture.scheduleId,
          tenantId: fixture.tenantId,
          locationId: fixture.locationId,
          startDate: new Date('2026-09-11T00:00:00.000Z'),
          endDate: new Date('2026-09-12T00:00:00.000Z'),
          status: 'DRAFT',
        },
      });
      await tx.shift.create({
        data: {
          id: fixture.shiftId,
          tenantId: fixture.tenantId,
          locationId: fixture.locationId,
          scheduleId: fixture.scheduleId,
          userId: null,
          startTime: new Date('2026-09-11T09:00:00.000Z'),
          endTime: new Date('2026-09-11T17:00:00.000Z'),
          role: 'STAFF',
        },
      });
    });

    const tenantDb = new TenantPrismaService(appPrisma);
    const featureAccess = new FeatureAccessService(new MeteringService(tenantDb), tenantDb);
    const service = new LunchBreaksService(featureAccess, tenantDb);

    await t.test('unchanged intent succeeds after paid subscription restoration', async () => {
      const key = `subscription-restored-${runId}`;
      await assert.rejects(
        service.generateLunchBreaks(fixture.tenantId, explicitIntent, key),
        (error) => error instanceof ForbiddenException && error.getStatus() === 403,
      );
      let request = await ownerPrisma.lunchBreakGenerationRequest.findFirstOrThrow({
        where: { tenantId: fixture.tenantId },
      });
      assert.equal(request.status, 'FAILED');
      assert.equal(request.failureStatus, 403);
      assert.equal(request.attempts, 1);
      assert.equal(await ownerPrisma.creditTransaction.count({ where: { tenantId: fixture.tenantId } }), 0);

      await ownerPrisma.tenant.update({
        where: { id: fixture.tenantId },
        data: { status: 'ACTIVE' },
      });
      const response = await service.generateLunchBreaks(fixture.tenantId, explicitIntent, key);
      request = await ownerPrisma.lunchBreakGenerationRequest.findUniqueOrThrow({ where: { id: request.id } });

      assert.equal(response.reused, false);
      assert.equal(request.status, 'SUCCEEDED');
      assert.equal(request.attempts, 2);
      assert.equal(request.failureStatus, null);
      assert.equal(await ownerPrisma.creditTransaction.count({
        where: { tenantId: fixture.tenantId, id: `lunch-break-credit-${request.id}` },
      }), 1);
    });

    await t.test('unchanged intent succeeds after separately purchased credits are restored', async () => {
      const key = `credits-restored-${runId}`;
      await ownerPrisma.tenant.update({
        where: { id: fixture.tenantId },
        data: { usageCredits: 0 },
      });
      const ledgerBeforeControls = await ownerPrisma.creditTransaction.count({
        where: { tenantId: fixture.tenantId },
      });
      await service.getPolicy(fixture.tenantId);
      await service.listLunchBreaks(fixture.tenantId, { locationId: fixture.locationId });
      await service.updatePolicy(fixture.tenantId, { lunchDurationMinutes: 35 });
      assert.equal(await ownerPrisma.creditTransaction.count({
        where: { tenantId: fixture.tenantId },
      }), ledgerBeforeControls);
      await assert.rejects(
        service.generateLunchBreaks(fixture.tenantId, explicitIntent, key),
        (error) => error instanceof ForbiddenException && error.getStatus() === 403,
      );
      let request = await ownerPrisma.lunchBreakGenerationRequest.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
      });
      assert.equal(request.failureStatus, 403);
      assert.equal(request.attempts, 1);

      await ownerPrisma.tenant.update({
        where: { id: fixture.tenantId },
        data: { usageCredits: 5 },
      });
      const response = await service.generateLunchBreaks(fixture.tenantId, explicitIntent, key);
      request = await ownerPrisma.lunchBreakGenerationRequest.findUniqueOrThrow({ where: { id: request.id } });

      assert.equal(response.reused, false);
      assert.equal(request.status, 'SUCCEEDED');
      assert.equal(request.attempts, 2);
      assert.equal(await ownerPrisma.creditTransaction.count({
        where: { tenantId: fixture.tenantId, id: `lunch-break-credit-${request.id}` },
      }), 1);
    });

    await t.test('rolled-back persistence failure retries with one domain replacement and debit', async () => {
      const key = `persistence-retry-${runId}`;
      const persistedIntent = {
        locationId: fixture.locationId,
        shiftIds: [fixture.shiftId],
        persist: true,
      };
      const persistGeneratedBreaks = service.persistGeneratedBreaks.bind(service);
      let failOnce = true;
      service.persistGeneratedBreaks = async (...args) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('forced rolled-back persistence failure');
        }
        return persistGeneratedBreaks(...args);
      };

      await assert.rejects(
        service.generateLunchBreaks(fixture.tenantId, persistedIntent, key),
        /forced rolled-back persistence failure/,
      );
      let request = await ownerPrisma.lunchBreakGenerationRequest.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
      });
      assert.equal(request.failureStatus, 503);
      assert.equal(request.attempts, 1);
      assert.equal(await ownerPrisma.creditTransaction.count({
        where: { tenantId: fixture.tenantId, id: `lunch-break-credit-${request.id}` },
      }), 0);
      assert.equal(await ownerPrisma.break.count({ where: { shiftId: fixture.shiftId } }), 0);
      assert.equal((await ownerPrisma.schedule.findUniqueOrThrow({
        where: { id: fixture.scheduleId },
        select: { revision: true },
      })).revision, 0);

      const response = await service.generateLunchBreaks(fixture.tenantId, persistedIntent, key);
      request = await ownerPrisma.lunchBreakGenerationRequest.findUniqueOrThrow({ where: { id: request.id } });
      assert.equal(response.persisted, true);
      assert.equal(response.reused, false);
      assert.equal(request.status, 'SUCCEEDED');
      assert.equal(request.attempts, 2);
      assert.equal(await ownerPrisma.creditTransaction.count({
        where: { tenantId: fixture.tenantId, id: `lunch-break-credit-${request.id}` },
      }), 1);
      assert.equal(await ownerPrisma.break.count({ where: { shiftId: fixture.shiftId } }), 3);
      assert.equal((await ownerPrisma.schedule.findUniqueOrThrow({
        where: { id: fixture.scheduleId },
        select: { revision: true },
      })).revision, 1);
    });

    await t.test('two callers cannot double-execute one reclaimed FAILED intent', async () => {
      const key = `two-caller-reclaim-${runId}`;
      await ownerPrisma.tenant.update({
        where: { id: fixture.tenantId },
        data: { usageCredits: 0 },
      });
      await assert.rejects(
        service.generateLunchBreaks(fixture.tenantId, explicitIntent, key),
        (error) => error instanceof ForbiddenException && error.getStatus() === 403,
      );
      const failed = await ownerPrisma.lunchBreakGenerationRequest.findFirstOrThrow({
        where: { tenantId: fixture.tenantId, status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
      });
      await ownerPrisma.tenant.update({
        where: { id: fixture.tenantId },
        data: { usageCredits: 5 },
      });

      let releasePolicy;
      let policyReached;
      const policyGate = new Promise((resolveGate) => { releasePolicy = resolveGate; });
      const reached = new Promise((resolveReached) => { policyReached = resolveReached; });
      const fetchPolicyForTenant = service.fetchPolicyForTenant.bind(service);
      let gateOnce = true;
      service.fetchPolicyForTenant = async (...args) => {
        if (gateOnce) {
          gateOnce = false;
          policyReached();
          await policyGate;
        }
        return fetchPolicyForTenant(...args);
      };

      const winner = service.generateLunchBreaks(fixture.tenantId, explicitIntent, key);
      await reached;
      await assert.rejects(
        service.generateLunchBreaks(fixture.tenantId, explicitIntent, key),
        (error) => error instanceof ConflictException && error.getStatus() === 409,
      );
      releasePolicy();
      const response = await winner;
      const request = await ownerPrisma.lunchBreakGenerationRequest.findUniqueOrThrow({ where: { id: failed.id } });

      assert.equal(response.reused, false);
      assert.equal(request.status, 'SUCCEEDED');
      assert.equal(request.attempts, 2);
      assert.equal(await ownerPrisma.creditTransaction.count({
        where: { tenantId: fixture.tenantId, id: `lunch-break-credit-${request.id}` },
      }), 1);
    });

    const tenant = await ownerPrisma.tenant.findUniqueOrThrow({
      where: { id: fixture.tenantId },
      select: { status: true, stripeSubscriptionId: true },
    });
    assert.deepEqual(tenant, {
      status: 'ACTIVE',
      stripeSubscriptionId: `sub_generation_recovery_${runId}`,
    });
  } finally {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.lunchBreakGenerationRequest.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.creditTransaction.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.break.deleteMany({ where: { shift: { tenantId: fixture.tenantId } } });
      await tx.shift.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.schedule.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.location.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.user.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.tenant.deleteMany({ where: { id: fixture.tenantId } });
    }).catch(() => {});
    await Promise.allSettled([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});
