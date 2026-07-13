import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { TenantPrismaService } from '../database/tenant-prisma.service';

export enum NotificationType {
    INFO = 'INFO',
    SUCCESS = 'SUCCESS',
    WARNING = 'WARNING',
    ERROR = 'ERROR',
    SCHEDULE_PUBLISHED = 'SCHEDULE_PUBLISHED',
    SHIFT_ASSIGNED = 'SHIFT_ASSIGNED',
    SHIFT_CHANGED = 'SHIFT_CHANGED'
}

@Injectable()
export class NotificationsService {
    private readonly logger = new Logger(NotificationsService.name);
    private readonly redis: Redis | null;
    private readonly tenantDb: TenantPrismaService;

    constructor(
        private readonly configService: ConfigService,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
        const redisUrl = this.configService.get<string>('REDIS_URL');
        this.redis = redisUrl
            ? new Redis(redisUrl, {
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                enableReadyCheck: false,
            })
            : null;
    }

    /**
     * Persists a notification to the database and pushes it to the user's specific WebSocket channel via Redis Pub/Sub.
     */
    async send(tenantId: string, userId: string, type: NotificationType, title: string, body: string) {
        this.logger.log(`Handling ${type} notification to user ${userId}: ${title}`);

        // 1. Save to DB
        const notification = await this.tenantDb.withTenant(tenantId, (tx) => tx.notification.create({
            data: {
                tenantId,
                userId,
                type,
                title,
                body
            }
        }));

        // 2. Push via WebSocket using Redis Pub/Sub
        // We broadcast to a dedicated user channel. Websocket gateways will listen to this.
        const channel = `notifications:user:${userId}`;
        const payload = JSON.stringify(notification);

        if (!this.redis) return notification;

        try {
            await this.redis.publish(channel, payload);
        } catch (error) {
            this.logger.warn(`Redis publish skipped for ${channel}: ${error instanceof Error ? error.message : 'unknown_error'}`);
        }

        return notification;
    }

    async sendMany(entries: Array<{ tenantId: string; userId: string; type: NotificationType; title: string; body: string }>) {
        if (entries.length === 0) return [];
        return Promise.all(entries.map((entry) => this.send(entry.tenantId, entry.userId, entry.type, entry.title, entry.body)));
    }

    /**
     * Retrieves notifications for a user, newest first.
     */
    async getRecent(tenantId: string, userId: string, options?: { unreadOnly?: boolean; limit?: number }) {
        const unreadOnly = Boolean(options?.unreadOnly);
        const take = Math.min(Math.max(options?.limit ?? 20, 1), 100);

        return this.tenantDb.withTenant(tenantId, (tx) => tx.notification.findMany({
            where: {
                tenantId,
                userId,
                ...(unreadOnly ? { readAt: null } : {}),
            },
            orderBy: {
                createdAt: 'desc'
            },
            take,
        }));
    }

    async getUnreadCount(tenantId: string, userId: string) {
        return this.tenantDb.withTenant(tenantId, (tx) => tx.notification.count({
            where: {
                tenantId,
                userId,
                readAt: null,
            },
        }));
    }

    /**
     * Marks notifications as read.
     */
    async markAsRead(notificationIds: string[], tenantId: string, userId: string) {
        if (notificationIds.length === 0) return { updated: 0 };

        const result = await this.tenantDb.withTenant(tenantId, (tx) => tx.notification.updateMany({
            where: {
                id: { in: notificationIds },
                tenantId,
                userId,
                readAt: null,
            },
            data: {
                readAt: new Date()
            }
        }));

        return { updated: result.count };
    }

    async markAllAsRead(tenantId: string, userId: string) {
        await this.tenantDb.withTenant(tenantId, (tx) => tx.notification.updateMany({
            where: {
                tenantId,
                userId,
                readAt: null,
            },
            data: {
                readAt: new Date()
            }
        }));
    }

    async getFeed(tenantId: string, userId: string, options?: { unreadOnly?: boolean; limit?: number }) {
        const [notifications, unreadCount] = await Promise.all([
            this.getRecent(tenantId, userId, options),
            this.getUnreadCount(tenantId, userId),
        ]);

        return {
            notifications,
            unreadCount,
        };
    }
}
