import type { MessageAction } from './types';

/** Inline link attached to a real billing block (out of credits / payment required). */
export const BILLING_ACTION: MessageAction = {
    label: 'Open Billing',
    href: '/dashboard/settings?tab=billing',
};

/**
 * True for a REAL blocking condition reported by the API: HTTP 402, or a refusal
 * whose message says the workspace needs a subscription, credits or payment.
 * It is never used to show a cost warning before the user acts.
 */
export function isBillingBlock(status: number | null | undefined, text: string | null | undefined): boolean {
    if (status === 402) return true;
    if (status === 403 && /(?:subscription|credit|payment)/i.test(text ?? '')) return true;
    return Boolean(text) && /\b(?:out of credits|payment required|active (?:paid )?subscription|no (?:available )?credits|insufficient credits|enough (?:\w+ )?credits)\b/i.test(text ?? '');
}
