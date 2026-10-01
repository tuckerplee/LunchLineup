import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

process.env.TS_NODE_PROJECT = resolve(import.meta.dirname, '../../apps/api-v2/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
const { PeopleService } = require('../../apps/api-v2/src/people/people.service.ts');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');
const { installProblemHandler } = require('../../apps/api-v2/src/platform/problem.ts');

// Direct service calls expose raw Prisma conflicts. Exercise the actual public
// problem handler instead of assuming those errors already carry HTTP status.
function publicPinFailure(error) {
  let handler, payload;
  installProblemHandler({ setErrorHandler(value) { handler = value; }, setNotFoundHandler() {} });
  const reply = { code(status) { this.status = status; return this; }, header() { return this; },
    type() { return this; }, send(value) { payload = value; } };
  handler(error, { id: 'native-pin-race', url: '/v2/users/me/pin', log: { info() {}, error() {} } }, reply);
  assert.equal(payload.status, reply.status);
  return payload;
}

// Run only on the approved disposable integration database. Elevated setup is
// separate; every operation being proved uses the restricted application role.
test('People mutations preserve stale writes, replay identity, suspended history, and durable PIN budgets', async () => {
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

    // These are real restricted-role transactions. Wrong PIN failures must
    // commit their account budget even though the public operation rejects.
    const originalPin = '456789', replacementPin = '567890';
    const salt = randomBytes(16).toString('hex');
    const originalHash = `${salt}:${scryptSync(originalPin, salt, 64).toString('hex')}`;
    const pinUser = await owner.user.create({ data: { tenantId, name: 'PIN Budget Employee', role: 'STAFF',
      username: `b${randomUUID().slice(0, 12)}`, pinHash: originalHash, pinResetRequired: true, mfaBackupCodes: [] } });
    const pinRole = await owner.role.create({ data: { tenantId, name: 'PIN Budget', slug: `pin-${randomUUID()}`,
      legacyRole: 'STAFF', isSystem: false } });
    const pinPermission = await owner.permission.findUniqueOrThrow({ where: { key: 'auth:login_pin' } });
    await owner.rolePermission.create({ data: { roleId: pinRole.id, permissionId: pinPermission.id } });
    await owner.roleAssignment.create({ data: { tenantId, userId: pinUser.id, roleId: pinRole.id } });
    const pinSession = await session(pinUser.id), copiedPinSession = await session(pinUser.id);
    const pinIdentity = { sub: pinUser.id, publicUserId: pinUser.publicId, tenantId, sessionId: pinSession.id,
      role: 'PIN Budget', legacyRole: 'STAFF', roles: [{ id: pinRole.publicId, name: pinRole.name, legacyRole: 'STAFF', isSystem: false }],
      permissions: ['auth:login_pin'], mfaVerified: true, mfaRequired: false, pinResetRequired: true };
    const readPinState = () => owner.user.findUniqueOrThrow({ where: { id: pinUser.id },
      select: { pinHash: true, pinLoginAttempts: true, pinLockedUntil: true, pinResetRequired: true } });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const beforeAttempt = Date.now();
      await assert.rejects(() => service.replaceOwnPin(pinIdentity, '111111', replacementPin),
        e => e.status === 401 && e.code === 'invalid_current_pin');
      const stored = await readPinState();
      assert.equal(stored.pinLoginAttempts, attempt);
      assert.equal(stored.pinHash, originalHash);
      assert.equal(stored.pinResetRequired, true);
      if (attempt < 5) assert.equal(stored.pinLockedUntil, null);
      else {
        assert.ok(stored.pinLockedUntil.getTime() >= beforeAttempt + 15 * 60 * 1000);
        assert.ok(stored.pinLockedUntil.getTime() <= Date.now() + 15 * 60 * 1000);
      }
      assert.equal(await owner.session.count({ where: { userId: pinUser.id, revokedAt: null } }), 2);
      assert.equal(await owner.auditLog.count({ where: { tenantId, resourceId: pinUser.id, action: 'USER_PIN_ROTATED' } }), 0);
    }
    const locked = await readPinState();
    await assert.rejects(() => service.replaceOwnPin(pinIdentity, originalPin, replacementPin), e => e.status === 403);
    assert.deepEqual(await readPinState(), locked);
    // Owner setup expires only this synthetic user's lock for the recovery
    // scenario; no service or production clock/policy is changed.
    await owner.user.update({ where: { id: pinUser.id }, data: { pinLockedUntil: new Date(Date.now() - 1000) } });
    await service.replaceOwnPin(pinIdentity, originalPin, replacementPin);
    const rotated = await readPinState();
    assert.equal(rotated.pinLoginAttempts, 0);
    assert.equal(rotated.pinLockedUntil, null);
    assert.equal(rotated.pinResetRequired, false);
    assert.notEqual(rotated.pinHash, originalHash);
    const [newSalt, newHash] = rotated.pinHash.split(':');
    assert.equal(scryptSync(replacementPin, newSalt, 64).toString('hex'), newHash);
    assert.equal(await owner.session.count({ where: { userId: pinUser.id, revokedAt: null } }), 0);
    assert.ok((await owner.session.findUniqueOrThrow({ where: { id: copiedPinSession.id } })).revokedAt);
    const rotationAudit = await owner.auditLog.findMany({ where: { tenantId, resourceId: pinUser.id, action: 'USER_PIN_ROTATED' } });
    assert.equal(rotationAudit.length, 1);
    assert.deepEqual(rotationAudit[0].newValue, { pinResetRequired: false, sessionsRevoked: 2 });
    await assert.rejects(() => service.replaceOwnPin(pinIdentity, replacementPin, '678901'), e => e.status === 403);
    assert.deepEqual(await readPinState(), rotated);
    const freshPinSession = await session(pinUser.id);
    const freshPinIdentity = { ...pinIdentity, sessionId: freshPinSession.id, pinResetRequired: false };
    await assert.rejects(() => service.replaceOwnPin({ ...freshPinIdentity, tenantId: otherTenantId }, '111111', '678901'), e => e.status === 403);
    assert.deepEqual(await readPinState(), rotated);
    const concurrentGuesses = await Promise.allSettled(Array.from({ length: 4 },
      () => service.replaceOwnPin(freshPinIdentity, '111111', '678901')));
    let committedGuesses = 0;
    for (const result of concurrentGuesses) {
      assert.equal(result.status, 'rejected');
      const problem = publicPinFailure(result.reason);
      assert.ok([401, 409].includes(problem.status), 'Concurrency must yield a durable invalid PIN or an explicit public conflict');
      assert.equal(problem.code, problem.status === 401 ? 'invalid_current_pin' : 'concurrent_change');
      if (problem.status === 401) {
        committedGuesses++;
      }
    }
    assert.ok(committedGuesses >= 1 && committedGuesses <= 4);
    const afterRace = await readPinState();
    assert.equal(afterRace.pinLoginAttempts, committedGuesses, 'No committed invalid-PIN rejection may lose its account charge');
    assert.equal(afterRace.pinLockedUntil, null);
    assert.equal(afterRace.pinHash, rotated.pinHash);
    assert.equal(afterRace.pinResetRequired, false);
    assert.equal(await owner.auditLog.count({ where: { tenantId, resourceId: pinUser.id, action: 'USER_PIN_ROTATED' } }), 1);
    assert.equal((await owner.session.findUniqueOrThrow({ where: { id: freshPinSession.id } })).revokedAt, null);
    await owner.rolePermission.delete({ where: { roleId_permissionId: { roleId: pinRole.id, permissionId: pinPermission.id } } });
    await assert.rejects(() => service.replaceOwnPin(freshPinIdentity, '111111', '678901'), e => e.status === 403);
    assert.deepEqual(await readPinState(), afterRace);
    assert.equal((await owner.session.findUniqueOrThrow({ where: { id: freshPinSession.id } })).revokedAt, null);

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
