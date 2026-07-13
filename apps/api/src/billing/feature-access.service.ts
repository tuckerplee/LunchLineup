import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { MeteringService } from './metering.service';
import {
    coercePlanFeatureKeys,
    FeatureKey,
    FEATURE_KEYS,
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
    usageCredits: number;
    features: Record<FeatureKey, FeatureResolution>;
};

const FEATURE_COST: Record<FeatureKey, number | null> = {
    scheduling: 1,
    lunch_breaks: 1,
    time_cards: 1,
    webhooks: 1,
};

const TENANT_FEATURE_CONFIG_KEY = 'feature_access';
const FEATURE_START_TENANT_STATUSES = new Set<TenantStatusValue>(['TRIAL', 'ACTIVE']);

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
            stripeSubscriptionActive: tenant.status === 'ACTIVE' && Boolean(tenant.stripeSubscriptionId),
            stripeSubscriptionPresent: Boolean(tenant.stripeSubscriptionId),
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

    async assertFeatureEnabledInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        feature: FeatureKey,
    ): Promise<FeatureResolution> {
        await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
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
                },
            }),
            this.loadTenantFeatureConfig(tx, tenantId),
        ]);
        const effectiveEntitlement = resolveEffectiveTenantEntitlement(tenant);
        const plan = await resolveTenantPlanDefinition(tx, effectiveEntitlement.planCode);
        const resolution = this.resolveFeature(tenant, feature, featureConfig, plan);
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
        return this.meteringService.recordFeatureUsageInTransaction(tx, {
            tenantId,
            source: resolution.source,
            cost: resolution.creditCost ?? 0,
            reason,
            operationId,
        });
    }

    async consumeCreditsForFeature(
        tenantId: string,
        feature: FeatureKey,
        reason: string,
    ): Promise<{ consumedCredits: number; newBalance: number | null }> {
        const matrix = await this.getFeatureMatrix(tenantId);
        const resolution = matrix.features[feature];
        if (!resolution.enabled) {
            throw new ForbiddenException(resolution.reason);
        }

        const cost = resolution.creditCost ?? 0;
        if (resolution.source === 'credits' && cost > 0) {
            const newBalance = await this.meteringService.consumeCredits(tenantId, cost, reason);
            return { consumedCredits: cost, newBalance };
        }

        if ((resolution.source === 'plan' || resolution.source === 'stripe') && cost > 0) {
            const newBalance = await this.meteringService.trackIncludedUsage(tenantId, cost, reason);
            return { consumedCredits: cost, newBalance };
        }

        return { consumedCredits: 0, newBalance: matrix.usageCredits };
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
        tenant: { planTier: TenantPlanTier; status: TenantStatusValue; trialEndsAt: Date | null; usageCredits: number; stripeSubscriptionId: string | null },
        feature: FeatureKey,
        featureConfig: TenantFeatureConfig | null,
        plan: Awaited<ReturnType<typeof resolveTenantPlanDefinition>> | null,
    ): FeatureResolution {
        const creditCost = FEATURE_COST[feature];
        const effectiveEntitlement = resolveEffectiveTenantEntitlement(tenant);
        const includedByPlan = coercePlanFeatureKeys(plan?.metadata ?? null, effectiveEntitlement.planCode).includes(feature);
        const paidSubscriptionActive = effectiveEntitlement.source === 'paid_subscription';
        const subscriptionEntitled = paidSubscriptionActive || effectiveEntitlement.source === 'trial';
        const creditEligible = creditCost !== null && creditCost > 0;
        const override = featureConfig?.features?.[feature];

        if (!FEATURE_START_TENANT_STATUSES.has(tenant.status)) {
            return {
                enabled: false,
                source: 'disabled',
                reason: 'Feature starts require a trial or active tenant.',
                creditCost,
            };
        }
        if (override?.source === 'disabled' || override?.enabled === false) {
            return {
                enabled: false,
                source: 'disabled',
                reason: override.reason ?? `Feature ${feature} has been disabled for this tenant.`,
                creditCost,
            };
        }

        const overrideEnabled = override?.enabled === true
            && (override.source === 'manual' || override.source === 'stripe' || override.source === 'credits');
        const entitlementSourceAllowed = override?.source === 'stripe'
            ? paidSubscriptionActive
            : subscriptionEntitled;
        const subscriptionIncludesFeature = entitlementSourceAllowed && (includedByPlan || overrideEnabled);
        if (!subscriptionIncludesFeature) {
            return {
                enabled: false,
                source: 'disabled',
                reason: 'Feature requires an active subscription that includes this feature.',
                creditCost,
            };
        }

        if (!creditEligible) {
            return {
                enabled: false,
                source: 'disabled',
                reason: `Feature ${feature} does not have a valid credit cost configured.`,
                creditCost,
            };
        }

        return {
            enabled: true,
            source: 'credits',
            reason: `Enabled by ${effectiveEntitlement.source === 'trial' ? 'unexpired trial' : 'active subscription'} (${creditCost} credit per billable use).`,
            creditCost,
        };
    }
}
