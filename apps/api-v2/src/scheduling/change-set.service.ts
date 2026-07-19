import { randomUUID } from 'node:crypto';
import {
  ScheduleChangeSetResponseSchema,
  type LegacyIdentity,
  type ScheduleChangeSetRequest,
  type ScheduleChangeSetResponse,
} from '@lunchlineup/api-contract';
import { Prisma } from '@prisma/client';
import { TenantDatabase, type TenantTransaction } from '../platform/database';
import { matchesContract } from '../platform/contract-check';
import { requirePermissions } from '../platform/identity';
import { ProblemError } from '../platform/problem';
import {
  requestHash,
  requireIdempotencyKey,
  requireScheduleRevision,
  scheduleEtag,
  sha256,
} from './contract-helpers';
import {
  planScheduleChangeSet,
  type ExternalShift,
  type PlannedShift,
  type ShiftMutation,
} from './change-set-plan';
import { assertSchedulingEntitled, lockSchedulingAggregate } from './entitlement';
import {
  serializeShift,
  type PublicShiftRow,
} from './serialization';

const MAX_SCHEDULE_SHIFTS = 5000;
const MAX_EXTERNAL_SHIFTS = 10_000;

type LockedSchedule = {
  id: string;
  publicId: string;
  locationId: string;
  locationPublicId: string;
  startDate: Date;
  endDate: Date;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  revision: number;
};

type StoredShift = Omit<PublicShiftRow, 'breaks'> & {
  breaks: Array<{
    id: string;
    startTime: Date;
    endTime: Date;
    paid: boolean;
  }>;
};

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function plannedShift(row: StoredShift): PlannedShift {
  return {
    internalId: row.id,
    publicId: row.publicId,
    userInternalId: row.userId,
    userPublicId: row.user?.publicId ?? null,
    startTime: row.startTime,
    endTime: row.endTime,
    role: row.role,
    breaks: row.breaks.map((item) => ({
      internalId: item.id,
      startTime: item.startTime,
      endTime: item.endTime,
    })),
    sourcePointer: '/saved',
  };
}

export class ScheduleChangeSetService {
  constructor(private readonly database: TenantDatabase) {}

  private authorize(identity: LegacyIdentity, body: ScheduleChangeSetRequest): void {
    if (body.operations.some((operation) => operation.op === 'shift.delete')) {
      requirePermissions(identity, ['shifts:delete']);
    }
    if (body.operations.some((operation) => operation.op !== 'shift.delete')) {
      requirePermissions(identity, ['shifts:write']);
    }
  }

  private async replay(
    transaction: TenantTransaction,
    tenantId: string,
    idempotencyKeyHash: string,
    expectedRequestHash: string,
  ): Promise<ScheduleChangeSetResponse | null> {
    const stored = await transaction.scheduleChangeSet.findUnique({
      where: {
        tenantId_idempotencyKeyHash: {
          tenantId,
          idempotencyKeyHash,
        },
      },
      select: {
        requestHash: true,
        response: true,
      },
    });
    if (!stored) return null;
    if (stored.requestHash !== expectedRequestHash) {
      throw new ProblemError(
        409,
        'idempotency_key_reused',
        'Idempotency-Key was already used for a different schedule change.',
        'Idempotency conflict',
      );
    }
    if (!matchesContract(ScheduleChangeSetResponseSchema, stored.response)) {
      throw new ProblemError(
        409,
        'idempotency_result_unavailable',
        'The stored idempotent result is unavailable. Use a new Idempotency-Key.',
        'Idempotency conflict',
      );
    }
    return stored.response;
  }

  private async applyMutation(
    transaction: TenantTransaction,
    identity: LegacyIdentity,
    schedule: LockedSchedule,
    mutation: ShiftMutation,
    deletedAt: Date,
  ): Promise<void> {
    if (mutation.kind === 'delete') {
      const deleted = await transaction.shift.updateMany({
        where: {
          id: mutation.before.internalId as string,
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
          deletedAt: null,
        },
        data: { deletedAt },
      });
      if (deleted.count !== 1) {
        throw new ProblemError(409, 'concurrent_change', 'A shift changed while the change set was applying.', 'Concurrent change');
      }
      return;
    }
    if (mutation.kind === 'create') {
      await transaction.shift.create({
        data: {
          publicId: mutation.after.publicId,
          tenantId: identity.tenantId,
          locationId: schedule.locationId,
          scheduleId: schedule.id,
          userId: mutation.after.userInternalId,
          startTime: mutation.after.startTime,
          endTime: mutation.after.endTime,
          role: mutation.after.role,
        },
      });
      return;
    }

    const updated = await transaction.shift.updateMany({
      where: {
        id: mutation.before.internalId as string,
        tenantId: identity.tenantId,
        scheduleId: schedule.id,
        deletedAt: null,
      },
      data: {
        userId: mutation.after.userInternalId,
        startTime: mutation.after.startTime,
        endTime: mutation.after.endTime,
        role: mutation.after.role,
      },
    });
    if (updated.count !== 1) {
      throw new ProblemError(409, 'concurrent_change', 'A shift changed while the change set was applying.', 'Concurrent change');
    }
    for (const item of mutation.after.breaks) {
      const translated = await transaction.break.updateMany({
        where: {
          id: item.internalId,
          shiftId: mutation.before.internalId as string,
        },
        data: {
          startTime: item.startTime,
          endTime: item.endTime,
        },
      });
      if (translated.count !== 1) {
        throw new ProblemError(
          409,
          'dependent_break_changed',
          'A dependent break changed while the shift was moving. Reload and retry.',
          'Concurrent change',
        );
      }
    }
  }

