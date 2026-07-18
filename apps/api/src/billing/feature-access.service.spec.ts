import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanTier, TenantStatus } from '@lunchlineup/db';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { FeatureAccessService, TenantFeatureConfig } from './feature-access.service';

function buildPrismaMock(overrides: Record<string, any> = {}) {
    const prisma = {
        $executeRaw: vi.fn().mockResolvedValue(1),
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
    let metering: {
        recordFeatureUsageInTransaction: ReturnType<typeof vi.fn>;
        recordCreditDebitInTransaction: ReturnType<typeof vi.fn>;
    };
    let service: FeatureAccessService;

    beforeEach(() => {
        prisma = buildPrismaMock();
        metering = {
            recordFeatureUsageInTransaction: vi.fn().mockResolvedValue({ consumedCredits: 0, newBalance: 0 }),
            recordCreditDebitInTransaction: vi.fn().mockResolvedValue({ consumedCredits: 1, newBalance: 4 }),
        };

        service = new FeatureAccessService(metering as any, new TenantPrismaService(prisma as any));
    });

    it('requires active paid plan entitlement for scheduling', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.STARTER,
            status: TenantStatus.ACTIVE,
            usageCredits: 5,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.scheduling.enabled).toBe(true);
        expect(matrix.features.scheduling.source).toBe('credits');
        expect(matrix.stripeSubscriptionCurrentPeriodEnd).toEqual(
            new Date('2099-01-01T00:00:00.000Z'),
        );
    });

    it.each([
        ['missing', null],
        ['expired', new Date('2020-01-01T00:00:00.000Z')],
    ])('fails closed for a %s authoritative paid-through value even with credits', async (
        _label,
        stripeSubscriptionCurrentPeriodEnd,
    ) => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            usageCredits: 500,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd,
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.stripeSubscriptionActive).toBe(false);
        expect(matrix.usageCredits).toBe(500);
        expect(Object.values(matrix.features).every((feature) => !feature.enabled)).toBe(true);
        expect(matrix.features.scheduling.reason).toMatch(/current active paid subscription/i);
    });

    it('does not unlock features outside the purchased active plan just because Stripe is active', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.STARTER,
            status: TenantStatus.ACTIVE,
            usageCredits: 0,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.time_cards.enabled).toBe(false);
        expect(matrix.features.time_cards.source).toBe('disabled');
    });

    it('does not treat a Stripe trial with externally granted credits as paid entitlement', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.TRIAL,
            trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            usageCredits: 50,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_trial_123',
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.trialEndsAt).toEqual(expect.any(Date));
        expect(matrix.stripeSubscriptionActive).toBe(false);
        expect(matrix.stripeSubscriptionPresent).toBe(true);
        expect(Object.values(matrix.features)).toHaveLength(4);
        expect(Object.values(matrix.features).every((feature) => !feature.enabled)).toBe(true);
        expect(Object.values(matrix.features).every((feature) => feature.source === 'disabled')).toBe(true);
        expect(matrix.features.scheduling.reason).toMatch(/active paid subscription/i);
        await expect(service.assertFeatureEnabledInTransaction(
            prisma as any,
            'tenant-1',
            'scheduling',
        )).rejects.toThrow(/active paid subscription/i);
    });

    it('does not enable paid plan features after the trial expires', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.STARTER,
            status: TenantStatus.TRIAL,
            trialEndsAt: new Date(Date.now() - 1),
            usageCredits: 0,
            creditDebt: 0,
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
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
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
        )).rejects.toThrow('active paid subscription');
    });

    it('does not unlock lunch breaks with credits alone', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.FREE,
            status: TenantStatus.TRIAL,
            usageCredits: 50,
            creditDebt: 0,
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
            creditDebt: 0,
            stripeSubscriptionId: null,
        });
        prisma.tenantSetting.findUnique.mockResolvedValue({ value: config });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.lunch_breaks.enabled).toBe(false);
        expect(matrix.features.lunch_breaks.reason).toMatch(/active paid subscription/i);
    });

    it('requires credits for time cards on active growth plans', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            usageCredits: 5,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.time_cards.enabled).toBe(true);
        expect(matrix.features.time_cards.source).toBe('credits');
    });

    it('keeps an explicit empty GROWTH feature set disabled instead of restoring plan defaults', async () => {
        prisma = buildPrismaMock({
            planDefinition: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'plan-growth',
                    code: 'GROWTH',
                    name: 'Growth',
                    monthlyPriceCents: 7900,
                    locationLimit: 25,
                    userLimit: 250,
                    creditQuotaLimit: null,
                    active: true,
                    metadata: { features: [] },
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            },
        });
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            trialEndsAt: null,
            usageCredits: 50,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });
        service = new FeatureAccessService(metering as any, new TenantPrismaService(prisma as any));

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(Object.values(matrix.features).every((feature) => !feature.enabled)).toBe(true);
        expect(matrix.features.scheduling.reason).toMatch(/includes this feature/i);
    });

    it.each([
        { features: ['scheduling', 'unknown_feature'] },
        { features: ['scheduling', 42] },
        { features: 'scheduling' },
    ])('fails closed for malformed stored GROWTH metadata %#', async (metadata) => {
        prisma = buildPrismaMock({
            planDefinition: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'plan-growth',
                    code: 'GROWTH',
                    name: 'Growth',
                    monthlyPriceCents: 7900,
                    locationLimit: 25,
                    userLimit: 250,
                    creditQuotaLimit: null,
                    active: true,
                    metadata,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            },
        });
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            trialEndsAt: null,
            usageCredits: 50,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });
        service = new FeatureAccessService(metering as any, new TenantPrismaService(prisma as any));

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(Object.values(matrix.features).every((feature) => !feature.enabled)).toBe(true);
    });

    it('uses GROWTH defaults only when feature metadata is missing', async () => {
        prisma = buildPrismaMock({
            planDefinition: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'plan-growth',
                    code: 'GROWTH',
                    name: 'Growth',
                    monthlyPriceCents: 7900,
                    locationLimit: 25,
                    userLimit: 250,
                    creditQuotaLimit: null,
                    active: true,
                    metadata: { customerFacingName: 'Growth' },
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            },
        });
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            trialEndsAt: null,
            usageCredits: 50,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });
        service = new FeatureAccessService(metering as any, new TenantPrismaService(prisma as any));

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.scheduling.enabled).toBe(true);
        expect(matrix.features.time_cards.enabled).toBe(true);
        expect(matrix.features.webhooks.enabled).toBe(true);
    });

    it('blocks new billable feature work when an active paid subscription has no credits', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            usageCredits: 0,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.time_cards).toMatchObject({
            enabled: false,
            source: 'disabled',
            creditCost: 1,
        });
        expect(matrix.features.time_cards.reason).toMatch(/separately purchased usage credit/i);
    });

    it('allows zero-settlement controls at zero credits while billable work remains denied', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            trialEndsAt: null,
            usageCredits: 0,
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });

        await expect(service.assertFeatureEnabledInTransaction(
            prisma as any,
            'tenant-1',
            'time_cards',
        )).rejects.toThrow(/separately purchased usage credit/i);
        await expect(service.assertFeatureEntitled(
            'tenant-1',
            'time_cards',
        )).resolves.toMatchObject({
            enabled: true,
            source: 'credits',
            creditCost: 1,
        });
        expect(metering.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    });

    it.each([null, 0, 100, -1])(
        'does not treat legacy plan credit limit %s as recurring or unlimited credits',
        async (creditQuotaLimit) => {
            prisma = buildPrismaMock({
                planDefinition: {
                    findUnique: vi.fn().mockResolvedValue({
                        id: 'plan-1',
                        code: 'STARTER',
                        name: 'Starter',
                        monthlyPriceCents: 3900,
                        locationLimit: 5,
                        userLimit: 50,
                        creditQuotaLimit,
                        active: true,
                        metadata: { features: ['scheduling'] },
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    }),
                },
            });
            prisma.tenant.findUniqueOrThrow.mockResolvedValue({
                id: 'tenant-1',
                planTier: PlanTier.STARTER,
                status: TenantStatus.ACTIVE,
                usageCredits: 0,
                creditDebt: 0,
                stripeSubscriptionId: 'sub_123',
                stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
            });
            service = new FeatureAccessService(metering as any, new TenantPrismaService(prisma as any));

            const matrix = await service.resolveTenantFeatures('tenant-1');

            expect(matrix.features.scheduling.enabled).toBe(false);
            expect(matrix.features.scheduling.reason).toMatch(/separately purchased usage credit/i);
        },
    );

    it('delegates completion of an already-reserved operation to the idempotent metering state machine', async () => {
        const resolution = {
            enabled: true,
            source: 'credits' as const,
            reason: 'Previously authorized billable operation.',
            creditCost: 1,
        };

        await expect(service.recordFeatureUsageInTransaction(
            prisma as any,
            'tenant-1',
            resolution,
            'Complete clock-in',
            'time-card-clock-in:existing-operation',
        )).resolves.toEqual({ consumedCredits: 0, newBalance: 0 });
        expect(metering.recordFeatureUsageInTransaction).toHaveBeenCalledWith(prisma, {
            tenantId: 'tenant-1',
            source: 'credits',
            cost: 1,
            reason: 'Complete clock-in',
            operationId: 'time-card-clock-in:existing-operation',
        });
    });

    it('preserves an explicit legacy ledger identity through the canonical debit state machine', async () => {
        const resolution = {
            enabled: true,
            source: 'credits' as const,
            reason: 'Billable.',
            creditCost: 1,
        };

        await expect(service.recordFeatureUsageInTransaction(
            prisma as any,
            'tenant-1',
            resolution,
            'Schedule generation (job-1)',
            'job-1',
            'schedule-credit-job-1',
        )).resolves.toEqual({ consumedCredits: 1, newBalance: 4 });

        expect(metering.recordCreditDebitInTransaction).toHaveBeenCalledWith(prisma, {
            tenantId: 'tenant-1',
            cost: 1,
            reason: 'Schedule generation (job-1)',
            transactionId: 'schedule-credit-job-1',
        });
        expect(metering.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    });

    it.each([
        { source: 'plan', creditCost: 1 },
        { source: 'stripe', creditCost: 1 },
        { source: 'manual', creditCost: 1 },
        { source: 'credits', creditCost: 0 },
        { source: 'credits', creditCost: null },
    ] as const)('rejects non-wallet or non-positive usage delegation for $source/$creditCost', async (resolution) => {
        await expect(service.recordFeatureUsageInTransaction(
            prisma as any,
            'tenant-1',
            {
                enabled: true,
                reason: 'invalid billing resolution',
                ...resolution,
            },
            'Billable operation',
            'operation-1',
        )).rejects.toThrow('positive separately purchased credit cost');
        expect(metering.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
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
            creditDebt: 0,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });
        service = new FeatureAccessService(metering as any, new TenantPrismaService(prisma as any));

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.features.time_cards.enabled).toBe(true);
        expect(matrix.features.time_cards.source).toBe('credits');
    });

    it('blocks billable work while preserving entitlement-only recovery during credit debt', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            planTier: PlanTier.GROWTH,
            status: TenantStatus.ACTIVE,
            trialEndsAt: null,
            usageCredits: 50,
            creditDebt: 3,
            stripeSubscriptionId: 'sub_123',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        });

        const matrix = await service.resolveTenantFeatures('tenant-1');

        expect(matrix.creditDebt).toBe(3);
        expect(matrix.features.time_cards).toMatchObject({
            enabled: false,
            source: 'disabled',
        });
        expect(matrix.features.time_cards.reason).toMatch(/credit debt is repaid/i);
        await expect(service.assertFeatureEnabledInTransaction(
            prisma as any,
            'tenant-1',
            'time_cards',
        )).rejects.toThrow(/credit debt is repaid/i);
        await expect(service.assertFeatureEntitled(
            'tenant-1',
            'time_cards',
        )).resolves.toMatchObject({
            enabled: true,
            source: 'credits',
        });
    });
});
