import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import {
    TenantAccountLifecycleService,
    type TenantLifecycleActor,
    type TenantRetentionLegalHoldActor,
} from './tenant-account-lifecycle.service';
import { isTenantReadyForApplicationDataPurge, isTenantReadyForRetentionPurge } from './tenant-account-lifecycle';

const postgresIntegrationUrl = process.env.MIGRATION_DATABASE_URL;
const postgresIntegrationCapability = process.env.TENANT_DATA_GOVERNANCE_TEST_CAPABILITY
    ?? process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET;

const actor: TenantLifecycleActor = {
    tenantId: 'tenant-1',
    userId: 'user-admin-1',
    ipAddress: '203.0.113.10',
    userAgent: 'vitest',
};

const legalHoldActor: TenantRetentionLegalHoldActor = {
    tenantId: actor.tenantId,
    userId: 'user-admin-1',
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
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

function executeRawCallIndexesContaining(prisma: any, sqlFragment: string): number[] {
    return prisma.$executeRaw.mock.calls
        .map((call: any[], index: number) => ({
            index,
            sql: `${Array.from(call[0] as readonly string[]).join(' ')} ${call.slice(1).join(' ')}`,
        }))
        .filter(({ sql }: { sql: string }) => sql.includes(sqlFragment))
        .map(({ index }: { index: number }) => index);
}

function addTransactionMock<T extends Record<string, any>>(prisma: T): T {
    (prisma as any).$queryRaw = vi.fn().mockImplementation(async (query: readonly string[]) => {
        const sql = Array.from(query).join(' ');
        if (sql.includes('invalid_provenance AS')) {
            return [];
        }
        if (sql.includes('COUNT(*)::integer FROM refund_candidates')) {
            return [{
                candidateCount: 0,
                settledCount: 0,
                replayedCount: 0,
                lockedWebhookCount: 0,
                refundableWebhookCount: 0,
                terminalizedWebhookCount: 0,
            }];
        }
        return [{
            id: 'tenant-1',
            operationId: 'tenant-deletion-audit-barrier-1',
        }];
    });
    (prisma as any).$executeRaw = vi.fn().mockResolvedValue(1);
    (prisma as any).$transaction = vi.fn(async (operation: (tx: T) => Promise<unknown>) => operation(prisma));
    return prisma;
}

function queryRawCallIndexesContaining(prisma: any, sqlFragment: string): number[] {
    return prisma.$queryRaw.mock.calls
        .map((call: any[], index: number) => ({
            index,
            sql: `${Array.from(call[0] as readonly string[]).join(' ')} ${call.slice(1).join(' ')}`,
        }))
        .filter(({ sql }: { sql: string }) => sql.includes(sqlFragment))
        .map(({ index }: { index: number }) => index);
}

function buildPrisma(): any {
    return addTransactionMock({
        tenant: {
            findMany: vi.fn(),
            findUnique: vi.fn(),
            findUniqueOrThrow: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
        tenantSetting: {
            findUnique: vi.fn().mockResolvedValue(null),
        },
    });
}

function buildService(prisma = buildPrisma()) {
    const stripeBilling = {
        cancelTenantSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue(scheduledCancellation),
        finalizeTenantBillingForPurge: vi.fn().mockResolvedValue(billingPurge),
    };
    const tenantCancellationLifecycle = {
        cancelCustomer: vi.fn().mockResolvedValue({
            id: activeTenant.id,
            slug: activeTenant.slug,
            status: activeTenant.status,
            cancellationEffectiveAt: scheduledCancellation.currentPeriodEnd,
            billingCancellation: scheduledCancellation,
        }),
        archivePlatform: vi.fn(),
    };
    return {
        prisma,
        stripeBilling,
        tenantCancellationLifecycle,
        service: new TenantAccountLifecycleService(
            new TenantPrismaService(prisma as any),
            stripeBilling as any,
            tenantCancellationLifecycle as any,
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
        const { service, prisma, stripeBilling, tenantCancellationLifecycle } = buildService();

        const result = await service.cancelTenant(actor, {
            confirmation: 'acme-dining',
            reason: 'closing account',
        });

        expect(tenantCancellationLifecycle.cancelCustomer).toHaveBeenCalledWith(actor, {
            confirmation: 'acme-dining',
            reason: 'closing account',
        });
        expect(stripeBilling.cancelTenantSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            status: 'ACTIVE',
            cancellationEffectiveAt: scheduledCancellation.currentPeriodEnd,
            billingCancellation: scheduledCancellation,
        });
    });

    it('does not mark a tenant cancelled when Stripe cancellation fails', async () => {
        const { service, prisma, tenantCancellationLifecycle } = buildService();
        tenantCancellationLifecycle.cancelCustomer.mockRejectedValue(
            new Error('Tenant billing lifecycle is pending reconciliation.'),
        );

        await expect(service.cancelTenant(actor, { confirmation: 'acme-dining' }))
            .rejects.toThrow('pending reconciliation');

        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('keeps the finalized cancellation effective date in GET account status after refresh', async () => {
        const { service, prisma } = buildService();
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            ...activeTenant,
            applicationDataPurgedAt: null,
            retentionLegalHoldAt: null,
            retentionLegalHoldReason: null,
            retentionLegalHoldByUserId: null,
        });
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                tenantId: actor.tenantId,
                kind: 'CUSTOMER_CANCELLATION',
                state: 'FINALIZED',
                providerResult: scheduledCancellation,
            },
        });

        await expect(service.getStatus(actor)).resolves.toMatchObject({
            status: 'ACTIVE',
            lifecycleStatus: 'CANCELLATION_SCHEDULED',
            cancellationEffectiveAt: scheduledCancellation.currentPeriodEnd,
        });
        expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
            where: {
                tenantId_key: {
                    tenantId: actor.tenantId,
                    key: 'internal:tenant-lifecycle-intent:customer_cancellation',
                },
            },
            select: { value: true },
        });
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
        const terminalizationCallIndexes = queryRawCallIndexesContaining(prisma, 'terminalized_jobs AS');
        expect(terminalizationCallIndexes).toHaveLength(1);
        const terminalizationSql = Array.from(
            prisma.$queryRaw.mock.calls[terminalizationCallIndexes[0]][0] as readonly string[],
        ).join(' ');
        expect(terminalizationSql).toContain('terminalized_webhook_deliveries AS');
        expect(terminalizationSql).toContain('refundable_webhook_deliveries AS');
        expect(terminalizationSql).toContain('feature-refund-webhook-delivery:');
        expect(prisma.tenant.update.mock.invocationCallOrder[0]).toBeLessThan(
            stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0],
        );
        expect(prisma.session.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
            stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0],
        );
        expect(prisma.$queryRaw.mock.invocationCallOrder[terminalizationCallIndexes[0]]).toBeLessThan(
            stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0],
        );
        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenCalledWith('tenant-1', {
            operationId: 'tenant-deletion-audit-barrier-1',
            providerDeadlineAtMs: expect.any(Number),
            signal: expect.any(AbortSignal),
        });
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
                actorUserId: actor.userId,
                actorTenantId: actor.tenantId,
                newValue: expect.objectContaining({ status: 'SUSPENDED' }),
            }),
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER',
                actorUserId: actor.userId,
                actorTenantId: actor.tenantId,
                newValue: expect.objectContaining({ billingPurge }),
            }),
        });
        const lifecycleLocks = executeRawCallIndexesContaining(prisma, 'public.lock_tenant_lifecycle(');
        const billingLocks = executeRawCallIndexesContaining(prisma, 'billing-checkout:');
        expect(lifecycleLocks).toHaveLength(2);
        expect(billingLocks).toHaveLength(2);
        expect(prisma.$executeRaw.mock.invocationCallOrder[lifecycleLocks[0]])
            .toBeLessThan(prisma.$executeRaw.mock.invocationCallOrder[billingLocks[0]]);
        expect(prisma.$executeRaw.mock.invocationCallOrder[lifecycleLocks[1]])
            .toBeLessThan(prisma.$executeRaw.mock.invocationCallOrder[billingLocks[1]]);
        const providerEntryLeaseRenewals = executeRawCallIndexesContaining(
            prisma,
            'SET "leaseExpiresAt" =',
        );
        expect(providerEntryLeaseRenewals).toHaveLength(1);
        expect(prisma.$executeRaw.mock.invocationCallOrder[providerEntryLeaseRenewals[0]])
            .toBeLessThan(stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0]);
        expect(prisma.$transaction).toHaveBeenCalledTimes(3);
        expect(prisma.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
        expect(prisma.$transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
        expect(prisma.$transaction).toHaveBeenNthCalledWith(3, expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
        expect(result).toMatchObject({
            status: 'PURGED',
            deletionState: 'FINALIZED',
            billingCleanupPending: false,
        });
    });

    it('returns a durable pending receipt when Stripe cleanup fails after the barrier commits', async () => {
        const requestedAt = new Date('2026-07-09T12:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(requestedAt);
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow.mockResolvedValue(activeTenant);
        prisma.tenant.update.mockResolvedValue(suspendedTenant);
        stripeBilling.finalizeTenantBillingForPurge.mockRejectedValue(new Error('Stripe unavailable'));

        const result = await service.requestDeletion(actor, { confirmation: 'acme-dining' });

        expect(result).toMatchObject({
            status: 'SUSPENDED',
            deletionState: 'PENDING_BILLING_CLEANUP',
            billingCleanupPending: true,
            deletionRequestedAt: requestedAt,
            retention: {
                deletionRequestedAt: requestedAt.toISOString(),
            },
        });
        expect(JSON.stringify(result)).not.toContain('Stripe unavailable');
        expect(prisma.tenant.update).toHaveBeenCalledOnce();
        expect(prisma.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
            data: { status: 'SUSPENDED', deletedAt: null },
        }));
        expect(prisma.session.updateMany).toHaveBeenCalledOnce();
        expect(queryRawCallIndexesContaining(prisma, 'terminalized_jobs AS')).toHaveLength(1);
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'TENANT_DELETION_BARRIER_COMMITTED' }),
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(3);
        expect(prisma.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
        expect(prisma.$transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
        expect(prisma.$transaction).toHaveBeenNthCalledWith(3, expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
        const claimCalls = queryRawCallIndexesContaining(
            prisma,
            '"attemptCount" = reconciliation."attemptCount" + 1',
        );
        const failureStateCalls = executeRawCallIndexesContaining(
            prisma,
            'PROVIDER_OR_FINALIZATION_FAILED',
        );
        const providerEntryLeaseRenewals = executeRawCallIndexesContaining(
            prisma,
            'SET "leaseExpiresAt" =',
        );
        expect(claimCalls).toHaveLength(1);
        expect(providerEntryLeaseRenewals).toHaveLength(1);
        expect(failureStateCalls).toHaveLength(1);
        expect(prisma.$queryRaw.mock.invocationCallOrder[claimCalls[0]])
            .toBeLessThan(prisma.$executeRaw.mock.invocationCallOrder[providerEntryLeaseRenewals[0]]);
        expect(prisma.$executeRaw.mock.invocationCallOrder[providerEntryLeaseRenewals[0]])
            .toBeLessThan(stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0]);
        expect(stripeBilling.finalizeTenantBillingForPurge.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.$executeRaw.mock.invocationCallOrder[failureStateCalls[0]]);
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
            actorUserId: actor.userId,
            actorTenantId: actor.tenantId,
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
        expect(queryRawCallIndexesContaining(prisma, 'terminalized_jobs AS')).toHaveLength(0);
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.webhookEndpoint.updateMany).not.toHaveBeenCalled();
        expect(prisma.webhookDelivery.updateMany).not.toHaveBeenCalled();
        expect(prisma.tenant.update).toHaveBeenCalledOnce();
        expect(prisma.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'PURGED', deletedAt: barrierCommittedAt }),
        }));
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER' }),
        });
        expect(result).toMatchObject({
            status: 'PURGED',
            deletionState: 'FINALIZED',
            billingCleanupPending: false,
            deletionRequestedAt: barrierCommittedAt,
        });
    });
    it('returns the existing finalized receipt without repeating Stripe or database side effects', async () => {
        const requestedAt = new Date('2026-07-09T12:00:00.000Z');
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'PURGED',
            deletedAt: requestedAt,
        });

        const result = await service.requestDeletion(actor, { confirmation: 'acme-dining' });

        expect(result).toMatchObject({
            status: 'PURGED',
            deletionState: 'FINALIZED',
            billingCleanupPending: false,
            deletionRequestedAt: requestedAt,
        });
        expect(stripeBilling.finalizeTenantBillingForPurge).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(queryRawCallIndexesContaining(prisma, 'terminalized_jobs AS')).toHaveLength(0);
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
    it('returns the pending receipt when phase-two database finalization fails', async () => {
        const { service, prisma, stripeBilling } = buildService();
        prisma.tenant.findUniqueOrThrow
            .mockResolvedValueOnce(activeTenant)
            .mockResolvedValueOnce(suspendedTenant);
        prisma.tenant.update
            .mockResolvedValueOnce(suspendedTenant)
            .mockRejectedValueOnce(new Error('phase two database failure'));

        const result = await service.requestDeletion(actor, { confirmation: 'acme-dining' });

        expect(result).toMatchObject({
            status: 'SUSPENDED',
            deletionState: 'PENDING_BILLING_CLEANUP',
            billingCleanupPending: true,
        });
        expect(JSON.stringify(result)).not.toContain('phase two database failure');
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
                id: 'audit-barrier-1',
                userId: actor.userId,
                actorUserId: actor.userId,
                actorTenantId: actor.tenantId,
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

        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenCalledWith('tenant-1', {
            operationId: 'tenant-deletion-audit-barrier-1',
            providerDeadlineAtMs: expect.any(Number),
            signal: expect.any(AbortSignal),
        });
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
                actorUserId: actor.userId,
                actorTenantId: actor.tenantId,
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
    it('sanitizes scheduler billing reconciliation failures', async () => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        const { service, prisma } = buildService();
        prisma.tenant.findUnique.mockRejectedValue(
            new Error('DATABASE_URL=postgresql://user:password@db/private?token=secret'),
        );

        const result = await service.reconcilePendingDeletionBillingCandidate('tenant-1');

        expect(result).toEqual({
            outcome: 'failed',
            tenantId: 'tenant-1',
            error: 'Tenant deletion billing reconciliation failed.',
        });
        expect(JSON.stringify(result)).not.toContain('password');
        expect(JSON.stringify(result)).not.toContain('token=secret');
    });

    it('terminalizes only nonterminal solve jobs and reuses the worker refund ledger identity', async () => {
        const { service, prisma } = buildService();
        prisma.tenant.findUniqueOrThrow.mockResolvedValue(activeTenant);
        prisma.tenant.update.mockResolvedValue(suspendedTenant);
        const stripeError = new Error('stop after phase one');
        const stripeBilling = (service as any).stripeBilling;
        stripeBilling.finalizeTenantBillingForPurge.mockRejectedValue(stripeError);

        await expect(service.requestDeletion(actor, { confirmation: 'acme-dining' }))
            .resolves.toMatchObject({ deletionState: 'PENDING_BILLING_CLEANUP' });

        const terminalizationCallIndexes = queryRawCallIndexesContaining(prisma, 'terminalized_jobs AS');
        expect(terminalizationCallIndexes).toHaveLength(1);
        const rawCall = prisma.$queryRaw.mock.calls[terminalizationCallIndexes[0]];
        const sql = Array.from(rawCall[0] as readonly string[]).join(' ');
        expect(sql).toContain(`"status" IN ('QUEUED', 'RUNNING', 'RETRYING')`);
        expect(sql).toContain(`"status" = 'DEAD_LETTERED'`);
        expect(sql).toContain(`debit."id" = 'schedule-credit-' || job."id"`);
        expect(sql).toContain(`THEN -debit."amount" = (job."creditConsumption"->>'consumedCredits')::integer`);
        expect(sql).toContain('-debit."amount" AS "amount"');
        expect(sql).toContain(`'schedule-credit-refund-' || "id"`);
        expect(sql).toContain('public.settle_positive_credit_value(');
        expect(sql).toContain('settlement."creditedValue" = candidate."amount"');
        expect(sql).not.toContain('tenant."usageCredits" +');
        expect(rawCall).toContain('tenant-1');
    });

});

