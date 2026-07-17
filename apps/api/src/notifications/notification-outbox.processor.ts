import { Logger } from '@nestjs/common';
import { Prisma, type Notification, type NotificationType } from '@prisma/client';
import { runtimeErrorText } from '../common/runtime-error-diagnostic';
import { ACTIVE_SCHEDULABLE_USER_FILTER } from '../common/schedulable-user';
import { TenantPrismaService } from '../database/tenant-prisma.service';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_LEASE_MS = 30_000;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 250;
const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_ATTEMPTS = 100;
const MAX_ERROR_LENGTH = 1_000;

export type NotificationOutboxEntry = {
    tenantId: string;
    userId: string;
    dedupeKey: string;
    type: NotificationType;
    title: string;
    body: string;
};

export type NotificationDeliverySummary = {
    status: 'DELIVERED' | 'NOT_REQUIRED' | 'PENDING' | 'PARTIAL' | 'FAILED';
    delivered: number;
    pending: number;
    failed: number;
};

type ClaimedNotificationIntent = {
    id: string;
    tenantId: string;
    userId: string;
    dedupeKey: string;
    notificationType: NotificationType;
    title: string;
    body: string;
    attempts: number;
    createdAt: Date | string;
};

export type NotificationDeliveryMetricStatus = 'delivered' | 'retrying' | 'dead_lettered';

type NotificationOutboxProcessorOptions = {
    pollIntervalMs?: number;
    leaseMs?: number;
    batchSize?: number;
    maxAttempts?: number;
    fanOut?: (notification: Notification) => Promise<void>;
    recordOutcome?: (status: NotificationDeliveryMetricStatus) => void;
    setDeadLetteredCount?: (count: number) => void;
};

export class NotificationOutboxProcessor {
    private readonly logger = new Logger(NotificationOutboxProcessor.name);
    private readonly pollIntervalMs: number;
    private readonly leaseMs: number;
    private readonly batchSize: number;
    private readonly maxAttempts: number;
    private readonly fanOut?: (notification: Notification) => Promise<void>;
    private readonly recordOutcome?: (status: NotificationDeliveryMetricStatus) => void;
    private readonly setDeadLetteredCount?: (count: number) => void;
    private timer?: NodeJS.Timeout;
    private activeSweep?: Promise<void>;

