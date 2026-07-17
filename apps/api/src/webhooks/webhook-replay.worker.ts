import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { runtimeErrorText } from '../common/runtime-error-diagnostic';
import { installProcessShutdownDeadline } from '../common/shutdown-deadline';
import { WebhookDeliveryStore } from './webhook-delivery.store';
import { startPendingRecoveryLoop } from './webhook-pending-recovery';
import {
    assertWebhookRetryQueues,
    parseWebhookRetryMessage,
    resolveWebhookRetryQueueConfig,
    publishWebhookRetryAfterDelay,
    publishWebhookRetryAfterMs,
    type WebhookRetryQueueConfig,
} from './webhook-retry-queue';
import { WebhooksService } from './webhooks.service';

type ReplayWorkerOptions = {
    configService?: ConfigService;
    webhooksService?: WebhooksService;
    connect?: typeof amqp.connect;
    runtime?: WebhookReplayRuntime;
    startRuntimeServer?: boolean;
};

export type WebhookReplayDeliveryLossReason =
    | 'connection_close'
    | 'connection_error'
    | 'channel_close'
    | 'channel_error'
    | 'consumer_cancel';

type ShutdownProcess = {
    exitCode?: string | number;
    once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type WebhookReplayMessageStatus = 'delivered' | 'not_found' | 'requeued' | 'dead_lettered' | 'malformed' | 'failed';

export type WebhookReplayWorkerHandle = {
    connection: AmqpConnection;
    channel: ConfirmChannel;
    runtime: WebhookReplayRuntime;
    runtimeServer?: WebhookReplayRuntimeServer;
    failure: Promise<WebhookReplayDeliveryLossReason>;
    close(): Promise<void>;
};

export type WebhookReplayHealth = {
    status: 'ok' | 'starting' | 'unhealthy';
    ready: boolean;
    deliveryLossReason: WebhookReplayDeliveryLossReason | null;
    queue: string | null;
    prefetch: number | null;
    inFlightMessages: number;
    uptimeSeconds: number;
};

export type WebhookReplayShutdownRegistration = {
    shutdown(): Promise<void>;
    dispose(): void;
};

export type WebhookReplayRuntimeServer = {
    port: number;
    close(): Promise<void>;
    forceClose(): void;
};

async function beforeShutdownDeadline<T>(
    operation: Promise<T>,
    deadlineAtMs: number,
    label: string,
): Promise<T> {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) throw new Error(`Webhook replay shutdown deadline exceeded before ${label}`);
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Webhook replay shutdown deadline exceeded during ${label}`)),
                    remainingMs,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function forceCloseReplayResources(
    connection: AmqpConnection,
    channel: ConfirmChannel,
    runtimeServer?: WebhookReplayRuntimeServer,
): void {
    const streams = new Set<unknown>([
        (channel as any)?.connection?.stream,
        (connection as any)?.connection?.stream,
        (connection as any)?.stream,
    ]);
    for (const stream of streams) {
        try {
            (stream as { destroy?: () => void } | undefined)?.destroy?.();
        } catch {
            // Forced cleanup is best effort after the aggregate deadline.
        }
    }
    runtimeServer?.forceClose();
}

export class WebhookReplayRuntime {
    public readonly registry: Registry;
    private readonly readyGauge: Gauge<string>;
    private readonly prefetchGauge: Gauge<string>;
    private readonly startedAtGauge: Gauge<string>;
    private readonly messagesTotal: Counter<'status'>;
    private readonly messageDurationSeconds: Histogram<'status'>;
    private readonly inFlightMessages: Gauge<string>;
    private readonly lastHandledTimestampSeconds: Gauge<string>;
    private readonly lastFailureTimestampSeconds: Gauge<string>;
    private readonly deliveryLossesTotal: Counter<'reason'>;
    private readonly startedAtMs = Date.now();
    private readonly idleWaiters = new Set<() => void>();
    private activeMessages = 0;
    private ready = false;
    private deliveryLossReason: WebhookReplayDeliveryLossReason | null = null;
    private queueName: string | null = null;
    private prefetch: number | null = null;

    constructor() {
        this.registry = new Registry();
        this.registry.setDefaultLabels({ app: 'lunchlineup-webhook-replay' });
        collectDefaultMetrics({ register: this.registry });

        this.readyGauge = new Gauge({
            name: 'lunchlineup_webhook_replay_ready',
            help: 'Whether the webhook replay worker has connected to RabbitMQ and started consuming messages',
            registers: [this.registry],
        });
        this.prefetchGauge = new Gauge({
            name: 'lunchlineup_webhook_replay_prefetch',
            help: 'Configured RabbitMQ prefetch for the webhook replay worker',
            registers: [this.registry],
        });
        this.startedAtGauge = new Gauge({
            name: 'lunchlineup_webhook_replay_started_timestamp_seconds',
            help: 'Unix timestamp when the webhook replay worker process initialized',
            registers: [this.registry],
        });
        this.messagesTotal = new Counter({
            name: 'lunchlineup_webhook_replay_messages_total',
            help: 'Webhook replay messages handled by bounded outcome status',
            labelNames: ['status'],
            registers: [this.registry],
        });
        this.messageDurationSeconds = new Histogram({
            name: 'lunchlineup_webhook_replay_message_duration_seconds',
            help: 'Time spent handling webhook replay messages',
            labelNames: ['status'],
            buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
            registers: [this.registry],
        });
        this.inFlightMessages = new Gauge({
            name: 'lunchlineup_webhook_replay_in_flight_messages',
            help: 'Webhook replay messages currently being handled',
            registers: [this.registry],
        });
        this.lastHandledTimestampSeconds = new Gauge({
            name: 'lunchlineup_webhook_replay_last_handled_timestamp_seconds',
            help: 'Unix timestamp of the latest handled webhook replay message',
            registers: [this.registry],
        });
        this.lastFailureTimestampSeconds = new Gauge({
            name: 'lunchlineup_webhook_replay_last_failure_timestamp_seconds',
            help: 'Unix timestamp of the latest malformed, failed, or dead-lettered webhook replay outcome',
            registers: [this.registry],
        });
        this.deliveryLossesTotal = new Counter({
            name: 'lunchlineup_webhook_replay_delivery_losses_total',
            help: 'Webhook replay delivery capability losses by bounded broker event',
            labelNames: ['reason'],
            registers: [this.registry],
        });

        this.readyGauge.set(0);
        this.inFlightMessages.set(0);
        this.startedAtGauge.set(this.startedAtMs / 1000);
    }

    markReady(queueName: string, prefetch: number): void {
        this.ready = true;
        this.deliveryLossReason = null;
        this.queueName = queueName;
        this.prefetch = prefetch;
        this.readyGauge.set(1);
        this.prefetchGauge.set(prefetch);
    }

    markNotReady(): void {
        this.ready = false;
        this.readyGauge.set(0);
    }

    markDeliveryLost(reason: WebhookReplayDeliveryLossReason): void {
        if (this.deliveryLossReason) {
            return;
        }
        this.deliveryLossReason = reason;
        this.markNotReady();
        this.deliveryLossesTotal.inc({ reason });
        this.lastFailureTimestampSeconds.set(Date.now() / 1000);
    }

    beginMessage(): number {
        this.activeMessages += 1;
        this.inFlightMessages.inc();
        return performance.now();
    }

    finishMessage(status: WebhookReplayMessageStatus, startedAtMs: number): void {
        this.activeMessages = Math.max(0, this.activeMessages - 1);
        this.inFlightMessages.dec();
        if (this.activeMessages === 0) {
            for (const resolveIdle of this.idleWaiters) {
                resolveIdle();
            }
            this.idleWaiters.clear();
        }
        this.messagesTotal.inc({ status });
        this.messageDurationSeconds.observe({ status }, (performance.now() - startedAtMs) / 1000);
        this.lastHandledTimestampSeconds.set(Date.now() / 1000);
        if (status === 'delivered' || status === 'not_found' || status === 'requeued') {
            return;
        }
        this.lastFailureTimestampSeconds.set(Date.now() / 1000);
    }

    health(): WebhookReplayHealth {
        return {
            status: this.ready ? 'ok' : this.deliveryLossReason ? 'unhealthy' : 'starting',
            ready: this.ready,
            deliveryLossReason: this.deliveryLossReason,
            queue: this.queueName,
            prefetch: this.prefetch,
            inFlightMessages: this.activeMessages,
            uptimeSeconds: Math.floor((Date.now() - this.startedAtMs) / 1000),
        };
    }

    async waitForIdle(timeoutMs: number): Promise<boolean> {
        if (this.activeMessages === 0) {
            return true;
        }
        return new Promise<boolean>((resolve) => {
            let settled = false;
            let timeout: NodeJS.Timeout;
            const finish = (drained: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                this.idleWaiters.delete(resolveIdle);
                resolve(drained);
            };
            const resolveIdle = () => finish(true);
            timeout = setTimeout(() => finish(false), timeoutMs);
            timeout.unref?.();
            this.idleWaiters.add(resolveIdle);
        });
    }

    async metrics(): Promise<string> {
        return this.registry.metrics();
    }
}

export async function startWebhookReplayWorker(
    options: ReplayWorkerOptions = {},
): Promise<WebhookReplayWorkerHandle> {
    const configService = options.configService ?? new ConfigService();
    const webhooksService = options.webhooksService
        ?? new WebhooksService(configService, new WebhookDeliveryStore(configService));
    const runtime = options.runtime ?? new WebhookReplayRuntime();
    const retryConfig = resolveWebhookRetryQueueConfig(configService);
    const rabbitUrl = String(configService.get('RABBITMQ_URL') || 'amqp://localhost');
    let runtimeServer: WebhookReplayRuntimeServer | undefined;
    let startupCleanup: (() => Promise<void>) | undefined;

    try {
        const connection = await (options.connect ?? amqp.connect)(rabbitUrl);
        const channel = await connection.createConfirmChannel();
        const prefetch = resolvePrefetch(configService);
        const shutdownTimeoutMs = resolveShutdownTimeoutMs(configService);
        let consumerTag: string | undefined;
        let stopPendingRecovery: (() => Promise<void>) | undefined;
        let closing = false;
        let closePromise: Promise<void> | undefined;
        let failureReason: WebhookReplayDeliveryLossReason | undefined;
        let resolveFailure!: (reason: WebhookReplayDeliveryLossReason) => void;
        const failure = new Promise<WebhookReplayDeliveryLossReason>((resolve) => {
            resolveFailure = resolve;
        });

        const onConnectionClose = () => deliveryCapabilityLost('connection_close');
        const onConnectionError = () => deliveryCapabilityLost('connection_error');
        const onChannelClose = () => deliveryCapabilityLost('channel_close');
        const onChannelError = () => deliveryCapabilityLost('channel_error');
        connection.on('close', onConnectionClose);
        connection.on('error', onConnectionError);
        channel.on('close', onChannelClose);
        channel.on('error', onChannelError);

        const detachTransportListeners = () => {
            connection.off('close', onConnectionClose);
            connection.off('error', onConnectionError);
            channel.off('close', onChannelClose);
            channel.off('error', onChannelError);
        };

        const performClose = (): Promise<void> => {
            closing = true;
            closePromise ??= (async () => {
                runtime.markNotReady();
                detachTransportListeners();
                const deadlineAtMs = Date.now() + shutdownTimeoutMs;
                let firstError: unknown;
                if (stopPendingRecovery) {
                    try {
                        await beforeShutdownDeadline(
                            stopPendingRecovery(),
                            deadlineAtMs,
                            'pending recovery stop',
                        );
                    } catch (error) {
                        firstError ??= error;
                    }
                }
                if (consumerTag) {
                    try {
                        await beforeShutdownDeadline(
                            channel.cancel(consumerTag),
                            deadlineAtMs,
                            'consumer cancellation',
                        );
                    } catch (error) {
                        firstError ??= error;
                    }
                }
                const drained = await runtime.waitForIdle(Math.max(1, deadlineAtMs - Date.now()));
                if (!drained) {
                    console.warn(
                        'Webhook replay shutdown timed out with '
                        + runtime.health().inFlightMessages
                        + ' message(s) in flight',
                    );
                }
                const closeOperations: Array<[string, () => Promise<unknown>]> = [
                    ['channel close', () => channel.close()],
                    ['connection close', () => connection.close()],
                    ['runtime server close', () => runtimeServer?.close() ?? Promise.resolve()],
                ];
                for (const [label, closeOperation] of closeOperations) {
                    try {
                        await beforeShutdownDeadline(closeOperation(), deadlineAtMs, label);
                    } catch (error) {
                        firstError ??= error;
                    }
                }
                if (Date.now() >= deadlineAtMs) {
                    forceCloseReplayResources(connection, channel, runtimeServer);
                }
                if (firstError) {
                    forceCloseReplayResources(connection, channel, runtimeServer);
                    throw firstError;
                }
            })();
            return closePromise;
        };
        startupCleanup = performClose;

        function deliveryCapabilityLost(reason: WebhookReplayDeliveryLossReason): void {
            if (closing || failureReason) {
                return;
            }
            failureReason = reason;
            runtime.markDeliveryLost(reason);
            console.error(`Webhook replay delivery capability lost reason=${reason}`);
            resolveFailure(reason);
            void performClose().catch(() => {
                console.error(`Webhook replay failure cleanup failed reason=${reason}`);
            });
        }

        await assertWebhookRetryQueues(channel, retryConfig);
        await channel.prefetch(prefetch);
        const consumer = await channel.consume(
            retryConfig.queueName,
            (message) => {
                if (!message) {
                    deliveryCapabilityLost('consumer_cancel');
                    return;
                }
                void handleReplayMessage(channel, webhooksService, retryConfig, message, runtime);
            },
            { noAck: false },
        );
        consumerTag = consumer.consumerTag;
        if (failureReason) {
            await performClose().catch(() => undefined);
            throw new Error('Webhook replay delivery capability was lost during startup');
        }

        stopPendingRecovery = startPendingRecoveryLoop(
            channel,
            webhooksService,
            retryConfig,
            configService,
        );

        if (options.startRuntimeServer !== false) {
            runtimeServer = await startWebhookReplayRuntimeServer(runtime, configService);
        }

        runtime.markReady(retryConfig.queueName, prefetch);
        console.log(`Webhook replay worker consuming ${retryConfig.queueName} with prefetch=${prefetch}`);

        return {
            connection,
            channel,
            runtime,
            runtimeServer,
            failure,
            close: performClose,
        };
    } catch (error) {
        runtime.markNotReady();
        if (startupCleanup) {
            await startupCleanup().catch(() => undefined);
        } else {
            await runtimeServer?.close();
        }
        throw error;
    }
}

export async function handleReplayMessage(
    channel: ConfirmChannel,
    webhooksService: WebhooksService,
    retryConfig: WebhookRetryQueueConfig,
    message: ConsumeMessage | null,
    runtime?: WebhookReplayRuntime,
): Promise<void> {
    if (!message) {
        return;
    }

    const startedAtMs = runtime?.beginMessage();
    let status: WebhookReplayMessageStatus = 'failed';
    let terminalAttempt = false;

    try {
        const parsed = parseWebhookRetryMessage(message.content);
        if (!parsed) {
            console.error('Discarding malformed webhook retry message');
            status = 'malformed';
            channel.ack(message);
            return;
        }

        const result = await webhooksService.replayDelivery(parsed.deliveryId);
        if (result.status === 'delivered' || result.status === 'not_found') {
            status = result.status;
            channel.ack(message);
            return;
        }

        if (result.status === 'deferred') {
            await publishWebhookRetryAfterMs(
                channel,
                retryConfig,
                result.deliveryId,
                result.retryAfterMs ?? retryConfig.baseDelayMs,
            );
            if (!result.tenantId) {
                throw new Error('Deferred webhook replay is missing its tenant');
            }
            await recordConfirmedRetryPublication(webhooksService, result.tenantId, result.deliveryId);
            status = 'requeued';
            channel.ack(message);
            return;
        }

        const attempts = result.attempts ?? 1;
        if (result.tenantId && attempts >= retryConfig.maxAttempts) {
            terminalAttempt = true;
            await webhooksService.deadLetterDelivery(
                result.tenantId,
                result.deliveryId,
                result.error ?? `Webhook replay exceeded ${retryConfig.maxAttempts} attempts`,
                attempts,
            );
            status = 'dead_lettered';
            channel.nack(message, false, false);
            return;
        }

        await publishWebhookRetryAfterDelay(
            channel,
            retryConfig,
            result.deliveryId,
            attempts,
        );
        if (!result.tenantId) {
            throw new Error('Failed webhook replay is missing its tenant');
        }
        await recordConfirmedRetryPublication(webhooksService, result.tenantId, result.deliveryId);
        status = 'requeued';
        channel.ack(message);
    } catch (error) {
        status = 'failed';
        console.error(`Webhook replay worker failed ${runtimeErrorText(error)}`);
        channel.nack(message, false, !terminalAttempt);
    } finally {
        if (runtime && startedAtMs !== undefined) {
            runtime.finishMessage(status, startedAtMs);
        }
    }
}

async function recordConfirmedRetryPublication(
    webhooksService: WebhooksService,
    tenantId: string,
    deliveryId: string,
): Promise<void> {
    try {
        await webhooksService.markRetryQueued(tenantId, deliveryId);
    } catch (error) {
        console.error(`Webhook retry publication state update failed ${runtimeErrorText(error)}`);
    }
}

export async function startWebhookReplayRuntimeServer(
    runtime: WebhookReplayRuntime,
    configService: ConfigService = new ConfigService(),
): Promise<WebhookReplayRuntimeServer> {
    const port = resolveMetricsPort(configService);
    const host = stringConfig(configService, 'WEBHOOK_REPLAY_METRICS_HOST', '0.0.0.0');
    const server = createServer((req, res) => {
        void handleRuntimeRequest(runtime, req, res).catch(() => {
            if (!res.headersSent) {
                writeText(res, 500, 'runtime endpoint failed');
            } else {
                res.end();
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
            server.off('error', onError);
            resolve();
        });
    });

    const address = server.address();
    return {
        port: boundPort(address, port),
        close: () => closeServer(server),
        forceClose: () => {
            server.closeAllConnections?.();
            server.close();
        },
    };
}

async function handleRuntimeRequest(
    runtime: WebhookReplayRuntime,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    if (req.method !== 'GET') {
        writeText(res, 405, 'method not allowed');
        return;
    }

    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/health') {
        const health = runtime.health();
        writeJson(res, health.ready ? 200 : 503, health);
        return;
    }
    if (path === '/metrics') {
        const body = await runtime.metrics();
        res.writeHead(200, {
            'Content-Type': runtime.registry.contentType,
            'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
    }

    writeText(res, 404, 'not found');
}

function resolvePrefetch(configService: ConfigService): number {
    const configured = Number.parseInt(String(configService.get('WEBHOOK_RETRY_WORKER_PREFETCH') ?? ''), 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 5;
}

function resolveMetricsPort(configService: ConfigService): number {
    const configured = Number.parseInt(String(configService.get('WEBHOOK_REPLAY_METRICS_PORT') ?? ''), 10);
    return Number.isFinite(configured) && configured >= 0 && configured <= 65535 ? configured : 3004;
}

function resolveShutdownTimeoutMs(configService: ConfigService): number {
    const configured = Number.parseInt(String(configService.get('WEBHOOK_REPLAY_SHUTDOWN_TIMEOUT_MS') ?? ''), 10);
    return Number.isFinite(configured) && configured >= 1_000 && configured <= 120_000 ? configured : 30_000;
}

function stringConfig(configService: ConfigService, key: string, fallback: string): string {
    const value = String(configService.get(key) ?? '').trim();
    return value || fallback;
}

function boundPort(address: string | AddressInfo | null, fallback: number): number {
    return typeof address === 'object' && address ? address.port : fallback;
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
}

function writeText(res: ServerResponse, statusCode: number, body: string): void {
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

export function registerWebhookReplayShutdown(
    worker: Pick<WebhookReplayWorkerHandle, 'close'>,
    runtimeProcess: ShutdownProcess = process,
): WebhookReplayShutdownRegistration {
    let shutdownPromise: Promise<void> | undefined;
    const dispose = () => {
        runtimeProcess.off('SIGINT', onSignal);
        runtimeProcess.off('SIGTERM', onSignal);
    };
    const shutdown = () => {
        shutdownPromise ??= worker.close()
            .catch((error) => {
                runtimeProcess.exitCode = 1;
                console.error(`Webhook replay worker failed to close ${runtimeErrorText(error)}`);
            })
            .finally(dispose);
        return shutdownPromise;
    };
    const onSignal = () => {
        void shutdown();
    };

    runtimeProcess.once('SIGINT', onSignal);
    runtimeProcess.once('SIGTERM', onSignal);
    return { shutdown, dispose };
}

if (require.main === module) {
    installProcessShutdownDeadline();
    startWebhookReplayWorker()
        .then((worker) => {
            registerWebhookReplayShutdown(worker);
            void worker.failure.then((reason) => {
                process.exitCode = 1;
                console.error(`Webhook replay worker terminating reason=${reason}`);
            });
        })
        .catch((error) => {
            console.error(`Webhook replay worker failed to start ${runtimeErrorText(error)}`);
            process.exitCode = 1;
        });
}
