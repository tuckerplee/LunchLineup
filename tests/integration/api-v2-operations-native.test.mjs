import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api-v2/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { LunchBreakService } = require('../../apps/api-v2/src/operations/lunch-breaks.service.ts');
const { OperationsService } = require('../../apps/api-v2/src/operations/operations.service.ts');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');

function identity(tenantId, userId, role) {
  return {
    sub: userId,
    publicUserId: randomUUID(),
    tenantId,
    sessionId: `operations-session-${randomUUID()}`,
    role,
    legacyRole: role,
    roles: [{ id: randomUUID(), name: role === 'STAFF' ? 'Staff' : 'Manager', isSystem: true, legacyRole: role }],
    permissions: [
      'schedules:read',
      'shifts:read',
      'shifts:write',
      'lunch_breaks:read',
      'lunch_breaks:write',
    ],
    mfaVerified: true,
    mfaRequired: false,
  };
}

test('native API v2 Operations uses public IDs, tenant RLS, durable credits, and direct lunch-break persistence', { timeout: 45_000 }, async () => {
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `api-v2-operations-${runId}`,
    otherTenantId: `api-v2-operations-other-${runId}`,
    managerId: `api-v2-operations-manager-${runId}`,
    staffId: `api-v2-operations-staff-${runId}`,
    locationId: `api-v2-operations-location-${runId}`,
    draftScheduleId: `api-v2-operations-draft-${runId}`,
    publishedScheduleId: `api-v2-operations-published-${runId}`,
    draftShiftId: `api-v2-operations-draft-shift-${runId}`,
    publishedShiftId: `api-v2-operations-published-shift-${runId}`,
  };
  const operations = new OperationsService(new TenantDatabase(app));
  const lunchBreaks = new LunchBreakService(new TenantDatabase(app));

  try {
    const tenant = await owner.tenant.create({
      data: {
        id: fixture.tenantId,
        name: 'API v2 Operations Integration',
        slug: `api-v2-operations-${runId}`,
        planTier: 'GROWTH',
        status: 'ACTIVE',
        stripeSubscriptionId: `sub_api_v2_operations_${runId}`,
        stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        usageCredits: 6,
      },
    });
    const otherTenant = await owner.tenant.create({
      data: {
        id: fixture.otherTenantId,
        name: 'Other API v2 Operations Integration',
        slug: `api-v2-operations-other-${runId}`,
        planTier: 'FREE',
        status: 'ACTIVE',
      },
    });
    const location = await owner.location.create({
      data: {
        id: fixture.locationId,
        tenantId: fixture.tenantId,
        name: 'API v2 Operations Location',
        timezone: 'UTC',
      },
    });
    const [manager, staff] = await Promise.all([
      owner.user.create({
        data: {
          id: fixture.managerId,
          tenantId: fixture.tenantId,
          name: 'API v2 Operations Manager',
          role: 'MANAGER',
          mfaBackupCodes: [],
        },
      }),
      owner.user.create({
        data: {
          id: fixture.staffId,
          tenantId: fixture.tenantId,
          name: 'API v2 Operations Staff',
          role: 'STAFF',
          mfaBackupCodes: [],
        },
      }),
    ]);
    const [draft, published] = await Promise.all([
      owner.schedule.create({
        data: {
          id: fixture.draftScheduleId,
          tenantId: fixture.tenantId,
          locationId: location.id,
          startDate: new Date('2026-09-10T00:00:00.000Z'),
          endDate: new Date('2026-09-11T00:00:00.000Z'),
          status: 'DRAFT',
        },
      }),
      owner.schedule.create({
        data: {
          id: fixture.publishedScheduleId,
          tenantId: fixture.tenantId,
          locationId: location.id,
          startDate: new Date('2026-09-12T00:00:00.000Z'),
          endDate: new Date('2026-09-13T00:00:00.000Z'),
          status: 'PUBLISHED',
          publishedAt: new Date('2026-09-09T00:00:00.000Z'),
        },
      }),
    ]);
    const [draftShift, publishedShift] = await Promise.all([
      owner.shift.create({
        data: {
          id: fixture.draftShiftId,
          tenantId: fixture.tenantId,
          locationId: location.id,
          scheduleId: draft.id,
          userId: manager.id,
          startTime: new Date('2026-09-10T09:00:00.000Z'),
          endTime: new Date('2026-09-10T17:00:00.000Z'),
          role: 'MANAGER',
        },
      }),
      owner.shift.create({
        data: {
          id: fixture.publishedShiftId,
          tenantId: fixture.tenantId,
          locationId: location.id,
          scheduleId: published.id,
          userId: staff.id,
          startTime: new Date('2026-09-12T09:00:00.000Z'),
          endTime: new Date('2026-09-12T17:00:00.000Z'),
          role: 'STAFF',
        },
      }),
    ]);
    const otherLocation = await owner.location.create({
      data: {
        tenantId: otherTenant.id,
        name: 'Other API v2 Operations Location',
        timezone: 'UTC',
      },
    });
    const otherUser = await owner.user.create({
      data: {
        tenantId: otherTenant.id,
        name: 'Other API v2 Operations Staff',
        role: 'STAFF',
        mfaBackupCodes: [],
      },
    });
    const otherSchedule = await owner.schedule.create({
      data: {
        tenantId: otherTenant.id,
        locationId: otherLocation.id,
        startDate: new Date('2026-09-14T00:00:00.000Z'),
        endDate: new Date('2026-09-15T00:00:00.000Z'),
        status: 'PUBLISHED',
        publishedAt: new Date('2026-09-09T00:00:00.000Z'),
      },
    });
    await owner.shift.create({
      data: {
        tenantId: otherTenant.id,
        locationId: otherLocation.id,
        scheduleId: otherSchedule.id,
        userId: otherUser.id,
        startTime: new Date('2026-09-14T09:00:00.000Z'),
        endTime: new Date('2026-09-14T17:00:00.000Z'),
        role: 'STAFF',
      },
    });
    const managerIdentity = identity(fixture.tenantId, manager.id, 'MANAGER');
    const staffIdentity = identity(fixture.tenantId, staff.id, 'STAFF');

    const [schedules, shifts, roster, staffSchedules, staffLunchRows] = await Promise.all([
      operations.listSchedules(managerIdentity, { limit: '20' }),
      operations.listShifts(managerIdentity, { locationId: location.publicId, limit: '20' }),
      operations.staffRoster(managerIdentity, { limit: '20' }),
      operations.listSchedules(staffIdentity, { limit: '20' }),
      lunchBreaks.list(staffIdentity, { locationId: location.publicId, limit: '20' }),
    ]);

    assert.deepEqual(new Set(schedules.data.map((row) => row.id)), new Set([draft.publicId, published.publicId]));
    assert.deepEqual(new Set(shifts.data.map((row) => row.id)), new Set([draftShift.publicId, publishedShift.publicId]));
    assert.deepEqual(new Set(roster.data.map((row) => row.id)), new Set([manager.publicId, staff.publicId]));
    assert.deepEqual(staffSchedules.data.map((row) => row.id), [published.publicId]);
    assert.deepEqual(staffLunchRows.data.map((row) => row.shiftId), [publishedShift.publicId]);
    assert.equal(JSON.stringify({ schedules, shifts, roster, staffSchedules, staffLunchRows }).includes(fixture.draftShiftId), false);
    assert.equal(JSON.stringify({ schedules, shifts, roster, staffSchedules, staffLunchRows }).includes(fixture.managerId), false);
    assert.equal(JSON.stringify({ schedules, shifts, roster, staffSchedules, staffLunchRows }).includes(otherTenant.id), false);

    const policyBefore = await lunchBreaks.policy(managerIdentity);
    const policyAfter = await lunchBreaks.replacePolicy(managerIdentity, { lunchDurationMinutes: 35 });
    assert.equal(policyBefore.lunchDurationMinutes, 30);
    assert.equal(policyAfter.lunchDurationMinutes, 35);
    assert.equal(await owner.creditTransaction.count({ where: { tenantId: tenant.id } }), 0);

    const generationKey = `api-v2-operations-generation-${runId}`;
    const generated = await lunchBreaks.generate(managerIdentity, {
      locationId: location.publicId,
      shiftIds: [draftShift.publicId],
      persist: true,
    }, generationKey);
    const generationReplay = await lunchBreaks.generate(managerIdentity, {
      locationId: location.publicId,
      shiftIds: [draftShift.publicId],
      persist: true,
    }, generationKey);
    assert.equal(generated.locationId, location.publicId);
    assert.equal(generated.persisted, true);
    assert.equal(generated.reused, false);
    assert.equal(generated.data[0]?.shiftId, draftShift.publicId);
    assert.equal(generationReplay.reused, true);
    assert.equal(JSON.stringify(generated).includes(fixture.draftShiftId), false);

    const replacementBody = {
      locationId: location.publicId,
      breaks: [
        { type: 'break1', startTime: '2026-09-10T10:30:00.000Z', durationMinutes: 10, skip: false },
        { type: 'lunch', startTime: '2026-09-10T13:00:00.000Z', durationMinutes: 35, skip: false },
        { type: 'break2', startTime: '2026-09-10T15:00:00.000Z', durationMinutes: 10, skip: false },
      ],
    };
    const replacementKey = `api-v2-operations-replace-${runId}`;
    const replaced = await lunchBreaks.replaceShiftBreaks(managerIdentity, draftShift.publicId, replacementBody, replacementKey);
    const replacementReplay = await lunchBreaks.replaceShiftBreaks(managerIdentity, draftShift.publicId, replacementBody, replacementKey);
    const replacementNoop = await lunchBreaks.replaceShiftBreaks(
      managerIdentity,
      draftShift.publicId,
      replacementBody,
      `api-v2-operations-replace-noop-${runId}`,
    );
    assert.equal(replaced.shiftId, draftShift.publicId);
    assert.deepEqual(replacementReplay, replaced);
    assert.deepEqual(replacementNoop, replaced);

    const setupKey = `api-v2-operations-setup-${runId}`;
    const setup = await lunchBreaks.setupShifts(managerIdentity, {
      locationId: location.publicId,
      rows: [{
        startTime: '2026-09-10T18:00:00.000Z',
        endTime: '2026-09-10T20:00:00.000Z',
      }],
    }, setupKey);
    const setupReplay = await lunchBreaks.setupShifts(managerIdentity, {
      locationId: location.publicId,
      rows: [{
        startTime: '2026-09-10T18:00:00.000Z',
        endTime: '2026-09-10T20:00:00.000Z',
      }],
    }, setupKey);
    assert.equal(setup.shiftIds.length, 1);
    assert.match(setup.shiftIds[0], /^[0-9a-f-]{36}$/i);
    assert.deepEqual(setupReplay, setup);

    const [tenantAfter, draftAfter, breakCount, ledger, setupShift] = await Promise.all([
      owner.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { usageCredits: true } }),
      owner.schedule.findUniqueOrThrow({ where: { id: draft.id }, select: { revision: true } }),
      owner.break.count({ where: { shiftId: draftShift.id } }),
      owner.creditTransaction.findMany({
        where: { tenantId: tenant.id },
        select: { amount: true, balanceAfter: true },
        orderBy: { createdAt: 'asc' },
      }),
      owner.shift.findUniqueOrThrow({ where: { publicId: setup.shiftIds[0] }, select: { tenantId: true, userId: true, role: true } }),
    ]);
    assert.equal(tenantAfter.usageCredits, 3);
    assert.equal(draftAfter.revision, 2);
    assert.equal(breakCount, 3);
    assert.deepEqual(ledger.map((row) => row.amount), [-1, -1, -1]);
    assert.equal(ledger.at(-1)?.balanceAfter, 3);
    assert.deepEqual(setupShift, { tenantId: tenant.id, userId: null, role: null });
  } finally {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      const tenantIds = [fixture.tenantId, fixture.otherTenantId];
      await transaction.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.lunchBreakGenerationRequest.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.creditTransaction.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.break.deleteMany({ where: { shift: { tenantId: { in: tenantIds } } } });
      await transaction.shift.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.schedule.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.tenantSetting.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.location.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }).catch(() => {});
    await Promise.allSettled([app.$disconnect(), owner.$disconnect()]);
  }
});
