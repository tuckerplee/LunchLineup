import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { payrollReadFixture, runPaused, ids, type Deadline, type ReadGate } from '../../../../tests/fixtures/payroll-export-read-authority';
import { PayrollReadService } from './payroll-read.service';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function owner(f: ReturnType<typeof payrollReadFixture>): PayrollReadService {
  // Actual original owner accepts only tenantDb and ignores the proposed trusted
  // constructor dependencies. No authorization result is substituted.
  return Reflect.construct(PayrollReadService, [f.tenantDb, f.rbac, f.observer]) as PayrollReadService;
}
const read = (f: ReturnType<typeof payrollReadFixture>, cursor?: string) => owner(f).getExport(f.actor, ids.batch, 1, cursor);
const capture = <T>(p: Promise<T>) => p.then(value => ({ value, error: null }), error => ({ value: null, error }));
function populated(value: any, f: ReturnType<typeof payrollReadFixture>, second = false) {
  expect(value).toMatchObject({ id: ids.batch, tenantId: ids.tenant, periodId: ids.period, formatVersion: 1, status: 'GENERATED',
    contentSha256: f.batch.contentSha256, rowCount: 2, totalPayableMinutes: 960,
    settlement: { consumedCredits: 1, newBalance: 9 }, downloadedAt: null, reconciledAt: null,
    reconciliation: { acceptedCount: 1, rejectedCount: 0, pendingCount: 1, providerTotalMinutes: 960,
      latestProvider: 'controlled-provider', latestProviderEventId: 'event-1', latestPayloadSha256: 'c'.repeat(64) } });
  const n = second ? 2 : 1;
  expect(value.lines).toEqual([{ id: `line-${n}`, lineNumber: n, lockedEntryId: `locked-${n}`, employeeId: ids.employee,
    payableMinutes: 480, canonicalSha256: f.tables.payrollExportLine[n - 1].canonicalSha256,
    reconciliationStatus: second ? 'PENDING' : 'ACCEPTED', reconciliationReason: null }]);
  expect(value.createdAt).toBe('2026-05-09T12:00:00.000Z'); expect(value.updatedAt).toBe(value.createdAt);
  expect(value.nextLineCursor).toBe(second ? null : 'line-1');
}
function forbidden(error: unknown, mfa = false) {
  expect(error).toBeInstanceOf(ForbiddenException);
  expect((error as Error).message).toMatch(mfa ? /MFA verification required/ : /session is no longer active|permission is no longer active/);
}

describe('Retained populated payroll export current read authority', () => {
  for (const writer of ['session', 'grant'] as const) it(`refuses writer-first exact ${writer} revocation after released valid admission`, async () => {
    const f = payrollReadFixture('retained'); await f.admit(); const before = f.financial(); f.writerFirst(writer);
    const result = await capture(read(f)); f.assertClosed(before); if (result.value) populated(result.value, f);
    const countercheck = await f.checkWriterDenied(); f.assertClosed(before); forbidden(countercheck);
    expect(f.contexts.filter(c => c.phase === 'owner').length).toBeGreaterThan(0);
    forbidden(result.error);
  });
  for (const gate of ['page', 'final'] as ReadGate[]) for (const deadline of ['stored', 'policy', 'mfa-wall', 'mfa-monotonic'] as Deadline[]) {
    it(`refuses ${deadline} expiry across the actual ${gate} data await with no committed effects`, async () => {
      const f = payrollReadFixture('retained', deadline); await f.admit(); const before = f.financial(); f.pause(gate);
      const result = await runPaused(f, () => read(f), true);
      f.assertClosed(before); if (result.value) populated(result.value, f);
      forbidden(result.error, deadline.startsWith('mfa'));
    });
    it(`returns populated data while ${deadline} remains current across the actual ${gate} await`, async () => {
      const f = payrollReadFixture('retained', deadline); await f.admit(); const before = f.financial(); f.pause(gate);
      const result = await runPaused(f, () => read(f), false);
      f.assertClosed(before); expect(result.error).toBeNull(); populated(result.value, f);
    });
  }
  it('returns populated first and next pages with private identities and unchanged financial evidence', async () => {
    const f = payrollReadFixture('retained'); await f.admit(); const before = f.financial();
    const first = await read(f); populated(first, f); const second = await read(f, first.nextLineCursor!); populated(second, f, true);
    f.assertClosed(before);
    expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'payrollExportLine' && r.method === 'findMany')).toHaveLength(2);
  });
  it('refuses a populated export owned by another tenant without exposing its rows', async () => {
    const f = payrollReadFixture('retained'); await f.admit(); f.batch.tenantId = 'other-tenant'; const before = f.financial();
    const result = await capture(read(f)); f.assertClosed(before); expect(result.error).toBeInstanceOf(NotFoundException);
    expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'payrollExportLine')).toEqual([]);
  });
  it('refuses an otherwise existing cursor belonging to another export batch', async () => {
    const f = payrollReadFixture('retained'); await f.admit(); f.tables.payrollExportLine.push({ ...f.tables.payrollExportLine[0], id: 'foreign-line', batchId: 'foreign-batch' });
    const before = f.financial(); const result = await capture(read(f, 'foreign-line')); f.assertClosed(before);
    expect(result.error).toBeInstanceOf(BadRequestException); expect((result.error as Error).message).toContain('lineCursor is invalid');
  });
  it('refuses reconciliation counts exceeding the immutable export row count', async () => {
    const f = payrollReadFixture('retained'); await f.admit();
    f.tables.payrollReconciliationLineState.push({ ...f.tables.payrollReconciliationLineState[0], lineId: 'line-2' },
      { ...f.tables.payrollReconciliationLineState[0], lineId: 'corrupt-third-state' });
    const before = f.financial(); const result = await capture(read(f)); f.assertClosed(before);
    expect(result.error).toBeInstanceOf(ConflictException); expect((result.error as Error).message).toContain('counts are invalid');
    expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'payrollReconciliationReceipt')).toEqual([]);
  });
});
