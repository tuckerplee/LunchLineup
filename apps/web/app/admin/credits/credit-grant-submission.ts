import {
    idempotentRequestAttempt,
    type IdempotentRequestAttempt,
} from '../../../lib/client-api';

export type CreditGrantPayload = {
    tenantId: string;
    amount: number;
    reason: string;
};

export type CreditGrantSubmissionState = {
    attempt: IdempotentRequestAttempt | null;
    inFlight: boolean;
};

export type CreditGrantSubmissionResult<T> =
    | { submitted: false }
    | { submitted: true; value: T };

export function createCreditGrantSubmissionState(): CreditGrantSubmissionState {
    return { attempt: null, inFlight: false };
}

export async function submitCreditGrant<T>(
    state: CreditGrantSubmissionState,
    payload: CreditGrantPayload,
    send: (payload: CreditGrantPayload, idempotencyKey: string) => Promise<T>,
    keyFactory?: () => string,
): Promise<CreditGrantSubmissionResult<T>> {
    if (state.inFlight) return { submitted: false };

    state.inFlight = true;
    try {
        const candidate = idempotentRequestAttempt(payload, state.attempt, keyFactory);
        const key = candidate.key.trim();
        if (!key) throw new Error('Unable to create a stable credit-grant attempt.');

        const attempt = key === candidate.key ? candidate : { ...candidate, key };
        state.attempt = attempt;
        const value = await send(payload, attempt.key);
        state.attempt = null;
        return { submitted: true, value };
    } finally {
        state.inFlight = false;
    }
}
