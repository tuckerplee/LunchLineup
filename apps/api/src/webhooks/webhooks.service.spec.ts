import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { secureHttpRequest } from '../common/secure-http-client';
import { WebhookDeliveryStore } from './webhook-delivery.store';
import { WebhookDeliveryCrypto } from './webhook-delivery.crypto';
import { WebhooksService } from './webhooks.service';

vi.mock('../common/secure-http-client', () => ({
    secureHttpRequest: vi.fn(),
}));

const secureHttpRequestMock = secureHttpRequest as unknown as Mock;
const encryptionKey = Buffer.alloc(32, 7).toString('base64');

function configMock(overrides: Record<string, string> = {}) {
    return {
        get: vi.fn((key: string) => overrides[key] ?? {
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
        $queryRaw: vi.fn(async () => row ? [{ id: row.id }] : []),
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
        deliveryStore = deliveryStoreMock();
        featureAccess = {
            assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', creditCost: 1, reason: 'Billable' }),
            recordFeatureUsageInTransaction: vi.fn().mockResolvedValue({ consumedCredits: 1, newBalance: 98 }),
        };
        service = new WebhooksService(configMock() as any, deliveryStore as any, featureAccess);
    });

    it('does not expose the obsolete standalone unbilled delivery path', () => {
        expect(service).not.toHaveProperty('deliver');
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

        deliveryStore.persistOutboxEventInTransaction
            .mockResolvedValueOnce({
                id: 'delivery-1',
                tenantId: 'tenant-1',
                endpointRef: 'endpoint-ref-1',
                payloadDigest: 'payload-digest',
                payloadBytes: 128,
                eventType: 'schedule.published',
            })
            .mockResolvedValueOnce({
                id: 'delivery-2',
                tenantId: 'tenant-1',
                endpointRef: 'endpoint-ref-2',
                payloadDigest: 'payload-digest',
                payloadBytes: 128,
                eventType: 'schedule.published',
            });
        featureAccess.recordFeatureUsageInTransaction
            .mockResolvedValueOnce({ consumedCredits: 1, newBalance: 99 })
            .mockResolvedValueOnce({ consumedCredits: 1, newBalance: 98 });

        const settlement = await service.enqueueEventInTransaction(tx as any, {
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
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenNthCalledWith(
            1,
            tx,
            'tenant-1',
            expect.objectContaining({ source: 'credits', creditCost: 1 }),
            'Webhook delivery (delivery-1)',
            'webhook-delivery:delivery-1',
        );
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
        expect(settlement).toEqual({
            matchingDeliveryCount: 2,
            unitCost: 1,
            totalConfiguredCost: 2,
            deliveries: [
                { deliveryId: 'delivery-1', consumedCredits: 1, newBalance: 99 },
                { deliveryId: 'delivery-2', consumedCredits: 1, newBalance: 98 },
            ],
        });
        expect(secureHttpRequestMock).not.toHaveBeenCalled();
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
            error: 'category=unknown class=Error',
        });
        expect(deliveryStore.markReplayFailed).toHaveBeenCalledWith('tenant-1', 'delivery-1', expect.any(Error), 3);
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        const logged = JSON.stringify(consoleError.mock.calls);
        expect(logged).not.toContain('query-token');
        expect(logged).not.toContain('delivery-token');
        expect(logged).toContain('category=unknown class=Error');

        vi.restoreAllMocks();
    });

    it('sends an exact future-paid replay once without charging credits again', async () => {
        deliveryStore.claimReplayByDeliveryId.mockResolvedValue({
            status: 'claimed',
            delivery: {
                id: 'delivery-1',
                tenantId: 'tenant-1',
                endpointId: 'endpoint-1',
                url: 'https://hooks.example.com/lunchlineup',
                body: '{}',
                eventType: 'schedule.published',
                secret: 'signing-secret',
                attempts: 3,
            },
        });
        deliveryStore.markDelivered.mockResolvedValue({ status: 'DELIVERED', attempts: 3 });
        secureHttpRequestMock.mockResolvedValue({ ok: true, status: 204 });

        await expect(service.replayDelivery('delivery-1')).resolves.toEqual({
            deliveryId: 'delivery-1',
            tenantId: 'tenant-1',
            status: 'delivered',
            attempts: 3,
            httpStatus: 204,
        });

        expect(secureHttpRequestMock).toHaveBeenCalledOnce();
        expect(deliveryStore.markDelivered).toHaveBeenCalledOnce();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
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
        const queryRaw = vi.fn().mockResolvedValue([{ id: 'authorized' }]);
        const tx = { $queryRaw: queryRaw, webhookDelivery: { create, updateMany } };
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
                        status: 'ACTIVE',
                        planTier: { not: 'FREE' },
                        stripeSubscriptionId: { not: null },
                        NOT: { stripeSubscriptionId: '' },
                        stripeSubscriptionCurrentPeriodEnd: {
                            gt: new Date('2026-01-01T00:00:00.000Z'),
                        },
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

    it('rejects a trial tenant before claiming its first webhook delivery', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const updateMany = vi.fn().mockResolvedValue({ count: 0 });
        const queryRaw = vi.fn().mockResolvedValue([]);
        const tx = { $queryRaw: queryRaw, webhookDelivery: { updateMany } };
        const tenantDb = { withTenant: vi.fn(async (_tenantId: string, operation: any) => operation(tx)) };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);

        await expect(store.claimInitialDelivery('tenant-trial', 'delivery-trial')).resolves.toBe(false);

        expect(updateMany).not.toHaveBeenCalled();
        const authoritySql = JSON.stringify(queryRaw.mock.calls[0]?.[0]);
        expect(authoritySql).toContain('planTier');
        expect(authoritySql).toContain('stripeSubscriptionCurrentPeriodEnd');
        expect(authoritySql).toContain('balanceAfter');
        expect(authoritySql).toContain('Webhook delivery (');
        vi.useRealTimers();
    });

    it('requires the canonical paid tuple and exact debit for recovery claims', async () => {
        const queryRaw = vi.fn().mockResolvedValue([]);
        const tenantDb = {
            withPlatformAdmin: vi.fn(async (operation: any) => operation({ $queryRaw: queryRaw })),
        };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);

        await expect(store.claimRecoverableForQueue(25)).resolves.toEqual([]);

        const sql = queryRaw.mock.calls[0]?.[0].strings.join(' ') ?? '';
        expect(sql).toContain('tenant."planTier" <> \'FREE\'');
        expect(sql).toContain('tenant."stripeSubscriptionCurrentPeriodEnd" > CURRENT_TIMESTAMP');
        expect(sql).toContain('NULLIF(BTRIM(tenant."stripeSubscriptionId")');
        expect(sql).toContain('credit."amount" =');
        expect(sql).toContain('credit."reason" = \'Webhook delivery (\'');
        expect(sql).toContain('credit."balanceAfter" IS NOT NULL');
    });

    it('does not claim replay when canonical paid or exact debit authority fails', async () => {
        const updateMany = vi.fn();
        const queryRaw = vi.fn().mockResolvedValue([]);
        const tx = { $queryRaw: queryRaw, webhookDelivery: { updateMany } };
        const tenantDb = {
            withPlatformAdmin: vi.fn(async (operation: any) => operation(tx)),
        };
        const store = new WebhookDeliveryStore(configMock() as any, tenantDb as any);

        await expect(store.claimReplayByDeliveryId('delivery-malformed')).resolves.toEqual({
            status: 'not_found',
        });

        expect(updateMany).not.toHaveBeenCalled();
        expect(JSON.stringify(queryRaw.mock.calls[0]?.[0])).toContain('balanceAfter');
    });

    it('sends only with canonical paid state and exact immutable credit proof', async () => {
        let tenantStripeSubscriptionId: string | null = 'sub_paid_1';
        let tenantPlanTier = 'GROWTH';
        let tenantPaidThrough: Date | null = new Date(Date.now() + 60_000);
        let hasExactCreditReservation = true;
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const queryRaw = vi.fn(async (_query: unknown) => [{
            tenantStatus: 'ACTIVE',
            tenantDeletedAt: null,
            tenantPlanTier,
            tenantStripeSubscriptionId,
            tenantPaidThrough,
            endpointActive: true,
            hasExactCreditReservation,
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

        hasExactCreditReservation = false;
        await expect(store.withActiveDeliverySendLease('tenant-1', 'delivery-1', send))
            .resolves.toBeNull();

        hasExactCreditReservation = true;
        tenantStripeSubscriptionId = null;
        await expect(store.withActiveDeliverySendLease('tenant-1', 'delivery-1', send))
            .resolves.toBeNull();

        tenantStripeSubscriptionId = 'sub_paid_1';
        tenantPlanTier = 'FREE';
        await expect(store.withActiveDeliverySendLease('tenant-1', 'delivery-1', send))
            .resolves.toBeNull();

        tenantPlanTier = 'GROWTH';
        tenantPaidThrough = new Date(Date.now() - 1);
        await expect(store.withActiveDeliverySendLease('tenant-1', 'delivery-1', send))
            .resolves.toBeNull();

        const leaseSql = JSON.stringify((queryRaw.mock.calls as unknown[][])[0]?.[0]);
        expect(leaseSql).toContain('feature-usage-webhook-delivery:');
        expect(leaseSql).toContain('CreditTransaction');
        expect(leaseSql).toContain('balanceAfter');
        expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'FAILED' }),
        }));
        expect(send).toHaveBeenCalledOnce();
    });
    it('pauses an in-flight PAST_DUE delivery and permits sending after ACTIVE recovery', async () => {
        let tenantStatus = 'ACTIVE';
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const queryRaw = vi.fn(async (_query: unknown) => [{
            tenantStatus,
            tenantDeletedAt: null,
            tenantPlanTier: 'GROWTH',
            tenantStripeSubscriptionId: 'sub_paid_1',
            tenantPaidThrough: new Date(Date.now() + 60_000),
            endpointActive: true,
            hasExactCreditReservation: true,
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
        expect(row.lastError).toBe('category=unknown class=Error');
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
            encryptedUrl: '',
            encryptedPayload: '',
            encryptionKeyRef: 'erased-v1',
        }));

        const failed = updateMany.mock.calls[1][0];
        expect(failed.data).toEqual(expect.objectContaining({
            status: 'FAILED',
            nextAttemptAt: new Date('2026-01-01T00:02:00.000Z'),
        }));
        expect(failed.data.lastError).not.toContain('delivery-token');
        expect(failed.data.lastError).toBe('category=unknown class=Error');

        const deadLettered = updateMany.mock.calls[2][0];
        expect(deadLettered.data).toEqual({
            status: 'DEAD_LETTERED',
            nextAttemptAt: null,
            lastError: 'category=unknown class=Error',
            encryptedUrl: '',
            encryptedPayload: '',
            encryptionKeyRef: 'erased-v1',
            attempts: 8,
        });

        vi.useRealTimers();
    });
});
