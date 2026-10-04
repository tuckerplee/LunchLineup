import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { isCurrentMfaObservation, PRIVILEGED_MFA_PERMISSION_KEYS,
    type MfaSessionObserver, type MfaVerificationObservation } from '@lunchlineup/rbac';
import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';

export type CurrentMutationActor = Readonly<{ userId: string; tenantId: string; sessionId: string }>;
export type CurrentMutationPolicy = Readonly<{
    actor: CurrentMutationActor;
    expiresAtEpochMs: number;
    requiresMfa: boolean;
}>;
export type CurrentMutationOptions = {
    actor: CurrentMutationActor;
    requiredPermission: string;
    scope?: 'tenant' | 'platform';
    mfaObserver?: MfaSessionObserver;
    conflictMessage?: string | ((error: unknown) => string);
    isConflict?: (error: unknown) => boolean;
};

export function freezeMutationActor(actor: CurrentMutationActor): CurrentMutationActor {
    const selected = { userId: actor.userId?.trim(), tenantId: actor.tenantId?.trim(),
        sessionId: actor.sessionId?.trim() };
    if (!selected.userId || !selected.tenantId || !selected.sessionId) {
        throw new ForbiddenException('A live administrator identity and session are required');
    }
    return Object.freeze(selected);
}

/** Read after the caller has acquired ordered Tenant/User/Session/RBAC locks.
 * This extension takes no late identity locks and does not alter self recovery.
 */
export async function captureCurrentMutationPolicy(
    tx: TenantPrismaTransaction,
    actor: CurrentMutationActor,
    permissions: Iterable<string>,
): Promise<CurrentMutationPolicy> {
    const tenant = await tx.tenant.findUnique({
        where: { id: actor.tenantId }, select: { id: true, status: true, deletedAt: true },
    });
    if (!tenant || tenant.id !== actor.tenantId || tenant.deletedAt
        || tenant.status === 'SUSPENDED' || tenant.status === 'PURGED') {
        throw new ForbiddenException('The workspace is no longer active');
    }
    const user = await tx.user.findFirst({
        where: { id: actor.userId, tenantId: actor.tenantId, deletedAt: null, suspendedAt: null },
        select: { id: true, tenantId: true, pinResetRequired: true, mfaEnabled: true,
            lockedUntil: true, pinLockedUntil: true },
    });
    if (!user || user.id !== actor.userId || user.tenantId !== actor.tenantId) {
        throw new ForbiddenException('Administrator account is inactive');
    }
    if ((user.lockedUntil?.getTime() ?? 0) > Date.now()
        || (user.pinLockedUntil?.getTime() ?? 0) > Date.now()) {
        throw new ForbiddenException('Administrator account is locked');
    }
    if (user.pinResetRequired) {
        throw new ForbiddenException('Replace your temporary PIN before continuing');
    }
    const session = await tx.session.findFirst({
        where: { id: actor.sessionId, userId: actor.userId },
        select: { id: true, userId: true, createdAt: true, expiresAt: true, revokedAt: true },
    });
    const setting = await tx.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId: actor.tenantId, key: 'workspace_settings' } },
        select: { value: true },
    });
    const value = setting?.value;
    const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const raw = stored.security;
    const security = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const timeout = security.sessionTimeoutMinutes;
    const minutes = typeof timeout === 'number' && Number.isInteger(timeout)
        && timeout >= 5 && timeout <= 1440 ? timeout : 480;
    const expiresAtEpochMs = session && session.expiresAt instanceof Date && session.createdAt instanceof Date
        ? Math.min(session.expiresAt.getTime(), session.createdAt.getTime() + minutes * 60_000) : NaN;
    if (!session || session.id !== actor.sessionId || session.userId !== actor.userId
        || session.revokedAt || !Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= Date.now()) {
        throw new ForbiddenException('Administrator session is no longer active');
    }
    return Object.freeze({ actor, expiresAtEpochMs,
        requiresMfa: user.mfaEnabled === true || security.requireMfaForAll === true
            || [...permissions].some(key => PRIVILEGED_MFA_PERMISSION_KEYS.has(key)) });
}

export function assertCurrentMutationPolicy(
    policy: CurrentMutationPolicy,
    observation: MfaVerificationObservation | null,
): void {
    if (policy.expiresAtEpochMs <= Date.now()) {
        throw new ForbiddenException('Administrator session is no longer active');
    }
    if (policy.requiresMfa && !isCurrentMfaObservation(observation, {
        sub: policy.actor.userId, tenantId: policy.actor.tenantId, sessionId: policy.actor.sessionId,
    })) {
        throw new ForbiddenException('MFA verification required before continuing');
    }
}

/** Canonical trusted observer, called only after the preflight DB callback ends. */
export async function observeCurrentMutationMfa(
    policy: CurrentMutationPolicy,
    observer: MfaSessionObserver | undefined,
): Promise<MfaVerificationObservation | null> {
    if (!policy.requiresMfa) return null;
    if (!observer || typeof observer.observeSessionMfa !== 'function') {
        throw new ServiceUnavailableException('MFA verification service is unavailable');
    }
    try {
        const selected = Object.freeze({ sub: policy.actor.userId, tenantId: policy.actor.tenantId,
            sessionId: policy.actor.sessionId });
        const observation = await observer.observeSessionMfa(selected);
        return observation ? Object.freeze({ sub: observation.sub, tenantId: observation.tenantId,
            sessionId: observation.sessionId, expiresAtEpochMs: observation.expiresAtEpochMs,
            expiresAtMonotonicMs: observation.expiresAtMonotonicMs }) : null;
    } catch {
        throw new ServiceUnavailableException('MFA verification service is unavailable');
    }
}
