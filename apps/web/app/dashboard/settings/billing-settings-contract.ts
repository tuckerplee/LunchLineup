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

export const CREDIT_PACK_DEFINITIONS = [
    { code: 'CREDITS_100', credits: 100 },
    { code: 'CREDITS_500', credits: 500 },
    { code: 'CREDITS_2000', credits: 2000 },
] as const;

export type CreditPackCode = (typeof CREDIT_PACK_DEFINITIONS)[number]['code'];

export type CreditPackOption = {
    code: CreditPackCode;
    credits: number;
    configured: boolean;
    amount: number | null;
    currency: string | null;
};

export type CreditPackState = {
    loading: boolean;
    error: string | null;
    options: CreditPackOption[];
};

export type BillingManagementMode = 'portal' | 'subscribe';

export type BillingReturnState =
    | 'credit-purchase-pending'
    | 'credit-purchase-success'
    | 'credit-purchase-cancelled'
    | 'subscription-success'
    | 'subscription-cancelled'
    | 'portal-return';

const BILLING_RETURN_STATES: Record<string, BillingReturnState> = {
    'credit-purchase-pending': 'credit-purchase-pending',
    'credit-purchase-success': 'credit-purchase-success',
    'credit-purchase-cancelled': 'credit-purchase-cancelled',
    success: 'subscription-success',
    cancelled: 'subscription-cancelled',
    'portal-return': 'portal-return',
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function unwrapDataArray(payload: unknown): Record<string, unknown>[] {
    const root = asRecord(payload);
    const raw = Array.isArray(payload) ? payload : Array.isArray(root?.data) ? root.data : [];
    return raw.map(asRecord).filter((value): value is Record<string, unknown> => Boolean(value));
}

function readString(source: Record<string, unknown>, key: string, fallback = ''): string {
    const value = source[key];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readOptionalString(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBoolean(source: Record<string, unknown>, key: string, fallback = false): boolean {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (value === 'true' || value === '1') return true;
        if (value === 'false' || value === '0') return false;
    }
    if (typeof value === 'number') return value !== 0;
    return fallback;
}

function readOptionalNumber(source: Record<string, unknown>, key: string): number | null {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function readSubscriptionRecoveryAction(
    source: Record<string, unknown>,
): BillingFeatureMatrix['subscriptionRecoveryAction'] {
    const value = source.subscriptionRecoveryAction;
    return value === 'resume' || value === 'portal' ? value : null;
}

export function normalizeBillingFeatureMatrix(payload: unknown): BillingFeatureMatrix {
    const root = asRecord(payload) ?? {};
    const featuresRecord = asRecord(root.features) ?? {};
    const features: Record<string, BillingFeatureResolution> = {};

    Object.entries(featuresRecord).forEach(([key, rawValue]) => {
        const value = asRecord(rawValue) ?? {};
        features[key] = {
            enabled: readBoolean(value, 'enabled'),
            source: readString(value, 'source', 'disabled'),
            reason: readString(value, 'reason'),
            creditCost: readOptionalNumber(value, 'creditCost'),
        };
    });

    return {
        planTier: readString(root, 'planTier', 'Unknown'),
        effectivePlanTier: readString(root, 'effectivePlanTier', 'FREE'),
        status: readString(root, 'status', 'Unknown'),
        trialEndsAt: readOptionalString(root, 'trialEndsAt'),
        stripeSubscriptionActive: readBoolean(root, 'stripeSubscriptionActive'),
        stripeSubscriptionPresent: readBoolean(root, 'stripeSubscriptionPresent'),
        subscriptionRecoveryAction: readSubscriptionRecoveryAction(root),
        usageCredits: readOptionalNumber(root, 'usageCredits') ?? 0,
        features,
    };
}

export function normalizePriceOptions(payload: unknown): BillingPriceOption[] {
    return unwrapDataArray(payload).map((option) => ({
        code: readString(option, 'code', 'UNKNOWN'),
        label: readString(option, 'label', readString(option, 'code', 'Plan')),
        priceId: readOptionalString(option, 'priceId'),
        configured: readBoolean(option, 'configured'),
    }));
}

export function normalizeCreditPackOptions(payload: unknown): CreditPackOption[] {
    const options = unwrapDataArray(payload);

    return CREDIT_PACK_DEFINITIONS.map((definition) => {
        const option = options.find((candidate) => (
            readString(candidate, 'code').toUpperCase() === definition.code
            && readOptionalNumber(candidate, 'credits') === definition.credits
        ));
        const amount = option ? readOptionalNumber(option, 'amount') : null;
        const currency = option ? readOptionalString(option, 'currency')?.toLowerCase() ?? null : null;
        const configured = option?.configured === true
            && Number.isSafeInteger(amount)
            && (amount ?? 0) > 0
            && Boolean(currency && /^[a-z]{3}$/.test(currency));

        return {
            ...definition,
            configured,
            amount: configured ? amount : null,
            currency: configured ? currency : null,
        };
    });
}

export function hasActivePaidSubscription(matrix: BillingFeatureMatrix | null): boolean {
    const effectiveTier = matrix?.effectivePlanTier?.trim().toUpperCase();
    return matrix?.status?.trim().toUpperCase() === 'ACTIVE'
        && matrix.stripeSubscriptionActive === true
        && matrix.stripeSubscriptionPresent === true
        && Boolean(effectiveTier && effectiveTier !== 'FREE' && effectiveTier !== 'UNKNOWN');
}

export function resolveBillingManagementMode(matrix: BillingFeatureMatrix | null): BillingManagementMode {
    return matrix?.stripeSubscriptionPresent ? 'portal' : 'subscribe';
}

export function isTerminallyCancelled(matrix: BillingFeatureMatrix | null): boolean {
    return matrix?.status?.toUpperCase() === 'CANCELLED' && !matrix.stripeSubscriptionPresent;
}

export function canAttemptPausedSubscriptionRecovery(matrix: BillingFeatureMatrix | null): boolean {
    return matrix?.subscriptionRecoveryAction === 'resume';
}

export function shouldUseBillingPortalForRecovery(matrix: BillingFeatureMatrix | null): boolean {
    return matrix?.subscriptionRecoveryAction === 'portal';
}

export function readBillingReturnState(search: string): BillingReturnState | null {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    const value = params.get('billing');
    return value ? BILLING_RETURN_STATES[value] ?? null : null;
}

export function sanitizeBillingReturnSearch(search: string): string {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    params.delete('billing');
    params.delete('session_id');
    const sanitized = params.toString();
    return sanitized ? '?' + sanitized : '';
}

export function readBillingRedirectUrl(
    payload: unknown,
    field: 'checkoutUrl' | 'portalUrl' | 'paymentUrl',
): string | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const value = (payload as Record<string, unknown>)[field];
    return typeof value === 'string' && /^https:\/\//i.test(value.trim()) ? value.trim() : null;
}
