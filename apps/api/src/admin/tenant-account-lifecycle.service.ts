import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantStatus } from '@prisma/client';
import {
    StripeService,
    type TenantSubscriptionCancellationResult,
} from '../billing/stripe.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { TenantDeletionBillingService } from './tenant-deletion-billing.service';
import {
    assertTenantSlugConfirmation,
    normalizeTenantConfirmation,
    serializeTenantLifecycleStatus,
    isTenantReadyForApplicationDataPurge,
    isTenantReadyForRetentionPurge,
    purgeExpiredTenantRecords,
    purgeTenantApplicationData,
} from './tenant-account-lifecycle';

export type TenantRetentionStage = 'application_data' | 'retained_records';

export type TenantRetentionCandidate = {
    id: string;
    slug?: string | null;
    status: TenantStatus | string;
    deletedAt: Date | null;
    applicationDataPurgedAt?: Date | null;
};

export type TenantRetentionPurgeAttempt =
    | { outcome: 'processed'; tenantId: string; result: Awaited<ReturnType<typeof purgeTenantApplicationData>> | Awaited<ReturnType<typeof purgeExpiredTenantRecords>> }
    | { outcome: 'skipped'; tenantId: string; reason: string }
    | { outcome: 'failed'; tenantId: string; error: string };

export type TenantLifecycleActor = {
    tenantId: string;
    userId?: string;
    ipAddress: any;
    userAgent: any;
};

type CancelTenantAccountBody = {
    confirmation?: unknown;
    reason?: unknown;
};

type RequestTenantDeletionBody = {
    confirmation?: unknown;
};

type TenantSubscriptionCanceller = Pick<
    StripeService,
    'cancelTenantSubscriptionAtPeriodEnd' | 'finalizeTenantBillingForPurge'
>;

