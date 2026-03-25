/**
 * Plan-tier rate limit resolution.
 * Rate limits are NOT magic numbers in middleware — they are resolved
 * from the tenant's billing plan.
 * Architecture Part I-A, §1A.8
 */
export interface RateLimits {
    globalRps: number;
    apiReqPerMin: number;
    authAttemptsPerWindow: number;
    expensiveReqPerMin: number;
    webhookDeliveriesPerHour: number;
}
export type PlanTier = 'free' | 'starter' | 'growth' | 'enterprise';
export declare const PLAN_RATE_LIMITS: Record<PlanTier, RateLimits>;
export interface TenantRateLimitOverrides {
    rateLimitGlobalRps?: number;
    rateLimitApiReqPerMin?: number;
    rateLimitAuthAttempts?: number;
    rateLimitExpensiveReqPerMin?: number;
    webhookDeliveriesPerHour?: number;
}
/**
 * Resolve effective rate limits for a tenant.
 * Upgrading a tenant's plan automatically adjusts their rate limits
 * without any code change or manual intervention.
 */
export declare function resolveRateLimits(planTier: PlanTier, overrides?: TenantRateLimitOverrides): RateLimits;
//# sourceMappingURL=rate-limits.d.ts.map