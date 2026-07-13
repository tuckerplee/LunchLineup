// @ts-nocheck
"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LunchBreaksService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
import * as feature_access_service_1 from "../billing/feature-access.service";
import * as tenant_prisma_service_1 from "../database/tenant-prisma.service";
import * as lunch_break_generation_idempotency_1 from "./lunch-break-generation-idempotency";
const BREAK_TYPES = ['break1', 'lunch', 'break2'];
const GENERATION_CLAIM_MS = 2 * 60_000;
const UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
const DB_BREAK_TYPE_BY_API_TYPE = {
    break1: client_1.BreakType.BREAK1,
    lunch: client_1.BreakType.LUNCH,
    break2: client_1.BreakType.BREAK2,
};
const API_BREAK_TYPE_BY_DB_TYPE = {
    BREAK1: 'break1',
    LUNCH: 'lunch',
    BREAK2: 'break2',
};
const TENANT_POLICY_SETTINGS_KEY = 'lunch_break_policy';
const SCHEDULABLE_USER_ROLES = [client_1.UserRole.MANAGER, client_1.UserRole.STAFF];
const SCHEDULABLE_SHIFT_USER_FILTER = {
    OR: [
        { userId: null },
        { user: { is: { role: { in: SCHEDULABLE_USER_ROLES }, deletedAt: null } } },
    ],
};
const DEFAULT_POLICY = {
    break1OffsetMinutes: 120,
    lunchOffsetMinutes: 240,
    break2OffsetMinutes: 120,
    break1DurationMinutes: 10,
    lunchDurationMinutes: 30,
    break2DurationMinutes: 10,
    timeStepMinutes: 5,
};
let LunchBreaksService = class LunchBreaksService {
    featureAccessService;
    tenantDb;
    constructor(featureAccessService, tenantDb) {
        this.featureAccessService = featureAccessService;
        this.tenantDb = tenantDb ?? new tenant_prisma_service_1.TenantPrismaService();
    }
    async getPolicy(tenantId) {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'lunch_breaks');
        return this.fetchPolicy(tenantId);
    }
    async updatePolicy(tenantId, policy) {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'lunch_breaks');
        return this.tenantDb.withTenant(tenantId, async (tx) => {
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
                    value: mergedPolicy,
                },
                update: {
                    value: mergedPolicy,
                },
            });
            return mergedPolicy;
        });
    }
    async listLunchBreaks(tenantId, filters, actor) {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'lunch_breaks');
        const where = { tenantId, deletedAt: null };
        const and = [SCHEDULABLE_SHIFT_USER_FILTER];
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
        if (filters.startDate)
            and.push({ endTime: { gt: this.toDateOrThrow(filters.startDate, 'Invalid startDate') } });
        if (filters.endDate)
            and.push({ startTime: { lt: this.toDateOrThrow(filters.endDate, 'Invalid endDate') } });
        where.AND = and;
        const shifts = await this.tenantDb.withTenant(tenantId, (tx) => tx.shift.findMany({
            where,
            orderBy: { startTime: 'asc' },
            include: {
                user: { select: { id: true, name: true, role: true } },
                breaks: { orderBy: { startTime: 'asc' } },
            },
        }));
        return {
            data: shifts.map((shift) => this.mapShiftToGenerated(shift)),
        };
    }
    isStaffActor(actor) {
        return [actor?.legacyRole, actor?.role].some((role) => this.isRole(role, client_1.UserRole.STAFF));
    }
    isRole(value, expected) {
        return typeof value === 'string'
            && value.trim().replace(/[\s-]+/g, '_').toUpperCase() === expected;
    }
    actorUserId(actor) {
        return actor?.sub ?? actor?.id;
    }
    async updateShiftBreaks(tenantId, shiftId, input) {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'lunch_breaks');
        const locationId = typeof input.locationId === 'string' ? input.locationId.trim() : '';
        if (!locationId) {
            throw new common_1.BadRequestException('locationId is required when editing shift lunch/breaks.');
        }
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const policy = await this.fetchPolicyForTenant(tx, tenantId);
            const shift = await tx.shift.findFirst({
                where: { id: shiftId, tenantId, locationId, deletedAt: null, AND: [SCHEDULABLE_SHIFT_USER_FILTER] },
                include: {
                    user: { select: { id: true, name: true, role: true } },
                    schedule: { select: { id: true, status: true } },
                    breaks: { orderBy: { startTime: 'asc' } },
                },
            });
            if (!shift)
                throw new common_1.NotFoundException('Shift not found for the selected location.');
            await this.lockScheduleRowsForMutation(tx, tenantId, [shift.schedule?.id]);
            this.assertDraftScheduleForBreakMutation(shift.schedule?.status);
            const shiftStart = shift.startTime.getTime();
            const shiftEnd = shift.endTime.getTime();
            const byType = new Map();
            for (const item of input.breaks ?? []) {
                if (!item || typeof item !== 'object' || !this.isBreakType(item.type)) {
                    throw new common_1.BadRequestException('Each break edit requires a valid type.');
                }
                if (byType.has(item.type)) {
                    throw new common_1.BadRequestException('Each break type can only be edited once.');
                }
                byType.set(item.type, item);
            }
            const payload = [];
            for (const type of BREAK_TYPES) {
                const candidate = byType.get(type);
                if (!candidate || candidate.skip)
                    continue;
                if (!candidate.startTime) {
                    throw new common_1.BadRequestException(`${type} startTime is required when not skipped.`);
                }
                const start = this.toDateOrThrow(candidate.startTime, `Invalid ${type} startTime.`);
                const duration = type === 'lunch'
                    ? this.clampInt(candidate.durationMinutes, policy.lunchDurationMinutes, 15, 120)
                    : this.clampInt(candidate.durationMinutes, type === 'break1' ? policy.break1DurationMinutes : policy.break2DurationMinutes, 5, 60);
                const startMs = start.getTime();
                const endMs = startMs + duration * 60000;
                if (startMs < shiftStart || endMs > shiftEnd) {
                    throw new common_1.BadRequestException(`${type} must be within the shift window.`);
                }
                payload.push({
                    shiftId,
                    type: DB_BREAK_TYPE_BY_API_TYPE[type],
                    startTime: start,
                    endTime: new Date(endMs),
                    paid: type !== 'lunch',
                });
            }
            this.assertBreakWindowsDoNotOverlap(payload);
            await tx.break.deleteMany({ where: { shiftId } });
            if (payload.length > 0) {
                await tx.break.createMany({ data: payload });
            }
            await this.incrementScheduleRevisions(tx, tenantId, [shift.schedule?.id]);
            const updated = await tx.shift.findFirst({
                where: { id: shiftId, tenantId, locationId, deletedAt: null, AND: [SCHEDULABLE_SHIFT_USER_FILTER] },
                include: {
                    user: { select: { id: true, name: true, role: true } },
                    breaks: { orderBy: { startTime: 'asc' } },
                },
            });
            if (!updated)
                throw new common_1.NotFoundException('Shift not found for this tenant.');
            return this.mapShiftToGenerated(updated);
        });
    }
    async persistSetupShifts(tenantId, input) {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'lunch_breaks');
        const locationId = typeof input.locationId === 'string' ? input.locationId.trim() : '';
        if (!locationId) {
            throw new common_1.BadRequestException('A location is required for setup shifts.');
        }
        const rows = Array.isArray(input.rows) ? input.rows : [];
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const location = await tx.location.findFirst({
                where: { id: locationId, tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!location) {
                throw new common_1.BadRequestException('The selected location was not found for this workspace.');
            }
            if (rows.length === 0)
                return { shiftIds: [] };
            const explicitShiftIds = rows.map((row) => row.shiftId).filter((id) => Boolean(id));
            const existingShifts = explicitShiftIds.length > 0
                ? await tx.shift.findMany({
                    where: { tenantId, deletedAt: null, id: { in: explicitShiftIds }, AND: [SCHEDULABLE_SHIFT_USER_FILTER] },
                    select: { id: true, locationId: true, scheduleId: true, schedule: { select: { status: true } } },
                })
                : [];
            const existingById = new Map(existingShifts.map((shift) => [shift.id, shift]));
            if (existingById.size !== explicitShiftIds.length) {
                throw new common_1.BadRequestException('One or more setup shifts were not found for this tenant.');
            }
            if (existingShifts.some((shift) => shift.locationId !== locationId)) {
                throw new common_1.BadRequestException('Setup shifts must belong to the selected location.');
            }
            await this.lockScheduleRowsForMutation(tx, tenantId, existingShifts.map((shift) => shift.scheduleId));
            if (existingShifts.some((shift) => this.isPublishedSchedule(shift.schedule?.status))) {
                throw new common_1.BadRequestException('Published schedules are locked. Create a new draft before changing lunch/break setup shifts.');
            }
            const ids = [];
            for (const row of rows) {
                const startTime = this.toDateOrThrow(row.startTime, 'Invalid setup shift startTime.');
                const endTime = this.toDateOrThrow(row.endTime, 'Invalid setup shift endTime.');
                this.assertShiftWindow(startTime, endTime);
                const userId = row.userId ?? null;
                if (userId) {
                    await this.assertSchedulableUser(tx, tenantId, userId);
                }
                if (row.shiftId) {
                    const updated = await tx.shift.updateMany({
                        where: { id: row.shiftId, tenantId, deletedAt: null },
                        data: {
                            startTime,
                            endTime,
                            ...(Object.prototype.hasOwnProperty.call(row, 'userId') ? { userId } : {}),
                        },
                    });
                    if (updated.count === 0) {
                        throw new common_1.BadRequestException('Unable to persist one or more setup shifts.');
                    }
                    ids.push(row.shiftId);
                    continue;
                }
                const created = await tx.shift.create({
                    data: {
                        tenantId,
                        locationId,
                        userId,
                        startTime,
                        endTime,
                        role: null,
                    },
                    select: { id: true },
                });
                ids.push(created.id);
            }
            return { shiftIds: ids };
        });
    }
    async generateLunchBreaks(tenantId, input, idempotencyKey) {
        const persistedLocationId = input.persist ? input.locationId?.trim() : undefined;
        if (input.persist && !persistedLocationId) {
            throw new common_1.BadRequestException('locationId is required when persisting generated lunch/breaks.');
        }
        const generationInputRequest = persistedLocationId
            ? { ...input, locationId: persistedLocationId }
            : input;
        if (persistedLocationId) {
            await this.assertPersistedGenerationLocationBoundary(tenantId, persistedLocationId, generationInputRequest.shiftIds);
        }
        const requestKeyHash = (0, lunch_break_generation_idempotency_1.hashLunchBreakGenerationIdempotencyKey)((0, lunch_break_generation_idempotency_1.normalizeLunchBreakGenerationIdempotencyKey)(idempotencyKey));
        const requestHash = (0, lunch_break_generation_idempotency_1.lunchBreakGenerationRequestHash)(generationInputRequest);
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
                        throw new common_1.BadRequestException('locationId must identify an active location in this tenant.');
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
                        throw new common_1.BadRequestException('Every selected shift must belong to the requested location.');
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
                throw new common_1.BadRequestException('Add at least one valid shift before generating lunch/breaks.');
            }
            this.assertGeneratedBreakSchedule(data);
            const shouldPersist = Boolean(input.persist) && source === 'shared_schedule';
            if (Boolean(input.persist) && source !== 'shared_schedule') {
                throw new common_1.BadRequestException('Persisting lunch/breaks requires existing shift records from shared scheduling data.');
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
    async claimGenerationRequest(tenantId, requestKeyHash, requestHash) {
        const requestId = (0, crypto_1.randomUUID)();
        const claimToken = (0, crypto_1.randomUUID)();
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
            if (row.id === requestId || row.requestHash !== requestHash || row.status === 'SUCCEEDED' || row.status === 'FAILED') {
                return row;
            }
            const reclaimed = await tx.lunchBreakGenerationRequest.updateMany({
                where: {
                    id: row.id,
                    tenantId,
                    requestHash,
                    status: 'PENDING',
                    OR: [
                        { claimExpiresAt: null },
                        { claimExpiresAt: { lte: now } },
                    ],
                },
                data: {
                    claimToken,
                    claimExpiresAt,
                    attempts: { increment: 1 },
                    failureStatus: null,
                    failureMessage: null,
                },
            });
            if (reclaimed.count !== 1)
                return row;
            return { ...row, claimToken, claimExpiresAt };
        });
        if (request.requestHash !== requestHash || request.status === 'SUCCEEDED' || request.status === 'FAILED') {
            return { reusedResponse: this.reuseGenerationRequest(request, requestHash) };
        }
        if (request.claimToken !== claimToken) {
            throw new common_1.ConflictException('Lunch/break generation for this Idempotency-Key is already in progress.');
        }
        return { requestId: request.id, claimToken };
    }
    async findGenerationRequest(tenantId, requestKeyHash) {
        return this.tenantDb.withTenant(tenantId, (tx) => tx.lunchBreakGenerationRequest.findUnique({
            where: { tenantId_requestKeyHash: { tenantId, requestKeyHash } },
        }));
    }
    reuseGenerationRequest(request, requestHash) {
        if (request.requestHash !== requestHash) {
            throw new common_1.ConflictException('Idempotency-Key was already used with a different lunch/break generation request.');
        }
        if (request.status === 'SUCCEEDED' && request.response) {
            return {
                ...request.response,
                reused: true,
            };
        }
        if (request.status === 'FAILED') {
            throw new common_1.HttpException(request.failureMessage || 'Lunch/break generation failed.', request.failureStatus || common_1.HttpStatus.INTERNAL_SERVER_ERROR);
        }
        throw new common_1.ConflictException('Lunch/break generation for this Idempotency-Key is already in progress.');
    }
    async completeGenerationRequest(tenantId, claim, prepared) {
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
                throw new common_1.ConflictException('Lunch/break generation claim expired before it could commit. Retry the request.');
            }
            const entitlement = await this.featureAccessService.assertFeatureEnabledInTransaction(
                tx,
                tenantId,
                'lunch_breaks',
            );
            if (prepared.generated) {
                await this.assertGeneratedShiftIdsPersistable(tx, tenantId, this.getGeneratedShiftIdsOrThrow(prepared.generated), prepared.calculationSnapshot);
            }
            const creditConsumption = await this.reserveGenerationCredit(tx, {
                tenantId,
                requestId: claim.requestId,
                source: entitlement.source,
                cost: entitlement.creditCost ?? 0,
                fallbackBalance: 0,
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
                    response: response,
                    creditConsumption: creditConsumption,
                    creditTransactionId: this.generationCreditTransactionId(claim.requestId, entitlement),
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
    async reserveGenerationCredit(tx, args) {
        if (args.cost > 0) {
            const rows = await tx.$queryRaw `
                UPDATE "Tenant"
                SET
                    "usageCredits" = "usageCredits" - ${args.cost},
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = ${args.tenantId}
                  AND "usageCredits" >= ${args.cost}
                RETURNING "usageCredits"
            `;
            if (!rows[0])
                throw new common_1.ForbiddenException('Insufficient usage credits balance.');
            const transactionId = this.generationCreditTransactionId(args.requestId, args);
            if (!transactionId)
                throw new Error('Credit transaction id is required for wallet usage.');
            await tx.creditTransaction.create({
                data: {
                    id: transactionId,
                    tenantId: args.tenantId,
                    amount: -args.cost,
                    reason: `Lunch/Break generation (${args.requestId})`,
                },
            });
            return { consumedCredits: args.cost, newBalance: Number(rows[0].usageCredits), source: args.source };
        }
        return {
            consumedCredits: args.source === 'plan' || args.source === 'stripe' ? args.cost : 0,
            newBalance: args.fallbackBalance,
            source: args.source,
        };
    }
    generationCreditTransactionId(requestId, entitlement) {
        const hasLedgerEntry = entitlement.cost > 0;
        return hasLedgerEntry ? `lunch-break-credit-${requestId}` : null;
    }
    async failGenerationRequest(tenantId, claim, error) {
        await this.tenantDb.withTenant(tenantId, (tx) => tx.lunchBreakGenerationRequest.updateMany({
            where: { id: claim.requestId, tenantId, status: 'PENDING', claimToken: claim.claimToken },
            data: {
                status: 'FAILED',
                failureStatus: error instanceof common_1.HttpException ? error.getStatus() : common_1.HttpStatus.INTERNAL_SERVER_ERROR,
                failureMessage: this.generationFailureMessage(error),
                completedAt: new Date(),
                claimToken: null,
                claimExpiresAt: null,
            },
        }));
    }
    generationFailureMessage(error) {
        const message = error instanceof Error && error.message
            ? error.message
            : 'Lunch/break generation failed.';
        return message.slice(0, 1000);
    }
    async fetchPolicy(tenantId) {
        return this.tenantDb.withTenant(tenantId, (tx) => this.fetchPolicyForTenant(tx, tenantId));
    }
    async fetchPolicyForTenant(tx, tenantId) {
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
        return this.normalizePolicy(existing.value);
    }
    normalizePolicy(value) {
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
    normalizeExplicitShifts(shifts) {
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
    async findSharedShifts(tx, tenantId, input) {
        const where = { tenantId, deletedAt: null };
        const and = [SCHEDULABLE_SHIFT_USER_FILTER];
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
    async assertPersistedGenerationLocationBoundary(tenantId, locationId, shiftIds) {
        await this.tenantDb.withTenant(tenantId, async (tx) => {
            const location = await tx.location.findFirst({
                where: { id: locationId, tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!location) {
                throw new common_1.BadRequestException('locationId must identify an active location in this tenant.');
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
                throw new common_1.BadRequestException('Every selected shift must belong to the requested location.');
            }
        });
    }
    buildShiftCalculationSnapshot(shifts) {
        return shifts.map((shift) => ({
            id: shift.id,
            scheduleId: shift.scheduleId,
            startTime: shift.startTime.toISOString(),
            endTime: shift.endTime.toISOString(),
            updatedAt: shift.updatedAt instanceof Date ? shift.updatedAt.toISOString() : undefined,
        }));
    }
    buildBreakSchedule(shifts, policy) {
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
    buildFeasibleBreaks(shiftStartMs, shiftEndMs, stepMs, specs) {
        let best = { breaks: [], priority: 0 };
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
    placeBreakSubset(shiftStartMs, shiftEndMs, stepMs, specs) {
        const latestStarts = new Array(specs.length);
        for (let index = specs.length - 1; index >= 0; index -= 1) {
            const durationMs = specs[index].durationMinutes * 60_000;
            latestStarts[index] = index === specs.length - 1
                ? shiftEndMs - durationMs
                : latestStarts[index + 1] - this.minimumBreakGapMs(specs[index], specs[index + 1]) - durationMs;
        }
        let earliestStart = shiftStartMs + 30 * 60_000;
        const placed = [];
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
    minimumBreakGapMs(left, right) {
        return left.type === 'break1' && right.type === 'lunch' ? 30 * 60_000 : 15 * 60_000;
    }
    assertGeneratedBreakSchedule(generated) {
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
                    throw new common_1.BadRequestException('Generated break schedule is not feasible inside its shift window.');
                }
                if (Math.round((breakEnd.getTime() - breakStart.getTime()) / 60_000) !== shiftBreak.durationMinutes) {
                    throw new common_1.BadRequestException('Generated break duration does not match its interval.');
                }
                seenTypes.add(shiftBreak.type);
                previousEnd = breakEnd;
            }
        }
    }
    async preflightGeneratedBreakPersistence(tenantId, generated, calculationSnapshot) {
        const shiftIds = this.getGeneratedShiftIdsOrThrow(generated);
        await this.tenantDb.withTenant(tenantId, (tx) => this.assertGeneratedShiftIdsPersistable(tx, tenantId, shiftIds, calculationSnapshot));
    }
    async persistGeneratedBreaks(tx, tenantId, generated, calculationSnapshot) {
        const shiftIds = this.getGeneratedShiftIdsOrThrow(generated);
        const payload = generated.flatMap((item) => item.breaks.map((entry) => ({
            shiftId: item.shiftId,
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
    getGeneratedShiftIdsOrThrow(generated) {
        const shiftIds = generated.map((item) => item.shiftId).filter((id) => Boolean(id));
        if (shiftIds.length !== generated.length) {
            throw new common_1.BadRequestException('Cannot persist generated breaks without shift IDs.');
        }
        return shiftIds;
    }
    async assertGeneratedShiftIdsPersistable(tx, tenantId, shiftIds, calculationSnapshot) {
        if (new Set(shiftIds).size !== shiftIds.length || calculationSnapshot.length !== shiftIds.length) {
            throw new common_1.ConflictException('Shift calculation snapshot no longer matches the requested shifts. Retry generation.');
        }
        await this.lockScheduleRowsForMutation(tx, tenantId, calculationSnapshot.map((shift) => shift.scheduleId));
        await tx.$queryRaw `
            SELECT "id"
            FROM "Shift"
            WHERE "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
              AND "id" IN (${client_1.Prisma.join([...shiftIds].sort())})
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
            throw new common_1.BadRequestException('One or more shifts were not found for this tenant.');
        }
        if (shifts.some((shift) => this.isPublishedSchedule(shift.schedule?.status))) {
            throw new common_1.BadRequestException('Published schedules are locked. Create a new draft before changing lunch/breaks.');
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
            throw new common_1.ConflictException('One or more shifts changed after break calculation. Retry generation.');
        }
    }
    mapShiftToGenerated(shift) {
        const ordered = Array.isArray(shift.breaks) ? [...shift.breaks].sort((a, b) => a.startTime.getTime() - b.startTime.getTime()) : [];
        const typedByStoredType = new Map();
        const untyped = [];
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
        const usedBreaks = new Set();
        const typed = [];
        for (const type of BREAK_TYPES) {
            const candidate = byType[type];
            if (!candidate)
                continue;
            const identity = candidate.id ?? candidate;
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
    async assertSchedulableUser(tx, tenantId, userId) {
        const user = await tx.user.findFirst({
            where: { id: userId, tenantId, deletedAt: null, role: { in: SCHEDULABLE_USER_ROLES } },
            select: { id: true },
        });
        if (!user) {
            throw new common_1.BadRequestException('User is not available for lunch/break scheduling in this tenant.');
        }
    }
    isPublishedSchedule(status) {
        return status === 'PUBLISHED';
    }
    assertDraftScheduleForBreakMutation(status) {
        if (this.isPublishedSchedule(status)) {
            throw new common_1.BadRequestException('Published schedules are locked. Create a new draft before changing lunch/breaks.');
        }
    }
    async lockScheduleRowsForMutation(tx, tenantId, scheduleIds) {
        const ids = Array.from(new Set(scheduleIds.filter((id) => Boolean(id)))).sort();
        if (ids.length === 0)
            return;
        const rows = await tx.$queryRaw `
            SELECT "id", "status"
            FROM "Schedule"
            WHERE "tenantId" = ${tenantId}
              AND "id" IN (${client_1.Prisma.join(ids)})
            ORDER BY "id" ASC
            FOR UPDATE
        `;
        if (rows.some((row) => row.status !== 'DRAFT')) {
            throw new common_1.BadRequestException('Published schedules are locked. Reopen the schedule before changing lunch/breaks.');
        }
    }
    async incrementScheduleRevisions(tx, tenantId, scheduleIds) {
        const ids = Array.from(new Set(scheduleIds.filter((id) => Boolean(id))));
        if (ids.length === 0)
            return;
        const updated = await tx.schedule.updateMany({
            where: { tenantId, id: { in: ids }, status: 'DRAFT', deletedAt: null },
            data: { revision: { increment: 1 } },
        });
        if (updated.count !== ids.length) {
            throw new common_1.ConflictException('Schedule changed before break edits could be saved. Retry the request.');
        }
    }
    isBreakType(value) {
        return typeof value === 'string' && BREAK_TYPES.includes(value);
    }
    toApiBreakType(value) {
        if (this.isBreakType(value))
            return value;
        if (typeof value !== 'string')
            return null;
        return API_BREAK_TYPE_BY_DB_TYPE[value] ?? null;
    }
    toDateOrThrow(value, message) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new common_1.BadRequestException(message);
        }
        const normalized = value.trim();
        const match = UTC_INSTANT_RE.exec(normalized);
        if (!match) {
            throw new common_1.BadRequestException(`${message} Use UTC ISO 8601.`);
        }
        const parsed = new Date(normalized);
        if (!this.isValidUtcInstant(parsed, match)) {
            throw new common_1.BadRequestException(`${message} Use UTC ISO 8601.`);
        }
        return parsed;
    }
    isValidUtcInstant(parsed, match) {
        return Number.isFinite(parsed.getTime()) &&
            parsed.getUTCFullYear() === Number(match[1]) &&
            parsed.getUTCMonth() === Number(match[2]) - 1 &&
            parsed.getUTCDate() === Number(match[3]) &&
            parsed.getUTCHours() === Number(match[4]) &&
            parsed.getUTCMinutes() === Number(match[5]) &&
            parsed.getUTCSeconds() === Number(match[6] ?? 0);
    }
    assertBreakWindowsDoNotOverlap(breaks) {
        const ordered = [...breaks].sort((left, right) => left.startTime.getTime() - right.startTime.getTime());
        for (let index = 1; index < ordered.length; index += 1) {
            if (ordered[index - 1].endTime > ordered[index].startTime) {
                throw new common_1.BadRequestException('Break windows cannot overlap.');
            }
        }
    }
    assertShiftWindow(startTime, endTime) {
        if (endTime <= startTime) {
            throw new common_1.BadRequestException('Shift end time must be after start time.');
        }
    }
    clampInt(value, fallback, min, max) {
        const parsed = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(parsed))
            return fallback;
        return Math.min(max, Math.max(min, Math.round(parsed)));
    }
    roundToStep(valueMs, stepMs) {
        return Math.round(valueMs / stepMs) * stepMs;
    }
};
exports.LunchBreaksService = LunchBreaksService;
exports.LunchBreaksService = LunchBreaksService = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [feature_access_service_1.FeatureAccessService,
        tenant_prisma_service_1.TenantPrismaService])
], LunchBreaksService);
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
export interface UpdateShiftBreakInput {
    type: 'break1' | 'lunch' | 'break2';
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
export type LunchBreaksService = any;
export { LunchBreaksService };
