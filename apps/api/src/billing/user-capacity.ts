import { BadRequestException } from '@nestjs/common';
import { resolveTenantPlanDefinition } from './plan-definitions';

type PrismaLike = {
    tenant: {
        findUnique?: (args: any) => Promise<{ planTier: string } | null>;
    };
    user: {
        count?: (args: any) => Promise<number>;
    };
    planDefinition?: {
        findUnique?: (args: any) => Promise<any>;
        findMany?: (args: any) => Promise<any>;
    };
};

export async function assertTenantCanAddActiveUser(prisma: PrismaLike, tenantId: string): Promise<void> {
    const tenant = await prisma.tenant.findUnique?.({
        where: { id: tenantId },
        select: { planTier: true },
    });

    if (!tenant) {
        throw new BadRequestException('Tenant not found');
    }

    const plan = await resolveTenantPlanDefinition(prisma as any, tenant.planTier);
    const userLimit = plan?.userLimit ?? null;
    if (userLimit === null) {
        return;
    }

    const activeUserCount = await prisma.user.count?.({
        where: {
            tenantId,
            deletedAt: null,
        },
    });

    if ((activeUserCount ?? 0) >= userLimit) {
        const planCode = plan?.code ?? tenant.planTier;
        throw new BadRequestException(`User limit reached for ${planCode} plan.`);
    }
}
