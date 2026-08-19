import { randomUUID } from 'node:crypto';
import {
  DemandWindowReplaceResponseSchema,
  type DemandWindowListResponse,
  type DemandWindowReplaceRequest,
  type DemandWindowReplaceResponse,
  type SessionIdentity,
} from '@lunchlineup/api-contract';
import { Prisma } from '@prisma/client';
import { TenantDatabase, type TenantTransaction } from '../platform/database';
import { matchesContract } from '../platform/contract-check';
import { requirePermissions } from '../platform/identity';
import { ProblemError } from '../platform/problem';
import {
  parseUtcInstant,
  requestHash,
  requireIdempotencyKey,
  requireScheduleRevision,
  scheduleEtag,
  sha256,
} from './contract-helpers';
import { assertSchedulingEntitled, lockSchedulingAggregate } from './entitlement';

type LockedDemandSchedule = {
  id: string;
  publicId: string;
  locationId: string;
  startDate: Date;
  endDate: Date;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  revision: number;
};

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function serializeWindows(rows: Array<{
  publicId: string;
  startTime: Date;
  endTime: Date;
  requiredStaff: number;
  skill: string | null;
}>): DemandWindowListResponse['data'] {
  return rows.map((row) => ({
    id: row.publicId,
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
    requiredStaff: row.requiredStaff,
    skill: row.skill,
  }));
}

export class DemandWindowService {
  constructor(private readonly database: TenantDatabase) {}

  private async replay(
    transaction: TenantTransaction,
    tenantId: string,
    idempotencyKeyHash: string,
    expectedRequestHash: string,
  ): Promise<DemandWindowReplaceResponse | null> {
    const stored = await transaction.scheduleChangeSet.findUnique({
      where: {
        tenantId_idempotencyKeyHash: {
          tenantId,
          idempotencyKeyHash,
        },
      },
      select: { requestHash: true, response: true },
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
    if (!matchesContract(DemandWindowReplaceResponseSchema, stored.response)) {
      throw new ProblemError(
        409,
        'idempotency_result_unavailable',
        'The stored idempotent result is unavailable. Use a new Idempotency-Key.',
        'Idempotency conflict',
      );
    }
    return stored.response;
  }

  async list(
    identity: SessionIdentity,
    schedulePublicId: string,
  ): Promise<DemandWindowListResponse> {
    requirePermissions(identity, ['schedules:write']);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const schedule = await transaction.schedule.findFirst({
        where: {
          tenantId: identity.tenantId,
          publicId: schedulePublicId,
          deletedAt: null,
        },
        select: { id: true, locationId: true },
      });
      if (!schedule) {
        throw new ProblemError(404, 'schedule_not_found', 'The selected schedule was not found.', 'Schedule not found');
      }
      const rows = await transaction.scheduleDemandWindow.findMany({
        where: {
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
          locationId: schedule.locationId,
        },
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        take: 501,
        select: {
          publicId: true,
          startTime: true,
          endTime: true,
          requiredStaff: true,
          skill: true,
        },
      });
      if (rows.length > 500) {
        throw new ProblemError(
          422,
          'demand_window_limit_exceeded',
          'This schedule contains too many demand windows for one safe response.',
          'Demand window limit',
        );
      }
      return { data: serializeWindows(rows) };
    });
  }

  async replace(
    identity: SessionIdentity,
    schedulePublicId: string,
    body: DemandWindowReplaceRequest,
    headers: { ifMatch?: string; idempotencyKey?: string },
    metadata: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<DemandWindowReplaceResponse> {
    requirePermissions(identity, ['schedules:write']);
    const baseRevision = requireScheduleRevision(headers.ifMatch, schedulePublicId);
    const idempotencyKey = requireIdempotencyKey(headers.idempotencyKey);
    const idempotencyKeyHash = sha256(idempotencyKey);
    const expectedRequestHash = requestHash({
      operation: 'demand-windows.replace',
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

      const schedules = await transaction.$queryRaw<LockedDemandSchedule[]>(Prisma.sql`
        SELECT
          schedule_row."id",
          schedule_row."publicId"::text AS "publicId",
          schedule_row."locationId",
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
          'Demand can be changed only on a draft schedule.',
          'Schedule locked',
        );
      }
      if (schedule.revision !== baseRevision) {
        throw new ProblemError(
          412,
          'stale_schedule_revision',
          'The schedule changed after this board loaded. Reload before saving demand.',
          'Precondition failed',
          undefined,
          scheduleEtag(schedule.publicId, schedule.revision),
        );
      }

      const windows = body.windows.map((window, index) => {
        const startTime = parseUtcInstant(window.startTime, `/windows/${index}/startTime`);
        const endTime = parseUtcInstant(window.endTime, `/windows/${index}/endTime`);
        if (endTime <= startTime) {
          throw new ProblemError(
            422,
            'invalid_demand_window',
            'Demand window end time must be after its start time.',
            'Demand validation failed',
            [{
              pointer: `/windows/${index}/endTime`,
              code: 'invalid_window',
              message: 'End time must be after start time.',
            }],
          );
        }
        if (startTime < schedule.startDate || endTime > schedule.endDate) {
          throw new ProblemError(
            422,
            'demand_outside_schedule',
            'Every demand window must stay inside the selected schedule.',
            'Demand validation failed',
            [{
              pointer: `/windows/${index}`,
              code: 'outside_schedule',
              message: 'Keep this demand window inside its schedule.',
            }],
          );
        }
        return {
          id: randomUUID(),
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
          locationId: schedule.locationId,
          startTime,
          endTime,
          requiredStaff: window.requiredStaff,
          skill: window.skill?.trim().toLowerCase() || null,
        };
      });

      await transaction.scheduleDemandWindow.deleteMany({
        where: {
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
          locationId: schedule.locationId,
        },
      });
      if (windows.length > 0) {
        await transaction.scheduleDemandWindow.createMany({ data: windows });
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
          'The schedule changed while demand was saving. Reload before retrying.',
          'Precondition failed',
        );
      }

      const savedRows = await transaction.scheduleDemandWindow.findMany({
        where: {
          tenantId: identity.tenantId,
          scheduleId: schedule.id,
          locationId: schedule.locationId,
        },
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        select: {
          publicId: true,
          startTime: true,
          endTime: true,
          requiredStaff: true,
          skill: true,
        },
      });
      const changeSetId = randomUUID();
      const revision = baseRevision + 1;
      const response: DemandWindowReplaceResponse = {
        data: serializeWindows(savedRows),
        changeSetId,
        scheduleId: schedule.publicId,
        baseRevision,
        revision,
        etag: scheduleEtag(schedule.publicId, revision),
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
          action: 'SCHEDULE_DEMAND_REPLACED',
          resource: 'schedule_change_set',
          resourceId: changeSetId,
          oldValue: { scheduleId: schedule.publicId, revision: baseRevision },
          newValue: {
            scheduleId: schedule.publicId,
            revision,
            demandWindowCount: savedRows.length,
          },
          ipAddress: metadata.ipAddress?.slice(0, 128),
          userAgent: metadata.userAgent?.slice(0, 512),
        },
      });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
