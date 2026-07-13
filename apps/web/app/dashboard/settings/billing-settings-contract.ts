import type { BillingFeatureMatrix, BillingFeatureResolution } from './BillingSettingsPanel';

export type BillingManagementMode = 'portal' | 'subscribe';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readString(source: Record<string, unknown>, key: string, fallback = ''): string {
    const value = source[key];
    return typeof value === 'string' && value.trim() ? value : fallback;
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
        stripeSubscriptionActive: readBoolean(root, 'stripeSubscriptionActive'),
        stripeSubscriptionPresent: readBoolean(root, 'stripeSubscriptionPresent'),
        subscriptionRecoveryAction: readSubscriptionRecoveryAction(root),
        usageCredits: readOptionalNumber(root, 'usageCredits') ?? 0,
        features,
    };
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

export function readBillingRedirectUrl(
    payload: unknown,
    field: 'checkoutUrl' | 'portalUrl' | 'paymentUrl',
): string | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const value = (payload as Record<string, unknown>)[field];
    return typeof value === 'string' && /^https:\/\//i.test(value.trim()) ? value.trim() : null;
}
