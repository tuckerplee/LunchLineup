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
};

@Injectable()
export class AvailabilityImportPublisher implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AvailabilityImportPublisher.name);
    private timer?: NodeJS.Timeout;
    private activeSweep?: Promise<void>;
    private shutdown?: Promise<void>;
    private lifecycle: 'starting' | 'ready' | 'draining' | 'stopped' = 'starting';
    private readonly activeConnections = new Set<Awaited<ReturnType<typeof amqp.connect>>>();
    private readonly activeChannels = new Set<amqp.ConfirmChannel>();

    constructor(private readonly tenantDb: TenantPrismaService) {}

    onModuleInit(): void {
        if (this.lifecycle !== 'starting') return;
        this.lifecycle = 'ready';
        this.timer = setInterval(() => this.kick(), PUBLISH_INTERVAL_MS);
        this.timer.unref();
        this.kick();
    }

    onModuleDestroy(): Promise<void> {
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
        await this.reconcileWorkerAccepted();
        const claimed = await this.claim();
        await Promise.all(claimed.map((publication) => this.publishClaim(publication)));
    }

    private async reconcileWorkerAccepted(): Promise<void> {
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
              AND "attempts" > 0
              AND "startedAt" IS NOT NULL
        `));
    }

    private async claim(): Promise<ClaimedPublication[]> {
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
                job."publishAttempts"
        `));
    }

    private async publishClaim(claim: ClaimedPublication): Promise<void> {
        try {
            await this.publishMessage(claim.tenantId, claim.id);
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

    private async publishMessage(tenantId: string, importId: string): Promise<void> {
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
                    retry_count: 0,
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
