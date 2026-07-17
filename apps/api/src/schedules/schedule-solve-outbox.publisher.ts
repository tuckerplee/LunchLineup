import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as amqp from 'amqplib';
import type { ConfirmChannel } from 'amqplib';
import { runtimeErrorText } from '../common/runtime-error-diagnostic';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import {
    assertScheduleSolveCreditProvenance,
    ScheduleSolveCreditProvenanceError,
    summarizeScheduleSolveCreditRows,
    type ScheduleSolveCreditRow,
} from './schedule-solve-credit-provenance';

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
const DEFAULT_TRANSPORT_DEADLINE_MS = 10_000;
const MIN_TRANSPORT_DEADLINE_MS = 100;
const MAX_TRANSPORT_DEADLINE_MS = 60_000;
const MAX_ERROR_LENGTH = 1_000;
const MAX_STATUS_REASON_LENGTH = 512;
const DEFAULT_MAX_PUBLISH_ATTEMPTS = 8;
const MAX_PUBLISH_ATTEMPTS = 100;
const DEFAULT_MAX_PUBLICATION_AGE_MS = 24 * 60 * 60_000;
const MIN_MAX_PUBLICATION_AGE_MS = 60_000;
const MAX_MAX_PUBLICATION_AGE_MS = 7 * 24 * 60 * 60_000;
const INVALID_CREDIT_PROVENANCE_REASON = 'Schedule solve billing provenance is invalid';
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

type ScheduleSolveClaimCandidate = ClaimedScheduleSolvePublication & {
    status: string;
    creditConsumption: Prisma.JsonValue | null;
};

type ScheduleSolveCreditSettlementRow = ScheduleSolveCreditRow & {
    balanceAfter: number | bigint | null;
};

type ScheduleRefundOutcome = {
    jobStatus: string | null;
    liveExecutionLease: boolean | null;
    creditConsumption: Prisma.JsonValue | null;
    configuredAmount: number | bigint | null;
    debitCount: number | bigint;
    debitTenantId: string | null;
    debitAmount: number | bigint | null;
    debitReason: string | null;
    debitBalanceAfter: number | bigint | null;
    refundCount: number | bigint;
    refundTenantId: string | null;
    refundAmount: number | bigint | null;
    refundReason: string | null;
    refundBalanceAfter: number | bigint | null;
    terminalizedCount: number | bigint;
    insertedRefundCount: number | bigint;
    insertedRefundBalanceAfter: number | bigint | null;
    walletUpdateCount: number | bigint;
};

type ScheduleSolveOutboxPublisherOptions = {
    connect?: typeof amqp.connect;
    pollIntervalMs?: number;
    leaseMs?: number;
    batchSize?: number;
    maxPublishAttempts?: number;
    maxPublicationAgeMs?: number;
    confirmedPublicationRecoveryAgeMs?: number;
    transportDeadlineMs?: number;
};

type ScheduleSolveRabbitConnection = Awaited<ReturnType<typeof amqp.connect>>;

export class ScheduleSolveOutboxPublisher {
    private readonly logger = new Logger(ScheduleSolveOutboxPublisher.name);
    private readonly connect: typeof amqp.connect;
    private readonly pollIntervalMs: number;
    private readonly leaseMs: number;
    private readonly batchSize: number;
    private readonly maxPublishAttempts: number;
    private readonly maxPublicationAgeMs: number;
    private readonly confirmedPublicationRecoveryAgeMs: number;
    private readonly transportDeadlineMs: number;
    private timer?: NodeJS.Timeout;
    private activeSweep?: Promise<void>;
    private activeConnection?: ScheduleSolveRabbitConnection;
    private activeChannel?: ConfirmChannel;

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
        this.transportDeadlineMs = this.boundedInteger(
            options.transportDeadlineMs ?? process.env.SCHEDULE_OUTBOX_TRANSPORT_DEADLINE_MS,
            DEFAULT_TRANSPORT_DEADLINE_MS,
            MIN_TRANSPORT_DEADLINE_MS,
            MAX_TRANSPORT_DEADLINE_MS,
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
        const active = this.activeSweep;
        if (!active) return;
        const drained = await this.settlesBeforeDeadline(active, this.transportDeadlineMs);
        if (drained) return;
        this.forceDestroyTransport(this.activeChannel, this.activeConnection);
        this.logger.warn('Schedule outbox shutdown exceeded its transport deadline; the RabbitMQ socket was destroyed.');
        void active.catch(() => undefined);
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

        let connection: ScheduleSolveRabbitConnection | undefined;
        let channel: ConfirmChannel | undefined;
        try {
            const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
            const queueName = process.env.WORKER_QUEUE_NAME || DEFAULT_SCHEDULE_QUEUE;
            const dlqName = process.env.WORKER_DLQ_NAME || DEFAULT_SCHEDULE_DLQ;
            connection = await this.awaitTransport(
                Promise.resolve(this.connect(rabbitUrl)),
                'RabbitMQ connect',
            );
            this.activeConnection = connection;
            channel = await this.awaitTransport(
                Promise.resolve(connection.createConfirmChannel()),
                'RabbitMQ confirm channel creation',
            );
            this.activeChannel = channel;
            await this.awaitTransport(channel.assertQueue(dlqName, { durable: true }), 'RabbitMQ DLQ assertion');
            await this.awaitTransport(channel.assertQueue(queueName, {
                durable: true,
                arguments: {
                    'x-dead-letter-exchange': '',
                    'x-dead-letter-routing-key': dlqName,
                },
            }), 'RabbitMQ queue assertion');

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
                    await this.awaitTransport(channel.waitForConfirms(), 'RabbitMQ publisher confirm');
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
            await this.closeTransport(channel, connection);
            if (this.activeChannel === channel) this.activeChannel = undefined;
            if (this.activeConnection === connection) this.activeConnection = undefined;
        }
    }

