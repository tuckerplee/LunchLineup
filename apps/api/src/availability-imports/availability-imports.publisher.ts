import { consumePersistentImportPermit } from '../admin/persistent-export-consumer';
import { pilotProducersClosed, requireOrdinaryProducer } from '../common/pilot-producer-admission';
import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';

import { TenantPrismaService } from '../database/tenant-prisma.service';

const PUBLISH_INTERVAL_MS = 2_000;
const PUBLISH_LEASE_MS = 60_000;
const PUBLISH_BATCH_SIZE = 10;
const PUBLISH_CONNECT_TIMEOUT_MS = 5_000;
const PUBLISH_CONFIRM_TIMEOUT_MS = 10_000;
const PUBLISH_CLOSE_TIMEOUT_MS = 2_000;
const PUBLISH_SHUTDOWN_TIMEOUT_MS = 15_000;

type ClaimedPublication = {
    id: string;
    tenantId: string;
    publishToken: string;
    publishAttempts: number;
    attempts: number;
};

function workerInteger(name: string, fallback: number, minimum: number, maximum: number): number {
    const value = process.env[name]?.trim() ?? String(fallback);
    if (!/^[+-]?\d(?:_?\d)*$/.test(value)) return fallback;
    const parsed = BigInt(value.replaceAll('_', ''));
    return parsed < BigInt(minimum) ? minimum : parsed > BigInt(maximum) ? maximum : Number(parsed);
}

