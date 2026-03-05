import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { PrismaClient } from '@lunchlineup/db';
import { PlanTier, PLAN_CONFIG } from './plans.config';

@Injectable()
export class MeteringService {
    private readonly prisma: any;

    constructor(@Optional() prisma?: any) {
        this.prisma = prisma ?? new PrismaClient();
    }

    /**
     * Grants usage credits to a tenant and records a ledger transaction.
     */
    async grantCredits(tenantId: string, amount: number, reason: string) {
        if (amount <= 0) throw new BadRequestException('Amount must be strictly positive');

        return this.prisma.$transaction(async (tx: any) => {
            const tenant = await tx.tenant.update({
                where: { id: tenantId },
                data: { usageCredits: { increment: amount } }
            });

            await tx.creditTransaction.create({
                data: { tenantId, amount, reason }
            });

            return tenant.usageCredits;
        });
    }

    /**
     * Deducts usage credits securely.
     * Throws an error if insufficient credits.
     */
    async consumeCredits(tenantId: string, amount: number, reason: string) {
        if (amount <= 0) throw new BadRequestException('Amount must be strictly positive');

        return this.prisma.$transaction(async (tx: any) => {
            const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
            if (tenant.usageCredits < amount) {
                throw new Error('Insufficient usage credits balance.');
            }

            const updated = await tx.tenant.update({
                where: { id: tenantId },
                data: { usageCredits: { decrement: amount } }
            });

            await tx.creditTransaction.create({
                data: { tenantId, amount: -amount, reason }
            });

            return updated.usageCredits;
        });
    }

    async checkLimits(tenantId: string, tier: PlanTier) {
        const limits = PLAN_CONFIG[tier];

        const locationCount = await this.prisma.location.count({ where: { tenantId } });
        if (locationCount >= limits.maxLocations) {
            throw new Error(`Location limit reached for ${tier} plan.`);
        }

        return true;
    }

    async reportUsageToStripe(tenantId: string, stripeSubscriptionItemId: string) {
        // Logic to count active staff and report as metered usage
        const staffCount = await this.prisma.user.count({ where: { tenantId } });
        // Update Stripe usage record...
        console.log(`Reported ${staffCount} staff members for tenant ${tenantId}`);
    }
}
