import { PlanTier, TenantStatus } from '@lunchlineup/db';
import { describe, expect, it, vi } from 'vitest';
import { FeatureAccessService } from '../billing/feature-access.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { TimeCardsController } from './time-cards.controller';

const adminReq = {
    user: {
        tenantId: 'tenant-1',
        sub: 'admin-1',
        permissions: ['users:read', 'shifts:read'],
    },
};

const baseCard = {
    id: 'card-1',
    tenantId: 'tenant-1',
    userId: 'staff-1',
    locationId: 'loc-1',
    shiftId: null,
    clockInAt: new Date('2026-07-08T15:00:00.000Z'),
    clockOutAt: null,
    breakMinutes: 0,
    status: 'OPEN',
    notes: null,
    deletedAt: null,
    updatedAt: new Date('2026-07-08T15:00:00.000Z'),
    user: { id: 'staff-1', name: 'Jordan Shift', username: 'jordan.shift', role: 'STAFF' },
    location: { id: 'loc-1', name: 'Downtown Diner', timezone: 'America/Los_Angeles' },
    shift: null,
    breaks: [],
};

const entitlementDenials = [
    {
        name: 'CANCELLED',
        tenant: {
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.CANCELLED,
            trialEndsAt: null,
            usageCredits: 10,
            stripeSubscriptionId: 'sub_cancelled',
        },
        reason: /active paid subscription/i,
    },
    {
        name: 'PAST_DUE',
        tenant: {
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.PAST_DUE,
            trialEndsAt: null,
            usageCredits: 10,
            stripeSubscriptionId: 'sub_past_due',
        },
        reason: /active paid subscription/i,
    },
    {
        name: 'missing Stripe subscription',
        tenant: {
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            trialEndsAt: null,
            usageCredits: 10,
            stripeSubscriptionId: null,
        },
        reason: /active paid subscription/i,
    },
] as const;

const zeroCreditPaidTenant = {
    id: 'tenant-1',
    planTier: PlanTier.GROWTH,
    status: TenantStatus.ACTIVE,
    trialEndsAt: null,
    usageCredits: 0,
    stripeSubscriptionId: 'sub_active',
    stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
} as const;

function buildFeatureAccess(tenant: (typeof entitlementDenials)[number]['tenant'] | typeof zeroCreditPaidTenant) {
    const prisma: any = {
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'tenant-1' }]),
        $transaction: vi.fn(),
        tenant: {
            findUniqueOrThrow: vi.fn().mockResolvedValue(tenant),
        },
        tenantSetting: {
            findUnique: vi.fn().mockResolvedValue(null),
        },
    };
    prisma.$transaction.mockImplementation(
        async (operation: (tx: any) => Promise<unknown>) => operation(prisma),
    );
    const metering = {
        recordFeatureUsageInTransaction: vi.fn(),
    };
    return {
        featureAccess: new FeatureAccessService(metering as any, new TenantPrismaService(prisma)),
        metering,
    };
}

function buildControllerDb(initialTenant: any = zeroCreditPaidTenant) {
    let tenant = initialTenant;
    const prisma = {
        $executeRaw: vi.fn().mockResolvedValue(0),
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'tenant-1' }]),
        tenant: {
            findUniqueOrThrow: vi.fn().mockImplementation(async () => tenant),
        },
        tenantSetting: {
            findUnique: vi.fn().mockResolvedValue(null),
        },
        timeCard: {
            findMany: vi.fn(),
            findFirst: vi.fn(),
            updateMany: vi.fn(),
        },
        auditLog: {
            create: vi.fn().mockResolvedValue({}),
        },
    };
    const tenantDb = {
        withTenant: vi.fn(
            async (_tenantId: string, operation: (tx: typeof prisma) => Promise<unknown>) =>
                operation(prisma),
        ),
    };
    return {
        prisma,
        tenantDb,
        setTenant(nextTenant: any) {
            tenant = nextTenant;
        },
    };
}

