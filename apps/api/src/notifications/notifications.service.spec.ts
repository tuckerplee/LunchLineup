import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationType, NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
    let service: NotificationsService;
    let tx: any;
    let tenantDb: { withTenant: ReturnType<typeof vi.fn> };
    let metrics: any;
    let moduleRef: any;
    let schedulePublishedEmail: any;

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
        metrics = {
            notificationOutboxDeliveriesTotal: { inc: vi.fn() },
            notificationOutboxDeadLettered: { set: vi.fn() },
        };
        moduleRef = { get: vi.fn().mockReturnValue(metrics) };
        schedulePublishedEmail = { send: vi.fn().mockResolvedValue('accepted') };
        service = new NotificationsService(
            { get: vi.fn().mockReturnValue(undefined) } as any,
            moduleRef,
            schedulePublishedEmail,
            tenantDb as any,
        );
    });

    it('starts and stops durable outbox recovery with the API lifecycle', async () => {
        const start = vi.spyOn((service as any).outbox, 'start').mockImplementation(() => undefined);
        const stop = vi.spyOn((service as any).outbox, 'stop').mockResolvedValue(undefined);

        service.onModuleInit();
        await service.onModuleDestroy();

        expect(moduleRef.get).toHaveBeenCalledWith(expect.any(Function), { strict: false });
        expect(start).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledOnce();
    });

    it('delegates schedule publication email with only outbox-owned delivery fields', async () => {
        await (service as any).outbox.deliverExternal({
            id: 'outbox-1',
            tenantId: 'tenant-1',
            userId: 'user-1',
            dedupeKey: 'schedule-published:schedule-1:revision-1:user-1',
            notificationType: NotificationType.SCHEDULE_PUBLISHED,
            title: 'Schedule published',
            body: 'Downtown: Jul 14 to Jul 20',
            attempts: 1,
            createdAt: new Date(),
        }, 'staff@example.test');

        expect(schedulePublishedEmail.send).toHaveBeenCalledWith({
            outboxId: 'outbox-1',
            recipientEmail: 'staff@example.test',
            title: 'Schedule published',
            body: 'Downtown: Jul 14 to Jul 20',
        });
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

        const log = vi.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
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
        expect(JSON.stringify(log.mock.calls)).not.toContain('Shift assigned');
        expect(JSON.stringify(log.mock.calls)).not.toContain('You have a new shift.');
    });

    it('redacts Redis channels, notification payloads, and error text from publish failures', async () => {
        const warn = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        (service as any).redis = {
            publish: vi.fn().mockRejectedValue(new Error('redis://secret@host notification body')),
        };

        await (service as any).publishExisting({
            id: 'notification-1',
            tenantId: 'tenant-1',
            userId: 'user-1',
            type: NotificationType.SHIFT_ASSIGNED,
            title: 'Private title',
            body: 'Private body',
        });

        const logs = JSON.stringify(warn.mock.calls);
        expect(logs).toContain('category=unknown class=Error');
        expect(logs).not.toContain('user-1');
        expect(logs).not.toContain('Private title');
        expect(logs).not.toContain('secret@host');
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
