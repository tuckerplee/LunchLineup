"use strict";
/**
 * Plan-tier rate limit resolution.
 * Rate limits are NOT magic numbers in middleware — they are resolved
 * from the tenant's billing plan.
 * Architecture Part I-A, §1A.8
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLAN_RATE_LIMITS = void 0;
exports.resolveRateLimits = resolveRateLimits;
exports.PLAN_RATE_LIMITS = {
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
/**
 * Resolve effective rate limits for a tenant.
 * Upgrading a tenant's plan automatically adjusts their rate limits
 * without any code change or manual intervention.
 */
function resolveRateLimits(planTier, overrides) {
    const defaults = exports.PLAN_RATE_LIMITS[planTier];
    return {
        globalRps: overrides?.rateLimitGlobalRps ?? defaults.globalRps,
        apiReqPerMin: overrides?.rateLimitApiReqPerMin ?? defaults.apiReqPerMin,
        authAttemptsPerWindow: overrides?.rateLimitAuthAttempts ?? defaults.authAttemptsPerWindow,
        expensiveReqPerMin: overrides?.rateLimitExpensiveReqPerMin ?? defaults.expensiveReqPerMin,
        webhookDeliveriesPerHour: overrides?.webhookDeliveriesPerHour ?? defaults.webhookDeliveriesPerHour,
    };
}
//# sourceMappingURL=rate-limits.js.map