import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { FEATURE_CREDIT_COST } from '../billing/plan-definitions';
import { runtimeErrorText } from '../common/runtime-error-diagnostic';
import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { WebhookDeliveryCrypto } from './webhook-delivery.crypto';

const MAX_LAST_ERROR_LENGTH = 1000;
const TERMINAL_DELIVERY_ERASURE = {
    encryptedUrl: '',
    encryptedPayload: '',
    encryptionKeyRef: 'erased-v1',
} as const;
const REPLAYABLE_DELIVERY_STATUSES: WebhookDeliveryStatus[] = ['PENDING', 'QUEUED', 'FAILED'];
const MAX_REPLAY_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_REPLAY_LEASE_MS = 60_000;
const MIN_REPLAY_LEASE_MS = 10_000;
const MAX_REPLAY_LEASE_MS = 5 * 60_000;
const DEFAULT_PENDING_CLAIM_LEASE_MS = 60_000;
const MIN_PENDING_CLAIM_LEASE_MS = 10_000;
const MAX_PENDING_CLAIM_LEASE_MS = 5 * 60_000;
const MAX_PENDING_CLAIM_BATCH_SIZE = 500;
const DEFAULT_CONFIRMED_QUEUE_RECOVERY_AGE_MS = 10 * 60_000;
const MIN_CONFIRMED_QUEUE_RECOVERY_AGE_MS = 60_000;
const MAX_CONFIRMED_QUEUE_RECOVERY_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_INITIAL_DELIVERY_LEASE_MS = 60_000;
const MIN_INITIAL_DELIVERY_LEASE_MS = 10_000;
const MAX_INITIAL_DELIVERY_LEASE_MS = 5 * 60_000;
const WEBHOOK_CREDIT_COST = FEATURE_CREDIT_COST.webhooks;
function deliveryEligibleTenantWhere(now = new Date()) {
    return {
        deletedAt: null,
        status: 'ACTIVE',
        planTier: { not: 'FREE' },
        stripeSubscriptionId: { not: null },
        NOT: { stripeSubscriptionId: '' },
        stripeSubscriptionCurrentPeriodEnd: { gt: now },
    };
}

export type WebhookDeliveryStatus =
    | 'PENDING'
    | 'QUEUED'
    | 'SENDING'
    | 'DELIVERED'
    | 'FAILED'
    | 'DEAD_LETTERED';

export type PersistWebhookDeliveryInput = {
    tenantId: string;
    endpointId: string;
    url: string;
    body: string;
    eventType?: string;
    failureReason?: unknown;
};

export type PersistedWebhookDelivery = {
    id: string;
    tenantId: string;
    endpointRef: string;
    payloadDigest: string;
    payloadBytes: number;
    eventType: string | null;
};

export type WebhookReplayEnvelope = {
    id: string;
    tenantId: string;
    url: string;
    body: string;
    eventType: string | null;
};

export type WorkerWebhookReplayEnvelope = WebhookReplayEnvelope & {
    endpointId: string | null;
    secret: string | null;
    attempts: number;
};

export type WebhookReplayClaim =
    | { status: 'claimed'; delivery: WorkerWebhookReplayEnvelope }
    | { status: 'deferred'; tenantId: string; attempts: number; retryAfterMs: number }
    | { status: 'not_found' };

export type WebhookDeliverySendAuthority = 'eligible' | 'paused' | 'terminal' | 'not_found';

export type WebhookDeliveryAttemptState = {
    attempts: number;
};

export type WebhookDeliveryReplayState = WebhookDeliveryAttemptState & {
    status: WebhookDeliveryStatus;
};

export type RecoverableWebhookDelivery = {
    id: string;
    tenantId: string;
    status: Extract<WebhookDeliveryStatus, 'PENDING' | 'QUEUED' | 'FAILED'>;
    attempts: number;
};

@Injectable()
export class WebhookDeliveryStore {
    private readonly tenantDb: TenantPrismaService;
    private readonly deliveryCrypto: WebhookDeliveryCrypto;

