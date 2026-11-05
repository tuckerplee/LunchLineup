import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Explicit billing provider selection.
 *
 * `stripe` (default) is the only mode that talks to Stripe. `disabled` is for
 * non-production data targets only (the internal pilot on staging): no Stripe
 * client is constructed, billing endpoints answer 503 `billing_disabled`, and
 * usage metering never reports to a provider. It is NOT a fake-key mode.
 */
export type BillingProvider = 'stripe' | 'disabled';

export const BILLING_PROVIDER_VALUES: readonly BillingProvider[] = ['stripe', 'disabled'];
/** DATA_TARGET_ENV values on which billing may be disabled. `production` and unset are refused. */
export const BILLING_DISABLED_DATA_TARGETS: readonly string[] = ['staging', 'development', 'disposable', 'test'];
export const BILLING_DISABLED_CODE = 'billing_disabled';
export const BILLING_DISABLED_MESSAGE = 'Billing is disabled for this environment.';

/** Returns the provider, or null when the configured value is not recognised. Unset means stripe. */
export function parseBillingProvider(value: string | undefined | null): BillingProvider | null {
    const normalized = (value ?? '').trim();
    if (!normalized) return 'stripe';
    return (BILLING_PROVIDER_VALUES as readonly string[]).includes(normalized) ? normalized as BillingProvider : null;
}

/** Only the exact lower-case value `disabled` disables billing; anything unrecognised never does. */
export function isBillingDisabled(value: string | undefined | null = process.env.BILLING_PROVIDER): boolean {
    return (value ?? '').trim() === 'disabled';
}

/** Startup validation shared by the API bootstrap. Returns error strings (empty when valid). */
export function billingProviderErrors(env: NodeJS.ProcessEnv): string[] {
    const provider = parseBillingProvider(env.BILLING_PROVIDER);
    if (provider === null) return ['BILLING_PROVIDER must be exactly stripe or disabled.'];
    if (provider === 'disabled') {
        const target = (env.DATA_TARGET_ENV ?? '').trim();
        if (!BILLING_DISABLED_DATA_TARGETS.includes(target)) {
            return [`BILLING_PROVIDER=disabled is only allowed when DATA_TARGET_ENV is one of ${BILLING_DISABLED_DATA_TARGETS.join(', ')} (never production).`];
        }
    }
    return [];
}

export class BillingDisabledException extends HttpException {
    constructor() {
        super({
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            error: 'Service Unavailable',
            code: BILLING_DISABLED_CODE,
            message: BILLING_DISABLED_MESSAGE,
        }, HttpStatus.SERVICE_UNAVAILABLE);
    }
}

export function assertBillingEnabled(value: string | undefined | null = process.env.BILLING_PROVIDER): void {
    if (isBillingDisabled(value)) throw new BillingDisabledException();
}
