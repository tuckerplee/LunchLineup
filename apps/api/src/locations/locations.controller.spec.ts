import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { TenantPrismaService } from '../database/tenant-prisma.service';

describe('LocationsController', () => {
    let controller: LocationsController;
    const writeReq = { user: { tenantId: 'tenant-1', role: 'STAFF', permissions: ['locations:write'] } };

    beforeEach(() => {
        controller = new LocationsController();
    });

    it('declares create as a locations write route for the global RBAC guard', () => {
        expect(Reflect.getMetadata('permission', controller.create)).toBe('locations:write');
    });

    it('updates tenant name during onboarding and creates location', async () => {
        const tenantFindUniqueOrThrow = vi.fn().mockResolvedValue({ planTier: 'FREE' });
        const tenantUpdate = vi.fn().mockResolvedValue({});
        const locationCount = vi.fn().mockResolvedValue(0);
        const locationCreate = vi.fn().mockResolvedValue({ id: 'loc-1', name: 'Downtown Bistro' });
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
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
        controller = new LocationsController(new TenantPrismaService({ $transaction: transaction } as any));

        const body = { name: 'Downtown Bistro', tenantName: 'Acme Dining' };
        const result = await controller.create(body, writeReq);

        expect(transaction).toHaveBeenCalledOnce();
        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(tx.$queryRaw.mock.calls[1][1]).toBe('location-capacity:tenant-1');
        expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(locationCount.mock.invocationCallOrder[0]);
        expect(locationCount.mock.invocationCallOrder[0]).toBeLessThan(locationCreate.mock.invocationCallOrder[0]);
        expect(tenantFindUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: {
                planTier: true,
                status: true,
                stripeSubscriptionId: true,
                trialEndsAt: true,
            },
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

    it('returns the original location when a create response is lost and retried with the same key', async () => {
        let persistedLocation: Record<string, unknown> | null = null;
        const locationFindFirst = vi.fn().mockImplementation(async ({ where }) => (
            persistedLocation?.tenantId === where.tenantId
            && persistedLocation?.creationRequestKeyHash === where.creationRequestKeyHash
                ? persistedLocation
                : null
        ));
        const locationCreate = vi.fn().mockImplementation(async ({ data }) => {
            persistedLocation = { id: 'loc-idempotent', ...data };
            return persistedLocation;
        });
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            tenant: {
                findUniqueOrThrow: vi.fn().mockResolvedValue({ planTier: 'FREE' }),
                update: vi.fn().mockResolvedValue({}),
            },
            location: {
                findFirst: locationFindFirst,
                count: vi.fn().mockResolvedValue(0),
                create: locationCreate,
            },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (cb: any) => cb(tx)),
        } as any));
        const body = { name: 'Downtown Bistro', tenantName: 'Acme Dining', timezone: 'America/Los_Angeles' };

        const first = await controller.create(body, writeReq, 'first-location-request-123');
        const retry = await controller.create(body, writeReq, 'first-location-request-123');

        expect(retry).toEqual(first);
        expect(locationCreate).toHaveBeenCalledOnce();
        expect(tx.location.count).toHaveBeenCalledOnce();
        expect(tx.tenant.update).toHaveBeenCalledOnce();
        expect(locationFindFirst).toHaveBeenCalledTimes(2);
        expect(locationCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                creationRequestKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                creationRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
        });
    });

    it('rejects reuse of a location idempotency key with a different payload', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            location: {
                findFirst: vi.fn().mockResolvedValue({
                    id: 'loc-idempotent',
                    creationRequestHash: 'different-request-hash',
                }),
                count: vi.fn(),
                create: vi.fn(),
            },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (cb: any) => cb(tx)),
        } as any));

        await expect(controller.create(
            { name: 'Uptown Bistro' },
            writeReq,
            'first-location-request-123',
        )).rejects.toBeInstanceOf(ConflictException);
        expect(tx.location.count).not.toHaveBeenCalled();
        expect(tx.location.create).not.toHaveBeenCalled();
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
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
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
        controller = new LocationsController(new TenantPrismaService({ $transaction: transaction } as any));

        await expect(controller.create({ name: 'Downtown Bistro', tenantName: 'Acme Dining' }, writeReq))
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

    it('rejects invalid IANA timezones before creating a location', async () => {
        await expect(controller.create(
            { name: 'Downtown', timezone: 'Mars/Olympus' },
            writeReq,
        )).rejects.toThrow('Location timezone must be a valid IANA timezone.');
    });

    it.each([
        {
            label: 'expired trial',
            tenant: {
                planTier: 'GROWTH',
                status: 'TRIAL',
                stripeSubscriptionId: null,
                trialEndsAt: new Date(Date.now() - 60_000),
            },
        },
        {
            label: 'delinquent subscription',
            tenant: {
                planTier: 'GROWTH',
                status: 'PAST_DUE',
                stripeSubscriptionId: 'sub_123',
                trialEndsAt: null,
            },
        },
        {
            label: 'terminal subscription',
            tenant: {
                planTier: 'ENTERPRISE',
                status: 'CANCELLED',
                stripeSubscriptionId: null,
                trialEndsAt: null,
            },
        },
    ])('applies free-tier location capacity to a $label tenant', async ({ tenant }) => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            tenant: {
                findUniqueOrThrow: vi.fn().mockResolvedValue(tenant),
                update: vi.fn(),
            },
            location: {
                count: vi.fn().mockResolvedValue(1),
                create: vi.fn(),
            },
            planDefinition: {
                findUnique: vi.fn().mockResolvedValue({
                    code: 'FREE',
                    name: 'Free',
                    active: true,
                    monthlyPriceCents: 0,
                    locationLimit: 1,
                    userLimit: 10,
                    creditQuotaLimit: 0,
                    metadata: null,
                }),
            },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (cb: any) => cb(tx)),
        } as any));

        await expect(controller.create({ name: 'Second location' }, writeReq))
            .rejects.toThrow(/Free plan/i);
        expect(tx.planDefinition.findUnique).toHaveBeenCalledWith({ where: { code: 'FREE' } });
        expect(tx.location.create).not.toHaveBeenCalled();
    });

    it('whitelists mutable fields when updating a location', async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 });
        const invalidateDrafts = vi.fn().mockResolvedValue({ count: 2 });
        const findFirst = vi.fn().mockResolvedValue({
            id: 'loc-1',
            name: 'Uptown Bistro',
            address: null,
            timezone: 'America/Chicago',
        });
        const tx = {
            $queryRaw: vi.fn(async (query: any) => {
                const sql = Array.isArray(query) ? query.join(' ') : String(query);
                if (sql.includes('FROM "Location"')) {
                    return [{ id: 'loc-1', timezone: 'America/New_York' }];
                }
                if (sql.includes('FROM "Schedule"')) {
                    return [{ id: 'schedule-draft', status: 'DRAFT' }];
                }
                return [{ set_current_tenant: null }];
            }),
            location: {
                updateMany,
                findFirst,
            },
            schedule: { updateMany: invalidateDrafts },
        };
        const transaction = vi.fn(async (cb: any) => cb(tx));
        controller = new LocationsController(new TenantPrismaService({ $transaction: transaction } as any));

        const result = await controller.update(
            'loc-1',
            {
                name: '  Uptown Bistro  ',
                address: '   ',
                timezone: ' America/Chicago ',
                tenantId: 'tenant-2',
                deletedAt: '2026-07-08T00:00:00.000Z',
            } as any,
            writeReq,
        );

        expect(updateMany).toHaveBeenCalledWith({
            where: { id: 'loc-1', tenantId: 'tenant-1', deletedAt: null },
            data: {
                name: 'Uptown Bistro',
                address: null,
                timezone: 'America/Chicago',
            },
        });
        expect(findFirst).toHaveBeenCalledWith({
            where: { id: 'loc-1', tenantId: 'tenant-1', deletedAt: null },
        });
        expect(invalidateDrafts).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                locationId: 'loc-1',
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
        expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
        expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(updateMany.mock.invocationCallOrder[0]);
        expect(tx.$queryRaw.mock.invocationCallOrder[2]).toBeLessThan(updateMany.mock.invocationCallOrder[0]);
        expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(invalidateDrafts.mock.invocationCallOrder[0]);
        expect(result.name).toBe('Uptown Bistro');
    });

    it('does not invalidate draft solves when the timezone is unchanged', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'loc-1', timezone: 'America/Chicago' }]),
            location: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                findFirst: vi.fn().mockResolvedValue({ id: 'loc-1', timezone: 'America/Chicago' }),
            },
            schedule: {
                updateMany: vi.fn(),
            },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (cb: any) => cb(tx)),
        } as any));

        await controller.update('loc-1', { name: 'Renamed', timezone: 'America/Chicago' }, writeReq);

        expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    });

    it.each(['PUBLISHED', 'ARCHIVED'])('rejects timezone changes with non-deleted %s schedule history', async (status) => {
        const tx = {
            $queryRaw: vi.fn(async (query: any) => {
                const sql = Array.isArray(query) ? query.join(' ') : String(query);
                if (sql.includes('FROM "Location"')) {
                    return [{ id: 'loc-1', timezone: 'America/Chicago' }];
                }
                if (sql.includes('FROM "Schedule"')) {
                    return [{ id: 'schedule-history', status }];
                }
                return [{ set_current_tenant: null }];
            }),
            location: {
                updateMany: vi.fn(),
                findFirst: vi.fn(),
            },
            schedule: {
                updateMany: vi.fn(),
            },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (cb: any) => cb(tx)),
        } as any));

        await expect(controller.update(
            'loc-1',
            { timezone: 'America/New_York' },
            writeReq,
        )).rejects.toBeInstanceOf(ConflictException);

        expect(tx.location.updateMany).not.toHaveBeenCalled();
        expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    });

    it('allows name-only updates when the location has published schedule history', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'loc-1', timezone: 'America/Chicago' }]),
            location: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                findFirst: vi.fn().mockResolvedValue({
                    id: 'loc-1',
                    name: 'Renamed',
                    timezone: 'America/Chicago',
                }),
            },
            schedule: {
                updateMany: vi.fn(),
            },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (cb: any) => cb(tx)),
        } as any));

        const result = await controller.update('loc-1', { name: 'Renamed' }, writeReq);

        expect(result.name).toBe('Renamed');
        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    });

    it('locks a location and invalidates only its active draft schedules before deletion', async () => {
        const locationUpdate = vi.fn().mockResolvedValue({ count: 1 });
        const invalidateDrafts = vi.fn().mockResolvedValue({ count: 3 });
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'loc-1', timezone: 'America/Los_Angeles' }]),
            location: { updateMany: locationUpdate },
            schedule: { updateMany: invalidateDrafts },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (cb: any) => cb(tx)),
        } as any));

        await controller.remove('loc-1', { user: { tenantId: 'tenant-1' } });

        expect(invalidateDrafts).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                locationId: 'loc-1',
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
        expect(locationUpdate).toHaveBeenCalledWith({
            where: { id: 'loc-1', tenantId: 'tenant-1', deletedAt: null },
            data: { deletedAt: expect.any(Date) },
        });
        expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(invalidateDrafts.mock.invocationCallOrder[0]);
        expect(invalidateDrafts.mock.invocationCallOrder[0]).toBeLessThan(locationUpdate.mock.invocationCallOrder[0]);
    });

    it('rejects location updates without supported fields', async () => {
        const updateMany = vi.fn();
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
            location: {
                updateMany,
            },
        };
        const transaction = vi.fn(async (cb: any) => cb(tx));
        controller = new LocationsController(new TenantPrismaService({ $transaction: transaction } as any));

        await expect(controller.update('loc-1', { tenantId: 'tenant-2' } as any, writeReq))
            .rejects
            .toBeInstanceOf(BadRequestException);

        expect(updateMany).not.toHaveBeenCalled();
    });

    it('rejects invalid IANA timezones before updating a location', async () => {
        await expect(controller.update(
            'loc-1',
            { timezone: 'Not/A_Real_Zone' },
            writeReq,
        )).rejects.toThrow('Location timezone must be a valid IANA timezone.');
    });
});
