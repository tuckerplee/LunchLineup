'use client';

import type { CSSProperties } from 'react';
import {
    canAttemptPausedSubscriptionRecovery,
    shouldUseBillingPortalForRecovery,
} from './billing-settings-contract';

type NoticeTone = 'success' | 'error';
type NoticeStyle = (tone: NoticeTone) => CSSProperties;

export type BillingFeatureResolution = {
    enabled?: boolean;
    source?: string;
    reason?: string;
    creditCost?: number | null;
};

export type BillingFeatureMatrix = {
    planTier?: string;
    effectivePlanTier?: string;
    status?: string;
    trialEndsAt?: string | null;
    stripeSubscriptionActive?: boolean;
    stripeSubscriptionPresent?: boolean;
    subscriptionRecoveryAction?: 'resume' | 'portal' | null;
    usageCredits?: number;
    features?: Record<string, BillingFeatureResolution>;
};

export type BillingPriceOption = {
    code: string;
    label: string;
    priceId: string | null;
    configured: boolean;
};

export type BillingState = {
    loading: boolean;
    error: string | null;
    matrix: BillingFeatureMatrix | null;
    priceOptions: BillingPriceOption[];
};

type BillingNotice = {
    tone: NoticeTone;
    text: string;
} | null;

type BillingSettingsPanelProps = {
    billingState: BillingState;
    billingNotice: BillingNotice;
    billingFeatures: Array<[string, BillingFeatureResolution]>;
    configuredPriceOptions: BillingPriceOption[];
    canManageBilling: boolean;
    subscriptionSaving: string | null;
    noticeStyle: NoticeStyle;
    onStartSubscription: (option: BillingPriceOption) => void | Promise<void>;
    onChangeSubscription: (option: BillingPriceOption) => void | Promise<void>;
    onOpenBillingPortal: () => void | Promise<void>;
    onResumeSubscription: () => void | Promise<void>;
    onRefreshBilling: () => void | Promise<void>;
};

