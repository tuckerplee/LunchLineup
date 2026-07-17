import { describe, expect, it } from 'vitest';
import {
    hasFutureStripeSubscriptionCurrentPeriodEnd,
    hasNonBlankStripeSubscriptionId,
    resolveEffectiveTenantEntitlement,
} from '../billing/plan-definitions';

describe('schedule publish paid-subscription identity', () => {
    it.each([null, undefined, '', ' ', '\t\r\n']) (
        'rejects a blank Stripe subscription identifier %#',
        (stripeSubscriptionId) => {
            expect(hasNonBlankStripeSubscriptionId(stripeSubscriptionId)).toBe(false);
            expect(resolveEffectiveTenantEntitlement({
                planTier: 'GROWTH',
                status: 'ACTIVE',
                stripeSubscriptionId,
                stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
            })).toEqual({ planCode: 'FREE', source: 'free' });
        },
    );

    it('accepts a non-blank Stripe subscription identifier for an active paid plan', () => {
        expect(resolveEffectiveTenantEntitlement({
            planTier: 'GROWTH',
            status: 'ACTIVE',
            stripeSubscriptionId: ' sub_paid_123 ',
            stripeSubscriptionCurrentPeriodEnd: new Date('2099-01-01T00:00:00.000Z'),
        })).toEqual({ planCode: 'GROWTH', source: 'paid_subscription' });
    });

    it.each([null, undefined, '', 'invalid', '2020-01-01T00:00:00.000Z'])(
        'rejects a missing, invalid, or stale authoritative paid-through value %#',
        (stripeSubscriptionCurrentPeriodEnd) => {
            expect(hasFutureStripeSubscriptionCurrentPeriodEnd(
                stripeSubscriptionCurrentPeriodEnd,
                new Date('2026-07-16T00:00:00.000Z'),
            )).toBe(false);
            expect(resolveEffectiveTenantEntitlement({
                planTier: 'GROWTH',
                status: 'ACTIVE',
                stripeSubscriptionId: 'sub_paid_123',
                stripeSubscriptionCurrentPeriodEnd,
            }, new Date('2026-07-16T00:00:00.000Z'))).toEqual({
                planCode: 'FREE',
                source: 'free',
            });
        },
    );
});
