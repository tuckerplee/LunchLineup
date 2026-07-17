import { describe, expect, it, vi } from 'vitest';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { EventEmitter } from 'node:events';
import {
    handleReplayMessage,
    registerWebhookReplayShutdown,
    startWebhookReplayWorker,
    startWebhookReplayRuntimeServer,
    WebhookReplayRuntime,
} from './webhook-replay.worker';
import { recoverPendingWebhookDeliveries } from './webhook-pending-recovery';
import {
    parseWebhookRetryMessage,
    resolveWebhookRetryQueueConfig,
    retryDelayForAttempt,
    type WebhookRetryQueueConfig,
} from './webhook-retry-queue';

function retryConfig(overrides: Partial<WebhookRetryQueueConfig> = {}): WebhookRetryQueueConfig {
    return {
        queueName: 'webhook_retries',
        delayQueueName: 'webhook_retries.delay',
        deadLetterQueueName: 'webhook_retries.dead',
        baseDelayMs: 60_000,
        maxDelayMs: 300_000,
        maxAttempts: 4,
        ...overrides,
    };
}

function message(content: unknown): ConsumeMessage {
    return {
        content: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
    } as ConsumeMessage;
}

function channelMock() {
    return {
        ack: vi.fn(),
        nack: vi.fn(),
        sendToQueue: vi.fn().mockReturnValue(true),
        waitForConfirms: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConfirmChannel & {
        ack: ReturnType<typeof vi.fn>;
        nack: ReturnType<typeof vi.fn>;
        sendToQueue: ReturnType<typeof vi.fn>;
        waitForConfirms: ReturnType<typeof vi.fn>;
    };
}

function supervisedTransport(consumerTag = 'consumer-1') {
    let consumerCallback: ((message: ConsumeMessage | null) => unknown) | undefined;
    const channel = Object.assign(new EventEmitter(), {
        assertQueue: vi.fn().mockResolvedValue(undefined),
        prefetch: vi.fn().mockResolvedValue(undefined),
        consume: vi.fn().mockImplementation(async (
            _queue: string,
            callback: (message: ConsumeMessage | null) => unknown,
        ) => {
            consumerCallback = callback;
            return { consumerTag };
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
    });
    const connection = Object.assign(new EventEmitter(), {
        createConfirmChannel: vi.fn().mockResolvedValue(channel),
        close: vi.fn().mockResolvedValue(undefined),
    });
    return {
        channel,
        connection,
        cancelConsumer() {
            if (!consumerCallback) {
                throw new Error('consumer callback was not registered');
            }
            consumerCallback(null);
        },
    };
}

function workerConfig() {
    return {
        get: vi.fn((key: string) => ({
            RABBITMQ_URL: 'amqp://rabbit',
            WEBHOOK_PENDING_RECOVERY_INTERVAL_MS: '60000',
        }[key])),
    } as any;
}

describe('webhook retry queue helpers', () => {
    it('parses only opaque delivery-id retry messages', () => {
        expect(parseWebhookRetryMessage(Buffer.from(JSON.stringify({ deliveryId: 'delivery-1' })))).toEqual({
            deliveryId: 'delivery-1',
        });
        expect(parseWebhookRetryMessage(Buffer.from('{'))).toBeNull();
        expect(parseWebhookRetryMessage(Buffer.from(JSON.stringify({ url: 'https://example.com' })))).toBeNull();
    });

    it('resolves bounded retry queue config and exponential delay', () => {
        const config = resolveWebhookRetryQueueConfig({
            get: vi.fn((key: string) => ({
                WEBHOOK_RETRY_QUEUE_NAME: 'custom.webhooks',
                WEBHOOK_RETRY_BASE_DELAY_MS: '1000',
                WEBHOOK_RETRY_MAX_DELAY_MS: '5000',
                WEBHOOK_RETRY_MAX_ATTEMPTS: '9',
            }[key])),
        });

        expect(config).toEqual({
            queueName: 'custom.webhooks',
            delayQueueName: 'custom.webhooks.delay',
            deadLetterQueueName: 'custom.webhooks.dead',
            baseDelayMs: 1000,
            maxDelayMs: 5000,
            maxAttempts: 9,
        });
        expect(retryDelayForAttempt(config, 1)).toBe(1000);
        expect(retryDelayForAttempt(config, 3)).toBe(4000);
        expect(retryDelayForAttempt(config, 9)).toBe(5000);
    });
});

describe('startWebhookReplayWorker', () => {
    it('consumes and publishes on a confirm channel', async () => {
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { channel, connection } = supervisedTransport();
        const service = {
            claimRecoverableRetries: vi.fn().mockResolvedValue([]),
        };

        const worker = await startWebhookReplayWorker({
            configService: workerConfig(),
            webhooksService: service as any,
            connect: vi.fn().mockResolvedValue(connection) as any,
            startRuntimeServer: false,
        });

        expect(connection.createConfirmChannel).toHaveBeenCalledOnce();
        expect(channel.consume).toHaveBeenCalledOnce();
        await worker.close();
        expect(channel.cancel).toHaveBeenCalledWith('consumer-1');
        expect(channel.close).toHaveBeenCalledOnce();
        expect(connection.close).toHaveBeenCalledOnce();
        expect(channel.listenerCount('close')).toBe(0);
        expect(channel.listenerCount('error')).toBe(0);
        expect(connection.listenerCount('close')).toBe(0);
        expect(connection.listenerCount('error')).toBe(0);
        consoleLog.mockRestore();
    });

    it('cancels consumption and drains in-flight work before closing transports', async () => {
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const runtime = new WebhookReplayRuntime();
        const startedAtMs = runtime.beginMessage();
        const { channel, connection } = supervisedTransport('consumer-drain');
        const worker = await startWebhookReplayWorker({
            configService: {
                get: vi.fn((key: string) => ({
                    RABBITMQ_URL: 'amqp://rabbit',
                    WEBHOOK_PENDING_RECOVERY_INTERVAL_MS: '60000',
                    WEBHOOK_REPLAY_SHUTDOWN_TIMEOUT_MS: '1000',
                }[key])),
            } as any,
            webhooksService: { claimRecoverableRetries: vi.fn().mockResolvedValue([]) } as any,
            connect: vi.fn().mockResolvedValue(connection) as any,
            runtime,
            startRuntimeServer: false,
        });

        const closing = worker.close();
        await vi.waitFor(() => expect(channel.cancel).toHaveBeenCalledWith('consumer-drain'));
        expect(channel.close).not.toHaveBeenCalled();

        runtime.finishMessage('delivered', startedAtMs);
        await closing;

        expect(channel.close).toHaveBeenCalledOnce();
        expect(connection.close).toHaveBeenCalledOnce();
        consoleLog.mockRestore();
    });

    it('bounds hung transport close and force-destroys the Rabbit socket', async () => {
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const destroy = vi.fn();
        const { channel, connection } = supervisedTransport('consumer-hung-close');
        channel.close.mockImplementation(() => new Promise(() => undefined));
        (connection as any).connection = { stream: { destroy } };
        const worker = await startWebhookReplayWorker({
            configService: {
                get: vi.fn((key: string) => ({
                    RABBITMQ_URL: 'amqp://rabbit',
                    WEBHOOK_PENDING_RECOVERY_INTERVAL_MS: '60000',
                    WEBHOOK_REPLAY_SHUTDOWN_TIMEOUT_MS: '1000',
                }[key])),
            } as any,
            webhooksService: { claimRecoverableRetries: vi.fn().mockResolvedValue([]) } as any,
            connect: vi.fn().mockResolvedValue(connection) as any,
            startRuntimeServer: false,
        });

        const startedAt = Date.now();
        await expect(worker.close()).rejects.toThrow(/shutdown deadline exceeded during channel close/);
        expect(Date.now() - startedAt).toBeLessThan(1_500);
        expect(destroy).toHaveBeenCalled();
        consoleLog.mockRestore();
    });

    it.each([
        ['connection close', 'connection', 'close', 'connection_close'],
        ['connection error', 'connection', 'error', 'connection_error'],
        ['channel close', 'channel', 'close', 'channel_close'],
        ['channel error', 'channel', 'error', 'channel_error'],
    ] as const)(
        'fails health and closes exactly once on %s',
        async (_label, target, event, reason) => {
            const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            const transport = supervisedTransport();
            const worker = await startWebhookReplayWorker({
                configService: workerConfig(),
                webhooksService: { claimRecoverableRetries: vi.fn().mockResolvedValue([]) } as any,
                connect: vi.fn().mockResolvedValue(transport.connection) as any,
                startRuntimeServer: false,
            });

            transport[target].emit(event, new Error('RABBITMQ_PASSWORD=secret'));

            expect(worker.runtime.health()).toMatchObject({
                status: 'unhealthy',
                ready: false,
                deliveryLossReason: reason,
            });
            await expect(worker.failure).resolves.toBe(reason);
            await vi.waitFor(() => expect(transport.connection.close).toHaveBeenCalledOnce());

            expect(transport.channel.consume).toHaveBeenCalledOnce();
            expect(transport.channel.cancel).toHaveBeenCalledOnce();
            expect(transport.channel.close).toHaveBeenCalledOnce();
            expect(transport.connection.listenerCount('close')).toBe(0);
            expect(transport.connection.listenerCount('error')).toBe(0);
            expect(transport.channel.listenerCount('close')).toBe(0);
            expect(transport.channel.listenerCount('error')).toBe(0);
            expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret');
            const metrics = await worker.runtime.metrics();
            expect(metrics).toContain(`reason="${reason}"`);
            consoleLog.mockRestore();
            consoleError.mockRestore();
        },
    );

    it('fails health immediately when RabbitMQ cancels the consumer', async () => {
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const transport = supervisedTransport('consumer-cancelled');
        const worker = await startWebhookReplayWorker({
            configService: workerConfig(),
            webhooksService: { claimRecoverableRetries: vi.fn().mockResolvedValue([]) } as any,
            connect: vi.fn().mockResolvedValue(transport.connection) as any,
            startRuntimeServer: false,
        });

        transport.cancelConsumer();

        expect(worker.runtime.health()).toMatchObject({
            status: 'unhealthy',
            ready: false,
            deliveryLossReason: 'consumer_cancel',
        });
        await expect(worker.failure).resolves.toBe('consumer_cancel');
        await vi.waitFor(() => expect(transport.connection.close).toHaveBeenCalledOnce());
        expect(transport.channel.consume).toHaveBeenCalledOnce();
        expect(transport.channel.cancel).toHaveBeenCalledWith('consumer-cancelled');
        consoleLog.mockRestore();
        consoleError.mockRestore();
    });

    it('registers idempotent SIGINT and SIGTERM closure', async () => {
        const listeners = new Map<string, () => void>();
        const runtimeProcess = {
            exitCode: undefined as number | undefined,
            once: vi.fn((signal: string, listener: () => void) => listeners.set(signal, listener)),
            off: vi.fn((signal: string) => listeners.delete(signal)),
        };
        const close = vi.fn().mockResolvedValue(undefined);
        const registration = registerWebhookReplayShutdown({ close }, runtimeProcess);

        listeners.get('SIGTERM')?.();
        await registration.shutdown();
        await registration.shutdown();

        expect(close).toHaveBeenCalledOnce();
        expect(runtimeProcess.off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
        expect(runtimeProcess.off).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
        expect(runtimeProcess.exitCode).toBeUndefined();
    });
});

describe('handleReplayMessage', () => {
    it('acks delivered webhook replays', async () => {
        const channel = channelMock();
        const service = {
            replayDelivery: vi.fn().mockResolvedValue({ deliveryId: 'delivery-1', status: 'delivered' }),
            deadLetterDelivery: vi.fn(),
        };

        await handleReplayMessage(channel, service as any, retryConfig(), message({ deliveryId: 'delivery-1' }));

        expect(service.replayDelivery).toHaveBeenCalledWith('delivery-1');
        expect(channel.ack).toHaveBeenCalledOnce();
        expect(channel.sendToQueue).not.toHaveBeenCalled();
    });

    it('requeues failed webhook replays through the delay queue', async () => {
        const channel = channelMock();
        const service = {
            replayDelivery: vi.fn().mockResolvedValue({
                deliveryId: 'delivery-1',
                tenantId: 'tenant-1',
                status: 'failed',
                attempts: 2,
            }),
            deadLetterDelivery: vi.fn(),
            markRetryQueued: vi.fn().mockResolvedValue(undefined),
        };

        await handleReplayMessage(channel, service as any, retryConfig(), message({ deliveryId: 'delivery-1' }));

        expect(channel.sendToQueue).toHaveBeenCalledWith(
            'webhook_retries.delay',
            Buffer.from(JSON.stringify({ deliveryId: 'delivery-1' })),
            { persistent: true, expiration: '120000' },
        );
        expect(service.deadLetterDelivery).not.toHaveBeenCalled();
        expect(channel.waitForConfirms).toHaveBeenCalledOnce();
        expect(service.markRetryQueued).toHaveBeenCalledWith('tenant-1', 'delivery-1');
        expect(channel.ack).toHaveBeenCalledOnce();
    });

    it('updates retry state and acks the source only after the broker confirm', async () => {
        const channel = channelMock();
        channel.sendToQueue.mockReturnValue(false);
        let confirmPublish!: () => void;
        channel.waitForConfirms.mockImplementation(() => new Promise<void>((resolve) => {
            confirmPublish = resolve;
        }));
        const service = {
            replayDelivery: vi.fn().mockResolvedValue({
                deliveryId: 'delivery-1',
                tenantId: 'tenant-1',
                status: 'failed',
                attempts: 2,
            }),
            deadLetterDelivery: vi.fn(),
            markRetryQueued: vi.fn().mockResolvedValue(undefined),
        };

        const handling = handleReplayMessage(
            channel,
            service as any,
            retryConfig(),
            message({ deliveryId: 'delivery-1' }),
        );

        await vi.waitFor(() => expect(channel.waitForConfirms).toHaveBeenCalledOnce());
        expect(service.markRetryQueued).not.toHaveBeenCalled();
        expect(channel.ack).not.toHaveBeenCalled();

        confirmPublish();
        await handling;

        expect(service.markRetryQueued).toHaveBeenCalledOnce();
        expect(channel.ack).toHaveBeenCalledOnce();
        expect(service.markRetryQueued.mock.invocationCallOrder[0])
            .toBeLessThan(channel.ack.mock.invocationCallOrder[0]);
    });

    it('nacks the source without changing queue state when the broker rejects a retry publish', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const channel = channelMock();
        channel.waitForConfirms.mockRejectedValue(new Error('broker nack'));
        const service = {
            replayDelivery: vi.fn().mockResolvedValue({
                deliveryId: 'delivery-1',
                tenantId: 'tenant-1',
                status: 'failed',
                attempts: 2,
            }),
            deadLetterDelivery: vi.fn(),
            markRetryQueued: vi.fn(),
        };

        await handleReplayMessage(channel, service as any, retryConfig(), message({ deliveryId: 'delivery-1' }));

        expect(service.markRetryQueued).not.toHaveBeenCalled();
        expect(channel.ack).not.toHaveBeenCalled();
        expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
        vi.restoreAllMocks();
    });

    it('acks a broker-confirmed replacement without hot-looping when the queue-state write fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const channel = channelMock();
        const service = {
            replayDelivery: vi.fn().mockResolvedValue({
                deliveryId: 'delivery-1',
                tenantId: 'tenant-1',
                status: 'failed',
                attempts: 2,
            }),
            deadLetterDelivery: vi.fn(),
            markRetryQueued: vi.fn().mockRejectedValue(new Error('database unavailable')),
        };

        await handleReplayMessage(channel, service as any, retryConfig(), message({ deliveryId: 'delivery-1' }));

        expect(channel.waitForConfirms).toHaveBeenCalledOnce();
        expect(channel.ack).toHaveBeenCalledOnce();
        expect(channel.nack).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it('delays redelivery until an active replay lease can be reclaimed', async () => {
        const channel = channelMock();
        const service = {
            replayDelivery: vi.fn().mockResolvedValue({
                deliveryId: 'delivery-1',
                tenantId: 'tenant-1',
                status: 'deferred',
                attempts: 2,
                retryAfterMs: 37_500,
            }),
            deadLetterDelivery: vi.fn(),
            markRetryQueued: vi.fn().mockResolvedValue(undefined),
        };

        await handleReplayMessage(channel, service as any, retryConfig(), message({ deliveryId: 'delivery-1' }));

        expect(channel.sendToQueue).toHaveBeenCalledWith(
            'webhook_retries.delay',
            Buffer.from(JSON.stringify({ deliveryId: 'delivery-1' })),
            { persistent: true, expiration: '37500' },
        );
        expect(service.deadLetterDelivery).not.toHaveBeenCalled();
        expect(channel.waitForConfirms).toHaveBeenCalledOnce();
        expect(service.markRetryQueued).toHaveBeenCalledWith('tenant-1', 'delivery-1');
        expect(channel.ack).toHaveBeenCalledOnce();
        expect(channel.nack).not.toHaveBeenCalled();
    });

    it('dead-letters failed webhook replays through the queue DLX after the max attempt count', async () => {
        const channel = channelMock();
        const service = {
            replayDelivery: vi.fn().mockResolvedValue({
                deliveryId: 'delivery-1',
                tenantId: 'tenant-1',
                status: 'failed',
                attempts: 4,
                error: 'HTTP 500',
            }),
            deadLetterDelivery: vi.fn().mockResolvedValue(undefined),
        };

        await handleReplayMessage(channel, service as any, retryConfig(), message({ deliveryId: 'delivery-1' }));

        expect(service.deadLetterDelivery).toHaveBeenCalledWith('tenant-1', 'delivery-1', 'HTTP 500', 4);
        expect(channel.sendToQueue).not.toHaveBeenCalled();
        expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
        expect(channel.ack).not.toHaveBeenCalled();
    });

    it('does not unboundedly requeue a terminal attempt when durable dead-letter marking fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const channel = channelMock();
        const service = {
            replayDelivery: vi.fn().mockResolvedValue({
                deliveryId: 'delivery-1',
                tenantId: 'tenant-1',
                status: 'failed',
                attempts: 4,
            }),
            deadLetterDelivery: vi.fn().mockRejectedValue(new Error('database unavailable')),
        };

        await handleReplayMessage(channel, service as any, retryConfig(), message({ deliveryId: 'delivery-1' }));

        expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
        expect(channel.ack).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it('nacks unexpected worker failures for broker redelivery', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const channel = channelMock();
        const service = {
            replayDelivery: vi.fn().mockRejectedValue(new Error('RABBITMQ_PASSWORD=secret')),
            deadLetterDelivery: vi.fn(),
        };

        await handleReplayMessage(channel, service as any, retryConfig(), message({ deliveryId: 'delivery-1' }));

        expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
        expect(channel.ack).not.toHaveBeenCalled();
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret');

        vi.restoreAllMocks();
    });

    it('exports bounded replay outcome metrics', async () => {
        const runtime = new WebhookReplayRuntime();
        runtime.markReady('webhook_retries', 5);
        const channel = channelMock();
        const service = {
            replayDelivery: vi.fn().mockResolvedValue({ deliveryId: 'delivery-1', status: 'delivered' }),
            deadLetterDelivery: vi.fn(),
        };

        await handleReplayMessage(
            channel,
            service as any,
            retryConfig(),
            message({ deliveryId: 'delivery-1' }),
            runtime,
        );

        const metrics = await runtime.metrics();
        expect(runtime.health()).toMatchObject({
            status: 'ok',
            ready: true,
            queue: 'webhook_retries',
            prefetch: 5,
        });
        expect(metrics).toMatch(/lunchlineup_webhook_replay_ready(?:\{[^}]*\})? 1/);
        expect(metrics).toMatch(/lunchlineup_webhook_replay_messages_total\{[^}]*status="delivered"[^}]*\} 1/);
        expect(metrics).toMatch(/lunchlineup_webhook_replay_in_flight_messages(?:\{[^}]*\})? 0/);
    });
});

