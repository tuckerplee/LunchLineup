import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  createPrisma,
  readSchedulePublishSideEffects,
  requireServiceUrl,
} from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { ConflictException } = require('@nestjs/common');
const { RbacService } = require('../../apps/api/src/auth/rbac.service.ts');
const { FeatureAccessService } = require('../../apps/api/src/billing/feature-access.service.ts');
const { MeteringService } = require('../../apps/api/src/billing/metering.service.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');
const { SchedulesController } = require('../../apps/api/src/schedules/schedules.controller.ts');
const { UsersController } = require('../../apps/api/src/users/users.controller.ts');

test('restricted user deletion revises each changed draft once and fences stale publish', { timeout: 60_000 }, async () => {
  const appPrisma = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const ownerPrisma = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const runId = randomUUID();
  const fixture = {
    tenantId: `tenant-user-delete-revision-${runId}`,
    locationId: `location-user-delete-revision-${runId}`,
    actorId: `actor-user-delete-revision-${runId}`,
    targetId: `target-user-delete-revision-${runId}`,
    otherId: `other-user-delete-revision-${runId}`,
    overflowTargetId: `overflow-user-delete-revision-${runId}`,
    actorSessionId: `session-user-delete-revision-${runId}`,
    schedules: Object.fromEntries(
      ['draftA', 'draftB', 'unchanged', 'published', 'archived', 'overflow']
        .map((name) => [name, `schedule-${name}-${runId}`]),
    ),
  };
  const scheduleIds = Object.values(fixture.schedules);

  try {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.tenant.create({
        data: {
          id: fixture.tenantId,
          name: 'User Deletion Revision Proof',
          slug: `user-delete-revision-${runId}`,
          planTier: 'GROWTH',
          status: 'ACTIVE',
          stripeSubscriptionId: `sub_user_delete_revision_${runId}`,
          usageCredits: 20,
        },
      });
      await tx.location.create({
        data: {
          id: fixture.locationId,
          tenantId: fixture.tenantId,
          name: 'User Deletion Revision Location',
          timezone: 'UTC',
        },
      });
      await tx.user.createMany({
        data: [
          { id: fixture.actorId, tenantId: fixture.tenantId, name: 'Deletion Actor', role: 'ADMIN', mfaBackupCodes: [] },
          { id: fixture.targetId, tenantId: fixture.tenantId, name: 'Deletion Target', role: 'STAFF', mfaBackupCodes: [] },
          { id: fixture.otherId, tenantId: fixture.tenantId, name: 'Other Staff', role: 'STAFF', mfaBackupCodes: [] },
          { id: fixture.overflowTargetId, tenantId: fixture.tenantId, name: 'Overflow Target', role: 'STAFF', mfaBackupCodes: [] },
        ],
      });
      await tx.session.create({
        data: {
          id: fixture.actorSessionId,
          userId: fixture.actorId,
          selectorHash: `selector-${runId}`,
          refreshToken: `refresh-${runId}`,
          ipAddress: '127.0.0.1',
          userAgent: 'user-deletion-schedule-revision-test',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const scheduleState = {
        draftA: ['DRAFT', 4],
        draftB: ['DRAFT', 8],
        unchanged: ['DRAFT', 12],
        published: ['PUBLISHED', 2],
        archived: ['ARCHIVED', 3],
        overflow: ['DRAFT', 2_147_483_647],
      };
      await tx.schedule.createMany({
        data: Object.entries(fixture.schedules).map(([name, id], index) => ({
          id,
          tenantId: fixture.tenantId,
          locationId: fixture.locationId,
          startDate: new Date(`2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
          endDate: new Date(`2026-10-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`),
          status: scheduleState[name][0],
          revision: scheduleState[name][1],
        })),
      });
      const shift = (id, scheduleName, userId, hour = 9) => ({
        id: `shift-${id}-${runId}`,
        tenantId: fixture.tenantId,
        locationId: fixture.locationId,
        scheduleId: scheduleName ? fixture.schedules[scheduleName] : null,
        userId,
        startTime: new Date(`2026-10-${String(Object.keys(fixture.schedules).indexOf(scheduleName) + 1 || 7).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`),
        endTime: new Date(`2026-10-${String(Object.keys(fixture.schedules).indexOf(scheduleName) + 1 || 7).padStart(2, '0')}T${String(hour + 4).padStart(2, '0')}:00:00.000Z`),
        role: 'STAFF',
      });
      await tx.shift.createMany({
        data: [
          shift('draft-a-1', 'draftA', fixture.targetId, 8),
          shift('draft-a-2', 'draftA', fixture.targetId, 13),
          shift('draft-b', 'draftB', fixture.targetId),
          shift('unchanged', 'unchanged', fixture.otherId),
          shift('published', 'published', fixture.targetId),
          shift('archived', 'archived', fixture.targetId),
          shift('schedule-less', null, fixture.targetId),
          shift('overflow', 'overflow', fixture.overflowTargetId),
        ],
      });
    });

    const tenantDb = new TenantPrismaService(appPrisma);
    const rbac = new RbacService(tenantDb);
    await rbac.assignLegacySystemRole(fixture.actorId, fixture.tenantId, 'ADMIN');
    await rbac.assignLegacySystemRole(fixture.targetId, fixture.tenantId, 'STAFF');
    await rbac.assignLegacySystemRole(fixture.overflowTargetId, fixture.tenantId, 'STAFF');
    const featureAccess = new FeatureAccessService(new MeteringService(tenantDb), tenantDb);
    const notifications = {
      enqueueInTransaction: async () => { throw new Error('stale publish reached notification enqueue'); },
      deliverPendingNow: async () => { throw new Error('stale publish reached notification delivery'); },
    };
    const schedules = new SchedulesController(
      notifications,
      featureAccess,
      tenantDb,
      new MeteringService(tenantDb),
      { enqueueEventInTransaction: async () => { throw new Error('stale publish reached webhook enqueue'); } },
    );
    const users = new UsersController({}, rbac, {}, tenantDb);
    const request = {
      user: {
        tenantId: fixture.tenantId,
        sub: fixture.actorId,
        sessionId: fixture.actorSessionId,
        role: 'ADMIN',
      },
    };
    const preflights = new Map();
    for (const name of ['draftA', 'draftB']) {
      preflights.set(name, await schedules.publishPreflight(fixture.schedules[name], request));
    }
    assert.equal(preflights.get('draftA').acceptedContract.version, 4);
    assert.equal(preflights.get('draftB').acceptedContract.version, 8);

    await users.deactivate(fixture.targetId, request);

    const scheduleRows = await ownerPrisma.schedule.findMany({
      where: { id: { in: scheduleIds } },
      select: { id: true, status: true, revision: true },
    });
    const state = Object.fromEntries(scheduleRows.map((row) => [row.id, row]));
    assert.equal(state[fixture.schedules.draftA].revision, 5);
    assert.equal(state[fixture.schedules.draftB].revision, 9);
    assert.equal(state[fixture.schedules.unchanged].revision, 12);
    assert.deepEqual(
      [state[fixture.schedules.published].status, state[fixture.schedules.published].revision],
      ['PUBLISHED', 2],
    );
    assert.deepEqual(
      [state[fixture.schedules.archived].status, state[fixture.schedules.archived].revision],
      ['ARCHIVED', 3],
    );
    assert.equal(await ownerPrisma.shift.count({
      where: { tenantId: fixture.tenantId, scheduleId: { in: [fixture.schedules.draftA, fixture.schedules.draftB] }, userId: null },
    }), 3);
    assert.equal(await ownerPrisma.shift.count({
      where: { tenantId: fixture.tenantId, scheduleId: { in: [fixture.schedules.published, fixture.schedules.archived] }, userId: fixture.targetId },
    }), 2);

    const beforeStalePublish = await readSchedulePublishSideEffects(appPrisma, fixture, scheduleIds);
    for (const name of ['draftA', 'draftB']) {
      await assert.rejects(
        schedules.publish(
          fixture.schedules[name],
          request,
          `stale-user-delete-${name}-${runId}`,
          { acceptedContract: preflights.get(name).acceptedContract },
        ),
        (error) => {
          assert.ok(error instanceof ConflictException);
          assert.equal(error.getStatus(), 409);
          assert.match(JSON.stringify(error.getResponse()), /Schedule or configured publish cost changed after confirmation/);
          return true;
        },
      );
    }
    assert.deepEqual(await readSchedulePublishSideEffects(appPrisma, fixture, scheduleIds), beforeStalePublish);

    await assert.rejects(users.deactivate(fixture.overflowTargetId, request));
    assert.equal((await ownerPrisma.user.findUniqueOrThrow({
      where: { id: fixture.overflowTargetId }, select: { deletedAt: true },
    })).deletedAt, null);
    assert.equal((await ownerPrisma.shift.findFirstOrThrow({
      where: { scheduleId: fixture.schedules.overflow }, select: { userId: true },
    })).userId, fixture.overflowTargetId);
    assert.equal((await ownerPrisma.schedule.findUniqueOrThrow({
      where: { id: fixture.schedules.overflow }, select: { revision: true },
    })).revision, 2_147_483_647);
  } finally {
    await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.notificationOutbox.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.notification.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.webhookDelivery.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.auditLog.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.creditTransaction.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.break.deleteMany({ where: { shift: { tenantId: fixture.tenantId } } });
      await tx.shift.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.schedule.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.roleAssignment.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.rolePermission.deleteMany({ where: { role: { tenantId: fixture.tenantId } } });
      await tx.role.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.session.deleteMany({ where: { user: { tenantId: fixture.tenantId } } });
      await tx.user.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.location.deleteMany({ where: { tenantId: fixture.tenantId } });
      await tx.tenant.deleteMany({ where: { id: fixture.tenantId } });
    }).catch(() => {});
    await Promise.allSettled([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
  }
});
