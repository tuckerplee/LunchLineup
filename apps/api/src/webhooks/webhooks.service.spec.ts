import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as amqp from 'amqplib';
import { secureHttpRequest } from '../common/secure-http-client';
import { WebhookDeliveryStore } from './webhook-delivery.store';
import { WebhookDeliveryCrypto } from './webhook-delivery.crypto';
import { WebhooksService } from './webhooks.service';

vi.mock('../common/secure-http-client', () => ({
    secureHttpRequest: vi.fn(),
}));

vi.mock('amqplib', () => ({
    connect: vi.fn(),
}));

const secureHttpRequestMock = secureHttpRequest as unknown as Mock;
const amqpConnectMock = amqp.connect as unknown as Mock;
const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function configMock(overrides: Record<string, string> = {}) {
    return {
        get: vi.fn((key: string) => overrides[key] ?? {
            RABBITMQ_URL: 'amqp://rabbit',
            WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT: encryptionKey,
        }[key]),
    };
}

function deliveryStoreMock() {
    return {
        persistEvent: vi.fn().mockResolvedValue({
            id: 'delivery-1',
            tenantId: 'tenant-1',
            endpointRef: 'endpoint-ref',
            payloadDigest: 'payload-digest',
            payloadBytes: 128,
            eventType: 'schedule.published',
        }),
        persistRetry: vi.fn().mockResolvedValue({
            id: 'delivery-1',
            tenantId: 'tenant-1',
            endpointRef: 'endpoint-ref',
            payloadDigest: 'payload-digest',
            payloadBytes: 128,
            eventType: 'schedule.published',
        }),
        persistOutboxEventInTransaction: vi.fn().mockResolvedValue({
            id: 'delivery-1',
            tenantId: 'tenant-1',
            endpointRef: 'endpoint-ref',
            payloadDigest: 'payload-digest',
            payloadBytes: 128,
            eventType: 'schedule.published',
        }),
        claimInitialDelivery: vi.fn().mockResolvedValue(true),
        markQueued: vi.fn().mockResolvedValue(undefined),
        claimRecoverableForQueue: vi.fn().mockResolvedValue([]),
        claimReplayByDeliveryId: vi.fn(),
        withActiveDeliverySendLease: vi.fn(async (_tenantId: string, _deliveryId: string, operation: () => Promise<unknown>) => operation()),
        markDelivered: vi.fn().mockResolvedValue({ status: 'DELIVERED', attempts: 2 }),
        markReplayFailed: vi.fn().mockResolvedValue({ status: 'FAILED', attempts: 2 }),
        markDeadLettered: vi.fn().mockResolvedValue({ status: 'DEAD_LETTERED', attempts: 8 }),
    };
}