describe('pending webhook recovery', () => {
    it('republishes a bounded claimed batch and marks only broker-confirmed rows queued', async () => {
        const channel = channelMock();
        const service = {
            claimRecoverableRetries: vi.fn().mockResolvedValue([
                { id: 'delivery-0', tenantId: 'tenant-0', status: 'PENDING', attempts: 0 },
                { id: 'delivery-1', tenantId: 'tenant-1', status: 'PENDING', attempts: 1 },
                { id: 'delivery-2', tenantId: 'tenant-2', status: 'FAILED', attempts: 3 },
                { id: 'delivery-3', tenantId: 'tenant-3', status: 'QUEUED', attempts: 2 },
            ]),
            markRetryQueued: vi.fn().mockResolvedValue(undefined),
        };

        const recovered = await recoverPendingWebhookDeliveries(
            channel,
            service as any,
            retryConfig(),
            25,
        );

        expect(service.claimRecoverableRetries).toHaveBeenCalledWith(25);
        expect(channel.sendToQueue).toHaveBeenCalledTimes(4);
        expect(channel.sendToQueue).toHaveBeenNthCalledWith(
            1,
            'webhook_retries',
            Buffer.from(JSON.stringify({ deliveryId: 'delivery-0' })),
            { persistent: true },
        );
        expect(channel.sendToQueue).toHaveBeenNthCalledWith(
            2,
            'webhook_retries.delay',
            Buffer.from(JSON.stringify({ deliveryId: 'delivery-1' })),
            { persistent: true, expiration: '60000' },
        );
        expect(channel.sendToQueue).toHaveBeenNthCalledWith(
            3,
            'webhook_retries',
            Buffer.from(JSON.stringify({ deliveryId: 'delivery-2' })),
            { persistent: true },
        );
        expect(channel.sendToQueue).toHaveBeenNthCalledWith(
            4,
            'webhook_retries',
            Buffer.from(JSON.stringify({ deliveryId: 'delivery-3' })),
            { persistent: true },
        );
        expect(channel.waitForConfirms).toHaveBeenCalledTimes(4);
        expect(service.markRetryQueued).toHaveBeenNthCalledWith(1, 'tenant-0', 'delivery-0');
        expect(service.markRetryQueued).toHaveBeenNthCalledWith(2, 'tenant-1', 'delivery-1');
        expect(service.markRetryQueued).toHaveBeenNthCalledWith(3, 'tenant-2', 'delivery-2');
        expect(service.markRetryQueued).toHaveBeenNthCalledWith(4, 'tenant-3', 'delivery-3');
        expect(recovered).toBe(4);
    });

    it('leaves the leased row pending when the worker crashes before marking it queued', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const channel = channelMock();
        const service = {
            claimRecoverableRetries: vi.fn().mockResolvedValue([
                { id: 'delivery-1', tenantId: 'tenant-1', status: 'PENDING', attempts: 1 },
            ]),
            markRetryQueued: vi.fn().mockRejectedValue(new Error('worker stopped')),
        };

        const recovered = await recoverPendingWebhookDeliveries(
            channel,
            service as any,
            retryConfig(),
            25,
        );

        expect(channel.sendToQueue).toHaveBeenCalledOnce();
        expect(service.markRetryQueued).toHaveBeenCalledOnce();
        expect(recovered).toBe(0);
        vi.restoreAllMocks();
    });

    it('does not mark a pending row queued while RabbitMQ is unavailable', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const channel = channelMock();
        channel.waitForConfirms.mockRejectedValue(new Error('broker nack'));
        const service = {
            claimRecoverableRetries: vi.fn().mockResolvedValue([
                { id: 'delivery-1', tenantId: 'tenant-1', status: 'PENDING', attempts: 1 },
            ]),
            markRetryQueued: vi.fn(),
        };

        const recovered = await recoverPendingWebhookDeliveries(
            channel,
            service as any,
            retryConfig(),
            25,
        );

        expect(service.markRetryQueued).not.toHaveBeenCalled();
        expect(recovered).toBe(0);
        vi.restoreAllMocks();
    });
});

describe('webhook replay runtime server', () => {
    it('serves health and Prometheus metrics', async () => {
        const runtime = new WebhookReplayRuntime();
        const server = await startWebhookReplayRuntimeServer(runtime, {
            get: vi.fn((key: string) => ({
                WEBHOOK_REPLAY_METRICS_HOST: '127.0.0.1',
                WEBHOOK_REPLAY_METRICS_PORT: '0',
            }[key])),
        } as any);

        try {
            const startingHealth = await fetch(`http://127.0.0.1:${server.port}/health`);
            expect(startingHealth.status).toBe(503);
            expect(await startingHealth.json()).toMatchObject({ status: 'starting', ready: false });

            runtime.markReady('webhook_retries', 5);
            const readyHealth = await fetch(`http://127.0.0.1:${server.port}/health`);
            expect(readyHealth.status).toBe(200);
            expect(await readyHealth.json()).toMatchObject({
                status: 'ok',
                ready: true,
                queue: 'webhook_retries',
                prefetch: 5,
            });

            const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
            expect(metrics.status).toBe(200);
            expect(metrics.headers.get('content-type')).toContain('text/plain');
            expect(await metrics.text()).toContain('lunchlineup_webhook_replay_ready');
        } finally {
            await server.close();
        }
    });
});
