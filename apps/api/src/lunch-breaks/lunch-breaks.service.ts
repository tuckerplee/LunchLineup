import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { FeatureAccessService } from '../billing/feature-access.service';

type BreakType = 'break1' | 'lunch' | 'break2';

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
    breaks?: UpdateShiftBreakInput[];
}

const TENANT_POLICY_SETTINGS_KEY = 'lunch_break_policy';

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
    private readonly prisma: PrismaClient;

    constructor(
        private readonly featureAccessService: FeatureAccessService,
        @Optional() prisma?: PrismaClient,
    ) {
        this.prisma = prisma ?? new PrismaClient();
    }

    async getPolicy(tenantId: string): Promise<LunchBreakPolicy> {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'lunch_breaks');
        return this.fetchPolicy(tenantId);
    }

    async updatePolicy(tenantId: string, policy: Partial<LunchBreakPolicy>): Promise<LunchBreakPolicy> {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'lunch_breaks');
        const mergedPolicy = this.normalizePolicy({ ...(await this.fetchPolicy(tenantId)), ...policy });

        await this.prisma.tenantSetting.upsert({
            where: {
                tenantId_key: {
                    tenantId,
                    key: TENANT_POLICY_SETTINGS_KEY,
                },
            },
            create: {
                tenantId,
                key: TENANT_POLICY_SETTINGS_KEY,
                value: mergedPolicy as any,
            },
            update: {
                value: mergedPolicy as any,
            },
        });

        return mergedPolicy;
    }

    async listLunchBreaks(
        tenantId: string,
        filters: {
            scheduleId?: string;
            locationId?: string;
            shiftIds?: string[];
            startDate?: string;
            endDate?: string;
        },
    ): Promise<{ data: GeneratedShiftBreaks[] }> {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'lunch_breaks');
        const where: any = { tenantId, deletedAt: null };
        if (filters.scheduleId) where.scheduleId = filters.scheduleId;
        if (filters.locationId) where.locationId = filters.locationId;
        if (filters.shiftIds?.length) where.id = { in: filters.shiftIds };

        const and: any[] = [];
        if (filters.startDate) and.push({ endTime: { gt: this.toDateOrThrow(filters.startDate, 'Invalid startDate') } });
        if (filters.endDate) and.push({ startTime: { lt: this.toDateOrThrow(filters.endDate, 'Invalid endDate') } });
        if (and.length > 0) where.AND = and;

        const shifts = await this.prisma.shift.findMany({
            where,
            orderBy: { startTime: 'asc' },
            include: {
                user: { select: { id: true, name: true } },
                breaks: { orderBy: { startTime: 'asc' } },
            },
        });

        return {
            data: shifts.map((shift) => this.mapShiftToGenerated(shift)),
        };
    }

    async updateShiftBreaks(
        tenantId: string,
        shiftId: string,
        input: UpdateShiftLunchBreaksRequest,
    ): Promise<GeneratedShiftBreaks> {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'lunch_breaks');
        const policy = await this.fetchPolicy(tenantId);

        const shift = await this.prisma.shift.findFirst({
            where: { id: shiftId, tenantId, deletedAt: null },
            include: {
                user: { select: { id: true, name: true } },
                breaks: { orderBy: { startTime: 'asc' } },
            },
        });
        if (!shift) throw new NotFoundException('Shift not found for this tenant.');

        const shiftStart = shift.startTime.getTime();
        const shiftEnd = shift.endTime.getTime();
        const byType = new Map<BreakType, UpdateShiftBreakInput>();
        for (const item of input.breaks ?? []) {
            if (item?.type === 'break1' || item?.type === 'lunch' || item?.type === 'break2') {
                byType.set(item.type, item);
            }
        }

        const payload: Array<{ shiftId: string; startTime: Date; endTime: Date; paid: boolean }> = [];
        for (const type of ['break1', 'lunch', 'break2'] as BreakType[]) {
            const candidate = byType.get(type);
            if (!candidate || candidate.skip) continue;
            if (!candidate.startTime) {
                throw new BadRequestException(`${type} startTime is required when not skipped.`);
            }

            const start = this.toDateOrThrow(candidate.startTime, `Invalid ${type} startTime.`);
            const duration = type === 'lunch'
                ? this.clampInt(candidate.durationMinutes, policy.lunchDurationMinutes, 15, 120)
                : this.clampInt(
                    candidate.durationMinutes,
                    type === 'break1' ? policy.break1DurationMinutes : policy.break2DurationMinutes,
                    5,
                    60,
                );

            const startMs = start.getTime();
            const endMs = startMs + duration * 60000;
            if (startMs < shiftStart || endMs > shiftEnd) {
                throw new BadRequestException(`${type} must be within the shift window.`);
            }

            payload.push({
                shiftId,
                startTime: start,
                endTime: new Date(endMs),
                paid: type !== 'lunch',
            });
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.break.deleteMany({ where: { shiftId } });
            if (payload.length > 0) {
                await tx.break.createMany({ data: payload });
            }
        });

        const updated = await this.prisma.shift.findFirst({
            where: { id: shiftId, tenantId, deletedAt: null },
            include: {
                user: { select: { id: true, name: true } },
                breaks: { orderBy: { startTime: 'asc' } },
            },
        });
        if (!updated) throw new NotFoundException('Shift not found for this tenant.');
        return this.mapShiftToGenerated(updated);
    }

    async generateLunchBreaks(
        tenantId: string,
        input: GenerateLunchBreaksRequest,
    ): Promise<{
        source: 'shared_schedule' | 'standalone';
        persisted: boolean;
        policy: LunchBreakPolicy;
        creditConsumption: { consumedCredits: number; newBalance: number | null };
        data: GeneratedShiftBreaks[];
    }> {
        const creditConsumption = await this.featureAccessService.consumeCreditsForFeature(
            tenantId,
            'lunch_breaks',
            'Lunch/Break generation',
        );

        const policy = this.normalizePolicy({
            ...(await this.fetchPolicy(tenantId)),
            ...(input.policy ?? {}),
        });

        const explicitShifts = this.normalizeExplicitShifts(input.shifts ?? []);
        const dbShifts = explicitShifts.length === 0
            ? await this.findSharedShifts(tenantId, input)
            : [];

        const source: 'shared_schedule' | 'standalone' = dbShifts.length > 0 ? 'shared_schedule' : 'standalone';
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

        const data = this.buildBreakSchedule(generationInput, policy);
        const shouldPersist = Boolean(input.persist) && source === 'shared_schedule';
        if (Boolean(input.persist) && source !== 'shared_schedule') {
            throw new BadRequestException('Persisting lunch/breaks requires existing shift records from shared scheduling data.');
        }
        if (shouldPersist) {
            await this.persistGeneratedBreaks(tenantId, data);
        }

        return {
            source,
            persisted: shouldPersist,
            policy,
            creditConsumption,
            data,
        };
    }

    private async fetchPolicy(tenantId: string): Promise<LunchBreakPolicy> {
        const existing = await this.prisma.tenantSetting.findUnique({
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
        if (!Array.isArray(shifts)) return [];
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

    private async findSharedShifts(tenantId: string, input: GenerateLunchBreaksRequest) {
        const where: any = { tenantId, deletedAt: null };
        if (input.scheduleId) where.scheduleId = input.scheduleId;
        if (input.locationId) where.locationId = input.locationId;
        if (input.shiftIds?.length) where.id = { in: input.shiftIds };
        return this.prisma.shift.findMany({
            where,
            orderBy: { startTime: 'asc' },
            include: {
                user: { select: { id: true, name: true } },
            },
        });
    }

    private buildBreakSchedule(shifts: LunchBreakShiftInput[], policy: LunchBreakPolicy): GeneratedShiftBreaks[] {
        if (!shifts.length) return [];
        return shifts.map((shift) => {
            const start = this.toDateOrThrow(shift.startTime, 'Invalid shift startTime');
            const end = this.toDateOrThrow(shift.endTime, 'Invalid shift endTime');
            let startMs = start.getTime();
            let endMs = end.getTime();
            if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;

            const stepMs = Math.max(1, policy.timeStepMinutes) * 60 * 1000;
            const lunchDuration = this.clampInt(shift.lunchDurationMinutes, policy.lunchDurationMinutes, 15, 120);
            const break1Duration = policy.break1DurationMinutes;
            const break2Duration = policy.break2DurationMinutes;

            const minBreak1 = startMs + 30 * 60 * 1000;
            const maxBreak1 = endMs - (break1Duration + lunchDuration + break2Duration + 30) * 60 * 1000;
            const break1 = this.roundToStep(this.clampMs(startMs + policy.break1OffsetMinutes * 60000, minBreak1, Math.max(minBreak1, maxBreak1)), stepMs);

            const minLunch = break1 + break1Duration * 60000 + 30 * 60 * 1000;
            const maxLunch = endMs - (lunchDuration + break2Duration + 15) * 60 * 1000;
            const lunch = this.roundToStep(this.clampMs(startMs + policy.lunchOffsetMinutes * 60000, minLunch, Math.max(minLunch, maxLunch)), stepMs);

            const minBreak2 = lunch + lunchDuration * 60000 + 15 * 60 * 1000;
            const maxBreak2 = endMs - break2Duration * 60000;
            const break2 = this.roundToStep(this.clampMs(lunch + (lunchDuration + policy.break2OffsetMinutes) * 60000, minBreak2, Math.max(minBreak2, maxBreak2)), stepMs);

            return {
                shiftId: shift.id ?? null,
                userId: shift.userId ?? null,
                employeeName: shift.employeeName ?? 'Unassigned',
                startTime: new Date(startMs).toISOString(),
                endTime: new Date(endMs).toISOString(),
                breaks: [
                    {
                        type: 'break1' as const,
                        startTime: new Date(break1).toISOString(),
                        endTime: new Date(break1 + break1Duration * 60000).toISOString(),
                        durationMinutes: break1Duration,
                        paid: true,
                    },
                    {
                        type: 'lunch' as const,
                        startTime: new Date(lunch).toISOString(),
                        endTime: new Date(lunch + lunchDuration * 60000).toISOString(),
                        durationMinutes: lunchDuration,
                        paid: false,
                    },
                    {
                        type: 'break2' as const,
                        startTime: new Date(break2).toISOString(),
                        endTime: new Date(break2 + break2Duration * 60000).toISOString(),
                        durationMinutes: break2Duration,
                        paid: true,
                    },
                ],
            };
        });
    }

    private async persistGeneratedBreaks(tenantId: string, generated: GeneratedShiftBreaks[]): Promise<void> {
        const shiftIds = generated.map((item) => item.shiftId).filter((id): id is string => Boolean(id));
        if (shiftIds.length !== generated.length) {
            throw new BadRequestException('Cannot persist generated breaks without shift IDs.');
        }
        const payload = generated.flatMap((item) =>
            item.breaks.map((entry) => ({
                shiftId: item.shiftId as string,
                startTime: new Date(entry.startTime),
                endTime: new Date(entry.endTime),
                paid: entry.paid,
            })),
        );

        await this.prisma.$transaction(async (tx) => {
            const shiftCount = await tx.shift.count({
                where: { tenantId, deletedAt: null, id: { in: shiftIds } },
            });
            if (shiftCount !== shiftIds.length) {
                throw new BadRequestException('One or more shifts were not found for this tenant.');
            }
            await tx.break.deleteMany({ where: { shiftId: { in: shiftIds } } });
            if (payload.length > 0) {
                await tx.break.createMany({ data: payload });
            }
        });
    }

    private mapShiftToGenerated(shift: any): GeneratedShiftBreaks {
        const ordered = Array.isArray(shift.breaks) ? [...shift.breaks].sort((a, b) => a.startTime.getTime() - b.startTime.getTime()) : [];
        const paid = ordered.filter((b) => b.paid);
        const unpaid = ordered.filter((b) => !b.paid);
        const byType: Record<BreakType, any | null> = {
            break1: paid[0] ?? ordered[0] ?? null,
            lunch: unpaid[0] ?? ordered[Math.floor(ordered.length / 2)] ?? null,
            break2: paid[1] ?? ordered[ordered.length - 1] ?? null,
        };

        const usedIds = new Set<string>();
        const typed: GeneratedBreak[] = [];
        for (const type of ['break1', 'lunch', 'break2'] as BreakType[]) {
            const candidate = byType[type];
            if (!candidate || usedIds.has(candidate.id)) continue;
            usedIds.add(candidate.id);
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

    private toDateOrThrow(value: string, message: string): Date {
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime())) {
            throw new BadRequestException(message);
        }
        return parsed;
    }

    private clampInt(value: unknown, fallback: number, min: number, max: number): number {
        const parsed = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, Math.round(parsed)));
    }

    private clampMs(value: number, min: number, max: number): number {
        return Math.min(max, Math.max(min, value));
    }

    private roundToStep(valueMs: number, stepMs: number): number {
        return Math.round(valueMs / stepMs) * stepMs;
    }
}

