import { pilotProducersClosed, requireOrdinaryProducer } from '../common/pilot-producer-admission';
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
    failureCount: number;
    createdAt: Date | string;
    leaseUntil: Date | string;
};

export type NotificationDeliveryMetricStatus = 'delivered' | 'retrying' | 'dead_lettered';

export type NotificationHandoffWindow = {
    signal: AbortSignal;
    assertNewHandoff: () => void;
};
export type PreparedNotificationHandoff = {
    recipientEmail: string | null;
    send: (recipientEmail: string | null, window: NotificationHandoffWindow) => Promise<unknown>;
};
class NotificationOwnershipLost extends Error {}
class NotificationPostponed extends Error {}
const DELIVERY_TRANSACTION_OPTIONS = { maxWait: 2_000, timeout: 40_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted } as const;
const BOOKKEEPING_HEADROOM_MS = 8_000;

type NotificationOutboxProcessorOptions = {
    pollIntervalMs?: number;
    leaseMs?: number;
    batchSize?: number;
    maxAttempts?: number;
    fanOut?: (notification: Notification) => Promise<void>;
    deliverExternal?: (intent: ClaimedNotificationIntent, recipientEmail: string | null) => Promise<unknown>;
    prepareExternal?: (intent: ClaimedNotificationIntent, recipientEmail: string | null, window: NotificationHandoffWindow) => Promise<PreparedNotificationHandoff>;
    externalTimeoutMs?: number;
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
    private readonly deliverExternal?: (intent: ClaimedNotificationIntent, recipientEmail: string | null) => Promise<unknown>;
    private readonly prepareExternal?: NotificationOutboxProcessorOptions['prepareExternal'];
    private readonly externalTimeoutMs: number;
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
        this.deliverExternal = options.deliverExternal;
        this.prepareExternal = options.prepareExternal;
        this.externalTimeoutMs = options.externalTimeoutMs ?? 30_000;
        if (!Number.isSafeInteger(this.externalTimeoutMs) || this.externalTimeoutMs < 1_000 || this.externalTimeoutMs > 30_000) {
            throw new Error('Notification handoff deadline must be between 1000 and 30000ms');
        }
        this.recordOutcome = options.recordOutcome;
        this.setDeadLetteredCount = options.setDeadLetteredCount;
    }

    start(): void {
        if (pilotProducersClosed()) return;
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
        requireOrdinaryProducer('notification enqueue');
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
        requireOrdinaryProducer('notification immediate delivery');
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
        requireOrdinaryProducer('notification sweep');
        const claimed = await this.claim();
        await Promise.all(claimed.map((intent) => this.deliver(intent)));
        await this.refreshDeadLetteredCount();
    }

    private async claim(tenantId?: string, dedupeKeys: string[] = []): Promise<ClaimedNotificationIntent[]> {
        requireOrdinaryProducer('notification claim');
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
                outbox."failureCount",
                outbox."createdAt",
                outbox."leaseUntil"
        `);

        return tenantId
            ? this.tenantDb.withTenant(tenantId, query)
            : this.tenantDb.withPlatformAdmin(query);
    }

    private async deliver(intent: ClaimedNotificationIntent): Promise<void> {
        const started = performance.now();
        const controller = new AbortController();
        const deadlineError = new Error('Schedule publication email provider deadline exceeded');
        const assertNewHandoff = () => {
            if (controller.signal.aborted || performance.now() - started >= this.externalTimeoutMs) {
                if (!controller.signal.aborted) controller.abort(deadlineError);
                throw deadlineError;
            }
        };
        const assertBookkeeping = () => {
            if (performance.now() - started >= this.externalTimeoutMs + BOOKKEEPING_HEADROOM_MS) {
                throw new NotificationOwnershipLost('Notification delivery bookkeeping deadline exceeded');
            }
        };
        const window = { signal: controller.signal, assertNewHandoff };
        const timer = setTimeout(() => controller.abort(deadlineError), this.externalTimeoutMs);
        const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
            assertNewHandoff();
            let rejectAbort!: () => void;
            const aborted = new Promise<never>((_resolve, reject) => {
                rejectAbort = () => reject(deadlineError);
                controller.signal.addEventListener('abort', rejectAbort, { once: true });
            });
            try { return await Promise.race([operation(), aborted]); }
            finally { controller.signal.removeEventListener('abort', rejectAbort); }
        };
        let prepared: PreparedNotificationHandoff | undefined;
        let preparationError: unknown;
        let preparationFailed = false;
        let candidateEmail: string | null | undefined;
        try {
            if (intent.notificationType === 'SCHEDULE_PUBLISHED' && (this.prepareExternal || this.deliverExternal)) {
                try {
                    const candidate = await bounded(() => this.tenantDb.withTenant(intent.tenantId, (tx) => tx.user.findFirst({
                        where: { id: intent.userId, tenantId: intent.tenantId, ...ACTIVE_SCHEDULABLE_USER_FILTER },
                        select: { id: true, email: true },
                    }), { maxWait: 2_000, timeout: 5_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }));
                    candidateEmail = candidate ? candidate.email : undefined;
                    if (candidate) {
                        prepared = await bounded(() => this.prepareExternal
                            ? this.prepareExternal(intent, candidateEmail ?? null, window)
                            : Promise.resolve({ recipientEmail: candidateEmail ?? null, send: async (email: string | null, selectedWindow: NotificationHandoffWindow) => {
                                selectedWindow.assertNewHandoff();
                                return this.deliverExternal!(intent, email);
                            } }));
                    }
                } catch (error) { preparationError = error; preparationFailed = true; }
            }
            const outcome = await this.tenantDb.withTenant(intent.tenantId, async (tx) => {
                await tx.$executeRaw`SELECT set_config('statement_timeout', '3000', true)`;
                assertBookkeeping();
                // NOWAIT removes worker wait edges from lifecycle-advisory/User/Tenant cycles.
                const tenants = await tx.$queryRaw<Array<{ id: string; status: string; deletedAt: Date | null }>>`
                    SELECT "id", "status", "deletedAt" FROM "Tenant"
                    WHERE "id" = ${intent.tenantId} FOR SHARE NOWAIT
                `;
                assertBookkeeping();
                const users = await tx.$queryRaw<Array<{ id: string; email: string | null; role: string; deletedAt: Date | null; suspendedAt: Date | null; emailDeliverySuppressedAt: Date | null }>>`
                    SELECT "id", "email", "role", "deletedAt", "suspendedAt", "emailDeliverySuppressedAt" FROM "User"
                    WHERE "id" = ${intent.userId} AND "tenantId" = ${intent.tenantId} FOR SHARE NOWAIT
                `;
                assertBookkeeping();
                const rows = await tx.$queryRaw<Array<ClaimedNotificationIntent & { status: string }>>`
                    SELECT "id", "tenantId", "userId", "dedupeKey", "notificationType", "title", "body", "attempts", "failureCount", "createdAt", "leaseUntil", "status"
                    FROM "NotificationOutbox" WHERE "id" = ${intent.id} AND "tenantId" = ${intent.tenantId}
                    FOR UPDATE NOWAIT
                `;
                assertBookkeeping();
                const row = rows[0];
                const claimedLease = this.leaseTime(intent.leaseUntil);
                if (!row || row.status !== 'PROCESSING' || row.attempts !== intent.attempts
                    || row.userId !== intent.userId || row.notificationType !== intent.notificationType
                    || row.dedupeKey !== intent.dedupeKey || row.title !== intent.title || row.body !== intent.body
                    || this.leaseTime(row.leaseUntil) !== claimedLease) {
                    throw new NotificationOwnershipLost('Notification outbox ownership changed');
                }
                const clock = async () => {
                    const clocks = await tx.$queryRaw<Array<{ now: Date }>>`SELECT (statement_timestamp() AT TIME ZONE 'UTC') AS "now"`;
                    assertBookkeeping();
                    const now = clocks[0]?.now;
                    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new NotificationOwnershipLost('Invalid notification database clock');
                    return now;
                };
                this.assertFailureCount(row.failureCount, row.attempts);
                const now = await clock();
                if (claimedLease <= now.getTime()) throw new NotificationOwnershipLost('Notification outbox lease expired');
                // Bind the exact lease as well as the monotonically increasing claim generation.
                const leaseUntil = new Date(now.getTime() + Math.ceil(Math.max(0, this.externalTimeoutMs + BOOKKEEPING_HEADROOM_MS - (performance.now() - started))) + 1_000);
                const renewed = await tx.$executeRaw`
                    UPDATE "NotificationOutbox" SET "leaseUntil" = (${leaseUntil.toISOString()}::timestamptz AT TIME ZONE 'UTC')
                    WHERE "id" = ${intent.id} AND "tenantId" = ${intent.tenantId} AND "status" = 'PROCESSING'
                      AND "attempts" = ${intent.attempts}
                      AND "leaseUntil" = (${new Date(claimedLease).toISOString()}::timestamptz AT TIME ZONE 'UTC')
                `;
                assertBookkeeping();
                if (renewed !== 1) throw new NotificationOwnershipLost('Notification outbox lease renewal failed');
                const assertLease = async () => {
                    if ((await clock()).getTime() >= leaseUntil.getTime()) throw new NotificationOwnershipLost('Notification outbox held lease expired');
                };
                await assertLease();
                const tenant = tenants[0]; const user = users[0];
                const eligible = tenant && tenant.deletedAt === null && tenant.status !== 'PURGED'
                    && user && user.deletedAt === null
                    && (intent.notificationType !== 'SCHEDULE_PUBLISHED' || (['MANAGER', 'STAFF'].includes(user.role) && user.suspendedAt === null));
                const transition = async (data: any) => {
                    await assertLease();
                    const result = await tx.notificationOutbox.updateMany({
                        where: { id: intent.id, tenantId: intent.tenantId, status: 'PROCESSING', attempts: intent.attempts, leaseUntil }, data,
                    });
                    await assertLease();
                    if (result.count !== 1) throw new NotificationOwnershipLost('Notification outbox ownership changed before commit');
                };
                if (!eligible) {
                    await transition({ status: 'DEAD_LETTERED', nextAttemptAt: null, leaseUntil: null, title: '', body: '', lastError: null });
                    return { status: 'dead_lettered' as const, notification: null, reason: 'recipient_unavailable' };
                }
                if ((this.prepareExternal || this.deliverExternal) && intent.notificationType === 'SCHEDULE_PUBLISHED'
                    && !preparationFailed
                    && (candidateEmail === undefined || candidateEmail !== user.email || (prepared && prepared.recipientEmail !== user.email))) {
                    throw new NotificationPostponed('Notification recipient changed during preparation');
                }
                await assertLease();
                const notification = await tx.notification.upsert({
                    where: { id: intent.id },
                    create: { id: intent.id, tenantId: intent.tenantId, userId: intent.userId, type: intent.notificationType, title: row.title, body: row.body },
                    update: {},
                });
                await assertLease();
                let externalError = preparationError;
                let externalFailed = preparationFailed;
                if (!externalFailed && prepared && !user.emailDeliverySuppressedAt) {
                    try { await bounded(() => prepared!.send(user.email, window)); }
                    catch (error) { externalError = error; externalFailed = true; }
                }
                // The provider deadline stops NEW handoffs. Same-owned failure bookkeeping has finite additional headroom.
                await assertLease();
                if (externalFailed) {
                    const failureCount = row.failureCount + 1;
                    const terminal = failureCount >= this.maxAttempts;
                    await assertLease();
                    const budgeted = await tx.$executeRaw`
                        UPDATE "NotificationOutbox" SET "failureCount" = ${failureCount}
                        WHERE "id" = ${intent.id} AND "tenantId" = ${intent.tenantId} AND "status" = 'PROCESSING'
                          AND "attempts" = ${intent.attempts} AND "failureCount" = ${row.failureCount}
                          AND "leaseUntil" = (${leaseUntil.toISOString()}::timestamptz AT TIME ZONE 'UTC')
                    `;
                    await assertLease();
                    if (budgeted !== 1) throw new NotificationOwnershipLost('Notification failure budget ownership changed');
                    await transition({ status: terminal ? 'DEAD_LETTERED' : 'FAILED', nextAttemptAt: terminal ? null : new Date(Date.now() + this.retryDelayMs(failureCount)), leaseUntil: null,
                        ...(terminal ? { title: '', body: '' } : {}), lastError: terminal ? null : this.errorMessage(externalError) });
                    return { status: terminal ? 'dead_lettered' as const : 'retrying' as const, notification, reason: this.errorMessage(externalError) };
                }
                await transition({ status: 'DELIVERED', deliveredAt: new Date(), nextAttemptAt: null, leaseUntil: null, title: '', body: '', lastError: null });
                await assertLease();
                return { status: 'delivered' as const, notification, reason: null };
            }, DELIVERY_TRANSACTION_OPTIONS);
            this.recordOutcome?.(outcome.status);
            if (outcome.status === 'dead_lettered') this.logger.error(`Notification outbox terminal failure reason=${outcome.reason}`);
            // Existing best-effort postcommit fanout is not a lifecycle-current transport guarantee.
            if (outcome.status === 'delivered' && outcome.notification && this.fanOut) {
                await this.fanOut(outcome.notification as Notification).catch(error => this.logger.warn(`Notification Redis fan-out skipped ${this.errorMessage(error)}`));
            }
        } catch (error) {
            if (error instanceof NotificationOwnershipLost) return;
            if (error instanceof NotificationPostponed || this.lockUnavailable(error)) await this.postpone(intent);
            else await this.markFailed(intent, error);
        } finally { clearTimeout(timer); controller.abort(deadlineError); }
    }

    private leaseTime(value: Date | string): number {
        const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
        if (!Number.isFinite(time)) throw new NotificationOwnershipLost('Invalid notification outbox lease');
        return time;
    }

    private lockUnavailable(error: unknown): boolean {
        const e = error as { code?: unknown; meta?: { code?: unknown } } | null;
        return e?.code === '55P03' || e?.meta?.code === '55P03';
    }

    private async postpone(intent: ClaimedNotificationIntent): Promise<void> {
        try {
            await this.tenantDb.withTenant(intent.tenantId, async (tx) => {
                await tx.$executeRaw`SELECT set_config('statement_timeout', '3000', true)`;
                const rows = await tx.$queryRaw<Array<{ id: string; status: string; attempts: number; leaseUntil: Date }>>`
                    SELECT "id", "status", "attempts", "leaseUntil" FROM "NotificationOutbox"
                    WHERE "id" = ${intent.id} AND "tenantId" = ${intent.tenantId} FOR UPDATE NOWAIT
                `;
                const row = rows[0]; const leaseUntil = new Date(this.leaseTime(intent.leaseUntil));
                if (!row || row.status !== 'PROCESSING' || row.attempts !== intent.attempts || this.leaseTime(row.leaseUntil) !== leaseUntil.getTime()) return;
                const assertLease = async () => {
                    const clocks = await tx.$queryRaw<Array<{ now: Date }>>`SELECT (statement_timestamp() AT TIME ZONE 'UTC') AS "now"`;
                    const now = clocks[0]?.now;
                    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getTime() >= leaseUntil.getTime()) throw new NotificationOwnershipLost('Notification postponement lease expired');
                };
                await assertLease();
                const result = await tx.notificationOutbox.updateMany({
                    where: { id: intent.id, tenantId: intent.tenantId, status: 'PROCESSING', attempts: intent.attempts, leaseUntil },
                    data: { status: 'FAILED', nextAttemptAt: new Date(Date.now() + 1_000), leaseUntil: null, lastError: null },
                });
                await assertLease();
                if (result.count !== 1) throw new NotificationOwnershipLost('Notification postponement ownership changed');
            }, { maxWait: 2_000, timeout: 5_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
        } catch (error) {
            // Another row owner may prevent even postponement; leave its finite lease/recovery untouched.
            this.logger.warn(`Notification contention postponement skipped ${this.errorMessage(error)}`);
        }
    }

    private assertFailureCount(value: number, attempts: number): void {
        if (!Number.isSafeInteger(value) || value < 0 || value > attempts) throw new NotificationOwnershipLost('Invalid notification failure budget');
    }

    private async markFailed(intent: ClaimedNotificationIntent, error: unknown): Promise<void> {
        const message = this.errorMessage(error);
        await this.tenantDb.withTenant(intent.tenantId, async (tx) => {
            await tx.$executeRaw`SELECT set_config('statement_timeout', '3000', true)`;
            const rows = await tx.$queryRaw<Array<{ id: string; status: string; attempts: number; leaseUntil: Date; failureCount: number }>>`
                SELECT "id", "status", "attempts", "leaseUntil", "failureCount" FROM "NotificationOutbox"
                WHERE "id" = ${intent.id} AND "tenantId" = ${intent.tenantId} FOR UPDATE NOWAIT
            `;
            const row = rows[0]; const leaseUntil = new Date(this.leaseTime(intent.leaseUntil));
            if (!row || row.status !== 'PROCESSING' || row.attempts !== intent.attempts || this.leaseTime(row.leaseUntil) !== leaseUntil.getTime()) return;
            this.assertFailureCount(row.failureCount, row.attempts);
            const assertLease = async () => {
                const clocks = await tx.$queryRaw<Array<{ now: Date }>>`SELECT (statement_timestamp() AT TIME ZONE 'UTC') AS "now"`;
                const now = clocks[0]?.now;
                if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getTime() >= leaseUntil.getTime()) throw new NotificationOwnershipLost('Notification failure bookkeeping lease expired');
            };
            await assertLease();
            const failureCount = row.failureCount + 1; const terminal = failureCount >= this.maxAttempts;
            const budgeted = await tx.$executeRaw`
                UPDATE "NotificationOutbox" SET "failureCount" = ${failureCount}
                WHERE "id" = ${intent.id} AND "tenantId" = ${intent.tenantId} AND "status" = 'PROCESSING'
                  AND "attempts" = ${intent.attempts} AND "failureCount" = ${row.failureCount}
                  AND "leaseUntil" = (${leaseUntil.toISOString()}::timestamptz AT TIME ZONE 'UTC')
            `;
            await assertLease();
            if (budgeted !== 1) throw new NotificationOwnershipLost('Notification failure budget ownership changed');
            const transitioned = await tx.notificationOutbox.updateMany({
                where: { id: intent.id, tenantId: intent.tenantId, status: 'PROCESSING', attempts: intent.attempts, leaseUntil },
                data: { status: terminal ? 'DEAD_LETTERED' : 'FAILED', nextAttemptAt: terminal ? null : new Date(Date.now() + this.retryDelayMs(failureCount)), leaseUntil: null,
                    ...(terminal ? { title: '', body: '' } : {}), lastError: terminal ? null : message },
            });
            await assertLease();
            if (transitioned.count !== 1) throw new NotificationOwnershipLost('Notification failure bookkeeping ownership changed');
            return terminal ? 'dead_lettered' as const : 'retrying' as const;
        }, { maxWait: 2_000, timeout: 5_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }).then(outcome => {
            if (outcome) this.recordOutcome?.(outcome);
            if (outcome === 'dead_lettered') this.logger.error(`Notification outbox terminal failure attempts=${intent.attempts} ${message}`);
        }).catch(failure => { this.logger.warn(`Notification failure bookkeeping skipped ${this.errorMessage(failure)}`); });
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
