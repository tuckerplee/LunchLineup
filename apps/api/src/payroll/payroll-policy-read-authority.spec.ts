import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { payrollPolicyReadFixture, runPolicyPaused, policyIds,
  type PolicyDeadline, type PolicyWriter } from '../../../../tests/fixtures/payroll-policy-read-authority';
import { PayrollPolicyService } from './payroll-policy.service';
import { PayrollController } from './payroll.controller';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
type Method = 'list' | 'latest';
const methods: Method[] = ['list', 'latest'];
const writers: PolicyWriter[] = ['session', 'grant', 'account', 'pin', 'policy', 'tenant', 'role'];
const deadlines: PolicyDeadline[] = ['stored', 'policy', 'mfa-wall', 'mfa-monotonic'];
function owner(f: ReturnType<typeof payrollPolicyReadFixture>) { return new PayrollPolicyService(f.tenantDb, f.rbac, f.observer as any); }
function read(f: ReturnType<typeof payrollPolicyReadFixture>, method: 'list', cursor?: string): ReturnType<PayrollPolicyService['list']>;
function read(f: ReturnType<typeof payrollPolicyReadFixture>, method: 'latest', cursor?: string): ReturnType<PayrollPolicyService['latest']>;
function read(f: ReturnType<typeof payrollPolicyReadFixture>, method: Method, cursor?: string): Promise<Awaited<ReturnType<PayrollPolicyService['list']>> | Awaited<ReturnType<PayrollPolicyService['latest']>>>;
function read(f: ReturnType<typeof payrollPolicyReadFixture>, method: Method, cursor?: string) {
  const controller = new PayrollController(owner(f), {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const request = { user: { sub: f.actor.userId, tenantId: f.actor.tenantId, sessionId: f.actor.sessionId } };
  return method === 'latest' ? controller.getPolicy(request) : controller.listPolicies(request, '2', cursor);
}
const capture = <T>(p: Promise<T>) => p.then(value => ({ value, error: null }), error => ({ value: null, error }));
function populated(value: any, method: Method, second = false) {
  const expected = (version: number) => ({ id: `policy-${version}`, tenantId: policyIds.tenant, version, timeZone: 'UTC', cadence: 'WEEKLY',
    anchorDate: '2026-01-01', effectiveFrom: ['2026-02-05', '2026-03-05', '2026-04-02'][version - 1], createdByUserId: policyIds.creator,
    createdAt: `2026-0${version}-01T12:00:00.000Z` });
  expect(value.data).toEqual(method === 'latest' ? expected(3) : (second ? [expected(1)] : [expected(3), expected(2)]));
  if (method === 'list') expect(value.nextCursor).toBe(second ? null : 'policy-2');
  expect(JSON.stringify(value)).not.toContain('foreign-policy'); expect(JSON.stringify(value)).not.toContain('foreign-tenant');
}
function forbidden(error: unknown, mfa = false) {
  expect(error).toBeInstanceOf(ForbiddenException);
  if (mfa) expect((error as Error).message).toContain('MFA verification required');
}

describe('retained payroll policy protected read authority', () => {
  for (const method of methods) for (const writer of writers) it(`${method} refuses writer-first ${writer} after released valid admission`, async () => {
    const f = payrollPolicyReadFixture('retained');
    if (writer === 'policy') f.tables.session[0].createdAt = new Date(Date.now() - 300_000);
    await f.admit(); const before = f.rowsBefore(); f.writerFirst(writer);
    const result = await capture(read(f, method)); f.assertClosed(before);
    if (result.value) populated(result.value, method);
    forbidden(await f.checkWriterDenied()); f.assertClosed(before); forbidden(result.error); expect(result.value).toBeNull();
  });
  for (const method of methods) for (const deadline of deadlines) {
    it(`${method} refuses ${deadline} expiry across the actual policy row await without response or writes`, async () => {
      const f = payrollPolicyReadFixture('retained', deadline); await f.admit(); const before = f.rowsBefore(); f.pause('row');
      const result = await runPolicyPaused(f, () => read(f, method), true); f.assertClosed(before);
      if (result.value) populated(result.value, method);
      forbidden(result.error, deadline.startsWith('mfa')); expect(result.value).toBeNull();
    });
    it(`${method} returns populated policies while ${deadline} remains current across the actual row await`, async () => {
      const f = payrollPolicyReadFixture('retained', deadline); await f.admit(); const before = f.rowsBefore(); f.pause('row');
      const result = await runPolicyPaused(f, () => read(f, method), false); f.assertClosed(before);
      expect(result.error).toBeNull(); populated(result.value, method);
      expect(f.observations.filter(o => o.phase === 'owner').length).toBeLessThanOrEqual(1);
    });
  }
  it('returns the complete two-page private cursor inventory and latest policy without reauthorizing historical creators', async () => {
    const f = payrollPolicyReadFixture('retained'); await f.admit(); const before = f.rowsBefore();
    const first = await read(f, 'list'); populated(first, 'list');
    populated(await read(f, 'list', first.nextCursor!), 'list', true); populated(await read(f, 'latest'), 'latest'); f.assertClosed(before);
    expect(f.reads.some(r => r.phase === 'owner' && r.table === 'payrollPolicyVersion' && r.args.cursor?.id === 'policy-2' && r.args.skip === 1)).toBe(true);
  });
  for (const method of methods) it(`${method} preserves the authorized empty policy response`, async () => {
    const f = payrollPolicyReadFixture('retained'); f.tables.payrollPolicyVersion = f.tables.payrollPolicyVersion.filter(r => r.tenantId !== policyIds.tenant);
    await f.admit(); const before = f.rowsBefore(); const value = await read(f, method); f.assertClosed(before);
    expect(value).toEqual(method === 'latest' ? { data: null } : { data: [], nextCursor: null });
  });
  for (const bad of ['limit', 'cursor'] as const) it(`preserves retained invalid ${bad} refusal without policy reads`, async () => {
    const f = payrollPolicyReadFixture('retained'); await f.admit(); const before = f.rowsBefore();
    const result = await capture(owner(f).list(f.actor, bad === 'limit' ? '0' : '2', bad === 'cursor' ? ' ' : undefined));
    f.assertClosed(before); expect(result.error).toBeInstanceOf(BadRequestException);
    expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'payrollPolicyVersion')).toEqual([]);
  });
  it('uses one bounded payroll:read proof and ordered current actor fences for a populated custom-role read', async () => {
    const f = payrollPolicyReadFixture('retained'); await f.admit(); const before = f.rowsBefore();
    populated(await read(f, 'latest'), 'latest'); f.assertClosed(before);
    expect(f.observations.filter(o => o.phase === 'owner')).toEqual([{ phase: 'owner', selected: {
      sub: policyIds.actor, tenantId: policyIds.tenant, sessionId: policyIds.session } }]);
    const ownerContexts = f.contexts.filter(c => c.phase === 'owner'); expect(ownerContexts).toHaveLength(2);
    const locks = f.reads.filter(r => r.phase === 'owner' && r.ordinal === ownerContexts[1].ordinal && r.table === '$raw' && r.text.endsWith('FOR UPDATE'));
    expect(locks.map(r => /FROM "([^"]+)"/.exec(r.text)?.[1])).toEqual(['Tenant', 'User', 'Session', 'RoleAssignment', 'Role', 'RolePermission']);
    expect(locks.find(r => r.text.includes('FROM "Session"'))?.values).toEqual([policyIds.session, policyIds.actor]);
  });
});
