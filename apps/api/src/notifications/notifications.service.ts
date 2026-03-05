import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@lunchlineup/db';
import Redis from 'ioredis';

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
    private redis: Redis;

    constructor(
        private readonly configService: ConfigService,
        private readonly prisma: PrismaClient
    ) {
        const redisUrl = this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';
        this.redis = new Redis(redisUrl);
    }

    /**
     * Persists a notification to the database and pushes it to the user's specific WebSocket channel via Redis Pub/Sub.
     */
    async send(tenantId: string, userId: string, type: NotificationType, title: string, body: string) {
        this.logger.log(`Handling ${type} notification to user ${userId}: ${title}`);

        // 1. Save to DB
        const notification = await this.prisma.notification.create({
            data: {
                tenantId,
                userId,
                type,
                title,
                body
            }
        });

        // 2. Push via WebSocket using Redis Pub/Sub
        // We broadcast to a dedicated user channel. Websocket gateways will listen to this.
        const channel = `notifications:user:${userId}`;
        const payload = JSON.stringify(notification);

        await this.redis.publish(channel, payload);
    }

    /**
     * Retrieves recent unread notifications for a given user.
     */
    async getRecent(userId: string) {
        return this.prisma.notification.findMany({
            where: {
                userId,
                readAt: null
            },
            orderBy: {
                createdAt: 'desc'
            },
            take: 20
        });
    }

    /**
     * Marks notifications as read.
     */
    async markAsRead(notificationIds: string[], userId: string) {
        await this.prisma.notification.updateMany({
            where: {
                id: { in: notificationIds },
                userId
            },
            data: {
                readAt: new Date()
            }
        });
    }
}
