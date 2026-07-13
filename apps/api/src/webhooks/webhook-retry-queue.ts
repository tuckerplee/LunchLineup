import type { Channel, ConfirmChannel } from 'amqplib';

const DEFAULT_RETRY_QUEUE = 'webhook_retries';
const DEFAULT_BASE_DELAY_MS = 60_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;

type ConfigReader = {
    get(key: string): unknown;
};

export type WebhookRetryQueueConfig = {
    queueName: string;
    delayQueueName: string;
    deadLetterQueueName: string;
    baseDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
};

export type WebhookRetryMessage = {
    deliveryId: string;
};

export function resolveWebhookRetryQueueConfig(configService: ConfigReader): WebhookRetryQueueConfig {
    const queueName = stringConfig(configService, 'WEBHOOK_RETRY_QUEUE_NAME', DEFAULT_RETRY_QUEUE);
    return {
        queueName,
        delayQueueName: stringConfig(configService, 'WEBHOOK_RETRY_DELAY_QUEUE_NAME', `${queueName}.delay`),
        deadLetterQueueName: stringConfig(configService, 'WEBHOOK_RETRY_DLQ_NAME', `${queueName}.dead`),
        baseDelayMs: positiveIntConfig(configService, 'WEBHOOK_RETRY_BASE_DELAY_MS', DEFAULT_BASE_DELAY_MS),
        maxDelayMs: positiveIntConfig(configService, 'WEBHOOK_RETRY_MAX_DELAY_MS', DEFAULT_MAX_DELAY_MS),
        maxAttempts: positiveIntConfig(configService, 'WEBHOOK_RETRY_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
    };
}

export async function assertWebhookRetryQueues(
    channel: Channel,
    config: WebhookRetryQueueConfig,
): Promise<void> {
    await channel.assertQueue(config.deadLetterQueueName, { durable: true });
    await channel.assertQueue(config.queueName, {
        durable: true,
        deadLetterExchange: '',
        deadLetterRoutingKey: config.deadLetterQueueName,
    });
    await channel.assertQueue(config.delayQueueName, {
        durable: true,
        deadLetterExchange: '',
        deadLetterRoutingKey: config.queueName,
    });
}

export function encodeWebhookRetryMessage(deliveryId: string): Buffer {
    return Buffer.from(JSON.stringify({ deliveryId } satisfies WebhookRetryMessage));
}

export function parseWebhookRetryMessage(content: Buffer): WebhookRetryMessage | null {
    try {
        const parsed = JSON.parse(content.toString('utf8')) as { deliveryId?: unknown };
        return typeof parsed.deliveryId === 'string' && parsed.deliveryId.trim()
            ? { deliveryId: parsed.deliveryId }
            : null;
    } catch {
        return null;
    }
}

export function retryDelayForAttempt(config: WebhookRetryQueueConfig, attempts = 1): number {
    const boundedAttempts = Math.max(1, Math.min(attempts, config.maxAttempts));
    return Math.min(2 ** (boundedAttempts - 1) * config.baseDelayMs, config.maxDelayMs);
}

export async function publishWebhookRetryAfterDelay(
    channel: ConfirmChannel,
    config: WebhookRetryQueueConfig,
    deliveryId: string,
    attempts = 1,
): Promise<void> {
    channel.sendToQueue(
        config.delayQueueName,
        encodeWebhookRetryMessage(deliveryId),
        {
            persistent: true,
            expiration: String(retryDelayForAttempt(config, attempts)),
        },
    );
    await channel.waitForConfirms();
}

export async function publishWebhookRetryAfterMs(
    channel: ConfirmChannel,
    config: WebhookRetryQueueConfig,
    deliveryId: string,
    delayMs: number,
): Promise<void> {
    const boundedDelayMs = Math.max(1_000, Math.min(Math.ceil(delayMs), 5 * 60_000));
    channel.sendToQueue(
        config.delayQueueName,
        encodeWebhookRetryMessage(deliveryId),
        {
            persistent: true,
            expiration: String(boundedDelayMs),
        },
    );
    await channel.waitForConfirms();
}

export async function publishWebhookRetryNow(
    channel: ConfirmChannel,
    config: WebhookRetryQueueConfig,
    deliveryId: string,
): Promise<void> {
    channel.sendToQueue(
        config.queueName,
        encodeWebhookRetryMessage(deliveryId),
        { persistent: true },
    );
    await channel.waitForConfirms();
}

function stringConfig(configService: ConfigReader, key: string, fallback: string): string {
    const value = String(configService.get(key) ?? '').trim();
    return value || fallback;
}

function positiveIntConfig(configService: ConfigReader, key: string, fallback: number): number {
    const configured = Number.parseInt(String(configService.get(key) ?? ''), 10);
    return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}
