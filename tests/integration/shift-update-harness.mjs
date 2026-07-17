import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { FeatureAccessService } = require('../../apps/api/src/billing/feature-access.service.ts');
const { MeteringService } = require('../../apps/api/src/billing/metering.service.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');
const { ShiftsController } = require('../../apps/api/src/shifts/shifts.controller.ts');
const { shiftBulkAssignmentOperationId } = require('../../apps/api/src/shifts/shift-bulk-assignment-idempotency.ts');
const { shiftUpdateOperationId } = require('../../apps/api/src/shifts/shift-update-idempotency.ts');

export function createShiftUpdateHarness() {
  const appPrisma = createPrisma(requireServiceUrl('DATABASE_URL').toString());
  const ownerPrisma = createPrisma(requireServiceUrl('MIGRATION_DATABASE_URL').toString());
  const tenantDb = new TenantPrismaService(appPrisma);
  const metering = new MeteringService(tenantDb);
  const featureAccess = new FeatureAccessService(metering, tenantDb);
  const controller = new ShiftsController(featureAccess, tenantDb);

  return {
    appPrisma,
    controller,
    ownerPrisma,
    shiftBulkAssignmentOperationId,
    shiftUpdateOperationId,
    async disconnect() {
      await Promise.allSettled([appPrisma.$disconnect(), ownerPrisma.$disconnect()]);
    },
  };
}

export function shiftUpdateRequest(tenantId, actorUserId) {
  return { user: { tenantId, sub: actorUserId, role: 'MANAGER' } };
}

