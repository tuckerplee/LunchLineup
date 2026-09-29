import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

process.env.TS_NODE_PROJECT = resolve(import.meta.dirname, '../../apps/api-v2/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { PeopleService } = require('../../apps/api-v2/src/people/people.service.ts');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');

// Run only on the approved disposable integration database. Elevated setup is
// separate; every operation being proved uses the restricted application role.
test('People mutations preserve stale writes, replay identity, and suspended staff history', async () => {
  assert.equal(process.env.DATA_TARGET_ENV, 'disposable');
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const tenantId = `people-mutations-${randomUUID()}`;
  const otherTenantId = `people-mutations-other-${randomUUID()}`;
  const service = new PeopleService(new TenantDatabase(app), {
    staffInvitationOutboxEnabled: false, staffInvitationOutboxEncryptionKey: '', staffInvitationMaxAttempts: 8,
  });
  const roles = [];
  try {
    const [dbRole] = await app.$queryRawUnsafe('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    assert.equal(dbRole.rolsuper, false);
    assert.equal(dbRole.rolbypassrls, false);
    await owner.tenant.createMany({ data: [tenantId, otherTenantId].map(id => ({ id, slug: id, name: id, status: 'ACTIVE', planTier: 'FREE' })) });
    const admin = await owner.user.create({ data: { tenantId, name: 'Manager A', role: 'ADMIN', email: `${randomUUID()}@example.test`, mfaBackupCodes: [] } });
    const employee = await owner.user.create({ data: { tenantId, name: 'Preserved Employee', role: 'STAFF', username: `p${randomUUID().slice(0, 12)}`, mfaBackupCodes: [] } });
    const foreign = await owner.user.create({ data: { tenantId: otherTenantId, name: 'Foreign', role: 'STAFF', mfaBackupCodes: [] } });
    for (const [user, legacyRole, keys] of [
      [admin, 'ADMIN', ['users:read', 'users:write', 'users:admin', 'auth:login_pin']],
      [employee, 'STAFF', ['auth:login_pin']],
    ]) {
      const role = await owner.role.create({ data: { tenantId, name: legacyRole === 'ADMIN' ? 'Admin' : 'Staff', slug: legacyRole.toLowerCase(), legacyRole, isSystem: true } });
      roles.push(role);
      for (const key of keys) {
        const permission = await owner.permission.findUniqueOrThrow({ where: { key } });
        await owner.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
      }
      await owner.roleAssignment.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    }
    const session = async userId => owner.session.create({ data: { userId, refreshToken: randomUUID(), ipAddress: '127.0.0.1', userAgent: 'native-mutation-test', expiresAt: new Date(Date.now() + 3600000) } });
    const actorSession = await session(admin.id);
    const employeeSession = await session(employee.id);
    const identity = { sub: admin.id, publicUserId: admin.publicId, tenantId, sessionId: actorSession.id,
      role: 'ADMIN', legacyRole: 'ADMIN', roles: [{ id: roles[0].publicId, name: 'Admin', legacyRole: 'ADMIN', isSystem: true }],
      permissions: ['users:read', 'users:write', 'users:admin', 'auth:login_pin'], mfaVerified: true, mfaRequired: false };
    const beforeA = await service.schedulingProfile(identity, employee.publicId);
    const beforeB = await service.schedulingProfile(identity, employee.publicId);
    await service.replaceSchedulingProfile(identity, employee.publicId, { expectedVersion: beforeA.version, skills: ['cashier'], availability: [], availabilityExceptions: [] });
    const saved = await service.schedulingProfile(identity, employee.publicId);
    await assert.rejects(() => service.replaceSchedulingProfile(identity, employee.publicId, { expectedVersion: beforeB.version, skills: ['stock'], availability: [], availabilityExceptions: [] }), e => e.status === 409);
    assert.deepEqual(await service.schedulingProfile(identity, employee.publicId), saved);
    assert.deepEqual((await owner.staffSkill.findMany({ where: { tenantId, userId: employee.id } })).map(row => row.skill), ['cashier']);

    const invite = { name: 'Replay Employee', username: `r${randomUUID().slice(0, 12)}`, pin: '567812', roleId: roles[1].publicId };
    const key = randomUUID();
    const created = await service.invite(identity, invite, key);
    assert.deepEqual(await service.invite(identity, invite, key), created);
    assert.equal(await owner.user.count({ where: { tenantId, username: invite.username } }), 1);
    await assert.rejects(() => service.invite(identity, { ...invite, name: 'Changed' }, key), e => e.status === 409);

    const location = await owner.location.create({ data: { tenantId, name: 'History', timezone: 'UTC' } });
    const start = new Date(Date.now() + 86400000);
    start.setUTCHours(0, 0, 0, 0);
    const schedule = await owner.schedule.create({ data: { tenantId, locationId: location.id, startDate: start,
      endDate: new Date(start.getTime() + 86400000), status: 'PUBLISHED', publishedAt: new Date() } });
    const shift = await owner.shift.create({ data: { tenantId, locationId: location.id, scheduleId: schedule.id, userId: employee.id,
      startTime: new Date(start.getTime() + 36000000), endTime: new Date(start.getTime() + 64800000) } });
    const card = await owner.timeCard.create({ data: { tenantId, userId: employee.id, locationId: location.id,
      clockInAt: new Date('2026-08-01T10:00:00Z'), clockOutAt: new Date('2026-08-01T18:00:00Z'), status: 'CLOSED', workTimeZone: 'UTC' } });
    const suspended = await service.setSuspended(identity, employee.publicId, { suspended: true, expectedSuspendedAt: null });
    assert.ok(suspended.user.suspendedAt);
    assert.equal(suspended.user.name, employee.name);
    assert.equal(suspended.futureAssignmentCount, 1);
    assert.equal(suspended.futureAssignments[0].id, shift.publicId);
    assert.ok((await owner.session.findUniqueOrThrow({ where: { id: employeeSession.id } })).revokedAt);
    assert.deepEqual(await owner.shift.findUniqueOrThrow({ where: { id: shift.id } }), shift);
    assert.deepEqual(await owner.schedule.findUniqueOrThrow({ where: { id: schedule.id } }), schedule);
    assert.deepEqual(await owner.timeCard.findUniqueOrThrow({ where: { id: card.id } }), card);
    await assert.rejects(() => service.schedulingProfile(identity, employee.publicId), e => e.status === 404);
    const reactivated = await service.setSuspended(identity, employee.publicId, { suspended: false, expectedSuspendedAt: suspended.user.suspendedAt });
    assert.equal(reactivated.user.suspendedAt, null);
    assert.equal(reactivated.user.id, employee.publicId);
    assert.ok((await owner.session.findUniqueOrThrow({ where: { id: employeeSession.id } })).revokedAt);
    assert.equal((await owner.user.findUniqueOrThrow({ where: { id: employee.id } })).deletedAt, null);
    assert.deepEqual(await service.schedulingProfile(identity, employee.publicId), saved);
    await assert.rejects(() => service.setSuspended(identity, foreign.publicId, { suspended: true, expectedSuspendedAt: null }), e => e.status === 404);
    await owner.session.update({ where: { id: actorSession.id }, data: { revokedAt: new Date() } });
    await assert.rejects(() => service.setSuspended(identity, employee.publicId, { suspended: true, expectedSuspendedAt: null }), e => e.status === 403);
    assert.equal((await owner.user.findUniqueOrThrow({ where: { id: employee.id } })).suspendedAt, null);
  } finally {
    // Audit history is deliberately append-only, even for the fixture owner.
    // The controller destroys this entire run-private database after the suite;
    // retain these uniquely named fixtures until then rather than bypassing it.
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  }
});
