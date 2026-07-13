import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { MeteringService } from './metering.service';
import { PlanTier } from './plans.config';

// Utility to build a spy Prisma mock
function buildPrismaMock(overrides: Record<string, any> = {}) {
    const prisma = {
        $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
        $transaction: vi.fn(),
        tenant: {
            findUnique: vi.fn(),
            findUniqueOrThrow: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
        planDefinition: {
            findUnique: vi.fn(),
        },
        creditTransaction: {
            create: vi.fn(),
            findUnique: vi.fn(),
        },
        location: {
            count: vi.fn().mockResolvedValue(0),
        },
        user: {
            count: vi.fn().mockResolvedValue(5),
        },
        stripeUsageEvent: {
            findUnique: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
        },
        ...overrides,
    };
    prisma.$transaction = vi.fn(async (fn: any) => fn(overrides.tx ?? prisma));
    return prisma;
}

afterEach(() => {
    delete process.env.STRIPE_METERED_USAGE_ENABLED;
    delete process.env.STRIPE_METER_EVENT_NAME;
    vi.useRealTimers();
});

describe('MeteringService â€“ grantCredits', () => {
    let service: MeteringService;
    let prisma: ReturnType<typeof buildPrismaMock>;
    let balance: number;
    let ledger: any;

    beforeEach(() => {
        balance = 0;
        ledger = null;
        prisma = buildPrismaMock({
            tx: {
                $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
                tenant: {
                    update: vi.fn(async ({ data }: any) => {
                        balance += data.usageCredits.increment;
                        return { usageCredits: balance };
                    }),
                    findUniqueOrThrow: vi.fn(async () => ({ usageCredits: balance })),
                },
                creditTransaction: {
                    findUnique: vi.fn(async ({ where }: any) => ledger?.id === where.id ? ledger : null),
                    create: vi.fn(async ({ data }: any) => {
                        ledger = data;
                        return ledger;
                    }),
                },
            },
        });

        // Wire the $transaction to call the function with the tx overrides
        prisma.$transaction = vi.fn(async (fn: any) => fn((prisma as any).tx));

        service = new MeteringService(new TenantPrismaService(prisma as any));
    });

    it('should reject non-positive amounts', async () => {
        await expect(service.grantCredits('tenant-1', 0, 'test')).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.grantCredits('tenant-1', -5, 'test')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should increment tenant usageCredits and create a ledger entry', async () => {
        const result = await service.grantCredits('tenant-1', 100, 'Beta Signup Bonus', 'grant-1');
        expect(result).toBe(100);
        expect((prisma as any).tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { usageCredits: { increment: 100 } }
        });
        expect((prisma as any).tx.creditTransaction.create).toHaveBeenCalledWith({
            data: {
                id: expect.stringMatching(/^admin-credit-grant-[a-f0-9]{64}$/),
                tenantId: 'tenant-1',
                amount: 100,
                reason: 'Beta Signup Bonus',
            }
        });
        expect((prisma as any).tx.creditTransaction.create.mock.invocationCallOrder[0]).toBeLessThan(
            (prisma as any).tx.tenant.update.mock.invocationCallOrder[0],
        );
    });

    it('replays a committed grant without incrementing credits twice', async () => {
        await expect(service.grantCredits('tenant-1', 100, 'Beta Signup Bonus', 'lost-response-1')).resolves.toBe(100);
        await expect(service.grantCredits('tenant-1', 100, 'Beta Signup Bonus', 'lost-response-1')).resolves.toBe(100);

        expect((prisma as any).tx.creditTransaction.create).toHaveBeenCalledTimes(1);
        expect((prisma as any).tx.tenant.update).toHaveBeenCalledTimes(1);
        expect((prisma as any).tx.tenant.findUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { usageCredits: true },
        });
    });

    it('rejects reuse of a key with a different grant payload', async () => {
        await service.grantCredits('tenant-1', 100, 'Beta Signup Bonus', 'conflict-1');

        await expect(
            service.grantCredits('tenant-1', 50, 'Correction', 'conflict-1'),
        ).rejects.toBeInstanceOf(ConflictException);

        expect((prisma as any).tx.creditTransaction.create).toHaveBeenCalledTimes(1);
        expect((prisma as any).tx.tenant.update).toHaveBeenCalledTimes(1);
    });

    it('recovers a duplicate-key race by replaying the committed ledger row', async () => {
        const tx = (prisma as any).tx;
        const committed = {
            id: 'admin-credit-grant-race',
            tenantId: 'tenant-1',
            amount: 100,
            reason: 'Beta Signup Bonus',
        };
        tx.creditTransaction.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(committed);
        tx.creditTransaction.create.mockRejectedValueOnce({ code: 'P2002' });

        await expect(
            service.grantCredits('tenant-1', 100, 'Beta Signup Bonus', 'race-1'),
        ).resolves.toBe(0);

        expect(tx.tenant.update).not.toHaveBeenCalled();
        expect(tx.tenant.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    });
});