    constructor(
        private readonly tenantDb: TenantPrismaService,
        options: NotificationOutboxProcessorOptions = {},
    ) {
        this.pollIntervalMs = options.pollIntervalMs
            ?? this.boundedInteger(
                process.env.NOTIFICATION_OUTBOX_POLL_INTERVAL_MS,
                DEFAULT_POLL_INTERVAL_MS,
                MIN_POLL_INTERVAL_MS,
                MAX_POLL_INTERVAL_MS,
            );
        this.leaseMs = options.leaseMs
            ?? this.boundedInteger(
                process.env.NOTIFICATION_OUTBOX_LEASE_MS,
                DEFAULT_LEASE_MS,
                MIN_LEASE_MS,
                MAX_LEASE_MS,
            );
        this.batchSize = options.batchSize
            ?? this.boundedInteger(
                process.env.NOTIFICATION_OUTBOX_BATCH_SIZE,
                DEFAULT_BATCH_SIZE,
                1,
                MAX_BATCH_SIZE,
            );
        this.maxAttempts = options.maxAttempts
            ?? this.boundedInteger(
                process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS,
                DEFAULT_MAX_ATTEMPTS,
                1,
                MAX_ATTEMPTS,
            );
        this.fanOut = options.fanOut;
        this.recordOutcome = options.recordOutcome;
        this.setDeadLetteredCount = options.setDeadLetteredCount;
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.kick(), this.pollIntervalMs);
        this.timer.unref();
        this.kick();
    }

    async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await this.activeSweep;
    }

    async enqueueInTransaction(tx: any, entries: NotificationOutboxEntry[]): Promise<number> {
        if (entries.length === 0) return 0;
        const result = await tx.notificationOutbox.createMany({
            data: entries.map((entry) => ({
                tenantId: entry.tenantId,
                userId: entry.userId,
                dedupeKey: entry.dedupeKey,
                notificationType: entry.type,
                title: entry.title,
                body: entry.body,
            })),
            skipDuplicates: true,
        });
        return result.count;
    }

    async deliverPendingNow(tenantId: string, dedupeKeys: string[]): Promise<NotificationDeliverySummary> {
        const keys = Array.from(new Set(dedupeKeys));
        if (keys.length === 0) {
            return { status: 'NOT_REQUIRED', delivered: 0, pending: 0, failed: 0 };
        }

        try {
            const claimed = await this.claim(tenantId, keys);
            await Promise.all(claimed.map((intent) => this.deliver(intent)));
            return await this.summarize(tenantId, keys);
        } catch (error) {
            this.logger.error(
                `Immediate notification outbox delivery failed ${this.errorMessage(error)}`,
            );
            return { status: 'PENDING', delivered: 0, pending: keys.length, failed: 0 };
        }
    }

    private kick(): void {
        if (this.activeSweep) return;
        this.activeSweep = this.sweep()
            .catch((error) => {
                this.logger.error(`Notification outbox sweep failed: ${this.errorMessage(error)}`);
            })
            .finally(() => {
                this.activeSweep = undefined;
            });
    }

    private async sweep(): Promise<void> {
        const claimed = await this.claim();
        await Promise.all(claimed.map((intent) => this.deliver(intent)));
        await this.refreshDeadLetteredCount();
    }

    private async claim(tenantId?: string, dedupeKeys: string[] = []): Promise<ClaimedNotificationIntent[]> {
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + this.leaseMs);
        const tenantFilter = tenantId
            ? Prisma.sql`AND outbox."tenantId" = ${tenantId}`
            : Prisma.empty;
        const dedupeFilter = dedupeKeys.length > 0
            ? Prisma.sql`AND outbox."dedupeKey" IN (${Prisma.join(dedupeKeys)})`
            : Prisma.empty;
        const query = async (tx: any): Promise<ClaimedNotificationIntent[]> => tx.$queryRaw(Prisma.sql`
            WITH candidates AS (
                SELECT outbox."id"
                FROM "NotificationOutbox" AS outbox
                WHERE (
                    (
                        outbox."status" IN ('PENDING', 'FAILED')
                        AND outbox."nextAttemptAt" <= ${now}
                    )
                    OR (
                        outbox."status" = 'PROCESSING'
                        AND outbox."leaseUntil" <= ${now}
                    )
                )
                ${tenantFilter}
                ${dedupeFilter}
                ORDER BY COALESCE(outbox."nextAttemptAt", outbox."leaseUntil", outbox."createdAt") ASC,
                         outbox."createdAt" ASC,
                         outbox."id" ASC
                FOR UPDATE SKIP LOCKED
                LIMIT ${tenantId ? Math.min(dedupeKeys.length || this.batchSize, this.batchSize) : this.batchSize}
            )
            UPDATE "NotificationOutbox" AS outbox
            SET
                "status" = 'PROCESSING',
                "attempts" = outbox."attempts" + 1,
                "leaseUntil" = ${leaseUntil},
                "lastError" = NULL,
                "updatedAt" = ${now}
            FROM candidates
            WHERE outbox."id" = candidates."id"
            RETURNING
                outbox."id",
                outbox."tenantId",
                outbox."userId",
                outbox."dedupeKey",
                outbox."notificationType",
                outbox."title",
                outbox."body",
                outbox."attempts",
                outbox."createdAt"
        `);

        return tenantId
            ? this.tenantDb.withTenant(tenantId, query)
            : this.tenantDb.withPlatformAdmin(query);
    }

    private async deliver(intent: ClaimedNotificationIntent): Promise<void> {
        try {
            const notification = await this.tenantDb.withTenant(intent.tenantId, async (tx: any) => {
                const [tenant, user] = await Promise.all([
                    tx.tenant.findFirst({
                        where: { id: intent.tenantId, deletedAt: null },
                        select: { status: true },
                    }),
                    tx.user.findFirst({
                        where: {
                            id: intent.userId,
                            tenantId: intent.tenantId,
                            ...(intent.notificationType === 'SCHEDULE_PUBLISHED'
                                ? ACTIVE_SCHEDULABLE_USER_FILTER
                                : { deletedAt: null }),
                        },
                        select: { id: true },
                    }),
                ]);

                if (!tenant || tenant.status === 'PURGED' || !user) {
                    const terminalized = await tx.notificationOutbox.updateMany({
                        where: {
                            id: intent.id,
                            tenantId: intent.tenantId,
                            status: 'PROCESSING',
                            attempts: intent.attempts,
                        },
                        data: {
                            status: 'DEAD_LETTERED',
                            nextAttemptAt: null,
                            leaseUntil: null,
                            title: '',
                            body: '',
                            lastError: 'Tenant or recipient is no longer eligible for notification delivery',
                        },
                    });
                    if (terminalized.count === 1) {
                        this.recordOutcome?.('dead_lettered');
                        this.logger.error(
                            'Notification outbox terminal failure reason=recipient_unavailable',
                        );
                    }
                    return null;
                }

                const durable = await tx.notification.upsert({
                    where: { id: intent.id },
                    create: {
                        id: intent.id,
                        tenantId: intent.tenantId,
                        userId: intent.userId,
                        type: intent.notificationType,
                        title: intent.title,
                        body: intent.body,
                    },
                    update: {},
                });
                const transitioned = await tx.notificationOutbox.updateMany({
                    where: {
                        id: intent.id,
                        tenantId: intent.tenantId,
                        status: 'PROCESSING',
                        attempts: intent.attempts,
                    },
                    data: {
                        status: 'DELIVERED',
                        deliveredAt: new Date(),
                        nextAttemptAt: null,
                        leaseUntil: null,
                        title: '',
                        body: '',
                        lastError: null,
                    },
                });
                if (transitioned.count !== 1) {
                    throw new Error('Notification outbox lease was lost before delivery committed');
                }
                return durable as Notification;
            });

            if (notification) {
                this.recordOutcome?.('delivered');
            }
            if (notification && this.fanOut) {
                await this.fanOut(notification).catch((error) => {
                    this.logger.warn(
                        `Notification Redis fan-out skipped ${this.errorMessage(error)}`,
                    );
                });
            }
        } catch (error) {
            await this.markFailed(intent, error);
        }
    }

    private async markFailed(intent: ClaimedNotificationIntent, error: unknown): Promise<void> {
        const terminal = intent.attempts >= this.maxAttempts;
        const message = this.errorMessage(error);
        const nextAttemptAt = terminal
            ? null
            : new Date(Date.now() + this.retryDelayMs(intent.attempts));

        await this.tenantDb.withTenant(intent.tenantId, async (tx: any) => {
            const transitioned = await tx.notificationOutbox.updateMany({
                where: {
                    id: intent.id,
                    tenantId: intent.tenantId,
                    status: 'PROCESSING',
                    attempts: intent.attempts,
                },
                data: {
                    status: terminal ? 'DEAD_LETTERED' : 'FAILED',
                    nextAttemptAt,
                    leaseUntil: null,
                    ...(terminal ? { title: '', body: '' } : {}),
                    lastError: message,
                },
            });
            if (transitioned.count === 1) {
                this.recordOutcome?.(terminal ? 'dead_lettered' : 'retrying');
            }
            if (terminal && transitioned.count === 1) {
                this.logger.error(
                    `Notification outbox terminal failure attempts=${intent.attempts} ${message}`,
                );
            }
        });
    }

    private async refreshDeadLetteredCount(): Promise<void> {
        if (!this.setDeadLetteredCount) return;
        const count = await this.tenantDb.withPlatformAdmin((tx) => tx.notificationOutbox.count({
            where: { status: 'DEAD_LETTERED' },
        }));
        this.setDeadLetteredCount(count);
    }

    private async summarize(tenantId: string, dedupeKeys: string[]): Promise<NotificationDeliverySummary> {
        const rows = await this.tenantDb.withTenant<Array<{ dedupeKey: string; status: string }>>(tenantId, (tx: any) => tx.notificationOutbox.findMany({
            where: { tenantId, dedupeKey: { in: dedupeKeys } },
            select: { dedupeKey: true, status: true },
        }));
        const delivered = rows.filter((row: { status: string }) => row.status === 'DELIVERED').length;
        const failed = rows.filter((row: { status: string }) => row.status === 'DEAD_LETTERED').length;
        const pending = Math.max(0, dedupeKeys.length - delivered - failed);
        return {
            status: delivered === dedupeKeys.length
                ? 'DELIVERED'
                : failed === dedupeKeys.length
                    ? 'FAILED'
                    : delivered === 0 && failed === 0
                        ? 'PENDING'
                        : 'PARTIAL',
            delivered,
            pending,
            failed,
        };
    }

    private retryDelayMs(attempt: number): number {
        return Math.min(60_000, 1_000 * (2 ** Math.max(0, Math.min(attempt - 1, 6))));
    }

    private errorMessage(error: unknown): string {
        return runtimeErrorText(error).slice(0, MAX_ERROR_LENGTH);
    }

    private boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(minimum, Math.min(maximum, parsed));
    }
}
