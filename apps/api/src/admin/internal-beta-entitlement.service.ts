import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanTier, Prisma, TenantStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { type PlatformAdminMutationActor, RbacService } from '../auth/rbac.service';
import { runSerializableMutationWithRetry } from '../auth/serializable-mutation';
import {
    coercePlanFeatureKeys,
    INTERNAL_BETA_ENTITLEMENT_KEY,
    INTERNAL_BETA_MAX_CREDITS,
    INTERNAL_BETA_MAX_DAYS,
    type InternalBetaSchedulingEntitlement,
    internalBetaEntitlementsRuntimeEnabled,
    resolveTenantPlanDefinition,
} from '../billing/plan-definitions';
import {
    administrativeCreditGrantTransactionId,
    MeteringService,
} from '../billing/metering.service';
import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const INTERNAL_BETA_LEDGER_PREFIX = 'Internal beta scheduling entitlement: ';

export type InternalBetaEntitlementActor = PlatformAdminMutationActor & {
    ipAddress: string | null;
    userAgent: string | null;
};

export type InternalBetaEntitlementGrantInput = {
    credits: number;
    expiresAt: string;
    reason: string;
};

export type InternalBetaEntitlementGrantResponse = {
    tenantId: string;
    grantId: string;
    creditTransactionId: string;
    creditsGranted: number;
    newBalance: number;
    approvedAt: string;
    expiresAt: string;
};

type StoredGrantAudit = {
    tenantId: string;
    action: string;
    resource: string;
    resourceId: string | null;
    newValue: Prisma.JsonValue | null;
};

export class InternalBetaEntitlementService {
    constructor(
        private readonly config: ConfigService,
        private readonly metering: MeteringService,
        private readonly tenantDb: TenantPrismaService,
        private readonly rbac: RbacService,
        private readonly clock: () => Date = () => new Date(),
    ) {}