describe('TenantAccountLifecycleService retention serialization', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('skips a tenant when another purge transaction owns its advisory lock', async () => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        const prisma: any = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([{ claimed: false }]),
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

    it('serializes hold placement and release before their reads, blocks both stages, and restores eligibility only after audit', async () => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        const placedAt = new Date('2026-07-10T12:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(placedAt);
        const { service, prisma } = buildService();
        const heldTenant = {
            id: 'tenant-1',
            slug: 'acme',
            status: 'PURGED',
            deletedAt: new Date('2026-01-01T00:00:00.000Z'),
            applicationDataPurgedAt: null,
            retentionLegalHoldAt: null as Date | null,
            retentionLegalHoldReason: null as string | null,
            retentionLegalHoldByUserId: null as string | null,
        };
        prisma.tenant.findUnique.mockImplementation(async () => ({ ...heldTenant }));
        prisma.tenant.updateMany.mockImplementation(async ({ data }: any) => {
            Object.assign(heldTenant, data);
            return { count: 1 };
        });

        await expect(service.placeRetentionLegalHold('tenant-1', legalHoldActor, {
            reason: 'Preserve records for active litigation.',
        })).resolves.toMatchObject({
            id: 'tenant-1',
            legalHold: { placedAt, placedByUserId: legalHoldActor.userId },
        });
        expect(isTenantReadyForApplicationDataPurge(
            heldTenant,
            new Date('2026-08-01T00:00:00.000Z'),
        )).toBe(false);
        expect(isTenantReadyForRetentionPurge(
            heldTenant,
            new Date('2033-07-10T00:00:00.000Z'),
        )).toBe(false);

        await expect(service.releaseRetentionLegalHold('tenant-1', legalHoldActor, {
            reason: 'Litigation preservation order is closed.',
        })).resolves.toMatchObject({ id: 'tenant-1', legalHold: null });
        expect(isTenantReadyForApplicationDataPurge(
            heldTenant,
            new Date('2026-08-01T00:00:00.000Z'),
        )).toBe(true);
        expect(isTenantReadyForRetentionPurge(
            heldTenant,
            new Date('2033-07-10T00:00:00.000Z'),
        )).toBe(true);
        expect(prisma.auditLog.create).toHaveBeenNthCalledWith(1, {
            data: expect.objectContaining({
                action: 'TENANT_RETENTION_LEGAL_HOLD_PLACED',
                actorUserId: legalHoldActor.userId,
                actorTenantId: legalHoldActor.tenantId,
            }),
        });
        expect(prisma.auditLog.create).toHaveBeenNthCalledWith(2, {
            data: expect.objectContaining({
                action: 'TENANT_RETENTION_LEGAL_HOLD_RELEASED',
                newValue: {
                    legalHold: null,
                    releaseReason: 'Litigation preservation order is closed.',
                },
            }),
        });
        const lockCallIndexes = executeRawCallIndexesContaining(
            prisma,
            'public.lock_tenant_lifecycle(',
        );
        expect(lockCallIndexes).toHaveLength(2);
        expect(prisma.$executeRaw.mock.calls[lockCallIndexes[0]]).toContain('tenant-1');
        expect(prisma.$executeRaw.mock.calls[lockCallIndexes[1]]).toContain('tenant-1');
        expect(prisma.$executeRaw.mock.invocationCallOrder[lockCallIndexes[0]])
            .toBeLessThan(prisma.tenant.findUnique.mock.invocationCallOrder[0]);
        expect(prisma.$executeRaw.mock.invocationCallOrder[lockCallIndexes[1]])
            .toBeLessThan(prisma.tenant.findUnique.mock.invocationCallOrder[1]);
        expect(prisma.$transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
        expect(prisma.$transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
    });

    it.each(['application_data', 'retained_records'] as const)(
        'transactionally skips %s when a hold appears after candidate selection',
        async (stage) => {
            vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
            const prisma: any = {
                $executeRaw: vi.fn().mockResolvedValue(1),
                $queryRaw: vi.fn().mockResolvedValue([{ claimed: true }]),
                $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>) => operation(prisma)),
                tenant: {
                    findUnique: vi.fn().mockResolvedValue({
                        id: 'tenant-1',
                        slug: 'acme',
                        status: 'PURGED',
                        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
                        applicationDataPurgedAt: null,
                        retentionLegalHoldAt: new Date('2026-07-09T00:00:00.000Z'),
                        retentionLegalHoldReason: 'Active litigation preservation.',
                        retentionLegalHoldByUserId: 'platform-admin-1',
                    }),
                },
            };
            const service = new TenantAccountLifecycleService(new TenantPrismaService(prisma));

            await expect(service.purgeRetentionCandidate({
                id: 'tenant-1',
                slug: 'acme',
                status: 'PURGED',
                deletedAt: new Date('2026-01-01T00:00:00.000Z'),
                applicationDataPurgedAt: null,
            }, stage, new Date('2033-07-10T00:00:00.000Z'))).resolves.toEqual({
                outcome: 'skipped',
                tenantId: 'tenant-1',
                reason: 'Tenant retention legal hold is active.',
            });
        },
    );

    it('sanitizes retention purge failures', async () => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        const prisma: any = {
            $transaction: vi.fn().mockRejectedValue(
                new Error('DATABASE_URL=postgresql://user:password@db/private?token=secret'),
            ),
        };
        const service = new TenantAccountLifecycleService(new TenantPrismaService(prisma));

        const result = await service.purgeRetentionCandidate({
            id: 'tenant-1',
            slug: 'acme',
            status: 'PURGED',
            deletedAt: new Date('2026-01-01T00:00:00.000Z'),
        }, 'retained_records', new Date('2033-07-10T00:00:00.000Z'));

        expect(result).toEqual({
            outcome: 'failed',
            tenantId: 'tenant-1',
            error: 'Tenant purge failed.',
        });
        expect(JSON.stringify(result)).not.toContain('password');
        expect(JSON.stringify(result)).not.toContain('token=secret');
    });

    it('fails the tenant transaction without marking application purge when payroll preconditions reject', async () => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        const payrollError = new Error('time cards require current immutable payroll snapshots before purge');
        const prisma: any = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn()
                .mockResolvedValueOnce([{ claimed: true }])
                .mockRejectedValueOnce(payrollError),
            $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>) => operation(prisma)),
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'tenant-1',
                    slug: 'acme',
                    status: 'PURGED',
                    deletedAt: new Date('2026-01-01T00:00:00.000Z'),
                    applicationDataPurgedAt: null,
                }),
                update: vi.fn(),
            },
            billingEvent: { updateMany: vi.fn() },
            session: { deleteMany: vi.fn() },
        };
        const service = new TenantAccountLifecycleService(new TenantPrismaService(prisma));

        await expect(service.purgeRetentionCandidate({
            id: 'tenant-1',
            slug: 'acme',
            status: 'PURGED',
            deletedAt: new Date('2026-01-01T00:00:00.000Z'),
            applicationDataPurgedAt: null,
        }, 'application_data', new Date('2026-07-10T00:00:00.000Z'))).resolves.toEqual({
            outcome: 'failed',
            tenantId: 'tenant-1',
            error: 'Tenant purge failed.',
        });

        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
            maxWait: 5_000,
            timeout: 60_000,
        });
        expect(prisma.billingEvent.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.deleteMany).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
    });
});