describe('MeteringService - reportUsageToStripe', () => {
    it('requires a tenant id before reporting usage', async () => {
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        await expect(service.reportUsageToStripe('')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('fails closed when Stripe metered usage is disabled', async () => {
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        await expect(service.reportUsageToStripe('tenant-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('persists active-staff usage before posting an idempotent Stripe meter event', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-09T12:30:00.000Z'));
        process.env.STRIPE_METERED_USAGE_ENABLED = 'true';
        process.env.STRIPE_METER_EVENT_NAME = 'll.active_staff';

        let usageEvent: any;
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
            tenant: {
                findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', stripeCustomerId: 'cus_live_123' }),
            },
            user: {
                count: vi.fn().mockResolvedValue(7),
            },
            stripeUsageEvent: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(async ({ data }: any) => {
                    usageEvent = { id: 'usage-1', attempts: 0, sentAt: null, ...data };
                    return usageEvent;
                }),
                update: vi.fn(async ({ data }: any) => {
                    usageEvent = {
                        ...usageEvent,
                        ...data,
                        attempts: typeof data.attempts === 'object' ? usageEvent.attempts + data.attempts.increment : usageEvent.attempts,
                    };
                    return usageEvent;
                }),
            },
        };
        const prisma = buildPrismaMock({ tx });
        prisma.$transaction = vi.fn(async (fn: any) => fn(tx));
        const stripeMeterEvents = {
            createMeterEvent: vi.fn().mockResolvedValue({ id: 'mtr_evt_123', requestId: 'req_123' }),
        };
        const service = new MeteringService(new TenantPrismaService(prisma as any), stripeMeterEvents as any);

        const result = await service.reportUsageToStripe('tenant-1');

        expect(tx.stripeUsageEvent.findUnique).toHaveBeenCalledWith({
            where: {
                tenantId_metric_periodStart_periodEnd: {
                    tenantId: 'tenant-1',
                    metric: 'ACTIVE_STAFF',
                    periodStart: new Date('2026-07-09T00:00:00.000Z'),
                    periodEnd: new Date('2026-07-10T00:00:00.000Z'),
                },
            },
        });

        expect(tx.stripeUsageEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                metric: 'ACTIVE_STAFF',
                quantity: 7,
                eventName: 'll.active_staff',
                stripeCustomerId: 'cus_live_123',
                status: 'PENDING',
            }),
        });
        expect(tx.stripeUsageEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
            stripeMeterEvents.createMeterEvent.mock.invocationCallOrder[0],
        );
        expect(stripeMeterEvents.createMeterEvent).toHaveBeenCalledWith(expect.objectContaining({
            eventName: 'll.active_staff',
            stripeCustomerId: 'cus_live_123',
            value: 7,
            identifier: expect.stringMatching(/^ll_active_staff_20260709_[a-f0-9]{24}$/),
            idempotencyKey: expect.stringMatching(/^stripe_usage_ll_active_staff_20260709_[a-f0-9]{24}$/),
        }));
        expect(result).toEqual(expect.objectContaining({
            id: 'usage-1',
            status: 'SENT',
            quantity: 7,
            stripeObjectId: 'mtr_evt_123',
            stripeRequestId: 'req_123',
        }));
    });

    it('keeps a failed outbox row retryable when Stripe rejects the meter event', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-09T12:30:00.000Z'));
        process.env.STRIPE_METERED_USAGE_ENABLED = 'true';
        process.env.STRIPE_METER_EVENT_NAME = 'll.active_staff';

        let usageEvent: any;
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
            tenant: {
                findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', stripeCustomerId: 'cus_live_123' }),
            },
            user: {
                count: vi.fn().mockResolvedValue(7),
            },
            stripeUsageEvent: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(async ({ data }: any) => {
                    usageEvent = { id: 'usage-1', attempts: 0, sentAt: null, ...data };
                    return usageEvent;
                }),
                update: vi.fn(async ({ data }: any) => {
                    usageEvent = {
                        ...usageEvent,
                        ...data,
                        attempts: typeof data.attempts === 'object' ? usageEvent.attempts + data.attempts.increment : usageEvent.attempts,
                    };
                    return usageEvent;
                }),
            },
        };
        const prisma = buildPrismaMock({ tx });
        prisma.$transaction = vi.fn(async (fn: any) => fn(tx));
        const stripeMeterEvents = {
            createMeterEvent: vi.fn().mockRejectedValue(new Error('stripe timeout')),
        };
        const service = new MeteringService(new TenantPrismaService(prisma as any), stripeMeterEvents as any);

        await expect(service.reportUsageToStripe('tenant-1')).rejects.toBeInstanceOf(ServiceUnavailableException);

        expect(tx.stripeUsageEvent.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'usage-1' },
            data: expect.objectContaining({
                status: 'FAILED',
                lastError: 'stripe timeout',
            }),
        }));
    });

    it('retries one logical snapshot with rotated transport identities and retained rejection metadata', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-09T12:30:00.000Z'));
        process.env.STRIPE_METERED_USAGE_ENABLED = 'true';
        process.env.STRIPE_METER_EVENT_NAME = 'll.active_staff';

        let usageEvent: any = {
            id: 'usage-rotated',
            tenantId: 'tenant-1',
            metric: 'ACTIVE_STAFF',
            periodStart: new Date('2026-07-09T00:00:00.000Z'),
            periodEnd: new Date('2026-07-10T00:00:00.000Z'),
            quantity: 6,
            eventName: 'll.active_staff',
            stripeCustomerId: 'cus_live_123',
            identifier: 'll_async_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            idempotencyKey: 'stripe_usage_async_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
            status: 'FAILED',
            attempts: 1,
            submittedAt: new Date('2026-07-09T12:29:00.000Z'),
            metadata: {
                source: 'worker.billing_usage',
                stripeAsyncError: { eventId: 'evt_meter_error_123' },
            },
        };
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
            tenant: {
                findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1', stripeCustomerId: 'cus_live_123' }),
            },
            user: { count: vi.fn().mockResolvedValue(8) },
            stripeUsageEvent: {
                findUnique: vi.fn().mockResolvedValue(usageEvent),
                create: vi.fn(),
                update: vi.fn(async ({ data }: any) => {
                    usageEvent = {
                        ...usageEvent,
                        ...data,
                        attempts: typeof data.attempts === 'object'
                            ? usageEvent.attempts + data.attempts.increment
                            : usageEvent.attempts,
                    };
                    return usageEvent;
                }),
            },
        };
        const prisma = buildPrismaMock({ tx });
        prisma.$transaction = vi.fn(async (fn: any) => fn(tx));
        const stripeMeterEvents = {
            createMeterEvent: vi.fn().mockResolvedValue({ id: 'mtr_evt_retry', requestId: 'req_retry' }),
        };
        const service = new MeteringService(new TenantPrismaService(prisma as any), stripeMeterEvents as any);

        const result = await service.reportUsageToStripe('tenant-1');

        expect(tx.stripeUsageEvent.create).not.toHaveBeenCalled();
        expect(stripeMeterEvents.createMeterEvent).toHaveBeenCalledWith(expect.objectContaining({
            value: 8,
            identifier: usageEvent.identifier,
            idempotencyKey: usageEvent.idempotencyKey,
        }));
        expect(usageEvent.metadata.stripeAsyncError.eventId).toBe('evt_meter_error_123');
        expect(result).toEqual(expect.objectContaining({
            id: 'usage-rotated',
            status: 'SENT',
            attempts: 2,
        }));
    });
});

