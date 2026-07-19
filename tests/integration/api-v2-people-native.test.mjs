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
const { PeopleService } = require('../../apps/api-v2/src/people/people.service.ts');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');

function identity(tenantId, userId) {
  return {
    sub: userId,
    publicUserId: randomUUID(),
    tenantId,
    sessionId: `people-session-${randomUUID()}`,
    role: 'MANAGER',
    legacyRole: 'MANAGER',
    roles: [{ id: randomUUID(), name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
    permissions: ['users:read', 'roles:read'],
    mfaVerified: true,
    mfaRequired: false,
  };
}

test('native API v2 people reads use public role/user UUIDs and tenant-scoped restricted-RLS access', async () => {
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const tenantId = `api-v2-people-${randomUUID()}`;
  const otherTenantId = `api-v2-people-other-${randomUUID()}`;
  const actorId = `api-v2-people-actor-${randomUUID()}`;
  const colleagueId = `api-v2-people-colleague-${randomUUID()}`;
  const otherUserId = `api-v2-people-other-user-${randomUUID()}`;
  const service = new PeopleService(new TenantDatabase(app), {
    staffInvitationOutboxEnabled: false,
    staffInvitationOutboxEncryptionKey: '',
    staffInvitationMaxAttempts: 8,
  });

  let roleId;
  let userPublicId;
  let rolePublicId;
  try {
    await owner.tenant.createMany({
      data: [
        { id: tenantId, name: 'API v2 People Integration', slug: `api-v2-people-${randomUUID()}`, planTier: 'FREE', status: 'ACTIVE' },
        { id: otherTenantId, name: 'Other People Tenant', slug: `api-v2-people-other-${randomUUID()}`, planTier: 'FREE', status: 'ACTIVE' },
      ],
    });
    const permission = await owner.permission.findUniqueOrThrow({ where: { key: 'users:read' } });
    const role = await owner.role.create({
      data: {
        tenantId,
        name: `People Manager ${randomUUID()}`,
        slug: `people-manager-${randomUUID()}`,
        isSystem: true,
        isDefault: true,
        legacyRole: 'MANAGER',
      },
    });
    roleId = role.id;
    rolePublicId = role.publicId;
    assert.match(role.publicId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(role.publicId, role.id);
    await owner.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const [actor, colleague] = await Promise.all([
      owner.user.create({
        data: {
          id: actorId, tenantId, name: 'Casey People', email: `casey-${randomUUID()}@example.test`,
          role: 'MANAGER', mfaBackupCodes: [],
        },
      }),
      owner.user.create({
        data: {
          id: colleagueId, tenantId, name: 'Jamie People', email: `jamie-${randomUUID()}@example.test`,
          role: 'STAFF', mfaBackupCodes: [],
        },
      }),
    ]);
    userPublicId = actor.publicId;
    assert.match(actor.publicId, /^[0-9a-f-]{36}$/i);
    await owner.roleAssignment.createMany({
      data: [
        { tenantId, userId: actor.id, roleId: role.id },
        { tenantId, userId: colleague.id, roleId: role.id },
      ],
    });
    const other = await owner.user.create({
      data: {
        id: otherUserId, tenantId: otherTenantId, name: 'Other Tenant Staff', email: `other-${randomUUID()}@example.test`,
        role: 'STAFF', mfaBackupCodes: [],
      },
    });

    const actorIdentity = identity(tenantId, actorId);
    const directory = await service.list(actorIdentity, { limit: '10' });
    assert.equal(directory.data.length, 2);
    assert.ok(directory.data.some((entry) => entry.id === actor.publicId));
    assert.ok(directory.data.some((entry) => entry.id === colleague.publicId));
    assert.equal(JSON.stringify(directory).includes(actor.id), false);
    assert.equal(JSON.stringify(directory).includes(colleague.id), false);
    assert.equal(directory.data[0]?.assignedRoles[0]?.id, role.publicId);

    const catalog = await service.accessCatalog(actorIdentity);
    assert.equal(catalog.roles.find((entry) => entry.id === role.publicId)?.name, role.name);
    assert.equal(JSON.stringify(catalog).includes(role.id), false);

    const fetched = await service.get(actorIdentity, actor.publicId);
    assert.equal(fetched.id, actor.publicId);
    assert.equal((await service.resolvePublicUserIds(tenantId, [actor.publicId])).get(actor.publicId), actor.id);
    assert.equal((await service.resolveInternalUserIds(tenantId, [actor.id])).get(actor.id), actor.publicId);
    assert.equal((await service.resolvePublicUserIds(tenantId, [other.publicId])).size, 0);
  } finally {
    await owner.roleAssignment.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
    if (roleId) await owner.rolePermission.deleteMany({ where: { roleId } });
    await owner.user.deleteMany({ where: { id: { in: [actorId, colleagueId, otherUserId] } } });
    if (roleId) await owner.role.deleteMany({ where: { id: roleId } });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
  }
});
