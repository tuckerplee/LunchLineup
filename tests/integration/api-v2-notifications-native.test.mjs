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
const { TenantDatabase } = require('../../apps/api-v2/src/platform/database.ts');
const { NotificationService } = require('../../apps/api-v2/src/notifications/notifications.service.ts');

function identity(tenantId, userId) {
  return {
    sub: userId,
    publicUserId: randomUUID(),
    tenantId,
    sessionId: `notifications-session-${randomUUID()}`,
    role: 'ADMIN',
    legacyRole: 'ADMIN',
    roles: [],
    permissions: ['notifications:read', 'notifications:write'],
    mfaVerified: true,
    mfaRequired: false,
  };
}

test('native API v2 notifications keep feed IDs public, cursor pagination tenant-scoped, and read state private to the session user', { timeout: 30_000 }, async () => {
  const owner = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const app = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `api-v2-notifications-${runId}`,
    otherTenantId: `api-v2-notifications-other-${runId}`,
    userId: `api-v2-notifications-user-${runId}`,
    otherUserId: `api-v2-notifications-other-user-${runId}`,
  };
  const notifications = new NotificationService(new TenantDatabase(app));

  try {
    const [tenant, otherTenant] = await Promise.all([
      owner.tenant.create({ data: { id: fixture.tenantId, name: 'Notifications Primary', slug: `notifications-primary-${runId}`, status: 'ACTIVE' } }),
      owner.tenant.create({ data: { id: fixture.otherTenantId, name: 'Notifications Isolated', slug: `notifications-isolated-${runId}`, status: 'ACTIVE' } }),
    ]);
    const [user, otherUser] = await Promise.all([
      owner.user.create({ data: { id: fixture.userId, tenantId: tenant.id, name: 'Notifications Admin', role: 'ADMIN', mfaBackupCodes: [] } }),
      owner.user.create({ data: { id: fixture.otherUserId, tenantId: otherTenant.id, name: 'Notifications Other Admin', role: 'ADMIN', mfaBackupCodes: [] } }),
    ]);
    const [older, newer, isolated] = await Promise.all([
      owner.notification.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          type: 'INFO',
          title: 'Older feed entry',
          body: 'Older body',
          createdAt: new Date('2026-07-19T00:00:00.000Z'),
        },
      }),
      owner.notification.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          type: 'SCHEDULE_PUBLISHED',
          title: 'Newer feed entry',
          body: 'Newer body',
          createdAt: new Date('2026-07-19T01:00:00.000Z'),
        },
      }),
      owner.notification.create({
        data: {
          tenantId: otherTenant.id,
          userId: otherUser.id,
          type: 'WARNING',
          title: 'Other tenant entry',
          body: 'Other body',
          createdAt: new Date('2026-07-19T02:00:00.000Z'),
        },
      }),
    ]);
    const primaryIdentity = identity(tenant.id, user.id);
    const isolatedIdentity = identity(otherTenant.id, otherUser.id);

    const firstPage = await notifications.list(primaryIdentity, { status: 'all', limit: '1' });
    assert.equal(firstPage.data.length, 1);
    assert.equal(firstPage.data[0].id, newer.publicId);
    assert.equal(firstPage.unreadCount, 2);
    assert.equal(firstPage.pagination.hasMore, true);
    assert.ok(firstPage.pagination.nextCursor);
    assert.equal(JSON.stringify(firstPage).includes(tenant.id), false);
    assert.equal(JSON.stringify(firstPage).includes(user.id), false);
    assert.equal(JSON.stringify(firstPage).includes(newer.id), false);

    const secondPage = await notifications.list(primaryIdentity, {
      status: 'all',
      limit: '1',
      cursor: firstPage.pagination.nextCursor,
    });
    assert.deepEqual(secondPage.data.map((entry) => entry.id), [older.publicId]);
    assert.equal(secondPage.pagination.hasMore, false);

    const markOne = await notifications.markRead(primaryIdentity, [newer.publicId, isolated.publicId]);
    assert.deepEqual(markOne, { updated: 1, unreadCount: 1 });
    const markAll = await notifications.markAllRead(primaryIdentity);
    assert.deepEqual(markAll, { success: true, updated: 1, unreadCount: 0 });

    const [primaryRows, isolatedFeed, isolatedRow] = await Promise.all([
      owner.notification.findMany({ where: { tenantId: tenant.id, userId: user.id }, select: { publicId: true, readAt: true } }),
      notifications.list(isolatedIdentity, { status: 'all', limit: '20' }),
      owner.notification.findUniqueOrThrow({ where: { id: isolated.id }, select: { readAt: true } }),
    ]);
    assert.equal(primaryRows.length, 2);
    assert.ok(primaryRows.every((row) => row.readAt instanceof Date));
    assert.deepEqual(isolatedFeed.data.map((entry) => entry.id), [isolated.publicId]);
    assert.equal(isolatedRow.readAt, null);
  } finally {
    await owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      const tenantIds = [fixture.tenantId, fixture.otherTenantId];
      await transaction.notification.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await transaction.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }).catch(() => {});
    await Promise.allSettled([app.$disconnect(), owner.$disconnect()]);
  }
});
