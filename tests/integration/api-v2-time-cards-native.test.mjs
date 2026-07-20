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
const { TimeCardService } = require('../../apps/api-v2/src/time/time-cards.service.ts');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');

function identity(tenantId, user, role, permissions) {
  return {
    sub: user.id,
    publicUserId: user.publicId,
    tenantId,
    sessionId: `time-card-session-${randomUUID()}`,
    role,
    legacyRole: role,
    roles: [{ id: randomUUID(), name: role === 'STAFF' ? 'Staff' : 'Manager', isSystem: true, legacyRole: role }],
    permissions,
    mfaVerified: true,
    mfaRequired: false,
  };
}

function iso(value) {
  return value.toISOString();
}

test('native API v2 Time Cards use public IDs, tenant RLS, exact clock-in replay, and recovery-safe clock-out', { timeout: 45_000 }, async () => {
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `api-v2-time-${runId}`,
    otherTenantId: `api-v2-time-other-${runId}`,
    managerId: `api-v2-time-manager-${runId}`,
    staffId: `api-v2-time-staff-${runId}`,
    locationId: `api-v2-time-location-${runId}`,
  };
  const timeCards = new TimeCardService(new TenantDatabase(app));

  try {
    const tenant = await owner.tenant.create({
      data: {
        id: fixture.tenantId,
        name: 'API v2 Time Integration',
        slug: `api-v2-time-${runId}`,
        planTier: 'GROWTH',
        status: 'ACTIVE',
        stripeSubscriptionId: `sub_api_v2_time_${runId}`,
        stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        usageCredits: 4,
      },
    });
    const otherTenant = await owner.tenant.create({
      data: {
        id: fixture.otherTenantId,
        name: 'Other API v2 Time Integration',
        slug: `api-v2-time-other-${runId}`,
        planTier: 'FREE',
        status: 'ACTIVE',
      },
    });
    const location = await owner.location.create({
      data: {
        id: fixture.locationId,
        tenantId: tenant.id,
        name: 'API v2 Time Location',
        timezone: 'UTC',
      },
    });
    const [manager, staff] = await Promise.all([
      owner.user.create({
        data: {
          id: fixture.managerId,
          tenantId: tenant.id,
          name: 'API v2 Time Manager',
          role: 'MANAGER',
          mfaBackupCodes: [],
        },
      }),
      owner.user.create({
        data: {
          id: fixture.staffId,
          tenantId: tenant.id,
          name: 'API v2 Time Staff',
          role: 'STAFF',
          mfaBackupCodes: [],
        },
      }),
    ]);
    const otherLocation = await owner.location.create({
      data: { tenantId: otherTenant.id, name: 'Other API v2 Time Location', timezone: 'UTC' },
    });
    const otherUser = await owner.user.create({
      data: {
        tenantId: otherTenant.id,
        name: 'Other API v2 Time Staff',
        role: 'STAFF',
        mfaBackupCodes: [],
      },
    });
    const otherCard = await owner.timeCard.create({
      data: {
        tenantId: otherTenant.id,
        userId: otherUser.id,
        locationId: otherLocation.id,
        clockInAt: new Date(Date.now() - 180 * 60_000),
        clockOutAt: new Date(Date.now() - 120 * 60_000),
        status: 'CLOSED',
      },
    });

    const managerIdentity = identity(tenant.id, manager, 'MANAGER', [
      'time_cards:read',
      'time_cards:write',
      'users:read',
      'shifts:read',
    ]);
    const staffIdentity = identity(tenant.id, staff, 'STAFF', [
      'time_cards:read',
      'time_cards:write',
    ]);
    const firstClockInAt = new Date(Date.now() - 120 * 60_000);
    const firstClockOutAt = new Date(Date.now() - 40 * 60_000);
    const clockInKey = `api-v2-time-clock-in-${runId}`;
    const clockInBody = {
      userId: staff.publicId,
      locationId: location.publicId,
      clockInAt: iso(firstClockInAt),
      notes: 'Native time card',
    };
    const created = await timeCards.clockIn(managerIdentity, clockInBody, clockInKey);
    const replay = await timeCards.clockIn(managerIdentity, clockInBody, clockInKey);
    assert.equal(created.reused, false);
    assert.equal(replay.reused, true);
    assert.equal(created.data.id, replay.data.id);
    assert.equal(created.data.userId, staff.publicId);
    assert.equal(created.data.locationId, location.publicId);
    assert.equal(JSON.stringify(created).includes(fixture.staffId), false);
    assert.equal(JSON.stringify(created).includes(fixture.locationId), false);
    assert.equal(JSON.stringify(created).includes(tenant.id), false);

    const active = await timeCards.active(staffIdentity, {});
    assert.equal(active.data?.id, created.data.id);
    const page = await timeCards.list(managerIdentity, { userId: staff.publicId, limit: '1' });
    assert.equal(page.data.length, 1);
    assert.equal(page.data[0]?.id, created.data.id);
    assert.equal(page.pagination.nextCursor, null);
    await assert.rejects(
      () => timeCards.get(managerIdentity, otherCard.publicId),
      (error) => error?.code === 'time_card_not_found',
    );
    await assert.rejects(
      () => timeCards.list(staffIdentity, { userId: manager.publicId }),
      (error) => error?.code === 'time_card_scope_denied',
    );

    const closed = await timeCards.clockOut(managerIdentity, created.data.id, {
      clockOutAt: iso(firstClockOutAt),
      breakMinutes: 0,
    });
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.clockOutAt, iso(firstClockOutAt));
    const breakStart = new Date(firstClockInAt.getTime() + 20 * 60_000);
    const breakEnd = new Date(firstClockInAt.getTime() + 30 * 60_000);
    const corrected = await timeCards.correct(managerIdentity, closed.id, {
      expectedUpdatedAt: closed.updatedAt,
      breakIntervals: [{ startAt: iso(breakStart), endAt: iso(breakEnd) }],
      reason: 'Add recorded meal break.',
    });
    assert.equal(corrected.breakMinutes, 10);
    assert.equal(corrected.breaks.length, 1);
    assert.match(corrected.breaks[0]?.id ?? '', /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.stringify(corrected).includes(fixture.staffId), false);

    const recoveryClockInAt = new Date(Date.now() - 20 * 60_000);
    const recovery = await timeCards.clockIn(managerIdentity, {
      userId: staff.publicId,
      locationId: location.publicId,
      clockInAt: iso(recoveryClockInAt),
    }, `api-v2-time-recovery-${runId}`);
    await owner.tenant.update({ where: { id: tenant.id }, data: { status: 'PAST_DUE' } });
    const recoveryActive = await timeCards.active(staffIdentity, {});
    assert.equal(recoveryActive.data?.id, recovery.data.id);
    const recovered = await timeCards.clockOut(staffIdentity, recovery.data.id, { breakMinutes: 0 });
    assert.equal(recovered.status, 'CLOSED');

    const [tenantAfter, debits, persisted] = await Promise.all([
      owner.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { usageCredits: true } }),
      owner.creditTransaction.findMany({
        where: { tenantId: tenant.id },
        select: { id: true, amount: true, reason: true, balanceAfter: true },
        orderBy: { createdAt: 'asc' },
      }),
      owner.timeCard.findUniqueOrThrow({
        where: { publicId: corrected.id },
        select: { id: true, publicId: true, breaks: { select: { id: true, publicId: true } } },
      }),
    ]);
    assert.equal(tenantAfter.usageCredits, 2);
    assert.deepEqual(debits.map((row) => row.amount), [-1, -1]);
    assert.equal(debits.filter((row) => row.id === `feature-usage-${createHash(tenant.id, clockInKey)}`).length, 1);
    assert.notEqual(persisted.id, persisted.publicId);
    assert.equal(persisted.breaks.length, 1);
    assert.notEqual(persisted.breaks[0]?.id, persisted.breaks[0]?.publicId);
  } finally {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      const tenantIds = [fixture.tenantId, fixture.otherTenantId];
      await transaction.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.creditTransaction.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.timeCardBreak.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.timeCard.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.location.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }).catch(() => {});
    await Promise.allSettled([app.$disconnect(), owner.$disconnect()]);
  }
});

function createHash(tenantId, key) {
  const { createHash: sha256 } = require('node:crypto');
  return sha256('sha256').update(`${tenantId}:${key}`, 'utf8').digest('hex');
}
