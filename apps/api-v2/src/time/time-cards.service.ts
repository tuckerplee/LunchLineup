import { createHash } from 'node:crypto';
import { Prisma, UserRole } from '@prisma/client';
import type {
  SessionIdentity,
  TimeCardActiveQuery,
  TimeCardActiveResponse,
  TimeCardClockInRequest,
  TimeCardClockInResponse,
  TimeCardClockOutRequest,
  TimeCardCorrectionRequest,
  TimeCardListQuery,
  TimeCardListResponse,
  TimeCardRecord,
} from '@lunchlineup/api-contract';
import type { TenantDatabase, TenantTransaction } from '../platform/database';
import { assertFeatureEntitled, debitFeatureCredit } from '../platform/feature-entitlement';
import { ProblemError } from '../platform/problem';
import {
  assertClockOutWithinPayrollPeriod,
  lockTimeCardPayrollContext,
  resolveTimeCardPayrollAssignment,
} from './payroll';
import {
  decodeTimeCardCursor,
  encodeTimeCardCursor,
  invalidTimeCardInput,
  parseTimeCardInstant,
  parseTimeCardLimit,
} from './pagination';
import { serializeTimeCard, type TimeCardWithPublicRelations } from './serialization';
import {
  isTimeCardOverlap,
  normalizeClockOutBreakMinutes,
  normalizeTimeCardNotes,
  timeCardAuditValue,
  validateTimeCardCorrection,
} from './validation';

const TEAM_TIME_CARD_PERMISSIONS = ['users:read', 'shifts:read'] as const;

const TIME_CARD_SELECT = {
  id: true,
  publicId: true,
  tenantId: true,
  userId: true,
  locationId: true,
  shiftId: true,
  clockInOperationId: true,
  clockInRequestHash: true,
  clockInAt: true,
  clockOutAt: true,
  payrollPeriodId: true,
  workTimeZone: true,
  revision: true,
  breakMinutes: true,
  notes: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { publicId: true, name: true, username: true, role: true } },
  location: { select: { publicId: true, name: true, timezone: true } },
  shift: { select: { publicId: true } },
  breaks: {
    orderBy: [{ startAt: 'asc' }, { publicId: 'asc' }],
    select: { publicId: true, startAt: true, endAt: true },
  },
} satisfies Prisma.TimeCardSelect;

type InternalTimeCard = TimeCardWithPublicRelations & {
  id: string;
  tenantId: string;
  userId: string;
  locationId: string | null;
  shiftId: string | null;
  clockInOperationId: string | null;
  clockInRequestHash: string | null;
  payrollPeriodId: string | null;
};

type TargetUser = {
  id: string;
  publicId: string;
};

type TimeCardLocation = {
  id: string;
  timezone: string;
};

type TimeCardShift = {
  id: string;
  locationId: string;
  userId: string | null;
};

function timeCardProblem(status: number, code: string, detail: string, title = 'Time-card request failed'): ProblemError {
  return new ProblemError(status, code, detail, title);
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'P2002';
}

function operationId(tenantId: string, idempotencyKey: string): string {
  // This intentionally matches the former v1 operation identity. A retry that
  // crosses the compatibility cutover still finds the original durable row.
  return createHash('sha256').update(`${tenantId}:${idempotencyKey}`, 'utf8').digest('hex');
}

