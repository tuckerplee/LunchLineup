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
const { LocationService } = require('../../apps/api-v2/src/locations/locations.service.ts');
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');

function identity(tenantId) {
  return {
    sub: `location-user-${randomUUID()}`,
    tenantId,
    sessionId: `location-session-${randomUUID()}`,
    role: 'Manager',
    legacyRole: 'MANAGER',
    roles: [{ id: `role-${randomUUID()}`, name: 'Manager', isSystem: true, legacyRole: 'MANAGER' }],
    permissions: ['locations:read', 'locations:write', 'locations:delete'],
    mfaVerified: true,
    mfaRequired: false,
  };
}

test('native API v2 locations use the restricted RLS role, public UUIDs, durable idempotency, and draft revision fencing', async () => {
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const tenantId = `api-v2-locations-${randomUUID()}`;
  const otherTenantId = `api-v2-locations-other-${randomUUID()}`;
  const tenantSlug = `api-v2-locations-${randomUUID()}`;
  const otherTenantSlug = `api-v2-locations-other-${randomUUID()}`;
  const actor = identity(tenantId);
  const service = new LocationService(new TenantDatabase(app));

  try {
    await owner.tenant.create({
      data: {
        id: tenantId,
        name: 'API v2 Location Integration',
        slug: tenantSlug,
        planTier: 'FREE',
        status: 'ACTIVE',
      },
    });
    await owner.tenant.create({
      data: {
        id: otherTenantId,
        name: 'Other Location Tenant',
        slug: otherTenantSlug,
        planTier: 'FREE',
        status: 'ACTIVE',
      },
    });

    const createRequest = {
      name: 'Native Location Proof',
      address: '100 Main Street',
      timezone: 'America/Los_Angeles',
    };
    const key = `location-create-${randomUUID()}`;
    const created = await service.create(actor, createRequest, key);
    const replay = await service.create(actor, createRequest, key);

    assert.deepEqual(replay, created);
    assert.match(created.id, /^[0-9a-f-]{36}$/i);
    assert.equal(Object.hasOwn(created, 'publicId'), false);

    const ownerLocation = await owner.location.findUnique({
      where: { publicId: created.id },
      select: { id: true, publicId: true, tenantId: true, deletedAt: true },
    });
    assert.ok(ownerLocation);
    assert.equal(ownerLocation.tenantId, tenantId);
    assert.equal(ownerLocation.publicId, created.id);
    assert.equal(ownerLocation.deletedAt, null);

    const listed = await service.list(actor, { limit: '1' });
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0]?.id, created.id);
    assert.equal(JSON.stringify(listed).includes(ownerLocation.id), false);

    const scheduleId = `api-v2-location-schedule-${randomUUID()}`;
    await owner.schedule.create({
      data: {
        id: scheduleId,
        publicId: randomUUID(),
        tenantId,
        locationId: ownerLocation.id,
        startDate: new Date('2026-07-20T00:00:00.000Z'),
        endDate: new Date('2026-07-21T00:00:00.000Z'),
        status: 'DRAFT',
        revision: 7,
      },
    });

    const updated = await service.update(actor, created.id, {
      name: 'Native Location Proof Updated',
      address: null,
      timezone: 'America/Denver',
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.timezone, 'America/Denver');
    assert.equal(updated.address, null);
    assert.equal((await owner.schedule.findUniqueOrThrow({ where: { id: scheduleId } })).revision, 8);

    const publicToInternal = await service.resolvePublicIds(tenantId, [created.id]);
    assert.equal(publicToInternal.get(created.id), ownerLocation.id);
    const internalToPublic = await service.resolveInternalIds(tenantId, [ownerLocation.id]);
    assert.equal(internalToPublic.get(ownerLocation.id), created.id);

    const otherLocation = await owner.location.create({
      data: {
        tenantId: otherTenantId,
        name: 'Other Tenant Location',
        timezone: 'America/New_York',
      },
      select: { publicId: true },
    });
    await assert.rejects(
      () => service.get(actor, otherLocation.publicId),
      (error) => error && typeof error === 'object' && error.status === 404,
    );

    await service.remove(actor, created.id);
    const deleted = await owner.location.findUniqueOrThrow({ where: { id: ownerLocation.id } });
    assert.ok(deleted.deletedAt);
    assert.equal((await owner.schedule.findUniqueOrThrow({ where: { id: scheduleId } })).revision, 9);
    assert.equal((await service.resolvePublicIds(tenantId, [created.id])).size, 0);
    assert.equal((await service.resolveInternalIds(tenantId, [ownerLocation.id])).get(ownerLocation.id), created.id);
    await assert.rejects(
      () => service.get(actor, created.id),
      (error) => error && typeof error === 'object' && error.status === 404,
    );
  } finally {
    await owner.schedule.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
    await owner.location.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
  }
});
