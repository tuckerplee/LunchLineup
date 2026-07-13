import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ShiftsController } from './shifts.controller';
import { TenantPrismaService } from '../database/tenant-prisma.service';

describe('ShiftsController', () => {
    let controller: ShiftsController;
    let prisma: any;
    let featureAccessService: any;
    let activeLocation: { id: string; timezone: string } | null;

    beforeEach(() => {
        featureAccessService = {
            assertFeatureEnabled: vi.fn().mockResolvedValue(undefined),
        };
        activeLocation = { id: 'loc-1', timezone: 'America/New_York' };
        prisma = {
            $queryRaw: vi.fn(async (query: any) => {
                const sql = Array.isArray(query) ? query.join(' ') : String(query);
                if (sql.includes('FROM "Location"') && sql.includes('FOR UPDATE')) {
                    return activeLocation ? [activeLocation] : [];
                }
                if (sql.includes('FROM "Schedule"') && sql.includes('FOR UPDATE')) {
                    return [{ id: 'schedule-1', status: 'DRAFT' }];
                }
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
            schedule: {
                findFirst: vi.fn(),
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
    });

    it('blocks shift creation when scheduling is not entitled', async () => {
        featureAccessService.assertFeatureEnabled.mockRejectedValue(new ForbiddenException('Upgrade plan or add credits to enable'));

        await expect(controller.create(
            {
                locationId: 'loc-1',
                userId: 'user-1',
                startTime: '2026-03-10T17:00:00.000Z',
                endTime: '2026-03-10T21:00:00.000Z',
            },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(featureAccessService.assertFeatureEnabled).toHaveBeenCalledWith('tenant-1', 'scheduling');
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.shift.create).not.toHaveBeenCalled();
    });

    it('blocks shift updates, deletes, and bulk assignment when scheduling is not entitled', async () => {
        featureAccessService.assertFeatureEnabled.mockRejectedValue(new ForbiddenException('Upgrade plan or add credits to enable'));

        await expect(controller.update(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toBeInstanceOf(ForbiddenException);
        await expect(controller.remove('shift-1', { user: { tenantId: 'tenant-1' } }))
            .rejects
            .toBeInstanceOf(ForbiddenException);
        await expect(controller.bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(featureAccessService.assertFeatureEnabled).toHaveBeenCalledTimes(3);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('creates an assigned draft shift without sending an assignment notification', async () => {
        prisma.shift.create.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            startTime: new Date('2026-03-10T17:00:00.000Z'),
            endTime: new Date('2026-03-10T21:00:00.000Z'),
        });

        await controller.create(
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
        expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(prisma.shift.create.mock.invocationCallOrder[0]);
    });

    it('does not create after a concurrent location deletion wins the row lock', async () => {
        activeLocation = null;

        await expect(controller.create(
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

        await controller.create(
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

        await expect(controller.create(
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

        await expect(controller.create(
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

        await expect(controller.create(
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

        await expect(controller.create(
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

    it('updates an assigned draft shift without sending a change notification', async () => {
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

        await controller.update(
            'shift-1',
            { startTime: '2026-03-10T18:00:00.000Z', endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        );

        expect(prisma.shift.updateMany).toHaveBeenCalledOnce();
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

        await controller.create(
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

        await controller.create(
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

        await expect(controller.create(
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

        await expect(controller.create(
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
        await expect(controller.create(
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
        await expect(controller.create(
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
        await expect(controller.create(
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

        await expect(controller.create(
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

        await expect(controller.update(
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

        await expect(controller.update(
            'shift-1',
            { startTime: '2026-03-10T18:00:00.000Z', endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('User already has a shift that overlaps this time window.');

        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
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

        await expect(controller.update(
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

        await expect(controller.update(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published schedules are locked');

        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
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

        await expect(controller.bulkAssign(
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

        await expect(controller.bulkAssign(
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
                startTime: new Date('2026-03-10T17:00:00.000Z'),
                endTime: new Date('2026-03-10T21:00:00.000Z'),
                schedule: { status: 'PUBLISHED' },
            },
        ]);

        await expect(controller.bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published schedules are locked');

        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
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

        await expect(controller.bulkAssign(
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

        await expect(controller.bulkAssign(
            { assignments: [{ shiftId: 'shift-1', userId: 'user-1' }] },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toBeInstanceOf(ConflictException);

        expect(prisma.shift.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'shift-1',
                tenantId: 'tenant-1',
                scheduleId: 'schedule-1',
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

        await expect(controller.update(
            'shift-1',
            { endTime: '2026-03-10T22:00:00.000Z' },
            { user: { tenantId: 'tenant-1' } },
        )).rejects.toThrow('Published schedules are locked');
        expect(prisma.shift.updateMany).not.toHaveBeenCalled();
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
                role: { in: ['MANAGER', 'STAFF'] },
            },
            orderBy: { name: 'asc' },
            select: {
                id: true,
                name: true,
                role: true,
            },
        });
        expect(result).toEqual({
            data: [
                { id: 'u2', name: 'Test Manager', role: 'MANAGER' },
                { id: 'u3', name: 'Test Staff', role: 'STAFF' },
            ],
        });
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
                role: { in: ['MANAGER', 'STAFF'] },
                id: 'staff-1',
            },
            orderBy: { name: 'asc' },
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
});
