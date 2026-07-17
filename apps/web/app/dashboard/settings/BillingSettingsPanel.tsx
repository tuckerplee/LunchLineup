'use client';

import type { CSSProperties } from 'react';
import { Coins, Loader2, RefreshCw } from 'lucide-react';
import {
    canAttemptPausedSubscriptionRecovery,
    shouldUseBillingPortalForRecovery,
    type BillingFeatureResolution,
    type BillingPriceOption,
    type BillingState,
    type CreditPackOption,
    type CreditPackState,
} from './billing-settings-contract';

type NoticeTone = 'success' | 'error';
type NoticeStyle = (tone: NoticeTone) => CSSProperties;

type BillingNotice = {
    tone: NoticeTone;
    text: string;
} | null;

type BillingSettingsPanelProps = {
    billingState: BillingState;
    creditPackState: CreditPackState;
    billingNotice: BillingNotice;
    billingFeatures: Array<[string, BillingFeatureResolution]>;
    configuredPriceOptions: BillingPriceOption[];
    canManageBilling: boolean;
    canPurchaseCreditPacks: boolean;
    subscriptionSaving: string | null;
    creditPackSaving: string | null;
    noticeStyle: NoticeStyle;
    onStartSubscription: (option: BillingPriceOption) => void | Promise<void>;
    onChangeSubscription: (option: BillingPriceOption) => void | Promise<void>;
    onOpenBillingPortal: () => void | Promise<void>;
    onResumeSubscription: () => void | Promise<void>;
    onPurchaseCreditPack: (option: CreditPackOption) => void | Promise<void>;
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
    if (deadline.getTime() <= Date.now()) return 'Expired ' + deadline.toLocaleDateString();
    return 'Ends ' + deadline.toLocaleDateString();
}

function creditPackActionLabel(option: CreditPackOption, isSaving: boolean): string {
    const quantity = option.credits.toLocaleString();
    if (isSaving) return 'Opening checkout for ' + quantity + ' credits';
    return option.configured ? 'Purchase ' + quantity + ' credits' : quantity + ' credit pack unavailable';
}

function formatCreditPackPrice(option: CreditPackOption): string {
    if (!option.configured || option.amount === null || !option.currency) return 'Unavailable';

    try {
        const formatter = new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: option.currency,
        });
        const fractionDigits = formatter.resolvedOptions().maximumFractionDigits;
        const majorAmount = option.amount / (10 ** fractionDigits);
        return formatter.format(majorAmount) + ' ' + option.currency.toUpperCase();
    } catch {
        return option.amount + ' ' + option.currency.toUpperCase() + ' minor units';
    }
}

export function BillingSettingsPanel({
    billingState,
    creditPackState,
    billingNotice,
    billingFeatures,
    configuredPriceOptions,
    canManageBilling,
    canPurchaseCreditPacks,
    subscriptionSaving,
    creditPackSaving,
    noticeStyle,
    onStartSubscription,
    onChangeSubscription,
    onOpenBillingPortal,
    onResumeSubscription,
    onPurchaseCreditPack,
    onRefreshBilling,
}: BillingSettingsPanelProps) {
    const alternativePlanOptions = configuredPriceOptions.filter(
        (option) => option.code.toUpperCase() !== billingState.matrix?.planTier?.toUpperCase(),
    );
    const canAttemptResume = canAttemptPausedSubscriptionRecovery(billingState.matrix);
    const usePortalForRecovery = shouldUseBillingPortalForRecovery(billingState.matrix);
    const creditPurchaseBlockReason = !canManageBilling
        ? 'Billing write access is required to purchase credits.'
        : !canPurchaseCreditPacks
            ? 'An active paid subscription is required to purchase credits.'
            : null;

    return (
        <div style={{ display: 'grid', gap: '1rem' }}>
            <div style={{ display: 'grid', gap: '0.2rem' }}>
                <h2 style={{ fontWeight: 750, fontSize: '1.02rem', color: 'var(--text-primary)' }}>Billing</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                    Manage plan access and separately purchased usage credits.
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
                    { label: 'Purchased credits', value: String(billingState.matrix?.usageCredits ?? 0) },
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
                {billingState.loading && !billingState.matrix ? (
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
                                    {resolution.enabled ? 'Enabled - ' + formatFeatureSource(resolution.source) : 'Disabled'}
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
                                        {subscriptionSaving === 'change:' + option.code
                                            ? 'Changing...'
                                            : 'Change to ' + option.label}
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
                                        ? 'Resubscribe to ' + option.label
                                        : 'Start ' + option.label + ' checkout'}
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
            </div>

            <section
                aria-labelledby="credit-packs-title"
                style={{
                    display: 'grid',
                    gap: '0.75rem',
                    paddingTop: '0.25rem',
                }}
            >
                <div style={{ display: 'grid', gap: 3 }}>
                    <div id="credit-packs-title" style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                        Credit packs
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                        Subscriptions provide plan access. Credits are purchased separately; subscriptions include no recurring or unlimited credits.
                    </div>
                </div>

                {creditPackState.error ? (
                    <div style={noticeStyle('error')} role="status">
                        Credit packs could not be loaded: {creditPackState.error}
                    </div>
                ) : null}

                {creditPurchaseBlockReason ? (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                        {creditPurchaseBlockReason}
                    </div>
                ) : null}

                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                        gap: '0.7rem',
                    }}
                >
                    {creditPackState.options.map((option) => {
                        const isSaving = creditPackSaving === option.code;
                        const unavailable = !option.configured || Boolean(creditPurchaseBlockReason);
                        return (
                            <div
                                key={option.code}
                                style={{
                                    minWidth: 0,
                                    minHeight: 142,
                                    border: '1px solid var(--border)',
                                    borderRadius: 8,
                                    padding: '0.85rem',
                                    display: 'grid',
                                    alignContent: 'space-between',
                                    gap: '0.8rem',
                                    background: 'var(--surface)',
                                }}
                            >
                                <div style={{ display: 'grid', gap: 3 }}>
                                    <div style={{ color: 'var(--text-primary)', fontSize: '1rem', fontWeight: 800 }}>
                                        {option.credits.toLocaleString()} credits
                                    </div>
                                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem', fontWeight: 700 }}>
                                        {creditPackState.loading && !option.configured
                                            ? 'Loading price...'
                                            : formatCreditPackPrice(option)}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={() => void onPurchaseCreditPack(option)}
                                    disabled={unavailable || creditPackState.loading || Boolean(creditPackSaving)}
                                    aria-label={creditPackActionLabel(option, isSaving)}
                                    aria-busy={isSaving}
                                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
                                >
                                    {isSaving ? <Loader2 size={16} aria-hidden="true" /> : <Coins size={16} aria-hidden="true" />}
                                    {isSaving ? 'Opening...' : option.configured ? 'Purchase' : 'Unavailable'}
                                </button>
                            </div>
                        );
                    })}
                </div>
            </section>

            <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void onRefreshBilling()}
                disabled={billingState.loading || creditPackState.loading}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
            >
                <RefreshCw size={16} aria-hidden="true" />
                {billingState.loading || creditPackState.loading ? 'Refreshing...' : 'Refresh billing'}
            </button>
        </div>
    );
}
