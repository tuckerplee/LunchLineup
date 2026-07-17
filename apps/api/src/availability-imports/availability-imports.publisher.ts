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
const PUBLISH_CONFIRM_TIMEOUT_MS = 10_000;
const PUBLISH_CLOSE_TIMEOUT_MS = 2_000;

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

    constructor(private readonly tenantDb: TenantPrismaService) {}

    onModuleInit(): void {
        this.timer = setInterval(() => this.kick(), PUBLISH_INTERVAL_MS);
        this.timer.unref();
        this.kick();
    }

    async onModuleDestroy(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        await this.activeSweep;
    }

    kick(): void {
        if (this.activeSweep) return;
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
        const connection = await amqp.connect(rabbitUrl, { timeout: 5_000 });
        try {
            const channel = await connection.createConfirmChannel();
            try {
                await channel.assertQueue(dlqName, { durable: true });
                await channel.assertQueue(queueName, {
                    durable: true,
                    arguments: {
                        'x-dead-letter-exchange': '',
                        'x-dead-letter-routing-key': dlqName,
                    },
                });
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
                    await this.withTimeout(
                        new Promise<void>((resolveDrain) => channel.once('drain', resolveDrain)),
                        PUBLISH_CONFIRM_TIMEOUT_MS,
                    );
                }
                await this.withTimeout(channel.waitForConfirms(), PUBLISH_CONFIRM_TIMEOUT_MS);
            } finally {
                await this.withTimeout(channel.close(), PUBLISH_CLOSE_TIMEOUT_MS)
                    .catch(() => undefined);
            }
        } finally {
            await this.withTimeout(connection.close(), PUBLISH_CLOSE_TIMEOUT_MS)
                .catch(() => undefined);
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
