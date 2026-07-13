import { describe, expect, it, vi, afterEach } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { TenantAccountLifecycleService, type TenantLifecycleActor } from './tenant-account-lifecycle.service';

const actor: TenantLifecycleActor = {
    tenantId: 'tenant-1',
    userId: 'user-admin-1',
    ipAddress: '203.0.113.10',
    userAgent: 'vitest',
};

const scheduledCancellation = {
    action: 'scheduled' as const,
    stripeSubscriptionId: 'sub_123',
    stripeStatus: 'active',
    cancelAtPeriodEnd: true,
    currentPeriodEnd: '2027-01-15T08:00:00.000Z',
    cancelAt: null,
    canceledAt: null,
    cancellationBehavior: 'cancel_at_period_end' as const,
};

const billingPurge = {
    expiredCheckoutSessionIds: ['cs_open'],
    canceledSubscriptionIds: ['sub_123'],
    alreadyTerminalSubscriptionIds: [],
};

function addTransactionMock<T extends Record<string, any>>(prisma: T): T {
    (prisma as any).$queryRaw = vi.fn().mockResolvedValue([{ id: 'tenant-1' }]);
    (prisma as any).$executeRaw = vi.fn().mockResolvedValue(1);
    (prisma as any).$transaction = vi.fn(async (operation: (tx: T) => Promise<unknown>) => operation(prisma));
    return prisma;
}

function buildPrisma(): any {
    return addTransactionMock({
        tenant: {
            findMany: vi.fn(),
            findUnique: vi.fn(),
            findUniqueOrThrow: vi.fn(),
            update: vi.fn(),
        },
        session: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        webhookEndpoint: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        webhookDelivery: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        auditLog: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({}),
        },
    });
}

function buildService(prisma = buildPrisma()) {
    const stripeBilling = {
        cancelTenantSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue(scheduledCancellation),
        finalizeTenantBillingForPurge: vi.fn().mockResolvedValue(billingPurge),
    };
    return {
        prisma,
        stripeBilling,
        service: new TenantAccountLifecycleService(
            new TenantPrismaService(prisma as any),
            stripeBilling as any,
        ),
    };
}

const activeTenant = {
    id: 'tenant-1',
    slug: 'acme-dining',
    status: 'ACTIVE',
    deletedAt: null,
    stripeSubscriptionId: 'sub_123',
};

const suspendedTenant = {
    id: 'tenant-1',
    slug: 'acme-dining',
    status: 'SUSPENDED',
    deletedAt: null,
};

describe('TenantAccountLifecycleService billing cancellation', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('schedules Stripe cancellation without revoking paid access before period end', async () => {
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow.mockResolvedValue(activeTenant);

        const result = await service.cancelTenant(actor, {
            confirmation: 'acme-dining',
            reason: 'closing account',
        });

        expect(stripeBilling.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledWith('tenant-1', 'sub_123');
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER',
                newValue: {
                    reason: 'closing account',
                    billingCancellation: scheduledCancellation,
                },
            }),
        });
        expect(result).toMatchObject({
            status: 'ACTIVE',
            cancellationEffectiveAt: scheduledCancellation.currentPeriodEnd,
            billingCancellation: scheduledCancellation,
        });
    });

    it('does not mark a tenant cancelled when Stripe cancellation fails', async () => {
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow.mockResolvedValue(activeTenant);
        stripeBilling.cancelTenantSubscriptionAtPeriodEnd.mockRejectedValue(new Error('Stripe unavailable'));

        await expect(service.cancelTenant(actor, { confirmation: 'acme-dining' }))
            .rejects.toThrow('Stripe unavailable');

        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });
});

