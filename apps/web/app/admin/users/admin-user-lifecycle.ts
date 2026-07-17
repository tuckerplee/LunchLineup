export type AdminUserStatus = 'ACTIVE' | 'LOCKED' | 'SUSPENDED' | 'DELETED';

export type AdminUserLifecycleFields = {
    deletedAt: string | null;
    suspendedAt: string | null;
    lockedUntil: string | null;
    pinLockedUntil: string | null;
};

function isFuture(value: string | null, now: number): boolean {
    if (!value) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp > now;
}

export function resolveAdminUserStatus(
    user: AdminUserLifecycleFields,
    now = Date.now(),
): AdminUserStatus {
    if (user.deletedAt) return 'DELETED';
    if (user.suspendedAt) return 'SUSPENDED';
    if (isFuture(user.lockedUntil, now) || isFuture(user.pinLockedUntil, now)) return 'LOCKED';
    return 'ACTIVE';
}

export function canMutateAdminUserLifecycle(status: AdminUserStatus): boolean {
    return status !== 'DELETED';
}
