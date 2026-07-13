import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canAttemptPausedSubscriptionRecovery,
  isTerminallyCancelled,
  normalizeBillingFeatureMatrix,
  readBillingRedirectUrl,
  resolveBillingManagementMode,
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

  it('wires paid plan management and cancelled resubscription controls', () => {
    const panelSource = readFileSync(resolve(__dirname, '../../app/dashboard/settings/BillingSettingsPanel.tsx'), 'utf8');
    const workspaceSource = readFileSync(resolve(__dirname, '../../app/dashboard/settings/SettingsWorkspace.tsx'), 'utf8');

    expect(panelSource).toContain('Payment & invoices');
    expect(panelSource).toContain("label: 'Trial access'");
    expect(panelSource).toContain('formatTrialDeadline(billingState.matrix?.trialEndsAt');
    expect(panelSource).toContain('Resume paused subscription');
    expect(panelSource).toContain('Change to ${option.label}');
    expect(panelSource).toContain('Resubscribe to ${option.label}');
    expect(workspaceSource).toContain("fetchWithSession('/billing/portal'");
    expect(workspaceSource).toContain("fetchWithSession('/billing/change-plan'");
    expect(workspaceSource).toContain("fetchWithSession('/billing/resume'");
    expect(workspaceSource).toContain("readBillingRedirectUrl(payload, 'portalUrl')");
    expect(workspaceSource).toContain("readBillingRedirectUrl(payload, 'paymentUrl')");
    expect(workspaceSource).toContain('normalizeBillingFeatureMatrix(featurePayload)');
  });
});
