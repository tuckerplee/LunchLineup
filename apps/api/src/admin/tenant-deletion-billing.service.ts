import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, TenantStatus, WebhookDeliveryStatus } from '@prisma/client';
import type { StripeService } from '../billing/stripe.service';
import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import type { TenantLifecycleActor } from './tenant-account-lifecycle.service';
import {
    TENANT_RETENTION_POLICY,
    assertTenantSlugConfirmation,
    buildTenantRetentionSchedule,
    normalizeTenantConfirmation,
} from './tenant-account-lifecycle';

type RequestTenantDeletionBody = {
    confirmation?: unknown;
};

type TenantDeletionResult = {
    id: string;
    slug: string;
    status: TenantStatus | string;
    deletionState: 'FINALIZED' | 'PENDING_BILLING_CLEANUP';
    billingCleanupPending: boolean;
    deletionRequestedAt: Date;
    retention: ReturnType<typeof buildTenantRetentionSchedule>;
    retainedRecords: string[];
};

export type PendingTenantDeletionBillingCandidate = {
    id: string;
    deletionRequestedAt: Date;
};

export type ClaimedTenantDeletionBillingCandidate = {
    tenantId: string;
    operationId: string;
    leaseOwner: string;
    leaseToken: string;
};

export type TenantDeletionBillingReconciliationAttempt =
    | { outcome: 'processed'; tenantId: string; result: TenantDeletionResult }
    | { outcome: 'skipped'; tenantId: string; reason: string }
    | { outcome: 'failed'; tenantId: string; error: string };

export type TenantDeletionBillingBacklog = {
    count: number;
    oldestPendingAt: Date | null;
};

export type TenantDeletionBillingAttemptControlOutcome =
    | 'deadline_exceeded'
    | 'stopped';

type TenantDeletionBillingFailureCode =
    | 'PROVIDER_OR_FINALIZATION_FAILED'
    | 'PROVIDER_ATTEMPT_DEADLINE_EXCEEDED'
    | 'RECONCILER_STOPPED';

export class TenantDeletionBillingAttemptControlError extends Error {
    constructor(
        readonly outcome: TenantDeletionBillingAttemptControlOutcome,
        readonly failureCode: TenantDeletionBillingFailureCode,
        message: string,
    ) {
        super(message);
        this.name = TenantDeletionBillingAttemptControlError.name;
    }
}

export type TenantDeletionBillingProviderAttemptContext = Readonly<{
    operationId: string;
    signal: AbortSignal;
    providerDeadlineAtMs: number;
}>;

type TenantDeletionBarrier = {
    tenantId: string;
    auditId: string;
    slug: string;
    userId: string | null;
    actorUserId: string | null;
    actorTenantId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
};

type TenantBillingPurgeResult = Awaited<ReturnType<StripeService['finalizeTenantBillingForPurge']>>;

type TenantBillingFinalizer = {
    finalizeTenantBillingForPurge(
        tenantId: string,
        context: TenantDeletionBillingProviderAttemptContext,
    ): Promise<TenantBillingPurgeResult>;
};

type TenantDeletionBillingServiceOptions = {
    leaseMs?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    providerAttemptTimeoutMs?: number;
};

type TenantDeletionPaidWorkSettlementOutcome = {
    candidateCount: number | bigint;
    insertedCount: number | bigint;
    walletUpdateCount: number | bigint;
};

