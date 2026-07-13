import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationType, NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
    let service: NotificationsService;
    let tx: any;
    let tenantDb: { withTenant: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        tx = {
            notification: {
                create: vi.fn(),
                findMany: vi.fn(),
                count: vi.fn(),
                updateMany: vi.fn(),
            },
        };
        tenantDb = {
            withTenant: vi.fn(async (_tenantId: string, operation: (tx: any) => Promise<unknown>) => operation(tx)),
        };
        service = new NotificationsService({ get: vi.fn().mockReturnValue(undefined) } as any, tenantDb as any);
    });

    it('creates notifications inside tenant context', async () => {
        tx.notification.create.mockResolvedValue({
            id: 'notification-1',
            tenantId: 'tenant-1',
            userId: 'user-1',
            type: NotificationType.SHIFT_ASSIGNED,
            title: 'Shift assigned',
            body: 'You have a new shift.',
        });

        const result = await service.send(
            'tenant-1',
            'user-1',
            NotificationType.SHIFT_ASSIGNED,
            'Shift assigned',
            'You have a new shift.',
        );

        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
        expect(tx.notification.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'user-1',
                type: NotificationType.SHIFT_ASSIGNED,
                title: 'Shift assigned',
                body: 'You have a new shift.',
            },
        });
        expect(result.id).toBe('notification-1');
    });

    it('reads and counts notifications inside tenant context', async () => {
        tx.notification.findMany.mockResolvedValue([{ id: 'notification-1' }]);
        tx.notification.count.mockResolvedValue(1);

        const result = await service.getFeed('tenant-1', 'user-1', { unreadOnly: true, limit: 200 });

        expect(tenantDb.withTenant).toHaveBeenCalledTimes(2);
        expect(tenantDb.withTenant).toHaveBeenNthCalledWith(1, 'tenant-1', expect.any(Function));
        expect(tenantDb.withTenant).toHaveBeenNthCalledWith(2, 'tenant-1', expect.any(Function));
        expect(tx.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                tenantId: 'tenant-1',
                userId: 'user-1',
                readAt: null,
            },
            take: 100,
        }));
        expect(tx.notification.count).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                userId: 'user-1',
                readAt: null,
            },
        });
        expect(result.unreadCount).toBe(1);
    });

    it('marks tenant-owned notifications as read inside tenant context', async () => {
        tx.notification.updateMany.mockResolvedValue({ count: 2 });

        const result = await service.markAsRead(['notification-1', 'notification-2'], 'tenant-1', 'user-1');

        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
        expect(tx.notification.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                id: { in: ['notification-1', 'notification-2'] },
                tenantId: 'tenant-1',
                userId: 'user-1',
                readAt: null,
            },
        }));
        expect(result).toEqual({ updated: 2 });
    });
});
