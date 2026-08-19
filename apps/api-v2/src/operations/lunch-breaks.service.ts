import { createHash, randomUUID } from 'node:crypto';
import { Prisma, UserRole } from '@prisma/client';
import type {
  LunchBreakGenerationRequest,
  LunchBreakGenerationResponse,
  LunchBreakListQuery,
  LunchBreakListResponse,
  LunchBreakPolicy,
  LunchBreakPolicyPatch,
  LunchBreakRow,
  SessionIdentity,
  SetupShiftsRequest,
  SetupShiftsResponse,
  ShiftBreakUpdateRequest,
} from '@lunchlineup/api-contract';
import type { TenantDatabase, TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';
import { canonicalJson, parseUtcInstant, requireIdempotencyKey, requestHash, sha256 } from '../scheduling/contract-helpers';
import { assertFeatureEntitled, debitFeatureCredit, lockSchedulingAggregate, lockTenantForScheduling } from './entitlement';
import { isStaffIdentity } from './operations.service';
import { decodeCursor, page, parseLimit, parseWindow } from './pagination';
import { serializeLunchBreakRow } from './serialization';

const DEFAULT_POLICY: LunchBreakPolicy = {
  break1OffsetMinutes: 120,
  lunchOffsetMinutes: 240,
  break2OffsetMinutes: 120,
  break1DurationMinutes: 10,
  lunchDurationMinutes: 30,
  break2DurationMinutes: 10,
  timeStepMinutes: 5,
};

const BREAK_TYPES = ['break1', 'lunch', 'break2'] as const;
type BreakType = (typeof BREAK_TYPES)[number];

const DB_BREAK_TYPE: Record<BreakType, 'BREAK1' | 'LUNCH' | 'BREAK2'> = {
  break1: 'BREAK1',
  lunch: 'LUNCH',
  break2: 'BREAK2',
};

const SCHEDULABLE_SHIFT_USER_FILTER = {
  OR: [
    { userId: null },
    {
      user: {
        is: {
          role: { in: [UserRole.MANAGER, UserRole.STAFF] },
          deletedAt: null,
          suspendedAt: null,
        },
      },
    },
  ],
};

type InternalShift = {
  id: string;
  publicId: string;
  userId: string | null;
  startTime: Date;
  endTime: Date;
  updatedAt: Date;
  role: string | null;
  location: { publicId: string };
  schedule: { id: string; publicId: string; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; startDate: Date; endDate: Date } | null;
  user: { id: string; publicId: string; name: string; role: string } | null;
  breaks: Array<{ id: string; type: string | null; startTime: Date; endTime: Date; paid: boolean }>;
};

type GeneratedInput = {
  shiftId: string | null;
  userId: string | null;
  employeeName: string | null;
  startTime: string;
  endTime: string;
  lunchDurationMinutes?: number;
};

type GenerationSnapshot = {
  id: string;
  publicId: string;
  scheduleId: string | null;
  startTime: string;
  endTime: string;
  updatedAt: string;
};

type GenerationClaim = {
  requestId: string;
  claimToken: string;
};

type PreparedGeneration = {
  locationId: string | null;
  source: 'shared_schedule' | 'standalone';
  persisted: boolean;
  policy: LunchBreakPolicy;
  data: LunchBreakRow[];
  snapshot: GenerationSnapshot[];
};

function problem(status: number, code: string, detail: string, title?: string): ProblemError {
  return new ProblemError(status, code, detail, title ?? 'Lunch and break request failed');
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function normalizePolicy(value: Partial<LunchBreakPolicy> | Record<string, unknown>): LunchBreakPolicy {
  return {
    break1OffsetMinutes: integer(value.break1OffsetMinutes, DEFAULT_POLICY.break1OffsetMinutes, 10, 480),
    lunchOffsetMinutes: integer(value.lunchOffsetMinutes, DEFAULT_POLICY.lunchOffsetMinutes, 30, 600),
    break2OffsetMinutes: integer(value.break2OffsetMinutes, DEFAULT_POLICY.break2OffsetMinutes, 10, 480),
    break1DurationMinutes: integer(value.break1DurationMinutes, DEFAULT_POLICY.break1DurationMinutes, 5, 60),
    lunchDurationMinutes: integer(value.lunchDurationMinutes, DEFAULT_POLICY.lunchDurationMinutes, 15, 120),
    break2DurationMinutes: integer(value.break2DurationMinutes, DEFAULT_POLICY.break2DurationMinutes, 5, 60),
    timeStepMinutes: integer(value.timeStepMinutes, DEFAULT_POLICY.timeStepMinutes, 1, 60),
  };
}

function canonicalIdempotencyOperation(namespace: string, tenantId: string, key: string): string {
  return createHash('sha256').update(`${namespace}:${tenantId}:${key}`, 'utf8').digest('hex');
}

function shiftBreakIdentity(input: { locationId: string; breaks: readonly NormalizedBreakInput[] }): string {
  return sha256(canonicalJson({
    locationId: input.locationId,
    breaks: [...input.breaks].sort((left, right) => left.type.localeCompare(right.type)),
  }));
}

function setupIdentity(input: SetupShiftsRequest): string {
  return sha256(canonicalJson(input));
}

function toStoredResponse(value: unknown): LunchBreakGenerationResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.data) || !record.policy || typeof record.policy !== 'object') return null;
  return record as unknown as LunchBreakGenerationResponse;
}

type NormalizedBreakInput = {
  type: BreakType;
  skip: boolean;
  startTime?: string;
  durationMinutes?: number;
};

function normalizeBreakUpdate(input: ShiftBreakUpdateRequest): { locationId: string; breaks: NormalizedBreakInput[] } {
  const seen = new Set<BreakType>();
  const byType = new Map<BreakType, NormalizedBreakInput>();
  for (const entry of input.breaks) {
    if (seen.has(entry.type)) {
      throw problem(422, 'invalid_break_update', 'Each lunch or break type can appear only once.', 'Break update validation failed');
    }
    seen.add(entry.type);
    if (entry.skip) {
      byType.set(entry.type, { type: entry.type, skip: true });
      continue;
    }
    if (!entry.startTime) {
      throw problem(422, 'invalid_break_update', `${entry.type} requires startTime unless skipped.`, 'Break update validation failed');
    }
    const startTime = parseUtcInstant(entry.startTime, '/breaks/startTime').toISOString();
    byType.set(entry.type, {
      type: entry.type,
      skip: false,
      startTime,
      ...(entry.durationMinutes === undefined ? {} : { durationMinutes: entry.durationMinutes }),
    });
  }
  return {
    locationId: input.locationId,
    breaks: BREAK_TYPES.map((type) => byType.get(type) ?? { type, skip: true }),
  };
}