describe('TenantAccountLifecycleService deletion saga', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('commits SUSPENDED access and paid-work barriers before external Stripe cleanup, then finalizes PURGED', async () => {
        const requestedAt = new Date('2026-07-09T12:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(requestedAt);
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow
            .mockResolvedValueOnce(activeTenant)
            .mockResolvedValueOnce(suspendedTenant);
        prisma.tenant.update
            .mockResolvedValueOnce(suspendedTenant)
            .mockResolvedValueOnce({ ...suspendedTenant, status: 'PURGED', deletedAt: requestedAt });

        const result = await service.requestDeletion(actor, { confirmation: 'acme-dining' });

        expect(prisma.tenant.update).toHaveBeenNthCalledWith(1, {
            where: { id: 'tenant-1' },
            data: { status: 'SUSPENDED', deletedAt: null },
            select: { id: true, slug: true, status: true, deletedAt: true },
        });
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { user: { tenantId: 'tenant-1' }, revokedAt: null },
            data: { revokedAt: requestedAt },
        });
        expect(prisma.webhookEndpoint.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', active: true },
            data: { active: false },
        });
        expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                status: { in: ['PENDING', 'QUEUED', 'SENDING', 'FAILED'] },
            },
            data: {
                status: 'DEAD_LETTERED',
                nextAttemptAt: null,
                lastError: 'Tenant account deletion requested',
            },
        });
        expect(prisma.$executeRaw).toHaveBeenCalledOnce();
        expect(prisma.tenant.update.mock.invocationCallOrder[0]).toBeLessThan(
            stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0],
        );
        expect(prisma.session.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
            stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0],
        );
        expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
            stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0],
        );
        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenCalledWith('tenant-1');
        expect(prisma.tenant.update).toHaveBeenNthCalledWith(2, {
            where: { id: 'tenant-1' },
            data: {
                status: 'PURGED',
                deletedAt: requestedAt,
                stripeSubscriptionId: null,
            },
            select: { id: true, slug: true, status: true, deletedAt: true },
        });
        expect(stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.tenant.update.mock.invocationCallOrder[1],
        );
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'TENANT_DELETION_BARRIER_COMMITTED',
                newValue: expect.objectContaining({ status: 'SUSPENDED' }),
            }),
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER',
                newValue: expect.objectContaining({ billingPurge }),
            }),
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
        expect(result.status).toBe('PURGED');
    });

    it('keeps the committed SUSPENDED barrier when Stripe cleanup fails', async () => {
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow.mockResolvedValue(activeTenant);
        prisma.tenant.update.mockResolvedValue(suspendedTenant);
        stripeBilling.finalizeTenantBillingForPurge.mockRejectedValue(new Error('Stripe unavailable'));

        await expect(service.requestDeletion(actor, { confirmation: 'acme-dining' }))
            .rejects.toThrow('Stripe unavailable');

        expect(prisma.tenant.update).toHaveBeenCalledOnce();
        expect(prisma.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { status: 'SUSPENDED', deletedAt: null },
        }));
        expect(prisma.session.updateMany).toHaveBeenCalledOnce();
        expect(prisma.$executeRaw).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'TENANT_DELETION_BARRIER_COMMITTED' }),
        });
        expect(prisma.$transaction).toHaveBeenCalledOnce();
    });

    it('retries safely from an existing SUSPENDED barrier using the original request time', async () => {
        const barrierCommittedAt = new Date('2026-07-08T12:00:00.000Z');
        const retriedAt = new Date('2026-07-09T12:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(retriedAt);
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow
            .mockResolvedValueOnce(suspendedTenant)
            .mockResolvedValueOnce(suspendedTenant);
        prisma.auditLog.findFirst.mockResolvedValue({
            id: 'audit-barrier-1',
            userId: actor.userId,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
            createdAt: barrierCommittedAt,
        });
        prisma.tenant.update.mockResolvedValue({
            ...suspendedTenant,
            status: 'PURGED',
            deletedAt: barrierCommittedAt,
        });

        const result = await service.requestDeletion(actor, { confirmation: 'acme-dining' });

        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenCalledOnce();
        expect(prisma.$executeRaw).toHaveBeenCalledOnce();
        expect(prisma.tenant.update).toHaveBeenCalledOnce();
        expect(prisma.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'PURGED', deletedAt: barrierCommittedAt }),
        }));
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER' }),
        });
        expect(result).toMatchObject({ status: 'PURGED', deletionRequestedAt: barrierCommittedAt });
    });
    it('rejects an already finalized purge without repeating Stripe or database side effects', async () => {
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'PURGED',
            deletedAt: new Date('2026-07-09T12:00:00.000Z'),
        });

        await expect(service.requestDeletion(actor, { confirmation: 'acme-dining' }))
            .rejects.toThrow('already been requested');

        expect(stripeBilling.finalizeTenantBillingForPurge).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('leaves the SUSPENDED phase-one write as the last committed state when phase two fails', async () => {
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow
            .mockResolvedValueOnce(activeTenant)
            .mockResolvedValueOnce(suspendedTenant);
        prisma.tenant.update
            .mockResolvedValueOnce(suspendedTenant)
            .mockRejectedValueOnce(new Error('phase two database failure'));

        await expect(service.requestDeletion(actor, { confirmation: 'acme-dining' }))
            .rejects.toThrow('phase two database failure');

        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenCalledOnce();
        expect(prisma.tenant.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
            data: { status: 'SUSPENDED', deletedAt: null },
        }));
        expect(prisma.tenant.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
            data: expect.objectContaining({ status: 'PURGED' }),
        }));
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'TENANT_DELETION_BARRIER_COMMITTED' }),
        });
    });

    it('discovers suspended deletion barriers for bounded scheduler reconciliation', async () => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        const barrierCommittedAt = new Date('2026-07-08T12:00:00.000Z');
        const { service, prisma } = buildService();
        prisma.tenant.findMany.mockResolvedValue([{
            id: 'tenant-1',
            auditLogs: [{ createdAt: barrierCommittedAt }],
        }]);

        await expect(service.listPendingDeletionBillingCandidates(25)).resolves.toEqual([{
            id: 'tenant-1',
            deletionRequestedAt: barrierCommittedAt,
        }]);
        expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ status: 'SUSPENDED', deletedAt: null }),
            take: 25,
        }));
    });

    it('reconciles a suspended deletion barrier with Stripe and the original request metadata', async () => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        const barrierCommittedAt = new Date('2026-07-08T12:00:00.000Z');
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-1',
            status: 'SUSPENDED',
            deletedAt: null,
            auditLogs: [{
                userId: actor.userId,
                ipAddress: actor.ipAddress,
                userAgent: actor.userAgent,
                createdAt: barrierCommittedAt,
            }],
        });
        prisma.tenant.findUniqueOrThrow.mockResolvedValue(suspendedTenant);
        prisma.tenant.update.mockResolvedValue({
            ...suspendedTenant,
            status: 'PURGED',
            deletedAt: barrierCommittedAt,
        });

        const result = await service.reconcilePendingDeletionBillingCandidate('tenant-1');

        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenCalledWith('tenant-1');
        expect(prisma.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'PURGED',
                deletedAt: barrierCommittedAt,
                stripeSubscriptionId: null,
            }),
        }));
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: actor.userId,
                ipAddress: actor.ipAddress,
                userAgent: actor.userAgent,
                action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER',
            }),
        });
        expect(result).toMatchObject({
            outcome: 'processed',
            tenantId: 'tenant-1',
            result: { deletionRequestedAt: barrierCommittedAt },
        });
    });
    it('terminalizes only nonterminal solve jobs and reuses the worker refund ledger identity', async () => {
        const { service, prisma } = buildService();
        prisma.tenant.findUniqueOrThrow.mockResolvedValue(activeTenant);
        prisma.tenant.update.mockResolvedValue(suspendedTenant);
        const stripeError = new Error('stop after phase one');
        const stripeBilling = (service as any).stripeBilling;
        stripeBilling.finalizeTenantBillingForPurge.mockRejectedValue(stripeError);

        await expect(service.requestDeletion(actor, { confirmation: 'acme-dining' }))
            .rejects.toThrow(stripeError);

        const rawCall = prisma.$executeRaw.mock.calls[0];
        const sql = Array.from(rawCall[0] as readonly string[]).join(' ');
        expect(sql).toContain(`"status" IN ('QUEUED', 'RUNNING', 'RETRYING')`);
        expect(sql).toContain(`"status" = 'DEAD_LETTERED'`);
        expect(sql).toContain(`'schedule-credit-refund-' || "id"`);
        expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
        expect(sql).toContain('tenant."usageCredits" + refund_totals."amount"');
        expect(rawCall).toContain('tenant-1');
    });
});

describe('TenantAccountLifecycleService retention serialization', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('skips a tenant when another purge transaction owns its advisory lock', async () => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        const prisma: any = {
            $queryRaw: vi.fn()
                .mockResolvedValueOnce([{ set_current_platform_admin: null }])
                .mockResolvedValueOnce([{ claimed: false }]),
            $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>) => operation(prisma)),
            tenant: { findUnique: vi.fn() },
        };
        const service = new TenantAccountLifecycleService(new TenantPrismaService(prisma));

        await expect(service.purgeRetentionCandidate({
            id: 'tenant-1',
            slug: 'acme',
            status: 'PURGED',
            deletedAt: new Date('2026-01-01T00:00:00.000Z'),
        }, 'retained_records', new Date('2033-07-10T00:00:00.000Z'))).resolves.toEqual({
            outcome: 'skipped',
            tenantId: 'tenant-1',
            reason: 'Tenant purge is already claimed.',
        });
        expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
    });
});