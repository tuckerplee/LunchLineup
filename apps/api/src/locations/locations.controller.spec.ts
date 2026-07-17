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

    it('declares the bounded list and summary as locations read routes', () => {
        expect(Reflect.getMetadata('permission', controller.findAll)).toBe('locations:read');
        expect(Reflect.getMetadata('permission', controller.summary)).toBe('locations:read');
    });

    it('returns stable bounded location pages with an explicit continuation cursor', async () => {
        const rows = [
            { id: 'loc-a', name: 'Alpha' },
            { id: 'loc-b1', name: 'Bravo' },
            { id: 'loc-b2', name: 'Bravo' },
            { id: 'loc-c', name: 'Charlie' },
        ];
        const findMany = vi.fn().mockImplementation(async ({ where, take }) => {
            const cursorName = where.OR?.[0]?.name?.gt;
            const cursorId = where.OR?.[1]?.id?.gt;
            const pageRows = cursorName === undefined
                ? rows
                : rows.filter((row) => row.name > cursorName || (row.name === cursorName && row.id > cursorId));
            return pageRows.slice(0, take);
        });
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([]),
            location: { findMany },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (callback: any) => callback(tx)),
        } as any));

        const first = await controller.findAll({ user: { tenantId: 'tenant-1' } }, '2');
        const second = await controller.findAll(
            { user: { tenantId: 'tenant-1' } },
            '2',
            first.pagination.nextCursor ?? undefined,
        );

        expect(first.data).toEqual(rows.slice(0, 2));
        expect(first.pagination).toMatchObject({
            limit: 2,
            maxLimit: 200,
            returned: 2,
            hasMore: true,
            nextCursor: expect.any(String),
        });
        expect(second.data).toEqual(rows.slice(2));
        expect(second.pagination).toMatchObject({
            limit: 2,
            returned: 2,
            hasMore: false,
            nextCursor: null,
        });
        expect(findMany).toHaveBeenNthCalledWith(1, {
            where: { tenantId: 'tenant-1', deletedAt: null },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: 3,
        });
        expect(findMany).toHaveBeenNthCalledWith(2, {
            where: {
                tenantId: 'tenant-1',
                deletedAt: null,
                OR: [
                    { name: { gt: 'Bravo' } },
                    { name: 'Bravo', id: { gt: 'loc-b1' } },
                ],
            },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: 3,
        });
    });

    it('rejects location list limits above the public API maximum before querying', async () => {
        await expect(controller.findAll({ user: { tenantId: 'tenant-1' } }, '201'))
            .rejects
            .toThrow('Use 1 through 200');
    });

    it('returns an exact active-location count without loading location rows', async () => {
        const count = vi.fn().mockResolvedValue(237);
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([]),
            location: { count },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (callback: any) => callback(tx)),
        } as any));

        await expect(controller.summary({ user: { tenantId: 'tenant-1' } })).resolves.toEqual({ count: 237 });
        expect(count).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1', deletedAt: null } });
    });

    it('updates tenant name and creates a location with an explicit non-Eastern timezone', async () => {
        const tenantFindUniqueOrThrow = vi.fn().mockResolvedValue({ planTier: 'FREE', slug: 'acme-dining-a1b2c3' });
        const tenantUpdate = vi.fn().mockResolvedValue({});
        const locationCount = vi.fn().mockResolvedValue(0);
        const locationCreate = vi.fn().mockResolvedValue({ id: 'loc-1', name: 'Downtown Bistro' });
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
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

        const body = {
            name: 'Downtown Bistro',
            tenantName: 'Acme Dining',
            workspaceSlug: 'acme-dining-a1b2c3',
            timezone: 'America/Los_Angeles',
        };
        const result = await controller.create(body, writeReq);

        expect(transaction).toHaveBeenCalledOnce();
        expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
        expect(tx.$executeRaw.mock.calls[1][1]).toBe('location-capacity:tenant-1');
        expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(locationCount.mock.invocationCallOrder[0]);
        expect(locationCount.mock.invocationCallOrder[0]).toBeLessThan(locationCreate.mock.invocationCallOrder[0]);
        expect(tenantFindUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { slug: true },
        });
        expect(tenantFindUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: {
                planTier: true,
                status: true,
                stripeSubscriptionId: true,
                stripeSubscriptionCurrentPeriodEnd: true,
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
                timezone: 'America/Los_Angeles',
                tenantId: 'tenant-1',
            },
        });
        expect(result).toEqual({ id: 'loc-1', name: 'Downtown Bistro' });
    });

    it('rejects first-location recovery when the signed-in workspace changed', async () => {
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([]),
            tenant: {
                findUniqueOrThrow: vi.fn().mockResolvedValue({ slug: 'current-workspace' }),
                update: vi.fn(),
            },
            location: {
                findFirst: vi.fn(),
                count: vi.fn(),
                create: vi.fn(),
            },
        };
        controller = new LocationsController(new TenantPrismaService({
            $transaction: vi.fn(async (cb: any) => cb(tx)),
        } as any));

        await expect(controller.create({
            name: 'Downtown Bistro',
            tenantName: 'Acme Dining',
            workspaceSlug: 'verified-workspace',
            timezone: 'America/Los_Angeles',
        }, writeReq, 'first-location-request-123')).rejects.toThrow(
            'First-location setup does not match the signed-in workspace',
        );

        expect(tx.location.findFirst).not.toHaveBeenCalled();
        expect(tx.location.count).not.toHaveBeenCalled();
        expect(tx.location.create).not.toHaveBeenCalled();
        expect(tx.tenant.update).not.toHaveBeenCalled();
    });

    it('rejects organization updates outside workspace-bound first-location setup', async () => {
        await expect(controller.create({
            name: 'Downtown Bistro',
            tenantName: 'Acme Dining',
            timezone: 'America/Los_Angeles',
        }, writeReq)).rejects.toThrow('workspaceSlug is required for first-location setup');
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
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([]),
            tenant: {
                findUniqueOrThrow: vi.fn().mockResolvedValue({ planTier: 'FREE', slug: 'acme-dining-a1b2c3' }),
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
        const body = { name: 'Downtown Bistro', tenantName: 'Acme Dining', timezone: 'America/Los_Angeles', workspaceSlug: 'acme-dining-a1b2c3' };

        const first = await controller.create(body, writeReq, 'first-location-request-123');
        const retry = await controller.create(body, writeReq, 'first-location-request-123');

        expect(retry).toEqual(first);
        expect(locationCreate).toHaveBeenCalledOnce();
        expect(tx.location.count).toHaveBeenCalledTimes(2);
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
            $executeRaw: vi.fn().mockResolvedValue(1),
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
            { name: 'Uptown Bistro', timezone: 'America/Los_Angeles' },
            writeReq,
            'first-location-request-123',
        )).rejects.toBeInstanceOf(ConflictException);
        expect(tx.location.count).not.toHaveBeenCalled();
        expect(tx.location.create).not.toHaveBeenCalled();
    });

    it('blocks bootstrap create when the plan location limit has already been reached', async () => {
        const tenantFindUniqueOrThrow = vi.fn().mockResolvedValue({ planTier: 'FREE', slug: 'acme-dining-a1b2c3' });
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
            $executeRaw: vi.fn().mockResolvedValue(1),
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

        await expect(controller.create({
            name: 'Downtown Bistro',
            tenantName: 'Acme Dining',
            workspaceSlug: 'acme-dining-a1b2c3',
            timezone: 'America/Los_Angeles',
        }, writeReq))
            .rejects
            .toBeInstanceOf(ForbiddenException);

        expect(planDefinitionFindUnique).toHaveBeenCalledWith({
            where: { code: 'FREE' },
        });
        expect(tenantUpdate).not.toHaveBeenCalled();
        expect(locationCreate).not.toHaveBeenCalled();
    });

    it('throws bad request for empty location name', async () => {
        await expect(controller.create(
            { name: '   ', timezone: 'America/Los_Angeles' },
            { user: { tenantId: 'tenant-1' } },
        ))
            .rejects
            .toBeInstanceOf(BadRequestException);
    });

    it('rejects an omitted timezone before creating a location', async () => {
        await expect(controller.create(
            { name: 'Downtown' },
            writeReq,
        )).rejects.toThrow('Location timezone is required.');
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
            $executeRaw: vi.fn().mockResolvedValue(1),
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

        await expect(controller.create({ name: 'Second location', timezone: 'America/Denver' }, writeReq))
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
            $executeRaw: vi.fn().mockResolvedValue(1),
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
        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(updateMany.mock.invocationCallOrder[0]);
        expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(updateMany.mock.invocationCallOrder[0]);
        expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(invalidateDrafts.mock.invocationCallOrder[0]);
        expect(result.name).toBe('Uptown Bistro');
    });

    it('does not invalidate draft solves when the timezone is unchanged', async () => {
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
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
            $executeRaw: vi.fn().mockResolvedValue(1),
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

    it('allows name updates with an explicit unchanged timezone when published history exists', async () => {
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
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

        const result = await controller.update(
            'loc-1',
            { name: 'Renamed', timezone: 'America/Chicago' },
            writeReq,
        );

        expect(result.name).toBe('Renamed');
        expect(tx.$queryRaw).toHaveBeenCalledOnce();
        expect(tx.schedule.updateMany).not.toHaveBeenCalled();
    });

    it('locks a location and invalidates only its active draft schedules before deletion', async () => {
        const locationUpdate = vi.fn().mockResolvedValue({ count: 1 });
        const invalidateDrafts = vi.fn().mockResolvedValue({ count: 3 });
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
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
        expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(invalidateDrafts.mock.invocationCallOrder[0]);
        expect(invalidateDrafts.mock.invocationCallOrder[0]).toBeLessThan(locationUpdate.mock.invocationCallOrder[0]);
    });

    it('rejects location updates that omit timezone', async () => {
        const updateMany = vi.fn();
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
            location: {
                updateMany,
            },
        };
        const transaction = vi.fn(async (cb: any) => cb(tx));
        controller = new LocationsController(new TenantPrismaService({ $transaction: transaction } as any));

        await expect(controller.update('loc-1', { name: 'Renamed' }, writeReq))
            .rejects
            .toThrow('Location timezone is required.');

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
