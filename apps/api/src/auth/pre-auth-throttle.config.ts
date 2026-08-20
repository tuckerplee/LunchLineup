const DEFAULT_PRE_AUTH_IP_LIMIT = 30;
const DEFAULT_PRE_AUTH_IDENTIFIER_LIMIT = 5;
const MAX_E2E_PRE_AUTH_LIMIT = 500;

export function resolvePreAuthThrottleLimits(env: NodeJS.ProcessEnv = process.env): {
    ip: number;
    identifier: number;
} {
    const rawIp = env.E2E_PREAUTH_IP_LIMIT?.trim();
    const rawIdentifier = env.E2E_PREAUTH_IDENTIFIER_LIMIT?.trim();
    if (!rawIp && !rawIdentifier) {
        return { ip: DEFAULT_PRE_AUTH_IP_LIMIT, identifier: DEFAULT_PRE_AUTH_IDENTIFIER_LIMIT };
    }

    if (env.NODE_ENV !== 'test' || env.DATA_TARGET_ENV !== 'test' || env.E2E_FULL_STACK !== '1') {
        throw new Error('E2E pre-auth throttle overrides require the isolated full-stack test environment');
    }

    const parseLimit = (name: string, raw: string | undefined, fallback: number): number => {
        if (!raw) return fallback;
        if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
        const value = Number(raw);
        if (value < fallback || value > MAX_E2E_PRE_AUTH_LIMIT) {
            throw new Error(`${name} must be between ${fallback} and ${MAX_E2E_PRE_AUTH_LIMIT}`);
        }
        return value;
    };

    return {
        ip: parseLimit('E2E_PREAUTH_IP_LIMIT', rawIp, DEFAULT_PRE_AUTH_IP_LIMIT),
        identifier: parseLimit(
            'E2E_PREAUTH_IDENTIFIER_LIMIT',
            rawIdentifier,
            DEFAULT_PRE_AUTH_IDENTIFIER_LIMIT,
        ),
    };
}
