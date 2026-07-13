import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { redactSensitiveText } from '../common/sensitive-redaction';
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

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;
type WebhookReplayMessageStatus = 'delivered' | 'not_found' | 'requeued' | 'dead_lettered' | 'malformed' | 'failed';

export type WebhookReplayWorkerHandle = {
    connection: AmqpConnection;
    channel: ConfirmChannel;
    runtime: WebhookReplayRuntime;
    runtimeServer?: WebhookReplayRuntimeServer;
    close(): Promise<void>;
};

export type WebhookReplayHealth = {
    status: 'ok' | 'starting';
    ready: boolean;
    queue: string | null;
    prefetch: number | null;
    uptimeSeconds: number;
};

export type WebhookReplayRuntimeServer = {
    port: number;
    close(): Promise<void>;
};

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
    private readonly startedAtMs = Date.now();
    private ready = false;
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

        this.readyGauge.set(0);
        this.inFlightMessages.set(0);
        this.startedAtGauge.set(this.startedAtMs / 1000);
    }

    markReady(queueName: string, prefetch: number): void {
        this.ready = true;
        this.queueName = queueName;
        this.prefetch = prefetch;
        this.readyGauge.set(1);
        this.prefetchGauge.set(prefetch);
    }

    markNotReady(): void {
        this.ready = false;
        this.readyGauge.set(0);
    }

    beginMessage(): number {
        this.inFlightMessages.inc();
        return performance.now();
    }

    finishMessage(status: WebhookReplayMessageStatus, startedAtMs: number): void {
        this.inFlightMessages.dec();
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
            status: this.ready ? 'ok' : 'starting',
            ready: this.ready,
            queue: this.queueName,
            prefetch: this.prefetch,
            uptimeSeconds: Math.floor((Date.now() - this.startedAtMs) / 1000),
        };
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

    try {
        if (options.startRuntimeServer !== false) {
            runtimeServer = await startWebhookReplayRuntimeServer(runtime, configService);
        }

        const connection = await (options.connect ?? amqp.connect)(rabbitUrl);
        const channel = await connection.createConfirmChannel();
        const prefetch = resolvePrefetch(configService);

        await assertWebhookRetryQueues(channel, retryConfig);
        await channel.prefetch(prefetch);
        await channel.consume(
            retryConfig.queueName,
            (message) => handleReplayMessage(channel, webhooksService, retryConfig, message, runtime),
            { noAck: false },
        );

        const stopPendingRecovery = startPendingRecoveryLoop(
            channel,
            webhooksService,
            retryConfig,
            configService,
        );

        runtime.markReady(retryConfig.queueName, prefetch);
        console.log(`Webhook replay worker consuming ${retryConfig.queueName} with prefetch=${prefetch}`);

        return {
            connection,
            channel,
            runtime,
            runtimeServer,
            async close() {
                runtime.markNotReady();
                await stopPendingRecovery();
                const closeOperations: Array<() => Promise<unknown>> = [
                    () => channel.close(),
                    () => connection.close(),
                    () => runtimeServer?.close() ?? Promise.resolve(),
                ];
                let firstError: unknown;
                for (const closeOperation of closeOperations) {
                    try {
                        await closeOperation();
                    } catch (error) {
                        firstError ??= error;
                    }
                }
                if (firstError) {
                    throw firstError;
                }
            },
        };
    } catch (error) {
        runtime.markNotReady();
        await runtimeServer?.close();
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
        console.error(
            'Webhook replay worker failed',
            redactSensitiveText(error instanceof Error ? error.stack ?? error.message : error),
        );
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
        console.error(
            `Webhook retry publication state update failed delivery_id=${deliveryId}`,
            redactSensitiveText(error instanceof Error ? error.stack ?? error.message : error),
        );
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

if (require.main === module) {
    startWebhookReplayWorker().catch((error) => {
        console.error(
            'Webhook replay worker failed to start',
            redactSensitiveText(error instanceof Error ? error.stack ?? error.message : error),
        );
        process.exit(1);
    });
}
