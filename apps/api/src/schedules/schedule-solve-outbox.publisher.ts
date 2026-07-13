import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import type { ConfirmChannel } from 'amqplib';
import { TenantPrismaService } from '../database/tenant-prisma.service';

const DEFAULT_SCHEDULE_QUEUE = 'lunchlineup.jobs';
const DEFAULT_SCHEDULE_DLQ = 'lunchlineup.jobs.dlq';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 60_000;
const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 10_000;
const MAX_LEASE_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;
const MAX_ERROR_LENGTH = 1_000;
const MAX_STATUS_REASON_LENGTH = 512;
const DEFAULT_MAX_PUBLISH_ATTEMPTS = 8;
const MAX_PUBLISH_ATTEMPTS = 100;
const DEFAULT_MAX_PUBLICATION_AGE_MS = 24 * 60 * 60_000;
const MIN_MAX_PUBLICATION_AGE_MS = 60_000;
const MAX_MAX_PUBLICATION_AGE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_CONFIRMED_PUBLICATION_RECOVERY_AGE_MS = 15 * 60_000;
const MIN_CONFIRMED_PUBLICATION_RECOVERY_AGE_MS = 60_000;
const MAX_CONFIRMED_PUBLICATION_RECOVERY_AGE_MS = 24 * 60 * 60_000;

export type ScheduleSolveQueueJob = {
    type: 'schedule.solve';
    job_id: string;
    payload: Record<string, unknown>;
};

type ClaimedScheduleSolvePublication = {
    id: string;
    tenantId: string;
    queuePayload: ScheduleSolveQueueJob;
    publishAttempts: number;
    createdAt: Date | string;
};

type ScheduleSolveOutboxPublisherOptions = {
    connect?: typeof amqp.connect;
    pollIntervalMs?: number;
    leaseMs?: number;
    batchSize?: number;
    maxPublishAttempts?: number;
    maxPublicationAgeMs?: number;
    confirmedPublicationRecoveryAgeMs?: number;
};

export class ScheduleSolveOutboxPublisher {
    private readonly logger = new Logger(ScheduleSolveOutboxPublisher.name);
    private readonly connect: typeof amqp.connect;
    private readonly pollIntervalMs: number;
    private readonly leaseMs: number;
    private readonly batchSize: number;
    private readonly maxPublishAttempts: number;
    private readonly maxPublicationAgeMs: number;
    private readonly confirmedPublicationRecoveryAgeMs: number;
    private timer?: NodeJS.Timeout;
    private activeSweep?: Promise<void>;

