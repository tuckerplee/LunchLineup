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

    const beforeUpdate = await service.get(actor, created.id);
    await assert.rejects(() => service.update(actor, created.id, { name: 'Missing precondition', timezone: beforeUpdate.timezone }),
      error => error?.status === 428);
    const updated = await service.update(actor, created.id, {
      expectedUpdatedAt: beforeUpdate.updatedAt,
      name: 'Native Location Proof Updated',
      address: null,
      timezone: 'America/Denver',
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.timezone, 'America/Denver');
    assert.equal(updated.address, null);
    const savedRows = await owner.location.findUniqueOrThrow({ where: { id: ownerLocation.id } });
    await assert.rejects(() => service.update(actor, created.id, {
      name: 'Stale second manager', address: 'Overwritten', timezone: beforeUpdate.timezone,
      expectedUpdatedAt: beforeUpdate.updatedAt,
    }), error => error?.status === 409);
    assert.deepEqual(await owner.location.findUniqueOrThrow({ where: { id: ownerLocation.id } }), savedRows);
    assert.deepEqual(await service.get(actor, created.id), updated);

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

// Owner setup/readback, restricted native service mutation. These are direct DB
// contracts; synthetic identity() does not establish HTTP/session authorization.
async function withLocationHistory(statuses, proof) {
  assert.equal(process.env.DATA_TARGET_ENV, 'disposable');
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const tenantIds = [0, 1].map(() => `native-location-history-${randomUUID()}`);
  const database = new TenantDatabase(app);
  const service = new LocationService(database);
  const actor = identity(tenantIds[0]);
  const transactionOptions = { maxWait: 5000, timeout: 20000 };
  const failures = [];
  const snapshot = () => owner.$transaction(async tx => ({
    tenants: await tx.tenant.findMany({ where: { id: { in: tenantIds } }, orderBy: { id: 'asc' } }),
    locations: await tx.location.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: { id: 'asc' } }),
    schedules: await tx.schedule.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: { id: 'asc' } }),
    shifts: await tx.shift.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: { id: 'asc' } }),
    breaks: await tx.break.findMany({ where: { shift: { tenantId: { in: tenantIds } } }, orderBy: { id: 'asc' } }),
  }), { ...transactionOptions, isolationLevel: 'RepeatableRead' });
  try {
    const [role] = await app.$queryRaw`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    const tables = await app.$queryRaw`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid IN ('"Location"'::regclass, '"Schedule"'::regclass, '"Shift"'::regclass, '"Break"'::regclass)`;
    assert.equal(tables.length, 4);
    for (const table of tables) {
      assert.equal(table.relrowsecurity, true, table.relname);
      assert.equal(table.relforcerowsecurity, true, table.relname);
    }
    const locations = await owner.$transaction(async tx => {
      for (const id of tenantIds) await tx.tenant.create({ data: { id, slug: id, name: id, planTier: 'FREE', status: 'ACTIVE' } });
      const rows = [];
      for (const [index, tenantId] of [tenantIds[0], tenantIds[0], tenantIds[1]].entries()) {
        const location = await tx.location.create({ data: {
          tenantId, name: `History location ${index}`, address: `${index} Native Street`, timezone: 'America/Los_Angeles',
          updatedAt: new Date('2026-07-01T00:00:00.000Z'),
        } });
        rows.push(location);
        const scheduleStates = index === 0 ? statuses : ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
        for (const [offset, state] of scheduleStates.entries()) {
          const startDate = new Date(Date.UTC(2026, 6, 20 + offset * 2));
          const schedule = await tx.schedule.create({ data: {
            tenantId, locationId: location.id, startDate, endDate: new Date(startDate.getTime() + 86400000),
            status: state === 'DELETED_DRAFT' ? 'DRAFT' : state, revision: 7 + offset,
            publishedAt: ['PUBLISHED', 'ARCHIVED'].includes(state) ? new Date('2026-07-19T00:00:00.000Z') : null,
            deletedAt: state === 'DELETED_DRAFT' ? new Date('2026-07-19T01:00:00.000Z') : null,
          } });
          const shift = await tx.shift.create({ data: {
            tenantId, locationId: location.id, scheduleId: schedule.id,
            startTime: new Date(startDate.getTime() + 3600000), endTime: new Date(startDate.getTime() + 7200000),
            notes: `Retained ${state} shift`,
          } });
          await tx.break.create({ data: {
            shiftId: shift.id, type: 'BREAK1', paid: true,
            startTime: new Date(startDate.getTime() + 4500000), endTime: new Date(startDate.getTime() + 4800000),
          } });
        }
      }
      return rows;
    }, transactionOptions);
    const [target, unrelated, foreign] = locations;
    // An unfiltered restricted-role read must see both own locations and no
    // foreign location, independently of LocationService's explicit filters.
    await database.withTenant(actor.tenantId, async tx => {
      const visible = await tx.location.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
      assert.deepEqual(visible.map(row => row.id), [target.id, unrelated.id].sort());
      assert.deepEqual(await tx.schedule.findMany({ where: { tenantId: tenantIds[1] } }), []);
      assert.deepEqual(await tx.shift.findMany({ where: { tenantId: tenantIds[1] } }), []);
      assert.deepEqual(await tx.break.findMany({ where: { shift: { tenantId: tenantIds[1] } } }), []);
    });
    await proof({ owner, service, actor, target, unrelated, foreign, snapshot });
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await owner.$transaction(async tx => {
        await tx.break.deleteMany({ where: { shift: { tenantId: { in: tenantIds } } } });
        await tx.shift.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await tx.schedule.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await tx.location.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      }, transactionOptions);
    } catch (error) {
      failures.push(error);
    }
    for (const client of [app, owner]) {
      try { await client.$disconnect(); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Native location history proof and/or cleanup failed');
}

async function proveHistoricalTimezoneRefusal(status) {
  await withLocationHistory([status, 'DRAFT', 'DELETED_DRAFT'], async ({ service, actor, target, snapshot }) => {
    const before = await snapshot();
    assert.equal(before.schedules.filter(row => row.locationId === target.id && row.status === status).length, 1);
    const current = await service.get(actor, target.publicId);
    await assert.rejects(() => service.update(actor, target.publicId, {
      expectedUpdatedAt: current.updatedAt, name: 'Forbidden partial name', address: 'Forbidden partial address', timezone: 'America/Denver',
    }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'location_timezone_locked');
      assert.equal(error.message, 'Location timezone cannot change after a schedule has been published. Name and address can still be updated.');
      return true;
    });
    assert.deepEqual(await snapshot(), before, `${status} refusal must preserve every fixture row and timestamp`);
    assert.deepEqual(await service.get(actor, target.publicId), current);

    const saved = await service.update(actor, target.publicId, {
      expectedUpdatedAt: current.updatedAt, name: `Allowed ${status} rename`, address: '200 Retained History Road', timezone: current.timezone,
    });
    assert.equal(saved.id, target.publicId);
    assert.equal(saved.name, `Allowed ${status} rename`);
    assert.equal(saved.address, '200 Retained History Road');
    assert.equal(saved.timezone, current.timezone);
    assert.notEqual(saved.updatedAt, current.updatedAt);
    assert.deepEqual(await service.get(actor, target.publicId), saved);
    const after = await snapshot();
    const row = after.locations.find(item => item.id === target.id);
    assert.deepEqual(row, { ...target, name: saved.name, address: saved.address, updatedAt: new Date(saved.updatedAt) });
    assert.deepEqual({ ...after, locations: after.locations.filter(item => item.id !== target.id) },
      { ...before, locations: before.locations.filter(item => item.id !== target.id) });
  });
}

test('native API v2 locations atomically refuse timezone changes with PUBLISHED history while permitting same-zone edits', async () => {
  await proveHistoricalTimezoneRefusal('PUBLISHED');
});

test('native API v2 locations atomically refuse timezone changes with ARCHIVED history while permitting same-zone edits', async () => {
  await proveHistoricalTimezoneRefusal('ARCHIVED');
});

test('native API v2 location deactivation retains history, fences only active drafts, and isolates unrelated locations and tenants', async () => {
  await withLocationHistory(['PUBLISHED', 'ARCHIVED', 'DRAFT', 'DELETED_DRAFT'], async ({ service, actor, target, unrelated, foreign, snapshot }) => {
    const before = await snapshot();
    assert.deepEqual(await service.summary(actor), { count: 2 });
    await assert.rejects(() => service.update(actor, foreign.publicId, {
      expectedUpdatedAt: foreign.updatedAt.toISOString(), name: 'Foreign attempted edit', address: null, timezone: 'America/Denver',
    }), error => error?.status === 404 && error?.code === 'location_not_found');
    await service.remove(actor, foreign.publicId);
    assert.deepEqual(await snapshot(), before, 'Foreign update/remove must preserve every fixture row');

    await service.remove(actor, target.publicId);
    const after = await snapshot();
    const deleted = after.locations.find(row => row.id === target.id);
    assert.ok(deleted.deletedAt instanceof Date);
    assert.notEqual(deleted.updatedAt.toISOString(), target.updatedAt.toISOString());
    assert.deepEqual(deleted, { ...target, deletedAt: deleted.deletedAt, updatedAt: deleted.updatedAt });
    assert.deepEqual(after.tenants, before.tenants);
    assert.deepEqual(after.locations.filter(row => row.id !== target.id), before.locations.filter(row => row.id !== target.id));
    assert.deepEqual(after.shifts, before.shifts);
    assert.deepEqual(after.breaks, before.breaks);
    const changedDrafts = before.schedules.filter(row => row.locationId === target.id && row.status === 'DRAFT' && row.deletedAt === null);
    assert.equal(changedDrafts.length, 1);
    assert.equal(after.schedules.length, before.schedules.length);
    for (const original of before.schedules) {
      const saved = after.schedules.find(row => row.id === original.id);
      assert.ok(saved);
      if (saved.id === changedDrafts[0].id) {
        assert.deepEqual(saved, { ...original, revision: original.revision + 1, updatedAt: saved.updatedAt });
      } else {
        assert.deepEqual(saved, original, 'Published, archived, deleted-draft, unrelated and foreign schedules remain byte-for-byte stable');
      }
    }
    assert.deepEqual(await service.summary(actor), { count: 1 });
    const listed = await service.list(actor, { limit: '100' });
    assert.deepEqual(listed.data.map(row => row.id), [unrelated.publicId]);
    await assert.rejects(() => service.get(actor, target.publicId), error => error?.status === 404 && error?.code === 'location_not_found');
    assert.deepEqual(await service.resolvePublicIds(actor.tenantId, [target.publicId, unrelated.publicId, foreign.publicId]),
      new Map([[unrelated.publicId, unrelated.id]]));
    assert.deepEqual(await service.resolveInternalIds(actor.tenantId, [target.id, foreign.id]), new Map([[target.id, target.publicId]]));
    await service.remove(actor, target.publicId);
    assert.deepEqual(await snapshot(), after, 'Repeated deactivation must not increment draft revisions again');
  });
});
