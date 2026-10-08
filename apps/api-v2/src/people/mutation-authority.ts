import type { SessionIdentity } from '@lunchlineup/api-contract';
import { isCurrentMfaObservation, PRIVILEGED_MFA_PERMISSION_KEYS, type MfaSessionIdentity,
  type MfaVerificationObservation } from '@lunchlineup/rbac';
import type { TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';
import { authorizeMutation, type MutationAuthority } from './access';

export type CurrentMutationAuthority = MutationAuthority & {
  identity: MfaSessionIdentity;
  expiresAtEpochMs: number;
  requiresMfa: boolean;
};

export function mutationIdentity(identity: SessionIdentity): SessionIdentity {
  return Object.freeze({ ...identity, sub: identity.sub.trim(), tenantId: identity.tenantId.trim(),
    sessionId: identity.sessionId.trim(), roles: identity.roles.map(role => ({ ...role })),
    permissions: [...identity.permissions] });
}

function forbidden(detail: string, code = 'permission_denied'): ProblemError {
  return new ProblemError(403, code, detail, 'Forbidden');
}

/** Explicit current-policy extension; the older helper's other callers keep their contract. */
export async function authorizeCurrentMutation(
  transaction: TenantTransaction,
  identity: SessionIdentity,
  permission: string,
  options: Parameters<typeof authorizeMutation>[3] & { allowPinRecovery?: boolean } = {},
): Promise<CurrentMutationAuthority> {
  const authority = await authorizeMutation(transaction, identity, permission, options);
  const tenant = await transaction.tenant.findUnique({
    where: { id: identity.tenantId }, select: { status: true, deletedAt: true },
  });
  if (!tenant || tenant.deletedAt || tenant.status === 'SUSPENDED' || tenant.status === 'PURGED') {
    throw forbidden('The workspace is no longer active.');
  }
  const user = await transaction.user.findFirst({
    where: { id: authority.actor.id, tenantId: identity.tenantId, deletedAt: null, suspendedAt: null },
    select: { id: true, tenantId: true, pinResetRequired: true, mfaEnabled: true },
  });
  if (!user || user.id !== identity.sub || user.tenantId !== identity.tenantId) {
    throw forbidden('Administrator account is inactive.');
  }
  const pinRecovery = options.allowPinRecovery === true && permission === 'auth:login_pin'
    && user.pinResetRequired === true;
  if (user.pinResetRequired && !pinRecovery) {
    throw forbidden('Replace your temporary PIN before continuing.', 'pin_rotation_required');
  }
  const session = await transaction.session.findFirst({
    where: { id: identity.sessionId, userId: authority.actor.id },
    select: { id: true, userId: true, createdAt: true, expiresAt: true, revokedAt: true },
  });
  const setting = await transaction.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId: identity.tenantId, key: 'workspace_settings' } }, select: { value: true },
  });
  const value = setting?.value;
  const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const raw = stored.security;
  const security = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const timeout = security.sessionTimeoutMinutes;
  const minutes = typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 5 && timeout <= 1440
    ? timeout : 480;
  const expiresAtEpochMs = session ? Math.min(session.expiresAt.getTime(), session.createdAt.getTime() + minutes * 60_000) : NaN;
  if (!session || session.id !== identity.sessionId || session.userId !== authority.actor.id || session.revokedAt
    || !Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= Date.now()) {
    throw forbidden('Administrator session is no longer active.');
  }
  return { ...authority, identity: Object.freeze({ sub: authority.actor.id, tenantId: identity.tenantId,
    sessionId: session.id }), expiresAtEpochMs,
    requiresMfa: !pinRecovery && (user.mfaEnabled === true || security.requireMfaForAll === true
      || [...authority.actorAccess.permissions].some(key => PRIVILEGED_MFA_PERMISSION_KEYS.has(key))) };
}

/** Process-local decision, repeated after domain waits and before state effects. */
export function assertCurrentMutation(
  authority: CurrentMutationAuthority,
  observation: MfaVerificationObservation | null,
): void {
  if (authority.expiresAtEpochMs <= Date.now()) throw forbidden('Administrator session is no longer active.');
  if (authority.requiresMfa && !isCurrentMfaObservation(observation, authority.identity)) {
    throw forbidden('MFA verification required before continuing.', 'mfa_verification_required');
  }
}
