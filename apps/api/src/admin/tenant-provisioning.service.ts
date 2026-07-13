import { BadRequestException } from '@nestjs/common';
import { PlanTier, TenantStatus, UserRole } from '@prisma/client';
import { RbacService } from '../auth/rbac.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';

export type PlatformTenantProvisioningInput = {
    name: string;
    slug: string;
    planTier: PlanTier;
    status: TenantStatus;
    trialEndsAt: Date | null;
    usageCredits: number;
    ownerName: string;
    ownerEmail: string;
    auditActor: {
        actorUserId: string | null;
        actorTenantId: string | null;
        ipAddress: string | null;
        userAgent: string | null;
    };
};

export class TenantProvisioningService {
    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly rbacService: RbacService,
    ) { }

    async createPlatformTenant(input: PlatformTenantProvisioningInput): Promise<{
        id: string;
        ownerId: string;
        planTier: PlanTier;
        status: TenantStatus;
        trialEndsAt: Date | null;
    }> {
        this.assertEntitlementState(input);

        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const tenant = await tx.tenant.create({
                data: {
                    name: input.name,
                    slug: input.slug,
                    planTier: input.planTier,
                    status: input.status,
                    trialEndsAt: input.trialEndsAt,
                    usageCredits: input.usageCredits,
                },
            });
            const owner = await tx.user.create({
                data: {
                    tenantId: tenant.id,
                    email: input.ownerEmail,
                    name: input.ownerName,
                    role: UserRole.ADMIN,
                },
            });

            await this.rbacService.provisionLegacySystemRole(
                tx,
                owner.id,
                tenant.id,
                UserRole.ADMIN,
            );
            await tx.auditLog.create({
                data: {
                    tenantId: tenant.id,
                    userId: null,
                    ...input.auditActor,
                    action: 'TENANT_CREATED',
                    resource: 'Tenant',
                    resourceId: tenant.id,
                },
            });

            return {
                id: tenant.id,
                ownerId: owner.id,
                planTier: input.planTier,
                status: input.status,
                trialEndsAt: input.trialEndsAt,
            };
        });
    }

    private assertEntitlementState(input: PlatformTenantProvisioningInput): void {
        if (input.planTier !== PlanTier.FREE && input.status === TenantStatus.ACTIVE) {
            throw new BadRequestException(
                'Paid tenants cannot be created ACTIVE without verified Stripe or manual entitlement proof. Create a bounded TRIAL instead.',
            );
        }

        if (input.status === TenantStatus.TRIAL) {
            if (!input.trialEndsAt || !Number.isFinite(input.trialEndsAt.getTime()) || input.trialEndsAt.getTime() <= Date.now()) {
                throw new BadRequestException('TRIAL tenants require a concrete future trialEndsAt.');
            }
            return;
        }

        if (input.trialEndsAt !== null) {
            throw new BadRequestException('trialEndsAt is only valid when status is TRIAL.');
        }
    }
}
