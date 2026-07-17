export type StripeErrorCategory =
    | 'authentication'
    | 'connectivity'
    | 'conflict'
    | 'invalid_request'
    | 'rate_limit'
    | 'signature'
    | 'timeout'
    | 'unknown';

export type StripeErrorDiagnostic = {
    event: string;
    errorClass: string;
    category: StripeErrorCategory;
    code?: string;
    requestRef?: string;
};

const SAFE_ERROR_CLASSES = new Set([
    'AbortError',
    'Error',
    'StripeAPIError',
    'StripeAuthenticationError',
    'StripeConnectionError',
    'StripeError',
    'StripeIdempotencyError',
    'StripeInvalidGrantError',
    'StripeInvalidRequestError',
    'StripePermissionError',
    'StripeRateLimitError',
    'StripeSignatureVerificationError',
    'StripeUnknownError',
    'TimeoutError',
    'TypeError',
]);

const SAFE_ERROR_CODES: Readonly<Record<string, StripeErrorCategory>> = {
    ABORT_ERR: 'timeout',
    EAI_AGAIN: 'connectivity',
    ECONNREFUSED: 'connectivity',
    ECONNRESET: 'connectivity',
    ENETDOWN: 'connectivity',
    ENETUNREACH: 'connectivity',
    ENOTFOUND: 'connectivity',
    EPIPE: 'connectivity',
    ESOCKETTIMEDOUT: 'timeout',
    ETIMEDOUT: 'timeout',
    api_connection_error: 'connectivity',
    api_key_expired: 'authentication',
    authentication_error: 'authentication',
    idempotency_error: 'conflict',
    idempotency_key_in_use: 'conflict',
    invalid_request_error: 'invalid_request',
    lock_timeout: 'conflict',
    platform_api_key_expired: 'authentication',
    rate_limit: 'rate_limit',
    resource_missing: 'invalid_request',
    secret_key_required: 'authentication',
    signature_verification_error: 'signature',
};

function errorChain(error: unknown): object[] {
    const chain: object[] = [];
    let current = error;
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
        chain.push(current);
        current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
    }
    return chain;
}

function safeErrorClass(chain: object[]): string {
    let fallback: string | undefined;
    for (const error of chain) {
        const candidates = [
            'type' in error ? (error as { type?: unknown }).type : undefined,
            'name' in error ? (error as { name?: unknown }).name : undefined,
            error instanceof Error ? error.constructor?.name : undefined,
        ];
        for (const candidate of candidates) {
            if (typeof candidate !== 'string' || !SAFE_ERROR_CLASSES.has(candidate)) continue;
            if (candidate.startsWith('Stripe')) return candidate;
            fallback ??= candidate;
        }
    }
    return fallback ?? (chain.length > 0 ? 'Error' : 'NonErrorThrow');
}

function safeErrorCode(chain: object[]): string | undefined {
    for (const error of chain) {
        if (!('code' in error)) continue;
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(SAFE_ERROR_CODES, code)) return code;
    }
    return undefined;
}

function safeRequestRef(chain: object[]): string | undefined {
    for (const error of chain) {
        const candidates = [
            'requestId' in error ? (error as { requestId?: unknown }).requestId : undefined,
            'request_id' in error ? (error as { request_id?: unknown }).request_id : undefined,
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && /^req_[A-Za-z0-9]{6,64}$/.test(candidate)) return candidate;
        }
    }
    return undefined;
}

function categoryFor(errorClass: string, code?: string): StripeErrorCategory {
    if (code) return SAFE_ERROR_CODES[code];
    if (errorClass === 'StripeAuthenticationError' || errorClass === 'StripeInvalidGrantError' || errorClass === 'StripePermissionError') return 'authentication';
    if (errorClass === 'StripeConnectionError') return 'connectivity';
    if (errorClass === 'StripeIdempotencyError') return 'conflict';
    if (errorClass === 'StripeInvalidRequestError' || errorClass === 'TypeError') return 'invalid_request';
    if (errorClass === 'StripeRateLimitError') return 'rate_limit';
    if (errorClass === 'StripeSignatureVerificationError') return 'signature';
    if (errorClass === 'AbortError' || errorClass === 'TimeoutError') return 'timeout';
    return 'unknown';
}

export function stripeErrorDiagnostic(event: string, error: unknown): StripeErrorDiagnostic {
    const chain = errorChain(error);
    const errorClass = safeErrorClass(chain);
    const code = safeErrorCode(chain);
    const requestRef = safeRequestRef(chain);
    const safeEvent = /^[a-z0-9_.-]{1,100}$/.test(event) ? event : 'stripe.operational_error';
    return {
        event: safeEvent,
        errorClass,
        category: categoryFor(errorClass, code),
        ...(code ? { code } : {}),
        ...(requestRef ? { requestRef } : {}),
    };
}

export function stripeErrorLog(event: string, error: unknown): string {
    return JSON.stringify(stripeErrorDiagnostic(event, error));
}
