import { performance } from 'node:perf_hooks';

export type MfaSessionIdentity = { sub: string; tenantId: string; sessionId: string };
export type MfaVerificationObservation = MfaSessionIdentity & {
    expiresAtEpochMs: number;
    // Process-local deadline: never serialize or accept this from a client.
    expiresAtMonotonicMs: number;
};
export type MfaSessionObserver = {
    observeSessionMfa(identity: MfaSessionIdentity): Promise<MfaVerificationObservation | null>;
};

// Read the verified value and its TTL in the same Redis execution. Keys without
// expiration cannot constitute a bounded MFA proof. This script never writes.
export const MFA_MARKER_TTL_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= '1' then return -2 end
return redis.call('PTTL', KEYS[1])
`;
const MAX_MFA_MARKER_TTL_MS = 1440 * 60_000 + 1000; // Maximum session policy plus TTL rounding.

export async function observeMfaVerification(
    identity: MfaSessionIdentity,
    read: (script: string, key: string) => Promise<unknown>,
    timeoutMs = 5000,
): Promise<MfaVerificationObservation | null> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000) {
        throw new Error('Invalid MFA observation timeout');
    }
    const selected = { sub: identity.sub, tenantId: identity.tenantId, sessionId: identity.sessionId };
    const startedEpochMs = Date.now(), startedMonotonicMs = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ttl: unknown;
    try {
        ttl = await Promise.race([
            read(MFA_MARKER_TTL_SCRIPT, `session_mfa:${selected.sessionId}`),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('MFA observation timed out')), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
    if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_MFA_MARKER_TTL_MS) return null;
    const observation = { ...selected, expiresAtEpochMs: startedEpochMs + ttl,
        expiresAtMonotonicMs: startedMonotonicMs + ttl };
    return isCurrentMfaObservation(observation, selected) ? observation : null;
}

export function isCurrentMfaObservation(
    observation: MfaVerificationObservation | null | undefined,
    identity: MfaSessionIdentity,
): boolean {
    return !!observation
        && observation.sub === identity.sub
        && observation.tenantId === identity.tenantId
        && observation.sessionId === identity.sessionId
        && Number.isSafeInteger(observation.expiresAtEpochMs)
        && Number.isFinite(observation.expiresAtMonotonicMs)
        && observation.expiresAtEpochMs > Date.now()
        && observation.expiresAtMonotonicMs > performance.now();
}