    private async awaitTransport<T>(operation: PromiseLike<T> | T, label: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                this.forceDestroyTransport(this.activeChannel, this.activeConnection);
                reject(new Error(`${label} exceeded the bounded transport deadline.`));
            }, this.transportDeadlineMs);
            timer.unref();
        });
        try {
            return await Promise.race([Promise.resolve(operation), deadline]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async closeTransport(
        channel?: ConfirmChannel,
        connection?: ScheduleSolveRabbitConnection,
    ): Promise<void> {
        if (channel) {
            await this.awaitTransport(Promise.resolve(channel.close()), 'RabbitMQ channel close')
                .catch(() => this.forceDestroyTransport(channel, connection));
        }
        if (connection) {
            await this.awaitTransport(Promise.resolve(connection.close()), 'RabbitMQ connection close')
                .catch(() => this.forceDestroyTransport(channel, connection));
        }
    }

    private async settlesBeforeDeadline(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
            timer.unref();
        });
        try {
            return await Promise.race([operation.then(() => true, () => true), deadline]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private forceDestroyTransport(channel?: unknown, connection?: unknown): void {
        const candidates = [
            channel,
            connection,
            (channel as { connection?: unknown } | undefined)?.connection,
            (connection as { connection?: unknown } | undefined)?.connection,
        ];
        const destroyed = new Set<unknown>();
        for (const candidate of candidates) {
            const transport = candidate as {
                destroy?: () => void;
                socket?: { destroy?: () => void };
                stream?: { destroy?: () => void };
            } | undefined;
            for (const target of [transport, transport?.socket, transport?.stream]) {
                if (!target || destroyed.has(target) || typeof target.destroy !== 'function') continue;
                destroyed.add(target);
                try {
                    target.destroy();
                } catch {
                    // Best-effort socket teardown must never extend shutdown.
                }
            }
        }
    }

    private async claim(jobId?: string): Promise<ClaimedScheduleSolvePublication[]> {
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + this.leaseMs);
        const confirmedBefore = new Date(now.getTime() - this.confirmedPublicationRecoveryAgeMs);
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const candidates = await tx.$queryRaw<ScheduleSolveClaimCandidate[]>(Prisma.sql`
                SELECT
                    job."id",
                    job."tenantId",
                    job."queuePayload",
                    job."publishAttempts",
                    job."createdAt",
                    job."status",
                    job."creditConsumption"
                FROM "ScheduleSolveJob" job
                WHERE job."queuePayload" IS NOT NULL
                  AND job."status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
                  AND (${jobId ?? null}::text IS NULL OR job."id" = ${jobId ?? null})
                  AND (
                    (
                      job."publicationStatus" IN ('PENDING', 'FAILED')
                      AND job."nextPublishAt" <= ${now}
                    )
                    OR (
                      job."publicationStatus" = 'PUBLISHING'
                      AND job."publishLeaseUntil" <= ${now}
                    )
                    OR (
                      job."publicationStatus" = 'PUBLISHED'
                      AND (
                        (
                          job."status" IN ('QUEUED', 'RETRYING')
                          AND job."publishedAt" <= ${confirmedBefore}
                        )
                        OR (
                          job."status" = 'RUNNING'
                          AND job."updatedAt" <= ${confirmedBefore}
                        )
                      )
                    )
                  )
                ORDER BY COALESCE(job."nextPublishAt", job."publishedAt", job."createdAt") ASC, job."createdAt" ASC
                FOR UPDATE OF job SKIP LOCKED
                LIMIT ${jobId ? 1 : this.batchSize}
            `);
            if (candidates.length === 0) return [];

            const creditIds = candidates.flatMap((candidate) => [
                `schedule-credit-${candidate.id}`,
                `schedule-credit-refund-${candidate.id}`,
            ]);
            const creditRows = await tx.$queryRaw<ScheduleSolveCreditSettlementRow[]>(Prisma.sql`
                SELECT "id", "tenantId", "amount", "reason", "balanceAfter"
                FROM "CreditTransaction"
                WHERE "id" IN (${Prisma.join(creditIds)})
                ORDER BY "id" ASC
                FOR UPDATE
            `);
            const validCandidates: ScheduleSolveClaimCandidate[] = [];
            const invalidCandidates: ScheduleSolveClaimCandidate[] = [];
            for (const candidate of candidates) {
                try {
                    const provenance = assertScheduleSolveCreditProvenance({
                        jobId: candidate.id,
                        tenantId: candidate.tenantId,
                        status: candidate.status,
                        creditConsumption: candidate.creditConsumption,
                        ...summarizeScheduleSolveCreditRows(candidate.id, creditRows),
                    });
                    const debitRows = creditRows.filter(
                        (row) => row.id === `schedule-credit-${candidate.id}`,
                    );
                    if (debitRows.length !== 1
                        || this.nonnegativeIntegerValue(debitRows[0].balanceAfter) !== provenance.newBalance) {
                        throw new ScheduleSolveCreditProvenanceError(
                            'Schedule solve debit settlement balance is invalid.',
                        );
                    }
                    validCandidates.push(candidate);
                } catch (error) {
                    if (!(error instanceof ScheduleSolveCreditProvenanceError)) throw error;
                    invalidCandidates.push(candidate);
                }
            }
            for (const candidate of invalidCandidates) {
                const retryAt = new Date(now.getTime() + this.maxPublicationAgeMs);
                await tx.$executeRaw(Prisma.sql`
                    UPDATE "ScheduleSolveJob"
                    SET
                        "publicationStatus" = 'FAILED',
                        "nextPublishAt" = ${retryAt},
                        "publishLeaseUntil" = NULL,
                        "publishLastError" = ${INVALID_CREDIT_PROVENANCE_REASON},
                        "updatedAt" = ${now}
                    WHERE "id" = ${candidate.id}
                      AND "tenantId" = ${candidate.tenantId}
                      AND "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
                `);
            }
            if (validCandidates.length === 0) return [];

            const candidateIds = validCandidates.map((candidate) => candidate.id);
            return tx.$queryRaw<ClaimedScheduleSolvePublication[]>(Prisma.sql`
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
                WHERE job."id" IN (${Prisma.join(candidateIds)})
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
            if (await this.hasLiveExecutionLease(publication)) return;
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

    private async hasLiveExecutionLease(publication: ClaimedScheduleSolvePublication): Promise<boolean> {
        const rows = await this.tenantDb.withTenant(publication.tenantId, (tx) => tx.$queryRaw<Array<{
            hasLiveExecutionLease: boolean;
        }>>(Prisma.sql`
            SELECT EXISTS (
                SELECT 1
                FROM "ScheduleSolveJob" job
                WHERE job."id" = ${publication.id}
                  AND job."tenantId" = ${publication.tenantId}
                  AND job."executionToken" IS NOT NULL
                  AND job."executionLeaseUntil" > CURRENT_TIMESTAMP
            ) AS "hasLiveExecutionLease"
        `));
        return rows[0]?.hasLiveExecutionLease === true;
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

        await this.tenantDb.withTenant(publication.tenantId, async (tx) => {
            await tx.$queryRaw(Prisma.sql`
                SELECT "id"
                FROM "Tenant"
                WHERE "id" = ${publication.tenantId}
                FOR UPDATE
            `);
            const outcomes = await tx.$queryRaw<ScheduleRefundOutcome[]>(Prisma.sql`
            WITH locked_job AS MATERIALIZED (
                SELECT
                    job."id",
                    job."tenantId",
                    job."status",
                    job."executionToken",
                    job."executionLeaseUntil",
                    job."executionToken" IS NOT NULL
                        AND job."executionLeaseUntil" > CURRENT_TIMESTAMP AS "liveExecutionLease",
                    job."creditConsumption",
                    CASE
                        WHEN jsonb_typeof(job."creditConsumption") = 'object'
                         AND job."creditConsumption" = jsonb_build_object(
                            'consumedCredits', job."creditConsumption"->'consumedCredits',
                            'newBalance', job."creditConsumption"->'newBalance',
                            'source', job."creditConsumption"->'source'
                         )
                         AND job."creditConsumption"->>'source' = 'credits'
                         AND jsonb_typeof(job."creditConsumption"->'consumedCredits') = 'number'
                         AND job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'
                         AND jsonb_typeof(job."creditConsumption"->'newBalance') = 'number'
                         AND job."creditConsumption"->>'newBalance' ~ '^(0|[1-9][0-9]*)$'
                         AND (job."creditConsumption"->>'newBalance')::numeric <= 2147483647
                         AND (job."creditConsumption"->>'consumedCredits')::numeric
                             <= 2147483647 - (job."creditConsumption"->>'newBalance')::numeric
                        THEN CASE
                            WHEN (job."creditConsumption"->>'consumedCredits')::numeric <= 2147483647
                            THEN (job."creditConsumption"->>'consumedCredits')::integer
                            ELSE NULL
                        END
                        ELSE NULL
                    END AS "configuredAmount"
                FROM "ScheduleSolveJob" job
                WHERE job."id" = ${publication.id}
                  AND job."tenantId" = ${publication.tenantId}
                FOR UPDATE
            ), debit_rows AS MATERIALIZED (
                SELECT debit."tenantId", debit."amount", debit."reason", debit."balanceAfter"
                FROM "CreditTransaction" debit
                JOIN locked_job job
                  ON debit."id" = 'schedule-credit-' || job."id"
            ), refund_rows AS MATERIALIZED (
                SELECT refund."tenantId", refund."amount", refund."reason", refund."balanceAfter"
                FROM "CreditTransaction" refund
                JOIN locked_job job
                  ON refund."id" = ${refundId}
            ), valid_provenance AS (
                SELECT job."id", job."tenantId", debit."amount" AS "debitAmount"
                FROM locked_job job
                JOIN debit_rows debit ON TRUE
                WHERE (SELECT COUNT(*) FROM debit_rows) = 1
                  AND job."configuredAmount" IS NOT NULL
                  AND debit."tenantId" = job."tenantId"
                  AND debit."amount" = -job."configuredAmount"
                  AND debit."reason" = 'Schedule generation (' || job."id" || ')'
                  AND debit."balanceAfter" = (job."creditConsumption"->>'newBalance')::integer
                  AND (SELECT COUNT(*) FROM refund_rows) = 0
                  AND (
                    job."executionToken" IS NULL
                    OR job."executionLeaseUntil" <= CURRENT_TIMESTAMP
                  )
            ), terminalized_job AS (
                UPDATE "ScheduleSolveJob" job
                SET
                    "status" = 'FAILED',
                    "statusReason" = ${statusReason},
                    "publicationStatus" = 'FAILED',
                    "publishLeaseUntil" = NULL,
                    "publishLastError" = ${message},
                    "completedAt" = CURRENT_TIMESTAMP,
                    "updatedAt" = CURRENT_TIMESTAMP
                FROM valid_provenance provenance
                WHERE job."id" = provenance."id"
                  AND job."tenantId" = provenance."tenantId"
                  AND job."status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
                  AND job."publicationStatus" = 'PUBLISHING'
                  AND job."publishAttempts" = ${publication.publishAttempts}
                  AND (
                    job."executionToken" IS NULL
                    OR job."executionLeaseUntil" <= CURRENT_TIMESTAMP
                  )
                RETURNING job."id", job."tenantId"
            ), updated_wallet AS (
                UPDATE "Tenant" tenant
                SET
                    "usageCredits" = tenant."usageCredits" - provenance."debitAmount",
                    "updatedAt" = CURRENT_TIMESTAMP
                FROM terminalized_job terminalized
                JOIN valid_provenance provenance ON provenance."id" = terminalized."id"
                WHERE tenant."id" = terminalized."tenantId"
                RETURNING
                    tenant."id" AS "tenantId",
                    -provenance."debitAmount" AS "amount",
                    tenant."usageCredits" AS "balanceAfter"
            ), inserted_refund AS (
                INSERT INTO "CreditTransaction" (
                    "id", "tenantId", "amount", "reason", "balanceAfter", "createdAt"
                )
                SELECT
                    ${refundId},
                    wallet."tenantId",
                    wallet."amount",
                    ${refundReason},
                    wallet."balanceAfter",
                    CURRENT_TIMESTAMP
                FROM updated_wallet wallet
                ON CONFLICT ("id") DO NOTHING
                RETURNING "tenantId", "amount", "balanceAfter"
            )
            SELECT
                (SELECT "status" FROM locked_job) AS "jobStatus",
                (SELECT "liveExecutionLease" FROM locked_job) AS "liveExecutionLease",
                (SELECT "creditConsumption" FROM locked_job) AS "creditConsumption",
                (SELECT "configuredAmount" FROM locked_job) AS "configuredAmount",
                (SELECT COUNT(*)::integer FROM debit_rows) AS "debitCount",
                (SELECT MIN("tenantId") FROM debit_rows) AS "debitTenantId",
                (SELECT MIN("amount") FROM debit_rows) AS "debitAmount",
                (SELECT MIN("reason") FROM debit_rows) AS "debitReason",
                (SELECT MIN("balanceAfter") FROM debit_rows) AS "debitBalanceAfter",
                (SELECT COUNT(*)::integer FROM refund_rows) AS "refundCount",
                (SELECT MIN("tenantId") FROM refund_rows) AS "refundTenantId",
                (SELECT MIN("amount") FROM refund_rows) AS "refundAmount",
                (SELECT MIN("reason") FROM refund_rows) AS "refundReason",
                (SELECT MIN("balanceAfter") FROM refund_rows) AS "refundBalanceAfter",
                (SELECT COUNT(*)::integer FROM terminalized_job) AS "terminalizedCount",
                (SELECT COUNT(*)::integer FROM inserted_refund) AS "insertedRefundCount",
                (SELECT MIN("balanceAfter") FROM inserted_refund) AS "insertedRefundBalanceAfter",
                (SELECT COUNT(*)::integer FROM updated_wallet) AS "walletUpdateCount"
            `);
            this.assertScheduleRefundOutcome(outcomes[0], publication);
        });
    }

    private assertScheduleRefundOutcome(
        outcome: ScheduleRefundOutcome | undefined,
        publication: ClaimedScheduleSolvePublication,
    ): void {
        if (!outcome?.jobStatus) {
            throw new Error('Schedule solve refund job ownership was lost.');
        }
        const provenance = assertScheduleSolveCreditProvenance({
            jobId: publication.id,
            tenantId: publication.tenantId,
            status: outcome.jobStatus,
            creditConsumption: outcome.creditConsumption,
            debit: {
                count: outcome.debitCount,
                tenantId: outcome.debitTenantId,
                amount: outcome.debitAmount,
                reason: outcome.debitReason,
            },
            refund: {
                count: outcome.refundCount,
                tenantId: outcome.refundTenantId,
                amount: outcome.refundAmount,
                reason: outcome.refundReason,
            },
        });
        if (this.nonnegativeIntegerValue(outcome.debitBalanceAfter) !== provenance.newBalance) {
            throw new Error('Schedule solve debit settlement balance is invalid.');
        }
        if (this.integerValue(outcome.refundCount) === 1
            && this.nonnegativeIntegerValue(outcome.refundBalanceAfter) === null) {
            throw new Error('Schedule solve refund settlement balance is invalid.');
        }
        if (outcome.jobStatus === 'SUCCEEDED'
            || outcome.jobStatus === 'FAILED'
            || outcome.jobStatus === 'DEAD_LETTERED') return;
        if (outcome.liveExecutionLease === true) return;
        if (this.integerValue(outcome.terminalizedCount) !== 1) {
            throw new Error('Schedule solve refund job ownership was lost.');
        }
        if (
            this.integerValue(outcome.insertedRefundCount) !== 1
            || this.integerValue(outcome.walletUpdateCount) !== 1
            || this.nonnegativeIntegerValue(outcome.insertedRefundBalanceAfter) === null
        ) {
            throw new Error('Schedule solve refund settlement failed.');
        }
    }

    private integerValue(value: number | bigint | null): number | null {
        if (value === null) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }

    private nonnegativeIntegerValue(value: number | bigint | null): number | null {
        const parsed = this.integerValue(value);
        return parsed !== null && parsed >= 0 ? parsed : null;
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
