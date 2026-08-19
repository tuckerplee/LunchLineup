import { Prisma } from '@prisma/client';

export const FEATURE_KEYS = ['scheduling', 'lunch_breaks', 'time_cards', 'webhooks'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_CREDIT_COST = {
    scheduling: 1,
    lunch_breaks: 1,
    time_cards: 1,
    webhooks: 1,
} as const satisfies Record<FeatureKey, number>;

export type TenantPlanCode = 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';

export type TenantEntitlementSnapshot = {
    planTier: string;
    status?: string | null;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionCurrentPeriodEnd?: Date | string | null;
    trialEndsAt?: Date | string | null;
};

export type EffectiveTenantEntitlement = {
    planCode: TenantPlanCode;
    source: 'free' | 'paid_subscription' | 'trial';
};

export type PlanDefinitionFeatureSet = Partial<Record<FeatureKey, true>>;

export interface PlanDefinitionRecord {
    id: string;
    code: string;
    name: string;
    monthlyPriceCents: number | null;
    locationLimit: number | null;
    userLimit: number | null;
    creditQuotaLimit: number | null;
    active: boolean;
    metadata: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface TenantFeatureConfig {
    features?: Partial<Record<FeatureKey, { source?: 'plan' | 'stripe' | 'credits' | 'manual' | 'disabled'; enabled?: boolean; reason?: string }>>;
}

export const INTERNAL_BETA_ENTITLEMENT_KEY = 'internal_beta_entitlement';
export const INTERNAL_BETA_ENTITLEMENTS_ENABLED_ENV = 'INTERNAL_BETA_ENTITLEMENTS_ENABLED';
export const INTERNAL_BETA_ORIGIN = 'https://beta.lunchlineup.com';
export const INTERNAL_BETA_MAX_CREDITS = 1_000;
export const INTERNAL_BETA_MAX_DAYS = 90;

export type InternalBetaSchedulingEntitlement = {
    version: 1;
    source: 'internal_beta';
    status: 'ACTIVE';
    features: ['scheduling'];
    grantId: string;
    auditId: string;
    creditTransactionId: string;
    creditsGranted: number;
    ledgerReason: string;
    reason: string;
    approvedAt: string;
    approvedByUserId: string;
    expiresAt: string;
};

function isNonEmptyBoundedString(value: unknown, maximumLength: number): value is string {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= maximumLength
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseStoredDate(value: unknown): Date | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function internalBetaEntitlementsRuntimeEnabled(
    env: Partial<Pick<NodeJS.ProcessEnv, 'INTERNAL_BETA_ENTITLEMENTS_ENABLED' | 'APP_ORIGIN'>> = process.env,
): boolean {
    if (env.INTERNAL_BETA_ENTITLEMENTS_ENABLED?.trim().toLowerCase() !== 'true') return false;
    try {
        const origin = new URL(env.APP_ORIGIN ?? '');
        return origin.origin === INTERNAL_BETA_ORIGIN
            && origin.pathname === '/'
            && !origin.search
            && !origin.hash
            && !origin.username
            && !origin.password;
    } catch {
        return false;
    }
}

export function parseActiveInternalBetaSchedulingEntitlement(
    value: Prisma.JsonValue | null | undefined,
    now = new Date(),
): InternalBetaSchedulingEntitlement | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const grant = value as Record<string, unknown>;
    const approvedAt = parseStoredDate(grant.approvedAt);
    const expiresAt = parseStoredDate(grant.expiresAt);
    if (
        grant.version !== 1
        || grant.source !== 'internal_beta'
        || grant.status !== 'ACTIVE'
        || !Array.isArray(grant.features)
        || grant.features.length !== 1
        || grant.features[0] !== 'scheduling'
        || !isNonEmptyBoundedString(grant.grantId, 255)
        || grant.auditId !== `${grant.grantId}-internal-beta-audit`
        || grant.creditTransactionId !== grant.grantId
        || !Number.isSafeInteger(grant.creditsGranted)
        || Number(grant.creditsGranted) < 1
        || Number(grant.creditsGranted) > INTERNAL_BETA_MAX_CREDITS
        || !isNonEmptyBoundedString(grant.ledgerReason, 500)
        || !isNonEmptyBoundedString(grant.reason, 240)
        || !isNonEmptyBoundedString(grant.approvedByUserId, 255)
        || !approvedAt
        || !expiresAt
        || approvedAt > now
        || expiresAt <= now
        || expiresAt <= approvedAt
    ) {
        return null;
    }
    return grant as InternalBetaSchedulingEntitlement;
}

export function internalBetaGrantAuditMatches(
    grant: InternalBetaSchedulingEntitlement,
    audit: {
        tenantId: string;
        action: string;
        resource: string;
        resourceId: string | null;
        newValue: Prisma.JsonValue | null;
    } | null,
    tenantId: string,
): boolean {
    const value = audit?.newValue;
    const storedEntitlement = value
        && typeof value === 'object'
        && !Array.isArray(value)
        && value.entitlement
        && typeof value.entitlement === 'object'
        && !Array.isArray(value.entitlement)
        ? value.entitlement as Record<string, unknown>
        : null;
    return audit?.tenantId === tenantId
        && audit.action === 'INTERNAL_BETA_ENTITLEMENT_GRANTED'
        && audit.resource === 'TenantSetting'
        && audit.resourceId === grant.grantId
        && storedEntitlement?.grantId === grant.grantId
        && storedEntitlement.auditId === grant.auditId
        && storedEntitlement.creditTransactionId === grant.creditTransactionId
        && storedEntitlement.creditsGranted === grant.creditsGranted
        && storedEntitlement.ledgerReason === grant.ledgerReason
        && storedEntitlement.reason === grant.reason
        && storedEntitlement.approvedAt === grant.approvedAt
        && storedEntitlement.approvedByUserId === grant.approvedByUserId
        && storedEntitlement.expiresAt === grant.expiresAt;
}

export interface PlanDefinitionResponse {
    id: string;
    code: string;
    key: string;
    name: string;
    status: 'ACTIVE' | 'INACTIVE';
    active: boolean;
    monthlyPriceCents: number | null;
    priceMonthly: number | null;
    locationLimit: number | null;
    maxLocations: number | null;
    storeLimit: number | null;
    userLimit: number | null;
    maxUsers: number | null;
    creditQuotaLimit: number | null;
    creditsLimit: number | null;
    metadata: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
}

type PrismaLike = {
    planDefinition?: {
        findUnique?: (args: any) => Promise<PlanDefinitionRecord | null>;
        findMany?: (args: any) => Promise<PlanDefinitionRecord[]>;
    };
};

export const DEFAULT_PLAN_FEATURES: Record<TenantPlanCode, FeatureKey[]> = {
    FREE: [],
    STARTER: ['scheduling'],
    GROWTH: ['scheduling', 'lunch_breaks', 'time_cards', 'webhooks'],
    ENTERPRISE: ['scheduling', 'lunch_breaks', 'time_cards', 'webhooks'],
};

export const DEFAULT_PLAN_DEFINITIONS: PlanDefinitionRecord[] = [
    {
        id: 'default-free',
        code: 'FREE',
        name: 'Free',
        monthlyPriceCents: null,
        locationLimit: 1,
        userLimit: 10,
        creditQuotaLimit: null,
        active: true,
        metadata: { features: DEFAULT_PLAN_FEATURES.FREE },
        createdAt: new Date(0),
        updatedAt: new Date(0),
    },
    {
        id: 'default-starter',
        code: 'STARTER',
        name: 'Starter',
        monthlyPriceCents: 3900,
        locationLimit: 5,
        userLimit: 50,
        creditQuotaLimit: null,
        active: true,
        metadata: { features: DEFAULT_PLAN_FEATURES.STARTER },
        createdAt: new Date(0),
        updatedAt: new Date(0),
    },
    {
        id: 'default-growth',
        code: 'GROWTH',
        name: 'Growth',
        monthlyPriceCents: 7900,
        locationLimit: 25,
        userLimit: 250,
        creditQuotaLimit: null,
        active: true,
        metadata: { features: DEFAULT_PLAN_FEATURES.GROWTH },
        createdAt: new Date(0),
        updatedAt: new Date(0),
    },
    {
        id: 'default-enterprise',
        code: 'ENTERPRISE',
        name: 'Enterprise',
        monthlyPriceCents: null,
        locationLimit: null,
        userLimit: null,
        creditQuotaLimit: null,
        active: true,
        metadata: { features: DEFAULT_PLAN_FEATURES.ENTERPRISE },
        createdAt: new Date(0),
        updatedAt: new Date(0),
    },
];

export function isTenantPlanCode(value: string): value is TenantPlanCode {
    return ['FREE', 'STARTER', 'GROWTH', 'ENTERPRISE'].includes(value);
}

export function normalizePlanCode(value: string): string {
    return value.trim().toUpperCase();
}

export function hasNonBlankStripeSubscriptionId(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function hasFutureStripeSubscriptionCurrentPeriodEnd(
    value: unknown,
    now = new Date(),
): boolean {
    const periodEnd = value instanceof Date
        ? value
        : typeof value === 'string'
            ? new Date(value)
            : null;
    return periodEnd !== null
        && Number.isFinite(periodEnd.getTime())
        && periodEnd.getTime() > now.getTime();
}

export function resolveEffectiveTenantEntitlement(
    tenant: TenantEntitlementSnapshot,
    now = new Date(),
): EffectiveTenantEntitlement {
    const normalizedPlan = normalizePlanCode(tenant.planTier || 'FREE');
    const planCode = isTenantPlanCode(normalizedPlan) ? normalizedPlan : 'FREE';
    if (planCode === 'FREE') {
        return { planCode: 'FREE', source: 'free' };
    }

    const status = String(tenant.status ?? '').toUpperCase();
    if (status === 'ACTIVE'
        && hasNonBlankStripeSubscriptionId(tenant.stripeSubscriptionId)
        && hasFutureStripeSubscriptionCurrentPeriodEnd(
            tenant.stripeSubscriptionCurrentPeriodEnd,
            now,
        )) {
        return { planCode, source: 'paid_subscription' };
    }

    const trialEndsAt = tenant.trialEndsAt instanceof Date
        ? tenant.trialEndsAt
        : typeof tenant.trialEndsAt === 'string'
            ? new Date(tenant.trialEndsAt)
            : null;
    if (status === 'TRIAL'
        && trialEndsAt
        && Number.isFinite(trialEndsAt.getTime())
        && trialEndsAt.getTime() > now.getTime()) {
        return { planCode, source: 'trial' };
    }

    return { planCode: 'FREE', source: 'free' };
}

export function coercePlanFeatureKeys(metadata: Prisma.JsonValue | null | undefined, fallbackCode: TenantPlanCode): FeatureKey[] {
    const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : null;
    if (!metadataRecord || !Object.prototype.hasOwnProperty.call(metadataRecord, 'features')) {
        return DEFAULT_PLAN_FEATURES[fallbackCode];
    }

    const raw = metadataRecord.features;
    const featureKeys = new Set<string>(FEATURE_KEYS);
    if (!Array.isArray(raw)
        || raw.some((item) => typeof item !== 'string' || !featureKeys.has(item))) {
        return [];
    }

    return Array.from(new Set(raw as FeatureKey[]));
}

export function planDefinitionToResponse(plan: PlanDefinitionRecord): PlanDefinitionResponse {
    const locationLimit = plan.locationLimit ?? null;
    const userLimit = plan.userLimit ?? null;
    const creditQuotaLimit = plan.creditQuotaLimit ?? null;
    const monthlyPriceCents = plan.monthlyPriceCents ?? null;
    return {
        id: plan.id,
        code: plan.code,
        key: plan.code,
        name: plan.name,
        status: plan.active ? 'ACTIVE' : 'INACTIVE',
        active: plan.active,
        monthlyPriceCents,
        priceMonthly: monthlyPriceCents === null ? null : monthlyPriceCents / 100,
        locationLimit,
        maxLocations: locationLimit,
        storeLimit: locationLimit,
        userLimit,
        maxUsers: userLimit,
        creditQuotaLimit,
        creditsLimit: creditQuotaLimit,
        metadata: plan.metadata ?? null,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
    };
}

export function resolveFallbackPlanDefinition(code: string): PlanDefinitionRecord | null {
    const normalized = normalizePlanCode(code);
    if (!isTenantPlanCode(normalized)) {
        return null;
    }

    return DEFAULT_PLAN_DEFINITIONS.find((plan) => plan.code === normalized) ?? null;
}

export async function resolveTenantPlanDefinition(prisma: PrismaLike, code: string): Promise<PlanDefinitionRecord | null> {
    const normalized = normalizePlanCode(code);
    if (prisma.planDefinition?.findUnique) {
        return prisma.planDefinition.findUnique({
            where: { code: normalized },
        });
    }

    const fallback = resolveFallbackPlanDefinition(normalized) ?? DEFAULT_PLAN_DEFINITIONS[0];
    return fallback;
}

export async function listPlanDefinitions(prisma: PrismaLike): Promise<PlanDefinitionRecord[]> {
    if (!prisma.planDefinition?.findMany) {
        return DEFAULT_PLAN_DEFINITIONS;
    }

    const records = await prisma.planDefinition.findMany({
        orderBy: [
            { active: 'desc' },
            { code: 'asc' },
        ],
    });

    return records.length > 0 ? records : DEFAULT_PLAN_DEFINITIONS;
}
