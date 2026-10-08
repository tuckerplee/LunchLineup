import { requireAnyPermission } from '../platform/identity';
import type { MfaSessionObserver } from '@lunchlineup/rbac';
import { immutableOperationsInput, operationsIdentity, operationsWait, prepareOperationsAuthority } from '../operations/operations.service';
import { randomUUID } from 'node:crypto';
import {
  ScheduleCreateResponseSchema,
  type SessionIdentity,
  type ScheduleCreateRequest,
  type ScheduleCreateResponse,
} from '@lunchlineup/api-contract';
import { Prisma } from '@prisma/client';
import { TenantDatabase, type TenantTransaction } from '../platform/database';
import { matchesContract } from '../platform/contract-check';
import { ProblemError } from '../platform/problem';
import {
  parseUtcInstant,
  requestHash,
  requireIdempotencyKey,
  sha256,
} from './contract-helpers';
import { assertSchedulingEntitled, lockSchedulingAggregate } from './entitlement';
import { serializeSchedule, type PublicScheduleRow } from './serialization';

const CREATE_ACTION = 'API_V2_SCHEDULE_CREATE';
const CREATE_RESOURCE = 'api_v2_schedule_create';
const MAX_SCHEDULE_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

type LockedLocation = {
  id: string;
  publicId: string;
};

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export class ScheduleCreateService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly observer?: Partial<MfaSessionObserver>,
  ) {}

  private async replay(
    transaction: TenantTransaction,
    tenantId: string,
    operationId: string,
    expectedRequestHash: string,
    assertCurrent: () => void,
  ): Promise<ScheduleCreateResponse | null> {
    const audit = await operationsWait(assertCurrent, () => transaction.auditLog.findFirst({
      where: {
        tenantId,
        action: CREATE_ACTION,
        resource: CREATE_RESOURCE,
        resourceId: operationId,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { newValue: true },
    }));
    if (!audit) return null;
    if (
      !audit.newValue
      || typeof audit.newValue !== 'object'
      || Array.isArray(audit.newValue)
      || (audit.newValue as Record<string, unknown>).requestHash !== expectedRequestHash
    ) {
      throw new ProblemError(
        409,
        'idempotency_key_reused',
        'Idempotency-Key was already used for a different schedule request.',
        'Idempotency conflict',
      );
    }
    const response = (audit.newValue as Record<string, unknown>).response;
    if (!matchesContract(ScheduleCreateResponseSchema, response)) {
      throw new ProblemError(
        409,
        'idempotency_result_unavailable',
        'The stored idempotent result is unavailable. Use a new Idempotency-Key.',
        'Idempotency conflict',
      );
    }
    return response;
  }

  async create(
    identity: SessionIdentity,
    locationPublicId: string,
    body: ScheduleCreateRequest,
    idempotencyKeyValue: string | undefined,
    metadata: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<ScheduleCreateResponse> {
    identity = operationsIdentity(identity);
    body = immutableOperationsInput(body);
    metadata = immutableOperationsInput(metadata);
    requireAnyPermission(identity, ['schedules:write', 'shifts:write']);
    // Bind this request to one captured eligible capability; loss requires a fresh request.
    const permission = identity.permissions.includes('schedules:write') ? 'schedules:write' : 'shifts:write';
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const operationId = sha256(`${identity.tenantId}:${CREATE_RESOURCE}:${idempotencyKey}`);
    const expectedRequestHash = requestHash({ locationPublicId, body });
    const startDate = parseUtcInstant(body.startDate, '/startDate');
    const endDate = parseUtcInstant(body.endDate, '/endDate');
    if (endDate <= startDate || endDate.getTime() - startDate.getTime() > MAX_SCHEDULE_WINDOW_MS) {
      throw new ProblemError(
        422,
        'invalid_schedule_window',
        'Schedule end must follow start and the window cannot exceed 31 days.',
        'Schedule validation failed',
      );
    }

    const scope = await prepareOperationsAuthority(this.database, identity, [permission], this.observer);
    return scope.run(async (transaction, identity, assertCurrent) => {
      const initialReplay = await operationsWait(assertCurrent, () => this.replay(
        transaction,
        identity.tenantId,
        operationId,
        expectedRequestHash,
        assertCurrent,
      ));
      if (initialReplay) return initialReplay;

      await operationsWait(assertCurrent, () => assertSchedulingEntitled(transaction, identity.tenantId));
      await operationsWait(assertCurrent, () => lockSchedulingAggregate(transaction, identity.tenantId));
      const lockedReplay = await operationsWait(assertCurrent, () => this.replay(
        transaction,
        identity.tenantId,
        operationId,
        expectedRequestHash,
        assertCurrent,
      ));
      if (lockedReplay) return lockedReplay;

      const locations = await operationsWait(assertCurrent, () => transaction.$queryRaw<LockedLocation[]>(Prisma.sql`
        SELECT "id", "publicId"::text AS "publicId"
        FROM "Location"
        WHERE "tenantId" = ${identity.tenantId}
          AND "publicId" = CAST(${locationPublicId} AS uuid)
          AND "deletedAt" IS NULL
        FOR UPDATE
      `));
      const location = locations[0];
      if (!location) {
        throw new ProblemError(404, 'location_not_found', 'The selected location was not found.', 'Location not found');
      }

      const overlap = await operationsWait(assertCurrent, () => transaction.schedule.findFirst({
        where: {
          tenantId: identity.tenantId,
          locationId: location.id,
          deletedAt: null,
          startDate: { lt: endDate },
          endDate: { gt: startDate },
        },
        select: {
          id: true,
          publicId: true,
          locationId: true,
          startDate: true,
          endDate: true,
          status: true,
          publishedAt: true,
          revision: true,
        },
      }));
      let schedule: PublicScheduleRow;
      if (
        overlap
        && overlap.status === 'DRAFT'
        && overlap.startDate.getTime() === startDate.getTime()
        && overlap.endDate.getTime() === endDate.getTime()
      ) {
        schedule = overlap as PublicScheduleRow;
      } else if (overlap) {
        throw new ProblemError(
          409,
          'schedule_window_conflict',
          'The requested schedule window overlaps an existing schedule at this location.',
          'Schedule conflict',
        );
      } else {
        schedule = await operationsWait(assertCurrent, () => transaction.schedule.create({
          data: {
            publicId: randomUUID(),
            tenantId: identity.tenantId,
            locationId: location.id,
            startDate,
            endDate,
            status: 'DRAFT',
          },
          select: {
            id: true,
            publicId: true,
            locationId: true,
            startDate: true,
            endDate: true,
            status: true,
            publishedAt: true,
            revision: true,
          },
        })) as PublicScheduleRow;
      }

      const response: ScheduleCreateResponse = {
        data: serializeSchedule(schedule, location.publicId),
      };
      await operationsWait(assertCurrent, () => transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId,
          userId: identity.sub,
          actorUserId: identity.sub,
          actorTenantId: identity.tenantId,
          action: CREATE_ACTION,
          resource: CREATE_RESOURCE,
          resourceId: operationId,
          newValue: {
            requestHash: expectedRequestHash,
            response: asInputJson(response),
          },
          ipAddress: metadata.ipAddress?.slice(0, 128),
          userAgent: metadata.userAgent?.slice(0, 512),
        },
      }));
      return response;
    });
  }
}
