import type { StaffInvitationPayload } from './staff-onboarding';

export type InvitationRecovery = { key: string; details: Omit<StaffInvitationPayload, 'pin'> };
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function invitationRecoveryStorageKey(scope: string): string {
    if (!/^[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/.test(scope)) throw new Error('Invalid staff recovery scope.');
    return `lunchlineup:staff-create:v1:${scope}`;
}

function details(payload: StaffInvitationPayload): InvitationRecovery['details'] {
    return {
        name: payload.name.trim(),
        ...(payload.email ? { email: payload.email.trim().toLowerCase() } : {}),
        ...(payload.username ? { username: payload.username.trim().toLowerCase() } : {}),
        ...(payload.roleId ? { roleId: payload.roleId } : {}),
    };
}

function parseInvitationRecovery(raw: string): InvitationRecovery {
    const value = JSON.parse(raw) as InvitationRecovery;
    if (!value || typeof value.key !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.key)
        || !value.details || typeof value.details.name !== 'string'
        || Object.keys(value).some(key => !['key', 'details'].includes(key))
        || Object.keys(value.details).some(key => !['name', 'email', 'username', 'roleId'].includes(key))
        || Object.values(value.details).some(field => typeof field !== 'string')
        || !value.details.name || Boolean(value.details.email) === Boolean(value.details.username)) {
        throw new Error('Staff recovery state could not be read. Review the staff directory before creating this employee again.');
    }
    return value;
}

export function readInvitationRecovery(storage: RecoveryStorage, scope: string): InvitationRecovery | null {
    const raw = storage.getItem(invitationRecoveryStorageKey(scope));
    // Corrupt state must not silently allocate a new key for an uncertain create.
    return raw === null ? null : parseInvitationRecovery(raw);
}

/** Called only after fresh directory loading and explicit user acknowledgement. */
export function acknowledgeCorruptInvitationRecovery(storage: RecoveryStorage, scope: string, reviewedRaw: string | null): void {
    const storageKey = invitationRecoveryStorageKey(scope);
    const currentRaw = storage.getItem(storageKey);
    if (currentRaw !== reviewedRaw) throw new Error('Recovery changed during review. Reload the directory and review again.');
    if (currentRaw === null) return;
    let corrupt = false;
    try { parseInvitationRecovery(currentRaw); } catch { corrupt = true; }
    if (!corrupt) throw new Error('A valid creation attempt is awaiting confirmation. Retry its original details or confirm the employee in the directory.');
    storage.removeItem(storageKey);
    if (storage.getItem(storageKey) !== null) throw new Error('Recovery storage could not be cleared.');
}

export function prepareInvitationRecovery(
    storage: RecoveryStorage, scope: string, payload: StaffInvitationPayload,
    keyFactory: () => string = () => crypto.randomUUID(),
): InvitationRecovery {
    const current = readInvitationRecovery(storage, scope);
    const submitted = details(payload);
    if (current && JSON.stringify(details(current.details)) !== JSON.stringify(submitted)) {
        throw new Error('An earlier creation is awaiting confirmation. Retry with the original staff details and original PIN, or review the directory and resolve that attempt first.');
    }
    const attempt = current ?? { key: keyFactory(), details: submitted };
    // Never store a PIN, payload fingerprint containing it, or returned credentials.
    storage.setItem(invitationRecoveryStorageKey(scope), JSON.stringify(attempt));
    return attempt;
}

export function clearInvitationRecovery(storage: RecoveryStorage, scope: string, key: string): void {
    if (readInvitationRecovery(storage, scope)?.key === key) storage.removeItem(invitationRecoveryStorageKey(scope));
}