function clockInRequestHash(input: {
  actorUserId: string;
  targetUserId: string;
  locationId: string | null;
  shiftId: string | null;
  clockInAt: string | null;
  notes: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

function normalizeClockInIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';
  if (!key) {
    throw timeCardProblem(428, 'idempotency_key_required', 'Clock-in requires an Idempotency-Key header.', 'Precondition required');
  }
  if (key.length > 255 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw timeCardProblem(422, 'invalid_idempotency_key', 'Idempotency-Key must contain 255 printable characters or fewer.', 'Time-card validation failed');
  }
  return key;
}

/**
 * Native API-02 owner for time-card reads and lifecycle writes. It keeps the
 * mature storage model during the cutover, but treats private primary keys as
 * strictly internal implementation detail and never calls a retained route.
 */
export class TimeCardService {
  constructor(private readonly database: Pick<TenantDatabase, 'withTenant'>) {}

  async list(identity: SessionIdentity, query: TimeCardListQuery): Promise<TimeCardListResponse> {
    const limit = parseTimeCardLimit(query.limit);
    const cursor = decodeTimeCardCursor(query.cursor);
    const startDate = query.startDate ? parseTimeCardInstant(query.startDate, 'startDate') : undefined;
    const endDate = query.endDate ? parseTimeCardInstant(query.endDate, 'endDate') : undefined;
    if (startDate && endDate && endDate <= startDate) {
      throw invalidTimeCardInput('endDate must be after startDate.');
    }
    if (!this.canViewTeam(identity) && query.userId && query.userId !== identity.publicUserId) {
      throw timeCardProblem(403, 'time_card_scope_denied', 'Staff can only view their own time cards.', 'Forbidden');
    }

    return this.database.withTenant(identity.tenantId, async (transaction) => {
      await assertFeatureEntitled(transaction, identity.tenantId, 'time_cards', false);
      const where: Prisma.TimeCardWhereInput = {
        tenantId: identity.tenantId,
        deletedAt: null,
      };
      const and: Prisma.TimeCardWhereInput[] = [];
      const requestedPublicUserId = query.userId ?? (this.canViewTeam(identity) ? undefined : identity.publicUserId);
      if (requestedPublicUserId) where.user = { is: { publicId: requestedPublicUserId } };
      if (query.locationId) where.location = { is: { publicId: query.locationId, deletedAt: null } };
      if (startDate || endDate) {
        where.clockInAt = {
          ...(startDate ? { gte: startDate } : {}),
          ...(endDate ? { lt: endDate } : {}),
        };
      }
      if (cursor) {
        and.push({
          OR: [
            { clockInAt: { lt: cursor.clockInAt } },
            { clockInAt: cursor.clockInAt, publicId: { lt: cursor.publicId } },
          ],
        });
      }
      if (and.length > 0) where.AND = and;
      const rows = await transaction.timeCard.findMany({
        where,
        orderBy: [{ clockInAt: 'desc' }, { publicId: 'desc' }],
        take: limit + 1,
        select: TIME_CARD_SELECT,
      }) as unknown as InternalTimeCard[];
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return {
        data: page.map((row) => this.serialize(row)),
        pagination: {
          limit,
          maxLimit: 200,
          returned: page.length,
          hasMore,
          nextCursor: hasMore && page.length > 0
            ? encodeTimeCardCursor(page[page.length - 1])
            : null,
          window: {
            startDate: startDate?.toISOString() ?? null,
            endDate: endDate?.toISOString() ?? null,
          },
        },
      };
    });
  }

  async active(identity: SessionIdentity, query: TimeCardActiveQuery): Promise<TimeCardActiveResponse> {
    if (!this.canViewTeam(identity) && query.userId && query.userId !== identity.publicUserId) {
      throw timeCardProblem(403, 'time_card_scope_denied', 'Staff can only view their own time cards.', 'Forbidden');
    }
    const requestedPublicUserId = query.userId ?? identity.publicUserId;
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      // Recovery must remain available after a subscription expires: a worker
      // must always be able to close an already-open time card.
      const row = await transaction.timeCard.findFirst({
        where: {
          tenantId: identity.tenantId,
          deletedAt: null,
          status: 'OPEN',
          user: { is: { publicId: requestedPublicUserId } },
        },
        orderBy: [{ clockInAt: 'desc' }, { publicId: 'desc' }],
        select: TIME_CARD_SELECT,
      }) as unknown as InternalTimeCard | null;
      return { data: row ? this.serialize(row) : null };
    });
  }

  async get(identity: SessionIdentity, timeCardPublicId: string): Promise<TimeCardRecord> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      await assertFeatureEntitled(transaction, identity.tenantId, 'time_cards', false);
      const card = await this.findScopedTimeCard(transaction, identity, timeCardPublicId, true);
      return this.serialize(card);
    });
  }

  async clockIn(
    identity: SessionIdentity,
    body: TimeCardClockInRequest,
    idempotencyKeyValue: string | undefined,
  ): Promise<TimeCardClockInResponse> {
    const idempotencyKey = normalizeClockInIdempotencyKey(idempotencyKeyValue);
    const operation = operationId(identity.tenantId, idempotencyKey);
    if (!this.canViewTeam(identity) && body.clockInAt !== undefined) {
      throw timeCardProblem(403, 'manual_clock_time_denied', 'Staff self-service clockInAt uses server time.', 'Forbidden');
    }
    const requestedClockInAt = body.clockInAt === undefined
      ? null
      : parseTimeCardInstant(body.clockInAt, 'clockInAt');
    const notes = normalizeTimeCardNotes(body.notes) ?? null;
    let expectedRequestHash: string | null = null;

    try {
      return await this.database.withTenant(identity.tenantId, async (transaction) => {
        const targetPublicId = this.writableTargetPublicId(identity, body.userId);
        // Resolve only durable storage references before replay detection. The
        // v1 operation hash used explicit request fields (not shift-derived
        // location), so this lets a lost response replay even after a user,
        // shift, or location has subsequently become ineligible.
        const requestedTarget = await this.resolveClockInTargetForReplay(
          transaction,
          identity.tenantId,
          targetPublicId,
        );
        const requestedLocation = body.locationId
          ? await this.resolveLocationForReplay(transaction, identity.tenantId, body.locationId)
          : null;
        const requestedShift = body.shiftId
          ? await this.resolveShiftForReplay(transaction, identity.tenantId, body.shiftId)
          : null;
        const requestHash = clockInRequestHash({
          actorUserId: identity.sub,
          targetUserId: requestedTarget.id,
          locationId: requestedLocation?.id ?? null,
          shiftId: requestedShift?.id ?? null,
          clockInAt: requestedClockInAt?.toISOString() ?? null,
          notes,
        });
        expectedRequestHash = requestHash;
        const replay = await this.findClockInReplay(transaction, identity.tenantId, operation, requestHash);
        if (replay) return { data: this.serialize(replay), reused: true };

        const target = await this.lockActiveClockInTarget(transaction, identity.tenantId, targetPublicId);
        const shift = body.shiftId
          ? await this.resolveShift(transaction, identity.tenantId, body.shiftId, target.id)
          : null;
        const location = body.locationId
          ? await this.resolveLocation(transaction, identity.tenantId, body.locationId)
          : shift
            ? await this.resolveLocationByInternalId(transaction, identity.tenantId, shift.locationId)
            : null;
        if (shift && location && location.id !== shift.locationId) {
          throw invalidTimeCardInput('Time-card location must match the selected shift location.');
        }
        const entitlement = await assertFeatureEntitled(transaction, identity.tenantId, 'time_cards', true);
        if (!entitlement) {
          throw timeCardProblem(403, 'time_cards_not_entitled', 'Clock-in requires usage credits.', 'Feature unavailable');
        }
        const openCard = await transaction.timeCard.findFirst({
          where: {
            tenantId: identity.tenantId,
            userId: target.id,
            status: 'OPEN',
            deletedAt: null,
          },
          select: { id: true },
        });
        if (openCard) {
          throw invalidTimeCardInput('This employee already has an open time card.');
        }
        const clockInAt = requestedClockInAt ?? new Date();
        const payroll = await resolveTimeCardPayrollAssignment(transaction, identity.tenantId, clockInAt, location);
        const created = await transaction.timeCard.create({
          data: {
            tenantId: identity.tenantId,
            userId: target.id,
            locationId: location?.id ?? null,
            shiftId: shift?.id ?? null,
            clockInOperationId: operation,
            clockInRequestHash: requestHash,
            clockInAt,
            payrollPeriodId: payroll.payrollPeriodId,
            workTimeZone: payroll.workTimeZone,
            notes,
            status: 'OPEN',
          },
          select: TIME_CARD_SELECT,
        }) as unknown as InternalTimeCard;
        await debitFeatureCredit(transaction, {
          tenantId: identity.tenantId,
          entitlement,
          operationId: operation,
          reason: `Time card clock-in (${created.id})`,
        });
        await transaction.auditLog.create({
          data: {
            tenantId: identity.tenantId,
            userId: identity.sub,
            actorUserId: identity.sub,
            actorTenantId: identity.tenantId,
            action: 'TIME_CARD_CLOCKED_IN',
            resource: 'TimeCard',
            resourceId: created.id,
            newValue: timeCardAuditValue(created) as Prisma.InputJsonValue,
          },
        });
        return { data: this.serialize(created), reused: false };
      }, {
        maxWait: 5_000,
        timeout: 10_000,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      // A successful commit followed by a dropped response must return the
      // exact persisted outcome instead of charging a second clock-in.
      const replay = await this.findClockInReplayOutsideTransaction(identity.tenantId, operation);
      if (replay && expectedRequestHash && replay.clockInRequestHash === expectedRequestHash) {
        return { data: this.serialize(replay), reused: true };
      }
      if (replay && expectedRequestHash) {
        throw timeCardProblem(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different clock-in request.', 'Conflict');
      }
      if (isUniqueConstraint(error)) {
        throw invalidTimeCardInput('This employee already has an open time card.');
      }
      throw error;
    }
  }

  async clockOut(
    identity: SessionIdentity,
    timeCardPublicId: string,
    body: TimeCardClockOutRequest,
  ): Promise<TimeCardRecord> {
    if (!this.canViewTeam(identity) && body.clockOutAt !== undefined) {
      throw timeCardProblem(403, 'manual_clock_time_denied', 'Staff self-service clockOutAt uses server time.', 'Forbidden');
    }
    const requestedClockOutAt = body.clockOutAt === undefined
      ? null
      : parseTimeCardInstant(body.clockOutAt, 'clockOutAt');
    const notes = normalizeTimeCardNotes(body.notes);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const initial = await this.findScopedTimeCard(transaction, identity, timeCardPublicId, false);
      const payrollPeriods = await lockTimeCardPayrollContext(
        transaction,
        identity.tenantId,
        initial.id,
        [initial.payrollPeriodId],
      );
      const card = await this.findScopedTimeCard(transaction, identity, timeCardPublicId, false);
      if (card.status !== 'OPEN') {
        throw invalidTimeCardInput('This time card is already closed.');
      }
      const clockOutAt = requestedClockOutAt ?? new Date();
      if (clockOutAt <= card.clockInAt) {
        throw invalidTimeCardInput('Clock out must be after clock in.');
      }
      assertClockOutWithinPayrollPeriod(card.payrollPeriodId, clockOutAt, payrollPeriods);
      const totalMinutes = Math.floor((clockOutAt.getTime() - card.clockInAt.getTime()) / 60_000);
      const breakMinutes = normalizeClockOutBreakMinutes(body.breakMinutes, totalMinutes);
      const updated = await transaction.timeCard.updateMany({
        where: {
          id: card.id,
          tenantId: identity.tenantId,
          deletedAt: null,
          status: 'OPEN',
          clockOutAt: null,
          revision: card.revision,
        },
        data: {
          clockOutAt,
          breakMinutes,
          ...(notes === undefined ? {} : { notes }),
          status: 'CLOSED',
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw timeCardProblem(409, 'concurrent_time_card_change', 'This time card was already clocked out by another request.', 'Concurrent change');
      }
      const result = await this.findScopedTimeCard(transaction, identity, timeCardPublicId, true);
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId,
          userId: identity.sub,
          actorUserId: identity.sub,
          actorTenantId: identity.tenantId,
          action: 'TIME_CARD_CLOCKED_OUT',
          resource: 'TimeCard',
          resourceId: result.id,
          oldValue: timeCardAuditValue(card) as Prisma.InputJsonValue,
          newValue: timeCardAuditValue(result) as Prisma.InputJsonValue,
        },
      });
      return this.serialize(result);
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  async correct(
    identity: SessionIdentity,
    timeCardPublicId: string,
    body: TimeCardCorrectionRequest,
  ): Promise<TimeCardRecord> {
    if (!this.canViewTeam(identity)) {
      throw timeCardProblem(403, 'time_card_correction_denied', 'Team time-card corrections require manager access.', 'Forbidden');
    }
    try {
      return await this.database.withTenant(identity.tenantId, async (transaction) => {
        await assertFeatureEntitled(transaction, identity.tenantId, 'time_cards', false);
        const initial = await this.findScopedTimeCard(transaction, identity, timeCardPublicId, true);
        if (initial.status === 'VOID') {
          throw invalidTimeCardInput('Voided time cards cannot be corrected.');
        }
        const correction = validateTimeCardCorrection(body, initial);
        const assignment = await resolveTimeCardPayrollAssignment(
          transaction,
          identity.tenantId,
          correction.clockInAt,
          initial.location && initial.locationId
            ? { id: initial.locationId, timezone: initial.workTimeZone }
            : null,
        );
        const periods = await lockTimeCardPayrollContext(
          transaction,
          identity.tenantId,
          initial.id,
          [initial.payrollPeriodId, assignment.payrollPeriodId],
        );
        const card = await this.findScopedTimeCard(transaction, identity, timeCardPublicId, true);
        if (card.status === 'VOID') {
          throw invalidTimeCardInput('Voided time cards cannot be corrected.');
        }
        await this.assertNoOverlap(
          transaction,
          identity.tenantId,
          card.userId,
          card.id,
          correction.clockInAt,
          correction.clockOutAt,
        );
        const update = await transaction.timeCard.updateMany({
          where: {
            id: card.id,
            tenantId: identity.tenantId,
            deletedAt: null,
            updatedAt: correction.expectedUpdatedAt,
            revision: card.revision,
          },
          data: {
            clockInAt: correction.clockInAt,
            clockOutAt: correction.clockOutAt,
            breakMinutes: correction.breakMinutes,
            status: correction.status,
            payrollPeriodId: assignment.payrollPeriodId,
            workTimeZone: assignment.workTimeZone,
            revision: { increment: 1 },
          },
        });
        if (update.count !== 1) {
          throw timeCardProblem(409, 'concurrent_time_card_change', 'This time card changed while you were editing it. Refresh and try again.', 'Concurrent change');
        }
        if (correction.breakIntervals !== null) {
          await transaction.timeCardBreak.deleteMany({
            where: { tenantId: identity.tenantId, timeCardId: card.id },
          });
          if (correction.breakIntervals.length > 0) {
            await transaction.timeCardBreak.createMany({
              data: correction.breakIntervals.map((interval) => ({
                tenantId: identity.tenantId,
                timeCardId: card.id,
                startAt: interval.startAt,
                endAt: interval.endAt,
              })),
            });
          }
        }
        const result = await this.findScopedTimeCard(transaction, identity, timeCardPublicId, true);
        if (result.payrollPeriodId && result.clockOutAt) {
          assertClockOutWithinPayrollPeriod(result.payrollPeriodId, result.clockOutAt, periods);
        }
        await transaction.auditLog.create({
          data: {
            tenantId: identity.tenantId,
            userId: identity.sub,
            actorUserId: identity.sub,
            actorTenantId: identity.tenantId,
            action: 'TIME_CARD_CORRECTED',
            resource: 'TimeCard',
            resourceId: result.id,
            oldValue: timeCardAuditValue(card) as Prisma.InputJsonValue,
            newValue: {
              ...timeCardAuditValue(result),
              correctionReason: correction.reason,
            } as Prisma.InputJsonValue,
          },
        });
        return this.serialize(result);
      }, {
        maxWait: 5_000,
        timeout: 10_000,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (isTimeCardOverlap(error)) {
        throw timeCardProblem(409, 'time_card_overlap', 'Corrected time cards cannot overlap another card for this employee.', 'Conflict');
      }
      throw error;
    }
  }

  private canViewTeam(identity: SessionIdentity): boolean {
    return TEAM_TIME_CARD_PERMISSIONS.every((permission) => identity.permissions.includes(permission));
  }

  private writableTargetPublicId(
    identity: SessionIdentity,
    requestedPublicId: string | undefined,
  ): string {
    const publicId = requestedPublicId ?? identity.publicUserId;
    if (!this.canViewTeam(identity) && publicId !== identity.publicUserId) {
      throw timeCardProblem(403, 'time_card_scope_denied', 'Staff can only manage their own time cards.', 'Forbidden');
    }
    return publicId;
  }

  private async resolveClockInTargetForReplay(
    transaction: TenantTransaction,
    tenantId: string,
    publicId: string,
  ): Promise<TargetUser> {
    const user = await transaction.user.findFirst({
      where: { tenantId, publicId },
      select: { id: true, publicId: true },
    });
    if (!user) {
      throw invalidTimeCardInput('User is not available for time tracking in this workspace.');
    }
    return user;
  }

  private async lockActiveClockInTarget(
    transaction: TenantTransaction,
    tenantId: string,
    publicId: string,
  ): Promise<TargetUser> {
    const rows = await transaction.$queryRaw<Array<{ id: string; publicId: string }>>(Prisma.sql`
      SELECT "id", "publicId"::text AS "publicId"
      FROM "User"
      WHERE "tenantId" = ${tenantId}
        AND "publicId" = ${publicId}::uuid
        AND "role" IN (${UserRole.MANAGER}::"UserRole", ${UserRole.STAFF}::"UserRole")
        AND "deletedAt" IS NULL
        AND "suspendedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) {
      throw invalidTimeCardInput('User is not available for time tracking in this workspace.');
    }
    return rows[0];
  }

  private async resolveLocationForReplay(
    transaction: TenantTransaction,
    tenantId: string,
    publicId: string,
  ): Promise<TimeCardLocation> {
    const location = await transaction.location.findFirst({
      where: { tenantId, publicId },
      select: { id: true, timezone: true },
    });
    if (!location) throw invalidTimeCardInput('Location is not available for this workspace.');
    return location;
  }

  private async resolveShiftForReplay(
    transaction: TenantTransaction,
    tenantId: string,
    publicId: string,
  ): Promise<TimeCardShift> {
    const shift = await transaction.shift.findFirst({
      where: { tenantId, publicId },
      select: { id: true, locationId: true, userId: true },
    });
    if (!shift) throw invalidTimeCardInput('Shift is not available for this workspace.');
    return shift;
  }

  private async resolveLocation(
    transaction: TenantTransaction,
    tenantId: string,
    publicId: string,
  ): Promise<TimeCardLocation> {
    const location = await transaction.location.findFirst({
      where: { tenantId, publicId, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!location) throw invalidTimeCardInput('Location is not available for this workspace.');
    return location;
  }

  private async resolveLocationByInternalId(
    transaction: TenantTransaction,
    tenantId: string,
    id: string,
  ): Promise<TimeCardLocation> {
    const location = await transaction.location.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!location) throw invalidTimeCardInput('Shift location is not available for this workspace.');
    return location;
  }

  private async resolveShift(
    transaction: TenantTransaction,
    tenantId: string,
    publicId: string,
    targetUserId: string,
  ): Promise<TimeCardShift> {
    const shift = await transaction.shift.findFirst({
      where: { tenantId, publicId, deletedAt: null },
      select: { id: true, locationId: true, userId: true },
    });
    if (!shift) throw invalidTimeCardInput('Shift is not available for this workspace.');
    if (shift.userId && shift.userId !== targetUserId) {
      throw invalidTimeCardInput('Shift is assigned to a different employee.');
    }
    return shift;
  }

  private async findClockInReplay(
    transaction: TenantTransaction,
    tenantId: string,
    operation: string,
    requestHash: string,
  ): Promise<InternalTimeCard | null> {
    const row = await transaction.timeCard.findUnique({
      where: { clockInOperationId: operation },
      select: TIME_CARD_SELECT,
    }) as unknown as InternalTimeCard | null;
    if (!row || row.tenantId !== tenantId) return null;
    if (row.clockInRequestHash !== requestHash) {
      throw timeCardProblem(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different clock-in request.', 'Conflict');
    }
    return row;
  }

  private async findClockInReplayOutsideTransaction(
    tenantId: string,
    operation: string,
  ): Promise<InternalTimeCard | null> {
    return this.database.withTenant(tenantId, async (transaction) => {
      const row = await transaction.timeCard.findUnique({
        where: { clockInOperationId: operation },
        select: TIME_CARD_SELECT,
      }) as unknown as InternalTimeCard | null;
      return row?.tenantId === tenantId ? row : null;
    });
  }

  private async findScopedTimeCard(
    transaction: TenantTransaction,
    identity: SessionIdentity,
    publicId: string,
    includeClosed: boolean,
  ): Promise<InternalTimeCard> {
    const row = await transaction.timeCard.findFirst({
      where: {
        tenantId: identity.tenantId,
        publicId,
        deletedAt: null,
        ...(includeClosed ? {} : { status: { not: 'VOID' } }),
        ...(this.canViewTeam(identity) ? {} : { userId: identity.sub }),
      },
      select: TIME_CARD_SELECT,
    }) as unknown as InternalTimeCard | null;
    if (!row) {
      throw timeCardProblem(404, 'time_card_not_found', 'Time card not found in this workspace.', 'Not found');
    }
    return row;
  }

  private async assertNoOverlap(
    transaction: TenantTransaction,
    tenantId: string,
    userId: string,
    timeCardId: string,
    clockInAt: Date,
    clockOutAt: Date | null,
  ): Promise<void> {
    const overlap = await transaction.timeCard.findFirst({
      where: {
        tenantId,
        userId,
        id: { not: timeCardId },
        deletedAt: null,
        status: { not: 'VOID' },
        clockInAt: { lt: clockOutAt ?? new Date('9999-12-31T23:59:59.999Z') },
        OR: [{ clockOutAt: null }, { clockOutAt: { gt: clockInAt } }],
      },
      select: { id: true },
    });
    if (overlap) {
      throw timeCardProblem(409, 'time_card_overlap', 'Corrected time cards cannot overlap another card for this employee.', 'Conflict');
    }
  }

  private serialize(row: InternalTimeCard): TimeCardRecord {
    return serializeTimeCard(row);
  }
}
