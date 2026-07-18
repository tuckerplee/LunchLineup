import { describe, it, expect, vi, afterEach } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { MeteringService } from './metering.service';
import { PlanTier } from './plans.config';

// Utility to build a spy Prisma mock
function buildPrismaMock(overrides: Record<string, any> = {}) {
    const prisma = {
        $executeRaw: vi.fn().mockResolvedValue(1),
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

describe('MeteringService - credit grants', () => {
    function buildGrantHarness(
        existing: any = null,
        current = { usageCredits: 10, creditDebt: 0 },
        settled = { usageCredits: 15, creditDebt: 0 },
    ) {
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'tenant-1' }]),
            creditTransaction: {
                findUnique: vi.fn().mockResolvedValue(existing),
                create: vi.fn().mockResolvedValue({}),
            },
            tenant: {
                findUniqueOrThrow: vi.fn().mockResolvedValue(current),
                update: vi.fn().mockResolvedValue(settled),
            },
        };
        return {
            tx,
            service: new MeteringService(new TenantPrismaService(buildPrismaMock() as any)),
        };
    }

    it('locks the tenant and stores the exact post-grant balance in the ledger', async () => {
        const h = buildGrantHarness();

        await expect(h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: ' tenant-1 ',
            amount: 5,
            reason: ' Correction grant ',
            idempotencyKey: ' grant-request-1 ',
        })).resolves.toEqual({
            transactionId: expect.stringMatching(/^admin-credit-grant-[a-f0-9]{64}$/),
            newBalance: 15,
            replayed: false,
        });

        expect(h.tx.creditTransaction.create).toHaveBeenCalledWith({
            data: {
                id: expect.stringMatching(/^admin-credit-grant-[a-f0-9]{64}$/),
                tenantId: 'tenant-1',
                amount: 5,
                debtAmount: 0,
                reason: 'Correction grant',
                balanceAfter: 15,
                debtAfter: 0,
            },
            select: { id: true },
        });
        expect(h.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                usageCredits: { increment: 5 },
                creditDebt: { decrement: 0 },
            },
            select: { usageCredits: true, creditDebt: true },
        });
        expect(h.tx.$queryRaw).toHaveBeenCalledOnce();
        expect(h.tx.$executeRaw).toHaveBeenCalledOnce();
        expect(Array.from(h.tx.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join(' ')).toContain(
            'LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE',
        );
        expect(h.tx.$executeRaw.mock.invocationCallOrder[0])
            .toBeLessThan(h.tx.$queryRaw.mock.invocationCallOrder[0]);
        expect(h.tx.$queryRaw.mock.invocationCallOrder[0])
            .toBeLessThan(h.tx.tenant.update.mock.invocationCallOrder[0]);
        expect(h.tx.tenant.update.mock.invocationCallOrder[0])
            .toBeLessThan(h.tx.creditTransaction.create.mock.invocationCallOrder[0]);
    });

    it('replays the stored original grant balance after intervening wallet changes', async () => {
        const h = buildGrantHarness({
            tenantId: 'tenant-1',
            amount: 5,
            debtAmount: 0,
            reason: 'Correction grant',
            balanceAfter: 15,
            debtAfter: 0,
        });

        await expect(h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: 'tenant-1',
            amount: 5,
            reason: 'Correction grant',
            idempotencyKey: 'grant-request-1',
        })).resolves.toMatchObject({ newBalance: 15, replayed: true });

        expect(h.tx.creditTransaction.create).not.toHaveBeenCalled();
        expect(h.tx.tenant.update).not.toHaveBeenCalled();
        expect(h.tx.$queryRaw).toHaveBeenCalledOnce();
    });

    it.each([
        {
            label: 'fully',
            amount: 5,
            current: { usageCredits: 10, creditDebt: 3 },
            settled: { usageCredits: 12, creditDebt: 0 },
            spendableAmount: 2,
            repaidDebt: 3,
        },
        {
            label: 'partially',
            amount: 2,
            current: { usageCredits: 10, creditDebt: 5 },
            settled: { usageCredits: 10, creditDebt: 3 },
            spendableAmount: 0,
            repaidDebt: 2,
        },
    ])('$label repays debt before adding spendable grant credits', async ({
        amount,
        current,
        settled,
        spendableAmount,
        repaidDebt,
    }) => {
        const h = buildGrantHarness(null, current, settled);

        await expect(h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: 'tenant-1',
            amount,
            reason: 'Correction grant',
            idempotencyKey: `debt-grant-${amount}`,
        })).resolves.toEqual({
            transactionId: expect.stringMatching(/^admin-credit-grant-[a-f0-9]{64}$/),
            newBalance: settled.usageCredits,
            replayed: false,
        });

        expect(h.tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: {
                usageCredits: { increment: spendableAmount },
                creditDebt: { decrement: repaidDebt },
            },
            select: { usageCredits: true, creditDebt: true },
        });
        expect(h.tx.creditTransaction.create).toHaveBeenCalledWith({
            data: {
                id: expect.stringMatching(/^admin-credit-grant-[a-f0-9]{64}$/),
                tenantId: 'tenant-1',
                amount: spendableAmount,
                debtAmount: -repaidDebt,
                reason: 'Correction grant',
                balanceAfter: settled.usageCredits,
                debtAfter: settled.creditDebt,
            },
            select: { id: true },
        });
    });

    it('replays the original total value after a debt-repaying grant', async () => {
        const h = buildGrantHarness({
            tenantId: 'tenant-1',
            amount: 2,
            debtAmount: -3,
            reason: 'Correction grant',
            balanceAfter: 12,
            debtAfter: 0,
        });

        await expect(h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: 'tenant-1',
            amount: 5,
            reason: 'Correction grant',
            idempotencyKey: 'grant-request-1',
        })).resolves.toEqual({
            transactionId: expect.stringMatching(/^admin-credit-grant-[a-f0-9]{64}$/),
            newBalance: 12,
            replayed: true,
        });

        expect(h.tx.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
        expect(h.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('derives different ledger identities for the same key in different tenants', async () => {
        const h = buildGrantHarness();

        await h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: 'tenant-1', amount: 5, reason: 'Correction grant', idempotencyKey: 'shared-key',
        });
        await h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: 'tenant-2', amount: 5, reason: 'Correction grant', idempotencyKey: 'shared-key',
        });

        const firstId = h.tx.creditTransaction.create.mock.calls[0][0].data.id;
        const secondId = h.tx.creditTransaction.create.mock.calls[1][0].data.id;
        expect(firstId).not.toBe(secondId);
    });

    it.each([
        ['missing tenant', undefined, 5, 'Correction grant', 'request-1'],
        ['blank tenant', ' ', 5, 'Correction grant', 'request-1'],
        ['zero amount', 'tenant-1', 0, 'Correction grant', 'request-1'],
        ['fractional amount', 'tenant-1', 1.5, 'Correction grant', 'request-1'],
        ['missing reason', 'tenant-1', 5, undefined, 'request-1'],
        ['blank reason', 'tenant-1', 5, ' ', 'request-1'],
        ['missing idempotency key', 'tenant-1', 5, 'Correction grant', undefined],
    ])('rejects %s before locking or mutating the tenant', async (
        _case,
        tenantId,
        amount,
        reason,
        idempotencyKey,
    ) => {
        const h = buildGrantHarness();

        await expect(h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: tenantId as any,
            amount,
            reason: reason as any,
            idempotencyKey: idempotencyKey as any,
        })).rejects.toBeInstanceOf(BadRequestException);

        expect(h.tx.$queryRaw).not.toHaveBeenCalled();
        expect(h.tx.tenant.update).not.toHaveBeenCalled();
    });

    it('rejects idempotency-key reuse with different tenant billing details', async () => {
        const h = buildGrantHarness({
            tenantId: 'tenant-1',
            amount: 4,
            debtAmount: 0,
            reason: 'Different grant',
            balanceAfter: 14,
            debtAfter: 0,
        });

        await expect(h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: 'tenant-1',
            amount: 5,
            reason: 'Correction grant',
            idempotencyKey: 'grant-request-1',
        })).rejects.toBeInstanceOf(ConflictException);

        expect(h.tx.creditTransaction.create).not.toHaveBeenCalled();
        expect(h.tx.tenant.update).not.toHaveBeenCalled();
    });

    it.each([null, -1, 1.5])('rejects malformed legacy settlement balance %#', async (balanceAfter) => {
        const h = buildGrantHarness({
            tenantId: 'tenant-1',
            amount: 5,
            debtAmount: 0,
            reason: 'Correction grant',
            balanceAfter,
            debtAfter: 0,
        });

        await expect(h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: 'tenant-1',
            amount: 5,
            reason: 'Correction grant',
            idempotencyKey: 'grant-request-1',
        })).rejects.toThrow(/immutable settlement balance/i);

        expect(h.tx.tenant.update).not.toHaveBeenCalled();
        expect(h.tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it.each([null, -1, 1.5])('rejects malformed immutable grant debt %#', async (debtAfter) => {
        const h = buildGrantHarness({
            tenantId: 'tenant-1',
            amount: 5,
            debtAmount: 0,
            reason: 'Correction grant',
            balanceAfter: 15,
            debtAfter,
        });

        await expect(h.service.grantCreditsInTransaction(h.tx as any, {
            tenantId: 'tenant-1',
            amount: 5,
            reason: 'Correction grant',
            idempotencyKey: 'grant-request-1',
        })).rejects.toThrow(/immutable debt balance/i);

        expect(h.tx.tenant.update).not.toHaveBeenCalled();
        expect(h.tx.creditTransaction.create).not.toHaveBeenCalled();
    });
});
describe('MeteringService - transactional feature usage', () => {
    it('does not expose the obsolete included-usage bypass', () => {
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        expect(service).not.toHaveProperty('trackIncludedUsage');
    });

    it.each([0, -1, 1.5, Number.NaN])(
        'rejects invalid feature credit cost %s before touching the ledger',
        async (cost) => {
            const tx: any = {
                $executeRaw: vi.fn(),
                $queryRaw: vi.fn(),
                tenant: {
                    updateMany: vi.fn(),
                    findUniqueOrThrow: vi.fn(),
                },
                creditTransaction: {
                    create: vi.fn(),
                    findUnique: vi.fn(),
                },
            };
            const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

            await expect(service.recordFeatureUsageInTransaction(tx, {
                tenantId: 'tenant-1',
                source: 'credits',
                cost,
                reason: 'Time card clock-in (card-1)',
                operationId: 'clock-in-op',
            })).rejects.toBeInstanceOf(BadRequestException);
            expect(tx.creditTransaction.findUnique).not.toHaveBeenCalled();
            expect(tx.creditTransaction.create).not.toHaveBeenCalled();
            expect(tx.tenant.updateMany).not.toHaveBeenCalled();
        },
    );
    it('atomically records and debits one credit-backed unit', async () => {
        const tx: any = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn(),
            tenant: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                findUniqueOrThrow: vi.fn().mockResolvedValue({ usageCredits: 4, creditDebt: 0 }),
            },
            creditTransaction: {
                create: vi.fn().mockResolvedValue({}),
                findUnique: vi.fn().mockResolvedValue(null),
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
                debtAmount: 0,
                reason: 'Time card clock-in (card-1)',
                balanceAfter: 4,
                debtAfter: 0,
            },
        });
        expect(tx.tenant.updateMany).toHaveBeenCalledWith({
            where: { id: 'tenant-1', creditDebt: 0, usageCredits: { gte: 1 } },
            data: { usageCredits: { decrement: 1 } },
        });
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            tx.tenant.updateMany.mock.invocationCallOrder[0],
        );
        expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
            tx.$queryRaw.mock.invocationCallOrder[0],
        );
        expect(tx.tenant.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
            tx.creditTransaction.create.mock.invocationCallOrder[0],
        );
        expect(result).toEqual({ consumedCredits: 1, newBalance: 4 });
    });

    it('records a caller-owned deterministic debit identity without changing its format', async () => {
        const tx: any = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn(),
            tenant: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                findUniqueOrThrow: vi.fn().mockResolvedValue({ usageCredits: 3, creditDebt: 0 }),
            },
            creditTransaction: {
                create: vi.fn().mockResolvedValue({}),
                findUnique: vi.fn().mockResolvedValue(null),
            },
        };
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        await expect(service.recordCreditDebitInTransaction(tx, {
            tenantId: 'tenant-1',
            cost: 2,
            reason: 'Lunch/Break generation (request-1)',
            transactionId: 'lunch-break-credit-request-1',
        })).resolves.toEqual({ consumedCredits: 2, newBalance: 3 });

        expect(tx.creditTransaction.create).toHaveBeenCalledWith({
            data: {
                id: 'lunch-break-credit-request-1',
                tenantId: 'tenant-1',
                amount: -2,
                debtAmount: 0,
                reason: 'Lunch/Break generation (request-1)',
                balanceAfter: 3,
                debtAfter: 0,
            },
        });
    });

    it.each(['plan', 'stripe', 'manual'] as const)('rejects legacy %s usage bypasses', async (source) => {
        const tx: any = {
            $executeRaw: vi.fn(),
            $queryRaw: vi.fn(),
            tenant: {
                updateMany: vi.fn(),
                findUniqueOrThrow: vi.fn(),
            },
            creditTransaction: {
                findUnique: vi.fn(),
                create: vi.fn(),
            },
        };
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        await expect(service.recordFeatureUsageInTransaction(tx, {
            tenantId: 'tenant-1',
            source,
            cost: 1,
            reason: 'Time card clock-in (card-1)',
            operationId: 'clock-in-op',
        })).rejects.toThrow('Billable feature usage requires wallet credits.');

        expect(tx.creditTransaction.findUnique).not.toHaveBeenCalled();
        expect(tx.creditTransaction.create).not.toHaveBeenCalled();
        expect(tx.tenant.updateMany).not.toHaveBeenCalled();
    });

    it('recovers an already charged operation without debiting again', async () => {
        const tx: any = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn(),
            tenant: {
                updateMany: vi.fn(),
                findUniqueOrThrow: vi.fn().mockResolvedValue({ usageCredits: 4 }),
            },
            creditTransaction: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'feature-usage-clock-in-op',
                    tenantId: 'tenant-1',
                    amount: -1,
                    debtAmount: 0,
                    reason: 'Time card clock-in (card-1)',
                    balanceAfter: 4,
                    debtAfter: 0,
                }),
                create: vi.fn(),
            },
        };
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        await expect(service.recordFeatureUsageInTransaction(tx, {
            tenantId: 'tenant-1',
            source: 'credits',
            cost: 1,
            reason: 'Time card clock-in (card-1)',
            operationId: 'clock-in-op',
        })).resolves.toEqual({ consumedCredits: 1, newBalance: 4 });

        expect(tx.creditTransaction.create).not.toHaveBeenCalled();
        expect(tx.tenant.updateMany).not.toHaveBeenCalled();
        expect(tx.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('rejects operation id reuse with different billing details', async () => {
        const tx: any = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn(),
            tenant: {
                updateMany: vi.fn(),
                findUniqueOrThrow: vi.fn(),
            },
            creditTransaction: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'feature-usage-clock-in-op',
                    tenantId: 'tenant-1',
                    amount: -2,
                    debtAmount: 0,
                    reason: 'Different charge',
                    balanceAfter: 3,
                    debtAfter: 0,
                }),
                create: vi.fn(),
            },
        };
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        await expect(service.recordFeatureUsageInTransaction(tx, {
            tenantId: 'tenant-1',
            source: 'credits',
            cost: 1,
            reason: 'Time card clock-in (card-1)',
            operationId: 'clock-in-op',
        })).rejects.toBeInstanceOf(ConflictException);

        expect(tx.creditTransaction.create).not.toHaveBeenCalled();
        expect(tx.tenant.updateMany).not.toHaveBeenCalled();
    });

    it('fails insufficient credit usage before returning a free unit', async () => {
        const tx: any = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn(),
            tenant: {
                updateMany: vi.fn().mockResolvedValue({ count: 0 }),
                findUniqueOrThrow: vi.fn(),
            },
            creditTransaction: {
                create: vi.fn().mockResolvedValue({}),
                findUnique: vi.fn().mockResolvedValue(null),
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
        expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it.each([null, -1, 1.5])('rejects malformed feature replay balance %#', async (balanceAfter) => {
        const tx: any = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn(),
            tenant: {
                updateMany: vi.fn(),
                findUniqueOrThrow: vi.fn(),
            },
            creditTransaction: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'feature-usage-clock-in-op',
                    tenantId: 'tenant-1',
                    amount: -1,
                    debtAmount: 0,
                    reason: 'Time card clock-in (card-1)',
                    balanceAfter,
                    debtAfter: 0,
                }),
                create: vi.fn(),
            },
        };
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        await expect(service.recordFeatureUsageInTransaction(tx, {
            tenantId: 'tenant-1',
            source: 'credits',
            cost: 1,
            reason: 'Time card clock-in (card-1)',
            operationId: 'clock-in-op',
        })).rejects.toThrow(/immutable settlement balance/i);

        expect(tx.tenant.updateMany).not.toHaveBeenCalled();
        expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it.each([
        [null, /immutable debt balance/i],
        [-1, /immutable debt balance/i],
        [1, /credit debt remained outstanding/i],
        [1.5, /immutable debt balance/i],
    ])('rejects malformed feature replay debt %#', async (debtAfter, expectedError) => {
        const tx: any = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn(),
            tenant: {
                updateMany: vi.fn(),
                findUniqueOrThrow: vi.fn(),
            },
            creditTransaction: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'feature-usage-clock-in-op',
                    tenantId: 'tenant-1',
                    amount: -1,
                    debtAmount: 0,
                    reason: 'Time card clock-in (card-1)',
                    balanceAfter: 4,
                    debtAfter,
                }),
                create: vi.fn(),
            },
        };
        const service = new MeteringService(new TenantPrismaService(buildPrismaMock() as any));

        await expect(service.recordFeatureUsageInTransaction(tx, {
            tenantId: 'tenant-1',
            source: 'credits',
            cost: 1,
            reason: 'Time card clock-in (card-1)',
            operationId: 'clock-in-op',
        })).rejects.toThrow(expectedError);

        expect(tx.tenant.updateMany).not.toHaveBeenCalled();
        expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    });
});
describe('MeteringService - checkLimits', () => {
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
describe('MeteringService - Stripe operational diagnostics', () => {
    it('persists and logs an allowlisted diagnostic without raw provider text', async () => {
        const secret = 'sk_live_super_secret https://private.example.test/path?token=leak';
        const providerError = Object.assign(new Error(secret), {
            name: 'StripeConnectionError',
            code: 'ECONNRESET',
            requestId: 'req_ABC12345',
        });
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const findUnique = vi.fn(async () => ({
            id: 'usage-1',
            tenantId: 'tenant-1',
            status: 'SENDING',
            submittedAt: updateMany.mock.calls[0][0].data.submittedAt,
            eventName: 'active_staff',
            stripeCustomerId: 'cus_123',
            quantity: 5,
            identifier: 'usage_identifier',
            periodStart: new Date('2026-07-14T00:00:00.000Z'),
            idempotencyKey: 'usage-idempotency',
            attempts: 1,
        }));
        const tenantDb = {
            withTenant: vi.fn(async (_tenantId: string, operation: (tx: any) => Promise<unknown>) => (
                operation({ stripeUsageEvent: { updateMany, findUnique } })
            )),
        };
        const stripeMeterEvents = {
            createMeterEvent: vi.fn().mockRejectedValue(providerError),
        };
        const service = new MeteringService(tenantDb as any, stripeMeterEvents as any);
        const warn = vi.fn();
        (service as any).logger = { warn };

        await expect((service as any).sendPersistedUsageEvent('tenant-1', 'usage-1'))
            .rejects.toThrow('Stripe metered usage reporting failed');

        const diagnostic = updateMany.mock.calls[1][0].data.lastError;
        expect(JSON.parse(diagnostic)).toEqual({
            event: 'billing.meter_usage_send_failed',
            errorClass: 'StripeConnectionError',
            category: 'connectivity',
            code: 'ECONNRESET',
            requestRef: 'req_ABC12345',
        });
        expect(diagnostic).not.toContain(secret);
        expect(diagnostic).not.toContain('sk_live');
        expect(diagnostic).not.toContain('private.example.test');
        expect(warn).toHaveBeenCalledWith(diagnostic);
        expect(warn.mock.calls.flat().join(' ')).not.toContain(secret);
    });
});
