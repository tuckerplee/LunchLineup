import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TenantStatus } from '@prisma/client';
import { StripeService } from '../billing/stripe.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { TenantCancellationLifecycleService } from './tenant-cancellation-lifecycle.service';
import { TenantDeletionBillingService } from './tenant-deletion-billing.service';
import {
    TENANT_CUSTOMER_CANCELLATION_INTENT_SETTING_KEY,
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
    retentionLegalHoldAt?: Date | null;
    retentionLegalHoldReason?: string | null;
    retentionLegalHoldByUserId?: string | null;
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

export type TenantRetentionLegalHoldActor = {
    userId: string;
    tenantId: string;
    ipAddress: string | null;
    userAgent: string | null;
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
    private readonly tenantCancellationLifecycle: TenantCancellationLifecycleService;

    constructor(
        private readonly tenantDb: TenantPrismaService,
        private stripeBilling?: TenantSubscriptionCanceller,
        tenantCancellationLifecycle?: TenantCancellationLifecycleService,
    ) {
        this.tenantDeletionBilling = new TenantDeletionBillingService(
            this.tenantDb,
            () => this.getStripeBilling(),
        );
        this.tenantCancellationLifecycle = tenantCancellationLifecycle
            ?? new TenantCancellationLifecycleService(
                this.tenantDb,
                () => this.getStripeBilling(),
            );
    }

    async cancelTenant(actor: TenantLifecycleActor, body: CancelTenantAccountBody) {
        return this.tenantCancellationLifecycle.cancelCustomer(actor, body);
    }

    async archiveTenant(
        tenantId: string,
        actor: TenantRetentionLegalHoldActor,
    ) {
        return this.tenantCancellationLifecycle.archivePlatform(actor, tenantId);
    }

    async getStatus(actor: TenantLifecycleActor) {
        const statusSource = await this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            const tenant = await tx.tenant.findUniqueOrThrow({
                where: { id: actor.tenantId },
                select: {
                    id: true,
                    slug: true,
                    status: true,
                    deletedAt: true,
                    applicationDataPurgedAt: true,
                    retentionLegalHoldAt: true,
                },
            });
            const customerCancellationIntent = await tx.tenantSetting.findUnique({
                where: {
                    tenantId_key: {
                        tenantId: actor.tenantId,
                        key: TENANT_CUSTOMER_CANCELLATION_INTENT_SETTING_KEY,
                    },
                },
                select: { value: true },
            });
            return { tenant, customerCancellationIntent };
        });

        return serializeTenantLifecycleStatus(
            statusSource.tenant,
            statusSource.customerCancellationIntent?.value,
        );
    }

    async placeRetentionLegalHold(
        tenantId: string,
        actor: TenantRetentionLegalHoldActor,
        body: { reason?: unknown },
    ) {
        const reason = this.normalizeLegalHoldReason(body?.reason);
        const placedAt = new Date();

        return this.tenantDb.withPlatformAdmin(async (tx) => {
            await this.lockTenantRetentionTransaction(tx, tenantId);
            const tenant = await tx.tenant.findUnique({
                where: { id: tenantId },
                select: { id: true, retentionLegalHoldAt: true },
            });
            if (!tenant) throw new NotFoundException('Tenant not found.');
            if (tenant.retentionLegalHoldAt) {
                throw new ConflictException('Tenant already has an active retention legal hold.');
            }

            const updated = await tx.tenant.updateMany({
                where: { id: tenantId, retentionLegalHoldAt: null },
                data: {
                    retentionLegalHoldAt: placedAt,
                    retentionLegalHoldReason: reason,
                    retentionLegalHoldByUserId: actor.userId,
                },
            });
            if (updated.count !== 1) {
                throw new ConflictException('Tenant retention legal hold changed before it could be placed.');
            }
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: actor.tenantId === tenantId ? actor.userId : null,
                    actorUserId: actor.userId,
                    actorTenantId: actor.tenantId,
                    action: 'TENANT_RETENTION_LEGAL_HOLD_PLACED',
                    resource: 'Tenant',
                    resourceId: tenantId,
                    oldValue: { legalHold: null },
                    newValue: {
                        legalHold: {
                            placedAt: placedAt.toISOString(),
                            reason,
                            placedByUserId: actor.userId,
                        },
                    },
                    ipAddress: actor.ipAddress,
                    userAgent: actor.userAgent,
                },
            });

            return {
                id: tenantId,
                legalHold: { placedAt, reason, placedByUserId: actor.userId },
            };
        }, TenantAccountLifecycleService.RETENTION_TRANSACTION_OPTIONS);
    }

    async releaseRetentionLegalHold(
        tenantId: string,
        actor: TenantRetentionLegalHoldActor,
        body: { reason?: unknown },
    ) {
        const releaseReason = this.normalizeLegalHoldReason(body?.reason);

        return this.tenantDb.withPlatformAdmin(async (tx) => {
            await this.lockTenantRetentionTransaction(tx, tenantId);
            const tenant = await tx.tenant.findUnique({
                where: { id: tenantId },
                select: {
                    id: true,
                    retentionLegalHoldAt: true,
                    retentionLegalHoldReason: true,
                    retentionLegalHoldByUserId: true,
                },
            });
            if (!tenant) throw new NotFoundException('Tenant not found.');
            if (!tenant.retentionLegalHoldAt) {
                throw new ConflictException('Tenant does not have an active retention legal hold.');
            }

            const updated = await tx.tenant.updateMany({
                where: { id: tenantId, retentionLegalHoldAt: tenant.retentionLegalHoldAt },
                data: {
                    retentionLegalHoldAt: null,
                    retentionLegalHoldReason: null,
                    retentionLegalHoldByUserId: null,
                },
            });
            if (updated.count !== 1) {
                throw new ConflictException('Tenant retention legal hold changed before it could be released.');
            }
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: actor.tenantId === tenantId ? actor.userId : null,
                    actorUserId: actor.userId,
                    actorTenantId: actor.tenantId,
                    action: 'TENANT_RETENTION_LEGAL_HOLD_RELEASED',
                    resource: 'Tenant',
                    resourceId: tenantId,
                    oldValue: {
                        legalHold: {
                            placedAt: tenant.retentionLegalHoldAt.toISOString(),
                            reason: tenant.retentionLegalHoldReason,
                            placedByUserId: tenant.retentionLegalHoldByUserId,
                        },
                    },
                    newValue: { legalHold: null, releaseReason },
                    ipAddress: actor.ipAddress,
                    userAgent: actor.userAgent,
                },
            });

            return { id: tenantId, legalHold: null, releaseReason };
        }, TenantAccountLifecycleService.RETENTION_TRANSACTION_OPTIONS);
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
                    select: {
                        id: true,
                        slug: true,
                        status: true,
                        deletedAt: true,
                        applicationDataPurgedAt: true,
                        retentionLegalHoldAt: true,
                        retentionLegalHoldReason: true,
                        retentionLegalHoldByUserId: true,
                    },
                });
                if (!tenant) {
                    return { outcome: 'skipped', tenantId: candidate.id, reason: 'Tenant no longer exists.' };
                }
                if (tenant.retentionLegalHoldAt) {
                    return { outcome: 'skipped', tenantId: candidate.id, reason: 'Tenant retention legal hold is active.' };
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
        } catch {
            return {
                outcome: 'failed',
                tenantId: candidate.id,
                error: 'Tenant purge failed.',
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

    private normalizeLegalHoldReason(value: unknown): string {
        if (typeof value !== 'string') {
            throw new BadRequestException('reason must be a string from 10 to 500 characters.');
        }
        const reason = value.trim();
        if (reason.length < 10 || reason.length > 500) {
            throw new BadRequestException('reason must be a string from 10 to 500 characters.');
        }
        return reason;
    }

    private async lockTenantRetentionTransaction(
        tx: Prisma.TransactionClient,
        tenantId: string,
    ): Promise<void> {
        await tx.$executeRaw`
            SELECT public.lock_tenant_lifecycle(${tenantId})
        `;
    }

    private getStripeBilling(): TenantSubscriptionCanceller {
        if (!this.stripeBilling) {
            this.stripeBilling = new StripeService(new ConfigService(), this.tenantDb);
        }
        return this.stripeBilling;
    }

}