export class TenantDeletionBillingService {
    static readonly TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 60_000 } as const;
    private static readonly DEFAULT_LEASE_MS = 2 * 60_000;
    private static readonly DEFAULT_RETRY_BASE_MS = 30_000;
    private static readonly DEFAULT_RETRY_MAX_MS = 6 * 60 * 60_000;
    private static readonly DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS = 90_000;

    private readonly leaseMs: number;
    private readonly retryBaseMs: number;
    private readonly retryMaxMs: number;
    private readonly providerAttemptTimeoutMs: number;

    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly stripeBilling: () => TenantBillingFinalizer,
        options: TenantDeletionBillingServiceOptions = {},
    ) {
        this.leaseMs = this.boundedInteger(
            options.leaseMs,
            TenantDeletionBillingService.DEFAULT_LEASE_MS,
            100,
            10 * 60_000,
        );
        this.retryBaseMs = this.boundedInteger(
            options.retryBaseMs,
            TenantDeletionBillingService.DEFAULT_RETRY_BASE_MS,
            1_000,
            60 * 60_000,
        );
        this.retryMaxMs = this.boundedInteger(
            options.retryMaxMs,
            TenantDeletionBillingService.DEFAULT_RETRY_MAX_MS,
            this.retryBaseMs,
            24 * 60 * 60_000,
        );
        this.providerAttemptTimeoutMs = this.boundedInteger(
            options.providerAttemptTimeoutMs,
            TenantDeletionBillingService.DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS,
            50,
            15 * 60_000,
        );
    }

    async listPendingDeletionBillingCandidates(limit: number): Promise<PendingTenantDeletionBillingCandidate[]> {
        const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 25;
        const now = new Date();
        const tenants = await this.tenantDb.withPlatformAdmin((tx) => tx.tenant.findMany({
            where: {
                status: TenantStatus.SUSPENDED,
                deletedAt: null,
                deletionBillingReconciliation: {
                    is: {
                        state: 'PENDING',
                        nextAttemptAt: { lte: now },
                        OR: [
                            { leaseOwner: null },
                            { leaseExpiresAt: { lte: now } },
                        ],
                    },
                },
                auditLogs: {
                    some: {
                        action: 'TENANT_DELETION_BARRIER_COMMITTED',
                        resource: 'Tenant',
                    },
                },
            },
            orderBy: [
                { deletionBillingReconciliation: { nextAttemptAt: 'asc' } },
                { deletionBillingReconciliation: { barrierCreatedAt: 'asc' } },
                { id: 'asc' },
            ],
            take: boundedLimit,
            select: {
                id: true,
                auditLogs: {
                    where: {
                        action: 'TENANT_DELETION_BARRIER_COMMITTED',
                        resource: 'Tenant',
                    },
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    take: 1,
                    select: { createdAt: true },
                },
            },
        }), TenantDeletionBillingService.TRANSACTION_OPTIONS);

        return tenants.flatMap((tenant) => {
            const barrier = tenant.auditLogs[0];
            return barrier ? [{ id: tenant.id, deletionRequestedAt: barrier.createdAt }] : [];
        });
    }

    async reconcilePendingDeletionBillingCandidate(
        tenantId: string,
    ): Promise<TenantDeletionBillingReconciliationAttempt> {
        let claim: ClaimedTenantDeletionBillingCandidate | null = null;
        try {
            claim = await this.claimPendingDeletionBillingCandidate(tenantId, true);
        } catch {
            return {
                outcome: 'failed',
                tenantId,
                error: 'Tenant deletion billing reconciliation failed.',
            };
        }
        if (!claim) {
            return { outcome: 'skipped', tenantId, reason: 'Tenant deletion billing barrier is not eligible or is already claimed.' };
        }

        try {
            return await this.reconcileClaimedDeletionBillingCandidate(claim);
        } catch {
            return {
                outcome: 'failed',
                tenantId,
                error: 'Tenant deletion billing reconciliation failed.',
            };
        }
    }

    async claimEligibleDeletionBillingCandidates(
        limit: number,
        excludedTenantIds: readonly string[] = [],
    ): Promise<ClaimedTenantDeletionBillingCandidate[]> {
        const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 25;
        const now = new Date();
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const exclusion = excludedTenantIds.length > 0
                ? Prisma.sql`AND reconciliation."tenantId" NOT IN (${Prisma.join(excludedTenantIds)})`
                : Prisma.empty;
            const candidates = await tx.$queryRaw<Array<{ tenantId: string }>>(Prisma.sql`
                SELECT reconciliation."tenantId"
                FROM "TenantDeletionBillingReconciliation" reconciliation
                JOIN "Tenant" tenant ON tenant."id" = reconciliation."tenantId"
                WHERE reconciliation."state" = 'PENDING'::"TenantDeletionBillingReconciliationState"
                  AND reconciliation."nextAttemptAt" <= ${now}
                  AND (
                    reconciliation."leaseOwner" IS NULL
                    OR reconciliation."leaseExpiresAt" <= ${now}
                  )
                  AND tenant."status" = 'SUSPENDED'::"TenantStatus"
                  AND tenant."deletedAt" IS NULL
                  ${exclusion}
                ORDER BY reconciliation."nextAttemptAt", reconciliation."barrierCreatedAt", reconciliation."tenantId"
                LIMIT ${boundedLimit}
                FOR UPDATE OF reconciliation SKIP LOCKED
            `);
            const claims: ClaimedTenantDeletionBillingCandidate[] = [];
            for (const candidate of candidates) {
                const claim = await this.claimPendingDeletionBillingCandidateInTransaction(
                    tx,
                    candidate.tenantId,
                    now,
                );
                if (claim) claims.push(claim);
            }
            return claims;
        }, TenantDeletionBillingService.TRANSACTION_OPTIONS);
    }

    async countPendingDeletionBillingCandidates(): Promise<number> {
        return (await this.readPendingDeletionBillingBacklog()).count;
    }

    async readPendingDeletionBillingBacklog(): Promise<TenantDeletionBillingBacklog> {
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const rows = await tx.$queryRaw<Array<{
                count: bigint | number;
                oldestPendingAt: Date | null;
            }>>`
                SELECT
                    COUNT(*) AS "count",
                    MIN(reconciliation."barrierCreatedAt") AS "oldestPendingAt"
                FROM "TenantDeletionBillingReconciliation" reconciliation
                JOIN "Tenant" tenant ON tenant."id" = reconciliation."tenantId"
                WHERE reconciliation."state" = 'PENDING'::"TenantDeletionBillingReconciliationState"
                  AND tenant."status" = 'SUSPENDED'::"TenantStatus"
                  AND tenant."deletedAt" IS NULL
            `;
            return {
                count: Number(rows[0]?.count ?? 0),
                oldestPendingAt: rows[0]?.oldestPendingAt ?? null,
            };
        }, TenantDeletionBillingService.TRANSACTION_OPTIONS);
    }

    async reconcileClaimedDeletionBillingCandidate(
        claim: ClaimedTenantDeletionBillingCandidate,
        signal?: AbortSignal,
    ): Promise<Extract<TenantDeletionBillingReconciliationAttempt, { outcome: 'processed' }>> {
        const barrier = await this.readPendingDeletionBarrier(claim.tenantId);
        if (!barrier) {
            await this.recordReconciliationFailure(claim, true).catch(() => undefined);
            throw new ConflictException('Tenant deletion billing barrier is no longer pending.');
        }
        if (claim.operationId !== this.reconciliationOperationId(barrier)) {
            await this.recordReconciliationFailure(claim, true).catch(() => undefined);
            throw new ConflictException('Tenant deletion billing reconciliation operation does not match the active barrier.');
        }
        try {
            return await this.runClaimedDeletionBillingReconciliation(claim, barrier, true, signal);
        } catch (error) {
            await this.recordReconciliationFailure(
                claim,
                true,
                this.reconciliationFailureCode(error),
            ).catch(() => undefined);
            if (error instanceof TenantDeletionBillingAttemptControlError) throw error;
            throw new ConflictException('Tenant deletion billing reconciliation failed.');
        }
    }

    async requestDeletion(actor: TenantLifecycleActor, body: RequestTenantDeletionBody) {
        const confirmation = normalizeTenantConfirmation(body?.confirmation);
        const barrierCommittedAt = new Date();
        const barrierAuditId = randomUUID();
        const phaseOne = await this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            await this.lockTenantDeletion(tx, actor.tenantId);
            const tenant = await tx.tenant.findUniqueOrThrow({
                where: { id: actor.tenantId },
                select: { id: true, slug: true, status: true, deletedAt: true },
            });
            assertTenantSlugConfirmation(confirmation, tenant.slug);

            if (tenant.status === TenantStatus.PURGED) {
                if (!tenant.deletedAt) {
                    throw new ConflictException('Finalized tenant deletion is missing its request timestamp.');
                }
                return { state: 'finalized' as const, tenant, requestedAt: tenant.deletedAt };
            }

            const existingBarrierAudit = await tx.auditLog.findFirst({
                where: {
                    tenantId: actor.tenantId,
                    action: 'TENANT_DELETION_BARRIER_COMMITTED',
                    resource: 'Tenant',
                    resourceId: actor.tenantId,
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                    id: true,
                    userId: true,
                    actorUserId: true,
                    actorTenantId: true,
                    ipAddress: true,
                    userAgent: true,
                    createdAt: true,
                },
            });
            if (tenant.status === TenantStatus.SUSPENDED && !tenant.deletedAt && existingBarrierAudit) {
                const barrier: TenantDeletionBarrier = {
                    tenantId: actor.tenantId,
                    auditId: existingBarrierAudit.id,
                    slug: tenant.slug,
                    userId: existingBarrierAudit.userId,
                    actorUserId: existingBarrierAudit.actorUserId,
                    actorTenantId: existingBarrierAudit.actorTenantId,
                    ipAddress: existingBarrierAudit.ipAddress,
                    userAgent: existingBarrierAudit.userAgent,
                    createdAt: existingBarrierAudit.createdAt,
                };
                await this.ensureReconciliationState(tx, barrier);
                return {
                    state: 'pending' as const,
                    barrier,
                    claim: await this.claimPendingDeletionBillingCandidateInTransaction(
                        tx,
                        actor.tenantId,
                        barrierCommittedAt,
                    ),
                };
            }

            if (tenant.status !== TenantStatus.SUSPENDED || tenant.deletedAt) {
                await tx.tenant.update({
                    where: { id: actor.tenantId },
                    data: { status: TenantStatus.SUSPENDED, deletedAt: null },
                    select: { id: true, slug: true, status: true, deletedAt: true },
                });
            }

            await tx.session.updateMany({
                where: { user: { tenantId: actor.tenantId }, revokedAt: null },
                data: { revokedAt: barrierCommittedAt },
            });
            await tx.webhookEndpoint.updateMany({
                where: { tenantId: actor.tenantId, active: true },
                data: { active: false },
            });
            await tx.webhookDelivery.updateMany({
                where: {
                    tenantId: actor.tenantId,
                    status: {
                        in: [
                            WebhookDeliveryStatus.PENDING,
                            WebhookDeliveryStatus.QUEUED,
                            WebhookDeliveryStatus.SENDING,
                            WebhookDeliveryStatus.FAILED,
                        ],
                    },
                },
                data: {
                    status: WebhookDeliveryStatus.DEAD_LETTERED,
                    nextAttemptAt: null,
                    lastError: 'Tenant account deletion requested',
                },
            });
            await this.terminalizePaidWorkForDeletion(tx, actor.tenantId, barrierCommittedAt);

            await tx.auditLog.create({
                data: {
                    id: barrierAuditId,
                    tenantId: actor.tenantId,
                    userId: actor.userId,
                    actorUserId: actor.userId,
                    actorTenantId: actor.tenantId,
                    action: 'TENANT_DELETION_BARRIER_COMMITTED',
                    resource: 'Tenant',
                    resourceId: actor.tenantId,
                    newValue: {
                        status: TenantStatus.SUSPENDED,
                        barrierCommittedAt,
                        access: 'Sessions revoked and new billable work disabled.',
                        paidWorkSettlement: 'Queued and in-flight schedule generation was terminalized with exactly-once wallet refunds.',
                    },
                    ipAddress: actor.ipAddress,
                    userAgent: actor.userAgent,
                    createdAt: barrierCommittedAt,
                },
            });
            const barrier: TenantDeletionBarrier = {
                tenantId: actor.tenantId,
                auditId: barrierAuditId,
                slug: tenant.slug,
                userId: actor.userId ?? null,
                actorUserId: actor.userId ?? null,
                actorTenantId: actor.tenantId,
                ipAddress: actor.ipAddress ?? null,
                userAgent: actor.userAgent ?? null,
                createdAt: barrierCommittedAt,
            };
            await this.ensureReconciliationState(tx, barrier);
            return {
                state: 'pending' as const,
                barrier,
                claim: await this.claimPendingDeletionBillingCandidateInTransaction(
                    tx,
                    actor.tenantId,
                    barrierCommittedAt,
                ),
            };
        }, TenantDeletionBillingService.TRANSACTION_OPTIONS);

        if (phaseOne.state === 'finalized') {
            return this.serializeDeletionResult(phaseOne.tenant, phaseOne.requestedAt);
        }
        if (!phaseOne.claim) {
            return this.serializePendingDeletionResult(phaseOne.barrier);
        }

        try {
            const reconciled = await this.runClaimedDeletionBillingReconciliation(
                phaseOne.claim,
                phaseOne.barrier,
                false,
            );
            return reconciled.result;
        } catch (error) {
            await this.recordReconciliationFailure(
                phaseOne.claim,
                false,
                this.reconciliationFailureCode(error),
            ).catch(() => undefined);
            return this.serializePendingDeletionResult(phaseOne.barrier);
        }
    }

    private async ensureReconciliationState(
        tx: TenantPrismaTransaction,
        barrier: TenantDeletionBarrier,
    ): Promise<void> {
        const operationId = this.reconciliationOperationId(barrier);
        await tx.$executeRaw`
            INSERT INTO "TenantDeletionBillingReconciliation" (
                "tenantId", "operationId", "barrierCreatedAt", "state",
                "attemptCount", "nextAttemptAt", "createdAt", "updatedAt"
            )
            VALUES (
                ${barrier.tenantId}, ${operationId}, ${barrier.createdAt},
                'PENDING'::"TenantDeletionBillingReconciliationState",
                0, ${barrier.createdAt}, ${barrier.createdAt}, ${barrier.createdAt}
            )
            ON CONFLICT ("tenantId") DO NOTHING
        `;
        const matched = await tx.$executeRaw`
            UPDATE "TenantDeletionBillingReconciliation"
            SET "updatedAt" = "updatedAt"
            WHERE "tenantId" = ${barrier.tenantId}
              AND "operationId" = ${operationId}
              AND "barrierCreatedAt" = ${barrier.createdAt}
              AND "state" = 'PENDING'::"TenantDeletionBillingReconciliationState"
        `;
        if (matched !== 1) {
            throw new ConflictException('Tenant deletion billing reconciliation state does not match the active barrier.');
        }
    }

    private async claimPendingDeletionBillingCandidate(
        tenantId: string,
        platformAdmin: boolean,
    ): Promise<ClaimedTenantDeletionBillingCandidate | null> {
        const now = new Date();
        const claim = (tx: TenantPrismaTransaction) => (
            this.claimPendingDeletionBillingCandidateInTransaction(tx, tenantId, now)
        );
        return platformAdmin
            ? this.tenantDb.withPlatformAdmin(claim, TenantDeletionBillingService.TRANSACTION_OPTIONS)
            : this.tenantDb.withTenant(tenantId, claim, TenantDeletionBillingService.TRANSACTION_OPTIONS);
    }

    private async claimPendingDeletionBillingCandidateInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        now: Date,
    ): Promise<ClaimedTenantDeletionBillingCandidate | null> {
        const leaseOwner = randomUUID();
        const leaseToken = randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
        const claimed = await tx.$queryRaw<Array<{ operationId: string }>>`
            UPDATE "TenantDeletionBillingReconciliation" reconciliation
            SET
                "leaseOwner" = ${leaseOwner},
                "leaseToken" = ${leaseToken},
                "leaseExpiresAt" = ${leaseExpiresAt},
                "attemptCount" = reconciliation."attemptCount" + 1,
                "lastAttemptAt" = ${now},
                "updatedAt" = ${now}
            FROM "Tenant" tenant
            WHERE reconciliation."tenantId" = ${tenantId}
              AND tenant."id" = reconciliation."tenantId"
              AND tenant."status" = 'SUSPENDED'::"TenantStatus"
              AND tenant."deletedAt" IS NULL
              AND reconciliation."state" = 'PENDING'::"TenantDeletionBillingReconciliationState"
              AND reconciliation."nextAttemptAt" <= ${now}
              AND (
                reconciliation."leaseOwner" IS NULL
                OR reconciliation."leaseExpiresAt" <= ${now}
              )
            RETURNING reconciliation."operationId"
        `;
        const operationId = claimed[0]?.operationId;
        return operationId ? { tenantId, operationId, leaseOwner, leaseToken } : null;
    }

    private async runClaimedDeletionBillingReconciliation(
        claim: ClaimedTenantDeletionBillingCandidate,
        barrier: TenantDeletionBarrier,
        platformAdmin: boolean,
        signal?: AbortSignal,
    ): Promise<Extract<TenantDeletionBillingReconciliationAttempt, { outcome: 'processed' }>> {
        const billingPurge = await this.withClaimHeartbeat(
            claim,
            platformAdmin,
            (providerSignal, providerDeadlineAtMs) =>
                this.stripeBilling().finalizeTenantBillingForPurge(claim.tenantId, {
                    operationId: claim.operationId,
                    signal: providerSignal,
                    providerDeadlineAtMs,
                }),
            signal,
        );
        this.throwIfAttemptStopped(signal);
        const tenant = await this.finalizeDeletionBarrier(
            barrier,
            billingPurge,
            platformAdmin,
            claim,
        );
        return {
            outcome: 'processed',
            tenantId: claim.tenantId,
            result: this.serializeDeletionResult(tenant, barrier.createdAt),
        };
    }

    private async withClaimHeartbeat<T>(
        claim: ClaimedTenantDeletionBillingCandidate,
        platformAdmin: boolean,
        operation: (
            providerSignal: AbortSignal,
            providerDeadlineAtMs: number,
        ) => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        this.throwIfAttemptStopped(signal);
        await this.renewClaim(claim, platformAdmin);
        this.throwIfAttemptStopped(signal);

        const providerAbort = new AbortController();
        const abortProvider = (error: unknown) => {
            if (!providerAbort.signal.aborted) providerAbort.abort(error);
        };

        const intervalMs = Math.max(25, Math.floor(this.leaseMs / 3));
        let renewal: Promise<void> | undefined;
        let rejectClaimLoss!: (error: unknown) => void;
        const claimLoss = new Promise<never>((_resolve, reject) => {
            rejectClaimLoss = reject;
        });
        const timer = setInterval(() => {
            if (renewal) return;
            renewal = this.renewClaim(claim, platformAdmin)
                .catch((error) => {
                    rejectClaimLoss(error);
                    abortProvider(error);
                })
                .finally(() => { renewal = undefined; });
        }, intervalMs);
        timer.unref();

        const providerDeadlineAtMs = Date.now() + this.providerAttemptTimeoutMs;
        let deadlineTimer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            deadlineTimer = setTimeout(() => {
                const error = new TenantDeletionBillingAttemptControlError(
                    'deadline_exceeded',
                    'PROVIDER_ATTEMPT_DEADLINE_EXCEEDED',
                    'Tenant deletion billing provider attempt exceeded its deadline.',
                );
                reject(error);
                abortProvider(error);
            }, this.providerAttemptTimeoutMs);
            deadlineTimer.unref();
        });
        let removeAbortListener: () => void = () => undefined;
        const stopped = new Promise<never>((_resolve, reject) => {
            if (!signal) return;
            const onAbort = () => {
                const error = new TenantDeletionBillingAttemptControlError(
                    'stopped',
                    'RECONCILER_STOPPED',
                    'Tenant deletion billing provider attempt was stopped.',
                );
                reject(error);
                abortProvider(error);
            };
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        });

        let providerAttempt: Promise<T>;
        try {
            providerAttempt = Promise.resolve(operation(
                providerAbort.signal,
                providerDeadlineAtMs,
            ));
        } catch (error) {
            providerAttempt = Promise.reject(error);
        }
        try {
            return await Promise.race([
                providerAttempt,
                claimLoss,
                deadline,
                stopped,
            ]);
        } catch (error) {
            if (providerAbort.signal.aborted) {
                await providerAttempt.catch(() => undefined);
            }
            throw error;
        } finally {
            clearInterval(timer);
            if (deadlineTimer) clearTimeout(deadlineTimer);
            removeAbortListener();
        }
    }

    private throwIfAttemptStopped(signal?: AbortSignal): void {
        if (!signal?.aborted) return;
        throw new TenantDeletionBillingAttemptControlError(
            'stopped',
            'RECONCILER_STOPPED',
            'Tenant deletion billing provider attempt was stopped.',
        );
    }

    private async renewClaim(
        claim: ClaimedTenantDeletionBillingCandidate,
        platformAdmin: boolean,
    ): Promise<void> {
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
        const renew = async (tx: TenantPrismaTransaction) => {
            const renewed = await tx.$executeRaw`
                UPDATE "TenantDeletionBillingReconciliation"
                SET "leaseExpiresAt" = ${leaseExpiresAt}, "updatedAt" = ${now}
                WHERE "tenantId" = ${claim.tenantId}
                  AND "state" = 'PENDING'::"TenantDeletionBillingReconciliationState"
                  AND "operationId" = ${claim.operationId}
                  AND "leaseOwner" = ${claim.leaseOwner}
                  AND "leaseToken" = ${claim.leaseToken}
                  AND "leaseExpiresAt" > ${now}
            `;
            if (renewed !== 1) throw new ConflictException('Tenant deletion billing reconciliation claim was lost.');
        };
        await (platformAdmin
            ? this.tenantDb.withPlatformAdmin(renew, TenantDeletionBillingService.TRANSACTION_OPTIONS)
            : this.tenantDb.withTenant(claim.tenantId, renew, TenantDeletionBillingService.TRANSACTION_OPTIONS));
    }

    private async recordReconciliationFailure(
        claim: ClaimedTenantDeletionBillingCandidate,
        platformAdmin: boolean,
        failureCode: TenantDeletionBillingFailureCode = 'PROVIDER_OR_FINALIZATION_FAILED',
    ): Promise<void> {
        const now = new Date();
        const release = async (tx: TenantPrismaTransaction) => {
            await tx.$executeRaw`
                UPDATE "TenantDeletionBillingReconciliation"
                SET
                    "leaseOwner" = NULL,
                    "leaseToken" = NULL,
                    "leaseExpiresAt" = NULL,
                    "lastFailureAt" = ${now},
                    "lastErrorCode" = ${failureCode},
                    "nextAttemptAt" = ${now} + (
                        LEAST(
                            ${this.retryMaxMs}::double precision,
                            ${this.retryBaseMs}::double precision
                              * POWER(2, LEAST(GREATEST("attemptCount" - 1, 0), 16))
                        ) * INTERVAL '1 millisecond'
                    ),
                    "updatedAt" = ${now}
                WHERE "tenantId" = ${claim.tenantId}
                  AND "state" = 'PENDING'::"TenantDeletionBillingReconciliationState"
                  AND "operationId" = ${claim.operationId}
                  AND "leaseOwner" = ${claim.leaseOwner}
                  AND "leaseToken" = ${claim.leaseToken}
            `;
        };
        await (platformAdmin
            ? this.tenantDb.withPlatformAdmin(release, TenantDeletionBillingService.TRANSACTION_OPTIONS)
            : this.tenantDb.withTenant(claim.tenantId, release, TenantDeletionBillingService.TRANSACTION_OPTIONS));
    }

    private reconciliationFailureCode(error: unknown): TenantDeletionBillingFailureCode {
        return error instanceof TenantDeletionBillingAttemptControlError
            ? error.failureCode
            : 'PROVIDER_OR_FINALIZATION_FAILED';
    }

    private reconciliationOperationId(barrier: TenantDeletionBarrier): string {
        return `tenant-deletion-${barrier.auditId}`;
    }

    private async readPendingDeletionBarrier(tenantId: string): Promise<TenantDeletionBarrier | null> {
        const tenant = await this.tenantDb.withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
                id: true,
                slug: true,
                status: true,
                deletedAt: true,
                auditLogs: {
                    where: {
                        action: 'TENANT_DELETION_BARRIER_COMMITTED',
                        resource: 'Tenant',
                        resourceId: tenantId,
                    },
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    take: 1,
                    select: {
                        id: true,
                        userId: true,
                        actorUserId: true,
                        actorTenantId: true,
                        ipAddress: true,
                        userAgent: true,
                        createdAt: true,
                    },
                },
            },
        }), TenantDeletionBillingService.TRANSACTION_OPTIONS);
        const barrier = tenant?.auditLogs[0];
        if (!tenant || tenant.status !== TenantStatus.SUSPENDED || tenant.deletedAt || !barrier) {
            return null;
        }
        return {
            tenantId,
            auditId: barrier.id,
            slug: tenant.slug,
            userId: barrier.userId,
            actorUserId: barrier.actorUserId,
            actorTenantId: barrier.actorTenantId,
            ipAddress: barrier.ipAddress,
            userAgent: barrier.userAgent,
            createdAt: barrier.createdAt,
        };
    }

    private async finalizeDeletionBarrier(
        barrier: TenantDeletionBarrier,
        billingPurge: Awaited<ReturnType<TenantBillingFinalizer['finalizeTenantBillingForPurge']>>,
        platformAdmin: boolean,
        claim: ClaimedTenantDeletionBillingCandidate,
    ) {
        const finalize = async (tx: TenantPrismaTransaction) => {
            await this.lockTenantDeletion(tx, barrier.tenantId);
            await this.assertExactReconciliationClaim(tx, claim);
            const current = await tx.tenant.findUniqueOrThrow({
                where: { id: barrier.tenantId },
                select: { id: true, slug: true, status: true, deletedAt: true },
            });

            if (current.status === TenantStatus.PURGED && current.deletedAt) {
                await this.markReconciliationFinalized(tx, claim, new Date());
                return current;
            }
            if (current.status !== TenantStatus.SUSPENDED || current.deletedAt) {
                throw new ConflictException('Tenant deletion barrier is no longer active.');
            }

            const retentionSchedule = buildTenantRetentionSchedule(barrier.createdAt);
            const updated = await tx.tenant.update({
                where: { id: barrier.tenantId },
                data: {
                    status: TenantStatus.PURGED,
                    deletedAt: barrier.createdAt,
                    stripeSubscriptionId: null,
                },
                select: { id: true, slug: true, status: true, deletedAt: true },
            });
            await tx.auditLog.create({
                data: {
                    tenantId: barrier.tenantId,
                    userId: barrier.userId,
                    actorUserId: barrier.actorUserId ?? barrier.userId,
                    actorTenantId: barrier.actorTenantId ?? barrier.tenantId,
                    action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER',
                    resource: 'Tenant',
                    resourceId: barrier.tenantId,
                    newValue: {
                        retention: 'Application access disabled immediately; retained billing, audit, log, and backup records follow the retention runbook.',
                        retentionSchedule,
                        retainedRecords: Array.from(TENANT_RETENTION_POLICY.retainedRecords),
                        billingPurge,
                    },
                    ipAddress: barrier.ipAddress,
                    userAgent: barrier.userAgent,
                },
            });
            await this.markReconciliationFinalized(tx, claim, new Date());
            return updated;
        };

        return platformAdmin
            ? this.tenantDb.withPlatformAdmin(finalize, TenantDeletionBillingService.TRANSACTION_OPTIONS)
            : this.tenantDb.withTenant(barrier.tenantId, finalize, TenantDeletionBillingService.TRANSACTION_OPTIONS);
    }

    private async assertExactReconciliationClaim(
        tx: TenantPrismaTransaction,
        claim: ClaimedTenantDeletionBillingCandidate,
    ): Promise<void> {
        const now = new Date();
        const matched = await tx.$executeRaw`
            UPDATE "TenantDeletionBillingReconciliation"
            SET "updatedAt" = "updatedAt"
            WHERE "tenantId" = ${claim.tenantId}
              AND "state" = 'PENDING'::"TenantDeletionBillingReconciliationState"
              AND "operationId" = ${claim.operationId}
              AND "leaseOwner" = ${claim.leaseOwner}
              AND "leaseToken" = ${claim.leaseToken}
              AND "leaseExpiresAt" > ${now}
        `;
        if (matched !== 1) {
            throw new ConflictException('Tenant deletion billing reconciliation claim was lost.');
        }
    }

    private async markReconciliationFinalized(
        tx: TenantPrismaTransaction,
        claim: ClaimedTenantDeletionBillingCandidate,
        finalizedAt: Date,
    ): Promise<void> {
        const finalized = await tx.$executeRaw`
            UPDATE "TenantDeletionBillingReconciliation"
            SET
                "state" = 'FINALIZED'::"TenantDeletionBillingReconciliationState",
                "leaseOwner" = NULL,
                "leaseToken" = NULL,
                "leaseExpiresAt" = NULL,
                "nextAttemptAt" = ${finalizedAt},
                "lastErrorCode" = NULL,
                "finalizedAt" = ${finalizedAt},
                "updatedAt" = ${finalizedAt}
            WHERE "tenantId" = ${claim.tenantId}
              AND "state" = 'PENDING'::"TenantDeletionBillingReconciliationState"
              AND "operationId" = ${claim.operationId}
              AND "leaseOwner" = ${claim.leaseOwner}
              AND "leaseToken" = ${claim.leaseToken}
        `;
        if (finalized !== 1) {
            throw new ConflictException('Tenant deletion billing reconciliation claim was lost before finalization.');
        }
    }

    private serializeDeletionResult(
        tenant: { id: string; slug: string; status: TenantStatus | string; deletedAt: Date | null },
        requestedAt: Date,
    ): TenantDeletionResult {
        const finalizedAt = tenant.deletedAt ?? requestedAt;
        return {
            id: tenant.id,
            slug: tenant.slug,
            status: tenant.status,
            deletionState: 'FINALIZED',
            billingCleanupPending: false,
            deletionRequestedAt: finalizedAt,
            retention: buildTenantRetentionSchedule(finalizedAt),
            retainedRecords: Array.from(TENANT_RETENTION_POLICY.retainedRecords),
        };
    }

    private serializePendingDeletionResult(barrier: TenantDeletionBarrier): TenantDeletionResult {
        return {
            id: barrier.tenantId,
            slug: barrier.slug,
            status: TenantStatus.SUSPENDED,
            deletionState: 'PENDING_BILLING_CLEANUP',
            billingCleanupPending: true,
            deletionRequestedAt: barrier.createdAt,
            retention: buildTenantRetentionSchedule(barrier.createdAt),
            retainedRecords: Array.from(TENANT_RETENTION_POLICY.retainedRecords),
        };
    }
    private async lockTenantDeletion(tx: TenantPrismaTransaction, tenantId: string): Promise<void> {
        await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${tenantId})`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-checkout:${tenantId}`}, 0))`;
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "Tenant"
            WHERE "id" = ${tenantId}
            FOR UPDATE
        `;
        if (!rows[0]) {
            throw new BadRequestException('Tenant not found');
        }
    }

    private boundedInteger(
        value: number | undefined,
        fallback: number,
        minimum: number,
        maximum: number,
    ): number {
        if (!Number.isFinite(value)) return fallback;
        return Math.max(minimum, Math.min(maximum, Math.trunc(value!)));
    }

    private async terminalizePaidWorkForDeletion(
        tx: TenantPrismaTransaction,
        tenantId: string,
        completedAt: Date,
    ): Promise<void> {
        await this.assertPaidWorkProvenanceForDeletion(tx, tenantId);
        const outcomes = await tx.$queryRaw<TenantDeletionPaidWorkSettlementOutcome[]>`
            WITH locked_wallet AS MATERIALIZED (
                SELECT tenant."id", tenant."usageCredits"
                FROM "Tenant" tenant
                WHERE tenant."id" = ${tenantId}
                FOR UPDATE OF tenant
            ), terminalized_jobs AS (
                UPDATE "ScheduleSolveJob"
                SET
                    "status" = 'DEAD_LETTERED',
                    "statusReason" = 'Tenant account deletion requested',
                    "completedAt" = COALESCE("completedAt", ${completedAt}),
                    "publicationStatus" = 'PUBLISHED',
                    "publishedAt" = COALESCE("publishedAt", ${completedAt}),
                    "publishLeaseUntil" = NULL,
                    "publishLastError" = 'Tenant account deletion requested',
                    "updatedAt" = ${completedAt}
                WHERE "tenantId" = ${tenantId}
                  AND "status" IN ('QUEUED', 'RUNNING', 'RETRYING')
                RETURNING "id", "tenantId", "creditConsumption"
            ), refundable_schedule_jobs AS (
                SELECT
                    job."id",
                    job."tenantId",
                    -debit."amount" AS "amount"
                FROM terminalized_jobs job
                JOIN "CreditTransaction" debit
                  ON debit."id" = 'schedule-credit-' || job."id"
                 AND debit."tenantId" = job."tenantId"
                 AND debit."amount" < 0
                WHERE job."creditConsumption"->>'source' = 'credits'
                  AND CASE
                      WHEN jsonb_typeof(job."creditConsumption"->'consumedCredits') = 'number'
                       AND job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'
                      THEN -debit."amount" = (job."creditConsumption"->>'consumedCredits')::integer
                      ELSE FALSE
                  END
                  AND debit."balanceAfter" = (job."creditConsumption"->>'newBalance')::integer
            ), locked_availability_imports AS MATERIALIZED (
                SELECT
                    job."id",
                    job."tenantId",
                    job."status"::text AS "status",
                    job."creditConsumption"
                FROM "AvailabilityImportJob" job
                WHERE job."tenantId" = ${tenantId}
                ORDER BY job."id"
                FOR UPDATE OF job
            ), refundable_availability_imports AS (
                SELECT
                    import_job."id",
                    import_job."tenantId",
                    -debit."amount" AS "amount"
                FROM locked_availability_imports import_job
                JOIN "CreditTransaction" debit
                  ON debit."id" = 'feature-usage-availability-import:' || import_job."id"
                 AND debit."tenantId" = import_job."tenantId"
                 AND debit."amount" < 0
                WHERE import_job."status" IN ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')
                  AND jsonb_typeof(import_job."creditConsumption") = 'object'
                  AND jsonb_typeof(import_job."creditConsumption"->'consumedCredits') = 'number'
                  AND import_job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'
                  AND (import_job."creditConsumption"->>'consumedCredits')::numeric <= 2147483647
                  AND -debit."amount" = (import_job."creditConsumption"->>'consumedCredits')::integer
                  AND debit."reason" = 'Availability PDF import (' || import_job."id" || ')'
                  AND debit."balanceAfter" = (import_job."creditConsumption"->>'newBalance')::integer
            ), cancelled_availability_imports AS (
                UPDATE "AvailabilityImportJob" job
                SET
                    "storageKey" = NULL,
                    "encryptedSourcePayload" = NULL,
                    "parsedAvailability" = NULL,
                    "resultErasedAt" = ${completedAt},
                    "status" = 'CANCELLED'::"AvailabilityImportStatus",
                    "publicationStatus" = 'FAILED'::"AvailabilityImportPublicationStatus",
                    "publishToken" = NULL,
                    "publishLeaseUntil" = NULL,
                    "publicationAmbiguous" = FALSE,
                    "publishLastError" = NULL,
                    "failureCode" = 'TENANT_DELETED',
                    "executionToken" = NULL,
                    "executionLeaseUntil" = NULL,
                    "completedAt" = ${completedAt},
                    "updatedAt" = ${completedAt}
                FROM locked_availability_imports import_job
                WHERE job."id" = import_job."id"
                  AND job."tenantId" = import_job."tenantId"
                  AND import_job."status" <> 'SUCCEEDED'
                RETURNING job."id"
            ), erased_successful_availability_imports AS (
                UPDATE "AvailabilityImportJob" job
                SET
                    "storageKey" = NULL,
                    "encryptedSourcePayload" = NULL,
                    "parsedAvailability" = NULL,
                    "resultErasedAt" = COALESCE(job."resultErasedAt", ${completedAt}),
                    "publishToken" = NULL,
                    "publishLeaseUntil" = NULL,
                    "publicationAmbiguous" = FALSE,
                    "publishLastError" = NULL,
                    "executionToken" = NULL,
                    "executionLeaseUntil" = NULL,
                    "updatedAt" = ${completedAt}
                FROM locked_availability_imports import_job
                WHERE job."id" = import_job."id"
                  AND job."tenantId" = import_job."tenantId"
                  AND import_job."status" = 'SUCCEEDED'
                RETURNING job."id"
            ), refund_candidates AS MATERIALIZED (
                SELECT
                    'schedule-credit-refund-' || "id" AS "id",
                    "tenantId",
                    "amount",
                    'Schedule generation refund (' || "id" || ')' AS "reason"
                FROM refundable_schedule_jobs
                UNION ALL
                SELECT
                    'feature-refund-availability-import:' || "id" AS "id",
                    "tenantId",
                    "amount",
                    'Availability PDF import refund (' || "id" || ')' AS "reason"
                FROM refundable_availability_imports
            ), settled_refunds AS MATERIALIZED (
                SELECT
                    candidate."id",
                    candidate."tenantId",
                    candidate."amount",
                    candidate."reason",
                    wallet."usageCredits" + SUM(candidate."amount") OVER (
                        PARTITION BY candidate."tenantId"
                        ORDER BY candidate."id"
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    )::integer AS "balanceAfter"
                FROM refund_candidates candidate
                JOIN locked_wallet wallet ON wallet."id" = candidate."tenantId"
            ), inserted_refunds AS (
                INSERT INTO "CreditTransaction" (
                    "id", "tenantId", "amount", "reason", "balanceAfter", "createdAt"
                )
                SELECT
                    "id", "tenantId", "amount", "reason", "balanceAfter", ${completedAt}
                FROM settled_refunds
                ORDER BY "id"
                ON CONFLICT ("id") DO NOTHING
                RETURNING "tenantId", "amount", "balanceAfter"
            ), refund_totals AS (
                SELECT "tenantId", SUM("amount")::integer AS "amount"
                FROM inserted_refunds
                GROUP BY "tenantId"
            ), updated_wallet AS (
                UPDATE "Tenant" tenant
                SET
                    "usageCredits" = tenant."usageCredits" + refund_totals."amount",
                    "updatedAt" = ${completedAt}
                FROM refund_totals
                WHERE tenant."id" = refund_totals."tenantId"
                RETURNING tenant."id"
            )
            SELECT
                (SELECT COUNT(*)::integer FROM refund_candidates) AS "candidateCount",
                (SELECT COUNT(*)::integer FROM inserted_refunds) AS "insertedCount",
                (SELECT COUNT(*)::integer FROM updated_wallet) AS "walletUpdateCount"
        `;
        const outcome = outcomes[0];
        const candidateCount = this.nonnegativeCount(outcome?.candidateCount);
        const insertedCount = this.nonnegativeCount(outcome?.insertedCount);
        const walletUpdateCount = this.nonnegativeCount(outcome?.walletUpdateCount);
        if (candidateCount === null
            || insertedCount !== candidateCount
            || walletUpdateCount !== (candidateCount > 0 ? 1 : 0)) {
            throw new ConflictException('Tenant deletion paid-work refund settlement failed.');
        }
    }

    private async assertPaidWorkProvenanceForDeletion(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ): Promise<void> {
        const invalid = await tx.$queryRaw<Array<{ jobType: string; jobId: string }>>`
            WITH locked_schedule_jobs AS MATERIALIZED (
                SELECT job."id", job."tenantId", job."status", job."creditConsumption"
                FROM "ScheduleSolveJob" job
                WHERE job."tenantId" = ${tenantId}
                ORDER BY job."id"
                FOR UPDATE OF job
            ), schedule_provenance AS (
                SELECT configured.*,
                       debit."count" AS "debitCount",
                       debit."tenantId" AS "debitTenantId",
                       debit."amount" AS "debitAmount",
                       debit."reason" AS "debitReason",
                       debit."balanceAfter" AS "debitBalanceAfter",
                       refund."count" AS "refundCount",
                       refund."tenantId" AS "refundTenantId",
                       refund."amount" AS "refundAmount",
                       refund."reason" AS "refundReason",
                       refund."balanceAfter" AS "refundBalanceAfter"
                FROM (
                    SELECT job.*,
                           CASE
                               WHEN jsonb_typeof(job."creditConsumption") = 'object'
                                AND job."creditConsumption"->>'source' = 'credits'
                                AND job."creditConsumption" = jsonb_build_object(
                                    'consumedCredits', job."creditConsumption"->'consumedCredits',
                                    'newBalance', job."creditConsumption"->'newBalance',
                                    'source', job."creditConsumption"->'source'
                                )
                                AND jsonb_typeof(job."creditConsumption"->'consumedCredits') = 'number'
                                AND job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'
                                AND jsonb_typeof(job."creditConsumption"->'newBalance') = 'number'
                                AND job."creditConsumption"->>'newBalance' ~ '^(0|[1-9][0-9]*)$'
                                AND (job."creditConsumption"->>'newBalance')::numeric <= 2147483647
                                AND (job."creditConsumption"->>'consumedCredits')::numeric
                                    <= 2147483647 - (job."creditConsumption"->>'newBalance')::numeric
                               THEN (job."creditConsumption"->>'consumedCredits')::integer
                               ELSE NULL
                           END AS "configuredAmount",
                           CASE
                               WHEN jsonb_typeof(job."creditConsumption") = 'object'
                                AND jsonb_typeof(job."creditConsumption"->'newBalance') = 'number'
                                AND job."creditConsumption"->>'newBalance' ~ '^(0|[1-9][0-9]*)$'
                                AND (job."creditConsumption"->>'newBalance')::numeric <= 2147483647
                               THEN (job."creditConsumption"->>'newBalance')::integer
                               ELSE NULL
                           END AS "configuredBalance"
                    FROM locked_schedule_jobs job
                ) configured
                CROSS JOIN LATERAL (
                    SELECT COUNT(*)::integer AS "count",
                           MIN(ledger."tenantId") AS "tenantId",
                           MIN(ledger."amount") AS "amount",
                           MIN(ledger."reason") AS "reason",
                           MIN(ledger."balanceAfter") AS "balanceAfter"
                    FROM "CreditTransaction" ledger
                    WHERE ledger."id" = 'schedule-credit-' || configured."id"
                ) debit
                CROSS JOIN LATERAL (
                    SELECT COUNT(*)::integer AS "count",
                           MIN(ledger."tenantId") AS "tenantId",
                           MIN(ledger."amount") AS "amount",
                           MIN(ledger."reason") AS "reason",
                           MIN(ledger."balanceAfter") AS "balanceAfter"
                    FROM "CreditTransaction" ledger
                    WHERE ledger."id" = 'schedule-credit-refund-' || configured."id"
                ) refund
            ), locked_availability_imports AS MATERIALIZED (
                SELECT job."id", job."tenantId", job."status"::text AS "status", job."creditConsumption"
                FROM "AvailabilityImportJob" job
                WHERE job."tenantId" = ${tenantId}
                ORDER BY job."id"
                FOR UPDATE OF job
            ), availability_provenance AS (
                SELECT configured.*,
                       debit."count" AS "debitCount",
                       debit."tenantId" AS "debitTenantId",
                       debit."amount" AS "debitAmount",
                       debit."reason" AS "debitReason",
                       debit."balanceAfter" AS "debitBalanceAfter",
                       refund."count" AS "refundCount",
                       refund."tenantId" AS "refundTenantId",
                       refund."amount" AS "refundAmount",
                       refund."reason" AS "refundReason",
                       refund."balanceAfter" AS "refundBalanceAfter"
                FROM (
                    SELECT job.*,
                           CASE
                               WHEN jsonb_typeof(job."creditConsumption") = 'object'
                                AND job."creditConsumption"->>'source' = 'credits'
                                AND job."creditConsumption" = jsonb_build_object(
                                    'consumedCredits', job."creditConsumption"->'consumedCredits',
                                    'newBalance', job."creditConsumption"->'newBalance',
                                    'source', job."creditConsumption"->'source'
                                )
                                AND jsonb_typeof(job."creditConsumption"->'consumedCredits') = 'number'
                                AND job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'
                                AND jsonb_typeof(job."creditConsumption"->'newBalance') = 'number'
                                AND job."creditConsumption"->>'newBalance' ~ '^(0|[1-9][0-9]*)$'
                                AND (job."creditConsumption"->>'newBalance')::numeric <= 2147483647
                                AND (job."creditConsumption"->>'consumedCredits')::numeric
                                    <= 2147483647 - (job."creditConsumption"->>'newBalance')::numeric
                               THEN (job."creditConsumption"->>'consumedCredits')::integer
                               ELSE NULL
                           END AS "configuredAmount",
                           CASE
                               WHEN jsonb_typeof(job."creditConsumption") = 'object'
                                AND jsonb_typeof(job."creditConsumption"->'newBalance') = 'number'
                                AND job."creditConsumption"->>'newBalance' ~ '^(0|[1-9][0-9]*)$'
                                AND (job."creditConsumption"->>'newBalance')::numeric <= 2147483647
                               THEN (job."creditConsumption"->>'newBalance')::integer
                               ELSE NULL
                           END AS "configuredBalance"
                    FROM locked_availability_imports job
                ) configured
                CROSS JOIN LATERAL (
                    SELECT COUNT(*)::integer AS "count",
                           MIN(ledger."tenantId") AS "tenantId",
                           MIN(ledger."amount") AS "amount",
                           MIN(ledger."reason") AS "reason",
                           MIN(ledger."balanceAfter") AS "balanceAfter"
                    FROM "CreditTransaction" ledger
                    WHERE ledger."id" = 'feature-usage-availability-import:' || configured."id"
                ) debit
                CROSS JOIN LATERAL (
                    SELECT COUNT(*)::integer AS "count",
                           MIN(ledger."tenantId") AS "tenantId",
                           MIN(ledger."amount") AS "amount",
                           MIN(ledger."reason") AS "reason",
                           MIN(ledger."balanceAfter") AS "balanceAfter"
                    FROM "CreditTransaction" ledger
                    WHERE ledger."id" = 'feature-refund-availability-import:' || configured."id"
                ) refund
            ), invalid_provenance AS (
                SELECT 'schedule'::text AS "jobType", provenance."id" AS "jobId"
                FROM schedule_provenance provenance
                WHERE provenance."configuredAmount" IS NULL
                   OR provenance."configuredBalance" IS NULL
                   OR provenance."debitCount" <> 1
                   OR provenance."debitTenantId" IS DISTINCT FROM provenance."tenantId"
                   OR provenance."debitAmount" IS DISTINCT FROM -provenance."configuredAmount"
                   OR provenance."debitReason" IS DISTINCT FROM 'Schedule generation (' || provenance."id" || ')'
                   OR provenance."debitBalanceAfter" IS DISTINCT FROM provenance."configuredBalance"
                   OR (
                       provenance."status" IN ('FAILED', 'DEAD_LETTERED')
                       AND provenance."refundCount" <> 1
                   )
                   OR (
                       provenance."status" = 'SUCCEEDED'
                       AND provenance."refundCount" <> 0
                   )
                   OR (
                       provenance."status" IN ('QUEUED', 'RUNNING', 'RETRYING')
                       AND provenance."refundCount" <> 0
                   )
                   OR provenance."status" NOT IN (
                       'QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED'
                   )
                   OR (provenance."refundCount" = 1 AND (
                       provenance."refundTenantId" IS DISTINCT FROM provenance."tenantId"
                       OR provenance."refundAmount" IS DISTINCT FROM provenance."configuredAmount"
                       OR provenance."refundReason" IS DISTINCT FROM 'Schedule generation refund (' || provenance."id" || ')'
                       OR provenance."refundBalanceAfter" IS NULL
                       OR provenance."refundBalanceAfter" < 0
                   ))
                UNION ALL
                SELECT 'availability_import'::text AS "jobType", provenance."id" AS "jobId"
                FROM availability_provenance provenance
                WHERE provenance."configuredAmount" IS NULL
                   OR provenance."configuredBalance" IS NULL
                   OR provenance."debitCount" <> 1
                   OR provenance."debitTenantId" IS DISTINCT FROM provenance."tenantId"
                   OR provenance."debitAmount" IS DISTINCT FROM -provenance."configuredAmount"
                   OR provenance."debitReason" IS DISTINCT FROM 'Availability PDF import (' || provenance."id" || ')'
                   OR provenance."debitBalanceAfter" IS DISTINCT FROM provenance."configuredBalance"
                   OR (
                       provenance."status" IN ('FAILED', 'DEAD_LETTERED', 'CANCELLED')
                       AND provenance."refundCount" <> 1
                   )
                   OR (
                       provenance."status" = 'SUCCEEDED'
                       AND provenance."refundCount" <> 0
                   )
                   OR (
                       provenance."status" IN ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')
                       AND provenance."refundCount" <> 0
                   )
                   OR provenance."status" NOT IN (
                       'PENDING', 'QUEUED', 'RUNNING', 'RETRYING',
                       'SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED'
                   )
                   OR (provenance."refundCount" = 1 AND (
                       provenance."refundTenantId" IS DISTINCT FROM provenance."tenantId"
                       OR provenance."refundAmount" IS DISTINCT FROM provenance."configuredAmount"
                       OR provenance."refundReason" IS DISTINCT FROM 'Availability PDF import refund (' || provenance."id" || ')'
                       OR provenance."refundBalanceAfter" IS NULL
                       OR provenance."refundBalanceAfter" < 0
                   ))
            )
            SELECT "jobType", "jobId"
            FROM invalid_provenance
            ORDER BY "jobType", "jobId"
            LIMIT 1
        `;
        if (invalid.some((row) => Boolean(row.jobType && row.jobId))) {
            throw new ConflictException('Tenant deletion paid-work billing provenance is invalid.');
        }
    }

    private nonnegativeCount(value: number | bigint | undefined): number | null {
        if (value === undefined) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }
}
