import { Injectable, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';

/**
 * Custom Rate Limits Guard.
 * Overrides the default HTTP throttler to derive dynamic limits based on the resolved `tenantId`
 * and its corresponding `planTier` (FREE, STARTER, GROWTH, ENTERPRISE).
 * Architecture Part VII-A.8
 */
@Injectable()
export class RateLimitsGuard extends ThrottlerGuard {

    private planLimits: Record<string, { ttl: number; limit: number }> = {
        FREE: { ttl: 60000, limit: 60 },        // 60 req/min
        STARTER: { ttl: 60000, limit: 300 },    // 300 req/min
        GROWTH: { ttl: 60000, limit: 1000 },    // 1000 req/min
        ENTERPRISE: { ttl: 60000, limit: 5000 } // 5000 req/min (or effectively uncapped at edge)
    };

    protected async handleRequest(
        context: ExecutionContext,
        limit: number,
        ttl: number,
        throttler: any
    ): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const user = req.user;

        // Default to FREE tier limits if not authenticated
        let appliedLimit = this.planLimits.FREE.limit;
        let appliedTtl = this.planLimits.FREE.ttl;

        // In a real implementation: fetch the tenant's planTier from the database
        // For example: const tenant = await prisma.tenant.findUnique({...});
        // Here we simulate resolving the tenant's plan tier:
        if (user && user.tenantId) {
            // Simulated tenant resolution (e.g. assume STARTER for authed users context)
            const tenantPlan = 'STARTER';

            if (this.planLimits[tenantPlan]) {
                appliedLimit = this.planLimits[tenantPlan].limit;
                appliedTtl = this.planLimits[tenantPlan].ttl;
            }
        }

        // Generate a cache key based on tenantId (or IP if unauthenticated)
        const key = this.generateKey(context, user ? user.tenantId : req.ip, throttler.name);

        const { totalHits } = await this.storageService.increment(key, appliedTtl);

        if (totalHits > appliedLimit) {
            throw new ThrottlerException('Rate Limit Exceeded. Please upgrade your plan.');
        }

        return true;
    }
}