@Injectable()
export class AvailabilityImportPublisher implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AvailabilityImportPublisher.name);
    private readonly pilotClosed = pilotProducersClosed();
    private ownerClosed = false;
    private ownerUsed = false;
    private ownerUnknown = false;
    private ownerOperation?: Promise<boolean>;
    private ownerClose?: Promise<void>;
    private timer?: NodeJS.Timeout;
    private activeSweep?: Promise<void>;
    private shutdown?: Promise<void>;
    private lifecycle: 'starting' | 'ready' | 'draining' | 'stopped' = 'starting';
    private readonly activeConnections = new Set<Awaited<ReturnType<typeof amqp.connect>>>();
    private readonly activeChannels = new Set<amqp.ConfirmChannel>();

    constructor(private readonly tenantDb: TenantPrismaService) {}

    onModuleInit(): void {
        if (pilotProducersClosed()) return;
        if (this.lifecycle !== 'starting') return;
        this.lifecycle = 'ready';
        this.timer = setInterval(() => this.kick(), PUBLISH_INTERVAL_MS);
        this.timer.unref();
        this.kick();
    }

    assertPersistentOwnerReady(): void {
        if (!this.pilotClosed || this.ownerClosed || this.ownerUsed || this.timer || this.activeSweep
            || this.lifecycle !== 'starting') throw new Error('Import publisher is not closed and unused.');
    }

    runPersistentOwnerImport(permit: object): Promise<boolean> {
        const selected = consumePersistentImportPermit(this, permit);
        this.assertPersistentOwnerReady();
        this.ownerUsed = true;
        this.ownerOperation = Promise.resolve().then(() => selected.effect === 'publish-exact-import'
            ? this.publishSelected(selected) : this.reconcileSelectedAcceptance(selected))
            .catch((error) => { this.ownerUnknown = true; throw error; });
        return this.ownerOperation;
    }

    closeAdmission(): Promise<void> {
        this.ownerClosed = true;
        if (this.ownerClose) return this.ownerClose;
        this.ownerClose = (async () => {
            try { await this.ownerOperation; } catch { this.ownerUnknown = true; }
            if (this.ownerUnknown) throw new Error('Import publication requires independent reconciliation.');
        })();
        return this.ownerClose;
    }

    private assertOwnerOpen(expires: number): void {
        if (!this.pilotClosed || !this.ownerUsed || this.ownerClosed || performance.now() >= expires) {
            throw new Error('Selected import publication admission is closed.');
        }
    }

    private async reconcileSelectedAcceptance(selected: { jobId: string; tenantId: string; expires: number }): Promise<boolean> {
        this.assertOwnerOpen(selected.expires);
        const rows = await this.tenantDb.withTenant(selected.tenantId, (tx) => {
            this.assertOwnerOpen(selected.expires);
            return tx.$queryRaw<Array<{ id: string; tenantId: string; attempts: number; startedAt: Date }>>(Prisma.sql`
                WITH candidate AS (
                    SELECT "id" FROM "AvailabilityImportJob"
                    WHERE "id" = ${selected.jobId} AND "tenantId" = ${selected.tenantId}
                        AND "publicationStatus" <> 'PUBLISHED' AND "status" <> 'PENDING'
                        AND "attempts" > 0 AND "startedAt" IS NOT NULL
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE "AvailabilityImportJob" job
                SET "publicationStatus" = 'PUBLISHED', "publishToken" = NULL, "publishLeaseUntil" = NULL,
                    "publicationAmbiguous" = FALSE, "publishLastError" = NULL,
                    "publishedAt" = COALESCE(job."publishedAt", job."startedAt", CURRENT_TIMESTAMP),
                    "queuedAt" = COALESCE(job."queuedAt", job."startedAt", CURRENT_TIMESTAMP),
                    "updatedAt" = CURRENT_TIMESTAMP
                FROM candidate WHERE job."id" = candidate."id" AND job."tenantId" = ${selected.tenantId}
                RETURNING job."id", job."tenantId", job."attempts", job."startedAt"
            `);
        });
        this.assertOwnerOpen(selected.expires);
        if (!rows.length) return false;
        if (rows.length !== 1 || rows[0].id !== selected.jobId || rows[0].tenantId !== selected.tenantId
            || rows[0].attempts <= 0 || !rows[0].startedAt) throw new Error('Selected import acceptance readback differs.');
        // Only publication acceptance is reconciled. Worker completion, retry and expiry are untouched.
        return true;
    }

    private async publishSelected(selected: { jobId: string; tenantId: string; expires: number }): Promise<boolean> {
        this.assertOwnerOpen(selected.expires);
        const publishToken = randomUUID();
        const leaseUntil = new Date(Date.now() + Math.max(1, Math.ceil(selected.expires - performance.now())));
        const rows = await this.tenantDb.withTenant(selected.tenantId, async (tx) => {
            this.assertOwnerOpen(selected.expires);
            return tx.$queryRaw<ClaimedPublication[]>(Prisma.sql`
                WITH candidate AS (
                    SELECT "id" FROM "AvailabilityImportJob"
                    WHERE "id" = ${selected.jobId} AND "tenantId" = ${selected.tenantId}
                        AND "status" = 'PENDING' AND "publicationStatus" = 'PENDING'
                        AND "publishAttempts" = 0 AND "attempts" = 0
                        AND "publishToken" IS NULL AND "executionToken" IS NULL
                        AND "publicationAmbiguous" = FALSE
                        AND "nextPublishAt" <= CURRENT_TIMESTAMP AND "expiresAt" > CURRENT_TIMESTAMP
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE "AvailabilityImportJob" job
                SET "publicationStatus" = 'PUBLISHING', "publishToken" = ${publishToken},
                    "publishLeaseUntil" = ${leaseUntil}, "publishAttempts" = job."publishAttempts" + 1,
                    "publicationAmbiguous" = TRUE, "publishLastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
                FROM candidate WHERE job."id" = candidate."id" AND job."tenantId" = ${selected.tenantId}
                RETURNING job."id", job."tenantId", job."publishToken", job."publishAttempts", job."attempts"
            `);
        });
        this.assertOwnerOpen(selected.expires);
        if (!rows.length) return false;
        if (rows.length !== 1 || rows[0].id !== selected.jobId || rows[0].tenantId !== selected.tenantId
            || rows[0].publishToken !== publishToken || rows[0].publishAttempts !== 1 || rows[0].attempts !== 0) {
            throw new Error('Selected import claim differs.');
        }
        let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
        let channel: amqp.ConfirmChannel | undefined;
        try {
            // Await actual promises; a late result remains owned after terminal admission close.
            connection = await amqp.connect(process.env.RABBITMQ_URL!);
            this.assertOwnerOpen(selected.expires);
            channel = await connection.createConfirmChannel();
            this.assertOwnerOpen(selected.expires);
            await channel.checkQueue(process.env.WORKER_QUEUE_NAME!);
            this.assertOwnerOpen(selected.expires);
            let returned = false;
            channel.on('return', () => { returned = true; });
            channel.sendToQueue(process.env.WORKER_QUEUE_NAME!, Buffer.from(JSON.stringify({
                type: 'pdf.parse', job_id: selected.jobId, retry_count: 0,
                payload: { import_id: selected.jobId, tenant_id: selected.tenantId },
            })), { persistent: true, mandatory: true, contentType: 'application/json', messageId: selected.jobId });
            await channel.waitForConfirms();
            if (returned) throw new Error('Selected import message was returned by the broker.');
            this.assertOwnerOpen(selected.expires);
            const changed = await this.tenantDb.withTenant(selected.tenantId, (tx) => {
                this.assertOwnerOpen(selected.expires);
                return tx.$executeRaw`
                UPDATE "AvailabilityImportJob"
                SET "publicationStatus" = 'PUBLISHED', "publishToken" = NULL, "publishLeaseUntil" = NULL,
                    "publicationAmbiguous" = FALSE, "publishLastError" = NULL,
                    "publishedAt" = CURRENT_TIMESTAMP, "queuedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = ${selected.jobId} AND "tenantId" = ${selected.tenantId}
                    AND "publicationStatus" = 'PUBLISHING' AND "publishToken" = ${publishToken}
                    AND "publishAttempts" = 1 AND "publishLeaseUntil" > CURRENT_TIMESTAMP
                `;
            });
            if (changed !== 1) throw new Error('Selected import acknowledgement fence differs.');
            this.assertOwnerOpen(selected.expires);
        } finally {
            try { if (channel) await channel.close(); }
            finally { if (connection) await connection.close(); }
        }
        this.assertOwnerOpen(selected.expires);
        return true;
    }

    onModuleDestroy(): Promise<void> {
        if (this.pilotClosed) return this.closeAdmission();
        if (this.shutdown) return this.shutdown;
        this.lifecycle = 'draining';
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.shutdown = this.drain().finally(() => {
            this.lifecycle = 'stopped';
        });
        return this.shutdown;
    }

    isReady(): boolean {
        return this.lifecycle === 'ready';
    }

    kick(): void {
        requireOrdinaryProducer('availability import publication');
        if (!this.isReady() || this.activeSweep) return;
        this.activeSweep = this.publishPending()
            .catch((error) => {
                this.logger.warn(
                    `Availability import publication sweep failed reason=${this.failureClass(error)}`,
                );
            })
            .finally(() => {
                this.activeSweep = undefined;
            });
    }

    private async publishPending(): Promise<void> {
        requireOrdinaryProducer('availability import publishPending');
        await this.reconcileWorkerAccepted();
        await this.recoverExpiredExecutions();
        const claimed = await this.claim();
        await Promise.all(claimed.map((publication) => this.publishClaim(publication)));
    }

    private async reconcileWorkerAccepted(): Promise<void> {
        requireOrdinaryProducer('availability import reconcileWorkerAccepted');
        await this.tenantDb.withPlatformAdmin((tx: any) => tx.$executeRaw(Prisma.sql`
            UPDATE "AvailabilityImportJob"
            SET
                "publicationStatus" = 'PUBLISHED',
                "publishToken" = NULL,
                "publishLeaseUntil" = NULL,
                "publicationAmbiguous" = FALSE,
                "publishLastError" = NULL,
                "publishedAt" = COALESCE("publishedAt", "startedAt", CURRENT_TIMESTAMP),
                "queuedAt" = COALESCE("queuedAt", "startedAt", CURRENT_TIMESTAMP),
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "publicationStatus" <> 'PUBLISHED'
              AND "status" <> 'PENDING'
              AND "attempts" > 0
              AND "startedAt" IS NOT NULL
        `));
    }

    private async recoverExpiredExecutions(): Promise<void> {
        requireOrdinaryProducer('availability import recoverExpiredExecutions');
        // A confirmed broker message can disappear after its worker crashes. Revoke
        // expired owners or stale missing ownership, then reuse durable publication.
        // Source bytes and the original debit remain intact; workers still validate
        // tenant/employee eligibility and exact settlement under their normal locks.
        const retryGraceSeconds = Math.max(
            workerInteger('WORKER_RETRY_BACKOFF_1_SECONDS', 5, 1, 300),
            workerInteger('WORKER_RETRY_BACKOFF_2_SECONDS', 30, 1, 900),
            workerInteger('WORKER_RETRY_BACKOFF_3_SECONDS', 120, 1, 3600),
        ) + 60;
        await this.tenantDb.withPlatformAdmin((tx: any) => tx.$executeRaw(Prisma.sql`
            WITH candidates AS (
                SELECT job."id"
                FROM "AvailabilityImportJob" AS job
                WHERE job."expiresAt" > CURRENT_TIMESTAMP
                  AND (
                    (job."status" = 'RUNNING' AND (
                      job."executionLeaseUntil" <= CURRENT_TIMESTAMP
                      OR (job."executionLeaseUntil" IS NULL
                          AND job."updatedAt" <= CURRENT_TIMESTAMP - INTERVAL '60 seconds')
                    ))
                    OR (job."status" = 'RETRYING'
                        AND job."executionToken" IS NULL
                        AND job."executionLeaseUntil" IS NULL
                        AND job."updatedAt" <= CURRENT_TIMESTAMP - (${retryGraceSeconds} * INTERVAL '1 second'))
                  )
                ORDER BY job."updatedAt", job."id"
                FOR UPDATE SKIP LOCKED
                LIMIT ${PUBLISH_BATCH_SIZE}
            )
            UPDATE "AvailabilityImportJob" AS job
            SET "status" = 'PENDING',
                "executionToken" = NULL,
                "executionLeaseUntil" = NULL,
                "publicationStatus" = 'PENDING',
                "publishToken" = NULL,
                "publishLeaseUntil" = NULL,
                "publicationAmbiguous" = FALSE,
                "publishLastError" = NULL,
                "nextPublishAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
            FROM candidates
            WHERE job."id" = candidates."id"
        `));
    }

    private async claim(): Promise<ClaimedPublication[]> {
        requireOrdinaryProducer('availability import claim');
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + PUBLISH_LEASE_MS);
        const publishToken = randomUUID();
        return this.tenantDb.withPlatformAdmin((tx: any) => tx.$queryRaw(Prisma.sql`
            WITH candidates AS (
                SELECT job."id"
                FROM "AvailabilityImportJob" AS job
                WHERE job."status" = 'PENDING'
                  AND job."expiresAt" > ${now}
                  AND (
                    (
                        job."publicationStatus" IN ('PENDING', 'FAILED')
                        AND job."nextPublishAt" <= ${now}
                    )
                    OR (
                        job."publicationStatus" = 'PUBLISHING'
                        AND job."publishLeaseUntil" <= ${now}
                    )
                  )
                ORDER BY job."nextPublishAt" ASC, job."createdAt" ASC, job."id" ASC
                FOR UPDATE SKIP LOCKED
                LIMIT ${PUBLISH_BATCH_SIZE}
            )
            UPDATE "AvailabilityImportJob" AS job
            SET
                "publicationStatus" = 'PUBLISHING',
                "publishToken" = ${publishToken},
                "publishLeaseUntil" = ${leaseUntil},
                "publishAttempts" = job."publishAttempts" + 1,
                "publicationAmbiguous" = TRUE,
                "publishLastError" = NULL,
                "updatedAt" = ${now}
            FROM candidates
            WHERE job."id" = candidates."id"
            RETURNING
                job."id",
                job."tenantId",
                job."publishToken",
                job."publishAttempts",
                job."attempts"
        `));
    }

    private async publishClaim(claim: ClaimedPublication): Promise<void> {
        try {
            // RUNNING attempts counts its crashed execution; RETRYING attempts
            // counts failed executions. Both resume at that durable retry budget.
            const retryCount = Math.min(claim.attempts, workerInteger('WORKER_MAX_RETRIES', 3, 0, 10));
            await this.publishMessage(claim.tenantId, claim.id, retryCount);
        } catch (error) {
            await this.markFailed(claim, error);
            return;
        }

        try {
            await this.tenantDb.withTenant(claim.tenantId, async (tx: any) => {
                await tx.availabilityImportJob.updateMany({
                    where: {
                        id: claim.id,
                        tenantId: claim.tenantId,
                        publicationStatus: 'PUBLISHING',
                        publishToken: claim.publishToken,
                    },
                    data: {
                        publicationStatus: 'PUBLISHED',
                        publishToken: null,
                        publishLeaseUntil: null,
                        publicationAmbiguous: false,
                        publishLastError: null,
                        publishedAt: new Date(),
                        queuedAt: new Date(),
                    },
                });
            });
        } catch (error) {
            // A broker confirm may already own delivery. Preserve the lease for recovery.
            this.logger.warn(
                `Availability import confirm persistence is ambiguous import_id=${claim.id} reason=${this.failureClass(error)}`,
            );
        }
    }

    private async markFailed(claim: ClaimedPublication, error: unknown): Promise<void> {
        const nextPublishAt = new Date(Date.now() + this.retryDelayMs(claim.publishAttempts));
        try {
            await this.tenantDb.withTenant(claim.tenantId, async (tx: any) => {
                await tx.availabilityImportJob.updateMany({
                    where: {
                        id: claim.id,
                        tenantId: claim.tenantId,
                        publicationStatus: 'PUBLISHING',
                        publishToken: claim.publishToken,
                    },
                    data: {
                        publicationStatus: 'FAILED',
                        publishToken: null,
                        publishLeaseUntil: null,
                        nextPublishAt,
                        publicationAmbiguous: true,
                        publishLastError: this.failureClass(error),
                    },
                });
            });
        } catch (stateError) {
            this.logger.warn(
                `Availability import publish failure persistence failed import_id=${claim.id} reason=${this.failureClass(stateError)}`,
            );
        }
    }

    private async publishMessage(tenantId: string, importId: string, retryCount: number): Promise<void> {
        const rabbitUrl = process.env.RABBITMQ_URL;
        if (!rabbitUrl) throw new Error('RabbitMQ URL is not configured');
        const queueName = process.env.WORKER_QUEUE_NAME || 'lunchlineup.jobs';
        const dlqName = process.env.WORKER_DLQ_NAME || 'lunchlineup.jobs.dlq';
        const connectionPromise = amqp.connect(rabbitUrl, { timeout: PUBLISH_CONNECT_TIMEOUT_MS });
        let connection: Awaited<ReturnType<typeof amqp.connect>>;
        try {
            connection = await this.withTimeout(connectionPromise, PUBLISH_CONNECT_TIMEOUT_MS);
        } catch (error) {
            void connectionPromise
                .then((lateConnection) => this.closeConnection(lateConnection))
                .catch(() => undefined);
            throw error;
        }
        this.activeConnections.add(connection);
        try {
            const channel = await this.withTimeout(
                connection.createConfirmChannel(),
                PUBLISH_CONFIRM_TIMEOUT_MS,
            );
            this.activeChannels.add(channel);
            try {
                await this.withTimeout(
                    channel.assertQueue(dlqName, { durable: true }),
                    PUBLISH_CONFIRM_TIMEOUT_MS,
                );
                await this.withTimeout(
                    channel.assertQueue(queueName, {
                        durable: true,
                        arguments: {
                            'x-dead-letter-exchange': '',
                            'x-dead-letter-routing-key': dlqName,
                        },
                    }),
                    PUBLISH_CONFIRM_TIMEOUT_MS,
                );
                const body = Buffer.from(JSON.stringify({
                    type: 'pdf.parse',
                    job_id: importId,
                    retry_count: retryCount,
                    payload: { import_id: importId, tenant_id: tenantId },
                }));
                if (!channel.sendToQueue(queueName, body, {
                    persistent: true,
                    contentType: 'application/json',
                    messageId: importId,
                })) {
                    await this.waitForDrain(channel);
                }
                await this.withTimeout(channel.waitForConfirms(), PUBLISH_CONFIRM_TIMEOUT_MS);
            } finally {
                await this.withTimeout(channel.close(), PUBLISH_CLOSE_TIMEOUT_MS)
                    .catch(() => this.forceDestroy(channel));
                this.activeChannels.delete(channel);
            }
        } finally {
            await this.closeConnection(connection);
            this.activeConnections.delete(connection);
        }
    }

    private async drain(): Promise<void> {
        const active = this.activeSweep;
        if (!active) return;
        try {
            await this.withTimeout(active, PUBLISH_SHUTDOWN_TIMEOUT_MS);
        } catch {
            this.forceDestroyTransports();
            this.logger.warn(
                'Availability import publisher shutdown exceeded its drain deadline; RabbitMQ transports were destroyed.',
            );
            void active.catch(() => undefined);
        }
    }

    private async closeConnection(
        connection: Awaited<ReturnType<typeof amqp.connect>>,
    ): Promise<void> {
        await this.withTimeout(connection.close(), PUBLISH_CLOSE_TIMEOUT_MS)
            .catch(() => {
                this.forceDestroy(connection);
            });
    }

    private forceDestroyTransports(): void {
        for (const channel of this.activeChannels) this.forceDestroy(channel);
        for (const connection of this.activeConnections) this.forceDestroy(connection);
    }

    private forceDestroy(candidate: unknown): void {
        const transports = [
            candidate,
            (candidate as { connection?: unknown } | undefined)?.connection,
        ];
        const destroyed = new Set<unknown>();
        for (const transport of transports) {
            const target = transport as {
                destroy?: () => void;
                socket?: { destroy?: () => void };
                stream?: { destroy?: () => void };
            } | undefined;
            for (const item of [target, target?.socket, target?.stream]) {
                if (!item || destroyed.has(item) || typeof item.destroy !== 'function') continue;
                destroyed.add(item);
                try {
                    item.destroy();
                } catch {
                    // Best-effort transport teardown must not extend shutdown.
                }
            }
        }
    }

    private async waitForDrain(channel: amqp.ConfirmChannel): Promise<void> {
        let onDrain!: () => void;
        const onDrainPromise = new Promise<void>((resolve) => {
            onDrain = resolve;
            channel.once('drain', onDrain);
        });
        try {
            await this.withTimeout(onDrainPromise, PUBLISH_CONFIRM_TIMEOUT_MS);
        } finally {
            channel.removeListener('drain', onDrain);
        }
    }

    private retryDelayMs(attempt: number): number {
        return Math.min(60_000, 1_000 * (2 ** Math.max(0, Math.min(attempt - 1, 6))));
    }

    private failureClass(error: unknown): string {
        const name = error instanceof Error ? error.constructor.name : 'UnknownError';
        return name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'UnknownError';
    }

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('RabbitMQ operation timed out')), timeoutMs);
                    timer.unref();
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
