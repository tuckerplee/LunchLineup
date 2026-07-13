import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { WebhookDeliveryCrypto } from './webhook-delivery.crypto';
import { WebhookEndpointsController } from './webhook-endpoints.controller';

const encryptionKey = Buffer.alloc(32, 11).toString('base64');
const endpointBeforeUpdate = {
    id: 'endpoint-1',
    url: 'https://hooks.example.com/lunchlineup',
    events: ['schedule.published'],
    active: true,
    createdAt: new Date('2026-07-09T20:00:00.000Z'),
    updatedAt: new Date('2026-07-09T20:00:00.000Z'),
};
const endpointAfterUpdate = {
    ...endpointBeforeUpdate,
    url: 'https://hooks.example.com/v2',
    events: ['schedule.published'],
    updatedAt: new Date('2026-07-09T21:00:00.000Z'),
};

function harness() {
    let transactionCommitted = false;
    const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
        auditLog: {
            create: vi.fn().mockResolvedValue({}),
        },
        webhookEndpoint: {
            count: vi.fn().mockResolvedValue(0),
            create: vi.fn(async ({ data }: any) => ({
                ...endpointBeforeUpdate,
                url: data.url,
                events: data.events,
                active: data.active,
            })),
            findMany: vi.fn().mockResolvedValue([]),
            findFirst: vi.fn().mockResolvedValue(endpointBeforeUpdate),
            findFirstOrThrow: vi.fn().mockResolvedValue(endpointAfterUpdate),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
    };
    const prisma = {
        $transaction: vi.fn(async (operation: (client: any) => Promise<unknown>) => {
            const result = await operation(tx);
            transactionCommitted = true;
            return result;
        }),
    };
    const featureAccess = {
        assertFeatureEnabled: vi.fn().mockResolvedValue(undefined),
    };
    const deliveryCrypto = new WebhookDeliveryCrypto({
        get: vi.fn((key: string) => key === 'WEBHOOK_DELIVERY_ENCRYPTION_KEY_CURRENT' ? encryptionKey : undefined),
    } as any);
    const controller = new WebhookEndpointsController(
        featureAccess as any,
        deliveryCrypto,
        new TenantPrismaService(prisma as any),
    );
    const req = {
        user: { tenantId: 'tenant-1', sub: 'user-1' },
        ip: '203.0.113.9',
        headers: { 'user-agent': 'u'.repeat(700) },
    };
    return {
        controller,
        deliveryCrypto,
        featureAccess,
        prisma,
        req,
        tx,
        transactionCommitted: () => transactionCommitted,
    };
}

type Harness = ReturnType<typeof harness>;

function auditData(h: Harness) {
    return h.tx.auditLog.create.mock.calls[0][0].data;
}

