import { Injectable, BadRequestException, ConflictException, ForbiddenException, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '@lunchlineup/db';
import { createHash } from 'crypto';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { PlanTier, PLAN_CONFIG } from './plans.config';
import { resolveTenantPlanDefinition } from './plan-definitions';
import { StripeMeterEventsService } from './stripe-meter-events.service';

const ACTIVE_STAFF_METRIC = 'ACTIVE_STAFF';
const STRIPE_METER_EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_STRIPE_USAGE_ATTEMPTS = 5;

export type BillableFeatureSource = 'plan' | 'stripe' | 'credits' | 'manual' | 'disabled';

@Injectable()
export class MeteringService {
    private readonly logger = new Logger(MeteringService.name);
    private readonly prisma: any;
    private readonly tenantDb: TenantPrismaService;
    private readonly stripeMeterEvents?: Pick<StripeMeterEventsService, 'createMeterEvent'>;

    constructor(
        @Optional() tenantDb?: TenantPrismaService,
        @Optional() stripeMeterEvents?: StripeMeterEventsService,
    ) {
        this.prisma = tenantDb?.client ?? new PrismaClient();
        this.tenantDb = tenantDb ?? new TenantPrismaService(this.prisma);
        this.stripeMeterEvents = stripeMeterEvents;
    }

    /**
     * Grants usage credits to a tenant and records a ledger transaction.
     */
    async grantCredits(tenantId: string, amount: number, reason: string, idempotencyKey?: string) {
        if (amount <= 0) throw new BadRequestException('Amount must be strictly positive');

        // Keep the separate legacy billing route compatible until it adopts a caller key.
        if (idempotencyKey === undefined) {
            return this.tenantDb.withTenant(tenantId, async (tx: any) => {
                const tenant = await tx.tenant.update({
                    where: { id: tenantId },
                    data: { usageCredits: { increment: amount } }
                });

                await tx.creditTransaction.create({
                    data: { tenantId, amount, reason }
                });

                return tenant.usageCredits;
            });
        }

        const normalizedKey = this.normalizeCreditGrantIdempotencyKey(idempotencyKey);
        const transactionId = `admin-credit-grant-${createHash('sha256').update(normalizedKey, 'utf8').digest('hex')}`;

        try {
            return await this.tenantDb.withTenant(tenantId, async (tx: any) => {
                const existing = await tx.creditTransaction.findUnique({ where: { id: transactionId } });
                if (existing) {
                    return this.replayCreditGrant(tx, existing, tenantId, amount, reason);
                }

                // Reserve the unique ledger id first so a racing duplicate cannot increment.
                await tx.creditTransaction.create({
                    data: { id: transactionId, tenantId, amount, reason }
                });

                const tenant = await tx.tenant.update({
                    where: { id: tenantId },
                    data: { usageCredits: { increment: amount } }
                });

                return tenant.usageCredits;
            });
        } catch (error) {
            if (!this.isUniqueConstraintError(error)) throw error;

            return this.tenantDb.withTenant(tenantId, async (tx: any) => {
                const existing = await tx.creditTransaction.findUnique({ where: { id: transactionId } });
                if (!existing) {
                    throw new ConflictException('Idempotency-Key was already used for another credit grant.');
                }
                return this.replayCreditGrant(tx, existing, tenantId, amount, reason);
            });
        }
    }

    private async replayCreditGrant(
        tx: any,
        existing: { tenantId: string; amount: number; reason: string },
        tenantId: string,
        amount: number,
        reason: string,
    ): Promise<number> {
        if (existing.tenantId !== tenantId || existing.amount !== amount || existing.reason !== reason) {
            throw new ConflictException('Idempotency-Key was already used with a different credit grant request.');
        }

        const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { usageCredits: true },
        });
        return tenant.usageCredits;
    }

    private normalizeCreditGrantIdempotencyKey(value: string): string {
        if (!value.trim()) {
            throw new BadRequestException('Idempotency-Key is required for idempotent credit grants.');
        }
        const key = value.trim();
        if (key.length > 255 || /[\u0000-\u001f\u007f]/.test(key)) {
            throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
        }
        return key;
    }

    private isUniqueConstraintError(error: unknown): boolean {
        return typeof error === 'object'
            && error !== null
            && 'code' in error
            && (error as { code?: unknown }).code === 'P2002';
    }

    /**
     * Deducts usage credits securely.
     * Throws an error if insufficient credits.
     */
    async consumeCredits(tenantId: string, amount: number, reason: string) {
        if (amount <= 0) throw new BadRequestException('Amount must be strictly positive');

        return this.tenantDb.withTenant(tenantId, async (tx: any) => {
            const debit = await tx.tenant.updateMany({
                where: {
                    id: tenantId,
                    usageCredits: { gte: amount },
                },
                data: { usageCredits: { decrement: amount } },
            });

            if (debit.count !== 1) {
                throw new ForbiddenException('Insufficient usage credits balance.');
            }

            const updated = await tx.tenant.findUniqueOrThrow({
                where: { id: tenantId },
                select: { usageCredits: true },
            });

            await tx.creditTransaction.create({
                data: { tenantId, amount: -amount, reason }
            });

            return updated.usageCredits;
        });
    }

    /**
     * Records included usage for paid monthly plans without decrementing wallet credits.
     * Keeps credit-balance semantics intact while preserving usage telemetry.
     */
    async trackIncludedUsage(tenantId: string, amount: number, reason: string) {
        if (amount <= 0) throw new BadRequestException('Amount must be strictly positive');

        return this.tenantDb.withTenant(tenantId, async (tx: any) => {
            const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });

            await tx.creditTransaction.create({
                data: {
                    tenantId,
                    amount: 0,
                    reason: `Included usage (${amount} credit): ${reason}`,
                },
            });

            return tenant.usageCredits;
        });
    }

    async recordFeatureUsageInTransaction(
        tx: TenantPrismaTransaction,
        args: {
            tenantId: string;
            source: BillableFeatureSource;
            cost: number;
            reason: string;
            operationId: string;
        },
    ): Promise<{ consumedCredits: number; newBalance: number | null }> {
        if (!Number.isInteger(args.cost) || args.cost < 0) {
            throw new BadRequestException('Feature credit cost must be a non-negative whole number');
        }
        if (args.cost === 0) {
            const tenant = await tx.tenant.findUniqueOrThrow({
                where: { id: args.tenantId },
                select: { usageCredits: true },
            });
            return { consumedCredits: 0, newBalance: tenant.usageCredits };
        }

        const ledgerId = `feature-usage-${args.operationId}`;
        if (args.source === 'credits' || args.source === 'plan' || args.source === 'stripe' || args.source === 'manual') {
            await tx.creditTransaction.create({
                data: {
                    id: ledgerId,
                    tenantId: args.tenantId,
                    amount: -args.cost,
                    reason: args.reason,
                },
            });
            const debit = await tx.tenant.updateMany({
                where: {
                    id: args.tenantId,
                    usageCredits: { gte: args.cost },
                },
                data: { usageCredits: { decrement: args.cost } },
            });
            if (debit.count !== 1) {
                throw new ForbiddenException('Insufficient usage credits balance.');
            }
            const tenant = await tx.tenant.findUniqueOrThrow({
                where: { id: args.tenantId },
                select: { usageCredits: true },
            });
            return { consumedCredits: args.cost, newBalance: tenant.usageCredits };
        }

        throw new ForbiddenException('Feature is not enabled for billable usage.');
    }

    async checkLimits(tenantId: string, tier: string) {
        const [locationCount, userCount] = await this.tenantDb.withTenant(tenantId, (tx: any) => Promise.all([
            tx.location.count({ where: { tenantId } }),
            tx.user.count({ where: { tenantId } }),
        ]));

        if (isLegacyPlanTier(tier)) {
            const limits = PLAN_CONFIG[tier];
            if (locationCount >= limits.maxLocations) {
                throw new Error(`Location limit reached for ${tier} plan.`);
            }
            if (userCount >= limits.maxStaffPerLocation) {
                throw new Error(`User limit reached for ${tier} plan.`);
            }

            return true;
        }

        const plan = await resolveTenantPlanDefinition(this.prisma, tier);
        if (!plan) {
            throw new ServiceUnavailableException(`Plan ${tier} is not configured`);
        }

        if (plan.locationLimit !== null && locationCount >= plan.locationLimit) {
            throw new Error(`Location limit reached for ${plan.code} plan.`);
        }

        if (plan.userLimit !== null && userCount >= plan.userLimit) {
            throw new Error(`User limit reached for ${plan.code} plan.`);
        }

        return true;
    }

    async reportUsageToStripe(tenantId: string, _legacyStripeSubscriptionItemId?: string) {
        const normalizedTenantId = this.requireNonEmpty(tenantId, 'tenantId');
        this.assertStripeMeteringEnabled();
        const eventName = this.resolveMeterEventName();
        const window = this.currentUtcDayWindow();

        const prepared = await this.tenantDb.withTenant(normalizedTenantId, async (tx: any) => {
            const tenant = await tx.tenant.findUnique({
                where: { id: normalizedTenantId },
                select: { id: true, stripeCustomerId: true },
            });
            if (!tenant) {
                throw new BadRequestException('Tenant not found');
            }
            if (!tenant.stripeCustomerId?.trim()) {
                throw new ServiceUnavailableException('Tenant is not connected to a Stripe customer');
            }

            const quantity = await tx.user.count({
                where: {
                    tenantId: normalizedTenantId,
                    deletedAt: null,
                },
            });
            const identity = this.buildUsageIdentity(normalizedTenantId, ACTIVE_STAFF_METRIC, window.periodStart);
            const existing = await tx.stripeUsageEvent.findUnique({
                where: {
                    tenantId_metric_periodStart_periodEnd: {
                        tenantId: normalizedTenantId,
                        metric: ACTIVE_STAFF_METRIC,
                        periodStart: window.periodStart,
                        periodEnd: window.periodEnd,
                    },
                },
            });

            if (existing?.status === 'SENT') {
                return existing;
            }

            const data = {
                tenantId: normalizedTenantId,
                metric: ACTIVE_STAFF_METRIC,
                periodStart: window.periodStart,
                periodEnd: window.periodEnd,
                quantity,
                eventName,
                stripeCustomerId: tenant.stripeCustomerId.trim(),
                identifier: identity.identifier,
                idempotencyKey: identity.idempotencyKey,
                status: 'PENDING',
                nextAttemptAt: new Date(),
                lastError: null,
                metadata: {
                    source: 'metering.reportUsageToStripe',
                    aggregation: 'active_staff_daily_snapshot',
                },
            };

            if (existing) {
                return tx.stripeUsageEvent.update({
                    where: { id: existing.id },
                    data: {
                        quantity: data.quantity,
                        eventName: data.eventName,
                        stripeCustomerId: data.stripeCustomerId,
                        status: data.status,
                        nextAttemptAt: data.nextAttemptAt,
                        lastError: data.lastError,
                        metadata: {
                            ...(existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
                                ? existing.metadata
                                : {}),
                            ...data.metadata,
                        },
                    },
                });
            }

            return tx.stripeUsageEvent.create({ data });
        });

        if (prepared.status === 'SENT') {
            return this.serializeUsageEvent(prepared);
        }

        return this.sendPersistedUsageEvent(normalizedTenantId, prepared.id);
    }

    private async sendPersistedUsageEvent(tenantId: string, usageEventId: string) {
        const submittedAt = new Date();
        const claimed: any = await this.tenantDb.withTenant(tenantId, (tx: any) => tx.stripeUsageEvent.update({
            where: { id: usageEventId },
            data: {
                status: 'SENDING',
                attempts: { increment: 1 },
                submittedAt,
                lastError: null,
            },
        }));

        try {
            const result = await this.getStripeMeterEvents().createMeterEvent({
                eventName: claimed.eventName,
                stripeCustomerId: claimed.stripeCustomerId,
                value: claimed.quantity,
                identifier: claimed.identifier,
                timestamp: claimed.periodStart,
                idempotencyKey: claimed.idempotencyKey,
            });

            const sent = await this.tenantDb.withTenant(tenantId, (tx: any) => tx.stripeUsageEvent.update({
                where: { id: claimed.id },
                data: {
                    status: 'SENT',
                    sentAt: new Date(),
                    stripeObjectId: result.id,
                    stripeRequestId: result.requestId,
                    lastError: null,
                },
            }));

            return this.serializeUsageEvent(sent);
        } catch (err) {
            const status = claimed.attempts >= MAX_STRIPE_USAGE_ATTEMPTS ? 'DEAD_LETTERED' : 'FAILED';
            const nextAttemptAt = this.nextStripeUsageAttemptAt(claimed.attempts);
            const message = (err as Error).message || 'Stripe metered usage request failed';
            await this.tenantDb.withTenant(tenantId, (tx: any) => tx.stripeUsageEvent.update({
                where: { id: claimed.id },
                data: {
                    status,
                    nextAttemptAt,
                    lastError: message.slice(0, 1000),
                },
            }));
            this.logger.warn(`Stripe metered usage event ${claimed.id} failed: ${message}`);
            throw new ServiceUnavailableException('Stripe metered usage reporting failed');
        }
    }

    private getStripeMeterEvents(): Pick<StripeMeterEventsService, 'createMeterEvent'> {
        if (!this.stripeMeterEvents) {
            throw new ServiceUnavailableException('Stripe metered usage client is not configured');
        }
        return this.stripeMeterEvents;
    }

    private assertStripeMeteringEnabled(): void {
        if (String(process.env.STRIPE_METERED_USAGE_ENABLED ?? '').toLowerCase() !== 'true') {
            throw new ServiceUnavailableException('Stripe metered usage reporting is disabled');
        }
    }

    private resolveMeterEventName(): string {
        const eventName = process.env.STRIPE_METER_EVENT_NAME?.trim();
        if (!eventName || !STRIPE_METER_EVENT_NAME_RE.test(eventName)) {
            throw new ServiceUnavailableException('STRIPE_METER_EVENT_NAME is not configured');
        }
        return eventName;
    }

    private requireNonEmpty(value: string, field: string): string {
        if (typeof value !== 'string' || !value.trim()) {
            throw new BadRequestException(`${field} is required`);
        }
        return value.trim();
    }

    private currentUtcDayWindow(now = new Date()) {
        const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);
        return { periodStart, periodEnd };
    }

    private buildUsageIdentity(tenantId: string, metric: string, periodStart: Date) {
        const day = periodStart.toISOString().slice(0, 10).replace(/-/g, '');
        const digest = createHash('sha256')
            .update(`${tenantId}:${metric}:${day}`)
            .digest('hex')
            .slice(0, 24);
        const identifier = `ll_${metric.toLowerCase()}_${day}_${digest}`;
        return {
            identifier,
            idempotencyKey: `stripe_usage_${identifier}`,
        };
    }

    private nextStripeUsageAttemptAt(attempts: number): Date {
        const delayMinutes = Math.min(60, Math.max(1, 2 ** Math.min(attempts, 6)));
        return new Date(Date.now() + delayMinutes * 60 * 1000);
    }

    private serializeUsageEvent(event: any) {
        return {
            id: event.id,
            tenantId: event.tenantId,
            metric: event.metric,
            periodStart: event.periodStart,
            periodEnd: event.periodEnd,
            quantity: event.quantity,
            status: event.status,
            attempts: event.attempts,
            identifier: event.identifier,
            stripeObjectId: event.stripeObjectId ?? null,
            stripeRequestId: event.stripeRequestId ?? null,
            sentAt: event.sentAt ?? null,
        };
    }
}

function isLegacyPlanTier(value: string): value is PlanTier {
    return value in PLAN_CONFIG;
}