function titleize(value: string): string {
    return value
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPlanCode(value?: string): string {
    return value ? titleize(value.toLowerCase()) : 'Unknown';
}

function formatFeatureSource(value?: string): string {
    if (!value) return 'Disabled';
    return titleize(value.toLowerCase());
}


function formatTrialDeadline(value?: string | null, status?: string): string {
    if (status?.toUpperCase() !== 'TRIAL') return 'Not applicable';
    if (!value) return 'Not available';
    const deadline = new Date(value);
    if (!Number.isFinite(deadline.getTime())) return 'Not available';
    if (deadline.getTime() <= Date.now()) return `Expired ${deadline.toLocaleDateString()}`;
    return `Ends ${deadline.toLocaleDateString()}`;
}
export function BillingSettingsPanel({
    billingState,
    billingNotice,
    billingFeatures,
    configuredPriceOptions,
    canManageBilling,
    subscriptionSaving,
    noticeStyle,
    onStartSubscription,
    onChangeSubscription,
    onOpenBillingPortal,
    onResumeSubscription,
    onRefreshBilling,
}: BillingSettingsPanelProps) {
    const alternativePlanOptions = configuredPriceOptions.filter(
        (option) => option.code.toUpperCase() !== billingState.matrix?.planTier?.toUpperCase(),
    );
    const canAttemptResume = canAttemptPausedSubscriptionRecovery(billingState.matrix);
    const usePortalForRecovery = shouldUseBillingPortalForRecovery(billingState.matrix);

    return (
        <div style={{ display: 'grid', gap: '1rem' }}>
            <div style={{ display: 'grid', gap: '0.2rem' }}>
                <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Billing</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                    Review plan access and start Stripe Checkout for configured plans.
                </p>
            </div>

            {billingNotice ? (
                <div style={noticeStyle(billingNotice.tone)} role="status">
                    {billingNotice.text}
                </div>
            ) : null}

            {billingState.error ? (
                <div style={noticeStyle('error')} role="status">
                    {billingState.error}
                </div>
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem' }}>
                {[
                    { label: 'Plan', value: formatPlanCode(billingState.matrix?.planTier) },
                    { label: 'Status', value: formatPlanCode(billingState.matrix?.status) },
                    { label: 'Trial access', value: formatTrialDeadline(billingState.matrix?.trialEndsAt, billingState.matrix?.status) },
                    { label: 'Usage credits', value: String(billingState.matrix?.usageCredits ?? 0) },
                    {
                        label: 'Stripe subscription',
                        value: billingState.matrix?.stripeSubscriptionActive
                            ? 'Active'
                            : billingState.matrix?.stripeSubscriptionPresent
                                ? 'Needs attention'
                                : 'Not active',
                    },
                ].map((item) => (
                    <div key={item.label} className="surface-muted" style={{ padding: '0.85rem', display: 'grid', gap: 3 }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>
                            {item.label}
                        </div>
                        <div style={{ fontSize: '1rem', color: 'var(--text-primary)', fontWeight: 800 }}>
                            {billingState.loading ? 'Loading...' : item.value}
                        </div>
                    </div>
                ))}
            </div>

            <div className="surface-muted" style={{ padding: '0.9rem', display: 'grid', gap: '0.65rem' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>Feature access</div>
                {billingState.loading ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.84rem' }}>Loading billing features...</div>
                ) : billingFeatures.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.84rem' }}>No feature access records returned.</div>
                ) : (
                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                        {billingFeatures.map(([feature, resolution]) => (
                            <div
                                key={feature}
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'minmax(130px, 1fr) auto',
                                    gap: '0.75rem',
                                    alignItems: 'center',
                                    padding: '0.65rem 0',
                                    borderTop: '1px solid var(--border)',
                                }}
                            >
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ color: 'var(--text-primary)', fontWeight: 750, fontSize: '0.88rem' }}>
                                        {titleize(feature)}
                                    </div>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>
                                        {resolution.reason || formatFeatureSource(resolution.source)}
                                    </div>
                                </div>
                                <div
                                    style={{
                                        justifySelf: 'end',
                                        padding: '0.28rem 0.55rem',
                                        borderRadius: 999,
                                        fontSize: '0.74rem',
                                        fontWeight: 800,
                                        background: resolution.enabled ? '#e9fbf1' : '#fff1f4',
                                        color: resolution.enabled ? '#0f8c52' : '#cb3653',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {resolution.enabled ? `Enabled - ${formatFeatureSource(resolution.source)}` : 'Disabled'}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="surface-muted" style={{ padding: '0.9rem', display: 'grid', gap: '0.7rem' }}>
                <div style={{ display: 'grid', gap: 2 }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                        {billingState.matrix?.stripeSubscriptionPresent ? 'Plan management' : 'Subscription setup'}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                        {billingState.matrix?.stripeSubscriptionPresent
                            ? canManageBilling
                                ? 'Update payment details and invoices in Stripe, or change plans here.'
                                : 'Billing write access is required to manage the current subscription.'
                            : configuredPriceOptions.length > 0
                            ? canManageBilling
                                ? 'Configured plans are available through Stripe Checkout.'
                                : 'Configured plans are visible. Checkout requires billing write access.'
                            : 'Checkout is unavailable because no Stripe price IDs are configured.'}
                    </div>
                </div>

                {billingState.matrix?.stripeSubscriptionPresent && canManageBilling ? (
                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.55rem' }}>
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => void onOpenBillingPortal()}
                                disabled={Boolean(subscriptionSaving)}
                            >
                                {subscriptionSaving === 'portal'
                                    ? 'Opening...'
                                    : usePortalForRecovery
                                        ? 'Resolve payment issue'
                                        : 'Payment & invoices'}
                            </button>
                            {canAttemptResume ? (
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => void onResumeSubscription()}
                                    disabled={Boolean(subscriptionSaving)}
                                >
                                    {subscriptionSaving === 'resume' ? 'Resuming...' : 'Resume paused subscription'}
                                </button>
                            ) : null}
                        </div>
                        {billingState.matrix?.stripeSubscriptionActive && alternativePlanOptions.length > 0 ? (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.55rem' }}>
                                {alternativePlanOptions.map((option) => (
                                    <button
                                        key={option.code}
                                        type="button"
                                        className="btn btn-secondary"
                                        onClick={() => void onChangeSubscription(option)}
                                        disabled={Boolean(subscriptionSaving)}
                                    >
                                        {subscriptionSaving === `change:${option.code}`
                                            ? 'Changing...'
                                            : `Change to ${option.label}`}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </div>
                ) : !billingState.matrix?.stripeSubscriptionPresent && configuredPriceOptions.length > 0 && canManageBilling ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.55rem' }}>
                        {configuredPriceOptions.map((option) => (
                            <button
                                key={option.code}
                                type="button"
                                className="btn btn-primary"
                                onClick={() => void onStartSubscription(option)}
                                disabled={Boolean(subscriptionSaving)}
                            >
                                {subscriptionSaving === option.code
                                    ? 'Starting...'
                                    : billingState.matrix?.status?.toUpperCase() === 'CANCELLED'
                                        ? `Resubscribe to ${option.label}`
                                        : `Start ${option.label} checkout`}
                            </button>
                        ))}
                    </div>
                ) : (
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                        {billingState.matrix?.stripeSubscriptionPresent
                            ? 'A billing administrator must manage the current subscription.'
                            : configuredPriceOptions.length > 0
                            ? 'A billing administrator must start or change subscriptions through Checkout.'
                            : 'A billing administrator must configure Stripe prices before subscription setup can start.'}
                    </div>
                )}

                <button className="btn btn-secondary" type="button" onClick={() => void onRefreshBilling()} disabled={billingState.loading}>
                    {billingState.loading ? 'Refreshing...' : 'Refresh billing'}
                </button>
            </div>
        </div>
    );
}
