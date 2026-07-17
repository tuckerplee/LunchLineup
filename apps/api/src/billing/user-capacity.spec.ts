import { describe, expect, it, vi } from 'vitest';
import {
    assertPlanUserLimitChangeAllowsExistingTenants,
    assertTenantActiveLocationCountWithinPlan,
    assertTenantActiveUserCountWithinPlan,
    assertTenantCanAddActiveUser,
} from './user-capacity';
import { resolveFallbackPlanDefinition } from './plan-definitions';

function buildPrismaMock(overrides: Record<string, any> = {}) {
    return {
        tenant: {
            findUnique: vi.fn(),
            findMany: vi.fn(),
        },
        user: {
            count: vi.fn(),
        },
        planDefinition: {
            findUnique: vi.fn(async ({ where }: any) => resolveFallbackPlanDefinition(where.code)),
        },
        ...overrides,
    };
}

describe('assertTenantCanAddActiveUser', () => {
    it('falls back to the free plan when the tenant plan code is unknown', async () => {
        const planDefinitionFindUnique = vi.fn(async ({ where }: any) => resolveFallbackPlanDefinition(where.code));

        const prisma = buildPrismaMock({
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    planTier: 'mystery-tier',
                    status: 'ACTIVE',
                    stripeSubscriptionId: 'sub_123',
                    stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
                }),
            },
            user: {
                count: vi.fn().mockResolvedValue(10),
            },
            planDefinition: {
                findUnique: planDefinitionFindUnique,
            },
        });

        await expect(assertTenantCanAddActiveUser(prisma as any, 'tenant-1')).rejects.toThrow(/FREE plan/i);
        expect(planDefinitionFindUnique).toHaveBeenNthCalledWith(1, {
            where: { code: 'FREE' },
        });
    });

    it('fails closed when a required plan definition is missing', async () => {
        const prisma = buildPrismaMock({
            planDefinition: { findUnique: vi.fn().mockResolvedValue(null) },
        });

        await expect(assertTenantActiveUserCountWithinPlan(prisma as any, 'tenant-1', 'MISSING'))
            .rejects
            .toThrow(/not configured/i);
        expect(prisma.user.count).not.toHaveBeenCalled();
    });

    it('serializes active user capacity checks with a tenant advisory lock', async () => {
        const prisma = buildPrismaMock({
            $executeRaw: vi.fn().mockResolvedValue(1),
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    planTier: 'STARTER',
                    status: 'ACTIVE',
                    stripeSubscriptionId: 'sub_123',
                    stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
                }),
            },
            user: {
                count: vi.fn().mockResolvedValue(49),
            },
        });

        await assertTenantCanAddActiveUser(prisma as any, 'tenant-1');

        expect((prisma as any).$executeRaw).toHaveBeenCalledOnce();
        const [query, lockTenantId] = (prisma as any).$executeRaw.mock.calls[0];
        expect(Array.from(query).join(' ')).toContain('SELECT pg_advisory_xact_lock');
        expect(lockTenantId).toBe('tenant-1');
        expect(prisma.user.count).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', deletedAt: null, suspendedAt: null },
        });
    });

    it('uses free-plan capacity for paid tenants without active subscription state', async () => {
        const prisma = buildPrismaMock({
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    planTier: 'GROWTH',
                    status: 'PAST_DUE',
                    stripeSubscriptionId: 'sub_123',
                    stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
                }),
            },
            user: {
                count: vi.fn().mockResolvedValue(10),
            },
        });

        await expect(assertTenantCanAddActiveUser(prisma as any, 'tenant-1')).rejects.toThrow(/FREE plan/i);
    });

    it('uses the selected plan capacity only while a trial is unexpired', async () => {
        const activeTrial = buildPrismaMock({
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    planTier: 'STARTER',
                    status: 'TRIAL',
                    stripeSubscriptionId: null,
                    trialEndsAt: new Date(Date.now() + 60_000),
                }),
            },
            user: { count: vi.fn().mockResolvedValue(10) },
        });
        const expiredTrial = buildPrismaMock({
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    planTier: 'STARTER',
                    status: 'TRIAL',
                    stripeSubscriptionId: null,
                    trialEndsAt: new Date(Date.now() - 60_000),
                }),
            },
            user: { count: vi.fn().mockResolvedValue(10) },
        });

        await expect(assertTenantCanAddActiveUser(activeTrial as any, 'tenant-1')).resolves.toBeUndefined();
        await expect(assertTenantCanAddActiveUser(expiredTrial as any, 'tenant-1')).rejects.toThrow(/FREE plan/i);
    });

    it('blocks tenant downgrades when active users exceed the target plan', async () => {
        const prisma = buildPrismaMock({
            tenant: {
                findUnique: vi.fn(),
            },
            user: {
                count: vi.fn().mockResolvedValue(11),
            },
        });

        await expect(assertTenantActiveUserCountWithinPlan(prisma as any, 'tenant-1', 'FREE'))
            .rejects
            .toThrow(/exceeds the FREE plan limit of 10/i);
    });

    it('blocks tenant downgrades when active locations exceed the target plan', async () => {
        const locationCount = vi.fn().mockResolvedValue(6);
        const prisma = buildPrismaMock({
            location: { count: locationCount },
        });

        await expect(assertTenantActiveLocationCountWithinPlan(prisma as any, 'tenant-1', 'STARTER'))
            .rejects
            .toThrow(/6 active locations.*STARTER plan limit of 5/i);
        expect(locationCount).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', deletedAt: null },
        });
    });

    it('blocks plan user-limit reductions that would overflow existing tenants', async () => {
        const prisma = buildPrismaMock({
            tenant: {
                findMany: vi.fn().mockResolvedValue([{ id: 'tenant-1' }]),
            },
            user: {
                count: vi.fn().mockResolvedValue(12),
            },
        });

        await expect(assertPlanUserLimitChangeAllowsExistingTenants(prisma as any, 'STARTER', 10))
            .rejects
            .toThrow(/tenant-1 has 12 active users/i);
    });
});
