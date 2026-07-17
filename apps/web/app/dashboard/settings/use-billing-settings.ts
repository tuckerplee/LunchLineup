'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';
import {
    hasActivePaidSubscription,
    normalizeBillingFeatureMatrix,
    normalizeCreditPackOptions,
    normalizePriceOptions,
    readBillingRedirectUrl,
    readBillingReturnState,
    sanitizeBillingReturnSearch,
    type BillingPriceOption,
    type BillingReturnState,
    type BillingState,
    type CreditPackOption,
    type CreditPackState,
} from './billing-settings-contract';

export type BillingNotice = {
    tone: 'success' | 'error';
    text: string;
} | null;

type UseBillingSettingsOptions = {
    canReadBilling: boolean;
    canManageBilling: boolean;
};

const EMPTY_BILLING_STATE: BillingState = {
    loading: false,
    error: null,
    matrix: null,
    priceOptions: [],
};

const EMPTY_CREDIT_PACK_STATE: CreditPackState = {
    loading: false,
    error: null,
    options: normalizeCreditPackOptions([]),
};

function jsonPostInit(payload: unknown): RequestInit {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    };
}

function extractMessage(payload: unknown, fallback: string): string {
    if (typeof payload === 'string' && payload.trim()) return payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const message = (payload as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) return message;
    }
    return fallback;
}

async function postBilling(path: string, payload: unknown, fallback: string): Promise<unknown> {
    const response = await fetchWithSession(path, jsonPostInit(payload));
    const responsePayload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(extractMessage(responsePayload, fallback + ' (' + response.status + ').'));
    }
    return responsePayload;
}

function rejectedMessage(result: PromiseRejectedResult, fallback: string): string {
    return result.reason instanceof Error ? result.reason.message : fallback;
}

function returnNotice(state: BillingReturnState): BillingNotice {
    switch (state) {
        case 'credit-purchase-pending':
            return {
                tone: 'success',
                text: 'Credit purchase is still pending in Stripe. Rely on the server-reported balance before using new credits.',
            };
        case 'credit-purchase-success':
            return {
                tone: 'success',
                text: 'Stripe Checkout completed. This return does not confirm fulfillment; rely on the server-reported balance below.',
            };
        case 'credit-purchase-cancelled':
            return {
                tone: 'success',
                text: 'Credit-pack checkout was cancelled. This return does not change or verify the server-reported balance.',
            };
        case 'subscription-success':
            return {
                tone: 'success',
                text: 'Stripe Checkout returned. Refreshing the server-authoritative subscription status.',
            };
        case 'subscription-cancelled':
            return {
                tone: 'success',
                text: 'Subscription checkout was cancelled.',
            };
        case 'portal-return':
            return {
                tone: 'success',
                text: 'Returned from Stripe billing. Refreshing the server-authoritative subscription status.',
            };
    }
}

