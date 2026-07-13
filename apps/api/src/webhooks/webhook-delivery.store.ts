import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { redactSensitiveText } from '../common/sensitive-redaction';
import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { WebhookDeliveryCrypto } from './webhook-delivery.crypto';

const MAX_LAST_ERROR_LENGTH = 1000;
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
const WEBHOOK_DELIVERY_ELIGIBLE_TENANT_STATUSES = ['ACTIVE', 'TRIAL'] as const;

function deliveryEligibleTenantWhere(now: Date) {
    return {
        deletedAt: null,
        OR: [
            { status: 'ACTIVE' },
            { status: 'TRIAL', trialEndsAt: { gt: now } },
        ],
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
                      AND (
                          tenant."status" = 'ACTIVE'::"TenantStatus"
                          OR (
                              tenant."status" = 'TRIAL'::"TenantStatus"
                              AND tenant."trialEndsAt" > ${now}
                          )
                      )
                      AND endpoint."active" = true
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

    async claimReplayByDeliveryId(deliveryId: string): Promise<WebhookReplayClaim> {
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const now = new Date();
            const leaseMs = this.resolveReplayLeaseMs();
            const staleBefore = new Date(now.getTime() - leaseMs);
            const claimed = await (tx as any).webhookDelivery.updateMany({
                where: {
                    id: deliveryId,
                    tenant: {
                        is: deliveryEligibleTenantWhere(now),
                    },
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
                        tenant: {
                            is: deliveryEligibleTenantWhere(now),
                        },
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
                    tenant: {
                        is: deliveryEligibleTenantWhere(now),
                    },
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
                await (tx as any).webhookDelivery.updateMany({
                    where: { id: row.id, tenantId: row.tenantId, status: 'SENDING' },
                    data: {
                        status: 'DEAD_LETTERED',
                        nextAttemptAt: null,
                        lastError: 'Webhook endpoint is not active',
                    },
                });
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

    async withActiveDeliverySendLease<T>(
        tenantId: string,
        deliveryId: string,
        operation: () => Promise<T>,
    ): Promise<T | null> {
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const leaseState = await (tx as any).$queryRaw(Prisma.sql`
                SELECT tenant."status" AS "tenantStatus",
                    tenant."deletedAt" AS "tenantDeletedAt",
                    tenant."trialEndsAt" AS "tenantTrialEndsAt",
                    endpoint."active" AS "endpointActive"
                FROM "WebhookDelivery" AS delivery
                INNER JOIN "Tenant" AS tenant ON tenant."id" = delivery."tenantId"
                INNER JOIN "WebhookEndpoint" AS endpoint
                    ON endpoint."id" = delivery."endpointId"
                   AND endpoint."tenantId" = delivery."tenantId"
                WHERE delivery."id" = ${deliveryId}
                  AND delivery."tenantId" = ${tenantId}
                  AND delivery."status" = 'SENDING'::"WebhookDeliveryStatus"
                FOR SHARE OF tenant, endpoint
            `) as Array<{
                tenantStatus: string;
                tenantDeletedAt: Date | null;
                tenantTrialEndsAt: Date | null;
                endpointActive: boolean;
            }>;

            const current = leaseState[0];
            const now = new Date();
            const deliveryEligible = current
                && current.endpointActive
                && current.tenantDeletedAt === null
                && (current.tenantStatus === WEBHOOK_DELIVERY_ELIGIBLE_TENANT_STATUSES[0]
                    || (current.tenantStatus === WEBHOOK_DELIVERY_ELIGIBLE_TENANT_STATUSES[1]
                        && current.tenantTrialEndsAt !== null
                        && current.tenantTrialEndsAt > now));
            if (!deliveryEligible) {
                const terminal = !current?.endpointActive || current?.tenantStatus === 'PURGED';
                await (tx as any).webhookDelivery.updateMany({
                    where: { id: deliveryId, tenantId, status: 'SENDING' },
                    data: terminal
                        ? {
                            status: 'DEAD_LETTERED' satisfies WebhookDeliveryStatus,
                            nextAttemptAt: null,
                            lastError: 'Tenant was purged or webhook endpoint was deactivated',
                        }
                        : {
                            status: 'FAILED' satisfies WebhookDeliveryStatus,
                            nextAttemptAt: now,
                            lastError: 'Tenant webhook delivery is paused',
                        },
                });
                return null;
            }

            return operation();
        });
    }

    async markDelivered(tenantId: string, deliveryId: string): Promise<WebhookDeliveryReplayState> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const transitioned = await (tx as any).webhookDelivery.updateMany({
                where: {
                    id: deliveryId,
                    tenantId,
                    status: 'SENDING' satisfies WebhookDeliveryStatus,
                },
                data: {
                    status: 'DELIVERED' satisfies WebhookDeliveryStatus,
                    deliveredAt: new Date(),
                    nextAttemptAt: null,
                    lastError: null,
                },
            });
            return this.loadTransitionedState(tx, tenantId, deliveryId, transitioned.count, 'DELIVERED');
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
                },
                data: {
                    status: 'FAILED' satisfies WebhookDeliveryStatus,
                    nextAttemptAt: this.nextRetryAt(attempts),
                    lastError: this.redactLastError(failureReason),
                },
            });
            return this.loadTransitionedState(tx, tenantId, deliveryId, transitioned.count, 'FAILED');
        });
    }

    async markDeadLettered(
        tenantId: string,
        deliveryId: string,
        failureReason: unknown,
        attempts?: number,
    ): Promise<WebhookDeliveryReplayState> {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const transitioned = await (tx as any).webhookDelivery.updateMany({
                where: {
                    id: deliveryId,
                    tenantId,
                    status: { in: ['SENDING', 'FAILED', 'QUEUED'] satisfies WebhookDeliveryStatus[] },
                },
                data: {
                    status: 'DEAD_LETTERED' satisfies WebhookDeliveryStatus,
                    nextAttemptAt: null,
                    lastError: this.redactLastError(failureReason),
                    ...(attempts === undefined ? {} : { attempts }),
                },
            });
            return this.loadTransitionedState(tx, tenantId, deliveryId, transitioned.count, 'DEAD_LETTERED');
        });
    }

    private async loadTransitionedState(
        tx: any,
        tenantId: string,
        deliveryId: string,
        transitionedCount: number,
        expectedStatus: WebhookDeliveryStatus,
    ): Promise<WebhookDeliveryReplayState> {
        if (transitionedCount !== 1) {
            throw new ServiceUnavailableException(`Webhook delivery state did not transition to ${expectedStatus}`);
        }
        const state = await tx.webhookDelivery.findFirst({
            where: { id: deliveryId, tenantId, status: expectedStatus },
            select: { status: true, attempts: true },
        });
        if (!state) {
            throw new ServiceUnavailableException(`Webhook delivery state ${expectedStatus} could not be loaded`);
        }
        return state;
    }

    private digestRef(value: string, length = 16): string {
        return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
    }

    private redactLastError(error: unknown): string | null {
        if (error === undefined || error === null) {
            return null;
        }

        const message = error instanceof Error ? error.stack ?? error.message : error;
        return redactSensitiveText(message).slice(0, MAX_LAST_ERROR_LENGTH);
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
}
