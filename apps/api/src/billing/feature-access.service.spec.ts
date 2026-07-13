import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanTier, TenantStatus } from '@lunchlineup/db';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { FeatureAccessService, TenantFeatureConfig } from './feature-access.service';

function buildPrismaMock(overrides: Record<string, any> = {}) {
    const prisma = {
        $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
        $transaction: vi.fn(),
        tenant: {
            findUniqueOrThrow: vi.fn(),
        },
        tenantSetting: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
        },
        ...overrides,
    };
    prisma.$transaction = vi.fn(async (operation: (tx: any) => Promise<unknown>) => operation(prisma));
    return prisma;
}

describe('FeatureAccessService', () => {
    let prisma: ReturnType<typeof buildPrismaMock>;
    let metering: { consumeCredits: ReturnType<typeof vi.fn>; trackIncludedUsage: ReturnType<typeof vi.fn> };
    let service: FeatureAccessService;

    beforeEach(() => {
        prisma = buildPrismaMock();
        metering = {
            consumeCredits: vi.fn().mockResolvedValue(95),
            trackIncludedUsage: vi.fn().mockResolvedValue(50),
        };

        service = new FeatureAccessService(metering as any, new TenantPrismaService(prisma as any));
    });

    it('requires active paid plan entitlement for scheduling', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.STARTER,
            status: TenantStatus.ACTIVE,
            usageCredits: 5,
            stripeSubscriptionId: 'sub_123',
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.scheduling.enabled).toBe(true);
        expect(matrix.features.scheduling.source).toBe('credits');
    });

    it('does not unlock features outside the purchased active plan just because Stripe is active', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.STARTER,
            status: TenantStatus.ACTIVE,
            usageCredits: 0,
            stripeSubscriptionId: 'sub_123',
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.time_cards.enabled).toBe(false);
        expect(matrix.features.time_cards.source).toBe('disabled');
    });

    it('recognizes an unexpired trial as subscription entitlement without conflating wallet balance', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.STARTER,
            status: TenantStatus.TRIAL,
            trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            usageCredits: 0,
            stripeSubscriptionId: null,
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.trialEndsAt).toEqual(expect.any(Date));
        expect(matrix.features.scheduling.enabled).toBe(true);
        expect(matrix.features.scheduling.source).toBe('credits');
        expect(matrix.features.scheduling.reason).toMatch(/unexpired trial/i);
    });

    it('does not enable paid plan features after the trial expires', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.STARTER,
            status: TenantStatus.TRIAL,
            trialEndsAt: new Date(Date.now() - 1),
            usageCredits: 0,
            stripeSubscriptionId: null,
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.scheduling.enabled).toBe(false);
        expect(matrix.features.scheduling.source).toBe('disabled');
    });

    it.each([
        TenantStatus.PAST_DUE,
        TenantStatus.SUSPENDED,
        TenantStatus.CANCELLED,
        TenantStatus.PURGED,
    ])('blocks new feature starts while tenant status is %s', async (status) => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status,
            trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            usageCredits: 50,
            stripeSubscriptionId: 'sub_123',
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.scheduling).toMatchObject({
            enabled: false,
            source: 'disabled',
        });
        await expect(service.assertFeatureEnabledInTransaction(
            prisma as any,
            'tenant-1',
            'scheduling',
        )).rejects.toThrow('trial or active tenant');
        expect(metering.consumeCredits).not.toHaveBeenCalled();
    });

    it('does not unlock lunch breaks with credits alone', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.FREE,
            status: TenantStatus.TRIAL,
            usageCredits: 50,
            stripeSubscriptionId: null,
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.lunch_breaks.enabled).toBe(false);
        expect(matrix.features.lunch_breaks.source).toBe('disabled');
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
        expect(matrix.features.lunch_breaks.reason).toMatch(/active subscription/i);
    });

    it('consumes credits for credit-backed feature actions', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            usageCredits: 50,
            stripeSubscriptionId: 'sub_123',
        });

        const result = await service.consumeCreditsForFeature('tenant-1', 'lunch_breaks', 'Lunch run');

        expect(result.consumedCredits).toBeGreaterThan(0);
        expect(metering.consumeCredits).toHaveBeenCalledWith('tenant-1', result.consumedCredits, 'Lunch run');
    });

    it('debits credits for active paid plans', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            usageCredits: 50,
            stripeSubscriptionId: 'sub_123',
        });

        const result = await service.consumeCreditsForFeature('tenant-1', 'lunch_breaks', 'Lunch run');

        expect(result.consumedCredits).toBe(1);
        expect(metering.consumeCredits).toHaveBeenCalledWith('tenant-1', 1, 'Lunch run');
        expect(metering.trackIncludedUsage).not.toHaveBeenCalled();
    });

    it('requires credits for time cards on active growth plans', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            usageCredits: 5,
            stripeSubscriptionId: 'sub_123',
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.time_cards.enabled).toBe(true);
        expect(matrix.features.time_cards.source).toBe('credits');
    });

    it('keeps an entitled feature enabled at zero credits so paid completion actions are not stranded', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            usageCredits: 0,
            stripeSubscriptionId: 'sub_123',
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.time_cards).toMatchObject({
            enabled: true,
            source: 'credits',
            creditCost: 1,
        });
    });

    it('honors time cards when present in stored plan metadata', async () => {
        prisma = buildPrismaMock({
            planDefinition: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'plan-1',
                    code: 'STARTER',
                    name: 'Starter',
                    monthlyPriceCents: 3900,
                    locationLimit: 5,
                    userLimit: 50,
                    creditQuotaLimit: null,
                    active: true,
                    metadata: { features: ['time_cards'] },
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            },
        });
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.STARTER,
            status: TenantStatus.ACTIVE,
            usageCredits: 5,
            stripeSubscriptionId: 'sub_123',
        });
        service = new FeatureAccessService(metering as any, new TenantPrismaService(prisma as any));

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.time_cards.enabled).toBe(true);
        expect(matrix.features.time_cards.source).toBe('credits');
    });
});