    async grant(
        tenantIdRaw: string,
        input: InternalBetaEntitlementGrantInput,
        idempotencyKeyRaw: unknown,
        actor: InternalBetaEntitlementActor,
    ): Promise<InternalBetaEntitlementGrantResponse> {
        this.assertRuntimeEnabled();
        const tenantId = tenantIdRaw?.trim();
        if (!tenantId) throw new BadRequestException('tenantId is required');
        const credits = Number(input?.credits);
        if (!Number.isSafeInteger(credits) || credits < 1 || credits > INTERNAL_BETA_MAX_CREDITS) {
            throw new BadRequestException(
                `credits must be a positive integer no greater than ${INTERNAL_BETA_MAX_CREDITS}.`,
            );
        }
        const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
        if (!reason || reason.length > 240 || /[\u0000-\u001f\u007f]/.test(reason)) {
            throw new BadRequestException('reason must contain 1 to 240 printable characters.');
        }
        const expiresAt = this.parseExpiry(input?.expiresAt);
        const idempotencyKey = this.normalizeIdempotencyKey(idempotencyKeyRaw);
        const meteringKey = `internal-beta-entitlement:${idempotencyKey}`;
        const creditTransactionId = administrativeCreditGrantTransactionId(tenantId, meteringKey);
        const auditId = `${creditTransactionId}-internal-beta-audit`;
        const requestHash = this.requestHash({ tenantId, credits, expiresAt, reason });
        const ledgerReason = `${INTERNAL_BETA_LEDGER_PREFIX}${reason}`;

        return runSerializableMutationWithRetry(
            () => this.tenantDb.withPlatformAdmin(async (tx) => {
                await tx.$executeRaw`LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE`;
                await this.rbac.authorizePlatformAdminTenantMutationInTransaction(tx, tenantId, actor);

                const replay = await this.findReplay(
                    tx,
                    auditId,
                    requestHash,
                    tenantId,
                    creditTransactionId,
                    credits,
                    ledgerReason,
                );
                if (replay) return replay;

                const now = this.clock();
                this.assertExpiryWindow(expiresAt, now);
                const tenant = await tx.tenant.findUnique({
                    where: { id: tenantId },
                    select: {
                        id: true,
                        planTier: true,
                        status: true,
                        trialEndsAt: true,
                        deletedAt: true,
                        creditDebt: true,
                    },
                });
                if (!tenant || tenant.deletedAt) throw new BadRequestException('Tenant not found');
                if (tenant.planTier === PlanTier.FREE) {
                    throw new BadRequestException('Internal beta scheduling requires a paid-plan trial workspace.');
                }
                if (
                    tenant.status !== TenantStatus.TRIAL
                    || !tenant.trialEndsAt
                    || tenant.trialEndsAt <= now
                ) {
                    throw new BadRequestException('Internal beta scheduling requires a current bounded tenant trial.');
                }
                if (expiresAt > tenant.trialEndsAt) {
                    throw new BadRequestException('Internal beta expiry cannot outlive the tenant trial.');
                }
                if (tenant.creditDebt !== 0) {
                    throw new ConflictException('Internal beta credits cannot be granted while credit debt is outstanding.');
                }
                const plan = await resolveTenantPlanDefinition(tx, tenant.planTier);
                if (
                    plan?.active === false
                    || !coercePlanFeatureKeys(plan?.metadata ?? null, tenant.planTier).includes('scheduling')
                ) {
                    throw new BadRequestException('The selected tenant plan does not include scheduling.');
                }
                const previous = await tx.tenantSetting.findUnique({
                    where: { tenantId_key: { tenantId, key: INTERNAL_BETA_ENTITLEMENT_KEY } },
                    select: { value: true },
                });
                const settlement = await this.metering.grantCreditsInTransaction(tx, {
                    tenantId,
                    amount: credits,
                    reason: ledgerReason,
                    idempotencyKey: meteringKey,
                });
                if (settlement.transactionId !== creditTransactionId || settlement.replayed) {
                    throw new ConflictException('Internal beta credit provenance is incomplete.');
                }

                const approvedAt = now.toISOString();
                const entitlement: InternalBetaSchedulingEntitlement = {
                    version: 1,
                    source: 'internal_beta',
                    status: 'ACTIVE',
                    features: ['scheduling'],
                    grantId: settlement.transactionId,
                    auditId,
                    creditTransactionId: settlement.transactionId,
                    creditsGranted: credits,
                    ledgerReason,
                    reason,
                    approvedAt,
                    approvedByUserId: actor.userId,
                    expiresAt: expiresAt.toISOString(),
                };
                const response: InternalBetaEntitlementGrantResponse = {
                    tenantId,
                    grantId: entitlement.grantId,
                    creditTransactionId: entitlement.creditTransactionId,
                    creditsGranted: credits,
                    newBalance: settlement.newBalance,
                    approvedAt,
                    expiresAt: entitlement.expiresAt,
                };

                await tx.tenantSetting.upsert({
                    where: { tenantId_key: { tenantId, key: INTERNAL_BETA_ENTITLEMENT_KEY } },
                    create: {
                        tenantId,
                        key: INTERNAL_BETA_ENTITLEMENT_KEY,
                        value: entitlement as Prisma.InputJsonValue,
                    },
                    update: { value: entitlement as Prisma.InputJsonValue },
                });
                await tx.auditLog.create({
                    data: {
                        id: auditId,
                        tenantId,
                        userId: null,
                        actorUserId: actor.userId,
                        actorTenantId: actor.tenantId,
                        ipAddress: actor.ipAddress?.slice(0, 128) ?? null,
                        userAgent: actor.userAgent?.slice(0, 512) ?? null,
                        action: 'INTERNAL_BETA_ENTITLEMENT_GRANTED',
                        resource: 'TenantSetting',
                        resourceId: entitlement.grantId,
                        oldValue: previous?.value ?? undefined,
                        newValue: {
                            requestHash,
                            entitlement,
                            response,
                        } as Prisma.InputJsonValue,
                    },
                });
                return response;
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
            { conflictMessage: 'Internal beta entitlement changed concurrently; retry the request.' },
        );
    }

    private assertRuntimeEnabled(): void {
        const enabled = internalBetaEntitlementsRuntimeEnabled({
            INTERNAL_BETA_ENTITLEMENTS_ENABLED: this.config.get<string>('INTERNAL_BETA_ENTITLEMENTS_ENABLED'),
            APP_ORIGIN: this.config.get<string>('APP_ORIGIN'),
        });
        if (!enabled) {
            throw new ServiceUnavailableException(
                'Internal beta entitlements are disabled or this runtime is not beta.lunchlineup.com.',
            );
        }
    }

    private parseExpiry(value: unknown): Date {
        if (typeof value !== 'string' || !value.trim()) {
            throw new BadRequestException('expiresAt is required as an ISO timestamp.');
        }
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime())) {
            throw new BadRequestException('expiresAt must be a valid ISO timestamp.');
        }
        return parsed;
    }

