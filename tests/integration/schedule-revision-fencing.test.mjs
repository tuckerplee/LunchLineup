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

const { ConflictException, NotFoundException } = require('@nestjs/common');
const { FeatureAccessService } = require('../../apps/api/src/billing/feature-access.service.ts');
const { MeteringService } = require('../../apps/api/src/billing/metering.service.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');
const { LunchBreaksController } = require('../../apps/api/src/lunch-breaks/lunch-breaks.controller.ts');
const { LunchBreaksService } = require('../../apps/api/src/lunch-breaks/lunch-breaks.service.ts');
const { SchedulesController } = require('../../apps/api/src/schedules/schedules.controller.ts');
const { ShiftsController } = require('../../apps/api/src/shifts/shifts.controller.ts');

test('real PostgreSQL revisions fence stale publish across every scheduled-shift mutation path', { timeout: 60_000 }, async (t) => {
  const appPrisma = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const ownerPrisma = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `tenant-schedule-revision-${runId}`,
    managerId: `manager-schedule-revision-${runId}`,
    staffId: `staff-schedule-revision-${runId}`,
    locationId: `location-schedule-revision-${runId}`,
    schedules: Object.fromEntries(
      ['create', 'update', 'delete', 'bulk', 'setup', 'manual']
        .map((name) => [name, `schedule-${name}-${runId}`]),
    ),
    shifts: Object.fromEntries(
      ['update', 'delete', 'deleteKeep', 'bulk', 'setup', 'manual']
        .map((name) => [name, `shift-${name}-${runId}`]),
    ),
  };
  const request = {
    user: {
      tenantId: fixture.tenantId,
      sub: fixture.managerId,
      role: 'MANAGER',
    },
  };

  try {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.tenant.create({
        data: {
          id: fixture.tenantId,
          name: 'Schedule Revision Fencing',
          slug: `schedule-revision-${runId}`,
          planTier: 'GROWTH',
          status: 'ACTIVE',
          stripeSubscriptionId: `sub_schedule_revision_${runId}`,
          stripeSubscriptionCurrentPeriodEnd: new Date(Date.now() + 86_400_000),
          usageCredits: 20,
        },
      });
      await tx.location.create({
        data: {
          id: fixture.locationId,
          tenantId: fixture.tenantId,
          name: 'Schedule Revision Location',
          timezone: 'UTC',
        },
      });
      await tx.user.createMany({
        data: [
          {
            id: fixture.managerId,
            tenantId: fixture.tenantId,
            name: 'Schedule Revision Manager',
            role: 'MANAGER',
            mfaBackupCodes: [],
          },
          {
            id: fixture.staffId,
            tenantId: fixture.tenantId,
            name: 'Schedule Revision Staff',
            role: 'STAFF',
            mfaBackupCodes: [],
          },
        ],
      });
      await tx.schedule.createMany({
        data: Object.entries(fixture.schedules).map(([name, id], index) => ({
          id,
          tenantId: fixture.tenantId,
          locationId: fixture.locationId,
          startDate: new Date(`2026-09-0${index + 1}T00:00:00.000Z`),
          endDate: new Date(`2026-09-0${index + 2}T00:00:00.000Z`),
          status: 'DRAFT',
          revision: 0,
        })),
      });
      await tx.shift.createMany({
        data: [
          ['update', '2026-09-02T09:00:00.000Z', '2026-09-02T13:00:00.000Z', null],
          ['delete', '2026-09-03T09:00:00.000Z', '2026-09-03T13:00:00.000Z', null],
          ['deleteKeep', '2026-09-03T14:00:00.000Z', '2026-09-03T18:00:00.000Z', null],
          ['bulk', '2026-09-04T09:00:00.000Z', '2026-09-04T13:00:00.000Z', fixture.staffId],
          ['setup', '2026-09-05T09:00:00.000Z', '2026-09-05T13:00:00.000Z', null],
          ['manual', '2026-09-06T09:00:00.000Z', '2026-09-06T13:00:00.000Z', null],
        ].map(([name, startTime, endTime, userId]) => ({
          id: fixture.shifts[name],
          tenantId: fixture.tenantId,
          locationId: fixture.locationId,
          scheduleId: fixture.schedules[name === 'deleteKeep' ? 'delete' : name],
          userId,
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          role: 'STAFF',
        })),
      });
    });

    const tenantDb = new TenantPrismaService(appPrisma);
    const featureAccess = new FeatureAccessService(new MeteringService(tenantDb), tenantDb);
    const shifts = new ShiftsController(featureAccess, tenantDb);
    const lunch = new LunchBreaksController(new LunchBreaksService(featureAccess, tenantDb));
    const notifications = {
      enqueueInTransaction: async () => undefined,
      deliverPendingNow: async () => ({ delivered: 0, failed: 0, pending: 0 }),
    };
    const webhooks = {
      enqueueEventInTransaction: async () => {
        throw new Error('stale publish reached webhook enqueue');
      },
    };
    const schedules = new SchedulesController(
      notifications,
      featureAccess,
      tenantDb,
      new MeteringService(tenantDb),
      webhooks,
    );

    async function revision(scheduleId) {
      return (await ownerPrisma.schedule.findUniqueOrThrow({
        where: { id: scheduleId },
        select: { revision: true },
      })).revision;
    }

    async function assertStalePublishFenced(name, mutate, replayOrNoOp, expectedLedgerDelta, verifyDomain) {
      const scheduleId = fixture.schedules[name];
      const before = await Promise.all([
        schedules.publishPreflight(scheduleId, request),
        ownerPrisma.tenant.findUniqueOrThrow({
          where: { id: fixture.tenantId },
          select: { usageCredits: true },
        }),
        ownerPrisma.creditTransaction.count({ where: { tenantId: fixture.tenantId } }),
        revision(scheduleId),
      ]);
      const [preflight, tenantBefore, ledgerBefore, revisionBefore] = before;

      await mutate();
      const revisionAfterMutation = await revision(scheduleId);
      assert.equal(revisionAfterMutation, revisionBefore + 1, `${name} must increment revision once`);
      await replayOrNoOp();
      assert.equal(await revision(scheduleId), revisionAfterMutation, `${name} replay/no-op must not increment revision`);
      await verifyDomain();

      const ledgerAfterMutation = await ownerPrisma.creditTransaction.count({
        where: { tenantId: fixture.tenantId },
      });
      assert.equal(ledgerAfterMutation, ledgerBefore + expectedLedgerDelta);
      await assert.rejects(
        schedules.publish(
          scheduleId,
          request,
          `stale-publish-${name}-${runId}`,
          { acceptedContract: preflight.acceptedContract },
        ),
        (error) => {
          assert.ok(error instanceof ConflictException);
          assert.equal(error.getStatus(), 409);
          return true;
        },
      );

      const [scheduleAfter, tenantAfter, ledgerAfterPublish, publishAudits, notificationOutbox, webhookDeliveries] = await Promise.all([
        ownerPrisma.schedule.findUniqueOrThrow({
          where: { id: scheduleId },
          select: { status: true, revision: true },
        }),
        ownerPrisma.tenant.findUniqueOrThrow({
          where: { id: fixture.tenantId },
          select: { usageCredits: true },
        }),
        ownerPrisma.creditTransaction.count({ where: { tenantId: fixture.tenantId } }),
        ownerPrisma.auditLog.count({
          where: {
            tenantId: fixture.tenantId,
            action: 'SCHEDULE_PUBLISHED',
            resourceId: { not: null },
          },
        }),
        ownerPrisma.notificationOutbox.count({ where: { tenantId: fixture.tenantId } }),
        ownerPrisma.webhookDelivery.count({ where: { tenantId: fixture.tenantId } }),
      ]);
      assert.deepEqual(scheduleAfter, { status: 'DRAFT', revision: revisionAfterMutation });
      assert.equal(tenantAfter.usageCredits, tenantBefore.usageCredits - expectedLedgerDelta);
      assert.equal(ledgerAfterPublish, ledgerAfterMutation);
      assert.equal(publishAudits, 0);
      assert.equal(notificationOutbox, 0);
      assert.equal(webhookDeliveries, 0);
    }

    await t.test('create increments once and exact replay stays silent', async () => {
      const body = {
        locationId: fixture.locationId,
        scheduleId: fixture.schedules.create,
        startTime: '2026-09-01T09:00:00.000Z',
        endTime: '2026-09-01T13:00:00.000Z',
      };
      let response;
      await assertStalePublishFenced(
        'create',
        async () => { response = await shifts.create(body, request, `revision-create-${runId}`); },
        async () => assert.deepEqual(await shifts.create(body, request, `revision-create-${runId}`), response),
        1,
        async () => assert.equal(await ownerPrisma.shift.count({
          where: { id: response.id, scheduleId: fixture.schedules.create, deletedAt: null },
        }), 1),
      );
    });

    await t.test('update increments once and exact replay stays silent', async () => {
      const body = { role: 'LEAD' };
      let response;
      await assertStalePublishFenced(
        'update',
        async () => { response = await shifts.update(fixture.shifts.update, body, request, `revision-update-${runId}`); },
        async () => assert.deepEqual(await shifts.update(fixture.shifts.update, body, request, `revision-update-${runId}`), response),
        1,
        async () => assert.equal((await ownerPrisma.shift.findUniqueOrThrow({
          where: { id: fixture.shifts.update },
          select: { role: true },
        })).role, 'LEAD'),
      );
    });

    await t.test('delete increments once and repeated delete stays silent', async () => {
      const creditsBefore = (await ownerPrisma.tenant.findUniqueOrThrow({
        where: { id: fixture.tenantId },
        select: { usageCredits: true },
      })).usageCredits;
      await ownerPrisma.tenant.update({
        where: { id: fixture.tenantId },
        data: { usageCredits: 0 },
      });
      try {
        await assertStalePublishFenced(
          'delete',
          async () => shifts.remove(fixture.shifts.delete, request),
          async () => assert.rejects(
            shifts.remove(fixture.shifts.delete, request),
            (error) => error instanceof NotFoundException && error.getStatus() === 404,
          ),
          0,
          async () => assert.ok((await ownerPrisma.shift.findUniqueOrThrow({
            where: { id: fixture.shifts.delete },
            select: { deletedAt: true },
          })).deletedAt),
        );
      } finally {
        await ownerPrisma.tenant.update({
          where: { id: fixture.tenantId },
          data: { usageCredits: creditsBefore },
        });
      }
    });

    await t.test('bulk reassign increments once and exact replay stays silent', async () => {
      const body = { assignments: [{ shiftId: fixture.shifts.bulk, userId: null }] };
      let response;
      await assertStalePublishFenced(
        'bulk',
        async () => { response = await shifts.bulkAssign(body, request, `revision-bulk-${runId}`); },
        async () => assert.deepEqual(await shifts.bulkAssign(body, request, `revision-bulk-${runId}`), response),
        1,
        async () => assert.equal((await ownerPrisma.shift.findUniqueOrThrow({
          where: { id: fixture.shifts.bulk },
          select: { userId: true },
        })).userId, null),
      );
    });

    await t.test('lunch setup update increments once and exact replay stays silent', async () => {
      const body = {
        locationId: fixture.locationId,
        rows: [{
          shiftId: fixture.shifts.setup,
          startTime: '2026-09-05T10:00:00.000Z',
          endTime: '2026-09-05T14:00:00.000Z',
        }],
      };
      let response;
      await assertStalePublishFenced(
        'setup',
        async () => { response = await lunch.persistSetupShifts(request, body, `revision-setup-${runId}`); },
        async () => assert.deepEqual(await lunch.persistSetupShifts(request, body, `revision-setup-${runId}`), response),
        1,
        async () => assert.equal((await ownerPrisma.shift.findUniqueOrThrow({
          where: { id: fixture.shifts.setup },
          select: { startTime: true },
        })).startTime.toISOString(), body.rows[0].startTime),
      );
    });

    await t.test('manual lunch replacement increments once and exact replay stays silent', async () => {
      const body = {
        locationId: fixture.locationId,
        breaks: [{
          type: 'lunch',
          startTime: '2026-09-06T11:00:00.000Z',
          durationMinutes: 30,
        }],
      };
      let response;
      await assertStalePublishFenced(
        'manual',
        async () => { response = await lunch.updateShiftBreaks(request, fixture.shifts.manual, body, `revision-manual-${runId}`); },
        async () => assert.deepEqual(await lunch.updateShiftBreaks(request, fixture.shifts.manual, body, `revision-manual-${runId}`), response),
        1,
        async () => assert.equal(await ownerPrisma.break.count({
          where: { shiftId: fixture.shifts.manual, type: 'LUNCH' },
        }), 1),
      );
    });

    const [tenant, debits] = await Promise.all([
      ownerPrisma.tenant.findUniqueOrThrow({
        where: { id: fixture.tenantId },
        select: { status: true, stripeSubscriptionId: true, usageCredits: true },
      }),
      ownerPrisma.creditTransaction.findMany({
        where: { tenantId: fixture.tenantId },
        select: { amount: true, reason: true },
      }),
    ]);
    assert.deepEqual(tenant, {
      status: 'ACTIVE',
      stripeSubscriptionId: `sub_schedule_revision_${runId}`,
      usageCredits: 15,
    });
    assert.equal(debits.length, 5);
    assert.equal(debits.every(({ amount }) => amount === -1), true);
    assert.equal(new Set(debits.map(({ reason }) => reason)).size, 5);
  } finally {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.notificationOutbox.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.webhookDelivery.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.auditLog.deleteMany({ where: { tenantId: fixture.tenantId } });
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
