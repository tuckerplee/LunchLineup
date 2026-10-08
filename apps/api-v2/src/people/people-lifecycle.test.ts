import { performance } from 'node:perf_hooks';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { MfaSessionIdentity } from '@lunchlineup/rbac';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PeopleService } from './people.service';
import { authorizeMutation } from './access';

vi.mock('./access', async importOriginal => ({
  ...await importOriginal<typeof import('./access')>(), authorizeMutation: vi.fn(),
}));

function fixture(suspendedAt: Date | null = null) {
  const user = { id: 'employee-internal', tenantId: 'tenant', publicId: 'employee-public', name: 'Preserved Employee',
    email: 'employee@example.test', username: null, role: 'STAFF', pinHash: null, pinResetRequired: false,
    deletedAt: null, suspendedAt };
  const actor = { id: 'admin', tenantId: 'tenant', role: 'ADMIN', pinResetRequired: false,
    mfaEnabled: false, deletedAt: null, suspendedAt: null };
  const session = { id: 'session', userId: actor.id, createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => (
    Object.entries(where).every(([key, value]) => row[key] === value)
  );
  const tx = {
    user: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (
      [actor, user].find(row => matches(row, where)) ?? null
    )), findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if (!matches(user, where)) throw new Error('Unexpected lifecycle user selector');
      return user;
    }),
      update: vi.fn(async ({ data }) => { Object.assign(user, data); return user; }), count: vi.fn(async () => 1) },
    session: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (
      matches(session, where) ? session : null
    )), updateMany: vi.fn(async (_args: Prisma.SessionUpdateManyArgs) => ({ count: 1 })) },
    passwordResetToken: { updateMany: vi.fn() }, passwordResetEmailOutbox: { updateMany: vi.fn() },
    mfaTotpClaim: { deleteMany: vi.fn() },
    auditLog: { create: vi.fn() }, roleAssignment: { findMany: vi.fn(async () => []) },
    shift: { count: vi.fn(async () => 1), findMany: vi.fn(async () => [{ publicId: 'shift-public',
      startTime: new Date('2030-01-01T22:00:00Z'), endTime: new Date('2030-01-02T06:00:00Z'),
      location: { name: 'Kitchen', timezone: 'UTC' }, schedule: { status: 'PUBLISHED' } }]) },
    tenant: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (
      where.id === 'tenant' ? { id: 'tenant', planTier: 'FREE', status: 'ACTIVE', deletedAt: null, trialEndsAt: null } : null
    )) },
    tenantSetting: { findUnique: vi.fn(async ({ where }: {
      where: { tenantId_key: { tenantId: string; key: string } };
    }) => (where.tenantId_key.tenantId === 'tenant' && where.tenantId_key.key === 'workspace_settings'
      ? { value: { security: { requireMfaForAll: false, sessionTimeoutMinutes: 480 } } } : null)) },
    planDefinition: { findUnique: vi.fn(async () => ({ code: 'FREE', userLimit: 10 })) },
    $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => []),
  };
  vi.mocked(authorizeMutation).mockImplementation(async (_tx, selected, permission, options = {}) => {
    expect(selected).toMatchObject({ sub: actor.id, tenantId: 'tenant', sessionId: session.id });
    expect(permission).toBe('users:admin');
    if (options.targetUserId) expect(options.targetUserId).toBe(user.id);
    return { actor: { ...actor }, actorAccess: { isSystemAdmin: true, permissions: new Set(['users:admin']) },
      ...(options.targetUserId ? { target: { ...user }, targetAccess: { isSystemAdmin: false } } : {}) } as never;
  });
  let activeTransactions = 0;
  const service = new PeopleService({ withTenant: async (_tenant, work) => {
    activeTransactions += 1;
    try { return await work(tx as never); } finally { activeTransactions -= 1; }
  } }, {
    staffInvitationOutboxEnabled: false, staffInvitationOutboxEncryptionKey: '', staffInvitationMaxAttempts: 8,
  }, {
    // Explicit bounded synthetic marker for the privileged permission, independent of JWT flags.
    observeSessionMfa: vi.fn(async (selected: MfaSessionIdentity) => {
      expect(activeTransactions).toBe(0);
      expect(selected).toEqual({ sub: actor.id, tenantId: 'tenant', sessionId: session.id });
      return { ...selected, expiresAtEpochMs: Date.now() + 60_000,
        expiresAtMonotonicMs: performance.now() + 60_000 };
    }),
  });
  const identity: SessionIdentity = { sub: 'admin', publicUserId: 'admin-public', tenantId: 'tenant', sessionId: 'session',
    role: 'ADMIN', legacyRole: 'ADMIN', roles: [], permissions: ['users:admin'],
    mfaVerified: false, mfaRequired: false, pinResetRequired: false };
  return { service, tx, user, identity };
}

describe('reversible account state', () => {
  it('suspends without anonymizing identity or rewriting assignments and reports future work', async () => {
    const { service, tx, identity } = fixture();
    const response = await service.setSuspended(identity, 'employee-public', { suspended: true, expectedSuspendedAt: null });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'employee-internal' }, data: { suspendedAt: expect.any(Date) } });
    expect(response.user).toMatchObject({ name: 'Preserved Employee', email: 'employee@example.test', suspendedAt: expect.any(String) });
    expect(response.futureAssignments[0]).toMatchObject({ id: 'shift-public', scheduleStatus: 'PUBLISHED' });
    expect(tx.session.updateMany).toHaveBeenCalledWith({ where: { userId: 'employee-internal', revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'USER_SUSPENDED' }) }));
  });
  it('reactivates while revoking, never restoring, sessions', async () => {
    const timestamp = new Date('2026-09-09T12:00:00Z');
    const { service, tx, identity } = fixture(timestamp);
    expect((await service.setSuspended(identity, 'employee-public', { suspended: false, expectedSuspendedAt: timestamp.toISOString() })).user.suspendedAt).toBeNull();
    expect(tx.session.updateMany.mock.calls[0][0].data.revokedAt).toBeInstanceOf(Date);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'USER_REACTIVATED' }) }));
  });
  it('rejects stale reactivation without changing state or sessions', async () => {
    const { service, tx, identity } = fixture(new Date('2026-09-09T12:00:00Z'));
    await expect(service.setSuspended(identity, 'employee-public', { suspended: false, expectedSuspendedAt: null })).rejects.toMatchObject({ status: 409 });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.session.updateMany).not.toHaveBeenCalled();
  });
  it('replays an unchanged desired state without another audit or mutation', async () => {
    const { service, tx, identity } = fixture(new Date('2026-09-09T12:00:00Z'));
    await service.setSuspended(identity, 'employee-public', { suspended: true, expectedSuspendedAt: null });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
