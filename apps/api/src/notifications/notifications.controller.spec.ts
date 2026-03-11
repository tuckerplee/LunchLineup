import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsController } from './notifications.controller';

describe('NotificationsController', () => {
    let controller: NotificationsController;
    let service: any;

    beforeEach(() => {
        service = {
            getFeed: vi.fn(),
            markAsRead: vi.fn(),
            getUnreadCount: vi.fn(),
            markAllAsRead: vi.fn(),
        };
        controller = new NotificationsController(service);
    });

    it('lists notification feed with unread count', async () => {
        service.getFeed.mockResolvedValue({
            notifications: [{ id: 'n1', title: 'Shift updated' }],
            unreadCount: 3,
        });

        const result = await controller.list(
            { user: { tenantId: 'tenant-1', sub: 'user-1' } },
            'all',
            '20',
        );

        expect(service.getFeed).toHaveBeenCalledWith('tenant-1', 'user-1', { unreadOnly: false, limit: 20 });
        expect(result).toEqual({
            data: [{ id: 'n1', title: 'Shift updated' }],
            unreadCount: 3,
        });
    });

    it('marks selected notifications as read', async () => {
        service.markAsRead.mockResolvedValue({ updated: 2 });
        service.getUnreadCount.mockResolvedValue(1);

        const result = await controller.markRead(
            { user: { tenantId: 'tenant-1', sub: 'user-1' } },
            { ids: ['n1', 'n2'] },
        );

        expect(service.markAsRead).toHaveBeenCalledWith(['n1', 'n2'], 'tenant-1', 'user-1');
        expect(result).toEqual({ updated: 2, unreadCount: 1 });
    });

    it('marks all notifications as read', async () => {
        const result = await controller.markAllRead({ user: { tenantId: 'tenant-1', sub: 'user-1' } });

        expect(service.markAllAsRead).toHaveBeenCalledWith('tenant-1', 'user-1');
        expect(result).toEqual({ success: true, unreadCount: 0 });
    });
});