function claimStoreFixture(leaseMs = '60000') {
    let row: any;
    const webhookDelivery = {
        create: vi.fn(async ({ data }) => {
            row = {
                ...data,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            return row;
        }),
        updateMany: vi.fn(async ({ where, data }) => {
            await Promise.resolve();
            if (!row || row.id !== where.id) {
                return { count: 0 };
            }

            const now = where.OR[1].nextAttemptAt.lte as Date;
            const staleBefore = where.OR[2].updatedAt.lte as Date;
            const isDue = row.status === 'QUEUED'
                || (['PENDING', 'FAILED'].includes(row.status)
                    && row.nextAttemptAt instanceof Date
                    && row.nextAttemptAt <= now);
            const isStale = row.status === 'SENDING' && row.updatedAt <= staleBefore;
            if (!isDue && !isStale) {
                return { count: 0 };
            }

            row = {
                ...row,
                status: data.status,
                attempts: row.attempts + 1,
                lastError: data.lastError,
                updatedAt: data.updatedAt,
            };
            return { count: 1 };
        }),
        findFirst: vi.fn(async () => row ?? null),
    };
    const tx = {
        webhookDelivery,
        webhookEndpoint: {
            findFirst: vi.fn(async () => ({
                secret: new WebhookDeliveryCrypto(configMock() as any).encryptString('signing-secret'),
            })),
        },
    };
    const tenantDb = {
        withTenant: vi.fn(async (_tenantId: string, operation: any) => operation(tx)),
        withPlatformAdmin: vi.fn(async (operation: any) => operation(tx)),
    };
    return {
        store: new WebhookDeliveryStore(configMock({ WEBHOOK_REPLAY_LEASE_MS: leaseMs }) as any, tenantDb as any),
        tenantDb,
        webhookDelivery,
    };
}

describe('WebhooksService', () => {
    let service: WebhooksService;
    let deliveryStore: ReturnType<typeof deliveryStoreMock>;
    let featureAccess: any;

    beforeEach(() => {
        secureHttpRequestMock.mockReset();
        amqpConnectMock.mockReset();
        deliveryStore = deliveryStoreMock();
        featureAccess = {
            assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', creditCost: 1, reason: 'Billable' }),
            recordFeatureUsageInTransaction: vi.fn().mockResolvedValue({ consumedCredits: 1, newBalance: 98 }),
        };
        service = new WebhooksService(configMock() as any, deliveryStore as any, featureAccess);
    });

    it('writes one encrypted delivery per active subscribed endpoint through the caller transaction', async () => {
        const tx = {
            webhookEndpoint: {
                findMany: vi.fn().mockResolvedValue([
                    { id: 'endpoint-1', url: 'https://one.example.com/events' },
                    { id: 'endpoint-2', url: 'https://two.example.com/events' },
                ]),
            },
        };
        const occurredAt = new Date('2026-07-09T20:00:00.000Z');

        const count = await service.enqueueEventInTransaction(tx as any, {
            tenantId: 'tenant-1',
            eventId: 'schedule.published:sch-1:2026-07-09T20:00:00.000Z',
            eventType: 'schedule.published',
            occurredAt,
            data: { scheduleId: 'sch-1' },
        });

        expect(tx.webhookEndpoint.findMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                active: true,
                events: { has: 'schedule.published' },
            },
            select: { id: true, url: true },
            orderBy: { createdAt: 'asc' },
        });
        expect(deliveryStore.persistOutboxEventInTransaction).toHaveBeenCalledTimes(2);
        expect(featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledWith(tx, 'tenant-1', 'webhooks');
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledTimes(2);
        expect(deliveryStore.persistOutboxEventInTransaction).toHaveBeenNthCalledWith(
            1,
            tx,
            expect.objectContaining({
                tenantId: 'tenant-1',
                endpointId: 'endpoint-1',
                eventType: 'schedule.published',
                body: JSON.stringify({
                    id: 'schedule.published:sch-1:2026-07-09T20:00:00.000Z',
                    event: 'schedule.published',
                    occurredAt: occurredAt.toISOString(),
                    data: { scheduleId: 'sch-1' },
                }),
            }),
        );
        expect(count).toBe(2);
        expect(secureHttpRequestMock).not.toHaveBeenCalled();
        expect(amqpConnectMock).not.toHaveBeenCalled();
    });

    it('delivers through the secure HTTP client with a signature and redirect blocking', async () => {
        const payload = { event: 'schedule.published', scheduleId: 'schedule-1' };
        const body = JSON.stringify(payload);
        const signature = crypto.createHmac('sha256', 'signing-secret').update(body).digest('hex');
        secureHttpRequestMock.mockResolvedValue({ ok: true, status: 200 });

        await service.deliver({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup',
            payload,
            secret: 'signing-secret',
        });

        expect(secureHttpRequestMock).toHaveBeenCalledWith('https://hooks.example.com/lunchlineup', {
            method: 'POST',
            headers: {
                'X-LunchLineup-Signature': signature,
                'Content-Type': 'application/json',
            },
            body,
            timeoutMs: 5000,
            redirect: 'error',
        });
        expect(deliveryStore.persistEvent).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            body,
            eventType: 'schedule.published',
        }));
        expect(deliveryStore.claimInitialDelivery).toHaveBeenCalledWith('tenant-1', 'delivery-1');
        expect(deliveryStore.markDelivered).toHaveBeenCalledWith('tenant-1', 'delivery-1');
        expect(deliveryStore.persistEvent.mock.invocationCallOrder[0]).toBeLessThan(secureHttpRequestMock.mock.invocationCallOrder[0]);
        expect(amqpConnectMock).not.toHaveBeenCalled();
    });

    it('does not call the provider after the tenant or endpoint becomes inactive', async () => {
        deliveryStore.withActiveDeliverySendLease.mockResolvedValueOnce(null);

        await service.deliver({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup',
            payload: { event: 'schedule.published' },
            secret: 'signing-secret',
        });

        expect(deliveryStore.withActiveDeliverySendLease).toHaveBeenCalledWith(
            'tenant-1',
            'delivery-1',
            expect.any(Function),
        );
        expect(secureHttpRequestMock).not.toHaveBeenCalled();
        expect(deliveryStore.markDelivered).not.toHaveBeenCalled();
        expect(deliveryStore.markReplayFailed).not.toHaveBeenCalled();
    });

    it('persists retry state and queues only an opaque delivery id', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const payload = {
            event: 'schedule.published',
            scheduleId: 'schedule-1',
            customerEmail: 'owner@example.com',
        };
        const body = JSON.stringify(payload);
        const signature = crypto.createHmac('sha256', 'signing-secret').update(body).digest('hex');
        const sendToQueue = vi.fn().mockReturnValue(true);
        const close = vi.fn();
        const closeChannel = vi.fn();
        const waitForConfirms = vi.fn().mockResolvedValue(undefined);
        amqpConnectMock.mockResolvedValue({
            createConfirmChannel: vi.fn().mockResolvedValue({
                assertQueue: vi.fn(),
                sendToQueue,
                waitForConfirms,
                close: closeChannel,
            }),
            close,
        });
        secureHttpRequestMock
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({ ok: true, status: 204 });

        await service.deliver({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup?token=query-token',
            payload,
            secret: 'signing-secret',
        });

        expect(deliveryStore.persistEvent).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup?token=query-token',
            body,
            eventType: 'schedule.published',
        }));
        expect(deliveryStore.markReplayFailed).toHaveBeenCalledWith(
            'tenant-1',
            'delivery-1',
            expect.any(Error),
            1,
        );
        expect(sendToQueue).toHaveBeenCalledOnce();
        expect(sendToQueue.mock.calls[0][0]).toBe('webhook_retries.delay');
        expect(sendToQueue.mock.calls[0][2]).toEqual({
            persistent: true,
            expiration: '60000',
        });
        const queued = JSON.parse(sendToQueue.mock.calls[0][1].toString());
        expect(queued).toEqual({ deliveryId: 'delivery-1' });

        const queuedBody = JSON.stringify(queued);
        expect(queuedBody).not.toContain('query-token');
        expect(queuedBody).not.toContain('schedule-1');
        expect(queuedBody).not.toContain('owner@example.com');
        expect(queuedBody).not.toContain(signature);
        expect(queued.url).toBeUndefined();
        expect(queued.payload).toBeUndefined();
        expect(queued.signature).toBeUndefined();
        expect(queued.secret).toBeUndefined();
        expect(waitForConfirms).toHaveBeenCalledOnce();
        expect(deliveryStore.markQueued).toHaveBeenCalledWith('tenant-1', 'delivery-1');

        deliveryStore.claimReplayByDeliveryId.mockResolvedValue({
            status: 'claimed',
            delivery: {
                id: queued.deliveryId,
                tenantId: 'tenant-1',
                endpointId: 'endpoint-1',
                url: 'https://hooks.example.com/lunchlineup?token=query-token',
                body,
                eventType: 'schedule.published',
                secret: 'signing-secret',
                attempts: 2,
            },
        });

        const replay = await service.replayDelivery(queued.deliveryId);

        expect(replay).toEqual({
            deliveryId: 'delivery-1',
            tenantId: 'tenant-1',
            status: 'delivered',
            attempts: 2,
            httpStatus: 204,
        });
        expect(deliveryStore.claimReplayByDeliveryId).toHaveBeenCalledWith('delivery-1');
        expect(secureHttpRequestMock).toHaveBeenLastCalledWith('https://hooks.example.com/lunchlineup?token=query-token', {
            method: 'POST',
            headers: {
                'X-LunchLineup-Signature': signature,
                'Content-Type': 'application/json',
            },
            body,
            timeoutMs: 5000,
            redirect: 'error',
        });
        expect(deliveryStore.markDelivered).toHaveBeenCalledWith('tenant-1', 'delivery-1');
        expect(amqpConnectMock).toHaveBeenCalledTimes(1);

        expect(closeChannel).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        vi.restoreAllMocks();
    });

    it('does not mark retry state queued until RabbitMQ confirms the publish', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        secureHttpRequestMock.mockRejectedValue(new Error('provider unavailable'));
        let confirmPublish!: () => void;
        const waitForConfirms = vi.fn(() => new Promise<void>((resolve) => {
            confirmPublish = resolve;
        }));
        amqpConnectMock.mockResolvedValue({
            createConfirmChannel: vi.fn().mockResolvedValue({
                assertQueue: vi.fn(),
                sendToQueue: vi.fn().mockReturnValue(true),
                waitForConfirms,
                close: vi.fn(),
            }),
            close: vi.fn(),
        });

        const delivery = service.deliver({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup',
            payload: { event: 'schedule.published' },
            secret: 'signing-secret',
        });

        await vi.waitFor(() => expect(waitForConfirms).toHaveBeenCalledOnce());
        expect(deliveryStore.markQueued).not.toHaveBeenCalled();

        confirmPublish();
        await delivery;

        expect(deliveryStore.markQueued).toHaveBeenCalledWith('tenant-1', 'delivery-1');
        vi.restoreAllMocks();
    });

    it('leaves retry state recoverable when RabbitMQ rejects the publisher confirm', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        secureHttpRequestMock.mockRejectedValue(new Error('provider unavailable'));
        amqpConnectMock.mockResolvedValue({
            createConfirmChannel: vi.fn().mockResolvedValue({
                assertQueue: vi.fn(),
                sendToQueue: vi.fn().mockReturnValue(true),
                waitForConfirms: vi.fn().mockRejectedValue(new Error('broker nack')),
                close: vi.fn(),
            }),
            close: vi.fn(),
        });

        await service.deliver({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup',
            payload: { event: 'schedule.published' },
            secret: 'signing-secret',
        });

        expect(deliveryStore.persistEvent).toHaveBeenCalledOnce();
        expect(deliveryStore.markReplayFailed).toHaveBeenCalledOnce();
        expect(deliveryStore.markQueued).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it('marks replay failures retryable without publishing another queue message', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const body = JSON.stringify({ event: 'schedule.published', scheduleId: 'schedule-1' });
        deliveryStore.claimReplayByDeliveryId.mockResolvedValue({
            status: 'claimed',
            delivery: {
                id: 'delivery-1',
                tenantId: 'tenant-1',
                endpointId: 'endpoint-1',
                url: 'https://hooks.example.com/lunchlineup?token=query-token',
                body,
                eventType: 'schedule.published',
                secret: 'signing-secret',
                attempts: 3,
            },
        });
        deliveryStore.markReplayFailed.mockResolvedValue({ status: 'FAILED', attempts: 3 });
        secureHttpRequestMock.mockRejectedValue(new Error('Authorization: Bearer delivery-token'));

        const replay = await service.replayDelivery('delivery-1');

        expect(replay).toEqual({
            deliveryId: 'delivery-1',
            tenantId: 'tenant-1',
            status: 'failed',
            attempts: 3,
            error: 'Authorization: [REDACTED] [REDACTED]',
        });
        expect(deliveryStore.markReplayFailed).toHaveBeenCalledWith('tenant-1', 'delivery-1', expect.any(Error), 3);
        expect(amqpConnectMock).not.toHaveBeenCalled();
        const logged = JSON.stringify(consoleError.mock.calls);
        expect(logged).not.toContain('query-token');
        expect(logged).not.toContain('delivery-token');
        expect(logged).toContain('[REDACTED]');

        vi.restoreAllMocks();
    });

    it('defers an active replay lease without calling the provider', async () => {
        deliveryStore.claimReplayByDeliveryId.mockResolvedValue({
            status: 'deferred',
            tenantId: 'tenant-1',
            attempts: 2,
            retryAfterMs: 45_000,
        });

        const replay = await service.replayDelivery('delivery-1');

        expect(replay).toEqual({
            deliveryId: 'delivery-1',
            tenantId: 'tenant-1',
            status: 'deferred',
            attempts: 2,
            retryAfterMs: 45_000,
        });
        expect(secureHttpRequestMock).not.toHaveBeenCalled();
        expect(deliveryStore.markDelivered).not.toHaveBeenCalled();
        expect(deliveryStore.markReplayFailed).not.toHaveBeenCalled();
    });

    it('redacts sensitive webhook URL and retry errors from logs', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        deliveryStore.persistEvent.mockResolvedValue({
            id: 'delivery-1',
            tenantId: 'tenant-1',
            endpointRef: 'endpoint-ref',
            payloadDigest: 'payload-digest',
            payloadBytes: 128,
            eventType: 'schedule.published',
        });
        secureHttpRequestMock.mockRejectedValue(new Error('Authorization: Bearer delivery-token'));
        amqpConnectMock.mockRejectedValue(new Error('amqp://user:rabbit-secret@rabbitmq:5672'));

        await service.deliver({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://url-user:url-password@hooks.example.com/lunchlineup?token=query-token&event=test',
            payload: { event: 'schedule.published' },
            secret: 'signing-secret',
        });

        const logged = JSON.stringify(consoleError.mock.calls);
        expect(logged).not.toContain('url-password');
        expect(logged).not.toContain('query-token');
        expect(logged).not.toContain('delivery-token');
        expect(logged).not.toContain('rabbit-secret');
        expect(logged).toContain('[REDACTED]');

        vi.restoreAllMocks();
    });

    it('keeps the durable retry pending when RabbitMQ publish is unavailable', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        secureHttpRequestMock.mockRejectedValue(new Error('provider unavailable'));
        amqpConnectMock.mockRejectedValue(new Error('broker unavailable'));

        await service.deliver({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup',
            payload: { event: 'schedule.published' },
            secret: 'signing-secret',
        });

        expect(deliveryStore.persistEvent).toHaveBeenCalledOnce();
        expect(deliveryStore.markReplayFailed).toHaveBeenCalledOnce();
        expect(deliveryStore.markQueued).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it('drops oversized payloads before signing, posting, persisting, or queueing retries', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        service = new WebhooksService(configMock({ WEBHOOK_MAX_PAYLOAD_BYTES: '64' }) as any, deliveryStore as any);

        await service.deliver({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup?token=query-token',
            payload: {
                event: 'schedule.published',
                data: 'x'.repeat(128),
            },
            secret: 'signing-secret',
        });

        expect(secureHttpRequestMock).not.toHaveBeenCalled();
        expect(deliveryStore.persistEvent).not.toHaveBeenCalled();
        expect(amqpConnectMock).not.toHaveBeenCalled();
        const logged = JSON.stringify(consoleError.mock.calls);
        expect(logged).toContain('payload_bytes=');
        expect(logged).not.toContain('query-token');

        vi.restoreAllMocks();
    });

    it('rejects events without a durable endpoint reference before persistence', async () => {
        await expect(service.deliver({
            tenantId: 'tenant-1',
            endpointId: '',
            url: 'https://hooks.example.com/lunchlineup',
            payload: { event: 'schedule.published' },
            secret: 'signing-secret',
        })).rejects.toThrow('endpoint id is required for durable replay');

        expect(deliveryStore.persistEvent).not.toHaveBeenCalled();
        expect(secureHttpRequestMock).not.toHaveBeenCalled();
        expect(amqpConnectMock).not.toHaveBeenCalled();
    });
});

