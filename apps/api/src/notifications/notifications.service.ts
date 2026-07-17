import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';
import type { Notification } from '@prisma/client';
import { MetricsService } from '../common/metrics.service';
import { runtimeErrorText } from '../common/runtime-error-diagnostic';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import {
    NotificationOutboxProcessor,
    type NotificationDeliverySummary,
    type NotificationOutboxEntry,
} from './notification-outbox.processor';

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
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(NotificationsService.name);
    private readonly redis: Redis | null;
    private readonly tenantDb: TenantPrismaService;
    private readonly outbox: NotificationOutboxProcessor;
    private metrics!: MetricsService;

    constructor(
        @Inject(ConfigService) private readonly configService: ConfigService,
        @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
        @Inject(TenantPrismaService) @Optional() tenantDb?: TenantPrismaService,
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
        this.outbox = new NotificationOutboxProcessor(this.tenantDb, {
            fanOut: (notification) => this.publishExisting(notification),
            recordOutcome: (status) => this.metrics.notificationOutboxDeliveriesTotal.inc({ status }),
            setDeadLetteredCount: (count) => this.metrics.notificationOutboxDeadLettered.set(count),
        });
    }

    onModuleInit(): void {
        this.metrics = this.moduleRef.get(MetricsService, { strict: false });
        this.outbox.start();
    }

    async onModuleDestroy(): Promise<void> {
        await this.outbox.stop();
        if (this.redis) {
            await this.redis.quit().catch(() => this.redis?.disconnect());
        }
    }

    async enqueueInTransaction(tx: any, entries: NotificationOutboxEntry[]): Promise<number> {
        return this.outbox.enqueueInTransaction(tx, entries);
    }

    async deliverPendingNow(tenantId: string, dedupeKeys: string[]): Promise<NotificationDeliverySummary> {
        return this.outbox.deliverPendingNow(tenantId, dedupeKeys);
    }
    /**
     * Persists a notification to the database and publishes an internal Redis fan-out event.
     */
    async send(tenantId: string, userId: string, type: NotificationType, title: string, body: string) {
        this.logger.log(`Handling notification type=${type}`);

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

        await this.publishExisting(notification);
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

    private async publishExisting(notification: Notification): Promise<void> {
        const channel = `notifications:user:${notification.userId}`;
        if (!this.redis) return;
        try {
            await this.redis.publish(channel, JSON.stringify(notification));
        } catch (error) {
            this.logger.warn(`Redis notification publish skipped ${runtimeErrorText(error)}`);
        }
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
