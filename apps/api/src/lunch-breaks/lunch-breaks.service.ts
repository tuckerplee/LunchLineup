import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Injectable,
    NotFoundException,
    Optional,
} from "@nestjs/common";
import { BreakType as PrismaBreakType, Prisma, UserRole } from "@prisma/client";
import { randomUUID } from "crypto";
import {
    FeatureAccessService,
    type FeatureResolution,
} from "../billing/feature-access.service";
import {
    assertBoundedListWindow,
    buildBoundedListPage,
    decodeBoundedListCursor,
    parseBoundedListLimit,
    parseOptionalBoundedDate,
    type BoundedPagination,
} from "../common/bounded-pagination";
import {
    ACTIVE_SCHEDULABLE_USER_FILTER,
    lockActiveSchedulableUser,
} from "../common/schedulable-user";
import {
    TenantPrismaService,
    type TenantPrismaTransaction,
} from "../database/tenant-prisma.service";
import {
    assertShiftUpdateWindow,
    assertShiftUpdateWithinSchedule,
    mapShiftUpdateInvariantError,
    translateShiftBreakWindows,
    type ShiftBreakWindow,
} from "../shifts/shift-update-invariants";
import {
    hashLunchBreakGenerationIdempotencyKey,
    lunchBreakGenerationRequestHash,
    normalizeLunchBreakGenerationIdempotencyKey,
} from "./lunch-break-generation-idempotency";
import {
    normalizeShiftBreakUpdateIdempotencyKey,
    shiftBreakUpdateOperationId,
    shiftBreakUpdateRequestHash,
    type ShiftBreakUpdateIdentity,
} from './shift-break-update-idempotency';
import {
    normalizeSetupShiftsIdempotencyKey,
    setupShiftsNeedsSemanticReplay,
    setupShiftsOperationId,
    setupShiftsRequestHash,
    setupShiftsSemanticOperationId,
    type SetupShiftIdentity,
    type SetupShiftsIdentity,
} from './setup-shifts-idempotency';

export type BreakType = "break1" | "lunch" | "break2";

export interface LunchBreakPolicy {
    break1OffsetMinutes: number;
    lunchOffsetMinutes: number;
    break2OffsetMinutes: number;
    break1DurationMinutes: number;
    lunchDurationMinutes: number;
    break2DurationMinutes: number;
    timeStepMinutes: number;
}

export interface LunchBreakShiftInput {
    id?: string;
    userId?: string | null;
    employeeName?: string | null;
    startTime: string;
    endTime: string;
    lunchDurationMinutes?: number;
}

export interface GenerateLunchBreaksRequest {
    scheduleId?: string;
    locationId?: string;
    shiftIds?: string[];
    persist?: boolean;
    policy?: Partial<LunchBreakPolicy>;
    shifts?: LunchBreakShiftInput[];
}

export interface GeneratedBreak {
    type: BreakType;
    startTime: string;
    endTime: string;
    durationMinutes: number;
    paid: boolean;
}

export interface GeneratedShiftBreaks {
    shiftId: string | null;
    userId: string | null;
    employeeName: string | null;
    startTime: string;
    endTime: string;
    breaks: GeneratedBreak[];
}

export interface UpdateShiftBreakInput {
    type: BreakType;
    startTime?: string;
    durationMinutes?: number;
    skip?: boolean;
}

export interface UpdateShiftLunchBreaksRequest {
    locationId?: string;
    breaks?: UpdateShiftBreakInput[];
}

export interface PersistSetupShiftInput {
    shiftId?: string | null;
    userId?: string | null;
    employeeName?: string | null;
    startTime: string;
    endTime: string;
}

export interface PersistSetupShiftsRequest {
    locationId?: string;
    rows?: PersistSetupShiftInput[];
}

export interface LunchBreakListFilters {
    scheduleId?: string;
    locationId?: string;
    shiftIds?: string[];
    startDate?: string;
    endDate?: string;
    limit?: string | number;
    cursor?: string | null;
}

export interface LunchBreakActor {
    sub?: string;
    id?: string;
    role?: string;
    legacyRole?: string;
    roles?: string[];
}
type CreditConsumption = {
    consumedCredits: number;
    newBalance: number;
    source: "credits";
};

type GenerationSource = "shared_schedule" | "standalone";

type GenerationResponse = {
    source: GenerationSource;
    persisted: boolean;
    policy: LunchBreakPolicy;
    creditConsumption: CreditConsumption;
    data: GeneratedShiftBreaks[];
    reused: boolean;
};

type GenerationClaim = {
    requestId: string;
    claimToken: string;
};

type GenerationClaimResult =
    | GenerationClaim
    | { reusedResponse: GenerationResponse };

type GenerationRequestRecord = {
    id: string;
    requestHash: string;
    status: string;
    response: Prisma.JsonValue | null;
    failureMessage: string | null;
    failureStatus: number | null;
    claimToken: string | null;
};

type CalculationShiftSnapshot = {
    id: string;
    scheduleId: string | null;
    startTime: string;
    endTime: string;
    updatedAt?: string;
};

type GenerationPrepared = {
    source: GenerationSource;
    persisted: boolean;
    policy: LunchBreakPolicy;
    data: GeneratedShiftBreaks[];
    generated?: GeneratedShiftBreaks[];
    calculationSnapshot: CalculationShiftSnapshot[];
};

type CreditReservationArgs = {
    tenantId: string;
    requestId: string;
    entitlement: FeatureResolution;
};

type SetupShiftsResponse = {
    shiftIds: string[];
};

type SetupExistingShift = {
    id: string;
    locationId: string;
    scheduleId: string | null;
    userId: string | null;
    startTime: Date;
    endTime: Date;
    schedule: {
        status: string;
        startDate: Date;
        endDate: Date;
    } | null;
};

type SetupShiftMutationPlan = {
    row: SetupShiftIdentity;
    existing: SetupExistingShift | null;
    nextStartTime: Date;
    nextEndTime: Date;
    nextUserId: string | null;
    valueChanged: boolean;
    translatedBreaks: ShiftBreakWindow[];
};

type BreakPlacementSpec = {
    type: BreakType;
    durationMinutes: number;
    preferredStartMs: number;
    paid: boolean;
    priority: number;
};

type BreakWindow = {
    startTime: Date;
    endTime: Date;
};

type ShiftBreakMutation = BreakWindow & {
    shiftId: string;
    type: PrismaBreakType;
    paid: boolean;
};

type SharedShift = Prisma.ShiftGetPayload<{
    include: {
        user: { select: { id: true; name: true; role: true } };
    };
}>;

type ShiftWithBreaks = Prisma.ShiftGetPayload<{
    include: {
        user: { select: { id: true; name: true; role: true } };
        breaks: true;
    };
}>;

type ScheduleStatusValue = string | null | undefined;
const BREAK_TYPES = ['break1', 'lunch', 'break2'] as const;
const GENERATION_CLAIM_MS = 2 * 60_000;
const UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
const DB_BREAK_TYPE_BY_API_TYPE: Record<BreakType, PrismaBreakType> = {
    break1: PrismaBreakType.BREAK1,
    lunch: PrismaBreakType.LUNCH,
    break2: PrismaBreakType.BREAK2,
};
const API_BREAK_TYPE_BY_DB_TYPE: Partial<Record<string, BreakType>> = {
    BREAK1: 'break1',
    LUNCH: 'lunch',
    BREAK2: 'break2',
};
const TENANT_POLICY_SETTINGS_KEY = 'lunch_break_policy';
const SETUP_SHIFTS_ACTION = 'LUNCH_BREAK_SETUP_SHIFTS_PERSISTED';
const SETUP_SHIFTS_IDEMPOTENCY_RESOURCE = 'LunchBreakSetupShiftsRequest';
const SETUP_SHIFTS_SEMANTIC_RESOURCE = 'LunchBreakSetupShiftsSemanticRequest';
const SETUP_SHIFTS_ENTITLEMENT_CODE = 'SETUP_SHIFTS_ENTITLEMENT_REQUIRED';
const SETUP_SHIFTS_CONFLICT_CODE = 'SETUP_SHIFTS_CONFLICT';
const SHIFT_BREAK_UPDATE_ACTION = 'LUNCH_BREAK_SHIFT_REPLACED';
const SHIFT_BREAK_UPDATE_IDEMPOTENCY_RESOURCE = 'LunchBreakShiftUpdateRequest';
const SHIFT_BREAK_UPDATE_ENTITLEMENT_CODE = 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED';
const SHIFT_BREAK_UPDATE_CONFLICT_CODE = 'SHIFT_BREAKS_CONFLICT';
const MAX_SETUP_SHIFT_ROWS = 200;
const SCHEDULABLE_SHIFT_USER_FILTER = {
    OR: [
        { userId: null },
        { user: { is: ACTIVE_SCHEDULABLE_USER_FILTER } },
    ],
} satisfies Prisma.ShiftWhereInput;
const DEFAULT_POLICY: LunchBreakPolicy = {
    break1OffsetMinutes: 120,
    lunchOffsetMinutes: 240,
    break2OffsetMinutes: 120,
    break1DurationMinutes: 10,
    lunchDurationMinutes: 30,
    break2DurationMinutes: 10,
    timeStepMinutes: 5,
};

@Injectable()
export class LunchBreaksService {
    private readonly tenantDb: TenantPrismaService;

