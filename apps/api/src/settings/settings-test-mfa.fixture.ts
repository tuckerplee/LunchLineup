import { performance } from 'node:perf_hooks';
import type { MfaSessionObserver } from '@lunchlineup/rbac';

// Explicit local settings-unit proof; never a Redis/native MFA qualification.
export const verifiedSettingsObserver: MfaSessionObserver = {
    async observeSessionMfa(identity) {
        return { ...identity, expiresAtEpochMs: Date.now() + 3_600_000,
            expiresAtMonotonicMs: performance.now() + 3_600_000 };
    },
};