function internalShiftSelect() {
  return {
    id: true,
    publicId: true,
    userId: true,
    startTime: true,
    endTime: true,
    updatedAt: true,
    role: true,
    location: { select: { publicId: true } },
    schedule: { select: { id: true, publicId: true, status: true, startDate: true, endDate: true } },
    user: { select: { id: true, publicId: true, name: true, role: true } },
    breaks: {
      orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
      select: { id: true, type: true, startTime: true, endTime: true, paid: true },
    },
  } satisfies Prisma.ShiftSelect;
}

/**
 * Native API-02 owner for policy, read models, idempotent break generation,
 * setup-shift persistence, and break replacement. It reads and writes the
 * existing tenant-RLS database directly; no retained HTTP call is involved.
 */
export class LunchBreakService {
  constructor(private readonly database: Pick<TenantDatabase, 'withTenant'>) {}

  async list(identity: SessionIdentity, query: LunchBreakListQuery): Promise<LunchBreakListResponse> {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const window = parseWindow(query);
    const shiftIds = query.shiftIds ? this.publicShiftIds(query.shiftIds) : undefined;
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      await assertFeatureEntitled(transaction, identity.tenantId, 'lunch_breaks', false);
      const scheduleFilter: Record<string, unknown> = {
        ...(query.scheduleId ? { publicId: query.scheduleId } : {}),
      };
      if (isStaffIdentity(identity)) {
        scheduleFilter.status = 'PUBLISHED';
        scheduleFilter.deletedAt = null;
      }
      const where: Record<string, unknown> = {
        tenantId: identity.tenantId,
        deletedAt: null,
        location: {
          is: {
            deletedAt: null,
            ...(query.locationId ? { publicId: query.locationId } : {}),
          },
        },
        AND: [SCHEDULABLE_SHIFT_USER_FILTER],
      };
      if (Object.keys(scheduleFilter).length > 0) where.schedule = { is: scheduleFilter };
      if (shiftIds) where.publicId = { in: shiftIds };
      if (isStaffIdentity(identity)) where.userId = identity.sub;
      const and = where.AND as Record<string, unknown>[];
      if (window.startDate) and.push({ endTime: { gt: window.startDate } });
      if (window.endDate) and.push({ startTime: { lt: window.endDate } });
      if (cursor) {
        and.push({
          OR: [
            { startTime: { gt: cursor.timestamp } },
            { startTime: cursor.timestamp, publicId: { gt: cursor.publicId } },
          ],
        });
      }
      const rows = await transaction.shift.findMany({
        where: where as never,
        orderBy: [{ startTime: 'asc' }, { publicId: 'asc' }],
        take: limit + 1,
        select: internalShiftSelect(),
      }) as unknown as InternalShift[];
      const result = page(rows, limit, (row) => ({ timestamp: row.startTime, publicId: row.publicId }), window);
      return {
        data: result.data.map((row) => serializeLunchBreakRow(row)),
        pagination: result.pagination,
      };
    });
  }

  async policy(identity: SessionIdentity): Promise<LunchBreakPolicy> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      await assertFeatureEntitled(transaction, identity.tenantId, 'lunch_breaks', false);
      return this.readPolicy(transaction, identity.tenantId);
    });
  }

  async replacePolicy(
    identity: SessionIdentity,
    patch: LunchBreakPolicyPatch,
  ): Promise<LunchBreakPolicy> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      await assertFeatureEntitled(transaction, identity.tenantId, 'lunch_breaks', false);
      const policy = normalizePolicy({ ...(await this.readPolicy(transaction, identity.tenantId)), ...patch });
      await transaction.tenantSetting.upsert({
        where: { tenantId_key: { tenantId: identity.tenantId, key: 'lunch_break_policy' } },
        create: {
          tenantId: identity.tenantId,
          key: 'lunch_break_policy',
          value: policy as unknown as Prisma.InputJsonValue,
        },
        update: { value: policy as unknown as Prisma.InputJsonValue },
      });
      return policy;
    });
  }

  async replaceShiftBreaks(
    identity: SessionIdentity,
    shiftPublicId: string,
    body: ShiftBreakUpdateRequest,
    idempotencyKeyValue: string | undefined,
  ): Promise<LunchBreakRow> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const input = normalizeBreakUpdate(body);
    const operationId = canonicalIdempotencyOperation(
      `api-v2:lunch-break-shift:${shiftPublicId}`,
      identity.tenantId,
      idempotencyKey,
    );
    const bodyHash = shiftBreakIdentity(input);
    const replay = await this.findShiftBreakReplay(identity.tenantId, operationId, bodyHash);
    if (replay) return replay;

    try {
      return await this.database.withTenant(identity.tenantId, async (transaction) => {
        const lockedReplay = await this.findShiftBreakReplayInTransaction(transaction, identity.tenantId, operationId, bodyHash);
        if (lockedReplay) return lockedReplay;
        await lockTenantForScheduling(transaction, identity.tenantId);
        await lockSchedulingAggregate(transaction, identity.tenantId);
        const shift = await transaction.shift.findFirst({
          where: {
            tenantId: identity.tenantId,
            publicId: shiftPublicId,
            deletedAt: null,
            location: { is: { publicId: input.locationId, deletedAt: null } },
            AND: [SCHEDULABLE_SHIFT_USER_FILTER],
          },
          select: internalShiftSelect(),
        }) as unknown as InternalShift | null;
        if (!shift) throw problem(404, 'shift_not_found', 'The selected shift was not found for this location.', 'Shift not found');
        await this.assertDraftSchedules(transaction, identity.tenantId, [shift.schedule?.id]);
        const policy = await this.readPolicy(transaction, identity.tenantId);
        const nextBreaks = this.breakPayload(shift, input.breaks, policy);
        this.assertBreaksInsideShift(shift.startTime, shift.endTime, nextBreaks);
        const current = serializeLunchBreakRow(shift);
        if (this.sameBreaks(current.breaks, nextBreaks)) return current;
        const entitlement = await assertFeatureEntitled(transaction, identity.tenantId, 'lunch_breaks', true);
        if (!entitlement) throw problem(403, 'lunch_breaks_not_entitled', 'Lunch and break changes require usage credits.', 'Feature unavailable');
        await debitFeatureCredit(transaction, {
          tenantId: identity.tenantId,
          entitlement,
          operationId,
          reason: `Lunch/break shift replacement (${operationId})`,
        });
        await transaction.break.deleteMany({ where: { shiftId: shift.id } });
        if (nextBreaks.length > 0) {
          await transaction.break.createMany({
            data: nextBreaks.map((entry) => ({
              shiftId: shift.id,
              type: DB_BREAK_TYPE[entry.type],
              startTime: new Date(entry.startTime),
              endTime: new Date(entry.endTime),
              paid: entry.paid,
            })),
          });
        }
        await transaction.shift.update({ where: { id: shift.id }, data: { updatedAt: new Date() } });
        await this.incrementDraftRevisions(transaction, identity.tenantId, [shift.schedule?.id]);
        const updated = await transaction.shift.findFirst({
          where: { id: shift.id, tenantId: identity.tenantId, deletedAt: null },
          select: internalShiftSelect(),
        }) as unknown as InternalShift | null;
        if (!updated) throw problem(409, 'concurrent_change', 'The shift changed while lunch and breaks were being saved. Reload and retry.', 'Concurrent change');
        const response = serializeLunchBreakRow(updated);
        await transaction.auditLog.create({
          data: {
            tenantId: identity.tenantId,
            userId: identity.sub,
            actorUserId: identity.sub,
            actorTenantId: identity.tenantId,
            action: 'API_V2_LUNCH_BREAK_SHIFT_REPLACED',
            resource: 'ApiV2LunchBreakShiftRequest',
            resourceId: operationId,
            newValue: { requestHash: bodyHash, response } as unknown as Prisma.InputJsonValue,
          },
        });
        return response;
      });
    } catch (error) {
      const committed = await this.findShiftBreakReplay(identity.tenantId, operationId, bodyHash);
      if (committed) return committed;
      throw error;
    }
  }

  async generate(
    identity: SessionIdentity,
    body: LunchBreakGenerationRequest,
    idempotencyKeyValue: string | undefined,
  ): Promise<LunchBreakGenerationResponse> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    this.assertGenerationRequest(body);
    const bodyHash = requestHash(body);
    const claim = await this.claimGeneration(identity.tenantId, idempotencyKey, bodyHash);
    if ('response' in claim) return claim.response;

    try {
      const prepared = await this.prepareGeneration(identity, body);
      return await this.completeGeneration(identity, claim, bodyHash, prepared);
    } catch (error) {
      const existing = await this.findGeneration(identity.tenantId, idempotencyKey);
      if (existing?.status === 'SUCCEEDED') {
        const response = toStoredResponse(existing.response);
        if (response && existing.requestHash === bodyHash) return { ...response, reused: true };
      }
      await this.failGeneration(identity.tenantId, claim, error);
      throw error;
    }
  }

  private assertGenerationRequest(body: LunchBreakGenerationRequest): void {
    if (body.shifts && (body.shiftIds || body.scheduleId)) {
      throw problem(422, 'invalid_break_generation', 'Manual shifts cannot be combined with schedule or shift references.', 'Break generation validation failed');
    }
    if (body.persist === true) {
      if (!body.locationId) {
        throw problem(422, 'invalid_break_generation', 'locationId is required when persisting lunch and breaks.', 'Break generation validation failed');
      }
      if (!body.shiftIds || body.shiftIds.length === 0) {
        throw problem(422, 'invalid_break_generation', 'Persisted lunch and break generation requires explicit shiftIds.', 'Break generation validation failed');
      }
      if (body.shifts?.length) {
        throw problem(422, 'invalid_break_generation', 'Manual shifts cannot be persisted as schedule records.', 'Break generation validation failed');
      }
    }
    if (!body.shifts?.length && !body.shiftIds?.length && !body.scheduleId && !body.locationId) {
      throw problem(422, 'invalid_break_generation', 'Provide manual shifts or a bounded schedule scope before generating lunch and breaks.', 'Break generation validation failed');
    }
  }

  private async prepareGeneration(
    identity: SessionIdentity,
    body: LunchBreakGenerationRequest,
  ): Promise<PreparedGeneration> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      await assertFeatureEntitled(transaction, identity.tenantId, 'lunch_breaks', false);
      const location = body.locationId
        ? await transaction.location.findFirst({
            where: { tenantId: identity.tenantId, publicId: body.locationId, deletedAt: null },
            select: { id: true, publicId: true },
          })
        : null;
      if (body.locationId && !location) {
        throw problem(404, 'location_not_found', 'The selected location was not found in this workspace.', 'Location not found');
      }
      const policy = normalizePolicy({ ...(await this.readPolicy(transaction, identity.tenantId)), ...(body.policy ?? {}) });
      if (body.shifts?.length) {
        const explicit = body.shifts.map((entry) => ({
          shiftId: entry.id ?? null,
          userId: entry.userId ?? null,
          employeeName: entry.employeeName?.trim() || 'Unassigned',
          startTime: entry.startTime,
          endTime: entry.endTime,
          lunchDurationMinutes: entry.lunchDurationMinutes,
        }));
        const data = this.buildBreakSchedule(explicit, policy);
        if (data.length === 0) {
          throw problem(422, 'invalid_break_generation', 'Add at least one valid shift before generating lunch and breaks.', 'Break generation validation failed');
        }
        return {
          locationId: location?.publicId ?? null,
          source: 'standalone',
          persisted: false,
          policy,
          data,
          snapshot: [],
        };
      }

      const where: Record<string, unknown> = {
        tenantId: identity.tenantId,
        deletedAt: null,
        AND: [SCHEDULABLE_SHIFT_USER_FILTER],
        ...(location ? { locationId: location.id } : {}),
      };
      if (body.scheduleId) where.schedule = { is: { publicId: body.scheduleId, deletedAt: null } };
      if (body.shiftIds) where.publicId = { in: body.shiftIds };
      const rows = await transaction.shift.findMany({
        where: where as never,
        orderBy: [{ startTime: 'asc' }, { publicId: 'asc' }],
        take: 1001,
        select: internalShiftSelect(),
      }) as unknown as InternalShift[];
      if (rows.length > 1000) {
        throw problem(422, 'break_generation_too_large', 'Choose at most 1,000 shifts for one lunch and break generation request.', 'Break generation validation failed');
      }
      if (body.shiftIds) {
        const requested = new Set(body.shiftIds);
        if (requested.size !== rows.length || rows.some((row) => !requested.has(row.publicId))) {
          throw problem(422, 'invalid_break_generation_scope', 'Every selected shift must belong to the requested active location and schedule scope.', 'Break generation validation failed');
        }
      }
      if (rows.length === 0) {
        throw problem(422, 'invalid_break_generation', 'Add at least one valid shift before generating lunch and breaks.', 'Break generation validation failed');
      }
      const data = this.buildBreakSchedule(rows.map((row) => ({
        shiftId: row.publicId,
        userId: row.user?.publicId ?? null,
        employeeName: row.user?.name ?? null,
        startTime: row.startTime.toISOString(),
        endTime: row.endTime.toISOString(),
        lunchDurationMinutes: policy.lunchDurationMinutes,
      })), policy);
      return {
        locationId: location?.publicId ?? null,
        source: 'shared_schedule',
        persisted: body.persist === true,
        policy,
        data,
        snapshot: rows.map((row) => ({
          id: row.id,
          publicId: row.publicId,
          scheduleId: row.schedule?.id ?? null,
          startTime: row.startTime.toISOString(),
          endTime: row.endTime.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      };
    });
  }

  private async claimGeneration(
    tenantId: string,
    idempotencyKey: string,
    bodyHash: string,
  ): Promise<GenerationClaim | { response: LunchBreakGenerationResponse }> {
    const keyHash = sha256(idempotencyKey);
    const now = new Date();
    const claimToken = randomUUID();
    const claimExpiresAt = new Date(now.getTime() + 2 * 60_000);
    return this.database.withTenant(tenantId, async (transaction) => {
      let existing = await transaction.lunchBreakGenerationRequest.findUnique({
        where: { tenantId_requestKeyHash: { tenantId, requestKeyHash: keyHash } },
      });
      if (!existing) {
        try {
          const created = await transaction.lunchBreakGenerationRequest.create({
            data: {
              id: randomUUID(),
              tenantId,
              requestKeyHash: keyHash,
              requestHash: bodyHash,
              status: 'PENDING',
              claimToken,
              claimExpiresAt,
              attempts: 1,
            },
          });
          return { requestId: created.id, claimToken };
        } catch {
          existing = await transaction.lunchBreakGenerationRequest.findUnique({
            where: { tenantId_requestKeyHash: { tenantId, requestKeyHash: keyHash } },
          });
          if (!existing) throw problem(503, 'generation_claim_unavailable', 'Lunch and break generation is temporarily unavailable. Retry the request.', 'Service unavailable');
        }
      }
      if (existing.requestHash !== bodyHash) {
        throw problem(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different lunch and break generation request.', 'Conflict');
      }
      if (existing.status === 'SUCCEEDED') {
        const response = toStoredResponse(existing.response);
        if (!response) {
          throw problem(409, 'idempotency_conflict', 'The saved lunch and break generation outcome is unavailable. Use a new Idempotency-Key.', 'Conflict');
        }
        return { response: { ...response, reused: true } };
      }
      if (existing.status === 'PENDING' && existing.claimExpiresAt && existing.claimExpiresAt > now) {
        throw problem(409, 'generation_in_progress', 'Lunch and break generation is already in progress for this Idempotency-Key.', 'Conflict');
      }
      if (existing.status === 'FAILED' && existing.failureStatus !== 403 && (existing.failureStatus ?? 500) < 500) {
        throw problem(existing.failureStatus ?? 422, 'generation_previously_rejected', existing.failureMessage || 'The previous lunch and break generation request was rejected.', 'Request rejected');
      }
      const reclaimed = await transaction.lunchBreakGenerationRequest.updateMany({
        where: {
          id: existing.id,
          tenantId,
          requestHash: bodyHash,
          OR: [
            { status: 'FAILED' },
            { status: 'PENDING', claimExpiresAt: { lte: now } },
            { status: 'PENDING', claimExpiresAt: null },
          ],
        },
        data: {
          status: 'PENDING',
          claimToken,
          claimExpiresAt,
          attempts: { increment: 1 },
          failureStatus: null,
          failureMessage: null,
          completedAt: null,
        },
      });
      if (reclaimed.count !== 1) {
        throw problem(409, 'generation_in_progress', 'Lunch and break generation is already in progress for this Idempotency-Key.', 'Conflict');
      }
      return { requestId: existing.id, claimToken };
    });
  }

  private async completeGeneration(
    identity: SessionIdentity,
    claim: GenerationClaim,
    bodyHash: string,
    prepared: PreparedGeneration,
  ): Promise<LunchBreakGenerationResponse> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const renewed = await transaction.lunchBreakGenerationRequest.updateMany({
        where: {
          id: claim.requestId,
          tenantId: identity.tenantId,
          requestHash: bodyHash,
          status: 'PENDING',
          claimToken: claim.claimToken,
        },
        data: { claimExpiresAt: new Date(Date.now() + 2 * 60_000) },
      });
      if (renewed.count !== 1) {
        throw problem(409, 'generation_claim_expired', 'The lunch and break generation claim expired. Retry the request.', 'Conflict');
      }
      const entitlement = await assertFeatureEntitled(transaction, identity.tenantId, 'lunch_breaks', true);
      if (!entitlement) throw problem(403, 'lunch_breaks_not_entitled', 'Lunch and break generation requires usage credits.', 'Feature unavailable');
      await lockSchedulingAggregate(transaction, identity.tenantId);
      if (prepared.persisted) {
        await this.assertPersistableGeneration(transaction, identity.tenantId, prepared);
      }
      const settlement = await debitFeatureCredit(transaction, {
        tenantId: identity.tenantId,
        entitlement,
        operationId: claim.requestId,
        reason: `Lunch/break generation (${claim.requestId})`,
        transactionId: `lunch-break-credit-${claim.requestId}`,
      });
      const response: LunchBreakGenerationResponse = {
        locationId: prepared.locationId,
        source: prepared.source,
        persisted: prepared.persisted,
        policy: prepared.policy,
        creditConsumption: {
          consumedCredits: settlement.consumedCredits,
          newBalance: settlement.newBalance,
          source: 'credits',
        },
        data: prepared.data,
        reused: false,
      };
      if (prepared.persisted) await this.persistGeneratedBreaks(transaction, identity.tenantId, prepared);
      await transaction.lunchBreakGenerationRequest.update({
        where: { id: claim.requestId },
        data: {
          status: 'SUCCEEDED',
          response: response as unknown as Prisma.InputJsonValue,
          creditConsumption: response.creditConsumption as unknown as Prisma.InputJsonValue,
          creditTransactionId: `lunch-break-credit-${claim.requestId}`,
          calculationSnapshot: prepared.snapshot as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
          failureStatus: null,
          failureMessage: null,
          claimToken: null,
          claimExpiresAt: null,
        },
      });
      return response;
    });
  }

  private async assertPersistableGeneration(
    transaction: TenantTransaction,
    tenantId: string,
    prepared: PreparedGeneration,
  ): Promise<void> {
    if (!prepared.locationId || prepared.snapshot.length === 0 || prepared.snapshot.length !== prepared.data.length) {
      throw problem(409, 'generation_scope_changed', 'The selected shifts changed before lunch and break generation could be saved. Retry the request.', 'Concurrent change');
    }
    await this.assertDraftSchedules(transaction, tenantId, prepared.snapshot.map((item) => item.scheduleId));
    const shiftIds = prepared.snapshot.map((item) => item.id).sort();
    await transaction.$queryRaw`
      SELECT "id"
      FROM "Shift"
      WHERE "tenantId" = ${tenantId}
        AND "deletedAt" IS NULL
        AND "id" IN (${Prisma.join(shiftIds)})
      ORDER BY "id" ASC
      FOR UPDATE
    `;
    const current = await transaction.shift.findMany({
      where: { tenantId, deletedAt: null, id: { in: shiftIds }, AND: [SCHEDULABLE_SHIFT_USER_FILTER] },
      select: { id: true, publicId: true, location: { select: { publicId: true } }, scheduleId: true, startTime: true, endTime: true, updatedAt: true, schedule: { select: { status: true } } },
    });
    const byId = new Map(current.map((row) => [row.id, row]));
    const changed = prepared.snapshot.some((snapshot) => {
      const row = byId.get(snapshot.id);
      return !row
        || row.publicId !== snapshot.publicId
        || row.location.publicId !== prepared.locationId
        || row.scheduleId !== snapshot.scheduleId
        || row.startTime.toISOString() !== snapshot.startTime
        || row.endTime.toISOString() !== snapshot.endTime
        || row.updatedAt.toISOString() !== snapshot.updatedAt
        || row.schedule?.status !== 'DRAFT';
    });
    if (changed || current.length !== prepared.snapshot.length) {
      throw problem(409, 'generation_scope_changed', 'One or more selected shifts changed after lunch and break calculation. Reload and retry.', 'Concurrent change');
    }
  }

  private async persistGeneratedBreaks(
    transaction: TenantTransaction,
    tenantId: string,
    prepared: PreparedGeneration,
  ): Promise<void> {
    const byPublicId = new Map(prepared.snapshot.map((item) => [item.publicId, item.id]));
    const entries = prepared.data.flatMap((row) => row.breaks.map((entry) => {
      const shiftId = row.shiftId ? byPublicId.get(row.shiftId) : undefined;
      if (!shiftId) {
        throw problem(409, 'generation_scope_changed', 'A selected shift could not be resolved while saving lunch and breaks.', 'Concurrent change');
      }
      return {
        shiftId,
        type: DB_BREAK_TYPE[entry.type],
        startTime: new Date(entry.startTime),
        endTime: new Date(entry.endTime),
        paid: entry.paid,
      };
    }));
    const shiftIds = prepared.snapshot.map((item) => item.id);
    await transaction.break.deleteMany({ where: { shiftId: { in: shiftIds } } });
    if (entries.length > 0) await transaction.break.createMany({ data: entries });
    await transaction.shift.updateMany({ where: { tenantId, deletedAt: null, id: { in: shiftIds } }, data: { updatedAt: new Date() } });
    await this.incrementDraftRevisions(transaction, tenantId, prepared.snapshot.map((item) => item.scheduleId));
  }

  private async findGeneration(tenantId: string, idempotencyKey: string) {
    return this.database.withTenant(tenantId, (transaction) => transaction.lunchBreakGenerationRequest.findUnique({
      where: { tenantId_requestKeyHash: { tenantId, requestKeyHash: sha256(idempotencyKey) } },
    }));
  }

  private async failGeneration(tenantId: string, claim: GenerationClaim, error: unknown): Promise<void> {
    const status = error instanceof ProblemError ? error.status : 503;
    const detail = error instanceof ProblemError ? error.message : 'Lunch and break generation failed.';
    await this.database.withTenant(tenantId, (transaction) => transaction.lunchBreakGenerationRequest.updateMany({
      where: { id: claim.requestId, tenantId, status: 'PENDING', claimToken: claim.claimToken },
      data: {
        status: 'FAILED',
        failureStatus: status,
        failureMessage: detail.slice(0, 1000),
        completedAt: new Date(),
        claimToken: null,
        claimExpiresAt: null,
      },
    })).catch(() => undefined);
  }

  private buildBreakSchedule(input: readonly GeneratedInput[], policy: LunchBreakPolicy): LunchBreakRow[] {
    return input.map((shift) => {
      const start = parseUtcInstant(shift.startTime, '/shifts/startTime');
      const end = parseUtcInstant(shift.endTime, '/shifts/endTime');
      if (end <= start) {
        throw problem(422, 'invalid_break_generation', 'Shift end time must be after shift start time.', 'Break generation validation failed');
      }
      const lunchDuration = integer(shift.lunchDurationMinutes, policy.lunchDurationMinutes, 15, 120);
      const breaks = this.placeBreaks(start.getTime(), end.getTime(), policy, lunchDuration);
      return {
        shiftId: shift.shiftId,
        userId: shift.userId,
        employeeName: shift.employeeName || null,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        breaks,
      };
    });
  }

  private placeBreaks(
    shiftStartMs: number,
    shiftEndMs: number,
    policy: LunchBreakPolicy,
    lunchDuration: number,
  ): LunchBreakRow['breaks'] {
    const specs: Array<{ type: BreakType; durationMinutes: number; preferredStartMs: number; paid: boolean; priority: number }> = [
      { type: 'break1', durationMinutes: policy.break1DurationMinutes, preferredStartMs: shiftStartMs + policy.break1OffsetMinutes * 60_000, paid: true, priority: 2 },
      { type: 'lunch', durationMinutes: lunchDuration, preferredStartMs: shiftStartMs + policy.lunchOffsetMinutes * 60_000, paid: false, priority: 4 },
      { type: 'break2', durationMinutes: policy.break2DurationMinutes, preferredStartMs: shiftStartMs + (policy.lunchOffsetMinutes + lunchDuration + policy.break2OffsetMinutes) * 60_000, paid: true, priority: 1 },
    ];
    const stepMs = policy.timeStepMinutes * 60_000;
    let best: { breaks: LunchBreakRow['breaks']; score: number } = { breaks: [], score: 0 };
    for (let mask = 1; mask < (1 << specs.length); mask += 1) {
      const selected = specs.filter((_entry, index) => (mask & (1 << index)) !== 0);
      const candidate = this.placeBreakSubset(shiftStartMs, shiftEndMs, stepMs, selected);
      if (!candidate) continue;
      const score = selected.reduce((total, item) => total + item.priority, 0);
      if (candidate.length > best.breaks.length || (candidate.length === best.breaks.length && score > best.score)) {
        best = { breaks: candidate, score };
      }
    }
    return best.breaks;
  }

  private placeBreakSubset(
    shiftStartMs: number,
    shiftEndMs: number,
    stepMs: number,
    specs: ReadonlyArray<{ type: BreakType; durationMinutes: number; preferredStartMs: number; paid: boolean }>,
  ): LunchBreakRow['breaks'] | null {
    const latestStarts: number[] = new Array(specs.length);
    for (let index = specs.length - 1; index >= 0; index -= 1) {
      const durationMs = specs[index].durationMinutes * 60_000;
      latestStarts[index] = index === specs.length - 1
        ? shiftEndMs - durationMs
        : latestStarts[index + 1] - this.minimumGap(specs[index].type, specs[index + 1].type) - durationMs;
    }
    let earliest = shiftStartMs + 30 * 60_000;
    const output: LunchBreakRow['breaks'] = [];
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      const latest = latestStarts[index];
      if (earliest > latest) return null;
      const rounded = Math.round(Math.min(latest, Math.max(earliest, spec.preferredStartMs)) / stepMs) * stepMs;
      const start = Math.min(latest, Math.max(earliest, rounded));
      const end = start + spec.durationMinutes * 60_000;
      if (start < shiftStartMs || end > shiftEndMs || end <= start) return null;
      output.push({
        type: spec.type,
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),
        durationMinutes: spec.durationMinutes,
        paid: spec.paid,
      });
      if (index < specs.length - 1) earliest = end + this.minimumGap(spec.type, specs[index + 1].type);
    }
    return output;
  }

  private minimumGap(left: BreakType, right: BreakType): number {
    return left === 'break1' && right === 'lunch' ? 30 * 60_000 : 15 * 60_000;
  }

  async setupShifts(
    identity: SessionIdentity,
    body: SetupShiftsRequest,
    idempotencyKeyValue: string | undefined,
  ): Promise<SetupShiftsResponse> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const bodyHash = setupIdentity(body);
    const operationId = canonicalIdempotencyOperation('api-v2:lunch-break-setup', identity.tenantId, idempotencyKey);
    const semanticOperationId = body.rows.some((row) => row.shiftId === undefined && (row.userId === undefined || row.userId === null))
      ? canonicalIdempotencyOperation('api-v2:lunch-break-setup-semantic', identity.tenantId, bodyHash)
      : null;
    const replay = await this.findSetupReplay(identity.tenantId, operationId, bodyHash)
      ?? (semanticOperationId ? await this.findSetupReplay(identity.tenantId, semanticOperationId, bodyHash, 'ApiV2LunchBreakSetupSemanticRequest') : null);
    if (replay) return replay;

    try {
      return await this.database.withTenant(identity.tenantId, async (transaction) => {
        const lockedReplay = await this.findSetupReplayInTransaction(transaction, identity.tenantId, operationId, bodyHash);
        if (lockedReplay) return lockedReplay;
        if (semanticOperationId) {
          const semanticReplay = await this.findSetupReplayInTransaction(
            transaction,
            identity.tenantId,
            semanticOperationId,
            bodyHash,
            'ApiV2LunchBreakSetupSemanticRequest',
          );
          if (semanticReplay) return semanticReplay;
        }
        await assertFeatureEntitled(transaction, identity.tenantId, 'scheduling', false);
        await lockSchedulingAggregate(transaction, identity.tenantId);
        const location = await transaction.location.findFirst({
          where: { tenantId: identity.tenantId, publicId: body.locationId, deletedAt: null },
          select: { id: true, publicId: true },
        });
        if (!location) throw problem(404, 'location_not_found', 'The selected location was not found in this workspace.', 'Location not found');

        const existingPublicIds = body.rows.flatMap((row) => row.shiftId ? [row.shiftId] : []);
        if (new Set(existingPublicIds).size !== existingPublicIds.length) {
          throw problem(422, 'invalid_setup_shifts', 'Each existing setup shift can appear only once.', 'Setup shift validation failed');
        }
        const existingRows = existingPublicIds.length === 0 ? [] : await transaction.shift.findMany({
          where: {
            tenantId: identity.tenantId,
            deletedAt: null,
            publicId: { in: existingPublicIds },
            AND: [SCHEDULABLE_SHIFT_USER_FILTER],
          },
          select: internalShiftSelect(),
        }) as unknown as InternalShift[];
        if (existingRows.length !== existingPublicIds.length || existingRows.some((row) => row.location.publicId !== location.publicId)) {
          throw problem(404, 'shift_not_found', 'One or more setup shifts were not found for the selected location.', 'Shift not found');
        }
        await this.assertDraftSchedules(transaction, identity.tenantId, existingRows.map((row) => row.schedule?.id));
        if (existingRows.length > 0) {
          await transaction.$queryRaw`
            SELECT "id"
            FROM "Break"
            WHERE "shiftId" IN (${Prisma.join(existingRows.map((row) => row.id).sort())})
            ORDER BY "id" ASC
            FOR UPDATE
          `;
        }
        const existingByPublicId = new Map(existingRows.map((row) => [row.publicId, row]));
        const assignedPublicIds = [...new Set(body.rows.flatMap((row) => (
          typeof row.userId === 'string' ? [row.userId] : []
        )))];
        const users = assignedPublicIds.length === 0 ? [] : await transaction.user.findMany({
          where: {
            tenantId: identity.tenantId,
            publicId: { in: assignedPublicIds },
            deletedAt: null,
            suspendedAt: null,
            role: { in: [UserRole.MANAGER, UserRole.STAFF] },
          },
          select: { id: true, publicId: true },
        });
        const userByPublicId = new Map(users.map((row) => [row.publicId, row.id]));
        if (userByPublicId.size !== assignedPublicIds.length) {
          throw problem(404, 'staff_not_found', 'A selected staff member is not available for scheduling in this workspace.', 'Staff member not found');
        }

        const plans = body.rows.map((row) => {
          const existing = row.shiftId ? existingByPublicId.get(row.shiftId) ?? null : null;
          const startTime = parseUtcInstant(row.startTime, '/rows/startTime');
          const endTime = parseUtcInstant(row.endTime, '/rows/endTime');
          if (endTime <= startTime) {
            throw problem(422, 'invalid_setup_shifts', 'Setup shift end time must be after start time.', 'Setup shift validation failed');
          }
          if (existing?.schedule && (startTime < existing.schedule.startDate || endTime > existing.schedule.endDate)) {
            throw problem(422, 'invalid_setup_shifts', 'A setup shift must remain inside its draft schedule window.', 'Setup shift validation failed');
          }
          const nextUserId = row.userId === undefined
            ? existing?.userId ?? null
            : row.userId === null
              ? null
              : userByPublicId.get(row.userId) ?? null;
          const translatedBreaks = existing
            && (existing.startTime.getTime() !== startTime.getTime() || existing.endTime.getTime() !== endTime.getTime())
            ? this.translateBreaks(existing.breaks, existing.startTime, startTime, endTime)
            : [];
          return {
            row,
            existing,
            startTime,
            endTime,
            nextUserId,
            translatedBreaks,
            changed: !existing
              || existing.startTime.getTime() !== startTime.getTime()
              || existing.endTime.getTime() !== endTime.getTime()
              || existing.userId !== nextUserId,
          };
        });

        await this.assertSetupOverlaps(
          transaction,
          identity.tenantId,
          plans.map((plan) => ({
            startTime: plan.startTime,
            endTime: plan.endTime,
            userId: plan.nextUserId,
          })),
          existingRows.map((row) => row.id),
        );
        const changed = plans.some((plan) => plan.changed);
        if (changed) {
          const entitlement = await assertFeatureEntitled(transaction, identity.tenantId, 'scheduling', true);
          if (!entitlement) throw problem(403, 'scheduling_not_entitled', 'Setup shifts require usage credits.', 'Feature unavailable');
          await debitFeatureCredit(transaction, {
            tenantId: identity.tenantId,
            entitlement,
            operationId,
            reason: `Lunch/break setup shift persistence (${operationId})`,
          });
        }

        const publicShiftIds: string[] = [];
        for (const plan of plans) {
          if (plan.existing) {
            publicShiftIds.push(plan.existing.publicId);
            if (!plan.changed) continue;
            const updated = await transaction.shift.updateMany({
              where: {
                id: plan.existing.id,
                tenantId: identity.tenantId,
                locationId: location.id,
                userId: plan.existing.userId,
                startTime: plan.existing.startTime,
                endTime: plan.existing.endTime,
                deletedAt: null,
              },
              data: { startTime: plan.startTime, endTime: plan.endTime, userId: plan.nextUserId },
            });
            if (updated.count !== 1) {
              throw problem(409, 'concurrent_change', 'A setup shift changed while it was being saved. Reload and retry.', 'Concurrent change');
            }
            for (const entry of plan.translatedBreaks) {
              const updatedBreak = await transaction.break.updateMany({
                where: { id: entry.id, shiftId: plan.existing.id },
                data: { startTime: entry.startTime, endTime: entry.endTime },
              });
              if (updatedBreak.count !== 1) {
                throw problem(409, 'concurrent_change', 'A dependent lunch or break changed while setup shifts were being saved. Reload and retry.', 'Concurrent change');
              }
            }
            continue;
          }
          const created = await transaction.shift.create({
            data: {
              tenantId: identity.tenantId,
              locationId: location.id,
              userId: plan.nextUserId,
              startTime: plan.startTime,
              endTime: plan.endTime,
              role: null,
            },
            select: { publicId: true },
          });
          publicShiftIds.push(created.publicId);
        }
        await this.incrementDraftRevisions(transaction, identity.tenantId, plans.map((plan) => plan.existing?.schedule?.id));
        const response = { shiftIds: publicShiftIds };
        await this.writeSetupAudit(transaction, identity, operationId, semanticOperationId, bodyHash, response);
        return response;
      });
    } catch (error) {
      const committed = await this.findSetupReplay(identity.tenantId, operationId, bodyHash);
      if (committed) return committed;
      throw error;
    }
  }

  private translateBreaks(
    entries: InternalShift['breaks'],
    previousStart: Date,
    nextStart: Date,
    nextEnd: Date,
  ): Array<{ id: string; startTime: Date; endTime: Date }> {
    const delta = nextStart.getTime() - previousStart.getTime();
    const translated = entries.map((entry) => ({
      id: entry.id,
      startTime: new Date(entry.startTime.getTime() + delta),
      endTime: new Date(entry.endTime.getTime() + delta),
    })).sort((left, right) => left.startTime.getTime() - right.startTime.getTime() || left.id.localeCompare(right.id));
    const invalid = translated.some((entry, index) => (
      entry.endTime <= entry.startTime
      || entry.startTime < nextStart
      || entry.endTime > nextEnd
      || (index > 0 && entry.startTime < translated[index - 1].endTime)
    ));
    if (invalid) {
      throw problem(409, 'setup_shift_break_conflict', 'The resized setup shift would place an existing lunch or break outside the shift window. Move the breaks first or choose a larger window.', 'Conflict');
    }
    return translated;
  }

  private async assertSetupOverlaps(
    transaction: TenantTransaction,
    tenantId: string,
    plans: ReadonlyArray<{ startTime: Date; endTime: Date; userId: string | null }>,
    excludedShiftIds: readonly string[],
  ): Promise<void> {
    const byUser = new Map<string, Array<{ startTime: Date; endTime: Date }>>();
    for (const plan of plans) {
      if (!plan.userId) continue;
      const prior = byUser.get(plan.userId) ?? [];
      if (prior.some((entry) => plan.startTime < entry.endTime && plan.endTime > entry.startTime)) {
        throw problem(409, 'setup_shift_overlap', 'Setup shifts cannot overlap for the same assigned staff member.', 'Conflict');
      }
      prior.push(plan);
      byUser.set(plan.userId, prior);
    }
    for (const [userId, rows] of byUser) {
      for (const row of rows) {
        const overlap = await transaction.shift.count({
          where: {
            tenantId,
            userId,
            deletedAt: null,
            startTime: { lt: row.endTime },
            endTime: { gt: row.startTime },
            ...(excludedShiftIds.length > 0 ? { id: { notIn: [...excludedShiftIds] } } : {}),
          },
        });
        if (overlap > 0) {
          throw problem(409, 'setup_shift_overlap', 'A selected staff member already has a shift that overlaps this setup window.', 'Conflict');
        }
      }
    }
  }

  private async writeSetupAudit(
    transaction: TenantTransaction,
    identity: SessionIdentity,
    operationId: string,
    semanticOperationId: string | null,
    bodyHash: string,
    response: SetupShiftsResponse,
  ): Promise<void> {
    const data = {
      tenantId: identity.tenantId,
      userId: identity.sub,
      actorUserId: identity.sub,
      actorTenantId: identity.tenantId,
      action: 'API_V2_LUNCH_BREAK_SETUP_PERSISTED',
      resource: 'ApiV2LunchBreakSetupRequest',
      resourceId: operationId,
      newValue: { requestHash: bodyHash, response } as unknown as Prisma.InputJsonValue,
    };
    await transaction.auditLog.create({ data });
    if (semanticOperationId) {
      await transaction.auditLog.create({
        data: {
          ...data,
          resource: 'ApiV2LunchBreakSetupSemanticRequest',
          resourceId: semanticOperationId,
        },
      });
    }
  }

  private async findSetupReplay(
    tenantId: string,
    operationId: string,
    bodyHash: string,
    resource = 'ApiV2LunchBreakSetupRequest',
  ): Promise<SetupShiftsResponse | null> {
    return this.database.withTenant(tenantId, (transaction) => this.findSetupReplayInTransaction(transaction, tenantId, operationId, bodyHash, resource));
  }

  private async findSetupReplayInTransaction(
    transaction: TenantTransaction,
    tenantId: string,
    operationId: string,
    bodyHash: string,
    resource = 'ApiV2LunchBreakSetupRequest',
  ): Promise<SetupShiftsResponse | null> {
    const stored = await transaction.auditLog.findFirst({
      where: {
        tenantId,
        action: 'API_V2_LUNCH_BREAK_SETUP_PERSISTED',
        resource,
        resourceId: operationId,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { newValue: true },
    });
    if (!stored) return null;
    if (!stored.newValue || typeof stored.newValue !== 'object' || Array.isArray(stored.newValue)) {
      throw problem(409, 'idempotency_conflict', 'The saved setup shift outcome is unavailable. Use a new Idempotency-Key.', 'Conflict');
    }
    const record = stored.newValue as Record<string, unknown>;
    const response = record.response;
    const shiftIds = response && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>).shiftIds
      : undefined;
    if (
      record.requestHash !== bodyHash
      || !response
      || typeof response !== 'object'
      || Array.isArray(response)
      || !Array.isArray(shiftIds)
      || shiftIds.some((id: unknown) => typeof id !== 'string' || !isUuid(id))
    ) {
      throw problem(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different setup shift request.', 'Conflict');
    }
    return response as SetupShiftsResponse;
  }

  private publicShiftIds(value: string): string[] {
    const ids = [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > 1000 || ids.some((id) => !isUuid(id))) {
      throw problem(422, 'invalid_shift_reference', 'shiftIds must contain up to 1,000 public shift UUIDs.', 'Lunch and break validation failed');
    }
    return ids;
  }

  private async readPolicy(transaction: TenantTransaction, tenantId: string): Promise<LunchBreakPolicy> {
    const setting = await transaction.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId, key: 'lunch_break_policy' } },
      select: { value: true },
    });
    if (!setting?.value || typeof setting.value !== 'object' || Array.isArray(setting.value)) return { ...DEFAULT_POLICY };
    return normalizePolicy(setting.value as Record<string, unknown>);
  }

  private breakPayload(
    shift: InternalShift,
    inputs: readonly NormalizedBreakInput[],
    policy: LunchBreakPolicy,
  ): Array<{ type: BreakType; startTime: string; endTime: string; paid: boolean; durationMinutes: number }> {
    return inputs.flatMap((entry) => {
      if (entry.skip) return [];
      if (!entry.startTime) throw problem(422, 'invalid_break_update', `${entry.type} requires startTime.`, 'Break update validation failed');
      const start = parseUtcInstant(entry.startTime, '/breaks/startTime');
      const fallback = entry.type === 'lunch'
        ? policy.lunchDurationMinutes
        : entry.type === 'break1'
          ? policy.break1DurationMinutes
          : policy.break2DurationMinutes;
      const minimum = entry.type === 'lunch' ? 15 : 5;
      const maximum = entry.type === 'lunch' ? 120 : 60;
      const durationMinutes = integer(entry.durationMinutes, fallback, minimum, maximum);
      const end = new Date(start.getTime() + durationMinutes * 60_000);
      return [{
        type: entry.type,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        durationMinutes,
        paid: entry.type !== 'lunch',
      }];
    });
  }

  private assertBreaksInsideShift(
    shiftStart: Date,
    shiftEnd: Date,
    breaks: ReadonlyArray<{ startTime: string; endTime: string }>,
  ): void {
    const ordered = [...breaks].sort((left, right) => left.startTime.localeCompare(right.startTime));
    let priorEnd = shiftStart;
    for (const entry of ordered) {
      const start = new Date(entry.startTime);
      const end = new Date(entry.endTime);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start < shiftStart || end > shiftEnd || end <= start || start < priorEnd) {
        throw problem(422, 'invalid_break_window', 'Lunch and break windows must be non-overlapping and remain inside their shift.', 'Break update validation failed');
      }
      priorEnd = end;
    }
  }

  private sameBreaks(
    current: LunchBreakRow['breaks'],
    next: ReadonlyArray<{ type: BreakType; startTime: string; endTime: string; paid: boolean }>,
  ): boolean {
    if (current.length !== next.length) return false;
    const normalize = (entries: ReadonlyArray<{ type: string; startTime: string; endTime: string; paid: boolean }>) => (
      [...entries]
        .map((entry) => `${entry.type}:${entry.startTime}:${entry.endTime}:${entry.paid}`)
        .sort()
        .join('|')
    );
    return normalize(current) === normalize(next);
  }

  private async findShiftBreakReplay(
    tenantId: string,
    operationId: string,
    bodyHash: string,
  ): Promise<LunchBreakRow | null> {
    return this.database.withTenant(tenantId, (transaction) => this.findShiftBreakReplayInTransaction(transaction, tenantId, operationId, bodyHash));
  }

  private async findShiftBreakReplayInTransaction(
    transaction: TenantTransaction,
    tenantId: string,
    operationId: string,
    bodyHash: string,
  ): Promise<LunchBreakRow | null> {
    const stored = await transaction.auditLog.findFirst({
      where: {
        tenantId,
        action: 'API_V2_LUNCH_BREAK_SHIFT_REPLACED',
        resource: 'ApiV2LunchBreakShiftRequest',
        resourceId: operationId,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { newValue: true },
    });
    if (!stored) return null;
    const value = stored.newValue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw problem(409, 'idempotency_conflict', 'The saved lunch and break outcome is unavailable. Use a new Idempotency-Key.', 'Conflict');
    }
    const record = value as Record<string, unknown>;
    if (record.requestHash !== bodyHash || !record.response || typeof record.response !== 'object' || Array.isArray(record.response)) {
      throw problem(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different lunch and break request.', 'Conflict');
    }
    return record.response as LunchBreakRow;
  }

  private async assertDraftSchedules(
    transaction: TenantTransaction,
    tenantId: string,
    scheduleIds: ReadonlyArray<string | null | undefined>,
  ): Promise<void> {
    const ids = [...new Set(scheduleIds.filter((id): id is string => Boolean(id)))].sort();
    if (ids.length === 0) return;
    const rows = await transaction.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status"
      FROM "Schedule"
      WHERE "tenantId" = ${tenantId}
        AND "id" IN (${Prisma.join(ids)})
      ORDER BY "id" ASC
      FOR UPDATE
    `;
    if (rows.length !== ids.length || rows.some((row) => row.status !== 'DRAFT')) {
      throw problem(409, 'schedule_locked', 'Published schedules are locked. Reopen the schedule before changing lunch and breaks.', 'Schedule locked');
    }
  }

  private async incrementDraftRevisions(
    transaction: TenantTransaction,
    tenantId: string,
    scheduleIds: ReadonlyArray<string | null | undefined>,
  ): Promise<void> {
    const ids = [...new Set(scheduleIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    const updated = await transaction.schedule.updateMany({
      where: { tenantId, id: { in: ids }, status: 'DRAFT', deletedAt: null },
      data: { revision: { increment: 1 } },
    });
    if (updated.count !== ids.length) {
      throw problem(409, 'concurrent_change', 'A draft schedule changed while lunch and breaks were being saved. Reload and retry.', 'Concurrent change');
    }
  }
}
