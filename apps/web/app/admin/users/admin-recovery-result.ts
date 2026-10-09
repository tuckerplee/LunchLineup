type RecoveryResult = Record<string, unknown>;

function resultForTarget(payload: unknown, targetId: string): RecoveryResult | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const result = payload as RecoveryResult;
    return result.id === targetId ? result : null;
}

export function requireAdminPinReset(payload: unknown, targetId: string): { temporaryPin: string } {
    const result = resultForTarget(payload, targetId);
    if (!result || result.pinResetRequired !== true || typeof result.username !== 'string'
        || !result.username.trim() || typeof result.temporaryPin !== 'string'
        || !/^\d{6}$/.test(result.temporaryPin)) {
        throw new Error('The PIN reset could not be confirmed. The previous PIN may no longer work. Refresh the user before trying again.');
    }
    return { temporaryPin: result.temporaryPin };
}

export function requireAdminMfaReset(payload: unknown, targetId: string): void {
    const result = resultForTarget(payload, targetId);
    if (!result || result.mfaEnabled !== false || typeof result.sessionsRevoked !== 'number'
        || !Number.isSafeInteger(result.sessionsRevoked) || result.sessionsRevoked < 0) {
        throw new Error('The MFA reset could not be confirmed. Refresh the user to check their security status before trying again.');
    }
}
