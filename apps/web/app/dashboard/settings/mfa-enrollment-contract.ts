export type MfaSetupChallenge = {
    enrollmentId: string | null;
    otpauthUrl: string | null;
    qrCodeDataUrl: string | null;
    manualEntryKey: string;
    expiresAt: string | null;
    issuer: string | null;
    accountLabel: string | null;
};

export type MfaEnrollmentState = {
    enabled: boolean;
    verifiedAt: string | null;
    recoveryCodesRemaining: number | null;
    setup: MfaSetupChallenge | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function unwrapPayload(payload: unknown): Record<string, unknown> {
    const root = asRecord(payload);
    if (!root) return {};
    return asRecord(root.data) ?? asRecord(root.result) ?? asRecord(root.enrollment) ?? root;
}

function firstRecord(source: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
    for (const key of keys) {
        const value = asRecord(source[key]);
        if (value) return value;
    }
    return null;
}

function readString(source: Record<string, unknown>, keys: string[], fallback = ''): string {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return fallback;
}

function readNullableString(source: Record<string, unknown>, keys: string[]): string | null {
    const value = readString(source, keys, '');
    return value || null;
}

function readBoolean(source: Record<string, unknown>, keys: string[], fallback = false): boolean {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            if (value === 'true' || value === '1') return true;
            if (value === 'false' || value === '0') return false;
        }
        if (typeof value === 'number') return value !== 0;
    }
    return fallback;
}

function readOptionalNumber(source: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return null;
}

function readStringArray(source: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
        const value = source[key];
        if (Array.isArray(value)) {
            return value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
        }
    }
    return [];
}

export function normalizeMfaSetupChallenge(payload: unknown): MfaSetupChallenge {
    const root = unwrapPayload(payload);
    const setup = firstRecord(root, ['setup', 'challenge', 'totp', 'mfa']) ?? root;

    return {
        enrollmentId: readNullableString(setup, ['enrollmentId', 'setupId', 'id']),
        otpauthUrl: readNullableString(setup, ['otpauthUrl', 'otpauthUri', 'uri']),
        qrCodeDataUrl: readNullableString(setup, ['qrCodeDataUrl', 'qrCodeUrl', 'qr']),
        manualEntryKey: readString(setup, ['manualEntryKey', 'secret', 'base32Secret', 'key']),
        expiresAt: readNullableString(setup, ['expiresAt', 'expires']),
        issuer: readNullableString(setup, ['issuer']),
        accountLabel: readNullableString(setup, ['accountLabel', 'label', 'account']),
    };
}

export function normalizeMfaEnrollmentState(payload: unknown): MfaEnrollmentState {
    const root = unwrapPayload(payload);
    const setup = firstRecord(root, ['setup', 'challenge', 'totp', 'mfa']);

    return {
        enabled: readBoolean(root, ['enabled', 'mfaEnabled', 'enrolled']),
        verifiedAt: readNullableString(root, ['verifiedAt', 'enabledAt', 'lastVerifiedAt']),
        recoveryCodesRemaining: readOptionalNumber(root, ['recoveryCodesRemaining', 'backupCodesRemaining', 'backupCodeCount']),
        setup: setup ? normalizeMfaSetupChallenge(setup) : null,
    };
}

export function readRecoveryCodes(payload: unknown): string[] {
    const root = unwrapPayload(payload);
    return readStringArray(root, ['recoveryCodes', 'backupCodes', 'codes']);
}

function invalidResponse(): never {
    throw new Error('The service returned an invalid MFA response. Refresh the status before trying again.');
}

/** Validate the actual owner response before displaying a persisted status. */
export function requireMfaEnrollmentState(payload: unknown): MfaEnrollmentState {
    const root = asRecord(payload);
    if (!root || typeof root.enabled !== 'boolean'
        || typeof root.recoveryCodesRemaining !== 'number'
        || !Number.isSafeInteger(root.recoveryCodesRemaining) || root.recoveryCodesRemaining < 0) {
        return invalidResponse();
    }
    return {
        enabled: root.enabled,
        verifiedAt: typeof root.verifiedAt === 'string' ? root.verifiedAt : null,
        recoveryCodesRemaining: root.recoveryCodesRemaining,
        setup: null,
    };
}

export function requireMfaSetupChallenge(payload: unknown): MfaSetupChallenge {
    const root = asRecord(payload);
    if (!root || typeof root.secret !== 'string' || !root.secret.trim()
        || typeof root.otpauthUrl !== 'string' || !root.otpauthUrl.startsWith('otpauth://totp/')
        || typeof root.expiresInSeconds !== 'number' || !Number.isSafeInteger(root.expiresInSeconds)
        || root.expiresInSeconds <= 0) return invalidResponse();
    return {
        enrollmentId: null,
        otpauthUrl: root.otpauthUrl,
        qrCodeDataUrl: null,
        manualEntryKey: root.secret,
        expiresAt: null,
        issuer: null,
        accountLabel: null,
    };
}

export function requireMfaConfirmation(payload: unknown): string[] {
    const root = asRecord(payload);
    if (!root || root.success !== true || root.mfaVerified !== true
        || !Array.isArray(root.backupCodes) || root.backupCodes.length === 0
        || !root.backupCodes.every(code => typeof code === 'string' && Boolean(code.trim()))) {
        return invalidResponse();
    }
    return [...root.backupCodes] as string[];
}

export function requireMfaDisableConfirmation(payload: unknown): void {
    const root = asRecord(payload);
    if (!root || root.success !== true || root.mfaEnabled !== false) invalidResponse();
}
