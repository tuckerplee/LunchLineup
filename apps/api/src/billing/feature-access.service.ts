import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { MeteringService } from './metering.service';
import {
    coercePlanFeatureKeys,
    FeatureKey,
    FEATURE_CREDIT_COST,
    FEATURE_KEYS,
    hasNonBlankStripeSubscriptionId,
    INTERNAL_BETA_ENTITLEMENT_KEY,
    internalBetaGrantAuditMatches,
    internalBetaEntitlementsRuntimeEnabled,
    parseActiveInternalBetaSchedulingEntitlement,
    resolveEffectiveTenantEntitlement,
    TenantFeatureConfig,
    TenantPlanCode,
    resolveTenantPlanDefinition,
} from './plan-definitions';

export type { FeatureKey, TenantFeatureConfig } from './plan-definitions';

type TenantPlanTier = TenantPlanCode;
type TenantStatusValue = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED' | 'PURGED';

export type FeatureResolution = {
    enabled: boolean;
    source: 'plan' | 'stripe' | 'credits' | 'manual' | 'disabled';
    reason: string;
    creditCost: number | null;
};

export type FeatureMatrix = {
    planTier: TenantPlanTier;
    effectivePlanTier: TenantPlanTier;
    status: TenantStatusValue;
    trialEndsAt: Date | null;
    stripeSubscriptionActive: boolean;
    stripeSubscriptionPresent: boolean;
    stripeSubscriptionCurrentPeriodEnd: Date | null;
    usageCredits: number;
    creditDebt: number;
    features: Record<FeatureKey, FeatureResolution>;
};

const TENANT_FEATURE_CONFIG_KEY = 'feature_access';

@Injectable()
export class FeatureAccessService {
    private readonly prisma: PrismaClient;
    private readonly tenantDb: TenantPrismaService;

    constructor(
        private readonly meteringService: MeteringService,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.prisma = tenantDb?.client ?? new PrismaClient();
        this.tenantDb = tenantDb ?? new TenantPrismaService(this.prisma);
    }

    async resolveTenantFeatures(tenantId: string): Promise<FeatureMatrix> {
        return this.getFeatureMatrix(tenantId);
    }

    async getFeatureMatrix(tenantId: string): Promise<FeatureMatrix> {
        const internalBetaRuntimeEnabled = internalBetaEntitlementsRuntimeEnabled();
        const { tenant, featureConfig, internalBetaSchedulingActive } = await this.tenantDb.withTenant(tenantId, async (tx) => {
            const [tenant, featureConfig, internalBetaSetting] = await Promise.all([
                tx.tenant.findUniqueOrThrow({
                    where: { id: tenantId },
                    select: {
                        id: true,
                        planTier: true,
                        status: true,
                        trialEndsAt: true,
                        usageCredits: true,
                        creditDebt: true,
                        stripeSubscriptionId: true,
                        stripeSubscriptionCurrentPeriodEnd: true,
                    },
                }),
                this.loadTenantFeatureConfig(tx, tenantId),
                internalBetaRuntimeEnabled
                    ? this.loadInternalBetaEntitlement(tx, tenantId)
                    : Promise.resolve(null),
            ]);
            return {
                tenant,
                featureConfig,
                internalBetaSchedulingActive: internalBetaRuntimeEnabled
                    ? await this.hasActiveInternalBetaSchedulingEntitlement(
                        tx,
                        tenantId,
                        tenant,
                        internalBetaSetting,
                    )
                    : false,
            };
        });
        const effectiveEntitlement = resolveEffectiveTenantEntitlement(tenant);
        const plan = await resolveTenantPlanDefinition(this.prisma, effectiveEntitlement.planCode);

        const features = Object.fromEntries(
            FEATURE_KEYS.map((feature) => [
                feature,
                this.resolveFeature(
                    tenant,
                    feature,
                    featureConfig,
                    plan,
                    true,
                    internalBetaSchedulingActive,
                ),
            ]),
        ) as Record<FeatureKey, FeatureResolution>;
        const planCode = (plan?.code ?? effectiveEntitlement.planCode).toUpperCase();

        return {
            planTier: tenant.planTier,
            effectivePlanTier: planCode as TenantPlanTier,
            status: tenant.status,
            trialEndsAt: tenant.trialEndsAt,
            stripeSubscriptionActive: effectiveEntitlement.source === 'paid_subscription',
            stripeSubscriptionPresent: hasNonBlankStripeSubscriptionId(tenant.stripeSubscriptionId),
            stripeSubscriptionCurrentPeriodEnd: tenant.stripeSubscriptionCurrentPeriodEnd,
            usageCredits: tenant.usageCredits,
            creditDebt: tenant.creditDebt,
            features,
        };
    }

    async assertFeatureEnabled(tenantId: string, feature: FeatureKey): Promise<FeatureResolution> {
        const matrix = await this.getFeatureMatrix(tenantId);
        const resolution = matrix.features[feature];
        if (!resolution.enabled) {
            throw new ForbiddenException(resolution.reason);
        }
        return resolution;
    }

