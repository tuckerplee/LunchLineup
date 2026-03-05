import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { MeteringService } from './metering.service';
import { PlanTier } from './plans.config';

// Utility to build a spy Prisma mock
function buildPrismaMock(overrides: Record<string, any> = {}) {
    return {
        $transaction: vi.fn(async (fn: any) => fn(overrides.tx ?? overrides)),
        tenant: {
            findUnique: vi.fn(),
            findUniqueOrThrow: vi.fn(),
            update: vi.fn(),
        },
        creditTransaction: {
            create: vi.fn(),
        },
        location: {
            count: vi.fn().mockResolvedValue(0),
        },
        user: {
            count: vi.fn().mockResolvedValue(5),
        },
        ...overrides,
    };
}

describe('MeteringService – grantCredits', () => {
    let service: MeteringService;
    let prisma: ReturnType<typeof buildPrismaMock>;

    beforeEach(() => {
        prisma = buildPrismaMock({
            tx: {
                tenant: {
                    update: vi.fn().mockResolvedValue({ usageCredits: 100 }),
                },
                creditTransaction: {
                    create: vi.fn().mockResolvedValue({}),
                },
            },
        });

        // Wire the $transaction to call the function with the tx overrides
        prisma.$transaction = vi.fn(async (fn: any) => fn((prisma as any).tx));

        service = new MeteringService(prisma as any);
    });

    it('should reject non-positive amounts', async () => {
        await expect(service.grantCredits('tenant-1', 0, 'test')).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.grantCredits('tenant-1', -5, 'test')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should increment tenant usageCredits and create a ledger entry', async () => {
        const balance = await service.grantCredits('tenant-1', 100, 'Beta Signup Bonus');
        expect(balance).toBe(100);
        expect((prisma as any).tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { usageCredits: { increment: 100 } }
        });
        expect((prisma as any).tx.creditTransaction.create).toHaveBeenCalledWith({
            data: { tenantId: 'tenant-1', amount: 100, reason: 'Beta Signup Bonus' }
        });
    });
});

describe('MeteringService – consumeCredits', () => {
    let service: MeteringService;
    let prisma: ReturnType<typeof buildPrismaMock>;

    const setupWithBalance = (credits: number) => {
        const tx = {
            tenant: {
                findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'tenant-1', usageCredits: credits }),
                update: vi.fn().mockResolvedValue({ usageCredits: credits - 10 }),
            },
            creditTransaction: {
                create: vi.fn().mockResolvedValue({}),
            },
        };

        const mock = buildPrismaMock({ tx });
        mock.$transaction = vi.fn(async (fn: any) => fn(tx));
        return { service: new MeteringService(mock as any), tx, prisma: mock };
    };

    it('should reject non-positive amounts', async () => {
        const { service } = setupWithBalance(100);
        await expect(service.consumeCredits('tenant-1', -1, 'test')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should throw if tenant has insufficient credits', async () => {
        const { service } = setupWithBalance(5);
        await expect(service.consumeCredits('tenant-1', 10, 'Schedule Generation')).rejects.toThrow('Insufficient usage credits balance.');
    });

    it('should decrement credits and log a negative CreditTransaction', async () => {
        const { service, tx } = setupWithBalance(100);
        const newBalance = await service.consumeCredits('tenant-1', 10, 'Schedule Generation');

        expect(tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { usageCredits: { decrement: 10 } }
        });
        expect(tx.creditTransaction.create).toHaveBeenCalledWith({
            data: { tenantId: 'tenant-1', amount: -10, reason: 'Schedule Generation' }
        });
        expect(newBalance).toBe(90);
    });
});

describe('MeteringService – checkLimits', () => {
    it('should throw when location count exceeds the plan limits', async () => {
        const prisma = buildPrismaMock({
            location: { count: vi.fn().mockResolvedValue(5) },
        });
        const service = new MeteringService(prisma as any);
        await expect(service.checkLimits('tenant-1', PlanTier.BASIC)).rejects.toThrow(/limit reached/i);
    });

    it('should pass when location count is within plan limits', async () => {
        const prisma = buildPrismaMock({
            location: { count: vi.fn().mockResolvedValue(0) },
        });
        const service = new MeteringService(prisma as any);
        await expect(service.checkLimits('tenant-1', PlanTier.BASIC)).resolves.toBe(true);
    });
});
