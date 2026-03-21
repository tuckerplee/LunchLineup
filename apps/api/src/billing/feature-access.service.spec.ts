import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanTier, TenantStatus } from '@lunchlineup/db';
import { FeatureAccessService, TenantFeatureConfig } from './feature-access.service';

function buildPrismaMock(overrides: Record<string, any> = {}) {
    return {
        tenant: {
            findUniqueOrThrow: vi.fn(),
        },
        tenantSetting: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
        },
        ...overrides,
    };
}

describe('FeatureAccessService', () => {
    let prisma: ReturnType<typeof buildPrismaMock>;
    let metering: { consumeCredits: ReturnType<typeof vi.fn> };
    let service: FeatureAccessService;

    beforeEach(() => {
        prisma = buildPrismaMock();
        metering = {
            consumeCredits: vi.fn().mockResolvedValue(95),
        };

        service = new FeatureAccessService(metering as any, prisma as any);
    });

    it('enables scheduling by plan tier when tenant is STARTER+', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.STARTER,
            status: TenantStatus.TRIAL,
            usageCredits: 0,
            stripeSubscriptionId: null,
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.scheduling.enabled).toBe(true);
        expect(matrix.features.scheduling.source).toBe('plan');
    });

    it('enables lunch_breaks from credits for FREE plan tenant', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.FREE,
            status: TenantStatus.TRIAL,
            usageCredits: 50,
            stripeSubscriptionId: null,
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.lunch_breaks.enabled).toBe(true);
        expect(matrix.features.lunch_breaks.source).toBe('credits');
    });

    it('respects tenant override that requires stripe subscription', async () => {
        const config: TenantFeatureConfig = {
            features: {
                lunch_breaks: {
                    source: 'stripe',
                },
            },
        };

        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.FREE,
            status: TenantStatus.TRIAL,
            usageCredits: 300,
            stripeSubscriptionId: null,
        });
        prisma.tenantSetting.findUnique.mockResolvedValue({ value: config });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.lunch_breaks.enabled).toBe(false);
        expect(matrix.features.lunch_breaks.reason).toMatch(/requires an active Stripe subscription/i);
    });

    it('consumes credits for credit-backed feature actions', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.FREE,
            status: TenantStatus.TRIAL,
            usageCredits: 50,
            stripeSubscriptionId: null,
        });

        const result = await service.consumeCreditsForFeature('tenant-1', 'lunch_breaks', 'Lunch run');

        expect(result.consumedCredits).toBeGreaterThan(0);
        expect(metering.consumeCredits).toHaveBeenCalledWith('tenant-1', result.consumedCredits, 'Lunch run');
    });
});
