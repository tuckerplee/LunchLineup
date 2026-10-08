import { performance } from 'node:perf_hooks';
import { expect, vi } from 'vitest';
import type { SessionIdentity } from '@lunchlineup/api-contract';

// Explicit source-test row model. Actual authorization executes; this does not
// simulate PostgreSQL locks, rollback, RLS, or a native MFA provider.
export function schedulingAuthority(transaction: any, identity: SessionIdentity) {
  const state = {
    tenant: { id: identity.tenantId, status: 'ACTIVE', deletedAt: null as Date | null },
    actor: { id: identity.sub, publicId: identity.publicUserId, tenantId: identity.tenantId,
      role: identity.legacyRole, name: 'Actor', username: 'actor', email: null,
      deletedAt: null as Date | null, suspendedAt: null as Date | null,
      lockedUntil: null, pinLockedUntil: null, pinResetRequired: false, mfaEnabled: true },
    session: { id: identity.sessionId, userId: identity.sub, createdAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 60000), revokedAt: null as Date | null },
    permissions: [...identity.permissions], legacyRole: identity.legacyRole,
    observed: undefined as (() => void) | undefined,
  };
  const role = () => ({ id: 'role-internal', publicId: '81000000-0000-4000-8000-000000000006',
    name: state.legacyRole, slug: 'fixture', isSystem: true, isDefault: false,
    description: null, legacyRole: state.legacyRole, deletedAt: null,
    rolePermissions: state.permissions.map(key => ({ permission: { key } })) });
  const original = transaction.$queryRaw;
  transaction.$queryRaw = vi.fn(async (query: any, ...args: any[]) => {
    const text = (Array.isArray(query) ? query : query.strings).join(' ');
    const values = Array.isArray(query) ? args : query.values;
    if (text.includes('FROM "Tenant"')) { expect(values).toEqual([identity.tenantId]); return [{ id: identity.tenantId }]; }
    if (text.includes('FROM "User"')) return [{ ...state.actor }];
    if (text.includes('FROM "Session"')) { expect(values).toEqual([identity.sessionId, identity.sub]); return [{ ...state.session }]; }
    if (text.includes('FROM "RolePermission"')) return [];
    if (text.includes('FROM "Role"')) return [{ id: 'role-internal' }];
    if (original) return original(query, ...args);
    throw new Error('Unmodeled SQL: ' + text);
  });
  transaction.tenant = { ...transaction.tenant, findUnique: vi.fn(async () => ({ ...state.tenant })) };
  transaction.user = { ...transaction.user, findFirst: vi.fn(async () => ({ ...state.actor })) };
  transaction.session = { findFirst: vi.fn(async () => ({ ...state.session })) };
  transaction.roleAssignment = { findMany: vi.fn(async () => [{ userId: identity.sub, roleId: 'role-internal' }]) };
  transaction.role = { findMany: vi.fn(async () => [role()]) };
  transaction.tenantSetting = { findUnique: vi.fn(async () => ({ value: { security: { requireMfaForAll: true, sessionTimeoutMinutes: 480 } } })) };
  let active = false;
  const database = { withTenant: vi.fn(async (tenantId: string, operation: (tx: any) => Promise<any>, options: any) => {
    expect(tenantId).toBe(identity.tenantId);
    expect(options).toEqual({ isolationLevel: 'ReadCommitted' });
    active = true;
    try { return await operation(transaction); } finally { active = false; }
  }) };
  const observer = { observeSessionMfa: vi.fn(async (selected: any) => {
    expect(active).toBe(false);
    expect(selected).toEqual({ sub: identity.sub, tenantId: identity.tenantId, sessionId: identity.sessionId });
    state.observed?.();
    return { ...selected, expiresAtEpochMs: Date.now() + 1000, expiresAtMonotonicMs: performance.now() + 60000 };
  }) };
  return { state, database, observer, transaction };
}