    private assertExpiryWindow(expiresAt: Date, now: Date): void {
        if (expiresAt <= now) throw new BadRequestException('expiresAt must be in the future.');
        if (expiresAt.getTime() > now.getTime() + INTERNAL_BETA_MAX_DAYS * MILLISECONDS_PER_DAY) {
            throw new BadRequestException(
                `expiresAt cannot exceed the ${INTERNAL_BETA_MAX_DAYS}-day internal beta window.`,
            );
        }
    }

    private normalizeIdempotencyKey(value: unknown): string {
        if (typeof value !== 'string' || !value.trim()) {
            throw new BadRequestException('Idempotency-Key header is required for internal beta grants.');
        }
        const key = value.trim();
        if (key.length > 220 || /[\u0000-\u001f\u007f]/.test(key)) {
            throw new BadRequestException('Idempotency-Key must be 220 printable characters or fewer.');
        }
        return key;
    }

    private requestHash(input: {
        tenantId: string;
        credits: number;
        expiresAt: Date;
        reason: string;
    }): string {
        return createHash('sha256')
            .update(JSON.stringify([
                input.tenantId,
                input.credits,
                input.expiresAt.toISOString(),
                input.reason,
            ]), 'utf8')
            .digest('hex');
    }

    private async findReplay(
        tx: TenantPrismaTransaction,
        auditId: string,
        requestHash: string,
        tenantId: string,
        creditTransactionId: string,
        credits: number,
        ledgerReason: string,
    ): Promise<InternalBetaEntitlementGrantResponse | null> {
        const audit = await tx.auditLog.findUnique({
            where: { id: auditId },
            select: {
                tenantId: true,
                action: true,
                resource: true,
                resourceId: true,
                newValue: true,
            },
        }) as StoredGrantAudit | null;
        if (!audit) return null;
        const value = audit.newValue;
        if (
            audit.tenantId !== tenantId
            || audit.action !== 'INTERNAL_BETA_ENTITLEMENT_GRANTED'
            || audit.resource !== 'TenantSetting'
            || audit.resourceId !== creditTransactionId
            || !value
            || typeof value !== 'object'
            || Array.isArray(value)
            || value.requestHash !== requestHash
        ) {
            throw new ConflictException('Idempotency-Key was already used for a different internal beta grant.');
        }
        const response = this.parseStoredResponse(value.response, tenantId, creditTransactionId, credits);
        const credit = await tx.creditTransaction.findUnique({
            where: { id: creditTransactionId },
            select: {
                tenantId: true,
                amount: true,
                debtAmount: true,
                reason: true,
                balanceAfter: true,
                debtAfter: true,
            },
        });
        if (
            credit?.tenantId !== tenantId
            || credit.amount !== credits
            || credit.debtAmount !== 0
            || credit.reason !== ledgerReason
            || credit.balanceAfter !== response.newBalance
            || credit.debtAfter !== 0
        ) {
            throw new ConflictException('Stored internal beta credit provenance is unavailable.');
        }
        return response;
    }

    private parseStoredResponse(
        value: unknown,
        tenantId: string,
        creditTransactionId: string,
        credits: number,
    ): InternalBetaEntitlementGrantResponse {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new ConflictException('Stored internal beta grant result is unavailable.');
        }
        const response = value as Record<string, unknown>;
        const approvedAt = typeof response.approvedAt === 'string' ? new Date(response.approvedAt) : null;
        const expiresAt = typeof response.expiresAt === 'string' ? new Date(response.expiresAt) : null;
        if (
            response.tenantId !== tenantId
            || response.grantId !== creditTransactionId
            || response.creditTransactionId !== creditTransactionId
            || response.creditsGranted !== credits
            || !Number.isSafeInteger(response.newBalance)
            || Number(response.newBalance) < 0
            || !approvedAt
            || !Number.isFinite(approvedAt.getTime())
            || !expiresAt
            || !Number.isFinite(expiresAt.getTime())
        ) {
            throw new ConflictException('Stored internal beta grant result is unavailable.');
        }
        return response as unknown as InternalBetaEntitlementGrantResponse;
    }
}
