import { afterEach, describe, expect, it, vi } from 'vitest';
import { payrollReadFixture, runPaused, ids, uuid, type Deadline, type ReadGate } from '../../../../tests/fixtures/payroll-export-read-authority';
import { ProblemError } from '../platform/problem';
import { PayrollService } from './payroll.service';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function owner(f: ReturnType<typeof payrollReadFixture>) { return new PayrollService(f.nativeDb, f.observer); }
const read = (f: ReturnType<typeof payrollReadFixture>, cursor?: string) => owner(f).getExport(f.identity, uuid(6), { lineLimit: '1', lineCursor: cursor });
const capture = <T>(p: Promise<T>) => p.then(value => ({ value, error: null }), error => ({ value: null, error }));
function populated(value: any, f: ReturnType<typeof payrollReadFixture>, second = false) {
  expect(value).toMatchObject({ id: uuid(6), periodId: uuid(4), formatVersion: 1, status: 'GENERATED',
    contentSha256: f.batch.contentSha256, rowCount: 2, totalPayableMinutes: 960,
    settlement: { consumedCredits: 1, newBalance: 9 }, downloadedAt: null, reconciledAt: null,
    reconciliation: { acceptedCount: 1, rejectedCount: 0, pendingCount: 1, providerTotalMinutes: 960,
      latestProvider: 'controlled-provider', latestProviderEventId: 'event-1', latestPayloadSha256: 'c'.repeat(64) } });
  const n = second ? 2 : 1;
  expect(value.lines).toEqual([{ id: uuid(30 + n), lineNumber: n, lockedEntryId: uuid(20 + n), employeeId: uuid(2),
    payableMinutes: 480, canonicalSha256: f.tables.payrollExportLine[n - 1].canonicalSha256,
    reconciliationStatus: second ? 'PENDING' : 'ACCEPTED', reconciliationReason: null }]);
  expect(value.createdAt).toBe('2026-05-09T12:00:00.000Z'); expect(value.updatedAt).toBe(value.createdAt);
  if (second) expect(value.nextLineCursor).toBeNull();
  else expect(JSON.parse(Buffer.from(value.nextLineCursor, 'base64url').toString())).toEqual({ publicId: uuid(31) });
}
function forbidden(error: unknown, mfa = false) {
  expect(error).toBeInstanceOf(ProblemError);
  expect(error).toMatchObject({ status: 403, code: mfa ? 'mfa_verification_required' : 'permission_denied' });
}

describe('Native populated payroll export current read authority', () => {
  for (const writer of ['session', 'grant'] as const) it(`refuses writer-first exact ${writer} revocation after released valid admission`, async () => {
    const f = payrollReadFixture('native'); await f.admit(); const before = f.financial(); f.writerFirst(writer);
    const result = await capture(read(f));
    f.assertClosed(before);
    if (result.value) populated(result.value, f);
    const countercheck = await f.checkWriterDenied(); f.assertClosed(before); forbidden(countercheck);
    expect(f.contexts.filter(c => c.phase === 'owner').length).toBeGreaterThan(0);
    forbidden(result.error);
  });
  for (const gate of ['page', 'final'] as ReadGate[]) for (const deadline of ['stored', 'policy', 'mfa-wall', 'mfa-monotonic'] as Deadline[]) {
    it(`refuses ${deadline} expiry across the actual ${gate} data await with no committed effects`, async () => {
      const f = payrollReadFixture('native', deadline); await f.admit(); const before = f.financial(); f.pause(gate);
      const result = await runPaused(f, () => read(f), true);
      f.assertClosed(before); if (result.value) populated(result.value, f);
      forbidden(result.error, deadline.startsWith('mfa'));
    });
    it(`returns populated data while ${deadline} remains current across the actual ${gate} await`, async () => {
      const f = payrollReadFixture('native', deadline); await f.admit(); const before = f.financial(); f.pause(gate);
      const result = await runPaused(f, () => read(f), false);
      f.assertClosed(before); expect(result.error).toBeNull(); populated(result.value, f);
    });
  }
  it('returns populated first and next pages with public identities and unchanged financial evidence', async () => {
    const f = payrollReadFixture('native'); await f.admit(); const before = f.financial();
    const first = await read(f); populated(first, f); const second = await read(f, first.nextLineCursor!); populated(second, f, true);
    f.assertClosed(before);
    expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'payrollExportLine' && r.args?.take === 5001)).toHaveLength(2);
  });
  it('refuses a populated export owned by another tenant without exposing its rows', async () => {
    const f = payrollReadFixture('native'); await f.admit(); f.batch.tenantId = 'other-tenant'; const before = f.financial();
    const result = await capture(read(f)); f.assertClosed(before);
    expect(result.error).toBeInstanceOf(ProblemError); expect(result.error).toMatchObject({ status: 404, code: 'payroll_export_not_found' });
    expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'payrollExportLine')).toEqual([]);
  });
  it('refuses an otherwise existing cursor belonging to another export batch', async () => {
    const f = payrollReadFixture('native'); await f.admit(); f.tables.payrollExportLine.push({ ...f.tables.payrollExportLine[0], id: 'foreign-line', publicId: uuid(99), batchId: 'foreign-batch' });
    const before = f.financial(); const cursor = Buffer.from(JSON.stringify({ publicId: uuid(99) })).toString('base64url');
    const result = await capture(read(f, cursor)); f.assertClosed(before);
    expect(result.error).toBeInstanceOf(ProblemError); expect(result.error).toMatchObject({ status: 422, code: 'invalid_payroll_line_cursor' });
  });
  it('refuses corrupted full-line canonical evidence beyond the requested page', async () => {
    const f = payrollReadFixture('native'); await f.admit(); f.tables.payrollExportLine[1].canonicalSha256 = 'd'.repeat(64); const before = f.financial();
    const result = await capture(read(f)); f.assertClosed(before);
    expect(f.reads.some(r => r.phase === 'owner' && r.table === 'timeCard')).toBe(true);
    expect(result.error).toBeInstanceOf(ProblemError); expect(result.error).toMatchObject({ status: 503, code: 'payroll_export_integrity_failed' });
  });
  const corruptions = {
    missing: (f: ReturnType<typeof payrollReadFixture>) => { f.tables.creditTransaction.length = 0; },
    tenant: (f: ReturnType<typeof payrollReadFixture>) => { f.tables.creditTransaction[0].tenantId = 'other-tenant'; },
    amount: (f: ReturnType<typeof payrollReadFixture>) => { f.tables.creditTransaction[0].amount = -2; },
    debt: (f: ReturnType<typeof payrollReadFixture>) => { f.tables.creditTransaction[0].debtAmount = 1; },
    reason: (f: ReturnType<typeof payrollReadFixture>) => { f.tables.creditTransaction[0].reason = 'Payroll export (other-period)'; },
    balance: (f: ReturnType<typeof payrollReadFixture>) => { f.tables.creditTransaction[0].balanceAfter = 8; },
  };
  for (const [corruption, change] of Object.entries(corruptions)) it(`refuses ${corruption} credit provenance before returning a correctly hashed populated export`, async () => {
    const f = payrollReadFixture('native'); await f.admit(); change(f); const before = f.financial();
    const result = await capture(read(f)); f.assertClosed(before); if (result.value) populated(result.value, f);
    // The original owner omits the ledger read altogether. Do not fabricate a
    // creditTransaction hit or infer that this HTTP read caused a debit.
    if (result.value) expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'creditTransaction')).toEqual([]);
    expect(result.error).toBeInstanceOf(ProblemError); expect(result.error).toMatchObject({ status: 503, code: 'payroll_export_integrity_failed' });
  });
});