    constructor(
        private readonly configService: ConfigService,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
        this.deliveryCrypto = new WebhookDeliveryCrypto(configService);
    }

    async persistEvent(input: PersistWebhookDeliveryInput): Promise<PersistedWebhookDelivery> {
        return this.persist(input, 0, new Date(Date.now() + this.resolveInitialDeliveryLeaseMs()), null);
    }

    async persistRetry(input: PersistWebhookDeliveryInput): Promise<PersistedWebhookDelivery> {
        return this.persist(input, 1, new Date(), input.failureReason);
    }

    async persistOutboxEventInTransaction(
        tx: TenantPrismaTransaction,
        input: PersistWebhookDeliveryInput,
    ): Promise<PersistedWebhookDelivery> {
        return this.persistWithClient(tx, input, 0, new Date(), null);
    }

    async claimInitialDelivery(tenantId: string, deliveryId: string): Promise<boolean> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const now = new Date();
            if (!await this.hasExactPaidDeliveryAuthority(tx, deliveryId, tenantId)) return false;
            const claimed = await (tx as any).webhookDelivery.updateMany({
                where: {
                    id: deliveryId,
                    tenantId,
                    tenant: {
                        is: deliveryEligibleTenantWhere(now),
                    },
                    status: 'PENDING' satisfies WebhookDeliveryStatus,
                    attempts: 0,
                },
                data: {
                    status: 'SENDING' satisfies WebhookDeliveryStatus,
                    attempts: { increment: 1 },
                    nextAttemptAt: null,
                    lastError: null,
                    updatedAt: now,
                },
            });
            return claimed.count === 1;
        });
    }

    private async persist(
        input: PersistWebhookDeliveryInput,
        attempts: number,
        nextAttemptAt: Date,
        failureReason: unknown,
    ): Promise<PersistedWebhookDelivery> {
        return this.tenantDb.withTenant(input.tenantId, (tx) => this.persistWithClient(
            tx,
            input,
            attempts,
            nextAttemptAt,
            failureReason,
        ));
    }

    private async persistWithClient(
        tx: TenantPrismaTransaction,
        input: PersistWebhookDeliveryInput,
        attempts: number,
        nextAttemptAt: Date,
        failureReason: unknown,
    ): Promise<PersistedWebhookDelivery> {
        if (!input.endpointId?.trim()) {
            throw new ServiceUnavailableException('Webhook endpoint id is required for durable replay');
        }
        const id = crypto.randomUUID();
        const bodyBytes = Buffer.byteLength(input.body);
        const data = {
            id,
            tenantId: input.tenantId,
            endpointId: input.endpointId,
            status: 'PENDING' satisfies WebhookDeliveryStatus,
            eventType: input.eventType ?? null,
            endpointRef: this.digestRef(input.url),
            payloadDigest: this.digestRef(input.body, 64),
            payloadBytes: bodyBytes,
            encryptedUrl: this.deliveryCrypto.encryptString(input.url),
            encryptedPayload: this.deliveryCrypto.encryptString(input.body),
            encryptionKeyRef: this.deliveryCrypto.encryptionKeyRef(),
            attempts,
            nextAttemptAt,
            lastError: this.redactLastError(failureReason),
        };

        return (tx as any).webhookDelivery.create({
            data,
            select: {
                id: true,
                tenantId: true,
                endpointRef: true,
                payloadDigest: true,
                payloadBytes: true,
                eventType: true,
            },
        });
    }

    async markQueued(tenantId: string, deliveryId: string): Promise<void> {
        await this.tenantDb.withTenant(tenantId, async (tx) => {
            await (tx as any).webhookDelivery.updateMany({
                where: {
                    id: deliveryId,
                    tenantId,
                    status: { in: REPLAYABLE_DELIVERY_STATUSES },
                },
                data: {
                    status: 'QUEUED' satisfies WebhookDeliveryStatus,
                    queuedAt: new Date(),
                    nextAttemptAt: null,
                },
            });
        });
    }

    async claimRecoverableForQueue(limit: number): Promise<RecoverableWebhookDelivery[]> {
        const boundedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_PENDING_CLAIM_BATCH_SIZE));
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + this.resolvePendingClaimLeaseMs());
        const staleSendingBefore = new Date(now.getTime() - this.resolveReplayLeaseMs());
        const confirmedQueuedBefore = new Date(now.getTime() - this.resolveConfirmedQueueRecoveryAgeMs());

        return this.tenantDb.withPlatformAdmin(async (tx) => {
            return (tx as any).$queryRaw(Prisma.sql`
                WITH candidates AS (
                    SELECT delivery."id", delivery."status"
                    FROM "WebhookDelivery" AS delivery
                    INNER JOIN "Tenant" AS tenant ON tenant."id" = delivery."tenantId"
                    INNER JOIN "WebhookEndpoint" AS endpoint
                        ON endpoint."id" = delivery."endpointId"
                       AND endpoint."tenantId" = delivery."tenantId"
                    WHERE tenant."deletedAt" IS NULL
                      AND tenant."status" = 'ACTIVE'::"TenantStatus"
                      AND tenant."planTier" <> 'FREE'::"PlanTier"
                      AND NULLIF(BTRIM(tenant."stripeSubscriptionId"), '') IS NOT NULL
                      AND tenant."stripeSubscriptionCurrentPeriodEnd" > CURRENT_TIMESTAMP
                      AND EXISTS (
                          SELECT 1
                          FROM "CreditTransaction" AS credit
                          WHERE credit."id" = 'feature-usage-webhook-delivery:' || delivery."id"
                            AND credit."tenantId" = delivery."tenantId"
                            AND credit."amount" = ${-WEBHOOK_CREDIT_COST}
                            AND credit."reason" = 'Webhook delivery (' || delivery."id" || ')'
                            AND credit."balanceAfter" IS NOT NULL
                            AND credit."balanceAfter" >= 0
                      )
                      AND ((delivery."status" IN (
                            'PENDING'::"WebhookDeliveryStatus",
                            'QUEUED'::"WebhookDeliveryStatus",
                            'FAILED'::"WebhookDeliveryStatus"
                        )
                        AND delivery."nextAttemptAt" <= ${now}
                    ) OR (
                        delivery."status" = 'SENDING'::"WebhookDeliveryStatus"
                        AND delivery."updatedAt" <= ${staleSendingBefore}
                    ) OR (
                        delivery."status" = 'QUEUED'::"WebhookDeliveryStatus"
                        AND delivery."nextAttemptAt" IS NULL
                        AND delivery."queuedAt" <= ${confirmedQueuedBefore}
                    ))
                    ORDER BY COALESCE(delivery."nextAttemptAt", delivery."queuedAt", delivery."createdAt") ASC,
                        delivery."createdAt" ASC
                    FOR UPDATE OF delivery SKIP LOCKED
                    LIMIT ${boundedLimit}
                )
                UPDATE "WebhookDelivery" AS delivery
                SET "status" = CASE
                        WHEN candidates."status" = 'SENDING'::"WebhookDeliveryStatus"
                            THEN 'FAILED'::"WebhookDeliveryStatus"
                        ELSE delivery."status"
                    END,
                    "nextAttemptAt" = ${leaseUntil},
                    "updatedAt" = ${now}
                FROM candidates
                WHERE delivery."id" = candidates."id"
                RETURNING delivery."id", delivery."tenantId", delivery."status", delivery."attempts"
            `) as Promise<RecoverableWebhookDelivery[]>;
        });
    }

    async loadReplayEnvelope(tenantId: string, deliveryId: string): Promise<WebhookReplayEnvelope | null> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const row = await (tx as any).webhookDelivery.findFirst({
                where: {
                    id: deliveryId,
                    tenantId,
                    status: { in: REPLAYABLE_DELIVERY_STATUSES },
                },
                select: {
                    id: true,
                    tenantId: true,
                    eventType: true,
                    encryptedUrl: true,
                    encryptedPayload: true,
                },
            });

            if (!row) {
                return null;
            }

            return {
                id: row.id,
                tenantId: row.tenantId,
                url: this.deliveryCrypto.decryptString(row.encryptedUrl),
                body: this.deliveryCrypto.decryptString(row.encryptedPayload),
                eventType: row.eventType,
            };
        });
    }

    async claimReplayByDeliveryId(deliveryId: string, maxAttempts: number): Promise<WebhookReplayClaim> {
        const boundedMaxAttempts = Math.max(1, Math.floor(maxAttempts));
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const now = new Date();
            const leaseMs = this.resolveReplayLeaseMs();
            const staleBefore = new Date(now.getTime() - leaseMs);
            if (!await this.hasExactPaidDeliveryAuthority(tx, deliveryId)) {
                return { status: 'not_found' };
            }
            const claimed = await (tx as any).webhookDelivery.updateMany({
                where: {
                    id: deliveryId,
                    tenant: {
                        is: deliveryEligibleTenantWhere(now),
                    },
                    attempts: { lt: boundedMaxAttempts },
                    OR: [
                        {
                            status: 'QUEUED' satisfies WebhookDeliveryStatus,
                        },
                        {
                            status: { in: ['PENDING', 'FAILED'] satisfies WebhookDeliveryStatus[] },
                            nextAttemptAt: { lte: now },
                        },
                        {
                            status: 'SENDING' satisfies WebhookDeliveryStatus,
                            updatedAt: { lte: staleBefore },
                        },
                    ],
                },
                data: {
                    status: 'SENDING' satisfies WebhookDeliveryStatus,
                    attempts: { increment: 1 },
                    lastError: null,
                    updatedAt: now,
                },
            });

            if (claimed.count !== 1) {
                const current = await (tx as any).webhookDelivery.findFirst({
                    where: {
                        id: deliveryId,
                    },
                    select: {
                        status: true,
                        tenantId: true,
                        attempts: true,
                        nextAttemptAt: true,
                        updatedAt: true,
                    },
                });

                const retryAt = this.retryAtForUnclaimedDelivery(current, leaseMs);
                const terminalAttemptIsReclaimable = current
                    && current.attempts >= boundedMaxAttempts
                    && (
                        current.status !== 'SENDING'
                        || current.updatedAt.getTime() <= staleBefore.getTime()
                    )
                    && (
                        REPLAYABLE_DELIVERY_STATUSES.includes(current.status)
                        || current.status === 'SENDING'
                    );
                if (terminalAttemptIsReclaimable) {
                    await this.settleDeadLetteredInTransaction(
                        tx,
                        current.tenantId,
                        deliveryId,
                        `Webhook replay exceeded ${boundedMaxAttempts} attempts`,
                        current.attempts,
                    );
                    return { status: 'not_found' };
                }
                return retryAt
                    ? {
                        status: 'deferred',
                        tenantId: current.tenantId,
                        attempts: current.attempts,
                        retryAfterMs: Math.max(1_000, retryAt.getTime() - Date.now()),
                    }
                    : { status: 'not_found' };
            }

            const row = await (tx as any).webhookDelivery.findFirst({
                where: {
                    id: deliveryId,
                    status: 'SENDING' satisfies WebhookDeliveryStatus,
                },
                select: {
                    id: true,
                    tenantId: true,
                    endpointId: true,
                    eventType: true,
                    encryptedUrl: true,
                    encryptedPayload: true,
                    attempts: true,
                },
            });

            if (!row) {
                return { status: 'not_found' };
            }

            const endpoint = row.endpointId
                ? await (tx as any).webhookEndpoint.findFirst({
                    where: {
                        id: row.endpointId,
                        tenantId: row.tenantId,
                        active: true,
                    },
                    select: {
                        secret: true,
                    },
                })
                : null;

            if (!endpoint) {
                await this.settleDeadLetteredInTransaction(
                    tx,
                    row.tenantId,
                    row.id,
                    'Webhook endpoint is not active',
                    row.attempts,
                );
                return { status: 'not_found' };
            }

            return {
                status: 'claimed',
                delivery: {
                    id: row.id,
                    tenantId: row.tenantId,
                    endpointId: row.endpointId,
                    url: this.deliveryCrypto.decryptString(row.encryptedUrl),
                    body: this.deliveryCrypto.decryptString(row.encryptedPayload),
                    eventType: row.eventType,
                    secret: endpoint.secret
                        ? this.deliveryCrypto.decryptString(endpoint.secret)
                        : null,
                    attempts: row.attempts,
                },
            };
        });
    }

    async validateActiveDeliverySendAuthority(
        tenantId: string,
        deliveryId: string,
        expectedAttempts: number,
    ): Promise<WebhookDeliverySendAuthority> {
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const leaseState = await (tx as any).$queryRaw(Prisma.sql`
                SELECT tenant."status" AS "tenantStatus",
                    tenant."deletedAt" AS "tenantDeletedAt",
                    tenant."planTier"::text AS "tenantPlanTier",
                    tenant."stripeSubscriptionId" AS "tenantStripeSubscriptionId",
                    tenant."stripeSubscriptionCurrentPeriodEnd" AS "tenantPaidThrough",
                    endpoint."active" AS "endpointActive",
                    delivery."attempts" AS "attempts",
                    EXISTS (
                        SELECT 1
                        FROM "CreditTransaction" AS credit
                        WHERE credit."id" = 'feature-usage-webhook-delivery:' || delivery."id"
                          AND credit."tenantId" = delivery."tenantId"
                          AND credit."amount" = ${-WEBHOOK_CREDIT_COST}
                          AND credit."reason" = 'Webhook delivery (' || delivery."id" || ')'
                          AND credit."balanceAfter" IS NOT NULL
                          AND credit."balanceAfter" >= 0
                    ) AS "hasExactCreditReservation"
                FROM "WebhookDelivery" AS delivery
                INNER JOIN "Tenant" AS tenant ON tenant."id" = delivery."tenantId"
                INNER JOIN "WebhookEndpoint" AS endpoint
                    ON endpoint."id" = delivery."endpointId"
                   AND endpoint."tenantId" = delivery."tenantId"
                WHERE delivery."id" = ${deliveryId}
                  AND delivery."tenantId" = ${tenantId}
                  AND delivery."status" = 'SENDING'::"WebhookDeliveryStatus"
                  AND delivery."attempts" = ${expectedAttempts}
                FOR SHARE OF tenant, endpoint
            `) as Array<{
                tenantStatus: string;
                tenantDeletedAt: Date | null;
                tenantPlanTier: string;
                tenantStripeSubscriptionId: string | null;
                tenantPaidThrough: Date | null;
                endpointActive: boolean;
                attempts: number;
                hasExactCreditReservation: boolean;
            }>;

            const current = leaseState[0];
            if (!current || current.attempts !== expectedAttempts) {
                return 'not_found';
            }
            const now = new Date();
            const deliveryEligible = current
                && current.endpointActive
                && current.tenantDeletedAt === null
                && current.tenantStatus === 'ACTIVE'
                && current.tenantPlanTier !== 'FREE'
                && Boolean(current.tenantStripeSubscriptionId?.trim())
                && current.tenantPaidThrough instanceof Date
                && current.tenantPaidThrough.getTime() > now.getTime()
                && current.hasExactCreditReservation;
            if (!deliveryEligible) {
                const terminal = !current?.endpointActive || current?.tenantStatus === 'PURGED';
                if (terminal) {
                    await this.settleDeadLetteredInTransaction(
                        tx,
                        tenantId,
                        deliveryId,
                        'Tenant was purged or webhook endpoint was deactivated',
                        expectedAttempts,
                    );
                    return 'terminal';
                }
                await (tx as any).webhookDelivery.updateMany({
                    where: {
                        id: deliveryId,
                        tenantId,
                        status: 'SENDING',
                        attempts: expectedAttempts,
                    },
                    data: {
                            status: 'FAILED' satisfies WebhookDeliveryStatus,
                            nextAttemptAt: now,
                            lastError: 'Tenant webhook delivery is paused',
                    },
                });
                return 'paused';
            }

            return 'eligible';
        });
    }

    private async hasExactPaidDeliveryAuthority(
        tx: TenantPrismaTransaction,
        deliveryId: string,
        tenantId?: string,
    ): Promise<boolean> {
        const rows = await (tx as any).$queryRaw(Prisma.sql`
            SELECT delivery."id"
            FROM "WebhookDelivery" delivery
            JOIN "Tenant" tenant ON tenant."id" = delivery."tenantId"
            JOIN "WebhookEndpoint" endpoint
              ON endpoint."id" = delivery."endpointId"
             AND endpoint."tenantId" = delivery."tenantId"
            WHERE delivery."id" = ${deliveryId}
              AND (${tenantId ?? null}::text IS NULL OR delivery."tenantId" = ${tenantId ?? null})
              AND tenant."deletedAt" IS NULL
              AND tenant."status" = 'ACTIVE'::"TenantStatus"
              AND tenant."planTier" <> 'FREE'::"PlanTier"
              AND NULLIF(BTRIM(tenant."stripeSubscriptionId"), '') IS NOT NULL
              AND tenant."stripeSubscriptionCurrentPeriodEnd" > CURRENT_TIMESTAMP
              AND EXISTS (
                  SELECT 1
                  FROM "CreditTransaction" credit
                  WHERE credit."id" = 'feature-usage-webhook-delivery:' || delivery."id"
                    AND credit."tenantId" = delivery."tenantId"
                    AND credit."amount" = ${-WEBHOOK_CREDIT_COST}
                    AND credit."reason" = 'Webhook delivery (' || delivery."id" || ')'
                    AND credit."balanceAfter" IS NOT NULL
                    AND credit."balanceAfter" >= 0
              )
            FOR SHARE OF tenant, endpoint
        `) as Array<{ id: string }>;
        return rows.length === 1;
    }

    async markDelivered(
        tenantId: string,
        deliveryId: string,
        expectedAttempts: number,
    ): Promise<WebhookDeliveryReplayState> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const transitioned = await (tx as any).webhookDelivery.updateMany({
                where: {
                    id: deliveryId,
                    tenantId,
                    status: 'SENDING' satisfies WebhookDeliveryStatus,
                    attempts: expectedAttempts,
                },
                data: {
                    status: 'DELIVERED' satisfies WebhookDeliveryStatus,
                    deliveredAt: new Date(),
                    nextAttemptAt: null,
                    lastError: null,
                    ...TERMINAL_DELIVERY_ERASURE,
                },
            });
            return this.loadTransitionedState(
                tx,
                tenantId,
                deliveryId,
                transitioned.count,
                'DELIVERED',
                expectedAttempts,
            );
        });
    }

    async markReplayFailed(
        tenantId: string,
        deliveryId: string,
        failureReason: unknown,
        attempts: number,
    ): Promise<WebhookDeliveryReplayState> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const transitioned = await (tx as any).webhookDelivery.updateMany({
                where: {
                    id: deliveryId,
                    tenantId,
                    status: 'SENDING' satisfies WebhookDeliveryStatus,
                    attempts,
                },
                data: {
                    status: 'FAILED' satisfies WebhookDeliveryStatus,
                    nextAttemptAt: this.nextRetryAt(attempts),
                    lastError: this.redactLastError(failureReason),
                },
            });
            return this.loadTransitionedState(tx, tenantId, deliveryId, transitioned.count, 'FAILED', attempts);
        });
    }

    async markDeadLettered(
        tenantId: string,
        deliveryId: string,
        failureReason: unknown,
        expectedAttempts: number,
    ): Promise<WebhookDeliveryReplayState> {
        return this.tenantDb.withTenant(
            tenantId,
            (tx) => this.settleDeadLetteredInTransaction(
                tx,
                tenantId,
                deliveryId,
                failureReason,
                expectedAttempts,
            ),
        );
    }

    private async loadTransitionedState(
        tx: any,
        tenantId: string,
        deliveryId: string,
        transitionedCount: number,
        expectedStatus: WebhookDeliveryStatus,
        expectedAttempts?: number,
    ): Promise<WebhookDeliveryReplayState> {
        const state = await tx.webhookDelivery.findFirst({
            where: { id: deliveryId, tenantId, status: expectedStatus },
            select: { status: true, attempts: true },
        });
        if (!state
            || (expectedAttempts !== undefined && state.attempts !== expectedAttempts)
            || (transitionedCount !== 0 && transitionedCount !== 1)) {
            throw new ServiceUnavailableException(`Webhook delivery state ${expectedStatus} could not be loaded`);
        }
        return state;
    }

    private async settleDeadLetteredInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        deliveryId: string,
        failureReason: unknown,
        expectedAttempts: number,
    ): Promise<WebhookDeliveryReplayState> {
        const walletRows = await (tx as any).$queryRaw(Prisma.sql`
            SELECT tenant."usageCredits"
            FROM "Tenant" tenant
            WHERE tenant."id" = ${tenantId}
            FOR UPDATE OF tenant
        `) as Array<{ usageCredits: number | bigint }>;
        const deliveryRows = await (tx as any).$queryRaw(Prisma.sql`
            SELECT delivery."status"::text AS "status", delivery."attempts"
            FROM "WebhookDelivery" delivery
            WHERE delivery."id" = ${deliveryId}
              AND delivery."tenantId" = ${tenantId}
            FOR UPDATE OF delivery
        `) as Array<{ status: WebhookDeliveryStatus; attempts: number }>;
        const walletBalance = this.nonnegativeInteger(walletRows[0]?.usageCredits);
        const delivery = deliveryRows[0];
        if (walletBalance === null || !delivery || delivery.attempts !== expectedAttempts) {
            throw new ServiceUnavailableException('Webhook terminal settlement ownership is unavailable');
        }

        const debitId = `feature-usage-webhook-delivery:${deliveryId}`;
        const refundId = `feature-refund-webhook-delivery:${deliveryId}`;
        const debitReason = `Webhook delivery (${deliveryId})`;
        const refundReason = `Webhook delivery refund (${deliveryId})`;
        const ledgerRows = await (tx as any).creditTransaction.findMany({
            where: {
                id: { in: [debitId, refundId] },
                tenantId,
            },
            select: {
                id: true,
                amount: true,
                reason: true,
                balanceAfter: true,
            },
            orderBy: { id: 'asc' },
        }) as Array<{
            id: string;
            amount: number;
            reason: string;
            balanceAfter: number | null;
        }>;
        const debit = ledgerRows.find((row) => row.id === debitId);
        const existingRefund = ledgerRows.find((row) => row.id === refundId);
        if (!debit
            || debit.amount !== -WEBHOOK_CREDIT_COST
            || debit.reason !== debitReason
            || this.nonnegativeInteger(debit.balanceAfter) === null
            || (existingRefund && (
                existingRefund.amount !== WEBHOOK_CREDIT_COST
                || existingRefund.reason !== refundReason
                || this.nonnegativeInteger(existingRefund.balanceAfter) === null
            ))) {
            throw new ServiceUnavailableException('Webhook terminal credit provenance is malformed or mismatched');
        }
        if (delivery.status === 'DELIVERED') {
            throw new ServiceUnavailableException('Delivered webhook cannot be terminally refunded');
        }

        if (!existingRefund) {
            const balanceAfter = walletBalance + WEBHOOK_CREDIT_COST;
            if (!Number.isSafeInteger(balanceAfter)) {
                throw new ServiceUnavailableException('Webhook terminal refund balance exceeds the supported range');
            }
            await (tx as any).tenant.update({
                where: { id: tenantId },
                data: { usageCredits: balanceAfter },
            });
            await (tx as any).creditTransaction.create({
                data: {
                    id: refundId,
                    tenantId,
                    amount: WEBHOOK_CREDIT_COST,
                    reason: refundReason,
                    balanceAfter,
                },
            });
        }

        if (delivery.status !== 'DEAD_LETTERED') {
            const transitioned = await (tx as any).webhookDelivery.updateMany({
                where: {
                    id: deliveryId,
                    tenantId,
                    status: {
                        in: ['PENDING', 'SENDING', 'FAILED', 'QUEUED'] satisfies WebhookDeliveryStatus[],
                    },
                    attempts: expectedAttempts,
                },
                data: {
                    status: 'DEAD_LETTERED' satisfies WebhookDeliveryStatus,
                    nextAttemptAt: null,
                    lastError: this.redactLastError(failureReason),
                    ...TERMINAL_DELIVERY_ERASURE,
                },
            });
            if (transitioned.count !== 1) {
                throw new ServiceUnavailableException('Webhook delivery did not enter terminal settlement');
            }
        }
        return this.loadTransitionedState(
            tx,
            tenantId,
            deliveryId,
            delivery.status === 'DEAD_LETTERED' ? 0 : 1,
            'DEAD_LETTERED',
            expectedAttempts,
        );
    }

    private digestRef(value: string, length = 16): string {
        return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
    }

    private redactLastError(error: unknown): string | null {
        if (error === undefined || error === null) {
            return null;
        }

        return runtimeErrorText(error).slice(0, MAX_LAST_ERROR_LENGTH);
    }

    private nextRetryAt(attempts: number): Date {
        const boundedAttempts = Math.max(1, Math.min(attempts, 8));
        const delayMs = Math.min(2 ** (boundedAttempts - 1) * 60_000, MAX_REPLAY_BACKOFF_MS);
        return new Date(Date.now() + delayMs);
    }

    private resolveReplayLeaseMs(): number {
        const configured = Number.parseInt(String(this.configService.get('WEBHOOK_REPLAY_LEASE_MS') ?? ''), 10);
        if (!Number.isFinite(configured)) {
            return DEFAULT_REPLAY_LEASE_MS;
        }

        return Math.max(MIN_REPLAY_LEASE_MS, Math.min(configured, MAX_REPLAY_LEASE_MS));
    }

    private resolvePendingClaimLeaseMs(): number {
        const configured = Number.parseInt(
            String(this.configService.get('WEBHOOK_PENDING_CLAIM_LEASE_MS') ?? ''),
            10,
        );
        if (!Number.isFinite(configured)) {
            return DEFAULT_PENDING_CLAIM_LEASE_MS;
        }

        return Math.max(MIN_PENDING_CLAIM_LEASE_MS, Math.min(configured, MAX_PENDING_CLAIM_LEASE_MS));
    }

    private resolveConfirmedQueueRecoveryAgeMs(): number {
        const configured = Number.parseInt(String(this.configService.get('WEBHOOK_CONFIRMED_QUEUE_RECOVERY_AGE_MS') ?? ''), 10);
        if (!Number.isFinite(configured)) {
            return DEFAULT_CONFIRMED_QUEUE_RECOVERY_AGE_MS;
        }
        return Math.max(
            MIN_CONFIRMED_QUEUE_RECOVERY_AGE_MS,
            Math.min(configured, MAX_CONFIRMED_QUEUE_RECOVERY_AGE_MS),
        );
    }

    private resolveInitialDeliveryLeaseMs(): number {
        const configured = Number.parseInt(String(this.configService.get('WEBHOOK_INITIAL_DELIVERY_LEASE_MS') ?? ''), 10);
        if (!Number.isFinite(configured)) {
            return DEFAULT_INITIAL_DELIVERY_LEASE_MS;
        }
        return Math.max(MIN_INITIAL_DELIVERY_LEASE_MS, Math.min(MAX_INITIAL_DELIVERY_LEASE_MS, configured));
    }

    private retryAtForUnclaimedDelivery(
        row: {
            status: WebhookDeliveryStatus;
            nextAttemptAt: Date | null;
            updatedAt: Date;
        } | null,
        leaseMs: number,
    ): Date | null {
        if (!row) {
            return null;
        }
        if (row.status === 'SENDING') {
            return new Date(row.updatedAt.getTime() + leaseMs);
        }
        if (REPLAYABLE_DELIVERY_STATUSES.includes(row.status) && row.nextAttemptAt) {
            return row.nextAttemptAt;
        }
        return null;
    }

    private nonnegativeInteger(value: unknown): number | null {
        if (typeof value === 'bigint') {
            const numeric = Number(value);
            return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
        }
        return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
            ? value
            : null;
    }
}
