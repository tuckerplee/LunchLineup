import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminController } from './admin.controller';

describe('AdminController credits', () => {
    let controller: AdminController;
    let prisma: any;
    let meteringService: { grantCredits: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        prisma = {
            tenant: {
                findMany: vi.fn(),
            },
            creditTransaction: {
                findMany: vi.fn(),
            },
        };

        meteringService = {
            grantCredits: vi.fn(),
        };

        controller = new AdminController(
            { get: vi.fn().mockReturnValue(null) } as any,
            { solverQueueDepth: { get: vi.fn().mockResolvedValue({ values: [] }) } } as any,
            meteringService as any,
        );

        (controller as any).prisma = prisma;
    });

    it('lists live tenant balances and credit history', async () => {
        prisma.tenant.findMany.mockResolvedValue([
            {
                id: 'tenant-1',
                name: 'Acme Dining',
                slug: 'acme-dining',
                planTier: 'STARTER',
                usageCredits: 125,
            },
        ]);
        prisma.creditTransaction.findMany.mockResolvedValue([
            {
                id: 'tx-1',
                amount: 100,
                reason: 'Seed grant',
                createdAt: new Date('2026-03-21T10:00:00.000Z'),
                tenant: {
                    id: 'tenant-1',
                    name: 'Acme Dining',
                    slug: 'acme-dining',
                },
            },
        ]);

        const result = await controller.credits({ user: { role: 'SUPER_ADMIN' } }, '25');

        expect(prisma.tenant.findMany).toHaveBeenCalledWith({
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                name: true,
                slug: true,
                planTier: true,
                usageCredits: true,
            },
        });
        expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith({
            orderBy: { createdAt: 'desc' },
            take: 25,
            include: {
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                    },
                },
            },
        });
        expect(result.tenants).toEqual([
            {
                id: 'tenant-1',
                name: 'Acme Dining',
                slug: 'acme-dining',
                planTier: 'STARTER',
                usageCredits: 125,
            },
        ]);
        expect(result.history).toEqual([
            {
                id: 'tx-1',
                amount: 100,
                reason: 'Seed grant',
                createdAt: new Date('2026-03-21T10:00:00.000Z'),
                tenant: {
                    id: 'tenant-1',
                    name: 'Acme Dining',
                    slug: 'acme-dining',
                },
            },
        ]);
    });

    it('grants credits through the metering service and returns the new balance', async () => {
        meteringService.grantCredits.mockResolvedValue(175);

        const result = await controller.grantCredits(
            { user: { role: 'SUPER_ADMIN' } },
            { tenantId: 'tenant-1', amount: 50, reason: 'Correction grant' },
        );

        expect(meteringService.grantCredits).toHaveBeenCalledWith('tenant-1', 50, 'Correction grant');
        expect(result).toEqual({
            success: true,
            newBalance: 175,
        });
    });
});
