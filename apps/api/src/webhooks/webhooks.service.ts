import {
    Injectable,
    Optional,
    PayloadTooLargeException,
    ServiceUnavailableException,
} from '@nestjs/common';
import crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { runtimeErrorText } from '../common/runtime-error-diagnostic';
import { secureHttpRequest } from '../common/secure-http-client';
import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { FeatureAccessService, type FeatureResolution } from '../billing/feature-access.service';
import { type RecoverableWebhookDelivery, WebhookDeliveryStore } from './webhook-delivery.store';
import { resolveWebhookRetryQueueConfig } from './webhook-retry-queue';

const DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES = 64 * 1024;
const HARD_MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024;

export const WEBHOOK_EVENT_TYPES = ['schedule.published'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export type TransactionalWebhookEvent = {
    tenantId: string;
    eventId: string;
    eventType: WebhookEventType;
    occurredAt: Date;
    data: Record<string, unknown>;
};

type PlannedWebhookEndpoint = {
    id: string;
    url: string;
};

export type TransactionalWebhookCostPlan = {
    tenantId: string;
    eventType: WebhookEventType;
    matchingDeliveryCount: number;
    unitCost: number;
    totalConfiguredCost: number;
    entitlement: FeatureResolution | null;
    endpoints: PlannedWebhookEndpoint[];
};

export type TransactionalWebhookSettlement = {
    matchingDeliveryCount: number;
    unitCost: number;
    totalConfiguredCost: number;
    deliveries: Array<{
        deliveryId: string;
        consumedCredits: number;
        newBalance: number;
    }>;
};

export type WebhookReplayResult = {
    deliveryId: string;
    tenantId?: string;
    status: 'not_found' | 'deferred' | 'delivered' | 'failed';
    attempts?: number;
    retryAfterMs?: number;
    httpStatus?: number;
    error?: string;
};

@Injectable()
export class WebhooksService {
    private readonly deliveryStore: WebhookDeliveryStore;

    constructor(
        private configService: ConfigService,
        @Optional() deliveryStore?: WebhookDeliveryStore,
        @Optional() private readonly featureAccessService?: FeatureAccessService,
    ) {
        this.deliveryStore = deliveryStore ?? new WebhookDeliveryStore(configService);
    }

    async enqueueEventInTransaction(
        tx: TenantPrismaTransaction,
        event: TransactionalWebhookEvent,
        costPlan?: TransactionalWebhookCostPlan,
    ): Promise<TransactionalWebhookSettlement> {
        const plan = costPlan ?? await this.preflightEventInTransaction(tx, event.tenantId, event.eventType);
        this.assertMatchingCostPlan(plan, event);

        const body = JSON.stringify({
            id: event.eventId,
            event: event.eventType,
            occurredAt: event.occurredAt.toISOString(),
            data: event.data,
        });
        const payloadBytes = Buffer.byteLength(body);
        if (payloadBytes > this.resolveMaxPayloadBytes()) {
            throw new PayloadTooLargeException('Webhook event payload exceeds the configured maximum');
        }

        const deliveries: TransactionalWebhookSettlement['deliveries'] = [];
        for (const endpoint of plan.endpoints) {
            const delivery = await this.deliveryStore.persistOutboxEventInTransaction(tx, {
                tenantId: event.tenantId,
                endpointId: endpoint.id,
                url: endpoint.url,
                body,
                eventType: event.eventType,
            });
            const usage = await this.featureAccessService!.recordFeatureUsageInTransaction(
                tx,
                event.tenantId,
                plan.entitlement!,
                `Webhook delivery (${delivery.id})`,
                `webhook-delivery:${delivery.id}`,
            );
            if (usage.consumedCredits !== plan.unitCost
                || usage.newBalance === null
                || !Number.isSafeInteger(usage.newBalance)
                || usage.newBalance < 0) {
                throw new ServiceUnavailableException('Webhook credit settlement balance is unavailable');
            }
            deliveries.push({
                deliveryId: delivery.id,
                consumedCredits: usage.consumedCredits,
                newBalance: usage.newBalance,
            });
        }

        return {
            matchingDeliveryCount: plan.matchingDeliveryCount,
            unitCost: plan.unitCost,
            totalConfiguredCost: plan.totalConfiguredCost,
            deliveries,
        };
    }

    async preflightEventInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        eventType: WebhookEventType,
    ): Promise<TransactionalWebhookCostPlan> {
        const endpoints = await (tx as any).webhookEndpoint.findMany({
            where: {
                tenantId,
                active: true,
                events: { has: eventType },
            },
            select: {
                id: true,
                url: true,
            },
            orderBy: { createdAt: 'asc' },
        });
        if (endpoints.length === 0) {
            return {
                tenantId,
                eventType,
                matchingDeliveryCount: 0,
                unitCost: 0,
                totalConfiguredCost: 0,
                entitlement: null,
                endpoints: [],
            };
        }

        if (!this.featureAccessService) {
            throw new ServiceUnavailableException('Webhook billing is unavailable');
        }
        const entitlement = await this.featureAccessService.assertFeatureEnabledInTransaction(
            tx,
            tenantId,
            'webhooks',
        );
        const unitCost = entitlement.creditCost;
        if (entitlement.source !== 'credits'
            || typeof unitCost !== 'number'
            || !Number.isSafeInteger(unitCost)
            || unitCost <= 0) {
            throw new ServiceUnavailableException('Webhook billing requires a positive configured credit cost');
        }
        const totalConfiguredCost = endpoints.length * unitCost;
        if (!Number.isSafeInteger(totalConfiguredCost)) {
            throw new ServiceUnavailableException('Webhook billing cost exceeds the supported range');
        }
        return {
            tenantId,
            eventType,
            matchingDeliveryCount: endpoints.length,
            unitCost,
            totalConfiguredCost,
            entitlement,
            endpoints: endpoints as PlannedWebhookEndpoint[],
        };
    }

    async replayDelivery(deliveryId: string): Promise<WebhookReplayResult> {
        const maxAttempts = resolveWebhookRetryQueueConfig(this.configService).maxAttempts;
        const claim = await this.deliveryStore.claimReplayByDeliveryId(deliveryId, maxAttempts);
        if (claim.status === 'not_found') {
            return {
                deliveryId,
                status: 'not_found',
            };
        }
        if (claim.status === 'deferred') {
            return {
                deliveryId,
                tenantId: claim.tenantId,
                status: 'deferred',
                attempts: claim.attempts,
                retryAfterMs: claim.retryAfterMs,
            };
        }

        const replay = claim.delivery;
        const replaySecret = replay.secret;
        if (!replaySecret) {
            const error = new Error('Webhook endpoint signing secret is unavailable for replay');
            const failed = await this.deliveryStore.markReplayFailed(
                replay.tenantId,
                replay.id,
                error,
                replay.attempts,
            );
            return {
                deliveryId: replay.id,
                tenantId: replay.tenantId,
                status: 'failed',
                attempts: failed.attempts,
                error: runtimeErrorText(error),
            };
        }

        try {
            const authority = await this.deliveryStore.validateActiveDeliverySendAuthority(
                replay.tenantId,
                replay.id,
                replay.attempts,
            );
            if (authority !== 'eligible') {
                return {
                    deliveryId: replay.id,
                    tenantId: replay.tenantId,
                    status: 'failed',
                    attempts: replay.attempts,
                    error: 'Tenant or webhook endpoint is not active',
                };
            }
            const response = await this.sendSignedWebhook(
                replay.url,
                replay.body,
                replaySecret,
                replay.id,
                replay.eventType,
            );
            if (!response.ok) {
                throw Object.assign(new Error('Webhook provider rejected delivery'), { status: response.status });
            }

            const delivered = await this.deliveryStore.markDelivered(
                replay.tenantId,
                replay.id,
                replay.attempts,
            );
            return {
                deliveryId: replay.id,
                tenantId: replay.tenantId,
                status: 'delivered',
                attempts: delivered.attempts,
                httpStatus: response.status,
            };
        } catch (error) {
            console.error(`Webhook replay failed ${runtimeErrorText(error)}`);
            const failed = await this.deliveryStore.markReplayFailed(
                replay.tenantId,
                replay.id,
                error,
                replay.attempts,
            );
            return {
                deliveryId: replay.id,
                tenantId: replay.tenantId,
                status: 'failed',
                attempts: failed.attempts,
                error: runtimeErrorText(error),
            };
        }
    }

    async deadLetterDelivery(
        tenantId: string,
        deliveryId: string,
        failureReason: unknown,
        attempts: number,
    ): Promise<void> {
        await this.deliveryStore.markDeadLettered(tenantId, deliveryId, failureReason, attempts);
    }

    async claimRecoverableRetries(limit: number): Promise<RecoverableWebhookDelivery[]> {
        return this.deliveryStore.claimRecoverableForQueue(limit);
    }

    async markRetryQueued(tenantId: string, deliveryId: string): Promise<void> {
        await this.deliveryStore.markQueued(tenantId, deliveryId);
    }

    private async sendSignedWebhook(
        url: string,
        body: string,
        secret: string,
        deliveryId: string,
        eventType?: string | null,
    ): Promise<Response> {
        const signedPayload = `v2:${deliveryId}:${eventType ?? ''}:${body}`;
        const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
        return secureHttpRequest(url, {
            method: 'POST',
            headers: {
                'X-LunchLineup-Signature': signature,
                'X-LunchLineup-Signature-Version': 'v2',
                'X-LunchLineup-Delivery-Id': deliveryId,
                ...(eventType ? { 'X-LunchLineup-Event': eventType } : {}),
                'Content-Type': 'application/json',
            },
            body,
            timeoutMs: 5000,
            redirect: 'error',
        });
    }

    private resolveMaxPayloadBytes(): number {
        const configured = Number.parseInt(String(this.configService.get('WEBHOOK_MAX_PAYLOAD_BYTES') ?? ''), 10);
        if (!Number.isFinite(configured) || configured <= 0) {
            return DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES;
        }

        return Math.min(configured, HARD_MAX_WEBHOOK_PAYLOAD_BYTES);
    }

    private assertMatchingCostPlan(
        plan: TransactionalWebhookCostPlan,
        event: TransactionalWebhookEvent,
    ): void {
        if (plan.tenantId !== event.tenantId
            || plan.eventType !== event.eventType
            || plan.matchingDeliveryCount !== plan.endpoints.length) {
            throw new ServiceUnavailableException('Webhook cost preflight does not match the event');
        }
        if (plan.matchingDeliveryCount === 0) return;
        if (!this.featureAccessService
            || !plan.entitlement
            || plan.unitCost !== plan.entitlement.creditCost
            || plan.totalConfiguredCost !== plan.matchingDeliveryCount * plan.unitCost) {
            throw new ServiceUnavailableException('Webhook cost preflight is invalid');
        }
    }
}
