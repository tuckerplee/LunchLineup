import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { RbacService } from '../auth/rbac.service';
import { installPlatformTenantAuthorityModel } from './platform-tenant-lifecycle-authority.fixture';
import { withCustomerLifecycleAdmission } from './customer-lifecycle-authority';
const actor = { tenantId: 'customer-tenant', userId: 'customer-user', sessionId: 'customer-session' };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T12:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
// Executes actual admission and RBAC with live modeled actor/session, finite
// MFA and transaction-private effects. Does not prove native SQL/Redis locks.
function fixture(stage: 'domain' | 'write' = 'domain') {
  let active = 0; const committed: unknown[] = []; let staged: unknown[] = [];
  const entered = gate(), release = gate();
  const tx: any = { tenant: { findUnique: vi.fn() }, $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async () => []) };
  const state = installPlatformTenantAuthorityModel(tx, actor); state.permissions = ['tenant_account:lifecycle'];
  const observer = state.observer;
  const observe = observer.observeSessionMfa.getMockImplementation()!;
  observer.observeSessionMfa.mockImplementation(async identity => { expect(active).toBe(0); return observe(identity); });
  tx.$transaction = vi.fn(async (callback: (transaction: any) => Promise<unknown>) => {
    expect(active).toBe(0); active++; staged = [];
    try { const result = await callback(tx); committed.push(...staged); return result; } finally { active--; }
  });
  const database = new TenantPrismaService(tx); const rbac = new RbacService(database);
  const operation = vi.fn(async (_tx: any, assertCurrent: () => void) => {
    staged.push({ requestId: 'request-1', state: 'PENDING' });
    if (stage === 'write') { entered.resolve(); await release.promise; }
    assertCurrent(); return 'admitted';
  });
  const domain = vi.fn(async () => { if (stage === 'domain') { entered.resolve(); await release.promise; } });
  return { tx, state, observer, committed, entered, release, operation, domain,
    call: (observation: any = observer) => withCustomerLifecycleAdmission(database, rbac, observation, actor, operation, domain) };
}
async function across(h: ReturnType<typeof fixture>, change: () => void) {
  const pending = h.call().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  try { expect(await Promise.race([h.entered.promise.then(() => 'arrived'), pending.then(() => 'settled')])).toBe('arrived'); change(); h.release.resolve(); return await pending; }
  finally { h.release.resolve(); await pending; }
}
describe('customer lifecycle actual current-authority owner', () => {
  it.each(['revoked', 'expired', 'grant-lost', 'suspended', 'locked', 'pin-required', 'tenant-suspended', 'policy-shortened'] as const)('refuses %s changed during domain wait without request effects', async mode => {
    const h = fixture(); const result = await across(h, () => {
      if (mode === 'revoked') h.state.session.revokedAt = new Date();
      if (mode === 'expired') h.state.session.expiresAt = new Date();
      if (mode === 'grant-lost') h.state.permissions = [];
      if (mode === 'suspended') h.state.actor.suspendedAt = new Date();
      if (mode === 'locked') h.state.actor.lockedUntil = new Date(Date.now() + 60_000);
      if (mode === 'pin-required') h.state.actor.pinResetRequired = true;
      if (mode === 'tenant-suspended') h.state.workspace.status = 'SUSPENDED';
      if (mode === 'policy-shortened') { h.state.security.sessionTimeoutMinutes = 5; h.state.session.createdAt = new Date(Date.now() - 6 * 60_000); }
    });
    expect(result.error).toBeDefined(); expect(result.value).toBeUndefined(); expect(h.operation).not.toHaveBeenCalled(); expect(h.committed).toEqual([]);
  });
  it.each(['domain', 'write'] as const)('refuses finite MFA equality expiry after %s wait and rolls back staged request', async stage => {
    const h = fixture(stage); const result = await across(h, () => vi.setSystemTime(Date.now() + 120_000));
    expect(result.error).toBeDefined(); expect(h.committed).toEqual([]);
    expect(h.operation).toHaveBeenCalledTimes(stage === 'write' ? 1 : 0);
  });
  it('uses a real modeled live session and finite observation to admit exactly one request', async () => {
    const h = fixture(); const result = await across(h, () => {});
    expect(result.error).toBeUndefined(); expect(result.value).toBe('admitted');
    expect(h.committed).toEqual([{ requestId: 'request-1', state: 'PENDING' }]);
    expect(h.observer.observeSessionMfa).toHaveBeenCalledTimes(1);
    expect(h.observer.observeSessionMfa).toHaveBeenCalledWith({ sub: actor.userId, tenantId: actor.tenantId, sessionId: actor.sessionId });
  });
  it('fails closed on an unavailable MFA observer before any domain operation', async () => {
    const h = fixture(); await expect(h.call({ observeSessionMfa: vi.fn().mockRejectedValue(new Error('controlled MFA outage')) })).rejects.toThrow();
    expect(h.domain).not.toHaveBeenCalled(); expect(h.operation).not.toHaveBeenCalled(); expect(h.committed).toEqual([]);
  });
});
