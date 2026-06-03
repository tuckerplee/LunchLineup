import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler/dist/throttler.guard.interface';

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

    protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
        const { context, throttler, blockDuration, getTracker, generateKey } = requestProps;
        const { req, res } = this.getRequestResponse(context);
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
        const throttlerName = throttler.name ?? 'default';
        const tracker = user?.tenantId ?? (await getTracker(req, context));
        const key = generateKey(context, tracker, throttlerName);

        const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } =
            await this.storageService.increment(
                key,
                appliedTtl,
                appliedLimit,
                blockDuration,
                throttlerName
            );

        const suffix = throttlerName === 'default' ? '' : `-${throttlerName}`;

        res.header(`${this.headerPrefix}-Limit${suffix}`, appliedLimit);
        res.header(`${this.headerPrefix}-Remaining${suffix}`, Math.max(0, appliedLimit - totalHits));
        res.header(`${this.headerPrefix}-Reset${suffix}`, timeToExpire);

        if (isBlocked) {
            res.header(`Retry-After${suffix}`, timeToBlockExpire);
            await this.throwThrottlingException(context, {
                limit: appliedLimit,
                ttl: appliedTtl,
                key,
                tracker,
                totalHits,
                timeToExpire,
                isBlocked,
                timeToBlockExpire,
            });
        }

        return true;
    }
}