    constructor(
        private readonly tenantDb: TenantPrismaService,
        options: ScheduleSolveOutboxPublisherOptions = {},
    ) {
        this.connect = options.connect ?? amqp.connect;
        this.pollIntervalMs = options.pollIntervalMs
            ?? this.boundedInteger(process.env.SCHEDULE_OUTBOX_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS);
        this.leaseMs = options.leaseMs
            ?? this.boundedInteger(process.env.SCHEDULE_OUTBOX_LEASE_MS, DEFAULT_LEASE_MS, MIN_LEASE_MS, MAX_LEASE_MS);
        this.batchSize = options.batchSize
            ?? this.boundedInteger(process.env.SCHEDULE_OUTBOX_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
        this.maxPublishAttempts = options.maxPublishAttempts
            ?? this.boundedInteger(
                process.env.SCHEDULE_OUTBOX_MAX_PUBLISH_ATTEMPTS,
                DEFAULT_MAX_PUBLISH_ATTEMPTS,
                1,
                MAX_PUBLISH_ATTEMPTS,
            );
        this.maxPublicationAgeMs = options.maxPublicationAgeMs
            ?? this.boundedInteger(
                process.env.SCHEDULE_OUTBOX_MAX_PUBLICATION_AGE_MS,
                DEFAULT_MAX_PUBLICATION_AGE_MS,
                MIN_MAX_PUBLICATION_AGE_MS,
                MAX_MAX_PUBLICATION_AGE_MS,
            );
        this.confirmedPublicationRecoveryAgeMs = options.confirmedPublicationRecoveryAgeMs
            ?? this.boundedInteger(
                process.env.SCHEDULE_OUTBOX_CONFIRMED_RECOVERY_AGE_MS,
                DEFAULT_CONFIRMED_PUBLICATION_RECOVERY_AGE_MS,
                MIN_CONFIRMED_PUBLICATION_RECOVERY_AGE_MS,
                MAX_CONFIRMED_PUBLICATION_RECOVERY_AGE_MS,
            );
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

    async publishPendingNow(jobId?: string): Promise<void> {
        await this.sweep(jobId);
    }

    private kick(): void {
        if (this.activeSweep) return;
        this.activeSweep = this.sweep()
            .catch((error) => {
                this.logger.error(`Schedule outbox sweep failed: ${this.errorMessage(error)}`);
            })
            .finally(() => {
                this.activeSweep = undefined;
            });
    }

    private async sweep(jobId?: string): Promise<void> {
        const claimed = await this.claim(jobId);
        if (claimed.length === 0) return;

        let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
        let channel: ConfirmChannel | undefined;
        try {
            const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
            const queueName = process.env.WORKER_QUEUE_NAME || DEFAULT_SCHEDULE_QUEUE;
            const dlqName = process.env.WORKER_DLQ_NAME || DEFAULT_SCHEDULE_DLQ;
            connection = await this.connect(rabbitUrl);
            channel = await connection.createConfirmChannel();
            await channel.assertQueue(dlqName, { durable: true });
            await channel.assertQueue(queueName, {
                durable: true,
                arguments: {
                    'x-dead-letter-exchange': '',
                    'x-dead-letter-routing-key': dlqName,
                },
            });

            for (const publication of claimed) {
                try {
                    channel.sendToQueue(
                        queueName,
                        Buffer.from(JSON.stringify(publication.queuePayload)),
                        {
                            persistent: true,
                            contentType: 'application/json',
                            messageId: publication.id,
                            type: publication.queuePayload.type,
                        },
                    );
                    await channel.waitForConfirms();
                } catch (error) {
                    await this.markFailed(publication, error);
                    continue;
                }

                try {
                    await this.markPublished(publication);
                } catch (error) {
                    this.logger.error(
                        `Schedule publication ${publication.id} was broker-confirmed but could not be acknowledged: ${this.errorMessage(error)}`,
                    );
                }
            }
        } catch (error) {
            await Promise.allSettled(claimed.map((publication) => this.markFailed(publication, error)));
        } finally {
            await Promise.resolve(channel?.close()).catch(() => undefined);
            await Promise.resolve(connection?.close()).catch(() => undefined);
        }
    }

    private async claim(jobId?: string): Promise<ClaimedScheduleSolvePublication[]> {
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + this.leaseMs);
        const confirmedBefore = new Date(now.getTime() - this.confirmedPublicationRecoveryAgeMs);
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            return tx.$queryRaw<ClaimedScheduleSolvePublication[]>(Prisma.sql`
                WITH candidates AS (
                    SELECT "id"
                    FROM "ScheduleSolveJob"
                    WHERE "queuePayload" IS NOT NULL
                      AND "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
                      AND (${jobId ?? null}::text IS NULL OR "id" = ${jobId ?? null})
                      AND (
                        (
                          "publicationStatus" IN ('PENDING', 'FAILED')
                          AND "nextPublishAt" <= ${now}
                        )
                        OR (
                          "publicationStatus" = 'PUBLISHING'
                          AND "publishLeaseUntil" <= ${now}
                        )
                        OR (
                          "publicationStatus" = 'PUBLISHED'
                          AND (
                            (
                              "status" IN ('QUEUED', 'RETRYING')
                              AND "publishedAt" <= ${confirmedBefore}
                            )
                            OR (
                              "status" = 'RUNNING'
                              AND "updatedAt" <= ${confirmedBefore}
                            )
                          )
                        )
                      )
                    ORDER BY COALESCE("nextPublishAt", "publishedAt", "createdAt") ASC, "createdAt" ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT ${jobId ? 1 : this.batchSize}
                )
                UPDATE "ScheduleSolveJob" AS job
                SET
                    "publicationStatus" = 'PUBLISHING',
                    "queuePayload" = CASE
                        WHEN job."status" IN ('RUNNING', 'RETRYING')
                            THEN jsonb_set(job."queuePayload", '{retry_count}', to_jsonb(job."retryCount"), true)
                        ELSE job."queuePayload"
                    END,
                    "publishAttempts" = job."publishAttempts" + 1,
                    "publishLeaseUntil" = ${leaseUntil},
                    "publishLastError" = NULL,
                    "updatedAt" = ${now}
                FROM candidates
                WHERE job."id" = candidates."id"
                RETURNING job."id", job."tenantId", job."queuePayload", job."publishAttempts", job."createdAt"
            `);
        });
    }

    private async markPublished(publication: ClaimedScheduleSolvePublication): Promise<void> {
        await this.tenantDb.withTenant(publication.tenantId, (tx) => tx.$executeRaw`
            UPDATE "ScheduleSolveJob"
            SET
                "publicationStatus" = 'PUBLISHED',
                "publishedAt" = CURRENT_TIMESTAMP,
                "publishLeaseUntil" = NULL,
                "publishLastError" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${publication.id}
              AND "tenantId" = ${publication.tenantId}
              AND "publicationStatus" = 'PUBLISHING'
              AND "publishAttempts" = ${publication.publishAttempts}
        `);
    }

    private async markFailed(publication: ClaimedScheduleSolvePublication, error: unknown): Promise<void> {
        const message = this.errorMessage(error).slice(0, MAX_ERROR_LENGTH);
        if (this.isPermanentFailure(publication)) {
            await this.terminalizeFailedPublication(publication, message);
            return;
        }

        const retryAt = new Date(Date.now() + this.retryDelayMs(publication.publishAttempts));
        await this.tenantDb.withTenant(publication.tenantId, (tx) => tx.$executeRaw`
            UPDATE "ScheduleSolveJob"
            SET
                "publicationStatus" = 'FAILED',
                "nextPublishAt" = ${retryAt},
                "publishLeaseUntil" = NULL,
                "publishLastError" = ${message},
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${publication.id}
              AND "tenantId" = ${publication.tenantId}
              AND "publicationStatus" = 'PUBLISHING'
              AND "publishAttempts" = ${publication.publishAttempts}
        `);
    }

    private isPermanentFailure(publication: ClaimedScheduleSolvePublication): boolean {
        const createdAt = publication.createdAt instanceof Date
            ? publication.createdAt
            : new Date(publication.createdAt);
        const ageMs = Date.now() - createdAt.getTime();
        return publication.publishAttempts >= this.maxPublishAttempts
            || (Number.isFinite(ageMs) && ageMs >= this.maxPublicationAgeMs);
    }

    private async terminalizeFailedPublication(
        publication: ClaimedScheduleSolvePublication,
        message: string,
    ): Promise<void> {
        const statusReason = (
            `Schedule solve could not be published after ${publication.publishAttempts} attempts: ${message}`
        ).slice(0, MAX_STATUS_REASON_LENGTH);
        const refundId = `schedule-credit-refund-${publication.id}`;
        const refundReason = `Schedule generation refund (${publication.id})`;

        await this.tenantDb.withTenant(publication.tenantId, (tx) => tx.$executeRaw`
            WITH terminalized_job AS (
                UPDATE "ScheduleSolveJob"
                SET
                    "status" = 'FAILED',
                    "statusReason" = ${statusReason},
                    "publicationStatus" = 'FAILED',
                    "publishLeaseUntil" = NULL,
                    "publishLastError" = ${message},
                    "completedAt" = CURRENT_TIMESTAMP,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = ${publication.id}
                  AND "tenantId" = ${publication.tenantId}
                  AND "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
                  AND "publicationStatus" = 'PUBLISHING'
                  AND "publishAttempts" = ${publication.publishAttempts}
                RETURNING "tenantId", "creditConsumption"
            ), inserted_refund AS (
                INSERT INTO "CreditTransaction" ("id", "tenantId", "amount", "reason", "createdAt")
                SELECT
                    ${refundId},
                    "tenantId",
                    ("creditConsumption"->>'consumedCredits')::integer,
                    ${refundReason},
                    CURRENT_TIMESTAMP
                FROM terminalized_job
                WHERE "creditConsumption"->>'source' = 'credits'
                  AND jsonb_typeof("creditConsumption"->'consumedCredits') = 'number'
                  AND ("creditConsumption"->>'consumedCredits')::integer > 0
                ON CONFLICT ("id") DO NOTHING
                RETURNING "tenantId", "amount"
            )
            UPDATE "Tenant" tenant
            SET
                "usageCredits" = tenant."usageCredits" + inserted_refund."amount",
                "updatedAt" = CURRENT_TIMESTAMP
            FROM inserted_refund
            WHERE tenant."id" = inserted_refund."tenantId"
        `);
    }

    private retryDelayMs(attempt: number): number {
        return Math.min(60_000, 1_000 * (2 ** Math.max(0, Math.min(attempt - 1, 6))));
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(minimum, Math.min(maximum, parsed));
    }
}
