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

export const PLAN_RATE_LIMITS: Record<PlanTier, RateLimits> = {
    free: {
        globalRps: 10,
        apiReqPerMin: 60,
        authAttemptsPerWindow: 5,
        expensiveReqPerMin: 2,
        webhookDeliveriesPerHour: 0,
    },
    starter: {
        globalRps: 50,
        apiReqPerMin: 300,
        authAttemptsPerWindow: 5,
        expensiveReqPerMin: 10,
        webhookDeliveriesPerHour: 100,
    },
    growth: {
        globalRps: 100,
        apiReqPerMin: 1000,
        authAttemptsPerWindow: 10,
        expensiveReqPerMin: 30,
        webhookDeliveriesPerHour: 500,
    },
    enterprise: {
        globalRps: 500,
        apiReqPerMin: 5000,
        authAttemptsPerWindow: 15,
        expensiveReqPerMin: 100,
        webhookDeliveriesPerHour: 5000,
    },
};

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
export function resolveRateLimits(
    planTier: PlanTier,
    overrides?: TenantRateLimitOverrides,
): RateLimits {
    const defaults = PLAN_RATE_LIMITS[planTier];
    return {
        globalRps: overrides?.rateLimitGlobalRps ?? defaults.globalRps,
        apiReqPerMin: overrides?.rateLimitApiReqPerMin ?? defaults.apiReqPerMin,
        authAttemptsPerWindow: overrides?.rateLimitAuthAttempts ?? defaults.authAttemptsPerWindow,
        expensiveReqPerMin: overrides?.rateLimitExpensiveReqPerMin ?? defaults.expensiveReqPerMin,
        webhookDeliveriesPerHour: overrides?.webhookDeliveriesPerHour ?? defaults.webhookDeliveriesPerHour,
    };
}