export async function createShiftUpdateFixture(prisma) {
  const runId = randomUUID();
  const primary = {
    tenantId: `tenant-shift-update-primary-${runId}`,
    managerId: `manager-shift-update-primary-${runId}`,
    staffId: `staff-shift-update-primary-${runId}`,
    locationId: `location-shift-update-primary-${runId}`,
    draftScheduleId: `schedule-shift-update-draft-${runId}`,
    publishedScheduleId: `schedule-shift-update-published-${runId}`,
    archivedScheduleId: `schedule-shift-update-archived-${runId}`,
    atomicShiftId: `shift-update-atomic-${runId}`,
    atomicBreakId: `break-update-atomic-${runId}`,
    collisionShiftId: `shift-update-collision-${runId}`,
    collisionBreakId: `break-update-collision-${runId}`,
    collisionBlockerShiftId: `shift-update-collision-blocker-${runId}`,
    rollbackShiftId: `shift-update-rollback-${runId}`,
    rollbackBreakId: `break-update-rollback-${runId}`,
    rollbackBlockerShiftId: `shift-update-rollback-blocker-${runId}`,
    concurrentShiftId: `shift-update-concurrent-${runId}`,
    bulkNoOpShiftId: `shift-bulk-no-op-${runId}`,
    bulkChangedShiftId: `shift-bulk-changed-${runId}`,
    bulkReplayShiftId: `shift-bulk-replay-${runId}`,
    publishedShiftId: `shift-update-published-${runId}`,
    archivedShiftId: `shift-update-archived-${runId}`,
  };
  const isolated = {
    tenantId: `tenant-shift-update-isolated-${runId}`,
    managerId: `manager-shift-update-isolated-${runId}`,
    staffId: `staff-shift-update-isolated-${runId}`,
    locationId: `location-shift-update-isolated-${runId}`,
    scheduleId: `schedule-shift-update-isolated-${runId}`,
    bulkShiftId: `shift-bulk-isolated-${runId}`,
  };

  await prisma.$transaction(async (tx) => {
    await tx.tenant.createMany({
      data: [
        {
          id: primary.tenantId,
          name: 'Shift Update Primary',
          slug: `shift-update-primary-${runId}`,
          planTier: 'STARTER',
          status: 'ACTIVE',
          stripeSubscriptionId: `sub_shift_update_primary_${runId}`,
          usageCredits: 20,
        },
        {
          id: isolated.tenantId,
          name: 'Shift Update Isolated',
          slug: `shift-update-isolated-${runId}`,
          planTier: 'STARTER',
          status: 'ACTIVE',
          stripeSubscriptionId: `sub_shift_update_isolated_${runId}`,
          usageCredits: 0,
        },
      ],
    });
    await tx.location.createMany({
      data: [
        { id: primary.locationId, tenantId: primary.tenantId, name: 'Primary Location', timezone: 'UTC' },
        { id: isolated.locationId, tenantId: isolated.tenantId, name: 'Isolated Location', timezone: 'UTC' },
      ],
    });
    await tx.user.createMany({
      data: [
        { id: primary.managerId, tenantId: primary.tenantId, name: 'Primary Manager', role: 'MANAGER', mfaBackupCodes: [] },
        { id: primary.staffId, tenantId: primary.tenantId, name: 'Primary Staff', role: 'STAFF', mfaBackupCodes: [] },
        { id: isolated.managerId, tenantId: isolated.tenantId, name: 'Isolated Manager', role: 'MANAGER', mfaBackupCodes: [] },
        { id: isolated.staffId, tenantId: isolated.tenantId, name: 'Isolated Staff', role: 'STAFF', mfaBackupCodes: [] },
      ],
    });
    await tx.schedule.createMany({
      data: [
        {
          id: primary.draftScheduleId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          startDate: new Date('2026-08-10T00:00:00.000Z'),
          endDate: new Date('2026-08-13T00:00:00.000Z'),
          status: 'DRAFT',
        },
        {
          id: primary.publishedScheduleId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          startDate: new Date('2026-08-13T00:00:00.000Z'),
          endDate: new Date('2026-08-14T00:00:00.000Z'),
          status: 'PUBLISHED',
          publishedAt: new Date('2026-08-12T12:00:00.000Z'),
        },
        {
          id: primary.archivedScheduleId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          startDate: new Date('2026-08-14T00:00:00.000Z'),
          endDate: new Date('2026-08-15T00:00:00.000Z'),
          status: 'ARCHIVED',
        },
        {
          id: isolated.scheduleId,
          tenantId: isolated.tenantId,
          locationId: isolated.locationId,
          startDate: new Date('2026-08-10T00:00:00.000Z'),
          endDate: new Date('2026-08-15T00:00:00.000Z'),
          status: 'DRAFT',
        },
      ],
    });
    await tx.shift.createMany({
      data: [
        {
          id: primary.atomicShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.draftScheduleId,
          userId: primary.staffId,
          startTime: new Date('2026-08-10T09:00:00.000Z'),
          endTime: new Date('2026-08-10T17:00:00.000Z'),
          role: 'STAFF',
        },
        {
          id: primary.collisionShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.draftScheduleId,
          userId: primary.staffId,
          startTime: new Date('2026-08-11T08:00:00.000Z'),
          endTime: new Date('2026-08-11T11:00:00.000Z'),
          role: 'STAFF',
        },
        {
          id: primary.collisionBlockerShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.draftScheduleId,
          userId: primary.staffId,
          startTime: new Date('2026-08-11T12:00:00.000Z'),
          endTime: new Date('2026-08-11T16:00:00.000Z'),
          role: 'STAFF',
        },
        {
          id: primary.rollbackShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.draftScheduleId,
          userId: primary.staffId,
          startTime: new Date('2026-08-12T18:00:00.000Z'),
          endTime: new Date('2026-08-12T20:00:00.000Z'),
          role: 'STAFF',
        },
        {
          id: primary.concurrentShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.draftScheduleId,
          userId: primary.staffId,
          startTime: new Date('2026-08-12T09:00:00.000Z'),
          endTime: new Date('2026-08-12T17:00:00.000Z'),
          role: 'STAFF',
        },
        {
          id: primary.bulkNoOpShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.draftScheduleId,
          userId: primary.staffId,
          startTime: new Date('2026-08-10T18:00:00.000Z'),
          endTime: new Date('2026-08-10T19:00:00.000Z'),
          role: 'STAFF',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: primary.bulkChangedShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.draftScheduleId,
          userId: null,
          startTime: new Date('2026-08-10T19:00:00.000Z'),
          endTime: new Date('2026-08-10T20:00:00.000Z'),
          role: 'STAFF',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: primary.bulkReplayShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.draftScheduleId,
          userId: null,
          startTime: new Date('2026-08-10T20:00:00.000Z'),
          endTime: new Date('2026-08-10T21:00:00.000Z'),
          role: 'STAFF',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: primary.publishedShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.publishedScheduleId,
          userId: primary.staffId,
          startTime: new Date('2026-08-13T09:00:00.000Z'),
          endTime: new Date('2026-08-13T17:00:00.000Z'),
          role: 'STAFF',
        },
        {
          id: primary.archivedShiftId,
          tenantId: primary.tenantId,
          locationId: primary.locationId,
          scheduleId: primary.archivedScheduleId,
          userId: primary.staffId,
          startTime: new Date('2026-08-14T09:00:00.000Z'),
          endTime: new Date('2026-08-14T17:00:00.000Z'),
          role: 'STAFF',
        },
        {
          id: isolated.bulkShiftId,
          tenantId: isolated.tenantId,
          locationId: isolated.locationId,
          scheduleId: isolated.scheduleId,
          userId: null,
          startTime: new Date('2026-08-10T10:00:00.000Z'),
          endTime: new Date('2026-08-10T12:00:00.000Z'),
          role: 'STAFF',
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    await tx.break.createMany({
      data: [
        {
          id: primary.atomicBreakId,
          shiftId: primary.atomicShiftId,
          type: 'LUNCH',
          startTime: new Date('2026-08-10T12:00:00.000Z'),
          endTime: new Date('2026-08-10T12:30:00.000Z'),
        },
        {
          id: primary.rollbackBreakId,
          shiftId: primary.rollbackShiftId,
          type: 'BREAK1',
          startTime: new Date('2026-08-12T18:30:00.000Z'),
          endTime: new Date('2026-08-12T18:45:00.000Z'),
        },
        {
          id: primary.collisionBreakId,
          shiftId: primary.collisionShiftId,
          type: 'BREAK1',
          startTime: new Date('2026-08-11T09:00:00.000Z'),
          endTime: new Date('2026-08-11T09:15:00.000Z'),
        },
      ],
    });
  });

  return { primary, isolated };
}

export async function cleanupShiftUpdateFixture(prisma, fixture) {
  if (!fixture) return;
  const tenantIds = [fixture.primary.tenantId, fixture.isolated.tenantId];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.creditTransaction.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.break.deleteMany({ where: { shift: { tenantId: { in: tenantIds } } } });
    await tx.shift.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.schedule.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.location.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  });
}

export async function readShiftUpdateState(prisma, tenantId, shiftId, breakId) {
  const [tenant, shift, shiftBreak, ledgerCount, auditCount] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { usageCredits: true } }),
    shiftId
      ? prisma.shift.findUniqueOrThrow({
        where: { id: shiftId },
        select: { userId: true, startTime: true, endTime: true, role: true, updatedAt: true },
      })
      : null,
    breakId
      ? prisma.break.findUniqueOrThrow({
        where: { id: breakId },
        select: { startTime: true, endTime: true },
      })
      : null,
    prisma.creditTransaction.count({ where: { tenantId } }),
    prisma.auditLog.count({ where: { tenantId, action: 'SHIFT_UPDATED' } }),
  ]);
  return {
    usageCredits: tenant.usageCredits,
    shift,
    shiftBreak,
    ledgerCount,
    auditCount,
  };
}

export async function readShiftBulkAssignmentState(prisma, tenantId, shiftIds) {
  const [tenant, shifts, ledgerCount, auditCount] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { usageCredits: true } }),
    prisma.shift.findMany({
      where: { id: { in: shiftIds } },
      orderBy: { id: 'asc' },
      select: { id: true, userId: true, updatedAt: true },
    }),
    prisma.creditTransaction.count({ where: { tenantId } }),
    prisma.auditLog.count({ where: { tenantId, action: 'SHIFT_BULK_ASSIGNED' } }),
  ]);
  return {
    usageCredits: tenant.usageCredits,
    shifts,
    ledgerCount,
    auditCount,
  };
}