    constructor(
        private readonly featureAccessService: FeatureAccessService,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
    }
    async getPolicy(tenantId: string): Promise<LunchBreakPolicy> {
        await this.featureAccessService.assertFeatureEntitled(tenantId, 'lunch_breaks');
        return this.fetchPolicy(tenantId);
    }
    async updatePolicy(tenantId: string, policy: Partial<LunchBreakPolicy>): Promise<LunchBreakPolicy> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, 'lunch_breaks');
            const mergedPolicy = this.normalizePolicy({ ...(await this.fetchPolicyForTenant(tx, tenantId)), ...policy });
            await tx.tenantSetting.upsert({
                where: {
                    tenantId_key: {
                        tenantId,
                        key: TENANT_POLICY_SETTINGS_KEY,
                    },
                },
                create: {
                    tenantId,
                    key: TENANT_POLICY_SETTINGS_KEY,
                    value: mergedPolicy as unknown as Prisma.InputJsonValue,
                },
                update: {
                    value: mergedPolicy as unknown as Prisma.InputJsonValue,
                },
            });
            return mergedPolicy;
        });
    }
    async listLunchBreaks(tenantId: string, filters: LunchBreakListFilters, actor: LunchBreakActor = {}): Promise<{ data: GeneratedShiftBreaks[]; pagination: BoundedPagination }> {
        await this.featureAccessService.assertFeatureEntitled(tenantId, 'lunch_breaks');
        const limit = parseBoundedListLimit(filters.limit);
        const window = {
            startDate: parseOptionalBoundedDate(filters.startDate, 'startDate'),
            endDate: parseOptionalBoundedDate(filters.endDate, 'endDate'),
        };
        assertBoundedListWindow(window);
        const cursor = decodeBoundedListCursor(filters.cursor);
        const where: Prisma.ShiftWhereInput = { tenantId, deletedAt: null };
        const and: Prisma.ShiftWhereInput[] = [SCHEDULABLE_SHIFT_USER_FILTER];
        if (this.isStaffActor(actor)) {
            where.userId = this.actorUserId(actor) ?? '__missing_actor__';
            and.push({ schedule: { is: { status: 'PUBLISHED' } } });
        }
        if (filters.scheduleId)
            where.scheduleId = filters.scheduleId;
        if (filters.locationId)
            where.locationId = filters.locationId;
        if (filters.shiftIds?.length)
            where.id = { in: filters.shiftIds };
        if (window.startDate)
            and.push({ endTime: { gt: window.startDate } });
        if (window.endDate)
            and.push({ startTime: { lt: window.endDate } });
        if (cursor) {
            and.push({
                OR: [
                    { startTime: { gt: cursor.timestamp } },
                    { startTime: cursor.timestamp, id: { gt: cursor.id } },
                ],
            });
        }
        where.AND = and;
        const shifts = await this.tenantDb.withTenant(tenantId, (tx) => tx.shift.findMany({
            where,
            orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
            take: limit + 1,
            include: {
                user: { select: { id: true, name: true, role: true } },
                breaks: { orderBy: { startTime: 'asc' } },
            },
        }));
        const page = buildBoundedListPage(shifts, limit, (shift) => shift.startTime, window);
        return {
            ...page,
            data: page.data.map((shift) => this.mapShiftToGenerated(shift)),
        };
    }
    private isStaffActor(actor: LunchBreakActor): boolean {
        return [actor?.legacyRole, actor?.role].some((role) => this.isRole(role, UserRole.STAFF));
    }
    private isRole(value: unknown, expected: UserRole): boolean {
        return typeof value === 'string'
            && value.trim().replace(/[\s-]+/g, '_').toUpperCase() === expected;
    }
    private actorUserId(actor: LunchBreakActor): string | undefined {
        return actor?.sub ?? actor?.id;
    }
    async updateShiftBreaks(
        tenantId: string,
        shiftId: string,
        input: UpdateShiftLunchBreaksRequest,
        idempotencyKey: string,
        actor: LunchBreakActor = {},
    ): Promise<GeneratedShiftBreaks> {
        const normalizedInput = this.normalizeShiftBreakUpdateInput(input);
        const operationId = shiftBreakUpdateOperationId(
            tenantId,
            shiftId,
            normalizeShiftBreakUpdateIdempotencyKey(idempotencyKey),
        );
        const requestHash = shiftBreakUpdateRequestHash(normalizedInput);
        const replay = await this.tenantDb.withTenant(tenantId, (tx) => this.findShiftBreakUpdateReplay(
            tx,
            tenantId,
            shiftId,
            operationId,
            requestHash,
        ));
        if (replay) return replay;

        try {
            return await this.tenantDb.withTenant(tenantId, async (tx) => {
                const lockedReplay = await this.findShiftBreakUpdateReplay(
                    tx,
                    tenantId,
                    shiftId,
                    operationId,
                    requestHash,
                );
                if (lockedReplay) return lockedReplay;
                await this.lockTenantSchedulingMutations(tx, tenantId);
                const serializedReplay = await this.findShiftBreakUpdateReplay(
                    tx,
                    tenantId,
                    shiftId,
                    operationId,
                    requestHash,
                );
                if (serializedReplay) return serializedReplay;

                const policy = await this.fetchPolicyForTenant(tx, tenantId);
                const shift = await tx.shift.findFirst({
                    where: {
                        id: shiftId,
                        tenantId,
                        locationId: normalizedInput.locationId,
                        deletedAt: null,
                        AND: [SCHEDULABLE_SHIFT_USER_FILTER],
                    },
                    include: {
                        user: { select: { id: true, name: true, role: true } },
                        schedule: { select: { id: true, status: true } },
                        breaks: { orderBy: { startTime: 'asc' } },
                    },
                });
                if (!shift) throw new NotFoundException('Shift not found for the selected location.');
                await this.lockScheduleRowsForMutation(tx, tenantId, [shift.schedule?.id]);
                this.assertDraftScheduleForBreakMutation(shift.schedule?.status);

                const payload = this.buildShiftBreakMutationPayload(shiftId, shift, normalizedInput, policy);
                this.assertBreakWindowsDoNotOverlap(payload);
                const currentResponse = this.mapShiftToGenerated(shift);
                if (this.shiftBreakPayloadMatches(currentResponse.breaks, payload)) {
                    return currentResponse;
                }

                const entitlement = await this.requireShiftBreakUpdateEntitlement(tx, tenantId);
                let creditConsumption: { consumedCredits: number; newBalance: number | null };
                try {
                    creditConsumption = await this.featureAccessService.recordFeatureUsageInTransaction(
                        tx,
                        tenantId,
                        entitlement,
                        `Lunch/break shift replacement (${operationId})`,
                        operationId,
                    );
                } catch (error) {
                    if (error instanceof ForbiddenException) throw this.shiftBreakUpdateEntitlementError();
                    throw error;
                }

                await tx.break.deleteMany({ where: { shiftId } });
                if (payload.length > 0) await tx.break.createMany({ data: payload });
                await this.incrementScheduleRevisions(tx, tenantId, [shift.schedule?.id]);
                const updated = await tx.shift.findFirst({
                    where: {
                        id: shiftId,
                        tenantId,
                        locationId: normalizedInput.locationId,
                        deletedAt: null,
                        AND: [SCHEDULABLE_SHIFT_USER_FILTER],
                    },
                    include: {
                        user: { select: { id: true, name: true, role: true } },
                        breaks: { orderBy: { startTime: 'asc' } },
                    },
                });
                if (!updated) throw this.shiftBreakUpdateConflict('Shift changed while lunch/breaks were being saved. Refresh and retry.');
                const response = this.mapShiftToGenerated(updated);
                await this.createShiftBreakUpdateAudit(tx, {
                    tenantId,
                    actorUserId: this.actorUserId(actor) ?? null,
                    shiftId,
                    operationId,
                    requestHash,
                    changed: true,
                    creditConsumption,
                    response,
                });
                return response;
            });
        } catch (error) {
            return this.replayShiftBreakUpdateAfterFailure(
                tenantId,
                shiftId,
                operationId,
                requestHash,
                this.toPublicShiftBreakUpdateError(mapShiftUpdateInvariantError(error)),
            );
        }
    }
    private normalizeShiftBreakUpdateInput(input: UpdateShiftLunchBreaksRequest): ShiftBreakUpdateIdentity {
        const locationId = typeof input?.locationId === 'string' ? input.locationId.trim() : '';
        if (!locationId) {
            throw new BadRequestException('locationId is required when editing shift lunch/breaks.');
        }
        if (input.breaks !== undefined && !Array.isArray(input.breaks)) {
            throw new BadRequestException('breaks must be an array.');
        }
        const byType = new Map<BreakType, ShiftBreakUpdateIdentity['breaks'][number]>();
        for (const item of input.breaks ?? []) {
            if (!item || typeof item !== 'object' || !this.isBreakType(item.type)) {
                throw new BadRequestException('Each break edit requires a valid type.');
            }
            if (byType.has(item.type)) {
                throw new BadRequestException('Each break type can only be edited once.');
            }
            if (item.skip === true) {
                byType.set(item.type, { type: item.type, skip: true });
                continue;
            }
            if (!item.startTime) {
                throw new BadRequestException(`${item.type} startTime is required when not skipped.`);
            }
            const startTime = this.toDateOrThrow(item.startTime, `Invalid ${item.type} startTime.`).toISOString();
            if (item.durationMinutes !== undefined
                && (typeof item.durationMinutes !== 'number' || !Number.isFinite(item.durationMinutes))) {
                throw new BadRequestException(`${item.type} durationMinutes must be a finite number.`);
            }
            byType.set(item.type, {
                type: item.type,
                startTime,
                ...(item.durationMinutes === undefined ? {} : { durationMinutes: Math.round(item.durationMinutes) }),
                skip: false,
            });
        }
        return {
            locationId,
            breaks: BREAK_TYPES.map((type) => byType.get(type) ?? { type, skip: true }),
        };
    }
    private buildShiftBreakMutationPayload(
        shiftId: string,
        shift: { startTime: Date; endTime: Date },
        input: ShiftBreakUpdateIdentity,
        policy: LunchBreakPolicy,
    ): ShiftBreakMutation[] {
        const shiftStart = shift.startTime.getTime();
        const shiftEnd = shift.endTime.getTime();
        const payload: ShiftBreakMutation[] = [];
        for (const candidate of input.breaks) {
            if (candidate.skip) continue;
            const type = candidate.type;
            const start = this.toDateOrThrow(candidate.startTime, `Invalid ${type} startTime.`);
            const duration = type === 'lunch'
                ? this.clampInt(candidate.durationMinutes, policy.lunchDurationMinutes, 15, 120)
                : this.clampInt(
                    candidate.durationMinutes,
                    type === 'break1' ? policy.break1DurationMinutes : policy.break2DurationMinutes,
                    5,
                    60,
                );
            const endMs = start.getTime() + duration * 60000;
            if (start.getTime() < shiftStart || endMs > shiftEnd) {
                throw new BadRequestException(`${type} must be within the shift window.`);
            }
            payload.push({
                shiftId,
                type: DB_BREAK_TYPE_BY_API_TYPE[type],
                startTime: start,
                endTime: new Date(endMs),
                paid: type !== 'lunch',
            });
        }
        return payload;
    }
    private shiftBreakPayloadMatches(current: GeneratedBreak[], desired: ShiftBreakMutation[]): boolean {
        const currentSemantics = current
            .map((entry) => ({
                type: entry.type,
                startTime: entry.startTime,
                endTime: entry.endTime,
                paid: entry.paid,
            }))
            .sort((left, right) => left.type.localeCompare(right.type));
        const desiredSemantics = desired
            .map((entry) => ({
                type: API_BREAK_TYPE_BY_DB_TYPE[entry.type]!,
                startTime: entry.startTime.toISOString(),
                endTime: entry.endTime.toISOString(),
                paid: entry.paid,
            }))
            .sort((left, right) => left.type.localeCompare(right.type));
        return JSON.stringify(currentSemantics) === JSON.stringify(desiredSemantics);
    }
    private async findShiftBreakUpdateReplay(
        tx: TenantPrismaTransaction,
        tenantId: string,
        shiftId: string,
        operationId: string,
        requestHash: string,
    ): Promise<GeneratedShiftBreaks | null> {
        const stored = await tx.auditLog.findFirst({
            where: {
                tenantId,
                action: SHIFT_BREAK_UPDATE_ACTION,
                resource: SHIFT_BREAK_UPDATE_IDEMPOTENCY_RESOURCE,
                resourceId: operationId,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { newValue: true },
        });
        if (!stored) return null;
        if (!this.isRecord(stored.newValue) || typeof stored.newValue.requestHash !== 'string') {
            throw this.shiftBreakUpdateConflict('The stored shift lunch/break outcome is unavailable. Use a new Idempotency-Key.');
        }
        if (stored.newValue.requestHash !== requestHash) {
            throw this.shiftBreakUpdateConflict('Idempotency-Key was already used with a different shift lunch/break request.');
        }
        const response = stored.newValue.response;
        if (!this.isGeneratedShiftBreaksResponse(response) || response.shiftId !== shiftId) {
            throw this.shiftBreakUpdateConflict('The stored shift lunch/break outcome is unavailable. Use a new Idempotency-Key.');
        }
        return response;
    }
    private async requireShiftBreakUpdateEntitlement(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ): Promise<FeatureResolution> {
        let entitlement: FeatureResolution;
        try {
            entitlement = await this.featureAccessService.assertFeatureEnabledInTransaction(tx, tenantId, 'lunch_breaks');
        } catch (error) {
            if (error instanceof ForbiddenException) throw this.shiftBreakUpdateEntitlementError();
            throw error;
        }
        if (!entitlement.enabled
            || entitlement.source !== 'credits'
            || typeof entitlement.creditCost !== 'number'
            || !Number.isSafeInteger(entitlement.creditCost)
            || entitlement.creditCost <= 0) {
            throw this.shiftBreakUpdateEntitlementError();
        }
        return entitlement;
    }
    private shiftBreakUpdateEntitlementError(): ForbiddenException {
        return new ForbiddenException({
            code: SHIFT_BREAK_UPDATE_ENTITLEMENT_CODE,
            message: 'Manual lunch/break replacement requires an active paid subscription and enough separately purchased usage credits.',
        });
    }
    private shiftBreakUpdateConflict(message: string): ConflictException {
        return new ConflictException({ code: SHIFT_BREAK_UPDATE_CONFLICT_CODE, message });
    }
    private toPublicShiftBreakUpdateError(error: unknown): unknown {
        if (!(error instanceof ConflictException)) return error;
        const response = error.getResponse();
        if (this.isRecord(response) && response.code === SHIFT_BREAK_UPDATE_CONFLICT_CODE) return error;
        const message = typeof response === 'string'
            ? response
            : this.isRecord(response) && typeof response.message === 'string'
                ? response.message
                : 'Shift lunch/breaks conflict with current schedule data. Refresh and retry.';
        return this.shiftBreakUpdateConflict(message);
    }
    private async createShiftBreakUpdateAudit(
        tx: TenantPrismaTransaction,
        args: {
            tenantId: string;
            actorUserId: string | null;
            shiftId: string;
            operationId: string;
            requestHash: string;
            changed: boolean;
            creditConsumption: { consumedCredits: number; newBalance: number | null } | null;
            response: GeneratedShiftBreaks;
        },
    ): Promise<void> {
        await tx.auditLog.create({
            data: {
                tenantId: args.tenantId,
                userId: args.actorUserId,
                actorUserId: args.actorUserId,
                actorTenantId: args.tenantId,
                action: SHIFT_BREAK_UPDATE_ACTION,
                resource: SHIFT_BREAK_UPDATE_IDEMPOTENCY_RESOURCE,
                resourceId: args.operationId,
                newValue: {
                    shiftId: args.shiftId,
                    requestHash: args.requestHash,
                    changed: args.changed,
                    creditConsumption: args.creditConsumption,
                    response: args.response,
                } as unknown as Prisma.InputJsonValue,
            },
        });
    }
    private async replayShiftBreakUpdateAfterFailure(
        tenantId: string,
        shiftId: string,
        operationId: string,
        requestHash: string,
        error: unknown,
    ): Promise<GeneratedShiftBreaks> {
        const replay = await this.tenantDb.withTenant(tenantId, (tx) => this.findShiftBreakUpdateReplay(
            tx,
            tenantId,
            shiftId,
            operationId,
            requestHash,
        ));
        if (replay) return replay;
        throw error;
    }
    private isGeneratedShiftBreaksResponse(value: unknown): value is GeneratedShiftBreaks {
        if (!this.isRecord(value)
            || (value.shiftId !== null && typeof value.shiftId !== 'string')
            || (value.userId !== null && typeof value.userId !== 'string')
            || (value.employeeName !== null && typeof value.employeeName !== 'string')
            || typeof value.startTime !== 'string'
            || typeof value.endTime !== 'string'
            || !Array.isArray(value.breaks)) {
            return false;
        }
        return value.breaks.every((entry) => this.isRecord(entry)
            && this.isBreakType(entry.type)
            && typeof entry.startTime === 'string'
            && typeof entry.endTime === 'string'
            && typeof entry.durationMinutes === 'number'
            && typeof entry.paid === 'boolean');
    }
    async persistSetupShifts(
        tenantId: string,
        input: PersistSetupShiftsRequest,
        idempotencyKey: string,
        actor: LunchBreakActor = {},
    ): Promise<SetupShiftsResponse> {
        const normalizedInput = this.normalizeSetupShiftsInput(input);
        const operationId = setupShiftsOperationId(
            tenantId,
            normalizeSetupShiftsIdempotencyKey(idempotencyKey),
        );
        const requestHash = setupShiftsRequestHash(normalizedInput);
        const semanticOperationId = setupShiftsNeedsSemanticReplay(normalizedInput)
            ? setupShiftsSemanticOperationId(tenantId, requestHash)
            : null;
        const replay = await this.tenantDb.withTenant(tenantId, (tx) => this.findSetupShiftsReplay(
            tx,
            tenantId,
            operationId,
            requestHash,
        ));
        if (replay) return replay;

        try {
            return await this.tenantDb.withTenant(tenantId, async (tx) => {
                const lockedReplay = await this.findSetupShiftsReplay(tx, tenantId, operationId, requestHash);
                if (lockedReplay) return lockedReplay;
                await this.lockTenantSchedulingMutations(tx, tenantId);
                const serializedReplay = await this.findSetupShiftsReplay(tx, tenantId, operationId, requestHash);
                if (serializedReplay) return serializedReplay;
                if (semanticOperationId) {
                    const semanticReplay = await this.findSetupShiftsReplay(
                        tx,
                        tenantId,
                        semanticOperationId,
                        requestHash,
                        SETUP_SHIFTS_SEMANTIC_RESOURCE,
                    );
                    if (semanticReplay) return semanticReplay;
                }
                const location = await tx.location.findFirst({
                    where: { id: normalizedInput.locationId, tenantId, deletedAt: null },
                    select: { id: true },
                });
                if (!location) {
                    throw new BadRequestException('The selected location was not found for this workspace.');
                }
                const explicitShiftIds = normalizedInput.rows
                    .map((row) => row.shiftId)
                    .filter((id): id is string => Boolean(id));
                const existingShifts = explicitShiftIds.length > 0
                    ? await tx.shift.findMany({
                        where: { tenantId, deletedAt: null, id: { in: explicitShiftIds }, AND: [SCHEDULABLE_SHIFT_USER_FILTER] },
                        select: {
                            id: true,
                            locationId: true,
                            scheduleId: true,
                            userId: true,
                            startTime: true,
                            endTime: true,
                            schedule: { select: { status: true, startDate: true, endDate: true } },
                        },
                    })
                    : [];
                const existingById = new Map(existingShifts.map((shift) => [shift.id, shift]));
                if (existingById.size !== explicitShiftIds.length) {
                    throw new BadRequestException('One or more setup shifts were not found for this tenant.');
                }
                if (existingShifts.some((shift) => shift.locationId !== normalizedInput.locationId)) {
                    throw new BadRequestException('Setup shifts must belong to the selected location.');
                }
                await this.lockScheduleRowsForMutation(tx, tenantId, existingShifts.map((shift) => shift.scheduleId));
                if (existingShifts.some((shift) => this.isPublishedSchedule(shift.schedule?.status))) {
                    throw new BadRequestException('Published schedules are locked. Create a new draft before changing lunch/break setup shifts.');
                }
                const userIds = Array.from(new Set(normalizedInput.rows
                    .map((row) => row.userId)
                    .filter((id): id is string => Boolean(id))));
                for (const userId of userIds) {
                    await this.assertSchedulableUser(tx, tenantId, userId);
                }

                const plans: SetupShiftMutationPlan[] = [];
                for (const row of normalizedInput.rows) {
                    const existing = row.shiftId ? existingById.get(row.shiftId) ?? null : null;
                    const nextStartTime = new Date(row.startTime);
                    const nextEndTime = new Date(row.endTime);
                    const nextUserId = row.userId === undefined ? existing?.userId ?? null : row.userId;
                    assertShiftUpdateWindow(nextStartTime, nextEndTime);
                    if (existing?.schedule) {
                        assertShiftUpdateWithinSchedule(nextStartTime, nextEndTime, existing.schedule);
                    }
                    const timeChanged = Boolean(existing)
                        && (existing!.startTime.getTime() !== nextStartTime.getTime()
                            || existing!.endTime.getTime() !== nextEndTime.getTime());
                    const translatedBreaks = existing && timeChanged
                        ? await this.lockAndPlanSetupShiftBreakTranslation(
                            tx,
                            existing.id,
                            existing.startTime,
                            nextStartTime,
                            nextEndTime,
                        )
                        : [];
                    plans.push({
                        row,
                        existing,
                        nextStartTime,
                        nextEndTime,
                        nextUserId,
                        valueChanged: !existing
                            || timeChanged
                            || existing.userId !== nextUserId,
                        translatedBreaks,
                    });
                }

                await this.assertSetupShiftOverlapInvariants(tx, tenantId, plans, explicitShiftIds);
                const changedPlans = plans.filter((plan) => plan.valueChanged);
                if (changedPlans.length > 0) {
                    const entitlement = await this.requireSetupShiftsEntitlement(tx, tenantId);
                    try {
                        await this.featureAccessService.recordFeatureUsageInTransaction(
                            tx,
                            tenantId,
                            entitlement,
                            `Lunch/break setup shift persistence (${operationId})`,
                            operationId,
                        );
                    } catch (error) {
                        if (error instanceof ForbiddenException) throw this.setupShiftsEntitlementError();
                        throw error;
                    }
                }

                const ids: string[] = [];
                for (const plan of plans) {
                    const { row } = plan;
                    if (row.shiftId) {
                        ids.push(row.shiftId);
                        if (!plan.valueChanged) continue;
                        const updated = await tx.shift.updateMany({
                            where: {
                                id: row.shiftId,
                                tenantId,
                                locationId: normalizedInput.locationId,
                                scheduleId: plan.existing!.scheduleId,
                                userId: plan.existing!.userId,
                                startTime: plan.existing!.startTime,
                                endTime: plan.existing!.endTime,
                                deletedAt: null,
                            },
                            data: {
                                startTime: plan.nextStartTime,
                                endTime: plan.nextEndTime,
                                userId: plan.nextUserId,
                            },
                        });
                        if (updated.count === 0) {
                            throw this.setupShiftsConflict('A setup shift changed while it was being saved. Refresh and retry.');
                        }
                        for (const shiftBreak of plan.translatedBreaks) {
                            const breakUpdate = await tx.break.updateMany({
                                where: { id: shiftBreak.id, shiftId: row.shiftId },
                                data: { startTime: shiftBreak.startTime, endTime: shiftBreak.endTime },
                            });
                            if (breakUpdate.count !== 1) {
                                throw this.setupShiftsConflict('A dependent lunch/break changed while setup shifts were being saved. Refresh and retry.');
                            }
                        }
                        continue;
                    }
                    const created = await tx.shift.create({
                        data: {
                            tenantId,
                            locationId: normalizedInput.locationId,
                            userId: plan.nextUserId,
                            startTime: plan.nextStartTime,
                            endTime: plan.nextEndTime,
                            role: null,
                        },
                        select: { id: true },
                    });
                    ids.push(created.id);
                }
                await this.incrementScheduleRevisions(
                    tx,
                    tenantId,
                    changedPlans.map((plan) => plan.existing?.scheduleId),
                );
                const response = { shiftIds: ids };
                await this.createSetupShiftsAudit(tx, {
                    tenantId,
                    actorUserId: this.actorUserId(actor) ?? null,
                    operationId,
                    semanticOperationId,
                    requestHash,
                    response,
                });
                return response;
            });
        } catch (error) {
            return this.replaySetupShiftsAfterFailure(
                tenantId,
                operationId,
                requestHash,
                this.toPublicSetupShiftsError(mapShiftUpdateInvariantError(error)),
            );
        }
    }
    private normalizeSetupShiftsInput(input: PersistSetupShiftsRequest): SetupShiftsIdentity {
        const locationId = typeof input?.locationId === 'string' ? input.locationId.trim() : '';
        if (!locationId) {
            throw new BadRequestException('A location is required for setup shifts.');
        }
        const rows = Array.isArray(input?.rows) ? input.rows : [];
        if (rows.length === 0) {
            throw new BadRequestException('At least one setup shift row is required.');
        }
        if (rows.length > MAX_SETUP_SHIFT_ROWS) {
            throw new BadRequestException(`Setup shift persistence accepts at most ${MAX_SETUP_SHIFT_ROWS} rows.`);
        }
        const seenShiftIds = new Set<string>();
        const normalizedRows = rows.map((row, index): SetupShiftIdentity => {
            if (!row || typeof row !== 'object' || Array.isArray(row)) {
                throw new BadRequestException(`Setup shift row ${index + 1} must be an object.`);
            }
            const startTime = this.toDateOrThrow(row.startTime, 'Invalid setup shift startTime.');
            const endTime = this.toDateOrThrow(row.endTime, 'Invalid setup shift endTime.');
            assertShiftUpdateWindow(startTime, endTime);
            const normalized: SetupShiftIdentity = {
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
            };
            if (row.shiftId !== undefined && row.shiftId !== null && row.shiftId !== '') {
                if (typeof row.shiftId !== 'string' || !row.shiftId.trim()) {
                    throw new BadRequestException('Setup shift shiftId must be a non-empty string when provided.');
                }
                normalized.shiftId = row.shiftId.trim();
                if (seenShiftIds.has(normalized.shiftId)) {
                    throw new BadRequestException('Each existing shift can appear only once in setup shift persistence.');
                }
                seenShiftIds.add(normalized.shiftId);
            }
            if (Object.prototype.hasOwnProperty.call(row, 'userId')) {
                if (row.userId === undefined || row.userId === null || row.userId === '') {
                    normalized.userId = null;
                } else if (typeof row.userId === 'string' && row.userId.trim()) {
                    normalized.userId = row.userId.trim();
                } else {
                    throw new BadRequestException('Setup shift userId must be a non-empty string or null.');
                }
            }
            return normalized;
        });
        return { locationId, rows: normalizedRows };
    }
    private async findSetupShiftsReplay(
        tx: TenantPrismaTransaction,
        tenantId: string,
        operationId: string,
        requestHash: string,
        resource: string = SETUP_SHIFTS_IDEMPOTENCY_RESOURCE,
    ): Promise<SetupShiftsResponse | null> {
        const stored = await tx.auditLog.findFirst({
            where: {
                tenantId,
                action: SETUP_SHIFTS_ACTION,
                resource,
                resourceId: operationId,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { newValue: true },
        });
        if (!stored) return null;
        if (!this.isRecord(stored.newValue) || typeof stored.newValue.requestHash !== 'string') {
            throw this.setupShiftsConflict('The stored setup shift outcome is unavailable. Use a new Idempotency-Key.');
        }
        if (stored.newValue.requestHash !== requestHash) {
            throw this.setupShiftsConflict('Idempotency-Key was already used with a different setup shift request.');
        }
        const response = stored.newValue.response;
        if (!this.isRecord(response)
            || !Array.isArray(response.shiftIds)
            || response.shiftIds.some((id) => typeof id !== 'string')) {
            throw this.setupShiftsConflict('The stored setup shift outcome is unavailable. Use a new Idempotency-Key.');
        }
        return { shiftIds: response.shiftIds as string[] };
    }
    private async requireSetupShiftsEntitlement(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ): Promise<FeatureResolution> {
        let entitlement: FeatureResolution;
        try {
            entitlement = await this.featureAccessService.assertFeatureEnabledInTransaction(tx, tenantId, 'scheduling');
        } catch (error) {
            if (error instanceof ForbiddenException) throw this.setupShiftsEntitlementError();
            throw error;
        }
        if (!entitlement.enabled
            || entitlement.source !== 'credits'
            || typeof entitlement.creditCost !== 'number'
            || !Number.isSafeInteger(entitlement.creditCost)
            || entitlement.creditCost <= 0) {
            throw this.setupShiftsEntitlementError();
        }
        return entitlement;
    }
    private async lockAndPlanSetupShiftBreakTranslation(
        tx: TenantPrismaTransaction,
        shiftId: string,
        previousStartTime: Date,
        nextStartTime: Date,
        nextEndTime: Date,
    ): Promise<ShiftBreakWindow[]> {
        const rows = await tx.$queryRaw<ShiftBreakWindow[]>`
            SELECT "id", "startTime", "endTime"
            FROM "Break"
            WHERE "shiftId" = ${shiftId}
            ORDER BY "startTime", "id"
            FOR UPDATE
        `;
        return translateShiftBreakWindows(rows, previousStartTime, nextStartTime, nextEndTime);
    }
    private async assertSetupShiftOverlapInvariants(
        tx: TenantPrismaTransaction,
        tenantId: string,
        plans: SetupShiftMutationPlan[],
        explicitShiftIds: string[],
    ): Promise<void> {
        const byUser = new Map<string, SetupShiftMutationPlan[]>();
        for (const plan of plans) {
            if (!plan.nextUserId) continue;
            const priorPlans = byUser.get(plan.nextUserId) ?? [];
            if (priorPlans.some((prior) => (
                plan.nextStartTime < prior.nextEndTime && plan.nextEndTime > prior.nextStartTime
            ))) {
                throw this.setupShiftsConflict('Setup shifts cannot overlap for the same assigned user.');
            }
            priorPlans.push(plan);
            byUser.set(plan.nextUserId, priorPlans);
        }

        for (const plan of plans) {
            if (!plan.nextUserId) continue;
            const overlapCount = await tx.shift.count({
                where: {
                    tenantId,
                    userId: plan.nextUserId,
                    deletedAt: null,
                    startTime: { lt: plan.nextEndTime },
                    endTime: { gt: plan.nextStartTime },
                    ...(explicitShiftIds.length > 0 ? { id: { notIn: explicitShiftIds } } : {}),
                },
            });
            if (overlapCount > 0) {
                throw this.setupShiftsConflict('User already has a shift that overlaps this setup window.');
            }
        }
    }
    private setupShiftsEntitlementError(): ForbiddenException {
        return new ForbiddenException({
            code: SETUP_SHIFTS_ENTITLEMENT_CODE,
            message: 'Setup shifts require an active paid subscription and enough separately purchased usage credits.',
        });
    }
    private setupShiftsConflict(message: string): ConflictException {
        return new ConflictException({ code: SETUP_SHIFTS_CONFLICT_CODE, message });
    }
    private toPublicSetupShiftsError(error: unknown): unknown {
        if (!(error instanceof ConflictException)) return error;
        const response = error.getResponse();
        if (this.isRecord(response) && response.code === SETUP_SHIFTS_CONFLICT_CODE) return error;
        const message = typeof response === 'string'
            ? response
            : this.isRecord(response) && typeof response.message === 'string'
                ? response.message
                : 'Setup shifts conflict with current schedule data. Refresh and retry.';
        return this.setupShiftsConflict(message);
    }
    private async createSetupShiftsAudit(
        tx: TenantPrismaTransaction,
        args: {
            tenantId: string;
            actorUserId: string | null;
            operationId: string;
            semanticOperationId: string | null;
            requestHash: string;
            response: SetupShiftsResponse;
        },
    ): Promise<void> {
        await tx.auditLog.create({
            data: {
                tenantId: args.tenantId,
                userId: args.actorUserId,
                actorUserId: args.actorUserId,
                actorTenantId: args.tenantId,
                action: SETUP_SHIFTS_ACTION,
                resource: SETUP_SHIFTS_IDEMPOTENCY_RESOURCE,
                resourceId: args.operationId,
                newValue: {
                    requestHash: args.requestHash,
                    response: args.response,
                },
            },
        });
        if (args.semanticOperationId) {
            await tx.auditLog.create({
                data: {
                    tenantId: args.tenantId,
                    userId: args.actorUserId,
                    actorUserId: args.actorUserId,
                    actorTenantId: args.tenantId,
                    action: SETUP_SHIFTS_ACTION,
                    resource: SETUP_SHIFTS_SEMANTIC_RESOURCE,
                    resourceId: args.semanticOperationId,
                    newValue: {
                        requestHash: args.requestHash,
                        response: args.response,
                    },
                },
            });
        }
    }
    private async replaySetupShiftsAfterFailure(
        tenantId: string,
        operationId: string,
        requestHash: string,
        error: unknown,
    ): Promise<SetupShiftsResponse> {
        const replay = await this.tenantDb.withTenant(tenantId, (tx) => this.findSetupShiftsReplay(
            tx,
            tenantId,
            operationId,
            requestHash,
        ));
        if (replay) return replay;
        throw error;
    }
    async generateLunchBreaks(tenantId: string, input: GenerateLunchBreaksRequest, idempotencyKey: string): Promise<GenerationResponse> {
        const persistedLocationId = input.persist ? input.locationId?.trim() : undefined;
        if (input.persist && !persistedLocationId) {
            throw new BadRequestException('locationId is required when persisting generated lunch/breaks.');
        }
        const generationInputRequest = persistedLocationId
            ? { ...input, locationId: persistedLocationId }
            : input;
        if (persistedLocationId) {
            await this.assertPersistedGenerationLocationBoundary(tenantId, persistedLocationId, generationInputRequest.shiftIds);
        }
        const requestKeyHash = hashLunchBreakGenerationIdempotencyKey(normalizeLunchBreakGenerationIdempotencyKey(idempotencyKey));
        const requestHash = lunchBreakGenerationRequestHash(generationInputRequest);
        const claimResult = await this.claimGenerationRequest(tenantId, requestKeyHash, requestHash);
        if ('reusedResponse' in claimResult)
            return claimResult.reusedResponse;
        const claim = claimResult;
        try {
            const explicitShifts = this.normalizeExplicitShifts(input.shifts ?? []);
            const { policy, dbShifts } = await this.tenantDb.withTenant(tenantId, async (tx) => {
                if (persistedLocationId) {
                    const location = await tx.location.findFirst({
                        where: { id: persistedLocationId, tenantId, deletedAt: null },
                        select: { id: true },
                    });
                    if (!location) {
                        throw new BadRequestException('locationId must identify an active location in this tenant.');
                    }
                }
                const sharedShifts = explicitShifts.length === 0
                    ? await this.findSharedShifts(tx, tenantId, generationInputRequest)
                    : [];
                if (persistedLocationId && generationInputRequest.shiftIds?.length) {
                    const requestedShiftIds = new Set(generationInputRequest.shiftIds);
                    const locatedShiftIds = new Set(sharedShifts.map((shift) => shift.id));
                    if (requestedShiftIds.size !== locatedShiftIds.size
                        || [...requestedShiftIds].some((shiftId) => !locatedShiftIds.has(shiftId))) {
                        throw new BadRequestException('Every selected shift must belong to the requested location.');
                    }
                }
                return {
                    policy: this.normalizePolicy({
                        ...(await this.fetchPolicyForTenant(tx, tenantId)),
                        ...(input.policy ?? {}),
                    }),
                    dbShifts: sharedShifts,
                };
            });
            const source = dbShifts.length > 0 ? 'shared_schedule' : 'standalone';
            const generationInput = dbShifts.length > 0
                ? dbShifts.map((shift) => ({
                    id: shift.id,
                    userId: shift.userId,
                    employeeName: shift.user?.name ?? null,
                    startTime: shift.startTime.toISOString(),
                    endTime: shift.endTime.toISOString(),
                    lunchDurationMinutes: policy.lunchDurationMinutes,
                }))
                : explicitShifts;
            const calculationSnapshot = this.buildShiftCalculationSnapshot(dbShifts);
            const data = this.buildBreakSchedule(generationInput, policy);
            if (data.length === 0) {
                throw new BadRequestException('Add at least one valid shift before generating lunch/breaks.');
            }
            this.assertGeneratedBreakSchedule(data);
            const shouldPersist = Boolean(input.persist) && source === 'shared_schedule';
            if (Boolean(input.persist) && source !== 'shared_schedule') {
                throw new BadRequestException('Persisting lunch/breaks requires existing shift records from shared scheduling data.');
            }
            if (shouldPersist) {
                await this.preflightGeneratedBreakPersistence(tenantId, data, calculationSnapshot);
            }
            return await this.completeGenerationRequest(tenantId, claim, {
                source,
                persisted: shouldPersist,
                policy,
                data,
                generated: shouldPersist ? data : undefined,
                calculationSnapshot,
            });
        }
        catch (error) {
            try {
                const committed = await this.findGenerationRequest(tenantId, requestKeyHash);
                if (committed?.status === 'SUCCEEDED' && committed.response) {
                    return this.reuseGenerationRequest(committed, requestHash);
                }
                await this.failGenerationRequest(tenantId, claim, error);
            }
            catch {
                // A lost commit acknowledgement remains safely reusable by the same idempotency key.
            }
            throw error;
        }
    }
    private async claimGenerationRequest(tenantId: string, requestKeyHash: string, requestHash: string): Promise<GenerationClaimResult> {
        const requestId = randomUUID();
        const claimToken = randomUUID();
        const now = new Date();
        const claimExpiresAt = new Date(now.getTime() + GENERATION_CLAIM_MS);
        const request = await this.tenantDb.withTenant(tenantId, async (tx) => {
            const row = await tx.lunchBreakGenerationRequest.upsert({
                where: { tenantId_requestKeyHash: { tenantId, requestKeyHash } },
                create: {
                    id: requestId,
                    tenantId,
                    requestKeyHash,
                    requestHash,
                    status: 'PENDING',
                    claimToken,
                    claimExpiresAt,
                    attempts: 1,
                },
                update: {},
            });
            if (row.id === requestId || row.requestHash !== requestHash || row.status === 'SUCCEEDED') {
                return row;
            }
            const retryableFailure = row.status === 'FAILED' && this.isRecoverableGenerationFailure(row.failureStatus);
            if (row.status === 'FAILED' && !retryableFailure) return row;
            const reclaimed = await tx.lunchBreakGenerationRequest.updateMany({
                where: {
                    id: row.id,
                    tenantId,
                    requestHash,
                    status: row.status,
                    ...(row.status === 'PENDING' ? {
                        OR: [
                            { claimExpiresAt: null },
                            { claimExpiresAt: { lte: now } },
                        ],
                    } : {
                        failureStatus: row.failureStatus,
                    }),
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
                return await tx.lunchBreakGenerationRequest.findUnique({
                    where: { tenantId_requestKeyHash: { tenantId, requestKeyHash } },
                }) ?? row;
            }
            return { ...row, status: 'PENDING', claimToken, claimExpiresAt };
        });
        if (request.requestHash !== requestHash || request.status === 'SUCCEEDED' || request.status === 'FAILED') {
            return { reusedResponse: this.reuseGenerationRequest(request, requestHash) };
        }
        if (request.claimToken !== claimToken) {
            throw new ConflictException('Lunch/break generation for this Idempotency-Key is already in progress.');
        }
        return { requestId: request.id, claimToken };
    }
    private async findGenerationRequest(tenantId: string, requestKeyHash: string): Promise<GenerationRequestRecord | null> {
        return this.tenantDb.withTenant(tenantId, (tx) => tx.lunchBreakGenerationRequest.findUnique({
            where: { tenantId_requestKeyHash: { tenantId, requestKeyHash } },
        }));
    }
    private reuseGenerationRequest(request: GenerationRequestRecord, requestHash: string): GenerationResponse {
        if (request.requestHash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used with a different lunch/break generation request.');
        }
        if (request.status === 'SUCCEEDED' && request.response) {
            if (typeof request.response !== 'object' || Array.isArray(request.response)) {
                throw new ConflictException('Stored lunch/break generation response is invalid.');
            }
            return {
                ...request.response,
                reused: true,
            } as unknown as GenerationResponse;
        }
        if (request.status === 'FAILED') {
            throw new HttpException(request.failureMessage || 'Lunch/break generation failed.', request.failureStatus || HttpStatus.INTERNAL_SERVER_ERROR);
        }
        throw new ConflictException('Lunch/break generation for this Idempotency-Key is already in progress.');
    }
    private async completeGenerationRequest(tenantId: string, claim: GenerationClaim, prepared: GenerationPrepared): Promise<GenerationResponse> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const claimed = await tx.lunchBreakGenerationRequest.updateMany({
                where: {
                    id: claim.requestId,
                    tenantId,
                    status: 'PENDING',
                    claimToken: claim.claimToken,
                },
                data: { claimExpiresAt: new Date(Date.now() + GENERATION_CLAIM_MS) },
            });
            if (claimed.count !== 1) {
                throw new ConflictException('Lunch/break generation claim expired before it could commit. Retry the request.');
            }
            const entitlement = await this.featureAccessService.assertFeatureEnabledInTransaction(
                tx,
                tenantId,
                'lunch_breaks',
            );
            this.requirePositiveGenerationCredit(entitlement);
            if (prepared.generated) {
                await this.assertGeneratedShiftIdsPersistable(tx, tenantId, this.getGeneratedShiftIdsOrThrow(prepared.generated), prepared.calculationSnapshot);
            }
            const creditConsumption = await this.reserveGenerationCredit(tx, {
                tenantId,
                requestId: claim.requestId,
                entitlement,
            });
            const response = {
                source: prepared.source,
                persisted: prepared.persisted,
                policy: prepared.policy,
                creditConsumption,
                data: prepared.data,
                reused: false,
            };
            if (prepared.generated) {
                await this.persistGeneratedBreaks(tx, tenantId, prepared.generated, prepared.calculationSnapshot);
            }
            await tx.lunchBreakGenerationRequest.update({
                where: { id: claim.requestId },
                data: {
                    status: 'SUCCEEDED',
                    response: response as unknown as Prisma.InputJsonValue,
                    creditConsumption: creditConsumption,
                    creditTransactionId: this.generationCreditTransactionId(claim.requestId),
                    calculationSnapshot: prepared.calculationSnapshot,
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
    private async reserveGenerationCredit(tx: TenantPrismaTransaction, args: CreditReservationArgs): Promise<CreditConsumption> {
        const transactionId = this.generationCreditTransactionId(args.requestId);
        const settlement = await this.featureAccessService.recordFeatureUsageInTransaction(
            tx,
            args.tenantId,
            args.entitlement,
            `Lunch/Break generation (${args.requestId})`,
            args.requestId,
            transactionId,
        );
        const newBalance = Number(settlement.newBalance);
        if (!Number.isSafeInteger(newBalance) || newBalance < 0) {
            throw new ConflictException('Lunch/break generation credit settlement is invalid.');
        }
        return {
            consumedCredits: settlement.consumedCredits,
            newBalance,
            source: 'credits',
        };
    }
    private requirePositiveGenerationCredit(entitlement: FeatureResolution): number {
        const creditCost = entitlement.creditCost;
        if (entitlement.source !== 'credits'
            || typeof creditCost !== 'number'
            || !Number.isSafeInteger(creditCost)
            || creditCost <= 0) {
            throw new ForbiddenException('Lunch/break generation requires an active paid subscription and separately purchased usage credits.');
        }
        return creditCost;
    }
    private generationCreditTransactionId(requestId: string): string {
        return `lunch-break-credit-${requestId}`;
    }
    private async failGenerationRequest(tenantId: string, claim: GenerationClaim, error: unknown): Promise<void> {
        const failureStatus = error instanceof HttpException
            ? error.getStatus()
            : HttpStatus.SERVICE_UNAVAILABLE;
        await this.tenantDb.withTenant(tenantId, (tx) => tx.lunchBreakGenerationRequest.updateMany({
            where: { id: claim.requestId, tenantId, status: 'PENDING', claimToken: claim.claimToken },
            data: {
                status: 'FAILED',
                failureStatus,
                failureMessage: this.generationFailureMessage(error),
                completedAt: new Date(),
                claimToken: null,
                claimExpiresAt: null,
            },
        }));
    }
    private isRecoverableGenerationFailure(failureStatus: number | null): boolean {
        return failureStatus === HttpStatus.FORBIDDEN
            || (typeof failureStatus === 'number' && failureStatus >= HttpStatus.INTERNAL_SERVER_ERROR);
    }
    private generationFailureMessage(error: unknown): string {
        const message = error instanceof HttpException && error.message
            ? error.message
            : 'Lunch/break generation failed.';
        return message.slice(0, 1000);
    }
    private async fetchPolicy(tenantId: string): Promise<LunchBreakPolicy> {
        return this.tenantDb.withTenant(tenantId, (tx) => this.fetchPolicyForTenant(tx, tenantId));
    }
    private async fetchPolicyForTenant(tx: TenantPrismaTransaction, tenantId: string): Promise<LunchBreakPolicy> {
        const existing = await tx.tenantSetting.findUnique({
            where: {
                tenantId_key: {
                    tenantId,
                    key: TENANT_POLICY_SETTINGS_KEY,
                },
            },
        });
        if (!existing?.value || typeof existing.value !== 'object') {
            return { ...DEFAULT_POLICY };
        }
        return this.normalizePolicy(existing.value as Record<string, unknown>);
    }
    private normalizePolicy(value: Record<string, unknown>): LunchBreakPolicy {
        return {
            break1OffsetMinutes: this.clampInt(value.break1OffsetMinutes, DEFAULT_POLICY.break1OffsetMinutes, 10, 480),
            lunchOffsetMinutes: this.clampInt(value.lunchOffsetMinutes, DEFAULT_POLICY.lunchOffsetMinutes, 30, 600),
            break2OffsetMinutes: this.clampInt(value.break2OffsetMinutes, DEFAULT_POLICY.break2OffsetMinutes, 10, 480),
            break1DurationMinutes: this.clampInt(value.break1DurationMinutes, DEFAULT_POLICY.break1DurationMinutes, 5, 60),
            lunchDurationMinutes: this.clampInt(value.lunchDurationMinutes, DEFAULT_POLICY.lunchDurationMinutes, 15, 120),
            break2DurationMinutes: this.clampInt(value.break2DurationMinutes, DEFAULT_POLICY.break2DurationMinutes, 5, 60),
            timeStepMinutes: this.clampInt(value.timeStepMinutes, DEFAULT_POLICY.timeStepMinutes, 1, 60),
        };
    }
    private normalizeExplicitShifts(shifts: LunchBreakShiftInput[]): LunchBreakShiftInput[] {
        if (!Array.isArray(shifts))
            return [];
        return shifts
            .filter((item) => item && item.startTime && item.endTime)
            .map((item) => ({
            id: item.id,
            userId: item.userId ?? null,
            employeeName: item.employeeName?.trim() || 'Unassigned',
            startTime: item.startTime,
            endTime: item.endTime,
            lunchDurationMinutes: item.lunchDurationMinutes,
        }));
    }
    private async findSharedShifts(tx: TenantPrismaTransaction, tenantId: string, input: GenerateLunchBreaksRequest): Promise<SharedShift[]> {
        const where: Prisma.ShiftWhereInput = { tenantId, deletedAt: null };
        const and: Prisma.ShiftWhereInput[] = [SCHEDULABLE_SHIFT_USER_FILTER];
        if (input.scheduleId)
            where.scheduleId = input.scheduleId;
        if (input.locationId)
            where.locationId = input.locationId;
        if (input.shiftIds?.length)
            where.id = { in: input.shiftIds };
        where.AND = and;
        return tx.shift.findMany({
            where,
            orderBy: { startTime: 'asc' },
            include: {
                user: { select: { id: true, name: true, role: true } },
            },
        });
    }
    private async assertPersistedGenerationLocationBoundary(tenantId: string, locationId: string, shiftIds?: string[]): Promise<void> {
        await this.tenantDb.withTenant(tenantId, async (tx) => {
            const location = await tx.location.findFirst({
                where: { id: locationId, tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!location) {
                throw new BadRequestException('locationId must identify an active location in this tenant.');
            }
            const requestedShiftIds = [...new Set(shiftIds ?? [])];
            if (requestedShiftIds.length === 0)
                return;
            const matchingShiftCount = await tx.shift.count({
                where: {
                    tenantId,
                    deletedAt: null,
                    locationId,
                    id: { in: requestedShiftIds },
                },
            });
            if (matchingShiftCount !== requestedShiftIds.length) {
                throw new BadRequestException('Every selected shift must belong to the requested location.');
            }
        });
    }
    private buildShiftCalculationSnapshot(shifts: SharedShift[]): CalculationShiftSnapshot[] {
        return shifts.map((shift) => ({
            id: shift.id,
            scheduleId: shift.scheduleId,
            startTime: shift.startTime.toISOString(),
            endTime: shift.endTime.toISOString(),
            updatedAt: shift.updatedAt instanceof Date ? shift.updatedAt.toISOString() : undefined,
        }));
    }
    private buildBreakSchedule(shifts: LunchBreakShiftInput[], policy: LunchBreakPolicy): GeneratedShiftBreaks[] {
        if (!shifts.length)
            return [];
        return shifts.map((shift) => {
            const start = this.toDateOrThrow(shift.startTime, 'Invalid shift startTime');
            const end = this.toDateOrThrow(shift.endTime, 'Invalid shift endTime');
            this.assertShiftWindow(start, end);
            const startMs = start.getTime();
            const endMs = end.getTime();
            const stepMs = Math.max(1, policy.timeStepMinutes) * 60 * 1000;
            const lunchDuration = this.clampInt(shift.lunchDurationMinutes, policy.lunchDurationMinutes, 15, 120);
            const breaks = this.buildFeasibleBreaks(startMs, endMs, stepMs, [
                {
                    type: 'break1',
                    durationMinutes: policy.break1DurationMinutes,
                    preferredStartMs: startMs + policy.break1OffsetMinutes * 60_000,
                    paid: true,
                    priority: 2,
                },
                {
                    type: 'lunch',
                    durationMinutes: lunchDuration,
                    preferredStartMs: startMs + policy.lunchOffsetMinutes * 60_000,
                    paid: false,
                    priority: 4,
                },
                {
                    type: 'break2',
                    durationMinutes: policy.break2DurationMinutes,
                    preferredStartMs: startMs + (policy.lunchOffsetMinutes + lunchDuration + policy.break2OffsetMinutes) * 60_000,
                    paid: true,
                    priority: 1,
                },
            ]);
            return {
                shiftId: shift.id ?? null,
                userId: shift.userId ?? null,
                employeeName: shift.employeeName ?? 'Unassigned',
                startTime: new Date(startMs).toISOString(),
                endTime: new Date(endMs).toISOString(),
                breaks,
            };
        });
    }
    private buildFeasibleBreaks(shiftStartMs: number, shiftEndMs: number, stepMs: number, specs: BreakPlacementSpec[]): GeneratedBreak[] {
        let best: { breaks: GeneratedBreak[]; priority: number } = { breaks: [], priority: 0 };
        for (let mask = 1; mask < 1 << specs.length; mask += 1) {
            const selected = specs.filter((_spec, index) => (mask & (1 << index)) !== 0);
            const candidate = this.placeBreakSubset(shiftStartMs, shiftEndMs, stepMs, selected);
            if (!candidate)
                continue;
            const priority = selected.reduce((total, spec) => total + spec.priority, 0);
            if (candidate.length > best.breaks.length || (candidate.length === best.breaks.length && priority > best.priority)) {
                best = { breaks: candidate, priority };
            }
        }
        return best.breaks;
    }
    private placeBreakSubset(shiftStartMs: number, shiftEndMs: number, stepMs: number, specs: BreakPlacementSpec[]): GeneratedBreak[] | null {
        const latestStarts: number[] = new Array(specs.length);
        for (let index = specs.length - 1; index >= 0; index -= 1) {
            const durationMs = specs[index].durationMinutes * 60_000;
            latestStarts[index] = index === specs.length - 1
                ? shiftEndMs - durationMs
                : latestStarts[index + 1] - this.minimumBreakGapMs(specs[index], specs[index + 1]) - durationMs;
        }
        let earliestStart = shiftStartMs + 30 * 60_000;
        const placed: GeneratedBreak[] = [];
        for (let index = 0; index < specs.length; index += 1) {
            const spec = specs[index];
            const latestStart = latestStarts[index];
            if (earliestStart > latestStart)
                return null;
            const rounded = this.roundToStep(Math.min(latestStart, Math.max(earliestStart, spec.preferredStartMs)), stepMs);
            const startMs = Math.min(latestStart, Math.max(earliestStart, rounded));
            const endMs = startMs + spec.durationMinutes * 60_000;
            if (startMs < shiftStartMs || endMs > shiftEndMs || endMs <= startMs)
                return null;
            placed.push({
                type: spec.type,
                startTime: new Date(startMs).toISOString(),
                endTime: new Date(endMs).toISOString(),
                durationMinutes: spec.durationMinutes,
                paid: spec.paid,
            });
            if (index < specs.length - 1) {
                earliestStart = endMs + this.minimumBreakGapMs(spec, specs[index + 1]);
            }
        }
        return placed;
    }
    private minimumBreakGapMs(left: BreakPlacementSpec, right: BreakPlacementSpec): number {
        return left.type === 'break1' && right.type === 'lunch' ? 30 * 60_000 : 15 * 60_000;
    }
    private assertGeneratedBreakSchedule(generated: GeneratedShiftBreaks[]): void {
        for (const item of generated) {
            const shiftStart = this.toDateOrThrow(item.startTime, 'Invalid generated shift startTime');
            const shiftEnd = this.toDateOrThrow(item.endTime, 'Invalid generated shift endTime');
            this.assertShiftWindow(shiftStart, shiftEnd);
            const seenTypes = new Set();
            let previousEnd = shiftStart;
            for (const shiftBreak of item.breaks) {
                const breakStart = this.toDateOrThrow(shiftBreak.startTime, 'Invalid generated break startTime');
                const breakEnd = this.toDateOrThrow(shiftBreak.endTime, 'Invalid generated break endTime');
                if (seenTypes.has(shiftBreak.type) || breakStart < shiftStart || breakEnd > shiftEnd || breakEnd <= breakStart || breakStart < previousEnd) {
                    throw new BadRequestException('Generated break schedule is not feasible inside its shift window.');
                }
                if (Math.round((breakEnd.getTime() - breakStart.getTime()) / 60_000) !== shiftBreak.durationMinutes) {
                    throw new BadRequestException('Generated break duration does not match its interval.');
                }
                seenTypes.add(shiftBreak.type);
                previousEnd = breakEnd;
            }
        }
    }
    private async preflightGeneratedBreakPersistence(tenantId: string, generated: GeneratedShiftBreaks[], calculationSnapshot: CalculationShiftSnapshot[]): Promise<void> {
        const shiftIds = this.getGeneratedShiftIdsOrThrow(generated);
        await this.tenantDb.withTenant(tenantId, (tx) => this.assertGeneratedShiftIdsPersistable(tx, tenantId, shiftIds, calculationSnapshot));
    }
    private async persistGeneratedBreaks(tx: TenantPrismaTransaction, tenantId: string, generated: GeneratedShiftBreaks[], calculationSnapshot: CalculationShiftSnapshot[]): Promise<void> {
        const shiftIds = this.getGeneratedShiftIdsOrThrow(generated);
        const payload = generated.flatMap((item) => item.breaks.map((entry) => ({
            shiftId: item.shiftId as string,
            type: DB_BREAK_TYPE_BY_API_TYPE[entry.type],
            startTime: new Date(entry.startTime),
            endTime: new Date(entry.endTime),
            paid: entry.paid,
        })));
        await tx.break.deleteMany({ where: { shiftId: { in: shiftIds } } });
        if (payload.length > 0) {
            await tx.break.createMany({ data: payload });
        }
        await tx.shift.updateMany({
            where: { tenantId, deletedAt: null, id: { in: shiftIds } },
            data: { updatedAt: new Date() },
        });
        await this.incrementScheduleRevisions(tx, tenantId, calculationSnapshot.map((shift) => shift.scheduleId));
    }
    private getGeneratedShiftIdsOrThrow(generated: GeneratedShiftBreaks[]): string[] {
        const shiftIds = generated.map((item) => item.shiftId).filter((id): id is string => Boolean(id));
        if (shiftIds.length !== generated.length) {
            throw new BadRequestException('Cannot persist generated breaks without shift IDs.');
        }
        return shiftIds;
    }
    private async assertGeneratedShiftIdsPersistable(tx: TenantPrismaTransaction, tenantId: string, shiftIds: string[], calculationSnapshot: CalculationShiftSnapshot[]): Promise<void> {
        if (new Set(shiftIds).size !== shiftIds.length || calculationSnapshot.length !== shiftIds.length) {
            throw new ConflictException('Shift calculation snapshot no longer matches the requested shifts. Retry generation.');
        }
        await this.lockScheduleRowsForMutation(tx, tenantId, calculationSnapshot.map((shift) => shift.scheduleId));
        await tx.$queryRaw `
            SELECT "id"
            FROM "Shift"
            WHERE "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
              AND "id" IN (${Prisma.join([...shiftIds].sort())})
            ORDER BY "id" ASC
            FOR UPDATE
        `;
        const shifts = await tx.shift.findMany({
            where: { tenantId, deletedAt: null, id: { in: shiftIds }, AND: [SCHEDULABLE_SHIFT_USER_FILTER] },
            select: {
                id: true,
                scheduleId: true,
                startTime: true,
                endTime: true,
                updatedAt: true,
                schedule: { select: { status: true } },
            },
        });
        if (shifts.length !== shiftIds.length) {
            throw new BadRequestException('One or more shifts were not found for this tenant.');
        }
        if (shifts.some((shift) => this.isPublishedSchedule(shift.schedule?.status))) {
            throw new BadRequestException('Published schedules are locked. Create a new draft before changing lunch/breaks.');
        }
        const currentById = new Map(shifts.map((shift) => [shift.id, shift]));
        const stale = calculationSnapshot.some((expected) => {
            const current = currentById.get(expected.id);
            if (!current)
                return true;
            if (expected.scheduleId !== undefined && current.scheduleId !== expected.scheduleId)
                return true;
            if (current.startTime.toISOString() !== expected.startTime || current.endTime.toISOString() !== expected.endTime)
                return true;
            return expected.updatedAt !== undefined && current.updatedAt.toISOString() !== expected.updatedAt;
        });
        if (stale) {
            throw new ConflictException('One or more shifts changed after break calculation. Retry generation.');
        }
    }
    private mapShiftToGenerated(shift: ShiftWithBreaks): GeneratedShiftBreaks {
        const ordered = Array.isArray(shift.breaks) ? [...shift.breaks].sort((a, b) => a.startTime.getTime() - b.startTime.getTime()) : [];
        const typedByStoredType = new Map<BreakType, ShiftWithBreaks["breaks"][number]>();
        const untyped: ShiftWithBreaks["breaks"] = [];
        for (const entry of ordered) {
            const storedType = this.toApiBreakType(entry.type);
            if (storedType) {
                if (!typedByStoredType.has(storedType)) {
                    typedByStoredType.set(storedType, entry);
                }
                continue;
            }
            untyped.push(entry);
        }
        const paid = untyped.filter((b) => b.paid);
        const unpaid = untyped.filter((b) => !b.paid);
        const byType = {
            break1: typedByStoredType.get('break1') ?? paid[0] ?? untyped[0] ?? null,
            lunch: typedByStoredType.get('lunch') ?? unpaid[0] ?? untyped[Math.floor(untyped.length / 2)] ?? null,
            break2: typedByStoredType.get('break2') ?? paid[1] ?? untyped[untyped.length - 1] ?? null,
        };
        const usedBreaks = new Set<string | object>();
        const typed: GeneratedBreak[] = [];
        for (const type of BREAK_TYPES) {
            const candidate = byType[type];
            if (!candidate)
                continue;
            const identity: string | object = candidate.id ?? candidate;
            if (usedBreaks.has(identity))
                continue;
            usedBreaks.add(identity);
            typed.push({
                type,
                startTime: candidate.startTime.toISOString(),
                endTime: candidate.endTime.toISOString(),
                durationMinutes: Math.max(1, Math.round((candidate.endTime.getTime() - candidate.startTime.getTime()) / 60000)),
                paid: Boolean(candidate.paid),
            });
        }
        return {
            shiftId: shift.id,
            userId: shift.userId ?? null,
            employeeName: shift.user?.name ?? null,
            startTime: shift.startTime.toISOString(),
            endTime: shift.endTime.toISOString(),
            breaks: typed,
        };
    }
    private async assertSchedulableUser(tx: TenantPrismaTransaction, tenantId: string, userId: string): Promise<void> {
        const user = await lockActiveSchedulableUser(tx, tenantId, userId);
        if (!user) {
            throw new BadRequestException('User is not available for lunch/break scheduling in this tenant.');
        }
    }
    private isPublishedSchedule(status: ScheduleStatusValue): boolean {
        return status === 'PUBLISHED';
    }
    private assertDraftScheduleForBreakMutation(status: ScheduleStatusValue): void {
        if (this.isPublishedSchedule(status)) {
            throw new BadRequestException('Published schedules are locked. Create a new draft before changing lunch/breaks.');
        }
    }
    private async lockScheduleRowsForMutation(tx: TenantPrismaTransaction, tenantId: string, scheduleIds: Array<string | null | undefined>): Promise<void> {
        const ids = Array.from(new Set(scheduleIds.filter((id): id is string => Boolean(id)))).sort();
        if (ids.length === 0)
            return;
        const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
            SELECT "id", "status"
            FROM "Schedule"
            WHERE "tenantId" = ${tenantId}
              AND "id" IN (${Prisma.join(ids)})
            ORDER BY "id" ASC
            FOR UPDATE
        `;
        if (rows.some((row) => row.status !== 'DRAFT')) {
            throw new BadRequestException('Published schedules are locked. Reopen the schedule before changing lunch/breaks.');
        }
    }
    private async lockTenantSchedulingMutations(tx: TenantPrismaTransaction, tenantId: string): Promise<void> {
        await this.featureAccessService.lockTenantInTransaction(tx, tenantId);
        await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:scheduling:${tenantId}`}, 0))
        `;
    }
    private async incrementScheduleRevisions(tx: TenantPrismaTransaction, tenantId: string, scheduleIds: Array<string | null | undefined>): Promise<void> {
        const ids = Array.from(new Set(scheduleIds.filter((id): id is string => Boolean(id))));
        if (ids.length === 0)
            return;
        const updated = await tx.schedule.updateMany({
            where: { tenantId, id: { in: ids }, status: 'DRAFT', deletedAt: null },
            data: { revision: { increment: 1 } },
        });
        if (updated.count !== ids.length) {
            throw new ConflictException('Schedule changed before break edits could be saved. Retry the request.');
        }
    }
    private isBreakType(value: unknown): value is BreakType {
        return typeof value === 'string' && (BREAK_TYPES as readonly string[]).includes(value);
    }
    private isRecord(value: unknown): value is Record<string, unknown> {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }
    private toApiBreakType(value: unknown): BreakType | null {
        if (this.isBreakType(value))
            return value;
        if (typeof value !== 'string')
            return null;
        return API_BREAK_TYPE_BY_DB_TYPE[value] ?? null;
    }
    private toDateOrThrow(value: unknown, message: string): Date {
        if (typeof value !== 'string' || !value.trim()) {
            throw new BadRequestException(message);
        }
        const normalized = value.trim();
        const match = UTC_INSTANT_RE.exec(normalized);
        if (!match) {
            throw new BadRequestException(`${message} Use UTC ISO 8601.`);
        }
        const parsed = new Date(normalized);
        if (!this.isValidUtcInstant(parsed, match)) {
            throw new BadRequestException(`${message} Use UTC ISO 8601.`);
        }
        return parsed;
    }
    private isValidUtcInstant(parsed: Date, match: RegExpExecArray): boolean {
        return Number.isFinite(parsed.getTime()) &&
            parsed.getUTCFullYear() === Number(match[1]) &&
            parsed.getUTCMonth() === Number(match[2]) - 1 &&
            parsed.getUTCDate() === Number(match[3]) &&
            parsed.getUTCHours() === Number(match[4]) &&
            parsed.getUTCMinutes() === Number(match[5]) &&
            parsed.getUTCSeconds() === Number(match[6] ?? 0);
    }
    private assertBreakWindowsDoNotOverlap(breaks: BreakWindow[]): void {
        const ordered = [...breaks].sort((left, right) => left.startTime.getTime() - right.startTime.getTime());
        for (let index = 1; index < ordered.length; index += 1) {
            if (ordered[index - 1].endTime > ordered[index].startTime) {
                throw new BadRequestException('Break windows cannot overlap.');
            }
        }
    }
    private assertShiftWindow(startTime: Date, endTime: Date): void {
        if (endTime <= startTime) {
            throw new BadRequestException('Shift end time must be after start time.');
        }
    }
    private clampInt(value: unknown, fallback: number, min: number, max: number): number {
        const parsed = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(parsed))
            return fallback;
        return Math.min(max, Math.max(min, Math.round(parsed)));
    }
    private roundToStep(valueMs: number, stepMs: number): number {
        return Math.round(valueMs / stepMs) * stepMs;
    }
}