    /**
     * Authorize a zero-settlement control, read, or recovery operation.
     * Value-producing work must use assertFeatureEnabledInTransaction instead.
     */
    async assertFeatureEntitled(tenantId: string, feature: FeatureKey): Promise<FeatureResolution> {
        return this.tenantDb.withTenant(tenantId, (tx) => (
            this.assertFeatureEntitledInTransaction(tx, tenantId, feature)
        ));
    }

    async assertFeatureEnabledInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        feature: FeatureKey,
    ): Promise<FeatureResolution> {
        return this.assertFeaturePolicyInTransaction(tx, tenantId, feature, true);
    }

    async assertFeatureEntitledInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        feature: FeatureKey,
    ): Promise<FeatureResolution> {
        return this.assertFeaturePolicyInTransaction(tx, tenantId, feature, false);
    }

    async lockTenantInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ): Promise<void> {
        await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
    }

    private async assertFeaturePolicyInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        feature: FeatureKey,
        requireBillableCredits: boolean,
    ): Promise<FeatureResolution> {
        await this.lockTenantInTransaction(tx, tenantId);
        const internalBetaRuntimeEnabled = internalBetaEntitlementsRuntimeEnabled();
        const [tenant, featureConfig, internalBetaSetting] = await Promise.all([
            tx.tenant.findUniqueOrThrow({
                where: { id: tenantId },
                select: {
                    id: true,
                    planTier: true,
                    status: true,
                    trialEndsAt: true,
                    usageCredits: true,
                    creditDebt: true,
                    stripeSubscriptionId: true,
                    stripeSubscriptionCurrentPeriodEnd: true,
                },
            }),
            this.loadTenantFeatureConfig(tx, tenantId),
            internalBetaRuntimeEnabled
                ? this.loadInternalBetaEntitlement(tx, tenantId)
                : Promise.resolve(null),
        ]);
        const internalBetaSchedulingActive = internalBetaRuntimeEnabled
            ? await this.hasActiveInternalBetaSchedulingEntitlement(
                tx,
                tenantId,
                tenant,
                internalBetaSetting,
            )
            : false;
        const effectiveEntitlement = resolveEffectiveTenantEntitlement(tenant);
        const plan = await resolveTenantPlanDefinition(tx, effectiveEntitlement.planCode);
        const resolution = this.resolveFeature(
            tenant,
            feature,
            featureConfig,
            plan,
            requireBillableCredits,
            internalBetaSchedulingActive,
        );
        if (!resolution.enabled) {
            throw new ForbiddenException(resolution.reason);
        }
        return resolution;
    }
    async recordFeatureUsageInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        resolution: FeatureResolution,
        reason: string,
        operationId: string,
        transactionId?: string,
    ): Promise<{ consumedCredits: number; newBalance: number | null }> {
        if (!resolution.enabled) {
            throw new ForbiddenException(resolution.reason);
        }
        const creditCost = resolution.creditCost;
        if (resolution.source !== 'credits'
            || typeof creditCost !== 'number'
            || !Number.isSafeInteger(creditCost)
            || creditCost <= 0) {
            throw new ForbiddenException('Billable feature usage requires a positive separately purchased credit cost.');
        }
        const settlement = {
            tenantId,
            source: resolution.source,
            cost: creditCost,
            reason,
            operationId,
        };
        if (transactionId !== undefined) {
            return this.meteringService.recordCreditDebitInTransaction(tx, {
                tenantId,
                cost: creditCost,
                reason,
                transactionId,
            });
        }
        return this.meteringService.recordFeatureUsageInTransaction(tx, settlement);
    }
    private async loadTenantFeatureConfig(tx: TenantPrismaTransaction, tenantId: string): Promise<TenantFeatureConfig | null> {
        const tenantSetting = await tx.tenantSetting?.findUnique?.({
            where: {
                tenantId_key: {
                    tenantId,
                    key: TENANT_FEATURE_CONFIG_KEY,
                },
            },
            select: {
                value: true,
            },
        });

        if (!tenantSetting?.value || typeof tenantSetting.value !== 'object' || Array.isArray(tenantSetting.value)) {
            return null;
        }

        const config = tenantSetting.value as TenantFeatureConfig;
        if (!config.features || typeof config.features !== 'object' || Array.isArray(config.features)) {
            return null;
        }

        return config;
    }

    private async loadInternalBetaEntitlement(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ) {
        return tx.tenantSetting.findUnique({
            where: {
                tenantId_key: {
                    tenantId,
                    key: INTERNAL_BETA_ENTITLEMENT_KEY,
                },
            },
            select: { value: true },
        });
    }

    private async hasActiveInternalBetaSchedulingEntitlement(
        tx: TenantPrismaTransaction,
        tenantId: string,
        tenant: {
            planTier: TenantPlanTier;
            status: TenantStatusValue;
            trialEndsAt: Date | null;
        },
        setting: { value: Prisma.JsonValue } | null,
        now = new Date(),
    ): Promise<boolean> {
        const grant = parseActiveInternalBetaSchedulingEntitlement(setting?.value, now);
        if (
            !grant
            || tenant.planTier === 'FREE'
            || tenant.status !== 'TRIAL'
            || !(tenant.trialEndsAt instanceof Date)
            || tenant.trialEndsAt <= now
            || new Date(grant.expiresAt) > tenant.trialEndsAt
        ) {
            return false;
        }
        const [credit, audit] = await Promise.all([
            tx.creditTransaction.findUnique({
                where: { id: grant.creditTransactionId },
                select: {
                    tenantId: true,
                    amount: true,
                    debtAmount: true,
                    reason: true,
                    balanceAfter: true,
                    debtAfter: true,
                },
            }),
            tx.auditLog.findUnique({
                where: { id: grant.auditId },
                select: {
                    tenantId: true,
                    action: true,
                    resource: true,
                    resourceId: true,
                    newValue: true,
                },
            }),
        ]);
        return credit?.tenantId === tenantId
            && credit.amount === grant.creditsGranted
            && credit.debtAmount === 0
            && credit.reason === grant.ledgerReason
            && Number.isSafeInteger(credit.balanceAfter)
            && Number(credit.balanceAfter) >= 0
            && credit.debtAfter === 0
            && internalBetaGrantAuditMatches(grant, audit, tenantId);
    }

    private resolveFeature(
        tenant: {
            planTier: TenantPlanTier;
            status: TenantStatusValue;
            trialEndsAt: Date | null;
            usageCredits: number;
            creditDebt: number;
            stripeSubscriptionId: string | null;
            stripeSubscriptionCurrentPeriodEnd: Date | null;
        },
        feature: FeatureKey,
        featureConfig: TenantFeatureConfig | null,
        plan: Awaited<ReturnType<typeof resolveTenantPlanDefinition>> | null,
        requireBillableCredits = true,
        internalBetaSchedulingActive = false,
    ): FeatureResolution {
        const creditCost = FEATURE_CREDIT_COST[feature];
        const effectiveEntitlement = resolveEffectiveTenantEntitlement(tenant);
        const includedByPlan = coercePlanFeatureKeys(plan?.metadata ?? null, effectiveEntitlement.planCode).includes(feature);
        const paidSubscriptionActive = effectiveEntitlement.source === 'paid_subscription';
        const internalBetaActive = feature === 'scheduling' && internalBetaSchedulingActive;
        const override = featureConfig?.features?.[feature];

        if (override?.source === 'disabled' || override?.enabled === false) {
            return {
                enabled: false,
                source: 'disabled',
                reason: override.reason ?? `Feature ${feature} has been disabled for this tenant.`,
                creditCost,
            };
        }

        if (!paidSubscriptionActive && !internalBetaActive) {
            return {
                enabled: false,
                source: 'disabled',
                reason: 'Billable features require a current active paid subscription.',
                creditCost,
            };
        }

        const overrideEnabled = override?.enabled === true
            && (override.source === 'manual' || override.source === 'stripe' || override.source === 'credits');
        if (!includedByPlan && !overrideEnabled) {
            return {
                enabled: false,
                source: 'disabled',
                reason: 'Feature requires an active paid subscription that includes this feature.',
                creditCost,
            };
        }

        if (requireBillableCredits) {
            if (!Number.isSafeInteger(tenant.creditDebt) || tenant.creditDebt !== 0) {
                return {
                    enabled: false,
                    source: 'disabled',
                    reason: 'Billable feature usage is blocked until outstanding credit debt is repaid.',
                    creditCost,
                };
            }
            if (creditCost === null || !Number.isSafeInteger(creditCost) || creditCost <= 0) {
                return {
                    enabled: false,
                    source: 'disabled',
                    reason: `Feature ${feature} does not have a valid credit cost configured.`,
                    creditCost,
                };
            }
            if (tenant.usageCredits < creditCost) {
                return {
                    enabled: false,
                    source: 'disabled',
                    reason: `Feature requires ${creditCost} separately purchased usage credit${creditCost === 1 ? '' : 's'}.`,
                    creditCost,
                };
            }
        }

        return {
            enabled: true,
            source: 'credits',
            reason: internalBetaActive
                ? requireBillableCredits
                    ? `Enabled by an approved internal beta grant and finite ledger credits (${creditCost} credit per billable use).`
                    : 'Entitled by an approved, unexpired internal beta grant for a zero-settlement control, read, or recovery operation.'
                : requireBillableCredits
                    ? `Enabled by active paid subscription and separately purchased credits (${creditCost} credit per billable use).`
                    : 'Entitled by active paid subscription for a zero-settlement control, read, or recovery operation.',
            creditCost,
        };
    }
}
