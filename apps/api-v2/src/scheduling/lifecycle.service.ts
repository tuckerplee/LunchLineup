import { randomUUID } from 'node:crypto';
import {
  ScheduleReopenResponseSchema,
  type SessionIdentity,
  type ScheduleReopenResponse,
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
import { assertSchedulingEntitled, lockSchedulingAggregate } from './entitlement';
import { serializeSchedule } from './serialization';

type LockedSchedule = {
  id: string;
  publicId: string;
  locationId: string;
  locationPublicId: string;
  startDate: Date;
  endDate: Date;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: Date | null;
  revision: number;
};

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class ScheduleLifecycleService {
  constructor(private readonly database: TenantDatabase) {}

  private async replay(
    transaction: TenantTransaction,
    tenantId: string,
    idempotencyKeyHash: string,
    expectedRequestHash: string,
  ): Promise<ScheduleReopenResponse | null> {
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
    if (!matchesContract(ScheduleReopenResponseSchema, stored.response)) {
      throw new ProblemError(
        409,
        'idempotency_result_unavailable',
        'The stored idempotent result is unavailable. Use a new Idempotency-Key.',
        'Idempotency conflict',
      );
    }
    return stored.response;
  }

  async reopen(
    identity: SessionIdentity,
    schedulePublicId: string,
    headers: { ifMatch?: string; idempotencyKey?: string },
    metadata: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<ScheduleReopenResponse> {
    requirePermissions(identity, ['schedules:publish']);
    const baseRevision = requireScheduleRevision(headers.ifMatch, schedulePublicId);
    const idempotencyKey = requireIdempotencyKey(headers.idempotencyKey);
    const idempotencyKeyHash = sha256(idempotencyKey);
    const expectedRequestHash = requestHash({
      operation: 'schedule.reopen',
      schedulePublicId,
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

      const rows = await transaction.$queryRaw<LockedSchedule[]>(Prisma.sql`
        SELECT
          schedule_row."id",
          schedule_row."publicId"::text AS "publicId",
          schedule_row."locationId",
          location_row."publicId"::text AS "locationPublicId",
          schedule_row."startDate",
          schedule_row."endDate",
          schedule_row."status"::text AS "status",
          schedule_row."publishedAt",
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
      const schedule = rows[0];
      if (!schedule) {
        throw new ProblemError(404, 'schedule_not_found', 'The selected schedule was not found.', 'Schedule not found');
      }
      if (schedule.status !== 'PUBLISHED') {
        throw new ProblemError(
          409,
          'schedule_not_published',
          'Only a published schedule can be reopened.',
          'Schedule state conflict',
        );
      }
      if (schedule.revision !== baseRevision) {
        throw new ProblemError(
          412,
          'stale_schedule_revision',
          'The schedule changed after this board loaded. Reload before reopening it.',
          'Precondition failed',
          undefined,
          scheduleEtag(schedule.publicId, schedule.revision),
        );
      }

      const updated = await transaction.schedule.updateMany({
        where: {
          id: schedule.id,
          tenantId: identity.tenantId,
          status: 'PUBLISHED',
          revision: baseRevision,
          deletedAt: null,
        },
        data: {
          status: 'DRAFT',
          publishedAt: null,
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ProblemError(
          412,
          'stale_schedule_revision',
          'The schedule changed while it was reopening. Reload before retrying.',
          'Precondition failed',
        );
      }

      const changeSetId = randomUUID();
      const revision = baseRevision + 1;
      const response: ScheduleReopenResponse = {
        data: serializeSchedule({
          ...schedule,
          status: 'DRAFT',
          publishedAt: null,
          revision,
        }, schedule.locationPublicId),
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
          request: inputJson({ operation: 'schedule.reopen' }),
          response: inputJson(response),
        },
      });
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId,
          userId: identity.sub,
          actorUserId: identity.sub,
          actorTenantId: identity.tenantId,
          action: 'SCHEDULE_REOPENED',
          resource: 'schedule',
          resourceId: schedule.publicId,
          oldValue: { status: 'PUBLISHED', revision: baseRevision },
          newValue: { status: 'DRAFT', revision },
          ipAddress: metadata.ipAddress?.slice(0, 128),
          userAgent: metadata.userAgent?.slice(0, 512),
        },
      });
      return response;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
