import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SchedulesController } from './schedules.controller';
import { NotificationType } from '../notifications/notifications.service';

describe('SchedulesController', () => {
    let controller: SchedulesController;
    let prisma: any;
    let notificationsService: any;

    beforeEach(() => {
        notificationsService = {
            sendMany: vi.fn().mockResolvedValue([]),
        };
        controller = new SchedulesController(notificationsService);
        prisma = {
            schedule: {
                updateMany: vi.fn(),
                findFirst: vi.fn(),
            },
            shift: {
                findMany: vi.fn(),
            },
        };
        (controller as any).prisma = prisma;
    });

    it('publishes draft schedule and notifies assigned users', async () => {
        prisma.schedule.updateMany.mockResolvedValue({ count: 1 });
        prisma.schedule.findFirst.mockResolvedValue({
            id: 'sch-1',
            startDate: new Date('2026-03-10T00:00:00.000Z'),
            endDate: new Date('2026-03-16T00:00:00.000Z'),
            location: { name: 'Downtown Bistro' },
        });
        prisma.shift.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);

        const result = await controller.publish('sch-1', { user: { tenantId: 'tenant-1' } });

        expect(prisma.schedule.updateMany).toHaveBeenCalled();
        expect(notificationsService.sendMany).toHaveBeenCalledWith([
            {
                tenantId: 'tenant-1',
                userId: 'u1',
                type: NotificationType.SCHEDULE_PUBLISHED,
                title: 'Schedule published',
                body: 'Downtown Bistro: 2026-03-10 to 2026-03-16',
            },
            {
                tenantId: 'tenant-1',
                userId: 'u2',
                type: NotificationType.SCHEDULE_PUBLISHED,
                title: 'Schedule published',
                body: 'Downtown Bistro: 2026-03-10 to 2026-03-16',
            },
        ]);
        expect(result.status).toBe('PUBLISHED');
    });
});
