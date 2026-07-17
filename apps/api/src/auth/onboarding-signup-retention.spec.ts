import { describe, expect, it, vi } from 'vitest';
import {
    ONBOARDING_SIGNUP_ATTEMPT_RETENTION_HOURS,
    applyOnboardingSignupAttemptRetention,
} from './onboarding-signup-retention';

function queryText(query: unknown): string {
    if (Array.isArray(query)) return query.join(' ');
    if (Array.isArray((query as { strings?: unknown[] })?.strings)) {
        return (query as { strings: unknown[] }).strings.join(' ');
    }
    return String(query);
}

describe('onboarding signup-attempt retention', () => {
    const asOf = new Date('2026-07-14T12:00:00.000Z');

    it('reports expired identifier rows without mutating them during dry-run', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ eligibleCount: 7n }]),
        };

        await expect(applyOnboardingSignupAttemptRetention(tx as any, asOf, true)).resolves.toEqual({
            retentionHours: ONBOARDING_SIGNUP_ATTEMPT_RETENTION_HOURS,
            eligibleCount: 7,
            purgedCount: 0,
        });

        const [query, queryAsOf, retentionHours] = tx.$queryRaw.mock.calls[0];
        expect(queryText(query)).toContain('FROM public."OnboardingSignupAttempt"');
        expect(queryText(query)).toContain('make_interval(hours =>');
        expect(queryAsOf).toEqual(asOf);
        expect(retentionHours).toBe(24);
    });

    it('uses the capability-gated database owner function during execution', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ purgedCount: '4' }]),
        };

        await expect(applyOnboardingSignupAttemptRetention(tx as any, asOf, false)).resolves.toEqual({
            retentionHours: 24,
            eligibleCount: 4,
            purgedCount: 4,
        });

        const [query, queryAsOf] = tx.$queryRaw.mock.calls[0];
        expect(queryText(query)).toContain('public.purge_expired_onboarding_signup_attempts');
        expect(queryAsOf).toEqual(asOf);
    });

    it('rejects an unsafe or corrupt database count', async () => {
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([{ purgedCount: '-1' }]),
        };

        await expect(applyOnboardingSignupAttemptRetention(tx as any, asOf, false))
            .rejects.toThrow(/invalid count/i);
    });
});