describe('MeteringService â€“ consumeCredits', () => {
    const setupWithBalance = (credits: number) => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
            tenant: {
                findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'tenant-1', usageCredits: credits - 10 }),
                updateMany: vi.fn().mockResolvedValue({ count: credits >= 10 ? 1 : 0 }),
            },
            creditTransaction: {
                create: vi.fn().mockResolvedValue({}),
            },
        };

        const mock = buildPrismaMock({ tx });
        mock.$transaction = vi.fn(async (fn: any) => fn(tx));
        return { service: new MeteringService(new TenantPrismaService(mock as any)), tx, prisma: mock };
    };

    it('should reject non-positive amounts', async () => {
        const { service } = setupWithBalance(100);
        await expect(service.consumeCredits('tenant-1', -1, 'test')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw if tenant has insufficient credits', async () => {
        const { service, tx } = setupWithBalance(5);
        await expect(service.consumeCredits('tenant-1', 10, 'Schedule Generation')).rejects.toThrow('Insufficient usage credits balance.');
        expect(tx.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
        expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it('should decrement credits and log a negative CreditTransaction', async () => {
        const { service, tx } = setupWithBalance(100);
        const newBalance = await service.consumeCredits('tenant-1', 10, 'Schedule Generation');

        expect(tx.tenant.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'tenant-1',
                usageCredits: { gte: 10 },
            },
            data: { usageCredits: { decrement: 10 } }
        });
        expect(tx.tenant.findUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { usageCredits: true },
        });
        expect(tx.creditTransaction.create).toHaveBeenCalledWith({
            data: { tenantId: 'tenant-1', amount: -10, reason: 'Schedule Generation' }
        });
        expect(newBalance).toBe(90);
    });
});

