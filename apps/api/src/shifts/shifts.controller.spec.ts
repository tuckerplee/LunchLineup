import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ShiftsController } from './shifts.controller';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { decodeBoundedListCursor } from '../common/bounded-pagination';
import { shiftUpdateRequestHash } from './shift-update-idempotency';

describe('ShiftsController', () => {
    let controller: ShiftsController;
    let prisma: any;
    let featureAccessService: any;
    let activeLocation: { id: string; timezone: string } | null;
    let lockedBreaks: Array<{ id: string; startTime: Date; endTime: Date }>;

    function createShift(body: any, req: any, idempotencyKey = 'shift-create-test-key') {
        return controller.create(body, req, idempotencyKey);
    }

    function bulkAssign(body: any, req: any, idempotencyKey = 'shift-bulk-test-key') {
        return controller.bulkAssign(body, req, idempotencyKey);
    }

    function updateShift(id: string, body: any, req: any, idempotencyKey = 'shift-update-test-key') {
        return controller.update(id, body, req, idempotencyKey);
    }

    function bulkTarget(overrides: Record<string, unknown> = {}) {
        return {
            id: 'shift-1',
            scheduleId: 'schedule-1',
            locationId: 'loc-1',
            userId: null,
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'DRAFT' },
            ...overrides,
        };
    }

    beforeEach(() => {
        featureAccessService = {
            lockTenantInTransaction: vi.fn().mockResolvedValue(undefined),
            assertFeatureEntitledInTransaction: vi.fn().mockResolvedValue({
                enabled: true,
                source: 'credits',
                creditCost: 1,
            }),
            assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({
                enabled: true,
                source: 'credits',
                creditCost: 1,
            }),
            recordFeatureUsageInTransaction: vi.fn().mockResolvedValue({ consumedCredits: 1, newBalance: 9 }),
        };
        activeLocation = { id: 'loc-1', timezone: 'America/New_York' };
        lockedBreaks = [];
        prisma = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn(async (query: any) => {
                const sql = Array.isArray(query) ? query.join(' ') : String(query);
                if (sql.includes('FROM "Location"') && sql.includes('FOR UPDATE')) {
                    return activeLocation ? [activeLocation] : [];
                }
                if (sql.includes('FROM "Schedule"') && sql.includes('FOR UPDATE')) {
                    return [{ id: 'schedule-1', status: 'DRAFT' }];
                }
                if (sql.includes('FROM "Break"') && sql.includes('FOR UPDATE')) return lockedBreaks;
                return [{ set_current_tenant: null }];
            }),
            user: {
                findFirst: vi.fn(),
                findMany: vi.fn(),
            },
            location: {
                findFirst: vi.fn(),
            },
            shift: {
                create: vi.fn(),
                findFirst: vi.fn(),
                updateMany: vi.fn(),
                findMany: vi.fn(),
                count: vi.fn(),
            },
            break: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            schedule: {
                findFirst: vi.fn(),
                create: vi.fn(),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            auditLog: {
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
            },
            $transaction: vi.fn(async (callback: (txClient: any) => Promise<unknown>) => callback(prisma)),
        };
        controller = new ShiftsController(
            featureAccessService,
            new TenantPrismaService(prisma),
        );
        prisma.location.findFirst.mockResolvedValue({ id: 'loc-1', timezone: 'America/New_York' });
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
        prisma.schedule.findFirst.mockResolvedValue({
            id: 'schedule-1',
            locationId: 'loc-1',
            status: 'DRAFT',
            startDate: new Date('2026-03-10T04:00:00.000Z'),
            endDate: new Date('2026-03-11T04:00:00.000Z'),
        });
        prisma.shift.count.mockResolvedValue(0);
        prisma.shift.updateMany.mockResolvedValue({ count: 1 });
    });

    it.each([
        {
            name: 'shift creation',
            transactions: 3,
            mutate: () => createShift({
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            }, { user: { tenantId: 'tenant-1' } }),
        },
        {
            name: 'shift update',
            transactions: 3,
            mutate: () => {
                prisma.shift.findFirst.mockResolvedValue({
                    id: 'shift-1',
                    scheduleId: 'schedule-1',
                    locationId: 'loc-1',
                    userId: 'user-1',
                    role: 'STAFF',
                    startTime: new Date('2026-03-10T17:00:00.000Z'),
                    endTime: new Date('2026-03-10T21:00:00.000Z'),
                    schedule: {
                        status: 'DRAFT',
                        startDate: new Date('2026-03-10T04:00:00.000Z'),
                        endDate: new Date('2026-03-11T04:00:00.000Z'),
                    },
                });
                return updateShift('shift-1', { endTime: '2026-03-10T22:00:00.000Z' }, { user: { tenantId: 'tenant-1' } });
            },
        },
        {
            name: 'bulk assignment',
            transactions: 3,
            mutate: () => {
                prisma.shift.findMany.mockResolvedValue([bulkTarget()]);
                return bulkAssign(
                    { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
                    { user: { tenantId: 'tenant-1' } },
                );
            },
        },
    ])('denies $name from inside its write transaction when entitlement changes', async ({ mutate, transactions }) => {
        featureAccessService.assertFeatureEnabledInTransaction.mockRejectedValue(
            new ForbiddenException('Subscription inactive or credits exhausted'),
        );

        await expect(mutate()).rejects.toBeInstanceOf(ForbiddenException);

        expect(featureAccessService.assertFeatureEnabledInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            'scheduling',
        );
        expect(prisma.$transaction).toHaveBeenCalledTimes(transactions);
        expect(prisma.shift.create).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
    it('creates an assigned draft shift without sending an assignment notification', async () => {
        prisma.shift.create.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
        });

        await createShift(
            {
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        );

        expect(prisma.shift.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                locationId: 'loc-1',
                scheduleId: 'schedule-1',
                userId: 'user-1',
            }),
        });
        const locationLockCall = prisma.$queryRaw.mock.calls.find(([query]: [any]) => (
            Array.from(query).join(' ').includes('FROM "Location"')
        ));
        expect(locationLockCall).toBeDefined();
        expect(Array.from(locationLockCall[0]).join(' ')).toContain('FOR UPDATE');
        const schedulingLockCall = prisma.$executeRaw.mock.calls.findIndex((call: any[]) => (
            Array.from(call[0] as ArrayLike<unknown>).join(' ').includes('pg_advisory_xact_lock')
        ));
        expect(schedulingLockCall).toBeGreaterThanOrEqual(0);
        expect(featureAccessService.lockTenantInTransaction.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.$executeRaw.mock.invocationCallOrder[schedulingLockCall],
        );
        expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(prisma.shift.create.mock.invocationCallOrder[0]);
        expect(prisma.schedule.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                id: { in: ['schedule-1'] },
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
    });

    it('requires an idempotency key before entitlement or tenant database work', async () => {
        await expect(controller.create(
            {
                locationId: 'loc-1',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
            undefined,
        )).rejects.toThrow('Idempotency-Key header is required');

        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('replays an unassigned shift create without inserting a duplicate', async () => {
        const createdShift = {
            id: 'shift-unassigned-1',
            tenantId: 'tenant-1',
            locationId: 'loc-1',
            scheduleId: 'schedule-1',
            userId: null,
            role: 'CASHIER',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
        };
        prisma.shift.create.mockResolvedValue(createdShift);
        const body = {
            locationId: 'loc-1',
            startTime: '2026-03-10T17:00:00.000Z',
            endTime: '2026-03-10T21:00:00.000Z',
            role: 'CASHIER',
        };
        const req = { user: { tenantId: 'tenant-1', sub: 'manager-1' } };

        const first = await createShift(body, req, 'unassigned-attempt-1');
        const storedOutcome = prisma.auditLog.create.mock.calls[0][0].data.newValue;
        prisma.auditLog.findFirst.mockResolvedValue({ newValue: storedOutcome });
        featureAccessService.assertFeatureEnabledInTransaction.mockRejectedValue(new ForbiddenException('Subscription inactive'));

        const replay = await createShift(body, req, 'unassigned-attempt-1');

        expect(replay).toEqual(first);
        expect(prisma.shift.create).toHaveBeenCalledOnce();
        expect(prisma.schedule.updateMany).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
        expect(featureAccessService.assertFeatureEnabledInTransaction).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                resource: 'ShiftCreationRequest',
                resourceId: expect.stringMatching(/^[a-f0-9]{64}$/),
                newValue: expect.objectContaining({
                    requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                    response: expect.objectContaining({ id: 'shift-unassigned-1' }),
                }),
            }),
        });
        expect(prisma.auditLog.create.mock.calls[0][0].data.resourceId).not.toContain('unassigned-attempt-1');
    });

    it('charges the authoritative positive scheduling cost once for a created shift', async () => {
        const entitlement = { enabled: true, source: 'credits', creditCost: 3 };
        featureAccessService.assertFeatureEnabledInTransaction.mockResolvedValue(entitlement);
        prisma.shift.create.mockResolvedValue({ id: 'shift-billed-1' });

        await createShift(
            {
                locationId: 'loc-1',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
            'shift-credit-cost-3',
        );

        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            entitlement,
            expect.stringMatching(/^Manual shift creation \([a-f0-9]{64}\)$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
        );
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });
    it('rejects reuse of a shift creation key with a different payload', async () => {
        prisma.auditLog.findFirst.mockResolvedValue({
            newValue: {
                requestHash: 'different-request-hash',
                response: { id: 'shift-unassigned-1' },
            },
        });

        await expect(createShift(
            {
                locationId: 'loc-1',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
            'reused-key',
        )).rejects.toThrow('different shift creation request');

        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('allows intentional identical unassigned shifts when each request has a distinct key', async () => {
        prisma.shift.create
            .mockResolvedValueOnce({ id: 'shift-unassigned-1' })
            .mockResolvedValueOnce({ id: 'shift-unassigned-2' });
        const body = {
            locationId: 'loc-1',
            startTime: '2026-03-10T17:00:00.000Z',
            endTime: '2026-03-10T21:00:00.000Z',
        };
        const req = { user: { tenantId: 'tenant-1' } };

        await createShift(body, req, 'headcount-slot-1');
        await createShift(body, req, 'headcount-slot-2');

        expect(prisma.shift.create).toHaveBeenCalledTimes(2);
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    });

    it('does not create after a concurrent location deletion wins the row lock', async () => {
        activeLocation = null;

        await expect(createShift(
            {
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Location is not available for this tenant.');

        expect(prisma.schedule.findFirst).not.toHaveBeenCalled();
        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('uses an explicit schedule only when it belongs to the tenant and location', async () => {
        prisma.schedule.findFirst.mockResolvedValue({
            id: 'schedule-2',
            locationId: 'loc-1',
            status: 'DRAFT',
            startDate: new Date('2026-03-10T04:00:00.000Z'),
            endDate: new Date('2026-03-11T04:00:00.000Z'),
        });
        prisma.shift.create.mockResolvedValue({
            id: 'shift-1',
            userId: null,
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
        });

        await createShift(
            {
                locationId: 'loc-1',
                scheduleId: 'schedule-2',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        );

        expect(prisma.schedule.findFirst).toHaveBeenCalledWith({
            where: { id: 'schedule-2', tenantId: 'tenant-1', deletedAt: null },
            select: { id: true, locationId: true, status: true, startDate: true, endDate: true },
        });
        expect(prisma.shift.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                locationId: 'loc-1',
                scheduleId: 'schedule-2',
            }),
        });
    });

    it('rejects an explicit soft-deleted schedule before creating a shift', async () => {
        prisma.schedule.findFirst.mockResolvedValue(null);

        await expect(createShift(
            {
                locationId: 'loc-1',
                scheduleId: 'schedule-deleted',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Schedule is not available for this tenant.');

        expect(prisma.schedule.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'schedule-deleted', tenantId: 'tenant-1', deletedAt: null },
        }));
        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('rejects an explicit schedule from another location', async () => {
        prisma.schedule.findFirst.mockResolvedValue({ id: 'schedule-2', locationId: 'loc-2', status: 'DRAFT' });

        await expect(createShift(
            {
                locationId: 'loc-1',
                scheduleId: 'schedule-2',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Schedule is not available for this location.');

        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('rejects an explicit schedule that has already been published', async () => {
        prisma.schedule.findFirst.mockResolvedValue({ id: 'schedule-2', locationId: 'loc-1', status: 'PUBLISHED' });

        await expect(createShift(
            {
                locationId: 'loc-1',
                scheduleId: 'schedule-2',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published schedules are locked');

        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('rejects shift creation outside a location-local schedule window across DST', async () => {
        prisma.schedule.findFirst.mockResolvedValue({
            id: 'schedule-dst',
            locationId: 'loc-1',
            status: 'DRAFT',
            startDate: new Date('2026-03-08T08:00:00.000Z'),
            endDate: new Date('2026-03-09T07:00:00.000Z'),
        });

        await expect(createShift(
            {
                locationId: 'loc-1',
                scheduleId: 'schedule-dst',
                startTime: '2026-03-08T07:30:00.000Z',
                endTime: '2026-03-08T12:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Shift must stay within its schedule window.');

        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('updates an assigned draft shift and charges one operation', async () => {
        const entitlement = { enabled: true, source: 'credits', creditCost: 4 };
        featureAccessService.assertFeatureEnabledInTransaction.mockResolvedValue(entitlement);
        prisma.shift.findFirst
            .mockResolvedValueOnce({
                id: 'shift-1',
                userId: 'user-1',
                role: 'CASHIER',
                startTime: new Date('2026-03-10T17:00:00.000Z'),
                endTime: new Date('2026-03-10T21:00:00.000Z'),
            })
            .mockResolvedValueOnce({
                id: 'shift-1',
                tenantId: 'tenant-1',
                userId: 'user-1',
                role: 'CASHIER',
                startTime: new Date('2026-03-10T18:00:00.000Z'),
                endTime: new Date('2026-03-10T22:00:00.000Z'),
                breaks: [],
            });
        prisma.shift.updateMany.mockResolvedValue({ count: 1 });

        await updateShift(
            'shift-1',
            { startTime: '2026-03-10T18:00:00.000Z', endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        );

        expect(prisma.shift.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: { id: 'shift-1', tenantId: 'tenant-1', deletedAt: null },
        }));
        expect(prisma.shift.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'shift-1', tenantId: 'tenant-1', deletedAt: null },
        }));
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            entitlement,
            expect.stringMatching(/^Manual shift update \([a-f0-9]{64}\)$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
        );
    });

    it('requires an idempotency key before starting a shift update transaction', async () => {
        await expect(controller.update(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
            undefined,
        )).rejects.toThrow('Idempotency-Key header is required for shift updates');

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    });

    it('returns the current shift for a fresh semantic no-op without entitlement, debit, writes, or audit', async () => {
        const existing = {
            id: 'shift-1',
            scheduleId: 'schedule-1',
            locationId: 'loc-1',
            userId: 'user-1',
            role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: {
                id: 'schedule-1',
                locationId: 'loc-1',
                status: 'DRAFT',
                startDate: new Date('2026-03-10T04:00:00.000Z'),
                endDate: new Date('2026-03-11T04:00:00.000Z'),
            },
            breaks: [{
                id: 'break-1',
                startTime: new Date('2026-03-10T18:00:00.000Z'),
                endTime: new Date('2026-03-10T18:30:00.000Z'),
            }],
        };
        prisma.shift.findFirst.mockResolvedValue(existing);
        const body = {
            userId: 'user-1',
            startTime: '2026-03-10T17:00:00.000Z',
            endTime: '2026-03-10T21:00:00.000Z',
            role: 'STAFF',
        };
        const req = { user: { tenantId: 'tenant-1' } };

        const first = await updateShift('shift-1', body, req, 'fresh-no-op-key');
        const retry = await updateShift('shift-1', body, req, 'fresh-no-op-key');

        expect(first).toEqual(JSON.parse(JSON.stringify(existing)));
        expect(retry).toEqual(first);
        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.break.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(prisma.schedule.updateMany).not.toHaveBeenCalled();
    });

    it('durably replays a shift update after entitlement loss without charging twice', async () => {
        const existing = {
            id: 'shift-1',
            scheduleId: 'schedule-1',
            locationId: 'loc-1',
            userId: 'user-1',
            role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: {
                id: 'schedule-1',
                locationId: 'loc-1',
                status: 'DRAFT',
                startDate: new Date('2026-03-10T04:00:00.000Z'),
                endDate: new Date('2026-03-11T04:00:00.000Z'),
            },
        };
        const updated = { ...existing, endTime: new Date('2026-03-10T22:00:00.000Z'), breaks: [] };
        lockedBreaks = [{ id: 'break-1', startTime: new Date('2026-03-10T18:00:00.000Z'), endTime: new Date('2026-03-10T18:30:00.000Z') }];
        prisma.shift.findFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce(updated);
        const body = { endTime: '2026-03-10T22:00:00.000Z' };
        const req = { user: { tenantId: 'tenant-1', sub: 'manager-1' } };

        const first = await updateShift('shift-1', body, req, 'shift-update-replay-1');
        const storedOutcome = prisma.auditLog.create.mock.calls[0][0].data.newValue;
        prisma.auditLog.findFirst.mockResolvedValue({ newValue: storedOutcome });
        featureAccessService.assertFeatureEnabledInTransaction.mockRejectedValue(new ForbiddenException('Subscription inactive'));

        const replay = await updateShift('shift-1', body, req, 'shift-update-replay-1');

        expect(replay).toEqual(first);
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.shift.updateMany).toHaveBeenCalledOnce();
        expect(prisma.break.updateMany).toHaveBeenCalledOnce();
        expect(prisma.schedule.updateMany).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('recovers the committed shift result after a lost transaction response without charging twice', async () => {
        const existing = {
            id: 'shift-1', scheduleId: 'schedule-1', locationId: 'loc-1', userId: 'user-1', role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'), endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'DRAFT', startDate: new Date('2026-03-10T04:00:00.000Z'), endDate: new Date('2026-03-11T04:00:00.000Z') },
        };
        const updated = { ...existing, startTime: new Date('2026-03-10T18:00:00.000Z'), endTime: new Date('2026-03-10T22:00:00.000Z'), breaks: [] };
        lockedBreaks = [{ id: 'break-1', startTime: new Date('2026-03-10T18:00:00.000Z'), endTime: new Date('2026-03-10T18:30:00.000Z') }];
        prisma.shift.findFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce(updated);
        let transactionCount = 0;
        prisma.$transaction.mockImplementation(async (callback: (txClient: any) => Promise<unknown>) => {
            const result = await callback(prisma);
            transactionCount += 1;
            if (transactionCount === 2) {
                prisma.auditLog.findFirst.mockResolvedValue({
                    newValue: prisma.auditLog.create.mock.calls[0][0].data.newValue,
                });
                throw new Error('Committed transaction response was lost');
            }
            return result;
        });

        const result = await updateShift(
            'shift-1',
            { startTime: '2026-03-10T18:00:00.000Z', endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
            'shift-update-lost-response-1',
        );

        expect(result).toEqual(JSON.parse(JSON.stringify(updated)));
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.shift.updateMany).toHaveBeenCalledOnce();
        expect(prisma.break.updateMany).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it.each([
        ['same-duration move', { startTime: '2026-03-10T18:00:00.000Z', endTime: '2026-03-10T22:00:00.000Z' }, '2026-03-10T19:00:00.000Z'],
        ['safe resize', { endTime: '2026-03-10T20:00:00.000Z' }, '2026-03-10T18:00:00.000Z'],
    ])('translates dependent breaks for a %s', async (_name, body, expectedBreakStart) => {
        const existing = {
            id: 'shift-1', scheduleId: 'schedule-1', locationId: 'loc-1', userId: 'user-1', role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'), endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'DRAFT', startDate: new Date('2026-03-10T04:00:00.000Z'), endDate: new Date('2026-03-11T04:00:00.000Z') },
        };
        lockedBreaks = [{ id: 'break-1', startTime: new Date('2026-03-10T18:00:00.000Z'), endTime: new Date('2026-03-10T18:30:00.000Z') }];
        prisma.shift.findFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, ...body, breaks: [] });

        await updateShift('shift-1', body, { user: { tenantId: 'tenant-1' } }, `translate-${_name}`);

        expect(prisma.break.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ startTime: new Date(expectedBreakStart) }),
        }));
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
    });

    it('rejects an unsafe resize before debit or mutation', async () => {
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1', scheduleId: 'schedule-1', locationId: 'loc-1', userId: 'user-1', role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'), endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'DRAFT', startDate: new Date('2026-03-10T04:00:00.000Z'), endDate: new Date('2026-03-11T04:00:00.000Z') },
        });
        lockedBreaks = [{ id: 'break-1', startTime: new Date('2026-03-10T20:00:00.000Z'), endTime: new Date('2026-03-10T20:30:00.000Z') }];
        await expect(updateShift('shift-1', { endTime: '2026-03-10T20:15:00.000Z' }, { user: { tenantId: 'tenant-1' } }, 'unsafe-resize'))
            .rejects.toThrow('Move the breaks first');
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.break.updateMany).not.toHaveBeenCalled();
    });

    it('rejects shift update request drift without charging', async () => {
        prisma.auditLog.findFirst.mockResolvedValue({
            newValue: {
                requestHash: 'different-request-hash',
                response: { id: 'shift-1' },
            },
        });

        await expect(updateShift(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
            'shift-update-drift-1',
        )).rejects.toThrow('different shift update request');

        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('uses the post-lock replay from a concurrent winner before charging', async () => {
        const requestHash = shiftUpdateRequestHash({
            shiftId: 'shift-1',
            endTime: '2026-03-10T22:00:00.000Z',
        });
        const response = { id: 'shift-1', endTime: '2026-03-10T22:00:00.000Z' };
        prisma.auditLog.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ newValue: { requestHash, response } });

        const result = await updateShift(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
            'shift-update-concurrent-1',
        );

        expect(result).toEqual(response);
        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('rolls billing back with the shift update when the guarded write fails', async () => {
        let balance = 1;
        prisma.$transaction.mockImplementation(async (callback: (txClient: any) => Promise<unknown>) => {
            const startingBalance = balance;
            try {
                return await callback(prisma);
            } catch (error) {
                balance = startingBalance;
                throw error;
            }
        });
        featureAccessService.recordFeatureUsageInTransaction.mockImplementation(async () => {
            balance -= 1;
            return { consumedCredits: 1, newBalance: balance };
        });
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            scheduleId: 'schedule-1',
            locationId: 'loc-1',
            userId: 'user-1',
            role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: {
                status: 'DRAFT',
                startDate: new Date('2026-03-10T04:00:00.000Z'),
                endDate: new Date('2026-03-11T04:00:00.000Z'),
            },
        });
        prisma.shift.updateMany.mockResolvedValue({ count: 0 });

        await expect(updateShift(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
            'shift-update-rollback-1',
        )).rejects.toThrow('Shift not found');

        expect(balance).toBe(1);
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rolls the debit and shift move back when a locked break write misses', async () => {
        let balance = 2;
        let persistedShiftStart = new Date('2026-03-10T17:00:00.000Z');
        const persistedBreakStart = new Date('2026-03-10T18:00:00.000Z');
        prisma.$transaction.mockImplementation(async (callback: (txClient: any) => Promise<unknown>) => {
            const startingBalance = balance;
            const startingShiftStart = persistedShiftStart;
            try {
                return await callback(prisma);
            } catch (error) {
                balance = startingBalance;
                persistedShiftStart = startingShiftStart;
                throw error;
            }
        });
        featureAccessService.recordFeatureUsageInTransaction.mockImplementation(async () => {
            balance -= 1;
            return { consumedCredits: 1, newBalance: balance };
        });
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1', scheduleId: 'schedule-1', locationId: 'loc-1', userId: 'user-1', role: 'STAFF',
            startTime: persistedShiftStart, endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'DRAFT', startDate: new Date('2026-03-10T04:00:00.000Z'), endDate: new Date('2026-03-11T04:00:00.000Z') },
        });
        lockedBreaks = [{ id: 'break-1', startTime: persistedBreakStart, endTime: new Date('2026-03-10T18:30:00.000Z') }];
        prisma.shift.updateMany.mockImplementation(async ({ data }: any) => {
            persistedShiftStart = data.startTime;
            return { count: 1 };
        });
        prisma.break.updateMany.mockResolvedValue({ count: 0 });

        const error = await updateShift(
            'shift-1',
            { startTime: '2026-03-10T18:00:00.000Z', endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
            'shift-update-break-miss-1',
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getStatus()).toBe(409);
        expect(balance).toBe(2);
        expect(persistedShiftStart).toEqual(new Date('2026-03-10T17:00:00.000Z'));
        expect(persistedBreakStart).toEqual(new Date('2026-03-10T18:00:00.000Z'));
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('lets a zero-credit active paid tenant delete a draft shift as a non-billable correction', async () => {
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            scheduleId: 'schedule-1',
            schedule: { status: 'DRAFT' },
        });
        featureAccessService.assertFeatureEnabledInTransaction.mockRejectedValue(
            new ForbiddenException('Positive wallet required'),
        );

        await controller.remove('shift-1', { user: { tenantId: 'tenant-1' } });

        expect(prisma.shift.updateMany).toHaveBeenCalledWith({
            where: { id: 'shift-1', tenantId: 'tenant-1', deletedAt: null },
            data: { deletedAt: expect.any(Date) },
        });
        expect(prisma.schedule.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                id: { in: ['schedule-1'] },
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
        expect(featureAccessService.assertFeatureEntitledInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            'scheduling',
        );
        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('reuses a containing weekly draft for an overnight shift when scheduleId is omitted', async () => {
        const weeklyDraft = {
            id: 'schedule-week',
            locationId: 'loc-1',
            status: 'DRAFT',
            startDate: new Date('2026-03-09T04:00:00.000Z'),
            endDate: new Date('2026-03-16T04:00:00.000Z'),
        };
        prisma.schedule.findFirst.mockResolvedValueOnce(weeklyDraft);
        prisma.shift.create.mockResolvedValue({
            id: 'shift-overnight',
            locationId: 'loc-1',
            scheduleId: 'schedule-week',
            userId: null,
            startTime: new Date('2026-03-11T02:00:00.000Z'),
            endTime: new Date('2026-03-11T06:00:00.000Z'),
        });

        await createShift(
            {
                locationId: 'loc-1',
                startTime: '2026-03-11T02:00:00.000Z',
                endTime: '2026-03-11T06:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        );

        expect(prisma.schedule.findFirst).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                locationId: 'loc-1',
                status: 'DRAFT',
                deletedAt: null,
                startDate: { lte: new Date('2026-03-11T02:00:00.000Z') },
                endDate: { gte: new Date('2026-03-11T06:00:00.000Z') },
            },
            orderBy: [{ startDate: 'desc' }, { endDate: 'asc' }],
            select: { id: true, locationId: true, status: true, startDate: true, endDate: true },
        });
        expect(prisma.schedule.create).not.toHaveBeenCalled();
        expect(prisma.shift.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ scheduleId: 'schedule-week' }),
        });
    });

    it('creates a containing two-day draft for an overnight shift when none exists', async () => {
        prisma.schedule.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        prisma.schedule.create.mockResolvedValue({ id: 'schedule-new' });
        prisma.shift.create.mockResolvedValue({
            id: 'shift-1',
            userId: null,
            startTime: new Date('2026-03-11T02:00:00.000Z'),
            endTime: new Date('2026-03-11T06:00:00.000Z'),
        });

        await createShift(
            {
                locationId: 'loc-1',
                startTime: '2026-03-11T02:00:00.000Z',
                endTime: '2026-03-11T06:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        );

        expect(prisma.schedule.findFirst).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                locationId: 'loc-1',
                status: 'DRAFT',
                deletedAt: null,
                startDate: { lte: new Date('2026-03-11T02:00:00.000Z') },
                endDate: { gte: new Date('2026-03-11T06:00:00.000Z') },
            },
            orderBy: [{ startDate: 'desc' }, { endDate: 'asc' }],
            select: { id: true, locationId: true, status: true, startDate: true, endDate: true },
        });
        expect(prisma.schedule.findFirst).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                locationId: 'loc-1',
                deletedAt: null,
                startDate: { lt: new Date('2026-03-12T04:00:00.000Z') },
                endDate: { gt: new Date('2026-03-10T04:00:00.000Z') },
            },
            select: { id: true, status: true },
        });
        expect(prisma.schedule.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                locationId: 'loc-1',
                startDate: new Date('2026-03-10T04:00:00.000Z'),
                endDate: new Date('2026-03-12T04:00:00.000Z'),
                status: 'DRAFT',
            },
            select: { id: true },
        });
        expect(prisma.shift.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                scheduleId: 'schedule-new',
            }),
        });
    });

    it('does not create a fallback over an overlapping draft that is too short', async () => {
        prisma.schedule.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'schedule-day', status: 'DRAFT' });

        await expect(createShift(
            {
                locationId: 'loc-1',
                startTime: '2026-03-11T02:00:00.000Z',
                endTime: '2026-03-11T06:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('An existing draft schedule does not contain the full shift interval.');

        expect(prisma.schedule.create).not.toHaveBeenCalled();
        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('does not auto-create a draft over a published schedule', async () => {
        prisma.schedule.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'schedule-published', status: 'PUBLISHED' });

        await expect(createShift(
            {
                locationId: 'loc-1',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published schedules are locked. Create an explicit draft schedule before adding shifts.');

        expect(prisma.schedule.create).not.toHaveBeenCalled();
        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('rejects ambiguous shift dates before tenant database work', async () => {
        await expect(createShift(
            {
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: '03/10/2026 09:00',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Invalid startTime');

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('rejects invalid calendar shift dates before tenant database work', async () => {
        await expect(createShift(
            {
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: '2026-02-30T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Invalid startTime');

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('rejects created shifts whose end time is not after start time', async () => {
        await expect(createShift(
            {
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: '2026-03-10T21:00:00.000Z',
                endTime: '2026-03-10T17:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Shift end time must be after start time.');

        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('rejects created assigned shifts that overlap an existing shift for the user', async () => {
        prisma.shift.count.mockResolvedValue(1);

        await expect(createShift(
            {
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('User already has a shift that overlaps this time window.');

        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('rejects updated shifts whose end time is not after start time', async () => {
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
        });

        await expect(updateShift(
            'shift-1',
            { endTime: '2026-03-10T16:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Shift end time must be after start time.');

        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('rejects updated assigned shifts that overlap an existing shift for the user', async () => {
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
        });
        prisma.shift.count.mockResolvedValue(1);

        const error = await updateShift(
            'shift-1',
            { startTime: '2026-03-10T18:00:00.000Z', endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ConflictException);
        expect(error.getStatus()).toBe(409);
        expect(error.message).toContain('User already has a shift that overlaps this time window.');
        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.break.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(prisma.schedule.updateMany).not.toHaveBeenCalled();
    });

    it('rejects moving a shift past its stored schedule end', async () => {
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            scheduleId: 'schedule-1',
            userId: 'user-1',
            role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: {
                id: 'schedule-1',
                locationId: 'loc-1',
                status: 'DRAFT',
                startDate: new Date('2026-03-10T04:00:00.000Z'),
                endDate: new Date('2026-03-11T04:00:00.000Z'),
            },
        });

        await expect(updateShift(
            'shift-1',
            { endTime: '2026-03-11T04:00:01.000Z' },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Shift must stay within its schedule window.');

        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('rejects updates to shifts on a published schedule', async () => {
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'PUBLISHED' },
        });

        await expect(updateShift(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published or archived schedules are locked');

        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('rejects updates to shifts on an archived schedule without billing or mutation', async () => {
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            scheduleId: 'schedule-1',
            locationId: 'loc-1',
            userId: 'user-1',
            role: 'STAFF',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'ARCHIVED' },
        });

        await expect(updateShift(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published or archived schedules are locked');

        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.break.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects deletes from shifts on a published schedule', async () => {
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            schedule: { status: 'PUBLISHED' },
        });

        await expect(controller.remove(
            'shift-1',
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published schedules are locked');

        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('rejects bulk assignments with overlapping shifts for the same user', async () => {
        prisma.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                scheduleId: 'schedule-1',
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: new Date('2026-03-10T17:00:00.000Z'),
                endTime: new Date('2026-03-10T21:00:00.000Z'),
            },
            {
                id: 'shift-2',
                scheduleId: 'schedule-1',
                locationId: 'loc-1',
                startTime: new Date('2026-03-10T20:00:00.000Z'),
                endTime: new Date('2026-03-10T23:00:00.000Z'),
            },
        ]);

        await expect(bulkAssign(
            {
                assignments: [
                    { shiftId: 'shift-1', userId: 'user-1' },
                    { shiftId: 'shift-2', userId: 'user-1' },
                ],
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Bulk assignment contains overlapping shifts for the same user.');

        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('does not assign retained shifts after their location is deleted', async () => {
        activeLocation = null;
        prisma.shift.findMany.mockResolvedValue([{
            id: 'shift-1',
            scheduleId: 'schedule-1',
            locationId: 'loc-1',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'DRAFT' },
        }]);

        await expect(bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Location is not available for this tenant.');

        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('rejects bulk assignments on published schedules', async () => {
        prisma.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                scheduleId: 'schedule-1',
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: new Date('2026-03-10T17:00:00.000Z'),
                endTime: new Date('2026-03-10T21:00:00.000Z'),
                schedule: { status: 'PUBLISHED' },
            },
        ]);

        await expect(bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published schedules are locked');

        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant bulk assignment targets before entitlement or mutation', async () => {
        prisma.shift.findMany.mockResolvedValue([]);

        await expect(bulkAssign(
            { assignments: [{ shiftId: 'other-tenant-shift', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('One or more shifts are not available for this tenant.');

        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('re-reads bulk assignment targets after locking when the solver replaces shifts', async () => {
        prisma.shift.findMany
            .mockResolvedValueOnce([{ id: 'shift-1', scheduleId: 'schedule-1' }])
            .mockResolvedValueOnce([{
                id: 'shift-1',
                scheduleId: 'replacement-schedule',
                locationId: 'loc-1',
                startTime: new Date('2026-03-10T17:00:00.000Z'),
                endTime: new Date('2026-03-10T21:00:00.000Z'),
                schedule: { status: 'DRAFT' },
            }]);

        await expect(bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toBeInstanceOf(ConflictException);

        expect(prisma.shift.findMany).toHaveBeenCalledTimes(2);
        const scheduleLockCall = prisma.$queryRaw.mock.calls.findIndex(([query]: [unknown]) => {
            const sql = Array.isArray(query) ? query.join(' ') : String(query);
            return sql.includes('FROM "Schedule"') && sql.includes('FOR UPDATE');
        });
        expect(scheduleLockCall).toBeGreaterThanOrEqual(0);
        expect(prisma.shift.findMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.$queryRaw.mock.invocationCallOrder[scheduleLockCall],
        );
        expect(prisma.$queryRaw.mock.invocationCallOrder[scheduleLockCall]).toBeLessThan(
            prisma.shift.findMany.mock.invocationCallOrder[1],
        );
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('fails the bulk transaction when a guarded assignment update misses', async () => {
        prisma.shift.findMany
            .mockResolvedValueOnce([{ id: 'shift-1', scheduleId: 'schedule-1' }])
            .mockResolvedValueOnce([{
                id: 'shift-1',
                scheduleId: 'schedule-1',
                locationId: 'loc-1',
                startTime: new Date('2026-03-10T17:00:00.000Z'),
                endTime: new Date('2026-03-10T21:00:00.000Z'),
                schedule: { status: 'DRAFT' },
            }]);
        prisma.shift.updateMany.mockResolvedValue({ count: 0 });

        await expect(bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toBeInstanceOf(ConflictException);

        expect(prisma.shift.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'shift-1',
                tenantId: 'tenant-1',
                scheduleId: 'schedule-1',
                userId: null,
                deletedAt: null,
            },
            data: { userId: 'user-1' },
        });
    });

    it('rejects a shift update when the schedule becomes published before the row lock', async () => {
        prisma.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            scheduleId: 'schedule-1',
            userId: 'user-1',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'DRAFT' },
        });
        prisma.$queryRaw.mockImplementation(async (query: any) => {
            const sql = Array.isArray(query) ? query.join(' ') : String(query);
            return sql.includes('FROM "Schedule"') && sql.includes('FOR UPDATE')
                ? [{ id: 'schedule-1', status: 'PUBLISHED' }]
                : [{ set_current_tenant: null }];
        });

        await expect(updateShift(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published schedules are locked');
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('bounds overlapping shift windows and continues with an ascending keyset cursor', async () => {
        const rows = [
            { id: 'shift-1', startTime: new Date('2026-03-09T16:00:00.000Z') },
            { id: 'shift-2', startTime: new Date('2026-03-09T17:00:00.000Z') },
            { id: 'shift-3', startTime: new Date('2026-03-09T18:00:00.000Z') },
        ];
        prisma.shift.findMany.mockResolvedValueOnce(rows);

        const firstPage = await controller.findAll(
            { user: { tenantId: 'tenant-1', role: 'MANAGER' } },
            'loc-1',
            'schedule-1',
            '2026-03-09T07:00:00.000Z',
            '2026-03-10T07:00:00.000Z',
            '2',
        );

        expect(prisma.shift.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                tenantId: 'tenant-1',
                locationId: 'loc-1',
                scheduleId: 'schedule-1',
                AND: expect.arrayContaining([
                    { endTime: { gt: new Date('2026-03-09T07:00:00.000Z') } },
                    { startTime: { lt: new Date('2026-03-10T07:00:00.000Z') } },
                ]),
            }),
            orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
            take: 3,
        }));
        expect(firstPage.data.map((shift) => shift.id)).toEqual(['shift-1', 'shift-2']);
        expect(firstPage.pagination).toEqual(expect.objectContaining({
            limit: 2,
            maxLimit: 200,
            returned: 2,
            hasMore: true,
            nextCursor: expect.any(String),
        }));
        expect(decodeBoundedListCursor(firstPage.pagination.nextCursor)).toEqual({
            timestamp: rows[1].startTime,
            id: 'shift-2',
        });

        prisma.shift.findMany.mockResolvedValueOnce([]);
        await controller.findAll(
            { user: { tenantId: 'tenant-1', role: 'MANAGER' } },
            'loc-1',
            'schedule-1',
            '2026-03-09T07:00:00.000Z',
            '2026-03-10T07:00:00.000Z',
            '2',
            firstPage.pagination.nextCursor ?? undefined,
        );
        expect(prisma.shift.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                AND: expect.arrayContaining([{
                    OR: [
                        { startTime: { gt: rows[1].startTime } },
                        { startTime: rows[1].startTime, id: { gt: 'shift-2' } },
                    ],
                }]),
            }),
            take: 3,
        }));
    });

    it('scopes staff shift list reads to their own assigned shifts', async () => {
        prisma.shift.findMany.mockResolvedValue([]);

        await controller.findAll({
            user: { tenantId: 'tenant-1', sub: 'staff-1', legacyRole: 'STAFF' },
        });

        expect(prisma.shift.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                tenantId: 'tenant-1',
                deletedAt: null,
                location: { is: { deletedAt: null } },
                userId: 'staff-1',
                schedule: { is: { status: 'PUBLISHED' } },
            }),
        }));
    });

    it('scopes refreshed staff shift reads using the current RBAC role label', async () => {
        prisma.shift.findMany.mockResolvedValue([]);

        await controller.findAll({
            user: { tenantId: 'tenant-1', sub: 'staff-1', role: 'Staff' },
        });

        expect(prisma.shift.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                userId: 'staff-1',
                schedule: { is: { status: 'PUBLISHED' } },
            }),
        }));
    });

    it('scopes staff single-shift reads to their own assigned shift', async () => {
        prisma.shift.findFirst.mockResolvedValue({ id: 'shift-1', userId: 'staff-1', breaks: [] });

        await controller.findOne('shift-1', {
            user: { tenantId: 'tenant-1', sub: 'staff-1', legacyRole: 'STAFF' },
        });

        expect(prisma.shift.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'shift-1',
                tenantId: 'tenant-1',
                deletedAt: null,
                location: { is: { deletedAt: null } },
                userId: 'staff-1',
                schedule: { is: { status: 'PUBLISHED' } },
            },
            include: { breaks: true },
        });
    });

    it('returns only manager/staff roster for planner consumers', async () => {
        prisma.user.findMany.mockResolvedValue([
            { id: 'u2', name: 'Test Manager', role: 'MANAGER' },
            { id: 'u3', name: 'Test Staff', role: 'STAFF' },
        ]);

        const result = await controller.staffRoster({ user: { tenantId: 'tenant-1' } });

        expect(prisma.user.findMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                deletedAt: null,
                suspendedAt: null,
                role: { in: ['MANAGER', 'STAFF'] },
            },
            orderBy: { id: 'asc' },
            take: 101,
            select: {
                id: true,
                name: true,
                role: true,
            },
        });
        expect(result.data).toEqual([
            { id: 'u2', name: 'Test Manager', role: 'MANAGER' },
            { id: 'u3', name: 'Test Staff', role: 'STAFF' },
        ]);
        expect(result.pagination).toEqual(expect.objectContaining({
            limit: 100,
            maxLimit: 200,
            returned: 2,
            hasMore: false,
            nextCursor: null,
        }));
    });

    it('continues bounded staff-roster pages without dropping planner users', async () => {
        const rows = [
            { id: 'u1', name: 'Zed', role: 'STAFF' },
            { id: 'u2', name: 'Amy', role: 'MANAGER' },
            { id: 'u3', name: 'Kai', role: 'STAFF' },
        ];
        prisma.user.findMany.mockResolvedValueOnce(rows);

        const firstPage = await controller.staffRoster(
            { user: { tenantId: 'tenant-1', role: 'MANAGER' } },
            '2',
        );

        expect(prisma.user.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
            orderBy: { id: 'asc' },
            take: 3,
        }));
        expect(firstPage.data.map((user) => user.id)).toEqual(['u1', 'u2']);
        expect(decodeBoundedListCursor(firstPage.pagination.nextCursor)).toEqual({
            timestamp: new Date(0),
            id: 'u2',
        });

        prisma.user.findMany.mockResolvedValueOnce([]);
        await controller.staffRoster(
            { user: { tenantId: 'tenant-1', role: 'MANAGER' } },
            '2',
            firstPage.pagination.nextCursor ?? undefined,
        );
        expect(prisma.user.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                AND: [{ id: { gt: 'u2' } }],
            }),
            take: 3,
        }));
    });

    it('scopes staff roster reads to the current staff member', async () => {
        prisma.user.findMany.mockResolvedValue([
            { id: 'staff-1', name: 'Test Staff', role: 'STAFF' },
        ]);

        const result = await controller.staffRoster({
            user: { tenantId: 'tenant-1', sub: 'staff-1', legacyRole: 'STAFF' },
        });

        expect(prisma.user.findMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                deletedAt: null,
                suspendedAt: null,
                role: { in: ['MANAGER', 'STAFF'] },
                id: 'staff-1',
            },
            orderBy: { id: 'asc' },
            take: 101,
            select: {
                id: true,
                name: true,
                role: true,
            },
        });
        expect(result.data).toEqual([
            { id: 'staff-1', name: 'Test Staff', role: 'STAFF' },
        ]);
    });
    it('requires an idempotency key before starting a bulk assignment transaction', async () => {
        await expect(controller.bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
            undefined,
        )).rejects.toThrow('Idempotency-Key header is required for bulk shift assignment');

        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns an all-no-op bulk assignment without entitlement, debit, writes, audit, or key reservation', async () => {
        const target = bulkTarget({ userId: 'user-1' });
        prisma.shift.findMany.mockResolvedValue([target]);
        const body = { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] };
        const req = { user: { tenantId: 'tenant-1', sub: 'manager-1' } };

        const first = await bulkAssign(body, req, 'bulk-fresh-no-op');
        const retry = await bulkAssign(body, req, 'bulk-fresh-no-op');

        expect(first).toEqual({ updated: 0 });
        expect(retry).toEqual(first);
        expect(featureAccessService.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(prisma.shift.findMany).toHaveBeenCalledTimes(4);
    });

    it('reuses a fresh bulk no-op key when later state makes the request distinct', async () => {
        const target = bulkTarget({ userId: 'user-1' });
        prisma.shift.findMany.mockResolvedValue([target]);
        const body = { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] };
        const req = { user: { tenantId: 'tenant-1', sub: 'manager-1' } };

        const noOp = await bulkAssign(body, req, 'bulk-reusable-no-op');
        expect(noOp).toEqual({ updated: 0 });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();

        target.userId = null;
        const applied = await bulkAssign(body, req, 'bulk-reusable-no-op');
        const storedOutcome = prisma.auditLog.create.mock.calls[0][0].data.newValue;
        prisma.auditLog.findFirst.mockResolvedValue({ newValue: storedOutcome });
        const replay = await bulkAssign(body, req, 'bulk-reusable-no-op');

        expect(applied).toEqual({ updated: 1 });
        expect(replay).toEqual(applied);
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.shift.updateMany).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
        expect(prisma.schedule.updateMany).toHaveBeenCalledOnce();
    });

    it('charges a mixed batch once and writes only assignments changed after locking', async () => {
        const unchanged = bulkTarget({
            id: 'shift-unchanged',
            userId: 'user-1',
            endTime: new Date('2026-03-10T19:00:00.000Z'),
        });
        const changed = bulkTarget({
            id: 'shift-changed',
            userId: null,
            startTime: new Date('2026-03-10T19:00:00.000Z'),
        });
        const entitlement = { enabled: true, source: 'credits', creditCost: 3 };
        featureAccessService.assertFeatureEnabledInTransaction.mockResolvedValue(entitlement);
        prisma.shift.findMany.mockResolvedValue([unchanged, changed]);

        const response = await bulkAssign({
            assignments: [
                { shiftId: 'shift-unchanged', userId: 'user-1' },
                { shiftId: 'shift-changed', userId: 'user-1' },
            ],
        }, { user: { tenantId: 'tenant-1', sub: 'manager-1' } }, 'bulk-mixed-cost-3');

        expect(response).toEqual({ updated: 1 });
        expect(prisma.shift.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            select: expect.objectContaining({ userId: true }),
        }));
        expect(featureAccessService.assertFeatureEnabledInTransaction).toHaveBeenCalledOnce();
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            entitlement,
            expect.stringMatching(/^Manual shift bulk assignment \([a-f0-9]{64}\)$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
        );
        expect(prisma.shift.updateMany).toHaveBeenCalledOnce();
        expect(prisma.shift.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'shift-changed',
                tenantId: 'tenant-1',
                scheduleId: 'schedule-1',
                userId: null,
                deletedAt: null,
            },
            data: { userId: 'user-1' },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('rejects a distinct bulk assignment at zero credit without debit, write, or audit', async () => {
        prisma.shift.findMany.mockResolvedValue([bulkTarget()]);
        featureAccessService.assertFeatureEnabledInTransaction.mockRejectedValue(
            new ForbiddenException('Feature requires 1 separately purchased usage credit.'),
        );

        await expect(bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1', sub: 'manager-1' } },
            'bulk-zero-credit-change',
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('charges and durably replays a bulk assignment without charging twice', async () => {
        const target = {
            id: 'shift-1',
            scheduleId: 'schedule-1',
            locationId: 'loc-1',
            userId: null,
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'DRAFT' },
        };
        const entitlement = { enabled: true, source: 'credits', creditCost: 3 };
        featureAccessService.assertFeatureEnabledInTransaction.mockResolvedValue(entitlement);
        prisma.shift.findMany.mockResolvedValue([target]);
        const body = { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] };
        const req = { user: { tenantId: 'tenant-1', sub: 'manager-1' } };

        const first = await bulkAssign(body, req, 'bulk-credit-cost-3');
        const storedOutcome = prisma.auditLog.create.mock.calls[0][0].data.newValue;
        prisma.auditLog.findFirst.mockResolvedValue({ newValue: storedOutcome });

        const replay = await bulkAssign(body, req, 'bulk-credit-cost-3');

        expect(first).toEqual({ updated: 1 });
        expect(replay).toEqual(first);
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            entitlement,
            expect.stringMatching(/^Manual shift bulk assignment \([a-f0-9]{64}\)$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
        );
        expect(prisma.shift.updateMany).toHaveBeenCalledOnce();
        expect(prisma.schedule.updateMany).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('rejects bulk idempotency-key request drift without charging', async () => {
        prisma.auditLog.findFirst.mockResolvedValue({
            newValue: {
                requestHash: 'different-request-hash',
                response: { updated: 1 },
            },
        });

        await expect(bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
            'bulk-reused-key',
        )).rejects.toThrow('different bulk shift assignment request');

        expect(featureAccessService.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('does not write an audit result when a bulk assignment update fails after billing is reserved', async () => {
        const target = {
            id: 'shift-1',
            scheduleId: 'schedule-1',
            locationId: 'loc-1',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
            schedule: { status: 'DRAFT' },
        };
        prisma.shift.findMany.mockResolvedValue([target]);
        prisma.shift.updateMany.mockResolvedValue({ count: 0 });

        await expect(bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
            'bulk-guarded-update-failure',
        )).rejects.toBeInstanceOf(ConflictException);

        expect(featureAccessService.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
});