export function useBillingSettings({
    canReadBilling,
    canManageBilling,
}: UseBillingSettingsOptions) {
    const billingRequestRef = useRef(0);
    const creditPackRequestRef = useRef(0);
    const [billingState, setBillingState] = useState<BillingState>(EMPTY_BILLING_STATE);
    const [creditPackState, setCreditPackState] = useState<CreditPackState>(EMPTY_CREDIT_PACK_STATE);
    const [billingNotice, setBillingNotice] = useState<BillingNotice>(null);
    const [subscriptionSaving, setSubscriptionSaving] = useState<string | null>(null);
    const [creditPackSaving, setCreditPackSaving] = useState<string | null>(null);
    const [billingReturnDetected, setBillingReturnDetected] = useState(false);

    useEffect(() => {
        if (canReadBilling) return;
        billingRequestRef.current += 1;
        creditPackRequestRef.current += 1;
        setBillingState(EMPTY_BILLING_STATE);
        setCreditPackState(EMPTY_CREDIT_PACK_STATE);
    }, [canReadBilling]);

    const loadSubscriptionBilling = useCallback(async () => {
        const requestId = ++billingRequestRef.current;
        if (!canReadBilling) {
            setBillingState(EMPTY_BILLING_STATE);
            return;
        }

        setBillingState((current) => ({ ...current, loading: true, error: null }));
        const [featureResult, priceResult] = await Promise.allSettled([
            fetchJsonWithSession<unknown>('/billing/features'),
            fetchJsonWithSession<unknown>('/billing/price-options'),
        ]);
        if (requestId !== billingRequestRef.current) return;

        const errors: string[] = [];
        if (featureResult.status === 'rejected') {
            errors.push(rejectedMessage(featureResult, 'Unable to load subscription status.'));
        }
        if (priceResult.status === 'rejected') {
            errors.push(rejectedMessage(priceResult, 'Unable to load subscription options.'));
        }

        setBillingState((current) => ({
            loading: false,
            error: errors.length > 0 ? errors.join(' ') : null,
            matrix: featureResult.status === 'fulfilled'
                ? normalizeBillingFeatureMatrix(featureResult.value)
                : current.matrix,
            priceOptions: priceResult.status === 'fulfilled'
                ? normalizePriceOptions(priceResult.value)
                : current.priceOptions,
        }));
    }, [canReadBilling]);

    const loadCreditPacks = useCallback(async () => {
        const requestId = ++creditPackRequestRef.current;
        if (!canReadBilling) {
            setCreditPackState(EMPTY_CREDIT_PACK_STATE);
            return;
        }

        setCreditPackState((current) => ({ ...current, loading: true, error: null }));
        try {
            const payload = await fetchJsonWithSession<unknown>('/billing/credit-packs');
            if (requestId !== creditPackRequestRef.current) return;
            setCreditPackState({
                loading: false,
                error: null,
                options: normalizeCreditPackOptions(payload),
            });
        } catch (error) {
            if (requestId !== creditPackRequestRef.current) return;
            setCreditPackState((current) => ({
                ...current,
                loading: false,
                error: error instanceof Error ? error.message : 'Unable to load credit packs.',
            }));
        }
    }, [canReadBilling]);

    const loadBilling = useCallback(async () => {
        await Promise.all([loadSubscriptionBilling(), loadCreditPacks()]);
    }, [loadCreditPacks, loadSubscriptionBilling]);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const params = new URLSearchParams(window.location.search);
        if (!params.has('billing') && !params.has('session_id')) return;

        const state = readBillingReturnState(window.location.search);
        if (state) {
            setBillingReturnDetected(true);
            setBillingNotice(returnNotice(state));
        }

        const sanitizedSearch = sanitizeBillingReturnSearch(window.location.search);
        window.history.replaceState(
            window.history.state,
            '',
            window.location.pathname + sanitizedSearch + window.location.hash,
        );
    }, []);

    const billingFeatures = useMemo(
        () => Object.entries(billingState.matrix?.features ?? {}).sort(([left], [right]) => left.localeCompare(right)),
        [billingState.matrix],
    );
    const configuredPriceOptions = useMemo(
        () => billingState.priceOptions.filter((option) => option.configured && option.priceId),
        [billingState.priceOptions],
    );
    const canPurchaseCreditPacks = hasActivePaidSubscription(billingState.matrix);

    const startSubscription = useCallback(async (option: BillingPriceOption) => {
        if (!canManageBilling) {
            setBillingNotice({ tone: 'error', text: 'You need billing write access to start subscription setup.' });
            return;
        }
        if (!option.priceId) {
            setBillingNotice({ tone: 'error', text: option.label + ' subscription setup is not configured.' });
            return;
        }

        setSubscriptionSaving(option.code);
        setBillingNotice(null);
        try {
            const payload = await postBilling(
                '/billing/subscribe',
                { priceId: option.priceId },
                'Subscription failed',
            );
            const checkoutUrl = readBillingRedirectUrl(payload, 'checkoutUrl');
            if (!checkoutUrl) throw new Error('Stripe Checkout did not return a redirect URL.');
            setBillingNotice({ tone: 'success', text: 'Redirecting to Stripe Checkout...' });
            window.location.assign(checkoutUrl);
        } catch (error) {
            setBillingNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to start subscription.' });
            setSubscriptionSaving(null);
        }
    }, [canManageBilling]);

    const openBillingPortal = useCallback(async () => {
        if (!canManageBilling) {
            setBillingNotice({ tone: 'error', text: 'You need billing write access to manage the subscription.' });
            return;
        }

        setSubscriptionSaving('portal');
        setBillingNotice(null);
        try {
            const payload = await postBilling('/billing/portal', {}, 'Billing portal failed');
            const portalUrl = readBillingRedirectUrl(payload, 'portalUrl');
            if (!portalUrl) throw new Error('Stripe billing portal did not return a redirect URL.');
            setBillingNotice({ tone: 'success', text: 'Redirecting to Stripe billing...' });
            window.location.assign(portalUrl);
        } catch (error) {
            setBillingNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to open billing portal.' });
            setSubscriptionSaving(null);
        }
    }, [canManageBilling]);

    const changeSubscription = useCallback(async (option: BillingPriceOption) => {
        if (!canManageBilling) {
            setBillingNotice({ tone: 'error', text: 'You need billing write access to change plans.' });
            return;
        }
        if (!option.priceId) {
            setBillingNotice({ tone: 'error', text: option.label + ' is not configured.' });
            return;
        }

        setSubscriptionSaving('change:' + option.code);
        setBillingNotice(null);
        try {
            await postBilling('/billing/change-plan', { priceId: option.priceId }, 'Plan change failed');
            setBillingNotice({ tone: 'success', text: 'Plan change to ' + option.label + ' submitted.' });
            await loadSubscriptionBilling();
        } catch (error) {
            setBillingNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to change plans.' });
        } finally {
            setSubscriptionSaving(null);
        }
    }, [canManageBilling, loadSubscriptionBilling]);

    const resumeSubscription = useCallback(async () => {
        if (!canManageBilling) {
            setBillingNotice({ tone: 'error', text: 'You need billing write access to resume subscriptions.' });
            return;
        }

        setSubscriptionSaving('resume');
        setBillingNotice(null);
        try {
            const payload = await postBilling('/billing/resume', {}, 'Subscription resume failed');
            const paymentUrl = readBillingRedirectUrl(payload, 'paymentUrl');
            if (paymentUrl) {
                setBillingNotice({ tone: 'success', text: 'Redirecting to Stripe payment recovery...' });
                window.location.assign(paymentUrl);
                return;
            }
            setBillingNotice({ tone: 'success', text: 'Subscription resume submitted.' });
            await loadSubscriptionBilling();
        } catch (error) {
            setBillingNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to resume the subscription.' });
        } finally {
            setSubscriptionSaving(null);
        }
    }, [canManageBilling, loadSubscriptionBilling]);

    const purchaseCreditPack = useCallback(async (option: CreditPackOption) => {
        if (!canManageBilling) {
            setBillingNotice({ tone: 'error', text: 'You need billing write access to purchase credits.' });
            return;
        }
        if (!hasActivePaidSubscription(billingState.matrix)) {
            setBillingNotice({ tone: 'error', text: 'An active paid subscription is required to purchase credits.' });
            return;
        }
        if (!option.configured || option.amount === null || !option.currency) {
            setBillingNotice({ tone: 'error', text: option.credits + '-credit pack is not currently available.' });
            return;
        }

        setCreditPackSaving(option.code);
        setBillingNotice(null);
        try {
            const payload = await postBilling(
                '/billing/credit-packs/checkout',
                { code: option.code },
                'Credit-pack checkout failed',
            );
            const checkoutUrl = readBillingRedirectUrl(payload, 'checkoutUrl');
            if (!checkoutUrl) throw new Error('Stripe Checkout did not return a redirect URL.');
            setBillingNotice({ tone: 'success', text: 'Redirecting to Stripe Checkout...' });
            window.location.assign(checkoutUrl);
        } catch (error) {
            setBillingNotice({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to purchase credits.' });
            setCreditPackSaving(null);
        }
    }, [billingState.matrix, canManageBilling]);

    return {
        billingState,
        creditPackState,
        billingNotice,
        billingFeatures,
        configuredPriceOptions,
        canPurchaseCreditPacks,
        subscriptionSaving,
        creditPackSaving,
        billingReturnDetected,
        loadBilling,
        loadCreditPacks,
        startSubscription,
        changeSubscription,
        openBillingPortal,
        resumeSubscription,
        purchaseCreditPack,
    };
}
