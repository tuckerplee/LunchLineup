import { ConfigService } from '@nestjs/config';
import type { ConfirmChannel } from 'amqplib';
import { redactSensitiveText } from '../common/sensitive-redaction';
import {
    publishWebhookRetryAfterDelay,
    publishWebhookRetryNow,
    type WebhookRetryQueueConfig,
} from './webhook-retry-queue';
import { WebhooksService } from './webhooks.service';

const DEFAULT_RECOVERY_BATCH_SIZE = 50;
const MAX_RECOVERY_BATCH_SIZE = 500;
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const MIN_RECOVERY_INTERVAL_MS = 5_000;
const MAX_RECOVERY_INTERVAL_MS = 5 * 60_000;

export async function recoverPendingWebhookDeliveries(
    channel: ConfirmChannel,
    webhooksService: WebhooksService,
    retryConfig: WebhookRetryQueueConfig,
    batchSize: number,
): Promise<number> {
    const pending = await webhooksService.claimRecoverableRetries(batchSize);
    let queued = 0;

    for (const delivery of pending) {
        try {
            if (delivery.status === 'PENDING' && delivery.attempts > 0) {
                await publishWebhookRetryAfterDelay(channel, retryConfig, delivery.id, delivery.attempts);
            } else {
                await publishWebhookRetryNow(channel, retryConfig, delivery.id);
            }
            await webhooksService.markRetryQueued(delivery.tenantId, delivery.id);
            queued += 1;
        } catch (error) {
            console.error(
                `Webhook pending recovery failed delivery_id=${delivery.id}`,
                redactSensitiveText(error instanceof Error ? error.stack ?? error.message : error),
            );
        }
    }

    return queued;
}

export function startPendingRecoveryLoop(
    channel: ConfirmChannel,
    webhooksService: WebhooksService,
    retryConfig: WebhookRetryQueueConfig,
    configService: ConfigService,
): () => Promise<void> {
    const batchSize = resolveRecoveryBatchSize(configService);
    const intervalMs = resolveRecoveryIntervalMs(configService);
    let activeSweep: Promise<void> | null = null;

    const sweep = () => {
        if (activeSweep) {
            return;
        }
        activeSweep = recoverPendingWebhookDeliveries(channel, webhooksService, retryConfig, batchSize)
            .then(() => undefined)
            .catch((error) => {
                console.error(
                    'Webhook pending recovery sweep failed',
                    redactSensitiveText(error instanceof Error ? error.stack ?? error.message : error),
                );
            })
            .finally(() => {
                activeSweep = null;
            });
    };

    sweep();
    const timer = setInterval(sweep, intervalMs);
    timer.unref?.();
    return async () => {
        clearInterval(timer);
        await activeSweep;
    };
}

function resolveRecoveryBatchSize(configService: ConfigService): number {
    const configured = Number.parseInt(String(configService.get('WEBHOOK_PENDING_RECOVERY_BATCH_SIZE') ?? ''), 10);
    if (!Number.isFinite(configured) || configured <= 0) {
        return DEFAULT_RECOVERY_BATCH_SIZE;
    }
    return Math.min(configured, MAX_RECOVERY_BATCH_SIZE);
}

function resolveRecoveryIntervalMs(configService: ConfigService): number {
    const configured = Number.parseInt(String(configService.get('WEBHOOK_PENDING_RECOVERY_INTERVAL_MS') ?? ''), 10);
    if (!Number.isFinite(configured)) {
        return DEFAULT_RECOVERY_INTERVAL_MS;
    }
    return Math.max(MIN_RECOVERY_INTERVAL_MS, Math.min(configured, MAX_RECOVERY_INTERVAL_MS));
}