  async apply(
    identity: LegacyIdentity,
    schedulePublicId: string,
    body: ScheduleChangeSetRequest,
    headers: { ifMatch?: string; idempotencyKey?: string },
    metadata: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<ScheduleChangeSetResponse> {
    this.authorize(identity, body);
    const baseRevision = requireScheduleRevision(headers.ifMatch, schedulePublicId);
    const idempotencyKey = requireIdempotencyKey(headers.idempotencyKey);
    const idempotencyKeyHash = sha256(idempotencyKey);
    const expectedRequestHash = requestHash({
      schedulePublicId,
      body,
    });

    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const initialReplay = await this.replay(
        transaction,
        identity.tenantId,
        idempotencyKeyHash,
        expectedRequestHash,
      );
      if (initialReplay) return initialReplay;

      await assertSchedulingEntitled(transaction, identity.tenantId);
      await lockSchedulingAggregate(transaction, identity.tenantId);
      const lockedReplay = await this.replay(
        transaction,
        identity.tenantId,
        idempotencyKeyHash,
        expectedRequestHash,
      );
      if (lockedReplay) return lockedReplay;

      const schedules = await transaction.$queryRaw<LockedSchedule[]>(Prisma.sql`
        SELECT
          schedule_row."id",
          schedule_row."publicId"::text AS "publicId",
          schedule_row."locationId",
          location_row."publicId"::text AS "locationPublicId",
          schedule_row."startDate",
          schedule_row."endDate",
          schedule_row."status"::text AS "status",
          schedule_row."revision"
        FROM "Schedule" schedule_row
        JOIN "Location" location_row
          ON location_row."id" = schedule_row."locationId"
         AND location_row."tenantId" = schedule_row."tenantId"
         AND location_row."deletedAt" IS NULL
        WHERE schedule_row."tenantId" = ${identity.tenantId}
          AND schedule_row."publicId" = CAST(${schedulePublicId} AS uuid)
          AND schedule_row."deletedAt" IS NULL
        FOR UPDATE OF schedule_row
      `);
      const schedule = schedules[0];
      if (!schedule) {
        throw new ProblemError(404, 'schedule_not_found', 'The selected schedule was not found.', 'Schedule not found');
      }
      if (schedule.status !== 'DRAFT') {
        throw new ProblemError(
          409,
          'schedule_locked',
          'Published or archived schedules are locked. Reopen the schedule before changing shifts.',
          'Schedule locked',
        );
      }
      if (schedule.revision !== baseRevision) {
        throw new ProblemError(
          412,
          'stale_schedule_revision',
          'The schedule changed after this board loaded. Reload before saving.',
          'Precondition failed',
          undefined,
          scheduleEtag(schedule.publicId, schedule.revision),
        );
      }

      const rows = await transaction.shift.findMany({
        where: {
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
          deletedAt: null,
        },
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        take: MAX_SCHEDULE_SHIFTS + 1,
        select: {
          id: true,
          publicId: true,
          userId: true,
          locationId: true,
          scheduleId: true,
          startTime: true,
          endTime: true,
          role: true,
          user: {
            select: {
              id: true,
              publicId: true,
              name: true,
              role: true,
            },
          },
          breaks: {
            orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              startTime: true,
              endTime: true,
              paid: true,
            },
          },
        },
      });
      if (rows.length > MAX_SCHEDULE_SHIFTS) {
        throw new ProblemError(
          422,
          'schedule_too_large',
          'This schedule contains too many shifts for one safe aggregate change.',
          'Schedule too large',
        );
      }
      const currentRows = rows as unknown as StoredShift[];
      const requestedUserIds = new Set<string>();
      for (const operation of body.operations) {
        if ('userId' in operation && typeof operation.userId === 'string') {
          requestedUserIds.add(operation.userId);
        }
      }
      const requestedUsers = requestedUserIds.size > 0
        ? await transaction.user.findMany({
            where: {
              tenantId: identity.tenantId,
              publicId: { in: [...requestedUserIds] },
              deletedAt: null,
              suspendedAt: null,
              role: { in: ['MANAGER', 'STAFF'] },
            },
            select: {
              id: true,
              publicId: true,
            },
          })
        : [];
      const usersByPublicId = new Map(requestedUsers.map((user) => [
        user.publicId,
        { internalId: user.id, publicId: user.publicId },
      ]));
      const involvedUserIds = new Set<string>([
        ...currentRows.flatMap((row) => row.userId ? [row.userId] : []),
        ...requestedUsers.map((user) => user.id),
      ]);
      const externalRows = involvedUserIds.size > 0
        ? await transaction.shift.findMany({
            where: {
              tenantId: identity.tenantId,
              scheduleId: { not: schedule.id },
              userId: { in: [...involvedUserIds] },
              deletedAt: null,
              startTime: { lt: schedule.endDate },
              endTime: { gt: schedule.startDate },
            },
            orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
            take: MAX_EXTERNAL_SHIFTS + 1,
            select: {
              id: true,
              userId: true,
              startTime: true,
              endTime: true,
            },
          })
        : [];
      if (externalRows.length > MAX_EXTERNAL_SHIFTS) {
        throw new ProblemError(
          422,
          'schedule_validation_too_large',
          'Too many related shifts exist to validate this change safely.',
          'Schedule validation limit',
        );
      }
      const externalShifts: ExternalShift[] = externalRows.flatMap((row) => row.userId
        ? [{
            internalId: row.id,
            userInternalId: row.userId,
            startTime: row.startTime,
            endTime: row.endTime,
          }]
        : []);
      const plan = planScheduleChangeSet({
        scheduleStart: schedule.startDate,
        scheduleEnd: schedule.endDate,
        currentShifts: currentRows.map(plannedShift),
        externalShifts,
        usersByPublicId,
        operations: body.operations,
      });

      await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
      const deletedAt = new Date();
      for (const mutation of plan.mutations.filter((item) => item.kind === 'delete')) {
        await this.applyMutation(transaction, identity, schedule, mutation, deletedAt);
      }
      for (const mutation of plan.mutations.filter((item) => item.kind === 'update')) {
        await this.applyMutation(transaction, identity, schedule, mutation, deletedAt);
      }
      for (const mutation of plan.mutations.filter((item) => item.kind === 'create')) {
        await this.applyMutation(transaction, identity, schedule, mutation, deletedAt);
      }

      const revised = await transaction.schedule.updateMany({
        where: {
          id: schedule.id,
          tenantId: identity.tenantId,
          status: 'DRAFT',
          deletedAt: null,
          revision: baseRevision,
        },
        data: { revision: { increment: 1 } },
      });
      if (revised.count !== 1) {
        throw new ProblemError(
          412,
          'stale_schedule_revision',
          'The schedule changed while this change set was applying. Reload before saving.',
          'Precondition failed',
        );
      }

      const resultRows = await transaction.shift.findMany({
        where: {
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
          deletedAt: null,
        },
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          publicId: true,
          userId: true,
          locationId: true,
          scheduleId: true,
          startTime: true,
          endTime: true,
          role: true,
          user: {
            select: {
              id: true,
              publicId: true,
              name: true,
              role: true,
            },
          },
          breaks: {
            orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
            select: {
              startTime: true,
              endTime: true,
              paid: true,
            },
          },
        },
      });
      const changeSetId = randomUUID();
      const revision = baseRevision + 1;
      const response: ScheduleChangeSetResponse = {
        data: {
          changeSetId,
          scheduleId: schedule.publicId,
          baseRevision,
          revision,
          etag: scheduleEtag(schedule.publicId, revision),
          shifts: (resultRows as unknown as PublicShiftRow[]).map((row) => (
            serializeShift(row, schedule.locationPublicId, schedule.publicId)
          )),
          created: plan.created,
        },
      };
      await transaction.scheduleChangeSet.create({
        data: {
          id: changeSetId,
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
          actorUserId: identity.sub,
          idempotencyKeyHash,
          requestHash: expectedRequestHash,
          baseRevision,
          resultRevision: revision,
          request: inputJson(body),
          response: inputJson(response),
        },
      });
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId,
          userId: identity.sub,
          actorUserId: identity.sub,
          actorTenantId: identity.tenantId,
          action: 'SCHEDULE_CHANGE_SET_APPLIED',
          resource: 'schedule_change_set',
          resourceId: changeSetId,
          oldValue: {
            scheduleId: schedule.publicId,
            revision: baseRevision,
          },
          newValue: {
            scheduleId: schedule.publicId,
            revision,
            operationCount: body.operations.length,
            createdShiftCount: plan.mutations.filter((item) => item.kind === 'create').length,
            updatedShiftCount: plan.mutations.filter((item) => item.kind === 'update').length,
            deletedShiftCount: plan.mutations.filter((item) => item.kind === 'delete').length,
          },
          ipAddress: metadata.ipAddress?.slice(0, 128),
          userAgent: metadata.userAgent?.slice(0, 512),
        },
      });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
