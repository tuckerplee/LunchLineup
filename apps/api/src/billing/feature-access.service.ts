import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { PrismaClient, PlanTier, TenantStatus } from '@prisma/client';
import { MeteringService } from './metering.service';

export type FeatureKey = 'scheduling' | 'lunch_breaks';

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

const PLAN_FEATURES: Record<PlanTier, FeatureKey[]> = {
    FREE: [],
    STARTER: ['scheduling'],
    GROWTH: ['scheduling', 'lunch_breaks'],
    ENTERPRISE: ['scheduling', 'lunch_breaks'],
};

@Injectable()
export class FeatureAccessService {
    private readonly prisma: PrismaClient;

    constructor(
        private readonly meteringService: MeteringService,
        @Optional() prisma?: PrismaClient,
    ) {
        this.prisma = prisma ?? new PrismaClient();
    }

    async getFeatureMatrix(tenantId: string): Promise<FeatureMatrix> {
        const tenant = await this.prisma.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: {
                id: true,
                planTier: true,
                status: true,
                usageCredits: true,
                stripeSubscriptionId: true,
            },
        });

        const features: Record<FeatureKey, FeatureResolution> = {
            scheduling: this.resolveFeature(tenant, 'scheduling'),
            lunch_breaks: this.resolveFeature(tenant, 'lunch_breaks'),
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

    private resolveFeature(
        tenant: { planTier: PlanTier; status: TenantStatus; usageCredits: number; stripeSubscriptionId: string | null },
        feature: FeatureKey,
    ): FeatureResolution {
        const creditCost = FEATURE_COST[feature];
        const includedByPlan = PLAN_FEATURES[tenant.planTier]?.includes(feature) ?? false;
        const stripeActive = tenant.status === TenantStatus.ACTIVE && Boolean(tenant.stripeSubscriptionId);
        const hasCredits = tenant.usageCredits >= creditCost;

        if (includedByPlan) {
            return {
                enabled: true,
                source: 'plan',
                reason: `Included in ${tenant.planTier.toLowerCase()} plan.`,
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
            reason: `upgrade plan, connect Stripe, or add credits to enable`,
            creditCost,
        };
    }
}

