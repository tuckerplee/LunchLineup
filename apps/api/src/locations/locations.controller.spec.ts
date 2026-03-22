import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { LocationsController } from './locations.controller';

describe('LocationsController', () => {
    let controller: LocationsController;

    beforeEach(() => {
        controller = new LocationsController();
    });

    it('updates tenant name during onboarding and creates location', async () => {
        const tenantFindUniqueOrThrow = vi.fn().mockResolvedValue({ planTier: 'FREE' });
        const tenantUpdate = vi.fn().mockResolvedValue({});
        const locationCount = vi.fn().mockResolvedValue(0);
        const locationCreate = vi.fn().mockResolvedValue({ id: 'loc-1', name: 'Downtown Bistro' });
        const tx = {
            tenant: {
                findUniqueOrThrow: tenantFindUniqueOrThrow,
                update: tenantUpdate,
            },
            location: {
                count: locationCount,
                create: locationCreate,
            },
        };
        const transaction = vi.fn(async (cb: any) => cb(tx));
        (controller as any).prisma = {
            location: {
                count: vi.fn().mockResolvedValue(0),
            },
            $transaction: transaction,
        };

        const req = { user: { tenantId: 'tenant-1', role: 'STAFF' } };
        const body = { name: 'Downtown Bistro', tenantName: 'Acme Dining' };
        const result = await controller.create(body, req);

        expect(transaction).toHaveBeenCalledOnce();
        expect(tenantFindUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { planTier: true },
        });
        expect(locationCount).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', deletedAt: null },
        });
        expect(tenantUpdate).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { name: 'Acme Dining' },
        });
        expect(locationCreate).toHaveBeenCalledWith({
            data: {
                name: 'Downtown Bistro',
                address: undefined,
                timezone: undefined,
                tenantId: 'tenant-1',
            },
        });
        expect(result).toEqual({ id: 'loc-1', name: 'Downtown Bistro' });
    });

    it('blocks bootstrap create when the plan location limit has already been reached', async () => {
        const tenantFindUniqueOrThrow = vi.fn().mockResolvedValue({ planTier: 'FREE' });
        const tenantUpdate = vi.fn().mockResolvedValue({});
        const locationCount = vi.fn().mockResolvedValue(0);
        const locationCreate = vi.fn().mockResolvedValue({ id: 'loc-1', name: 'Downtown Bistro' });
        const planDefinitionFindUnique = vi.fn().mockResolvedValue({
            id: 'plan-1',
            code: 'CUSTOM',
            name: 'Custom',
            monthlyPriceCents: null,
            locationLimit: 0,
            userLimit: null,
            creditQuotaLimit: null,
            active: true,
            metadata: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const tx = {
            tenant: {
                findUniqueOrThrow: tenantFindUniqueOrThrow,
                update: tenantUpdate,
            },
            location: {
                count: locationCount,
                create: locationCreate,
            },
            planDefinition: {
                findUnique: planDefinitionFindUnique,
            },
        };
        const transaction = vi.fn(async (cb: any) => cb(tx));
        (controller as any).prisma = {
            location: {
                count: vi.fn().mockResolvedValue(0),
            },
            $transaction: transaction,
        };

        await expect(controller.create({ name: 'Downtown Bistro', tenantName: 'Acme Dining' }, { user: { tenantId: 'tenant-1', role: 'STAFF' } }))
            .rejects
            .toBeInstanceOf(ForbiddenException);

        expect(planDefinitionFindUnique).toHaveBeenCalledWith({
            where: { code: 'FREE' },
        });
        expect(tenantUpdate).not.toHaveBeenCalled();
        expect(locationCreate).not.toHaveBeenCalled();
    });

    it('throws bad request for empty location name', async () => {
        await expect(controller.create({ name: '   ' }, { user: { tenantId: 'tenant-1' } }))
            .rejects
            .toBeInstanceOf(BadRequestException);
    });
});
