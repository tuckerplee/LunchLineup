import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { MeteringService } from './metering.service';
import {
    coercePlanFeatureKeys,
    FeatureKey,
    FEATURE_CREDIT_COST,
    FEATURE_KEYS,
    hasNonBlankStripeSubscriptionId,
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
        const { tenant, featureConfig } = await this.tenantDb.withTenant(tenantId, async (tx) => {
            const [tenant, featureConfig] = await Promise.all([
                tx.tenant.findUniqueOrThrow({
                    where: { id: tenantId },
                    select: {
                        id: true,
                        planTier: true,
                        status: true,
                        trialEndsAt: true,
                        usageCredits: true,
                        stripeSubscriptionId: true,
                        stripeSubscriptionCurrentPeriodEnd: true,
                    },
                }),
                this.loadTenantFeatureConfig(tx, tenantId),
            ]);
            return { tenant, featureConfig };
        });
        const effectiveEntitlement = resolveEffectiveTenantEntitlement(tenant);
        const plan = await resolveTenantPlanDefinition(this.prisma, effectiveEntitlement.planCode);

        const features = Object.fromEntries(
            FEATURE_KEYS.map((feature) => [
                feature,
                this.resolveFeature(tenant, feature, featureConfig, plan),
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
        const [tenant, featureConfig] = await Promise.all([
            tx.tenant.findUniqueOrThrow({
                where: { id: tenantId },
                select: {
                    id: true,
                    planTier: true,
                    status: true,
                    trialEndsAt: true,
                    usageCredits: true,
                    stripeSubscriptionId: true,
                    stripeSubscriptionCurrentPeriodEnd: true,
                },
            }),
            this.loadTenantFeatureConfig(tx, tenantId),
        ]);
        const effectiveEntitlement = resolveEffectiveTenantEntitlement(tenant);
        const plan = await resolveTenantPlanDefinition(tx, effectiveEntitlement.planCode);
        const resolution = this.resolveFeature(
            tenant,
            feature,
            featureConfig,
            plan,
            requireBillableCredits,
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
        return this.meteringService.recordFeatureUsageInTransaction(tx, {
            tenantId,
            source: resolution.source,
            cost: creditCost,
            reason,
            operationId,
        });
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

    private resolveFeature(
        tenant: {
            planTier: TenantPlanTier;
            status: TenantStatusValue;
            trialEndsAt: Date | null;
            usageCredits: number;
            stripeSubscriptionId: string | null;
            stripeSubscriptionCurrentPeriodEnd: Date | null;
        },
        feature: FeatureKey,
        featureConfig: TenantFeatureConfig | null,
        plan: Awaited<ReturnType<typeof resolveTenantPlanDefinition>> | null,
        requireBillableCredits = true,
    ): FeatureResolution {
        const creditCost = FEATURE_CREDIT_COST[feature];
        const effectiveEntitlement = resolveEffectiveTenantEntitlement(tenant);
        const includedByPlan = coercePlanFeatureKeys(plan?.metadata ?? null, effectiveEntitlement.planCode).includes(feature);
        const paidSubscriptionActive = effectiveEntitlement.source === 'paid_subscription';
        const override = featureConfig?.features?.[feature];

        if (override?.source === 'disabled' || override?.enabled === false) {
            return {
                enabled: false,
                source: 'disabled',
                reason: override.reason ?? `Feature ${feature} has been disabled for this tenant.`,
                creditCost,
            };
        }

        if (!paidSubscriptionActive) {
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
            reason: requireBillableCredits
                ? `Enabled by active paid subscription and separately purchased credits (${creditCost} credit per billable use).`
                : 'Entitled by active paid subscription for a zero-settlement control, read, or recovery operation.',
            creditCost,
        };
    }
}
