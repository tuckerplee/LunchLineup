import { describe, expect, it } from 'vitest';
import { PLAN_RATE_LIMITS, resolveRateLimits } from '@lunchlineup/config';

type CanonicalPlanTier = 'free' | 'starter' | 'growth' | 'enterprise';

const LEGACY_TIER_MAP: Record<string, CanonicalPlanTier> = {
    FREE: 'free',
    STARTER: 'starter',
    GROWTH: 'growth',
    ENTERPRISE: 'enterprise',
    BASIC: 'starter',
    PRO: 'growth',
    free: 'free',
    starter: 'starter',
    growth: 'growth',
    enterprise: 'enterprise',
};

function normalizePlanTier(value?: string | null): CanonicalPlanTier {
    if (!value) return 'free';
    return LEGACY_TIER_MAP[value.trim()] ?? 'free';
}

describe('plan tier compatibility', () => {
    it('maps legacy enum tiers to canonical plan records', () => {
        expect(normalizePlanTier('FREE')).toBe('free');
        expect(normalizePlanTier('STARTER')).toBe('starter');
        expect(normalizePlanTier('GROWTH')).toBe('growth');
        expect(normalizePlanTier('ENTERPRISE')).toBe('enterprise');
    });

    it('treats BASIC and PRO as aliases during the transition', () => {
        expect(normalizePlanTier('BASIC')).toBe('starter');
        expect(normalizePlanTier('PRO')).toBe('growth');
    });

    it('falls back to free for missing or unknown tiers', () => {
        expect(normalizePlanTier(undefined)).toBe('free');
        expect(normalizePlanTier(null)).toBe('free');
        expect(normalizePlanTier('trial')).toBe('free');
    });

    it('resolves canonical rate-limit defaults for each tier', () => {
        expect(resolveRateLimits('free')).toEqual(PLAN_RATE_LIMITS.free);
        expect(resolveRateLimits('starter')).toEqual(PLAN_RATE_LIMITS.starter);
        expect(resolveRateLimits('growth')).toEqual(PLAN_RATE_LIMITS.growth);
        expect(resolveRateLimits('enterprise')).toEqual(PLAN_RATE_LIMITS.enterprise);
    });

    it('applies per-tenant overrides without changing plan defaults', () => {
        const defaults = PLAN_RATE_LIMITS.growth;
        const resolved = resolveRateLimits('growth', {
            rateLimitGlobalRps: 250,
            rateLimitApiReqPerMin: 1500,
        });

        expect(resolved).toEqual({
            globalRps: 250,
            apiReqPerMin: 1500,
            authAttemptsPerWindow: defaults.authAttemptsPerWindow,
            expensiveReqPerMin: defaults.expensiveReqPerMin,
            webhookDeliveriesPerHour: defaults.webhookDeliveriesPerHour,
        });
        expect(PLAN_RATE_LIMITS.growth).toEqual(defaults);
    });
});