describe('WebhookDeliveryStore', () => {
    it('claims a bounded recoverable batch with a concurrency-safe database lease', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const recoverable = [{
            id: 'delivery-1',
            tenantId: 'tenant-1',
            status: 'FAILED',
            attempts: 3,
        }];
        const queryRaw = vi.fn().mockResolvedValue(recoverable);
        const tx = { $queryRaw: queryRaw };
        const tenantDb = {
            withPlatformAdmin: vi.fn(async (operation: any) => operation(tx)),
        };
        const store = new WebhookDeliveryStore(
            configMock({ WEBHOOK_PENDING_CLAIM_LEASE_MS: '30000' }) as any,
            tenantDb as any,
        );

        const claimed = await store.claimRecoverableForQueue(5_000);

        expect(claimed).toEqual(recoverable);
        expect(tenantDb.withPlatformAdmin).toHaveBeenCalledOnce();
        const query = queryRaw.mock.calls[0][0];
        const sql = query.strings.join('?');
        expect(sql).toContain('FOR UPDATE OF delivery SKIP LOCKED');
        expect(sql).toContain('tenant."status" = \'ACTIVE\'');
        expect(sql).toContain('\'ACTIVE\'::"TenantStatus"');
        expect(sql).toContain('\'TRIAL\'::"TenantStatus"');
        expect(sql).toContain('tenant."trialEndsAt" >');
        expect(sql).not.toContain('\'PAST_DUE\'::"TenantStatus"');
        expect(sql).toContain('\'PENDING\'::\"WebhookDeliveryStatus\"');
        expect(sql).toContain('\'QUEUED\'::\"WebhookDeliveryStatus\"');
        expect(sql).toContain('\'FAILED\'::\"WebhookDeliveryStatus\"');
        expect(sql).toContain('SENDING');
        expect(sql).toContain('"queuedAt" <=');
        expect(sql).toContain('"nextAttemptAt" IS NULL');
        expect(sql).toContain('WHEN candidates."status"');
        expect(query.values).toContain(500);
        expect(query.values).toContainEqual(new Date('2026-01-01T00:00:30.000Z'));
        expect(query.values).toContainEqual(new Date('2025-12-31T23:59:00.000Z'));
        expect(query.values).toContainEqual(new Date('2025-12-31T23:50:00.000Z'));
        vi.useRealTimers();
    });

    it('persists and claims the first attempt before any provider network call can occur', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const create = vi.fn(async ({ data }) => ({
            id: data.id,
            tenantId: data.tenantId,
            endpointRef: data.endpointRef,
            payloadDigest: data.payloadDigest,
            payloadBytes: data.payloadBytes,
            eventType: data.eventType,
        }));
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const tx = { webhookDelivery: { create, updateMany } };
        const tenantDb = { withTenant: vi.fn(async (_tenantId: string, operation: any) => operation(tx)) };
        const store = new WebhookDeliveryStore(
            configMock({ WEBHOOK_INITIAL_DELIVERY_LEASE_MS: '30000' }) as any,
            tenantDb as any,
        );

        const delivery = await store.persistEvent({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup',
            body: '{"event":"schedule.published"}',
            eventType: 'schedule.published',
        });
        const claimed = await store.claimInitialDelivery('tenant-1', delivery.id);

        expect(claimed).toBe(true);
        expect(create.mock.calls[0][0].data).toEqual(expect.objectContaining({
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: new Date('2026-01-01T00:00:30.000Z'),
            lastError: null,
        }));
        expect(updateMany).toHaveBeenCalledWith({
            where: {
                id: delivery.id,
                tenantId: 'tenant-1',
                status: 'PENDING',
                attempts: 0,
                tenant: {
                    is: {
                        deletedAt: null,
                        OR: [
                            { status: 'ACTIVE' },
                            { status: 'TRIAL', trialEndsAt: { gt: new Date('2026-01-01T00:00:00.000Z') } },
                        ],
                    },
                },
            },
            data: {
                status: 'SENDING',
                attempts: { increment: 1 },
                nextAttemptAt: null,
                lastError: null,
                updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            },
        });
        vi.useRealTimers();
    });

    it('allows a TRIAL tenant to claim its first webhook delivery', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const tx = { webhookDelivery: { updateMany } };
        const tenantDb = { withTenant: vi.fn(async (_tenantId: string, operation: any) => operation(tx)) };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);

        await expect(store.claimInitialDelivery('tenant-trial', 'delivery-trial')).resolves.toBe(true);

        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'delivery-trial',
                tenantId: 'tenant-trial',
                tenant: {
                    is: {
                        deletedAt: null,
                        OR: [
                            { status: 'ACTIVE' },
                            { status: 'TRIAL', trialEndsAt: { gt: new Date('2026-01-01T00:00:00.000Z') } },
                        ],
                    },
                },
            }),
        }));
        vi.useRealTimers();
    });

    it('sends only while a TRIAL tenant has a future trial end', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        let tenantTrialEndsAt = new Date('2026-01-02T00:00:00.000Z');
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const tx = {
            $queryRaw: vi.fn(async () => [{
                tenantStatus: 'TRIAL',
                tenantDeletedAt: null,
                tenantTrialEndsAt,
                endpointActive: true,
            }]),
            webhookDelivery: { updateMany },
        };
        const tenantDb = { withPlatformAdmin: vi.fn(async (operation: any) => operation(tx)) };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);
        const send = vi.fn().mockResolvedValue('sent');

        await expect(store.withActiveDeliverySendLease('tenant-trial', 'delivery-trial', send))
            .resolves.toBe('sent');

        tenantTrialEndsAt = new Date('2025-12-31T23:59:59.000Z');
        await expect(store.withActiveDeliverySendLease('tenant-trial', 'delivery-trial', send))
            .resolves.toBeNull();
        expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'FAILED' }),
        }));
        expect(send).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    it('pauses an in-flight PAST_DUE delivery and permits sending after ACTIVE recovery', async () => {
        let tenantStatus = 'ACTIVE';
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const queryRaw = vi.fn(async () => [{
            tenantStatus,
            tenantDeletedAt: null,
            tenantTrialEndsAt: null,
            endpointActive: true,
        }]);
        const tx = {
            $queryRaw: queryRaw,
            webhookDelivery: { updateMany },
        };
        const tenantDb = { withPlatformAdmin: vi.fn(async (operation: any) => operation(tx)) };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);
        const send = vi.fn().mockResolvedValue('sent');

        await expect(store.withActiveDeliverySendLease('tenant-1', 'delivery-1', send))
            .resolves.toBe('sent');

        tenantStatus = 'PAST_DUE';
        await expect(store.withActiveDeliverySendLease('tenant-1', 'delivery-1', send))
            .resolves.toBeNull();
        expect(updateMany).toHaveBeenLastCalledWith({
            where: { id: 'delivery-1', tenantId: 'tenant-1', status: 'SENDING' },
            data: {
                status: 'FAILED',
                nextAttemptAt: expect.any(Date),
                lastError: 'Tenant webhook delivery is paused',
            },
        });
        expect(updateMany.mock.calls.at(-1)?.[0].data.status).not.toBe('DEAD_LETTERED');

        tenantStatus = 'ACTIVE';
        await expect(store.withActiveDeliverySendLease('tenant-1', 'delivery-1', send))
            .resolves.toBe('sent');
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('clears the recovery timestamp only when marking a confirmed publish queued', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const tx = { webhookDelivery: { updateMany } };
        const tenantDb = { withTenant: vi.fn(async (_tenantId: string, operation: any) => operation(tx)) };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);

        await store.markQueued('tenant-1', 'delivery-1');

        expect(updateMany).toHaveBeenCalledWith({
            where: {
                id: 'delivery-1',
                tenantId: 'tenant-1',
                status: { in: ['PENDING', 'QUEUED', 'FAILED'] },
            },
            data: {
                status: 'QUEUED',
                queuedAt: new Date('2026-01-01T00:00:00.000Z'),
                nextAttemptAt: null,
            },
        });
        vi.useRealTimers();
    });

    it('persists replayable delivery data without plaintext URL, payload, or signature', async () => {
        const body = JSON.stringify({
            event: 'schedule.published',
            scheduleId: 'schedule-1',
            customerEmail: 'owner@example.com',
        });
        const create = vi.fn(async ({ data }) => ({
            id: data.id,
            tenantId: data.tenantId,
            endpointRef: data.endpointRef,
            payloadDigest: data.payloadDigest,
            payloadBytes: data.payloadBytes,
            eventType: data.eventType,
        }));
        const tx = { webhookDelivery: { create } };
        const tenantDb = { withTenant: vi.fn(async (_tenantId: string, operation: any) => operation(tx)) };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);

        await store.persistRetry({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup?token=query-token',
            body,
            eventType: 'schedule.published',
            failureReason: new Error('Authorization: Bearer delivery-token'),
        });

        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
        const row = create.mock.calls[0][0].data;
        const serializedRow = JSON.stringify(row);
        expect(row.endpointRef).toMatch(/^[a-f0-9]{16}$/);
        expect(row.payloadDigest).toBe(crypto.createHash('sha256').update(body).digest('hex'));
        expect(row.payloadBytes).toBe(Buffer.byteLength(body));
        expect(row.encryptedUrl).not.toContain('hooks.example.com');
        expect(row.encryptedUrl).not.toContain('query-token');
        expect(row.encryptedPayload).not.toContain('schedule-1');
        expect(row.encryptedPayload).not.toContain('owner@example.com');
        expect(serializedRow).not.toContain('signing-secret');
        expect(row.lastError).not.toContain('delivery-token');
        expect(row.lastError).toContain('[REDACTED]');
    });

    it('loads a decrypted replay envelope from tenant-scoped storage', async () => {
        const body = JSON.stringify({ event: 'schedule.published', scheduleId: 'schedule-1' });
        let persisted: any;
        const tx = {
            webhookDelivery: {
                create: vi.fn(async ({ data }) => {
                    persisted = data;
                    return {
                        id: data.id,
                        tenantId: data.tenantId,
                        endpointRef: data.endpointRef,
                        payloadDigest: data.payloadDigest,
                        payloadBytes: data.payloadBytes,
                        eventType: data.eventType,
                    };
                }),
                findFirst: vi.fn(async () => ({
                    id: persisted.id,
                    tenantId: persisted.tenantId,
                    eventType: persisted.eventType,
                    encryptedUrl: persisted.encryptedUrl,
                    encryptedPayload: persisted.encryptedPayload,
                })),
            },
        };
        const tenantDb = { withTenant: vi.fn(async (_tenantId: string, operation: any) => operation(tx)) };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);
        const delivery = await store.persistRetry({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup?token=query-token',
            body,
            eventType: 'schedule.published',
        });

        const replay = await store.loadReplayEnvelope('tenant-1', delivery.id);

        expect(replay).toEqual({
            id: delivery.id,
            tenantId: 'tenant-1',
            url: 'https://hooks.example.com/lunchlineup?token=query-token',
            body,
            eventType: 'schedule.published',
        });
        expect(tx.webhookDelivery.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: delivery.id,
                tenantId: 'tenant-1',
            }),
        }));
    });

    it('atomically claims a due worker replay with its endpoint signing secret', async () => {
        const body = JSON.stringify({ event: 'schedule.published', scheduleId: 'schedule-1' });
        const { store, tenantDb, webhookDelivery } = claimStoreFixture();
        const delivery = await store.persistRetry({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup?token=query-token',
            body,
            eventType: 'schedule.published',
        });

        const replay = await store.claimReplayByDeliveryId(delivery.id);

        expect(replay).toEqual({
            status: 'claimed',
            delivery: {
                id: delivery.id,
                tenantId: 'tenant-1',
                endpointId: 'endpoint-1',
                url: 'https://hooks.example.com/lunchlineup?token=query-token',
                body,
                eventType: 'schedule.published',
                secret: 'signing-secret',
                attempts: 2,
            },
        });
        expect(tenantDb.withPlatformAdmin).toHaveBeenCalledWith(expect.any(Function));
        expect(webhookDelivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: delivery.id,
                OR: expect.arrayContaining([
                    expect.objectContaining({ status: 'SENDING' }),
                ]),
            }),
        }));
    });

    it('allows only one concurrent replay claim', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const { store } = claimStoreFixture('60000');
        const delivery = await store.persistRetry({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup',
            body: '{}',
        });

        const claims = await Promise.all([
            store.claimReplayByDeliveryId(delivery.id),
            store.claimReplayByDeliveryId(delivery.id),
        ]);

        expect(claims.filter((claim) => claim.status === 'claimed')).toHaveLength(1);
        expect(claims.filter((claim) => claim.status === 'deferred')).toEqual([
            { status: 'deferred', tenantId: 'tenant-1', attempts: 2, retryAfterMs: 60_000 },
        ]);
        vi.useRealTimers();
    });

    it('reclaims a SENDING delivery after a worker crash expires its lease', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const { store } = claimStoreFixture('10000');
        const delivery = await store.persistRetry({
            tenantId: 'tenant-1',
            endpointId: 'endpoint-1',
            url: 'https://hooks.example.com/lunchlineup',
            body: '{}',
        });

        const firstClaim = await store.claimReplayByDeliveryId(delivery.id);
        vi.advanceTimersByTime(10_001);
        const recoveredClaim = await store.claimReplayByDeliveryId(delivery.id);

        expect(firstClaim).toMatchObject({ status: 'claimed', delivery: { attempts: 2 } });
        expect(recoveredClaim).toMatchObject({ status: 'claimed', delivery: { attempts: 3 } });
        vi.useRealTimers();
    });

    it('updates durable replay attempt and terminal status fields', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        let state = { status: 'SENDING', attempts: 2 };
        const updateMany = vi.fn(async ({ data }) => {
            state = { ...state, status: data.status };
            return { count: 1 };
        });
        const findFirst = vi.fn(async () => state);
        const tx = { webhookDelivery: { updateMany, findFirst } };
        const tenantDb = { withTenant: vi.fn(async (_tenantId: string, operation: any) => operation(tx)) };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);

        await store.markDelivered('tenant-1', 'delivery-1');
        await store.markReplayFailed('tenant-1', 'delivery-1', new Error('Authorization: Bearer delivery-token'), 2);
        await store.markDeadLettered('tenant-1', 'delivery-1', new Error('Authorization: Bearer delivery-token'), 8);

        const delivered = updateMany.mock.calls[0][0];
        expect(delivered.where).toEqual({
            id: 'delivery-1',
            tenantId: 'tenant-1',
            status: 'SENDING',
        });
        expect(delivered.data).toEqual(expect.objectContaining({
            status: 'DELIVERED',
            deliveredAt: new Date('2026-01-01T00:00:00.000Z'),
            nextAttemptAt: null,
            lastError: null,
        }));

        const failed = updateMany.mock.calls[1][0];
        expect(failed.data).toEqual(expect.objectContaining({
            status: 'FAILED',
            nextAttemptAt: new Date('2026-01-01T00:02:00.000Z'),
        }));
        expect(failed.data.lastError).not.toContain('delivery-token');
        expect(failed.data.lastError).toContain('[REDACTED]');

        const deadLettered = updateMany.mock.calls[2][0];
        expect(deadLettered.data).toEqual({
            status: 'DEAD_LETTERED',
            nextAttemptAt: null,
            lastError: expect.stringContaining('[REDACTED]'),
            attempts: 8,
        });

        vi.useRealTimers();
    });
});
