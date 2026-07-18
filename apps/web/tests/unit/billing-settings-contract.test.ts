import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  canAttemptPausedSubscriptionRecovery,
  hasActivePaidSubscription,
  isTerminallyCancelled,
  normalizeBillingFeatureMatrix,
  normalizeCreditPackOptions,
  readBillingRedirectUrl,
  readBillingReturnState,
  resolveBillingManagementMode,
  sanitizeBillingReturnSearch,
  shouldUseBillingPortalForRecovery,
} from '../../app/dashboard/settings/billing-settings-contract';

describe('billing settings contract', () => {
  it('routes existing paid subscriptions through the Stripe billing portal', () => {
    expect(resolveBillingManagementMode({
      status: 'ACTIVE',
      stripeSubscriptionActive: true,
      stripeSubscriptionPresent: true,
    })).toBe('portal');
  });

  it('routes terminally cancelled tenants with cleared subscription IDs to checkout', () => {
    const matrix = {
      status: 'CANCELLED',
      stripeSubscriptionActive: false,
      stripeSubscriptionPresent: false,
    };

    expect(resolveBillingManagementMode(matrix)).toBe('subscribe');
    expect(isTerminallyCancelled(matrix)).toBe(true);
  });

  it('accepts only HTTPS Stripe redirect URLs from API responses', () => {
    expect(readBillingRedirectUrl({ portalUrl: 'https://billing.stripe.com/p/session_123' }, 'portalUrl'))
      .toBe('https://billing.stripe.com/p/session_123');
    expect(readBillingRedirectUrl({ checkoutUrl: 'javascript:alert(1)' }, 'checkoutUrl')).toBeNull();
    expect(readBillingRedirectUrl({ paymentUrl: 'https://invoice.stripe.com/i/in_resume' }, 'paymentUrl'))
      .toBe('https://invoice.stripe.com/i/in_resume');
    expect(readBillingRedirectUrl(null, 'checkoutUrl')).toBeNull();
  });

  it('preserves the server trial deadline while normalizing feature data', () => {
    const matrix = normalizeBillingFeatureMatrix({
      status: 'TRIAL',
      trialEndsAt: '2026-08-01T12:30:00.000Z',
      features: {
        scheduling: { enabled: true, source: 'trial', creditCost: 1 },
      },
    });

    expect(matrix.trialEndsAt).toBe('2026-08-01T12:30:00.000Z');
    expect(matrix.features?.scheduling).toEqual({
      enabled: true,
      source: 'trial',
      reason: '',
      creditCost: 1,
    });
  });

  it('offers resume only when the API verified that Stripe is actually paused', () => {
    const paused = normalizeBillingFeatureMatrix({
      status: 'PAST_DUE',
      stripeSubscriptionActive: false,
      stripeSubscriptionPresent: true,
      subscriptionRecoveryAction: 'resume',
    });
    const delinquent = normalizeBillingFeatureMatrix({
      status: 'PAST_DUE',
      stripeSubscriptionActive: false,
      stripeSubscriptionPresent: true,
      subscriptionRecoveryAction: 'portal',
    });

    expect(paused.subscriptionRecoveryAction).toBe('resume');
    expect(canAttemptPausedSubscriptionRecovery(paused)).toBe(true);
    expect(delinquent.subscriptionRecoveryAction).toBe('portal');
    expect(canAttemptPausedSubscriptionRecovery(delinquent)).toBe(false);
    expect(canAttemptPausedSubscriptionRecovery({
      status: 'CANCELLED',
      stripeSubscriptionActive: false,
      stripeSubscriptionPresent: false,
    })).toBe(false);
  });

  it('routes non-paused delinquent subscriptions through portal payment recovery', () => {
    const delinquent = normalizeBillingFeatureMatrix({
      status: 'PAST_DUE',
      stripeSubscriptionPresent: true,
      subscriptionRecoveryAction: 'portal',
    });
    const paused = normalizeBillingFeatureMatrix({
      status: 'PAST_DUE',
      stripeSubscriptionPresent: true,
      subscriptionRecoveryAction: 'resume',
    });

    expect(shouldUseBillingPortalForRecovery(delinquent)).toBe(true);
    expect(shouldUseBillingPortalForRecovery(paused)).toBe(false);
  });

  it('normalizes unknown recovery actions to no privileged recovery control', () => {
    const matrix = normalizeBillingFeatureMatrix({
      status: 'PAST_DUE',
      stripeSubscriptionPresent: true,
      subscriptionRecoveryAction: 'unexpected',
    });

    expect(matrix.subscriptionRecoveryAction).toBeNull();
    expect(canAttemptPausedSubscriptionRecovery(matrix)).toBe(false);
    expect(shouldUseBillingPortalForRecovery(matrix)).toBe(false);
  });

  it('normalizes only fixed credit packs with Stripe-authoritative amount and currency', () => {
    expect(normalizeCreditPackOptions({
      data: [
        { code: 'CREDITS_2000', credits: 2000, configured: true, amount: 4500, currency: 'CAD' },
        { code: 'CREDITS_100', credits: 100, configured: true, amount: 1299, currency: 'usd' },
        { code: 'CREDITS_500', credits: 501, configured: true, amount: 2500, currency: 'usd' },
        { code: 'CREDITS_9999', credits: 9999, configured: true, amount: 1, currency: 'usd' },
      ],
    })).toEqual([
      { code: 'CREDITS_100', credits: 100, configured: true, amount: 1299, currency: 'usd' },
      { code: 'CREDITS_500', credits: 500, configured: false, amount: null, currency: null },
      { code: 'CREDITS_2000', credits: 2000, configured: true, amount: 4500, currency: 'cad' },
    ]);
  });

  it('requires a current active paid subscription for client-side credit checkout', () => {
    expect(hasActivePaidSubscription({
      status: 'ACTIVE',
      effectivePlanTier: 'GROWTH',
      stripeSubscriptionActive: true,
      stripeSubscriptionPresent: true,
    })).toBe(true);
    expect(hasActivePaidSubscription({
      status: 'TRIAL',
      effectivePlanTier: 'GROWTH',
      stripeSubscriptionActive: true,
      stripeSubscriptionPresent: true,
    })).toBe(false);
    expect(hasActivePaidSubscription({
      status: 'ACTIVE',
      effectivePlanTier: 'FREE',
      stripeSubscriptionActive: true,
      stripeSubscriptionPresent: true,
    })).toBe(false);
    expect(hasActivePaidSubscription({
      status: 'PAST_DUE',
      effectivePlanTier: 'GROWTH',
      stripeSubscriptionActive: false,
      stripeSubscriptionPresent: true,
    })).toBe(false);
  });

  it('recognizes pending, success, and cancel returns without retaining session state', () => {
    expect(readBillingReturnState('?billing=credit-purchase-pending')).toBe('credit-purchase-pending');
    expect(readBillingReturnState('?billing=credit-purchase-success&session_id=cs_test_secret'))
      .toBe('credit-purchase-success');
    expect(readBillingReturnState('?billing=credit-purchase-cancelled')).toBe('credit-purchase-cancelled');
    expect(readBillingReturnState('?billing=unknown&session_id=cs_test_secret')).toBeNull();
    expect(sanitizeBillingReturnSearch(
      '?billing=credit-purchase-success&session_id=cs_test_secret&view=team',
    )).toBe('?view=team');
  });

  it('wires recovery-safe subscription management and fixed credit-pack checkout', () => {
    const panelSource = readFileSync(resolve(__dirname, '../../app/dashboard/settings/BillingSettingsPanel.tsx'), 'utf8');
    const workspaceSource = readFileSync(resolve(__dirname, '../../app/dashboard/settings/SettingsWorkspace.tsx'), 'utf8');
    const hookSource = readFileSync(resolve(__dirname, '../../app/dashboard/settings/use-billing-settings.ts'), 'utf8');

    expect(panelSource).toContain('Payment & invoices');
    expect(panelSource).toContain("label: 'Trial access'");
    expect(panelSource).toContain('formatTrialDeadline(billingState.matrix?.trialEndsAt');
    expect(panelSource).toContain('Resume paused subscription');
    expect(panelSource).toContain('Subscriptions provide plan access. Credits are purchased separately; subscriptions include no recurring or unlimited credits.');
    expect(panelSource).toContain('formatCreditPackPrice(option)');
    expect(workspaceSource).toContain('useBillingSettings({ canReadBilling, canManageBilling })');
    expect(workspaceSource).toContain('onPurchaseCreditPack={purchaseCreditPack}');
    expect(hookSource).toContain("fetchJsonWithSession<unknown>('/billing/credit-packs')");
    expect(hookSource).toContain("'/billing/credit-packs/checkout'");
    expect(hookSource).toContain('{ code: option.code }');
    expect(hookSource).toContain('hasActivePaidSubscription(billingState.matrix)');
    expect(hookSource).toContain('Promise.allSettled([');
    expect(hookSource).toContain("fetchJsonWithSession<unknown>('/billing/features')");
    expect(hookSource).toContain("fetchJsonWithSession<unknown>('/billing/subscription-recovery-action')");
    expect(hookSource).toContain('mergeSubscriptionRecoveryAction(');
    expect(hookSource).toContain("postBilling('/billing/portal'");
    expect(hookSource).toContain("postBilling('/billing/change-plan'");
    expect(hookSource).toContain("postBilling('/billing/resume'");
    expect(hookSource).toContain("readBillingRedirectUrl(payload, 'portalUrl')");
    expect(hookSource).toContain("readBillingRedirectUrl(payload, 'paymentUrl')");
  });
});
