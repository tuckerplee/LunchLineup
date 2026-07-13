import { BadRequestException, ConflictException } from '@nestjs/common';
import { TenantStatus, WebhookDeliveryStatus } from '@prisma/client';
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
    deletionRequestedAt: Date;
    retention: ReturnType<typeof buildTenantRetentionSchedule>;
    retainedRecords: string[];
};

export type PendingTenantDeletionBillingCandidate = {
    id: string;
    deletionRequestedAt: Date;
};

export type TenantDeletionBillingReconciliationAttempt =
    | { outcome: 'processed'; tenantId: string; result: TenantDeletionResult }
    | { outcome: 'skipped'; tenantId: string; reason: string }
    | { outcome: 'failed'; tenantId: string; error: string };

type TenantDeletionBarrier = {
    tenantId: string;
    userId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
};

type TenantBillingFinalizer = Pick<StripeService, 'finalizeTenantBillingForPurge'>;

export class TenantDeletionBillingService {
    static readonly TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 60_000 } as const;

    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly stripeBilling: () => TenantBillingFinalizer,
    ) { }

    async listPendingDeletionBillingCandidates(limit: number): Promise<PendingTenantDeletionBillingCandidate[]> {
        const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 25;
        const tenants = await this.tenantDb.withPlatformAdmin((tx) => tx.tenant.findMany({
            where: {
                status: TenantStatus.SUSPENDED,
                deletedAt: null,
                auditLogs: {
                    some: {
                        action: 'TENANT_DELETION_BARRIER_COMMITTED',
                        resource: 'Tenant',
                    },
                },
            },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
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
        try {
            const barrier = await this.readPendingDeletionBarrier(tenantId);
            if (!barrier) {
                return { outcome: 'skipped', tenantId, reason: 'Tenant deletion billing barrier is no longer pending.' };
            }

            const billingPurge = await this.stripeBilling().finalizeTenantBillingForPurge(tenantId);
            const tenant = await this.finalizeDeletionBarrier(barrier, billingPurge, true);
            return {
                outcome: 'processed',
                tenantId,
                result: this.serializeDeletionResult(tenant, barrier.createdAt),
            };
        } catch (error) {
            return {
                outcome: 'failed',
                tenantId,
                error: error instanceof Error ? error.message : 'Unknown tenant deletion billing reconciliation failure.',
            };
        }
    }

    async requestDeletion(actor: TenantLifecycleActor, body: RequestTenantDeletionBody) {
        const confirmation = normalizeTenantConfirmation(body?.confirmation);
        const barrierCommittedAt = new Date();
        const barrier = await this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            await this.lockTenantDeletion(tx, actor.tenantId);
            const tenant = await tx.tenant.findUniqueOrThrow({
                where: { id: actor.tenantId },
                select: { id: true, slug: true, status: true, deletedAt: true },
            });
            assertTenantSlugConfirmation(confirmation, tenant.slug);

            if (tenant.status === TenantStatus.PURGED) {
                throw new BadRequestException('Tenant deletion has already been requested.');
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

            const existingBarrierAudit = await tx.auditLog.findFirst({
                where: {
                    tenantId: actor.tenantId,
                    action: 'TENANT_DELETION_BARRIER_COMMITTED',
                    resource: 'Tenant',
                    resourceId: actor.tenantId,
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true, userId: true, ipAddress: true, userAgent: true, createdAt: true },
            });
            if (existingBarrierAudit) {
                return { tenantId: actor.tenantId, ...existingBarrierAudit };
            }

            await tx.auditLog.create({
                data: {
                    tenantId: actor.tenantId,
                    userId: actor.userId,
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
            return {
                tenantId: actor.tenantId,
                userId: actor.userId ?? null,
                ipAddress: actor.ipAddress ?? null,
                userAgent: actor.userAgent ?? null,
                createdAt: barrierCommittedAt,
            };
        }, TenantDeletionBillingService.TRANSACTION_OPTIONS);

        const billingPurge = await this.stripeBilling().finalizeTenantBillingForPurge(actor.tenantId);
        const tenant = await this.finalizeDeletionBarrier(barrier, billingPurge, false);
        return this.serializeDeletionResult(tenant, barrier.createdAt);
    }

    private async readPendingDeletionBarrier(tenantId: string): Promise<TenantDeletionBarrier | null> {
        const tenant = await this.tenantDb.withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
                id: true,
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
                    select: { userId: true, ipAddress: true, userAgent: true, createdAt: true },
                },
            },
        }), TenantDeletionBillingService.TRANSACTION_OPTIONS);
        const barrier = tenant?.auditLogs[0];
        if (!tenant || tenant.status !== TenantStatus.SUSPENDED || tenant.deletedAt || !barrier) {
            return null;
        }
        return { tenantId, ...barrier };
    }

    private async finalizeDeletionBarrier(
        barrier: TenantDeletionBarrier,
        billingPurge: Awaited<ReturnType<TenantBillingFinalizer['finalizeTenantBillingForPurge']>>,
        platformAdmin: boolean,
    ) {
        const finalize = async (tx: TenantPrismaTransaction) => {
            await this.lockTenantDeletion(tx, barrier.tenantId);
            const current = await tx.tenant.findUniqueOrThrow({
                where: { id: barrier.tenantId },
                select: { id: true, slug: true, status: true, deletedAt: true },
            });

            if (current.status === TenantStatus.PURGED && current.deletedAt) {
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
            return updated;
        };

        return platformAdmin
            ? this.tenantDb.withPlatformAdmin(finalize, TenantDeletionBillingService.TRANSACTION_OPTIONS)
            : this.tenantDb.withTenant(barrier.tenantId, finalize, TenantDeletionBillingService.TRANSACTION_OPTIONS);
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
            deletionRequestedAt: finalizedAt,
            retention: buildTenantRetentionSchedule(finalizedAt),
            retainedRecords: Array.from(TENANT_RETENTION_POLICY.retainedRecords),
        };
    }

    private async lockTenantDeletion(tx: TenantPrismaTransaction, tenantId: string): Promise<void> {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-checkout:${tenantId}`}, 0))`;
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

    private async terminalizePaidWorkForDeletion(
        tx: TenantPrismaTransaction,
        tenantId: string,
        completedAt: Date,
    ): Promise<void> {
        await tx.$executeRaw`
            WITH terminalized_jobs AS (
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
            ), inserted_refunds AS (
                INSERT INTO "CreditTransaction" ("id", "tenantId", "amount", "reason", "createdAt")
                SELECT
                    'schedule-credit-refund-' || "id",
                    "tenantId",
                    ("creditConsumption"->>'consumedCredits')::integer,
                    'Schedule generation refund (' || "id" || ')',
                    ${completedAt}
                FROM terminalized_jobs
                WHERE "creditConsumption"->>'source' = 'credits'
                  AND jsonb_typeof("creditConsumption"->'consumedCredits') = 'number'
                  AND ("creditConsumption"->>'consumedCredits')::integer > 0
                ON CONFLICT ("id") DO NOTHING
                RETURNING "tenantId", "amount"
            ), refund_totals AS (
                SELECT "tenantId", SUM("amount")::integer AS "amount"
                FROM inserted_refunds
                GROUP BY "tenantId"
            )
            UPDATE "Tenant" tenant
            SET
                "usageCredits" = tenant."usageCredits" + refund_totals."amount",
                "updatedAt" = ${completedAt}
            FROM refund_totals
            WHERE tenant."id" = refund_totals."tenantId"
        `;
    }
}