export class TenantAccountLifecycleService {
    static readonly RETENTION_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 60_000 } as const;

    private readonly tenantDeletionBilling: TenantDeletionBillingService;

    constructor(
        private readonly tenantDb: TenantPrismaService,
        private stripeBilling?: TenantSubscriptionCanceller,
    ) {
        this.tenantDeletionBilling = new TenantDeletionBillingService(
            this.tenantDb,
            () => this.getStripeBilling(),
        );
    }

    async cancelTenant(actor: TenantLifecycleActor, body: CancelTenantAccountBody) {
        const confirmation = normalizeTenantConfirmation(body?.confirmation);
        const reason = typeof body?.reason === 'string' && body.reason.trim()
            ? body.reason.trim().slice(0, 500)
            : null;
        const tenantToCancel = await this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            const tenant = await tx.tenant.findUniqueOrThrow({
                where: { id: actor.tenantId },
                select: { id: true, slug: true, status: true, deletedAt: true, stripeSubscriptionId: true },
            });
            assertTenantSlugConfirmation(confirmation, tenant.slug);

            if (tenant.status === TenantStatus.PURGED) {
                throw new BadRequestException('Tenant deletion has already been requested.');
            }

            return tenant;
        });
        const billingCancellation = await this.cancelTenantBillingAtPeriodEnd(
            actor.tenantId,
            tenantToCancel.stripeSubscriptionId,
        );

        const tenant = await this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            const tenant = await tx.tenant.findUniqueOrThrow({
                where: { id: actor.tenantId },
                select: { id: true, slug: true, status: true, deletedAt: true },
            });

            if (tenant.status === TenantStatus.PURGED) {
                throw new BadRequestException('Tenant deletion has already been requested.');
            }

            await tx.auditLog.create({
                data: {
                    tenantId: actor.tenantId,
                    userId: actor.userId,
                    action: 'TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER',
                    resource: 'Tenant',
                    resourceId: actor.tenantId,
                    newValue: this.buildBillingCancellationAuditValue(billingCancellation, reason),
                    ipAddress: actor.ipAddress,
                    userAgent: actor.userAgent,
                },
            });
            return tenant;
        });

        return {
            id: tenant.id,
            slug: tenant.slug,
            status: tenant.status,
            cancellationEffectiveAt: billingCancellation.currentPeriodEnd,
            billingCancellation,
        };
    }

    async getStatus(actor: TenantLifecycleActor) {
        const tenant = await this.tenantDb.withTenant(actor.tenantId, (tx) => tx.tenant.findUniqueOrThrow({
            where: { id: actor.tenantId },
            select: { id: true, slug: true, status: true, deletedAt: true, applicationDataPurgedAt: true },
        }));

        return serializeTenantLifecycleStatus(tenant);
    }

    async purgeRetentionCandidate(
        candidate: TenantRetentionCandidate,
        stage: TenantRetentionStage,
        asOf: Date,
    ): Promise<TenantRetentionPurgeAttempt> {
        try {
            return await this.tenantDb.withPlatformAdmin(async (tx) => {
                const lockRows = await tx.$queryRaw<Array<{ claimed: boolean }>>`
                    SELECT pg_try_advisory_xact_lock(hashtextextended(${candidate.id}, 20260711)) AS claimed
                `;
                if (lockRows[0]?.claimed !== true) {
                    return { outcome: 'skipped', tenantId: candidate.id, reason: 'Tenant purge is already claimed.' };
                }

                const tenant = await tx.tenant.findUnique({
                    where: { id: candidate.id },
                    select: { id: true, slug: true, status: true, deletedAt: true, applicationDataPurgedAt: true },
                });
                if (!tenant) {
                    return { outcome: 'skipped', tenantId: candidate.id, reason: 'Tenant no longer exists.' };
                }

                const eligible = stage === 'application_data'
                    ? isTenantReadyForApplicationDataPurge(tenant, asOf)
                    : isTenantReadyForRetentionPurge(tenant, asOf);
                if (!eligible) {
                    return { outcome: 'skipped', tenantId: candidate.id, reason: 'Tenant is no longer eligible.' };
                }

                const result = stage === 'application_data'
                    ? await purgeTenantApplicationData(tx, tenant, { asOf })
                    : await purgeExpiredTenantRecords(tx, tenant, { asOf });
                return { outcome: 'processed', tenantId: candidate.id, result };
            }, TenantAccountLifecycleService.RETENTION_TRANSACTION_OPTIONS);
        } catch (error) {
            return {
                outcome: 'failed',
                tenantId: candidate.id,
                error: error instanceof Error ? error.message : 'Unknown tenant purge failure.',
            };
        }
    }

    async listPendingDeletionBillingCandidates(limit: number) {
        return this.tenantDeletionBilling.listPendingDeletionBillingCandidates(limit);
    }

    async reconcilePendingDeletionBillingCandidate(tenantId: string) {
        return this.tenantDeletionBilling.reconcilePendingDeletionBillingCandidate(tenantId);
    }

    async requestDeletion(actor: TenantLifecycleActor, body: RequestTenantDeletionBody) {
        return this.tenantDeletionBilling.requestDeletion(actor, body);
    }

    private async cancelTenantBillingAtPeriodEnd(
        tenantId: string,
        stripeSubscriptionId?: string | null,
    ): Promise<TenantSubscriptionCancellationResult> {
        const normalizedSubscriptionId = typeof stripeSubscriptionId === 'string' && stripeSubscriptionId.trim()
            ? stripeSubscriptionId.trim()
            : null;

        if (!normalizedSubscriptionId) {
            return {
                action: 'none',
                stripeSubscriptionId: null,
                stripeStatus: null,
                cancelAtPeriodEnd: false,
                currentPeriodEnd: null,
                cancelAt: null,
                canceledAt: null,
                cancellationBehavior: 'cancel_at_period_end',
            };
        }

        return this.getStripeBilling().cancelTenantSubscriptionAtPeriodEnd(tenantId, normalizedSubscriptionId);
    }

    private getStripeBilling(): TenantSubscriptionCanceller {
        if (!this.stripeBilling) {
            this.stripeBilling = new StripeService(new ConfigService(), this.tenantDb);
        }
        return this.stripeBilling;
    }

    private buildBillingCancellationAuditValue(
        billingCancellation: TenantSubscriptionCancellationResult,
        reason?: string | null,
    ) {
        return {
            ...(reason ? { reason } : {}),
            billingCancellation,
        };
    }
}
