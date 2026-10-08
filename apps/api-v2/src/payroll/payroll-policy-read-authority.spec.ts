import { afterEach, describe, expect, it, vi } from 'vitest';
import { payrollPolicyReadFixture, runPolicyPaused, policyBounded, policyIds, policyUuid,
  type PolicyDeadline, type PolicyGate, type PolicyWriter } from '../../../../tests/fixtures/payroll-policy-read-authority';
import { PayrollService } from './payroll.service';
import { ProblemError } from '../platform/problem';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
type Method = 'list' | 'latest';
const methods: Method[] = ['list', 'latest'];
const writers: PolicyWriter[] = ['session', 'grant', 'account', 'pin', 'policy', 'tenant', 'role'];
const deadlines: PolicyDeadline[] = ['stored', 'policy', 'mfa-wall', 'mfa-monotonic'];
const gates: PolicyGate[] = ['row', 'creator'];
function read(f: ReturnType<typeof payrollPolicyReadFixture>, method: 'list', cursor?: string): ReturnType<PayrollService['listPolicies']>;
function read(f: ReturnType<typeof payrollPolicyReadFixture>, method: 'latest', cursor?: string): ReturnType<PayrollService['latestPolicy']>;
function read(f: ReturnType<typeof payrollPolicyReadFixture>, method: Method, cursor?: string): Promise<Awaited<ReturnType<PayrollService['listPolicies']>> | Awaited<ReturnType<PayrollService['latestPolicy']>>>;
function read(f: ReturnType<typeof payrollPolicyReadFixture>, method: Method, cursor?: string) {
  const owner = new PayrollService(f.nativeDb, f.observer);
  return method === 'latest' ? owner.latestPolicy(f.identity) : owner.listPolicies(f.identity, { limit: '2', cursor });
}
const capture = <T>(p: Promise<T>) => p.then(value => ({ value, error: null }), error => ({ value: null, error }));
function populated(value: any, method: Method, second = false) {
  const expected = (version: number) => ({ id: policyUuid(10 + version), version, timeZone: 'UTC', cadence: 'WEEKLY',
    anchorDate: '2026-01-01', effectiveFrom: ['2026-02-05', '2026-03-05', '2026-04-02'][version - 1], createdByUserId: policyUuid(2),
    createdAt: `2026-0${version}-01T12:00:00.000Z` });
  expect(value.data).toEqual(method === 'latest' ? expected(3) : (second ? [expected(1)] : [expected(3), expected(2)]));
  if (method === 'list') {
    if (second) expect(value.nextCursor).toBeNull();
    else expect(JSON.parse(Buffer.from(value.nextCursor, 'base64url').toString())).toEqual({ version: 2, publicId: policyUuid(12) });
  }
  const serialized = JSON.stringify(value);
  for (const internal of [policyIds.tenant, policyIds.actor, policyIds.session, policyIds.creator, 'foreign-policy', 'foreign-tenant']) expect(serialized).not.toContain(internal);
}
function forbidden(error: unknown, mfa = false) {
  expect(error).toBeInstanceOf(ProblemError); expect((error as ProblemError).status).toBe(403);
  if (mfa) expect((error as ProblemError).code).toBe('mfa_verification_required');
}

