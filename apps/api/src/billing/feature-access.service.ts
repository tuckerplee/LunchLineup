import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MeteringService } from './metering.service';
import {
    coercePlanFeatureKeys,
    FeatureKey,
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
    usageCredits: number;
    features: Record<FeatureKey, FeatureResolution>;
};

const FEATURE_COST: Record<FeatureKey, number> = {
    scheduling: 1,
    lunch_breaks: 1,
};

const TENANT_FEATURE_CONFIG_KEY = 'feature_access';

@Injectable()
export class FeatureAccessService {
    private readonly prisma: PrismaClient;

    constructor(
        private readonly meteringService: MeteringService,
        @Optional() prisma?: PrismaClient,
    ) {
        this.prisma = prisma ?? new PrismaClient();
    }

    async resolveTenantFeatures(tenantId: string): Promise<FeatureMatrix> {
        return this.getFeatureMatrix(tenantId);
    }

    async getFeatureMatrix(tenantId: string): Promise<FeatureMatrix> {
        const [tenant, featureConfig] = await Promise.all([
            this.prisma.tenant.findUniqueOrThrow({
                where: { id: tenantId },
                select: {
                    id: true,
                    planTier: true,
                    status: true,
                    usageCredits: true,
                    stripeSubscriptionId: true,
                },
            }),
            this.loadTenantFeatureConfig(tenantId),
        ]);
        const plan = await resolveTenantPlanDefinition(this.prisma, tenant.planTier);

        const features: Record<FeatureKey, FeatureResolution> = {
            scheduling: this.resolveFeature(tenant, 'scheduling', featureConfig, plan),
            lunch_breaks: this.resolveFeature(tenant, 'lunch_breaks', featureConfig, plan),
        };

        return {
            usageCredits: tenant.usageCredits,
            features,
        };
    }

    async assertFeatureEnabled(tenantId: string, feature: FeatureKey): Promise<void> {
        const matrix = await this.getFeatureMatrix(tenantId);
        const resolution = matrix.features[feature];
        if (!resolution.enabled) {
            throw new ForbiddenException(resolution.reason);
        }
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

        return { consumedCredits: 0, newBalance: matrix.usageCredits };
    }

    private async loadTenantFeatureConfig(tenantId: string): Promise<TenantFeatureConfig | null> {
        const tenantSetting = await this.prisma.tenantSetting?.findUnique?.({
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
        tenant: { planTier: TenantPlanTier; status: TenantStatusValue; usageCredits: number; stripeSubscriptionId: string | null },
        feature: FeatureKey,
        featureConfig: TenantFeatureConfig | null,
        plan: Awaited<ReturnType<typeof resolveTenantPlanDefinition>> | null,
    ): FeatureResolution {
        const creditCost = FEATURE_COST[feature];
        const includedByPlan = coercePlanFeatureKeys(plan?.metadata ?? null, tenant.planTier).includes(feature);
        const stripeActive = tenant.status === 'ACTIVE' && Boolean(tenant.stripeSubscriptionId);
        const hasCredits = tenant.usageCredits >= creditCost;
        const override = featureConfig?.features?.[feature];

        if (override?.source === 'disabled' || override?.enabled === false) {
            return {
                enabled: false,
                source: 'disabled',
                reason: override.reason ?? `Feature ${feature} has been disabled for this tenant.`,
                creditCost,
            };
        }

        if (override?.source === 'manual' && override.enabled === true) {
            return {
                enabled: true,
                source: 'manual',
                reason: override.reason ?? `Feature ${feature} was enabled manually.`,
                creditCost,
            };
        }

        if (override?.source === 'stripe') {
            if (stripeActive) {
                return {
                    enabled: true,
                    source: 'stripe',
                    reason: override.reason ?? 'Enabled by active Stripe subscription.',
                    creditCost,
                };
            }

            return {
                enabled: false,
                source: 'disabled',
                reason: override.reason ?? 'Feature requires an active Stripe subscription.',
                creditCost,
            };
        }

        if (override?.source === 'credits') {
            if (hasCredits) {
                return {
                    enabled: true,
                    source: 'credits',
                    reason: override.reason ?? `Enabled using usage credits (${creditCost} credit per run).`,
                    creditCost,
                };
            }

            return {
                enabled: false,
                source: 'disabled',
                reason: override.reason ?? 'Insufficient usage credits.',
                creditCost,
            };
        }

        if (includedByPlan) {
            return {
                enabled: true,
                source: 'plan',
                reason: plan?.name ? `Included in ${plan.name} plan.` : `Included in ${tenant.planTier.toLowerCase()} plan.`,
                creditCost,
            };
        }

        if (stripeActive) {
            return {
                enabled: true,
                source: 'stripe',
                reason: 'Enabled by active Stripe subscription.',
                creditCost,
            };
        }

        if (hasCredits) {
            return {
                enabled: true,
                source: 'credits',
                reason: `Enabled using usage credits (${creditCost} credit per run).`,
                creditCost,
            };
        }

        return {
            enabled: false,
            source: 'disabled',
            reason: `Upgrade plan, connect Stripe, or add credits to enable`,
            creditCost,
        };
    }
}