describe('WebhookEndpointsController', () => {
    it('creates an endpoint and its attributed audit record in one tenant transaction', async () => {
        const h = harness();

        const result = await h.controller.create({
            url: 'https://hooks.example.com/lunchlineup#fragment',
            events: ['schedule.published'],
        }, h.req);

        const persistedSecret = h.tx.webhookEndpoint.create.mock.calls[0][0].data.secret;
        expect(h.featureAccess.assertFeatureEnabled).toHaveBeenCalledWith('tenant-1', 'webhooks');
        expect(persistedSecret).not.toContain(result.signingSecret);
        expect(h.deliveryCrypto.decryptString(persistedSecret)).toBe(result.signingSecret);
        expect(result).not.toHaveProperty('secret');
        expect(auditData(h)).toEqual({
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'user-1',
            actorTenantId: 'tenant-1',
            ipAddress: '203.0.113.9',
            userAgent: 'u'.repeat(512),
            action: 'WEBHOOK_ENDPOINT_CREATED',
            resource: 'WebhookEndpoint',
            resourceId: 'endpoint-1',
            newValue: {
                url: 'https://hooks.example.com',
                events: ['schedule.published'],
                active: true,
            },
        });
        expect(h.prisma.$transaction).toHaveBeenCalledOnce();
        expect(h.transactionCommitted()).toBe(true);
    });

    it('audits URL and event updates with bounded credential-free snapshots', async () => {
        const h = harness();
        h.tx.webhookEndpoint.findFirst.mockResolvedValue({
            ...endpointBeforeUpdate,
            url: 'https://legacy-user:legacy-password@hooks.example.com/old?token=secret#fragment',
            events: [],
        });

        await h.controller.update('endpoint-1', {
            url: 'https://hooks.example.com/v2',
            events: ['schedule.published'],
        }, h.req);

        expect(h.tx.webhookEndpoint.updateMany).toHaveBeenCalledWith({
            where: { id: 'endpoint-1', tenantId: 'tenant-1' },
            data: {
                url: 'https://hooks.example.com/v2',
                events: ['schedule.published'],
            },
        });
        expect(auditData(h)).toEqual(expect.objectContaining({
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'user-1',
            actorTenantId: 'tenant-1',
            action: 'WEBHOOK_ENDPOINT_UPDATED',
            resource: 'WebhookEndpoint',
            resourceId: 'endpoint-1',
            oldValue: {
                url: 'https://hooks.example.com',
                events: [],
                active: true,
            },
            newValue: {
                url: 'https://hooks.example.com',
                events: ['schedule.published'],
                active: true,
            },
        }));
        const serializedAudit = JSON.stringify(auditData(h));
        expect(serializedAudit).not.toContain('legacy-user');
        expect(serializedAudit).not.toContain('legacy-password');
        expect(serializedAudit).not.toContain('token');
        expect(serializedAudit.length).toBeLessThan(2048);
    });

    it('rotates a signing secret and audits the event without secret material or hashes', async () => {
        const h = harness();

        const result = await h.controller.rotateSecret('endpoint-1', h.req);

        const persistedSecret = h.tx.webhookEndpoint.updateMany.mock.calls[0][0].data.secret;
        expect(persistedSecret).not.toContain(result.signingSecret);
        expect(h.deliveryCrypto.decryptString(persistedSecret)).toBe(result.signingSecret);
        expect(auditData(h)).toEqual(expect.objectContaining({
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'user-1',
            actorTenantId: 'tenant-1',
            action: 'WEBHOOK_ENDPOINT_SECRET_ROTATED',
            resource: 'WebhookEndpoint',
            resourceId: 'endpoint-1',
            newValue: { signingSecretRotated: true },
        }));
        const serializedAudit = JSON.stringify(auditData(h));
        expect(serializedAudit).not.toContain(result.signingSecret);
        expect(serializedAudit).not.toContain(persistedSecret);
        expect(serializedAudit).not.toMatch(/[a-f0-9]{64}/i);
    });

    it('deactivates only the tenant endpoint and audits its active-state transition', async () => {
        const h = harness();

        await h.controller.deactivate('endpoint-1', h.req);

        expect(h.tx.webhookEndpoint.updateMany).toHaveBeenCalledWith({
            where: { id: 'endpoint-1', tenantId: 'tenant-1' },
            data: { active: false },
        });
        expect(auditData(h)).toEqual(expect.objectContaining({
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorUserId: 'user-1',
            actorTenantId: 'tenant-1',
            action: 'WEBHOOK_ENDPOINT_DEACTIVATED',
            resource: 'WebhookEndpoint',
            resourceId: 'endpoint-1',
            oldValue: { active: true },
            newValue: { active: false },
        }));
    });

    const auditedMutations: Array<[string, (h: Harness) => Promise<unknown>]> = [
        ['create', (h) => h.controller.create({
            url: 'https://hooks.example.com/lunchlineup',
            events: ['schedule.published'],
        }, h.req)],
        ['update', (h) => h.controller.update('endpoint-1', {
            url: 'https://hooks.example.com/v2',
            events: ['schedule.published'],
        }, h.req)],
        ['secret rotation', (h) => h.controller.rotateSecret('endpoint-1', h.req)],
        ['deactivation', (h) => h.controller.deactivate('endpoint-1', h.req)],
    ];

    it.each(auditedMutations)('rolls back %s when its immutable audit insert fails', async (_name, mutate) => {
        const h = harness();
        h.tx.auditLog.create.mockRejectedValue(new Error('audit insert failed'));

        await expect(mutate(h)).rejects.toThrow('audit insert failed');

        expect(h.tx.auditLog.create).toHaveBeenCalledOnce();
        expect(h.prisma.$transaction).toHaveBeenCalledOnce();
        expect(h.transactionCommitted()).toBe(false);
    });

    it('keeps endpoint reads tenant-scoped and never selects the signing secret', async () => {
        const h = harness();

        await h.controller.list(h.req);

        expect(h.tx.webhookEndpoint.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId: 'tenant-1' },
            select: expect.not.objectContaining({ secret: expect.anything() }),
        }));
    });

    it('blocks endpoint configuration when the paid feature is unavailable', async () => {
        const h = harness();
        h.featureAccess.assertFeatureEnabled.mockRejectedValue(new ForbiddenException('Upgrade required'));

        await expect(h.controller.create({
            url: 'https://hooks.example.com/lunchlineup',
            events: ['schedule.published'],
        }, h.req)).rejects.toBeInstanceOf(ForbiddenException);

        expect(h.prisma.$transaction).not.toHaveBeenCalled();
        expect(h.tx.webhookEndpoint.create).not.toHaveBeenCalled();
        expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects query-string credentials before storing or auditing an endpoint URL', async () => {
        const h = harness();

        await expect(h.controller.create({
            url: 'https://hooks.example.com/lunchlineup?token=secret',
            events: ['schedule.published'],
        }, h.req)).rejects.toThrow('url query parameters are not supported');

        expect(h.prisma.$transaction).not.toHaveBeenCalled();
        expect(h.tx.webhookEndpoint.create).not.toHaveBeenCalled();
        expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    });
});