describe('native payroll policy protected read authority', () => {
  for (const method of methods) for (const writer of writers) it(`${method} refuses writer-first ${writer} after released valid admission`, async () => {
    const f = payrollPolicyReadFixture('native');
    if (writer === 'policy') f.tables.session[0].createdAt = new Date(Date.now() - 300_000);
    await f.admit(); const before = f.rowsBefore(); f.writerFirst(writer);
    const result = await capture(read(f, method)); f.assertClosed(before);
    if (result.value) populated(result.value, method);
    forbidden(await f.checkWriterDenied()); f.assertClosed(before); forbidden(result.error);
    expect(result.value).toBeNull();
  });
  for (const method of methods) for (const at of gates) for (const deadline of deadlines) {
    it(`${method} refuses ${deadline} expiry across actual ${at} await without protected result or policy write`, async () => {
      const f = payrollPolicyReadFixture('native', deadline); await f.admit(); const before = f.rowsBefore(); f.pause(at);
      const result = await runPolicyPaused(f, () => read(f, method), true); f.assertClosed(before);
      if (result.value) populated(result.value, method);
      forbidden(result.error, deadline.startsWith('mfa')); expect(result.value).toBeNull();
    });
    it(`${method} returns populated policies while ${deadline} remains current across ${at}`, async () => {
      const f = payrollPolicyReadFixture('native', deadline); await f.admit(); const before = f.rowsBefore(); f.pause(at);
      const result = await runPolicyPaused(f, () => read(f, method), false); f.assertClosed(before);
      expect(result.error).toBeNull(); populated(result.value, method);
      // Domain controls are not failed solely because the original owner has no new proof protocol.
      expect(f.observations.filter(o => o.phase === 'owner').length).toBeLessThanOrEqual(1);
    });
  }
  it('returns the complete two-page native cursor inventory and latest policy for an inactive historical creator', async () => {
    const f = payrollPolicyReadFixture('native'); await f.admit(); const before = f.rowsBefore();
    const first = await read(f, 'list'); populated(first, 'list');
    const next = await read(f, 'list', first.nextCursor!); populated(next, 'list', true);
    populated(await read(f, 'latest'), 'latest'); f.assertClosed(before);
    expect(f.tables.user.find(u => u.id === policyIds.creator)?.deletedAt).toBeInstanceOf(Date);
    expect(f.reads.some(r => r.phase === 'owner' && r.table === 'payrollPolicyVersion' && r.args.where.OR)).toBe(true);
  });
  for (const method of methods) it(`${method} preserves the authorized empty policy response`, async () => {
    const f = payrollPolicyReadFixture('native'); f.tables.payrollPolicyVersion = f.tables.payrollPolicyVersion.filter(r => r.tenantId !== policyIds.tenant);
    await f.admit(); const before = f.rowsBefore(); const value = await read(f, method); f.assertClosed(before);
    expect(value).toEqual(method === 'latest' ? { data: null } : { data: [], nextCursor: null });
    expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'user' && r.method === 'findMany')).toEqual([]);
  });
  for (const bad of ['limit', 'cursor'] as const) it(`preserves native invalid ${bad} refusal without policy reads`, async () => {
    const f = payrollPolicyReadFixture('native'); await f.admit(); const before = f.rowsBefore();
    const result = await capture(new PayrollService(f.nativeDb, f.observer).listPolicies(f.identity,
      bad === 'limit' ? { limit: '0' } : { limit: '2', cursor: 'not-a-json-cursor' }));
    f.assertClosed(before); expect(result.error).toBeInstanceOf(ProblemError); expect((result.error as ProblemError).status).toBe(422);
    expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'payrollPolicyVersion')).toEqual([]);
  });
  it('preserves missing creator-reference failure instead of exposing a stored staff ID', async () => {
    const f = payrollPolicyReadFixture('native'); f.tables.user = f.tables.user.filter(u => u.id !== policyIds.creator);
    await f.admit(); const before = f.rowsBefore(); const result = await capture(read(f, 'latest')); f.assertClosed(before);
    expect(result.error).toBeInstanceOf(ProblemError); expect(result.error).toMatchObject({ status: 503, code: 'payroll_reference_integrity_failed' });
    expect(result.value).toBeNull();
  });
  it('keeps one bounded privileged proof and exact actor locks when the caller changes the actor object during first owner context wait', async () => {
    const f = payrollPolicyReadFixture('native'); await f.admit(); const before = f.rowsBefore(); f.pauseEntry();
    const result = capture(read(f, 'latest'));
    try {
      expect(await policyBounded(Promise.race([f.arrived.then(() => 'entered'), result.then(() => 'settled')]))).toBe('entered');
      f.identity.sub = 'new-caller'; f.identity.sessionId = 'new-session'; f.identity.permissions = [];
    } finally { f.release(); await policyBounded(result); }
    const finished = await result; expect(finished.error).toBeNull(); populated(finished.value, 'latest'); f.assertClosed(before);
    expect(f.observations.filter(o => o.phase === 'owner')).toEqual([{ phase: 'owner', selected: {
      sub: policyIds.actor, tenantId: policyIds.tenant, sessionId: policyIds.session } }]);
    const ownerContexts = f.contexts.filter(c => c.phase === 'owner'); expect(ownerContexts).toHaveLength(2);
    const locks = f.reads.filter(r => r.phase === 'owner' && r.ordinal === ownerContexts[1].ordinal && r.table === '$raw' && r.text.endsWith('FOR UPDATE'));
    expect(locks.map(r => /FROM "([^"]+)"/.exec(r.text)?.[1])).toEqual(['Tenant', 'User', 'Session', 'Role', 'RolePermission']);
    expect(locks.find(r => r.text.includes('FROM "Session"'))?.values).toEqual([policyIds.session, policyIds.actor]);
  });
});