if (postgresIntegrationUrl && postgresIntegrationCapability) {
    describe('TenantAccountLifecycleService Postgres legal-hold ownership', () => {
        it('serializes a real hold transition and persists status plus attributed place/release audits', async () => {
            const databaseUrl = postgresIntegrationUrl;
            const capability = postgresIntegrationCapability;
            const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
            const contender = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
            const suffix = randomUUID();
            const tenantId = `tenant-hold-${suffix}`;
            const userId = `user-hold-${suffix}`;
            const holdActor: TenantRetentionLegalHoldActor = {
                tenantId,
                userId,
                ipAddress: '203.0.113.20',
                userAgent: 'vitest-postgres',
            };
            let releaseLock!: () => void;
            const lockRelease = new Promise<void>((resolve) => { releaseLock = resolve; });
            let signalLocked!: () => void;
            const lockAcquired = new Promise<void>((resolve) => { signalLocked = resolve; });

            try {
                await prisma.$executeRaw`
                    INSERT INTO "Tenant" ("id", "name", "slug", "status", "usageCredits", "createdAt", "updatedAt")
                    VALUES (${tenantId}, 'Legal Hold Proof', ${`legal-hold-${suffix}`},
                            'ACTIVE'::"TenantStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await prisma.$executeRaw`
                    INSERT INTO "User"
                        ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
                    VALUES (${userId}, ${tenantId}, 'Hold Administrator', ${`hold-admin-${suffix}`},
                            'SUPER_ADMIN'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                const tenantDb = {
                    withPlatformAdmin: (operation: (tx: any) => Promise<unknown>, options?: any) =>
                        prisma.$transaction(async (tx) => {
                            await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
                            return operation(tx);
                        }, options),
                    withTenant: (scopedTenantId: string, operation: (tx: any) => Promise<unknown>, options?: any) =>
                        prisma.$transaction(async (tx) => {
                            await tx.$executeRaw`SELECT set_current_tenant(${scopedTenantId})`;
                            return operation(tx);
                        }, options),
                };
                const service = new TenantAccountLifecycleService(tenantDb as TenantPrismaService);
                const lockHolder = contender.$transaction(async (tx) => {
                    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
                    await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${tenantId})`;
                    signalLocked();
                    await lockRelease;
                }, { maxWait: 2_000, timeout: 5_000 });
                await Promise.race([
                    lockAcquired,
                    new Promise<never>((_, reject) => setTimeout(
                        () => reject(new Error('Timed out acquiring the Postgres legal-hold proof lock.')),
                        2_000,
                    )),
                ]);

                let placementSettled = false;
                const placement = service.placeRetentionLegalHold(tenantId, holdActor, {
                    reason: 'Preserve tenant records for active litigation.',
                }).finally(() => { placementSettled = true; });
                await new Promise((resolve) => setTimeout(resolve, 100));
                expect(placementSettled).toBe(false);
                releaseLock();
                await lockHolder;
                const placed = await placement;
                expect(placed).toMatchObject({
                    id: tenantId,
                    legalHold: {
                        reason: 'Preserve tenant records for active litigation.',
                        placedByUserId: userId,
                    },
                });
                await expect(service.getStatus({ ...holdActor, tenantId })).resolves.toMatchObject({
                    id: tenantId,
                    legalHold: {
                        placedAt: expect.any(Date),
                    },
                });
                const customerStatus = await service.getStatus({ ...holdActor, tenantId });
                expect(customerStatus.legalHold).not.toHaveProperty('reason');
                expect(customerStatus.legalHold).not.toHaveProperty('placedByUserId');

                await expect(service.releaseRetentionLegalHold(tenantId, holdActor, {
                    reason: 'Litigation preservation obligation has ended.',
                })).resolves.toMatchObject({ id: tenantId, legalHold: null });
                await expect(service.getStatus({ ...holdActor, tenantId })).resolves.toMatchObject({
                    id: tenantId,
                    legalHold: null,
                });
                const audits = await prisma.auditLog.findMany({
                    where: { tenantId, action: { in: [
                        'TENANT_RETENTION_LEGAL_HOLD_PLACED',
                        'TENANT_RETENTION_LEGAL_HOLD_RELEASED',
                    ] } },
                    orderBy: { createdAt: 'asc' },
                    select: { action: true, actorUserId: true, actorTenantId: true },
                });
                expect(audits).toEqual([
                    { action: 'TENANT_RETENTION_LEGAL_HOLD_PLACED', actorUserId: userId, actorTenantId: tenantId },
                    { action: 'TENANT_RETENTION_LEGAL_HOLD_RELEASED', actorUserId: userId, actorTenantId: tenantId },
                ]);
            } finally {
                releaseLock?.();
                await prisma.$transaction(async (tx) => {
                    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
                    await tx.$executeRaw`
                        UPDATE "Tenant"
                        SET "retentionLegalHoldAt" = NULL,
                            "retentionLegalHoldReason" = NULL,
                            "retentionLegalHoldByUserId" = NULL,
                            "status" = 'PURGED'::"TenantStatus",
                            "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
                            "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
                            "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "id" = ${tenantId}
                    `;
                    await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
                }).catch(() => undefined);
                await prisma.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${tenantId}`.catch(() => undefined);
                await prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`.catch(() => undefined);
                await contender.$disconnect();
                await prisma.$disconnect();
            }
        }, 20_000);

        it('keeps an overlapping platform archive behind the deletion barrier and converges once to PURGED', async () => {
            const owner = new PrismaClient({ datasources: { db: { url: postgresIntegrationUrl } } });
            const suffix = randomUUID();
            const tenantId = `tenant-delete-archive-${suffix}`;
            const userId = `user-delete-archive-${suffix}`;
            const subscriptionId = `sub-delete-archive-${suffix}`;
            const tenantSlug = `delete-archive-${suffix}`;
            let releaseArchiveProvider!: () => void;
            const archiveProviderRelease = new Promise<void>((resolve) => {
                releaseArchiveProvider = resolve;
            });
            let signalArchiveProvider!: () => void;
            const archiveProviderStarted = new Promise<void>((resolve) => {
                signalArchiveProvider = resolve;
            });
            const stripeBilling = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => {
                    signalArchiveProvider();
                    await archiveProviderRelease;
                    return { ...scheduledCancellation, stripeSubscriptionId: subscriptionId };
                }),
                finalizeTenantBillingForPurge: vi.fn().mockResolvedValue(billingPurge),
            };
            const tenantDb = {
                withPlatformAdmin: (operation: (tx: any) => Promise<unknown>, options?: any) =>
                    owner.$transaction(async (tx) => {
                        await tx.$executeRaw`SELECT set_current_platform_admin(true, ${postgresIntegrationCapability})`;
                        return operation(tx);
                    }, options),
                withTenant: (scopedTenantId: string, operation: (tx: any) => Promise<unknown>, options?: any) =>
                    owner.$transaction(async (tx) => {
                        await tx.$executeRaw`SELECT set_current_tenant(${scopedTenantId})`;
                        return operation(tx);
                    }, options),
            };
            const service = new TenantAccountLifecycleService(
                tenantDb as TenantPrismaService,
                stripeBilling as any,
            );
            const customer: TenantLifecycleActor = {
                tenantId,
                userId,
                ipAddress: '203.0.113.30',
                userAgent: 'vitest-postgres-overlap',
            };
            const platform: TenantRetentionLegalHoldActor = {
                tenantId: 'platform-tenant',
                userId: 'platform-admin-overlap',
                ipAddress: '203.0.113.31',
                userAgent: 'vitest-postgres-overlap',
            };

            try {
                await owner.$executeRaw`
                    INSERT INTO "Tenant"
                        ("id", "name", "slug", "stripeSubscriptionId", "status", "usageCredits", "createdAt", "updatedAt")
                    VALUES
                        (${tenantId}, 'Deletion Archive Overlap', ${tenantSlug}, ${subscriptionId},
                         'ACTIVE'::"TenantStatus", 17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await owner.$executeRaw`
                    INSERT INTO "User"
                        ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
                    VALUES
                        (${userId}, ${tenantId}, 'Deletion Administrator', ${`delete-admin-${suffix}`},
                         'ADMIN'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;

                const archive = service.archiveTenant(tenantId, platform);
                await Promise.race([
                    archiveProviderStarted,
                    new Promise<never>((_, reject) => setTimeout(
                        () => reject(new Error('Timed out waiting for the controlled archive provider call.')),
                        2_000,
                    )),
                ]);

                await expect(service.requestDeletion(customer, { confirmation: tenantSlug }))
                    .resolves.toMatchObject({
                        id: tenantId,
                        status: 'PURGED',
                        deletionState: 'FINALIZED',
                    });
                releaseArchiveProvider();
                await expect(archive).rejects.toThrow('pending reconciliation');

                expect(stripeBilling.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();
                expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenCalledOnce();
                await expect(owner.tenant.findUniqueOrThrow({
                    where: { id: tenantId },
                    select: { status: true, usageCredits: true },
                })).resolves.toEqual({ status: 'PURGED', usageCredits: 17 });
                expect(await owner.auditLog.count({
                    where: { tenantId, action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER' },
                })).toBe(1);
                expect(await owner.auditLog.count({
                    where: { tenantId, action: 'TENANT_ARCHIVED' },
                })).toBe(0);

                await owner.$transaction(async (tx) => {
                    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${postgresIntegrationCapability})`;
                    await tx.$executeRaw`
                        UPDATE "Tenant"
                        SET "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '31 days',
                            "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "id" = ${tenantId}
                    `;
                    await tx.$queryRaw`SELECT public.redact_retained_tenant_audit_logs(${tenantId})`;
                });
                const deletionAudits = await owner.auditLog.findMany({
                    where: {
                        tenantId,
                        action: { in: [
                            'TENANT_DELETION_BARRIER_COMMITTED',
                            'TENANT_DELETION_REQUESTED_BY_CUSTOMER',
                        ] },
                    },
                    orderBy: { createdAt: 'asc' },
                    select: {
                        action: true,
                        userId: true,
                        actorUserId: true,
                        actorTenantId: true,
                    },
                });
                expect(deletionAudits).toHaveLength(2);
                for (const audit of deletionAudits) {
                    expect(audit).toMatchObject({
                        userId: null,
                        actorTenantId: tenantId,
                    });
                    expect(audit.actorUserId).toMatch(/^deleted-user:[a-f0-9]{64}$/);
                }
            } finally {
                releaseArchiveProvider?.();
                await owner.$transaction(async (tx) => {
                    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${postgresIntegrationCapability})`;
                    await tx.$executeRaw`
                        UPDATE "Tenant"
                        SET "status" = 'PURGED'::"TenantStatus",
                            "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
                            "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
                            "retentionLegalHoldAt" = NULL,
                            "retentionLegalHoldReason" = NULL,
                            "retentionLegalHoldByUserId" = NULL,
                            "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "id" = ${tenantId}
                    `;
                    await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
                }).catch(() => undefined);
                await owner.tenantSetting.deleteMany({ where: { tenantId } }).catch(() => undefined);
                await owner.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
                await owner.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
                await owner.$disconnect();
            }
        }, 20_000);
    });
}