describe('TimeCardsController entitlement boundaries', () => {
    it.each(entitlementDenials)(
        'blocks history, historical detail, and corrections for $name',
        async ({ tenant, reason }) => {
            const { featureAccess } = buildFeatureAccess(tenant);
            const accessSpy = vi.spyOn(featureAccess, 'assertFeatureEntitled');
            const transactionAccessSpy = vi.spyOn(featureAccess, 'assertFeatureEntitledInTransaction');
            const { prisma, tenantDb } = buildControllerDb(tenant);
            const controller = new TimeCardsController(featureAccess, tenantDb as any);
            const correction = {
                clockOutAt: '2026-07-08T23:00:00.000Z',
                expectedUpdatedAt: '2026-07-08T15:00:00.000Z',
                reason: 'Forgotten clock out.',
            };

            await expect(controller.findAll(adminReq)).rejects.toThrow(reason);
            await expect(controller.findOne('card-1', adminReq)).rejects.toThrow(reason);
            await expect(controller.correct('card-1', correction, adminReq)).rejects.toThrow(reason);

            expect(accessSpy).toHaveBeenCalledTimes(2);
            expect(accessSpy).toHaveBeenNthCalledWith(1, 'tenant-1', 'time_cards');
            expect(accessSpy).toHaveBeenNthCalledWith(2, 'tenant-1', 'time_cards');
            expect(transactionAccessSpy).toHaveBeenCalledWith(prisma, 'tenant-1', 'time_cards');
            expect(tenantDb.withTenant).toHaveBeenCalledOnce();
            expect(prisma.timeCard.findMany).not.toHaveBeenCalled();
            expect(prisma.timeCard.findFirst).not.toHaveBeenCalled();
            expect(prisma.timeCard.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );

    it.each(entitlementDenials)(
        'keeps active-card retrieval and clock-out usable for $name',
        async ({ tenant, reason }) => {
            const { featureAccess } = buildFeatureAccess(tenant);
            const accessSpy = vi.spyOn(featureAccess, 'assertFeatureEntitled');
            const { prisma, tenantDb } = buildControllerDb();
            const controller = new TimeCardsController(featureAccess, tenantDb as any);
            const closedCard = {
                ...baseCard,
                clockOutAt: new Date('2026-07-08T23:00:00.000Z'),
                status: 'CLOSED',
            };
            prisma.timeCard.findFirst
                .mockResolvedValueOnce(baseCard)
                .mockResolvedValueOnce(baseCard)
                .mockResolvedValueOnce(baseCard)
                .mockResolvedValueOnce(closedCard);
            prisma.timeCard.updateMany.mockResolvedValue({ count: 1 });

            await expect(featureAccess.assertFeatureEntitled('tenant-1', 'time_cards')).rejects.toThrow(reason);
            accessSpy.mockClear();

            const active = await controller.active(adminReq, 'staff-1');
            const closed = await controller.clockOut(
                'card-1',
                { clockOutAt: '2026-07-08T23:00:00.000Z' },
                adminReq,
            );

            expect(active.data?.id).toBe('card-1');
            expect(closed.status).toBe('CLOSED');
            expect(accessSpy).not.toHaveBeenCalled();
            expect(tenantDb.withTenant).toHaveBeenCalledTimes(2);
            expect(prisma.timeCard.updateMany).toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({
                    id: 'card-1',
                    tenantId: 'tenant-1',
                    status: 'OPEN',
                    clockOutAt: null,
                }),
            }));
            expect(prisma.auditLog.create).toHaveBeenCalledOnce();
        },
    );

    it('fails a correction when the tenant becomes PAST_DUE at mutation lock time', async () => {
        const { featureAccess } = buildFeatureAccess(zeroCreditPaidTenant);
        const accessSpy = vi.spyOn(featureAccess, 'assertFeatureEntitled');
        const { prisma, tenantDb, setTenant } = buildControllerDb(zeroCreditPaidTenant);
        const originalWithTenant = tenantDb.withTenant;
        tenantDb.withTenant = vi.fn(async (tenantId: string, operation: (tx: typeof prisma) => Promise<unknown>) => {
            setTenant({
                ...zeroCreditPaidTenant,
                status: TenantStatus.PAST_DUE,
            });
            return originalWithTenant(tenantId, operation);
        });
        const controller = new TimeCardsController(featureAccess, tenantDb as any);

        await expect(controller.correct('card-1', {
            clockOutAt: '2026-07-08T23:00:00.000Z',
            expectedUpdatedAt: '2026-07-08T15:00:00.000Z',
            reason: 'Forgotten clock out.',
        }, adminReq)).rejects.toThrow(/active paid subscription/i);

        expect(accessSpy).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).toHaveBeenCalledOnce();
        expect(prisma.timeCard.findFirst).not.toHaveBeenCalled();
        expect(prisma.timeCard.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('allows zero-credit paid history and detail reads without credit settlement', async () => {
        const { featureAccess, metering } = buildFeatureAccess(zeroCreditPaidTenant);
        const accessSpy = vi.spyOn(featureAccess, 'assertFeatureEntitled');
        const { prisma, tenantDb } = buildControllerDb();
        const controller = new TimeCardsController(featureAccess, tenantDb as any);
        prisma.timeCard.findMany.mockResolvedValue([baseCard]);
        prisma.timeCard.findFirst.mockResolvedValue(baseCard);

        const history = await controller.findAll(adminReq);
        const detail = await controller.findOne('card-1', adminReq);

        expect(history.data).toHaveLength(1);
        expect(detail.id).toBe('card-1');
        expect(accessSpy).toHaveBeenCalledTimes(2);
        expect(metering.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
});
