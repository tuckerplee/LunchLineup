import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { resolveEffectiveTenantEntitlement, resolveTenantPlanDefinition } from './plan-definitions';

type PrismaLike = {
    $executeRaw?: (strings: TemplateStringsArray, ...values: any[]) => Promise<unknown>;
    tenant: {
        findUnique?: (args: any) => Promise<{
            planTier: string;
            status?: string;
            stripeSubscriptionId?: string | null;
            stripeSubscriptionCurrentPeriodEnd?: Date | null;
            trialEndsAt?: Date | null;
        } | null>;
        findMany?: (args: any) => Promise<Array<{ id: string }>>;
    };
    user?: {
        count?: (args: any) => Promise<number>;
    };
    location?: {
        count?: (args: any) => Promise<number>;
    };
    planDefinition?: {
        findUnique?: (args: any) => Promise<any>;
        findMany?: (args: any) => Promise<any>;
    };
};

export async function assertTenantCanAddActiveUser(prisma: PrismaLike, tenantId: string): Promise<void> {
    await lockTenantCapacity(prisma, tenantId);
    const tenant = await prisma.tenant.findUnique?.({
        where: { id: tenantId },
        select: {
            planTier: true,
            status: true,
            stripeSubscriptionId: true,
            stripeSubscriptionCurrentPeriodEnd: true,
            trialEndsAt: true,
        },
    });

    if (!tenant) {
        throw new BadRequestException('Tenant not found');
    }

    const effectivePlanCode = resolveEffectiveTenantEntitlement(tenant).planCode;
    const plan = await resolveTenantPlanDefinition(prisma as any, effectivePlanCode);
    if (!plan) {
        throw new ServiceUnavailableException(`Plan ${effectivePlanCode} is not configured`);
    }
    const userLimit = plan.userLimit ?? null;
    if (userLimit === null) {
        return;
    }

    const activeUserCount = await prisma.user?.count?.({
        where: {
            tenantId,
            deletedAt: null,
            suspendedAt: null,
        },
    });

    if ((activeUserCount ?? 0) >= userLimit) {
        throw new BadRequestException(`User limit reached for ${plan.code} plan.`);
    }
}

export async function assertTenantActiveUserCountWithinPlan(prisma: PrismaLike, tenantId: string, planCode: string): Promise<void> {
    await lockTenantCapacity(prisma, tenantId);
    const plan = await resolveTenantPlanDefinition(prisma as any, planCode);
    if (!plan) {
        throw new ServiceUnavailableException(`Plan ${planCode} is not configured`);
    }
    const userLimit = plan.userLimit ?? null;
    if (userLimit === null) {
        return;
    }

    const activeUserCount = await prisma.user?.count?.({
        where: {
            tenantId,
            deletedAt: null,
            suspendedAt: null,
        },
    });

    if ((activeUserCount ?? 0) > userLimit) {
        throw new BadRequestException(`Tenant has ${activeUserCount} active users, which exceeds the ${plan.code} plan limit of ${userLimit}.`);
    }
}

export async function assertTenantActiveLocationCountWithinPlan(prisma: PrismaLike, tenantId: string, planCode: string): Promise<void> {
    await lockTenantCapacity(prisma, tenantId);
    const plan = await resolveTenantPlanDefinition(prisma as any, planCode);
    if (!plan) {
        throw new ServiceUnavailableException(`Plan ${planCode} is not configured`);
    }
    const locationLimit = plan.locationLimit ?? null;
    if (locationLimit === null) {
        return;
    }

    const activeLocationCount = await prisma.location?.count?.({
        where: {
            tenantId,
            deletedAt: null,
        },
    });

    if ((activeLocationCount ?? 0) > locationLimit) {
        throw new BadRequestException(`Tenant has ${activeLocationCount} active locations, which exceeds the ${plan.code} plan limit of ${locationLimit}.`);
    }
}

export async function assertPlanUserLimitChangeAllowsExistingTenants(
    prisma: PrismaLike,
    planCode: string,
    userLimit: number | null,
): Promise<void> {
    if (userLimit === null) {
        return;
    }

    const tenants = await prisma.tenant.findMany?.({
        where: {
            planTier: planCode,
            deletedAt: null,
        },
        select: { id: true },
        orderBy: { id: 'asc' },
    }) ?? [];

    for (const tenant of tenants) {
        await lockTenantCapacity(prisma, tenant.id);
        const activeUserCount = await prisma.user?.count?.({
            where: {
                tenantId: tenant.id,
                deletedAt: null,
                suspendedAt: null,
            },
        });
        if ((activeUserCount ?? 0) > userLimit) {
            throw new BadRequestException(`Tenant ${tenant.id} has ${activeUserCount} active users, which exceeds the ${planCode} plan limit of ${userLimit}.`);
        }
    }
}

async function lockTenantCapacity(prisma: PrismaLike, tenantId: string): Promise<void> {
    if (prisma.$executeRaw) {
        await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`;
    }
}
