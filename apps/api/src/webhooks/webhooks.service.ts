import {
    Injectable,
    Optional,
    PayloadTooLargeException,
    ServiceUnavailableException,
} from '@nestjs/common';
import crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { ConfirmChannel } from 'amqplib';
import { secureHttpRequest } from '../common/secure-http-client';
import { redactSensitiveText, redactUrlForLog } from '../common/sensitive-redaction';
import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { FeatureAccessService } from '../billing/feature-access.service';
import { type RecoverableWebhookDelivery, WebhookDeliveryStore } from './webhook-delivery.store';
import {
    assertWebhookRetryQueues,
    publishWebhookRetryAfterDelay,
    resolveWebhookRetryQueueConfig,
} from './webhook-retry-queue';

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

export type WebhookDeliveryRequest = {
    tenantId: string;
    endpointId: string;
    url: string;
    payload: unknown;
    secret: string;
    eventType?: string;
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

    /**
     * Secure Webhook Delivery
     * As per Architecture Part VII-A.4
     */
    async deliver(request: WebhookDeliveryRequest): Promise<void> {
        if (!request.endpointId?.trim()) {
            throw new ServiceUnavailableException('Webhook endpoint id is required for durable replay');
        }

        const body = JSON.stringify(request.payload ?? null);
        const maxPayloadBytes = this.resolveMaxPayloadBytes();
        const payloadBytes = Buffer.byteLength(body);
        if (payloadBytes > maxPayloadBytes) {
            console.error(
                `Webhook delivery dropped for ${redactUrlForLog(request.url)}`,
                `payload_bytes=${payloadBytes} max_payload_bytes=${maxPayloadBytes}`,
            );
            return;
        }

        const delivery = await this.deliveryStore.persistEvent({
            tenantId: request.tenantId,
            endpointId: request.endpointId,
            url: request.url,
            body,
            eventType: request.eventType ?? this.payloadEventType(request.payload),
        });
        const claimed = await this.deliveryStore.claimInitialDelivery(request.tenantId, delivery.id);
        if (!claimed) {
            return;
        }

        const signature = crypto
            .createHmac('sha256', request.secret)
            .update(body)
            .digest('hex');

        try {
            const response = await this.deliveryStore.withActiveDeliverySendLease(
                request.tenantId,
                delivery.id,
                () => this.sendSignedWebhook(request.url, body, request.secret, signature),
            );
            if (!response) {
                return;
            }

            if (!response.ok) {
                throw new Error(`Webhook endpoint returned HTTP ${response.status}`);
            }
            await this.deliveryStore.markDelivered(request.tenantId, delivery.id);
        } catch (error) {
            console.error(
                `Webhook delivery failed to ${redactUrlForLog(request.url)}`,
                redactSensitiveText(error instanceof Error ? error.message : error),
            );
            await this.deliveryStore.markReplayFailed(request.tenantId, delivery.id, error, 1);
            await this.enqueueRetry(request.tenantId, delivery.id);
        }
    }

    async enqueueEventInTransaction(
        tx: TenantPrismaTransaction,
        event: TransactionalWebhookEvent,
    ): Promise<number> {
        const endpoints = await (tx as any).webhookEndpoint.findMany({
            where: {
                tenantId: event.tenantId,
                active: true,
                events: { has: event.eventType },
            },
            select: {
                id: true,
                url: true,
            },
            orderBy: { createdAt: 'asc' },
        });
        if (endpoints.length === 0) {
            return 0;
        }

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

        if (!this.featureAccessService) {
            throw new ServiceUnavailableException('Webhook billing is unavailable');
        }
        const entitlement = await this.featureAccessService.assertFeatureEnabledInTransaction(
            tx,
            event.tenantId,
            'webhooks',
        );
        for (const endpoint of endpoints as Array<{ id: string; url: string }>) {
            const delivery = await this.deliveryStore.persistOutboxEventInTransaction(tx, {
                tenantId: event.tenantId,
                endpointId: endpoint.id,
                url: endpoint.url,
                body,
                eventType: event.eventType,
            });
            await this.featureAccessService.recordFeatureUsageInTransaction(
                tx,
                event.tenantId,
                entitlement,
                `Webhook delivery (${delivery.id})`,
                `webhook-delivery:${delivery.id}`,
            );
        }
        return endpoints.length;
    }

    async replayDelivery(deliveryId: string): Promise<WebhookReplayResult> {
        const claim = await this.deliveryStore.claimReplayByDeliveryId(deliveryId);
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
                error: redactSensitiveText(error.message),
            };
        }

        try {
            const response = await this.deliveryStore.withActiveDeliverySendLease(
                replay.tenantId,
                replay.id,
                () => this.sendSignedWebhook(replay.url, replay.body, replaySecret),
            );
            if (!response) {
                return {
                    deliveryId: replay.id,
                    tenantId: replay.tenantId,
                    status: 'failed',
                    attempts: replay.attempts,
                    error: 'Tenant or webhook endpoint is not active',
                };
            }
            if (!response.ok) {
                throw new Error(`Webhook endpoint returned HTTP ${response.status}`);
            }

            const delivered = await this.deliveryStore.markDelivered(replay.tenantId, replay.id);
            return {
                deliveryId: replay.id,
                tenantId: replay.tenantId,
                status: 'delivered',
                attempts: delivered.attempts,
                httpStatus: response.status,
            };
        } catch (error) {
            console.error(
                `Webhook replay failed to ${redactUrlForLog(replay.url)}`,
                redactSensitiveText(error instanceof Error ? error.message : error),
            );
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
                error: redactSensitiveText(error instanceof Error ? error.message : error),
            };
        }
    }

    async deadLetterDelivery(
        tenantId: string,
        deliveryId: string,
        failureReason: unknown,
        attempts?: number,
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
        signature = crypto.createHmac('sha256', secret).update(body).digest('hex'),
    ): Promise<Response> {
        return secureHttpRequest(url, {
            method: 'POST',
            headers: {
                'X-LunchLineup-Signature': signature,
                'Content-Type': 'application/json',
            },
            body,
            timeoutMs: 5000,
            redirect: 'error',
        });
    }

    private async enqueueRetry(tenantId: string, deliveryId: string): Promise<void> {
        let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
        let channel: ConfirmChannel | undefined;
        try {
            const rabbitUrl = this.configService.get('RABBITMQ_URL') || 'amqp://localhost';
            connection = await amqp.connect(rabbitUrl);
            channel = await connection.createConfirmChannel();

            const retryConfig = resolveWebhookRetryQueueConfig(this.configService);
            await assertWebhookRetryQueues(channel, retryConfig);

            await publishWebhookRetryAfterDelay(channel, retryConfig, deliveryId, 1);
            await this.deliveryStore.markQueued(tenantId, deliveryId);
        } catch (err) {
            console.error('CRITICAL: Failed to enqueue webhook retry to RabbitMQ', redactSensitiveText(err instanceof Error ? err.stack ?? err.message : err));
        } finally {
            await Promise.resolve(channel?.close()).catch(() => undefined);
            await Promise.resolve(connection?.close()).catch(() => undefined);
        }
    }

    private resolveMaxPayloadBytes(): number {
        const configured = Number.parseInt(String(this.configService.get('WEBHOOK_MAX_PAYLOAD_BYTES') ?? ''), 10);
        if (!Number.isFinite(configured) || configured <= 0) {
            return DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES;
        }

        return Math.min(configured, HARD_MAX_WEBHOOK_PAYLOAD_BYTES);
    }

    private payloadEventType(payload: unknown): string | undefined {
        if (!payload || typeof payload !== 'object') {
            return undefined;
        }

        const event = (payload as { event?: unknown }).event;
        return typeof event === 'string' ? event : undefined;
    }
}