describe('MeteringService - transactional feature usage', () => {
    it('atomically records and debits one credit-backed unit', async () => {
        const tx: any = {
            tenant: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                findUniqueOrThrow: vi.fn().mockResolvedValue({ usageCredits: 4 }),
            },
            creditTransaction: {
                create: vi.fn().mockResolvedValue({}),
            },
        };
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        const result = await service.recordFeatureUsageInTransaction(tx, {
            tenantId: 'tenant-1',
            source: 'credits',
            cost: 1,
            reason: 'Time card clock-in (card-1)',
            operationId: 'clock-in-op',
        });

        expect(tx.creditTransaction.create).toHaveBeenCalledWith({
            data: {
                id: 'feature-usage-clock-in-op',
                tenantId: 'tenant-1',
                amount: -1,
                reason: 'Time card clock-in (card-1)',
            },
        });
        expect(tx.tenant.updateMany).toHaveBeenCalledWith({
            where: { id: 'tenant-1', usageCredits: { gte: 1 } },
            data: { usageCredits: { decrement: 1 } },
        });
        expect(result).toEqual({ consumedCredits: 1, newBalance: 4 });
    });

    it('debits subscription-backed feature usage', async () => {
        const tx: any = {
            tenant: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                findUniqueOrThrow: vi.fn().mockResolvedValue({ usageCredits: 9 }),
            },
            creditTransaction: {
                create: vi.fn().mockResolvedValue({}),
            },
        };
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        const result = await service.recordFeatureUsageInTransaction(tx, {
            tenantId: 'tenant-1',
            source: 'plan',
            cost: 1,
            reason: 'Time card clock-in (card-1)',
            operationId: 'clock-in-op',
        });

        expect(tx.creditTransaction.create).toHaveBeenCalledWith({
            data: {
                id: 'feature-usage-clock-in-op',
                tenantId: 'tenant-1',
                amount: -1,
                reason: 'Time card clock-in (card-1)',
            },
        });
        expect(tx.tenant.updateMany).toHaveBeenCalledWith({ where: { id: 'tenant-1', usageCredits: { gte: 1 } }, data: { usageCredits: { decrement: 1 } } });
        expect(result).toEqual({ consumedCredits: 1, newBalance: 9 });
    });

    it('fails insufficient credit usage before returning a free unit', async () => {
        const tx: any = {
            tenant: {
                updateMany: vi.fn().mockResolvedValue({ count: 0 }),
                findUniqueOrThrow: vi.fn(),
            },
            creditTransaction: {
                create: vi.fn().mockResolvedValue({}),
            },
        };
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        await expect(service.recordFeatureUsageInTransaction(tx, {
            tenantId: 'tenant-1',
            source: 'credits',
            cost: 1,
            reason: 'Time card clock-in (card-1)',
            operationId: 'clock-in-op',
        })).rejects.toThrow('Insufficient usage credits balance.');

        expect(tx.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
    });
});
describe('MeteringService â€“ checkLimits', () => {
    it('should throw when location count exceeds the plan limits', async () => {
        const prisma = buildPrismaMock({
            location: { count: vi.fn().mockResolvedValue(5) },
        });
        const service = new MeteringService(new TenantPrismaService(prisma as any));
        await expect(service.checkLimits('tenant-1', PlanTier.BASIC)).rejects.toThrow(/limit reached/i);
    });

    it('should pass when location count is within plan limits', async () => {
        const prisma = buildPrismaMock({
            location: { count: vi.fn().mockResolvedValue(0) },
        });
        const service = new MeteringService(new TenantPrismaService(prisma as any));
        await expect(service.checkLimits('tenant-1', PlanTier.BASIC)).resolves.toBe(true);
    });

    it('fails closed when the tenant plan code is unknown', async () => {
        const planDefinitionFindUnique = vi.fn().mockResolvedValue(null);

        const prisma = buildPrismaMock({
            planDefinition: {
                findUnique: planDefinitionFindUnique,
            },
            location: { count: vi.fn().mockResolvedValue(1) },
            user: { count: vi.fn().mockResolvedValue(0) },
        });
        const service = new MeteringService(new TenantPrismaService(prisma as any));

        await expect(service.checkLimits('tenant-1', 'mystery-tier')).rejects.toThrow(/not configured/i);
        expect(planDefinitionFindUnique).toHaveBeenCalledOnce();
        expect(planDefinitionFindUnique).toHaveBeenCalledWith({
            where: { code: 'MYSTERY-TIER' },
        });
    });
});
