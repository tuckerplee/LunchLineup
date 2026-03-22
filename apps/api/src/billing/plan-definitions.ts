import { Prisma } from '@prisma/client';

export type FeatureKey = 'scheduling' | 'lunch_breaks';

export type TenantPlanCode = 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';

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
    GROWTH: ['scheduling', 'lunch_breaks'],
    ENTERPRISE: ['scheduling', 'lunch_breaks'],
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

export function coercePlanFeatureKeys(metadata: Prisma.JsonValue | null | undefined, fallbackCode: TenantPlanCode): FeatureKey[] {
    const raw = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>).features
        : undefined;

    const features = Array.isArray(raw)
        ? raw.filter((item): item is FeatureKey => item === 'scheduling' || item === 'lunch_breaks')
        : [];

    return features.length > 0 ? features : DEFAULT_PLAN_FEATURES[fallbackCode];
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
    const exactMatch = await prisma.planDefinition?.findUnique?.({
        where: { code: normalized },
    });

    if (exactMatch) {
        return exactMatch;
    }

    const fallback = resolveFallbackPlanDefinition(normalized) ?? DEFAULT_PLAN_DEFINITIONS[0];
    const record = await prisma.planDefinition?.findUnique?.({
        where: { code: fallback.code },
    });

    return record ?? fallback;
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
