import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShiftsController } from './shifts.controller';
import { NotificationType } from '../notifications/notifications.service';

describe('ShiftsController notifications', () => {
    let controller: ShiftsController;
    let prisma: any;
    let notificationsService: any;

    beforeEach(() => {
        notificationsService = {
            send: vi.fn().mockResolvedValue(undefined),
            sendMany: vi.fn().mockResolvedValue(undefined),
        };
        controller = new ShiftsController(notificationsService);
        prisma = {
            shift: {
                create: vi.fn(),
                findFirst: vi.fn(),
                updateMany: vi.fn(),
                findMany: vi.fn(),
            },
            $transaction: vi.fn().mockResolvedValue(undefined),
        };
        (controller as any).prisma = prisma;
    });

    it('sends SHIFT_ASSIGNED when creating an assigned shift', async () => {
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

        expect(notificationsService.send).toHaveBeenCalledWith(
            'tenant-1',
            'user-1',
            NotificationType.SHIFT_ASSIGNED,
            'New shift assigned',
            'You were assigned a shift (2026-03-10 17:00 - 2026-03-10 21:00 UTC).',
        );
    });

    it('sends SHIFT_CHANGED when an assigned shift details change', async () => {
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

        expect(notificationsService.send).toHaveBeenCalledWith(
            'tenant-1',
            'user-1',
            NotificationType.SHIFT_CHANGED,
            'Shift updated',
            'Your shift was updated (2026-03-10 18:00 - 2026-03-10 22:00 UTC).',
        );
    });
});
