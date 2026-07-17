import { Injectable, BadRequestException, ConflictException, ForbiddenException, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '@lunchlineup/db';
import { createHash } from 'crypto';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { PlanTier, PLAN_CONFIG } from './plans.config';
import { resolveTenantPlanDefinition } from './plan-definitions';
import { StripeMeterEventsService } from './stripe-meter-events.service';
import { stripeErrorLog } from './stripe-error-diagnostic';

const ACTIVE_STAFF_METRIC = 'ACTIVE_STAFF';
const STRIPE_METER_EVENT_NAME_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_STRIPE_USAGE_ATTEMPTS = 5;
const STRIPE_USAGE_SEND_LEASE_MS = 2 * 60_000;

export type BillableFeatureSource = 'plan' | 'stripe' | 'credits' | 'manual' | 'disabled';

export type CreditGrantSettlement = {
    transactionId: string;
    newBalance: number;
    replayed: boolean;
};

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
    async grantCreditsInTransaction(
        tx: TenantPrismaTransaction,
        args: { tenantId: string; amount: number; reason: string; idempotencyKey: string },
    ): Promise<CreditGrantSettlement> {
        const { tenantId, amount, reason, idempotencyKey } = args;
        const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
        const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
        if (!normalizedTenantId) throw new BadRequestException('tenantId is required');
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw new BadRequestException('Amount must be a positive whole number');
        }
        if (!normalizedReason || normalizedReason.length > 500) {
            throw new BadRequestException('Reason must be between 1 and 500 characters');
        }

        const normalizedKey = this.normalizeCreditGrantIdempotencyKey(idempotencyKey);
        const transactionId = `admin-credit-grant-${createHash('sha256')
            .update(`${normalizedTenantId}:${normalizedKey}`, 'utf8')
            .digest('hex')}`;

        await this.lockCreditSettlementTables(tx);
        await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${normalizedTenantId} FOR UPDATE`;
        const existing = await tx.creditTransaction.findUnique({
            where: { id: transactionId },
            select: {
                id: true,
                tenantId: true,
                amount: true,
                debtAmount: true,
                reason: true,
                balanceAfter: true,
                debtAfter: true,
            },
        });
        if (existing) {
            return this.replayCreditGrant(
                existing,
                normalizedTenantId,
                amount,
                normalizedReason,
                transactionId,
            );
        }

        const current = await tx.tenant.findUniqueOrThrow({
            where: { id: normalizedTenantId },
            select: { usageCredits: true, creditDebt: true },
        });
        const repaidDebt = Math.min(current.creditDebt, amount);
        const spendableAmount = amount - repaidDebt;
        const tenant = await tx.tenant.update({
            where: { id: normalizedTenantId },
            data: {
                usageCredits: { increment: spendableAmount },
                creditDebt: { decrement: repaidDebt },
            },
            select: { usageCredits: true, creditDebt: true },
        });
        const newBalance = this.requireStoredBalanceAfter(
            tenant.usageCredits,
            'Credit grant settlement produced an invalid wallet balance.',
        );
        const debtAfter = this.requireStoredDebtAfter(
            tenant.creditDebt,
            'Credit grant settlement produced an invalid debt balance.',
        );

        await tx.creditTransaction.create({
            data: {
                id: transactionId,
                tenantId: normalizedTenantId,
                amount: spendableAmount,
                debtAmount: -repaidDebt,
                reason: normalizedReason,
                balanceAfter: newBalance,
                debtAfter,
            },
            select: { id: true },
        });

        return { transactionId, newBalance, replayed: false };
    }

    private replayCreditGrant(
        existing: {
            tenantId: string;
            amount: number;
            debtAmount: number;
            reason: string;
            balanceAfter: number | null;
            debtAfter: number | null;
        },
        tenantId: string,
        amount: number,
        reason: string,
        transactionId: string,
    ): CreditGrantSettlement {
        if (
            existing.tenantId !== tenantId
            || existing.amount - existing.debtAmount !== amount
            || existing.debtAmount > 0
            || existing.reason !== reason
        ) {
            throw new ConflictException('Idempotency-Key was already used with a different credit grant request.');
        }
        this.requireStoredDebtAfter(
            existing.debtAfter,
            'Existing credit grant is missing its immutable debt balance.',
        );

        return {
            transactionId,
            newBalance: this.requireStoredBalanceAfter(
                existing.balanceAfter,
                'Existing credit grant is missing its immutable settlement balance.',
            ),
            replayed: true,
        };
    }

    private normalizeCreditGrantIdempotencyKey(value: unknown): string {
        if (typeof value !== 'string' || !value.trim()) {
            throw new BadRequestException('Idempotency-Key is required for idempotent credit grants.');
        }
        const key = value.trim();
        if (key.length > 255 || /[\u0000-\u001f\u007f]/.test(key)) {
            throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
        }
        return key;
    }

    private requireStoredBalanceAfter(value: unknown, message: string): number {
        if (!Number.isSafeInteger(value) || Number(value) < 0) {
            throw new ConflictException(message);
        }
        return Number(value);
    }

    private requireStoredDebtAfter(value: unknown, message: string): number {
        if (!Number.isSafeInteger(value) || Number(value) < 0) {
            throw new ConflictException(message);
        }
        return Number(value);
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
        if (args.source !== 'credits') {
            throw new ForbiddenException('Billable feature usage requires wallet credits.');
        }
        if (!Number.isSafeInteger(args.cost) || args.cost <= 0) {
            throw new BadRequestException('Feature credit cost must be a positive whole number');
        }

        const ledgerId = `feature-usage-${args.operationId}`;
        await this.lockCreditSettlementTables(tx);
        await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${args.tenantId} FOR UPDATE`;
        const existing = await tx.creditTransaction.findUnique({
            where: { id: ledgerId },
            select: {
                id: true,
                tenantId: true,
                amount: true,
                debtAmount: true,
                reason: true,
                balanceAfter: true,
                debtAfter: true,
            },
        });
        if (existing) {
            if (
                existing.tenantId !== args.tenantId
                || existing.amount !== -args.cost
                || existing.debtAmount !== 0
                || existing.reason !== args.reason
            ) {
                throw new ConflictException('Feature usage operation was already recorded with different billing details.');
            }
            return {
                consumedCredits: args.cost,
                newBalance: this.requireStoredBalanceAfter(
                    existing.balanceAfter,
                    'Existing feature usage is missing its immutable settlement balance.',
                ),
            };
        }

        const debit = await tx.tenant.updateMany({
            where: {
                id: args.tenantId,
                creditDebt: 0,
                usageCredits: { gte: args.cost },
            },
            data: { usageCredits: { decrement: args.cost } },
        });
        if (debit.count !== 1) {
            throw new ForbiddenException('Insufficient usage credits balance.');
        }
        const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: args.tenantId },
            select: { usageCredits: true, creditDebt: true },
        });
        const newBalance = this.requireStoredBalanceAfter(
            tenant.usageCredits,
            'Feature usage settlement produced an invalid wallet balance.',
        );
        const debtAfter = this.requireStoredDebtAfter(
            tenant.creditDebt,
            'Feature usage settlement produced an invalid debt balance.',
        );
        await tx.creditTransaction.create({
            data: {
                id: ledgerId,
                tenantId: args.tenantId,
                amount: -args.cost,
                debtAmount: 0,
                reason: args.reason,
                balanceAfter: newBalance,
                debtAfter,
            },
        });
        return { consumedCredits: args.cost, newBalance };
    }

    private async lockCreditSettlementTables(tx: TenantPrismaTransaction): Promise<void> {
        await tx.$executeRaw`
            LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE
        `;
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

            return tx.stripeUsageEvent.upsert({
                where: {
                    tenantId_metric_periodStart_periodEnd: {
                        tenantId: normalizedTenantId,
                        metric: ACTIVE_STAFF_METRIC,
                        periodStart: window.periodStart,
                        periodEnd: window.periodEnd,
                    },
                },
                create: data,
                update: {},
            });
        });

        if (prepared.status === 'SENT') {
            return this.serializeUsageEvent(prepared);
        }

        return this.sendPersistedUsageEvent(normalizedTenantId, prepared.id);
    }

    private async sendPersistedUsageEvent(tenantId: string, usageEventId: string) {
        const submittedAt = new Date();
        const staleLeaseBefore = new Date(submittedAt.getTime() - STRIPE_USAGE_SEND_LEASE_MS);
        const leaseExpiresAt = new Date(submittedAt.getTime() + STRIPE_USAGE_SEND_LEASE_MS);
        const claim = await this.tenantDb.withTenant<{ count: number }>(tenantId, (tx: any) => tx.stripeUsageEvent.updateMany({
            where: {
                id: usageEventId,
                tenantId,
                OR: [
                    {
                        status: 'PENDING',
                        nextAttemptAt: { lte: submittedAt },
                    },
                    {
                        status: 'FAILED',
                        attempts: { lt: MAX_STRIPE_USAGE_ATTEMPTS },
                        nextAttemptAt: { lte: submittedAt },
                    },
                    {
                        status: 'SENDING',
                        submittedAt: { lte: staleLeaseBefore },
                    },
                ],
            },
            data: {
                status: 'SENDING',
                attempts: { increment: 1 },
                submittedAt,
                nextAttemptAt: leaseExpiresAt,
                lastError: null,
            },
        }));

        if (claim.count !== 1) {
            const observed = await this.findUsageEvent(tenantId, usageEventId);
            return this.serializeUsageEvent(observed);
        }

        const claimed: any = await this.findUsageEvent(tenantId, usageEventId);
        if (
            claimed.status !== 'SENDING'
            || !(claimed.submittedAt instanceof Date)
            || claimed.submittedAt.getTime() !== submittedAt.getTime()
        ) {
            throw new ServiceUnavailableException('Stripe metered usage send lease was lost');
        }

        let result: { id: string | null; requestId: string | null };
        try {
            result = await this.getStripeMeterEvents().createMeterEvent({
                eventName: claimed.eventName,
                stripeCustomerId: claimed.stripeCustomerId,
                value: claimed.quantity,
                identifier: claimed.identifier,
                timestamp: claimed.periodStart,
                idempotencyKey: claimed.idempotencyKey,
            });
        } catch (err) {
            const status = claimed.attempts >= MAX_STRIPE_USAGE_ATTEMPTS ? 'DEAD_LETTERED' : 'FAILED';
            const nextAttemptAt = this.nextStripeUsageAttemptAt(claimed.attempts);
            const diagnostic = stripeErrorLog('billing.meter_usage_send_failed', err);
            const failedTransition = await this.tenantDb.withTenant<{ count: number }>(tenantId, (tx: any) => tx.stripeUsageEvent.updateMany({
                where: {
                    id: claimed.id,
                    tenantId,
                    status: 'SENDING',
                    submittedAt,
                    identifier: claimed.identifier,
                    idempotencyKey: claimed.idempotencyKey,
                },
                data: {
                    status,
                    nextAttemptAt,
                    lastError: diagnostic,
                },
            }));
            if (failedTransition.count !== 1) {
                const observed = await this.findUsageEvent(tenantId, claimed.id);
                if (observed.status === 'SENT') {
                    return this.serializeUsageEvent(observed);
                }
            }
            this.logger.warn(diagnostic);
            throw new ServiceUnavailableException('Stripe metered usage reporting failed');
        }

        const sentTransition = await this.tenantDb.withTenant<{ count: number }>(tenantId, (tx: any) => tx.stripeUsageEvent.updateMany({
            where: {
                id: claimed.id,
                tenantId,
                status: 'SENDING',
                submittedAt,
                identifier: claimed.identifier,
                idempotencyKey: claimed.idempotencyKey,
            },
            data: {
                status: 'SENT',
                sentAt: new Date(),
                stripeObjectId: result.id,
                stripeRequestId: result.requestId,
                lastError: null,
            },
        }));
        const observed = await this.findUsageEvent(tenantId, claimed.id);
        if (sentTransition.count !== 1 && observed.status !== 'SENT') {
            throw new ServiceUnavailableException('Stripe metered usage send lease was lost');
        }
        return this.serializeUsageEvent(observed);
    }

    private async findUsageEvent(tenantId: string, usageEventId: string): Promise<any> {
        const usageEvent = await this.tenantDb.withTenant(tenantId, (tx: any) => tx.stripeUsageEvent.findUnique({
            where: { id: usageEventId },
        }));
        if (!usageEvent) {
            throw new ServiceUnavailableException('Stripe metered usage event was not found');
        }
        return usageEvent;
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
