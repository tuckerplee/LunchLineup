import { afterEach, describe, expect, it, vi } from 'vitest';
import { payrollPeriodReadFixture, runPeriodPaused, periodBounded, periodIds, periodUuid,
  type PeriodDeadline, type PeriodGate, type PeriodWriter } from '../../../../tests/fixtures/payroll-period-read-authority';
import { PayrollService } from './payroll.service';
import { ProblemError } from '../platform/problem';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
type Method = 'list' | 'detail';
const methods: Method[] = ['list', 'detail'];
const writers: PeriodWriter[] = ['session', 'grant', 'account', 'pin', 'policy', 'tenant', 'role'];
const deadlines: PeriodDeadline[] = ['stored', 'policy', 'mfa-wall', 'mfa-monotonic'];
const capture = <T>(p: Promise<T>) => p.then(value => ({ value, error: null }), error => ({ value: null, error }));
type Fixture = ReturnType<typeof payrollPeriodReadFixture>;
function owner(f: Fixture) { return new PayrollService(f.nativeDb, f.observer); }
function listNext(f: Fixture, cursor?: string) { return owner(f).listPeriods(f.identity, { limit: '2', cursor }); }
function detail(f: Fixture, n: number, cardLimit = '1', cardCursor?: string, lineLimit = '1', lineCursor?: string) {
  return owner(f).getPeriod(f.identity, periodUuid(20 + n), { cardLimit, cardCursor, lineLimit, lineCursor });
}
function read(f: Fixture, method: 'list'): ReturnType<PayrollService['listPeriods']>;
function read(f: Fixture, method: 'detail'): ReturnType<PayrollService['getPeriod']>;
function read(f: Fixture, method: Method): Promise<Awaited<ReturnType<PayrollService['listPeriods']>> | Awaited<ReturnType<PayrollService['getPeriod']>>>;
function read(f: Fixture, method: Method) { return method === 'list' ? listNext(f) : detail(f, 2); }
function missing(f: Fixture, target: 'missing' | 'foreign') { return owner(f).getPeriod(f.identity, periodUuid(target === 'foreign' ? 99 : 98), {}); }
function invalid(f: Fixture, bad: string): Promise<Awaited<ReturnType<PayrollService['listPeriods']>> | Awaited<ReturnType<PayrollService['getPeriod']>>> {
  if (bad.startsWith('list')) return owner(f).listPeriods(f.identity, bad === 'list-bound' ? { limit: '0' } : { cursor: 'not-json' });
  const key = ({ 'card-bound': 'cardLimit', 'card-cursor': 'cardCursor', 'line-bound': 'lineLimit', 'line-cursor': 'lineCursor' } as Record<string, string>)[bad];
  return owner(f).getPeriod(f.identity, periodUuid(22), { [key]: bad.endsWith('bound') ? '0' : 'not-json' });
}
const native = true;
const ownId = (kind: 'period' | 'card' | 'entry' | 'line' | 'amendment', n: number) => native
  ? periodUuid(({ period: 20, card: 30, entry: 40, line: 60, amendment: 50 })[kind] + n) : `${kind}-${n}`;
const staff = () => native ? periodUuid(2) : periodIds.creator;
function summary(n: number) {
  return { cardCount: n === 3 ? 0 : 2, closedCardCount: n === 3 ? 0 : 2, approvedCardCount: n === 1 ? 1 : 0,
    rejectedCardCount: 0, pendingCardCount: n === 1 ? 1 : n === 2 ? 2 : 0, amendmentCount: n === 3 ? 1 : 0,
    pendingAmendmentCount: 0, approvedAmendmentCount: n === 3 ? 1 : 0, lockedEntryCount: n === 2 ? 2 : 0 };
}
function expectedPeriod(n: number, exportBatch: unknown = null, detail = false, f?: Fixture) {
  const day = ['2026-08-13', '2026-07-30', '2026-08-06'][n - 1], end = ['2026-08-20', '2026-08-06', '2026-08-13'][n - 1];
  return { id: ownId('period', n), ...(native ? {} : { tenantId: periodIds.tenant }),
    policyVersionId: native ? periodUuid(13) : 'policy-3', localStartDate: day, localEndDateExclusive: end,
    startsAt: `${day}T00:00:00.000Z`, endsAt: `${end}T00:00:00.000Z`, timeZone: 'UTC', cadence: 'WEEKLY',
    status: n === 2 ? 'LOCKED' : 'OPEN', revision: n === 2 ? 3 : 1,
    reviewStartedAt: n === 2 ? '2026-08-07T00:00:00.000Z' : null,
    ...(native ? {} : { reviewStartedByUserId: n === 2 ? periodIds.creator : null }),
    lockedAt: n === 2 ? '2026-08-07T01:00:00.000Z' : null,
    ...(native ? {} : { lockedByUserId: n === 2 ? periodIds.creator : null }),
    lockedEntrySha256: n === 2 ? f!.tables.payrollPeriod.find(p => p.id === 'period-2')!.lockedEntrySha256 : null, lockedEntryCount: n === 2 ? 2 : null,
    totalPayableMinutes: n === 2 ? 960 : null, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    summary: summary(n), ...(native || detail ? { exportBatch } : {}) };
}
function cursorValue(cursor: string | null, key: string, expected: unknown) {
  expect(cursor).not.toBeNull();
  if (native) expect(JSON.parse(Buffer.from(cursor!, 'base64url').toString())).toEqual({ [key]: expected });
  else expect(cursor).toBe(expected);
}
function expectedCard(n: number) {
  const day = ({ 1: '2026-08-14', 2: '2026-08-15', 3: '2026-08-16', 7: '2026-07-31', 8: '2026-08-01' } as Record<number, string>)[n];
  const decision = n === 1 ? {
    ...(native ? {} : { id: 'approval-current', timeCardId: 'card-1' }), timeCardRevision: 2, decision: 'APPROVED', reason: null,
    decidedAt: '2026-08-20T00:00:00.000Z', decidedByUserId: staff() } : null;
  return { id: ownId('card', n), timeCardRevision: n === 1 ? 2 : 1,
    user: { id: staff(), name: 'Historical staff', username: '' }, locationId: native ? periodUuid(4) : periodIds.location,
    clockInAt: `${day}T08:00:00.000Z`, clockOutAt: `${day}T16:00:00.000Z`, breakMinutes: 0, payableMinutes: 480,
    updatedAt: `${day}T16:00:00.000Z`, displayTimeZone: 'UTC', included: n !== 2, adoptionEligible: n === 2,
    decision, decisionIsCurrent: n === 1 };
}
function expectedEntries(f: Fixture) {
  return [1, 2].map(n => {
    const day = n === 1 ? '2026-07-31' : '2026-08-01';
    return { id: ownId('entry', n), sequence: n - 1, sourceType: 'TIME_CARD', sourceId: ownId('card', n === 1 ? 7 : 8), sourceRevision: 1,
      employeeId: staff(), employeeName: 'Historical staff', locationId: native ? periodUuid(4) : periodIds.location,
      workTimeZone: 'UTC', clockInAt: `${day}T08:00:00.000Z`, clockOutAt: `${day}T16:00:00.000Z`, breakMinutes: 0,
      payableMinutes: 480, approvedAt: '2026-08-07T00:00:00.000Z', approvedByUserId: staff(), canonicalSha256: f.tables.payrollLockedEntry[n - 1].canonicalSha256 };
  });
}
function expectedAmendment() {
  return { id: ownId('amendment', 1), ...(native ? {} : { tenantId: periodIds.tenant }), lockedEntryId: ownId('entry', 1),
    sourceEmployeeId: staff(), adjustmentPeriodId: ownId('period', 3), requestedByUserId: staff(), reason: 'Correct missed break',
    replacementClockInAt: '2026-07-31T08:00:00.000Z', replacementClockOutAt: '2026-07-31T16:00:00.000Z',
    replacementBreakMinutes: 30, replacementPayableMinutes: 450, minuteDelta: -30, createdAt: '2026-08-08T00:00:00.000Z',
    decision: { decision: 'APPROVED', reason: null, decidedByUserId: staff(), decidedAt: '2026-08-09T00:00:00.000Z' } };
}
function expectedBatch(f: ReturnType<typeof payrollPeriodReadFixture>, line: number) {
  const row = f.tables.payrollExportLine[line - 1];
  return { id: native ? periodUuid(70) : periodIds.batch, ...(native ? {} : { tenantId: periodIds.tenant }),
    periodId: ownId('period', 2), formatVersion: 1, status: 'RECONCILED', contentSha256: f.tables.payrollExportBatch[0].contentSha256,
    rowCount: 2, totalPayableMinutes: 960, settlement: { consumedCredits: 1, newBalance: 9 },
    createdAt: '2026-08-08T00:00:00.000Z', downloadedAt: '2026-08-08T00:00:00.000Z',
    reconciledAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
    lines: [{ id: ownId('line', line), lineNumber: line, lockedEntryId: ownId('entry', line), employeeId: staff(),
      payableMinutes: 480, canonicalSha256: row.canonicalSha256, reconciliationStatus: line === 1 ? 'ACCEPTED' : 'REJECTED',
      reconciliationReason: line === 1 ? null : 'controlled rejection' }],
    nextLineCursor: line === 1 ? (native ? expect.any(String) : 'line-1') : null,
    reconciliation: { acceptedCount: 1, rejectedCount: 1, pendingCount: 0, providerTotalMinutes: 960,
      latestProvider: 'controlled-provider', latestProviderEventId: 'event-1', latestPayloadSha256: 'c'.repeat(64) } };
}
function populated(value: any, method: Method, f: ReturnType<typeof payrollPeriodReadFixture>) {
  if (method === 'list') {
    expect(value.data).toEqual([expectedPeriod(1), expectedPeriod(3)]);
    if (native) expect(JSON.parse(Buffer.from(value.nextCursor, 'base64url').toString())).toEqual({ localStartDate: '2026-08-06', publicId: periodUuid(23) });
    else expect(value.nextCursor).toBe('period-3');
  } else {
    const batch = expectedBatch(f, 1);
    expect(value).toEqual({ period: expectedPeriod(2, batch, true, f), cards: [expectedCard(7)], nextCardCursor: expect.any(String),
      lockedEntries: expectedEntries(f), amendments: [expectedAmendment()] });
    cursorValue(value.nextCardCursor, 'publicId', ownId('card', 7));
    cursorValue(value.period.exportBatch.nextLineCursor, 'publicId', ownId('line', 1));
  }
  const text = JSON.stringify(value); expect(text).not.toContain('foreign-period'); expect(text).not.toContain('foreign-tenant');
  if (native) for (const id of [periodIds.tenant, periodIds.actor, periodIds.session, periodIds.creator, periodIds.location, periodIds.batch,
    'period-1', 'period-2', 'period-3', 'card-7', 'entry-1', 'amendment-1', 'line-1']) expect(text).not.toContain(id);
}
function forbidden(error: unknown, mfa = false) {
  expect(error).toBeInstanceOf(ProblemError); expect((error as ProblemError).status).toBe(403);
  if (mfa) expect((error as ProblemError).code).toBe('mfa_verification_required');
}

describe('native payroll period protected read authority', () => {
  for (const method of methods) for (const writer of writers) it(`${method} refuses writer-first ${writer} after released valid admission`, async () => {
    const f = payrollPeriodReadFixture('native');
    if (writer === 'policy') f.tables.session[0].createdAt = new Date(Date.now() - 300_000);
    await f.admit(); const before = f.rowsBefore(); f.writerFirst(writer);
    const result = await capture(read(f, method)); f.assertClosed(before);
    if (result.value) populated(result.value, method, f);
    forbidden(await f.checkWriterDenied()); f.assertClosed(before); forbidden(result.error); expect(result.value).toBeNull();
  });
  for (const method of methods) for (const at of ['row', method === 'list' ? 'summary' : 'receipt'] as PeriodGate[]) for (const deadline of deadlines) {
    it(`${method} refuses ${deadline} expiry across actual ${at} await without result or domain writes`, async () => {
      const f = payrollPeriodReadFixture('native', deadline); await f.admit(); const before = f.rowsBefore(); f.pause(at);
      const result = await runPeriodPaused(f, () => read(f, method), true); f.assertClosed(before);
      if (result.value) populated(result.value, method, f);
      forbidden(result.error, deadline.startsWith('mfa')); expect(result.value).toBeNull();
    });
    it(`${method} preserves populated read while ${deadline} remains current across ${at}`, async () => {
      const f = payrollPeriodReadFixture('native', deadline); await f.admit(); const before = f.rowsBefore(); f.pause(at);
      const result = await runPeriodPaused(f, () => read(f, method), false); f.assertClosed(before);
      expect(result.error).toBeNull(); populated(result.value, method, f);
      expect(f.observations.filter(o => o.phase === 'owner').length).toBeLessThanOrEqual(1);
    });
  }
  it('preserves complete bounded period list inventory and public/private continuation', async () => {
    const f = payrollPeriodReadFixture('native'); await f.admit(); const before = f.rowsBefore();
    const first = await read(f, 'list'); populated(first, 'list', f);
    const next = await listNext(f, first.nextCursor!); expect(next).toEqual({ data: [expectedPeriod(2, null, false, f)], nextCursor: null }); f.assertClosed(before);
    expect(f.tables.user.find(u => u.id === periodIds.creator)?.deletedAt).toBeInstanceOf(Date);
  });
  it('preserves OPEN assigned and unassigned CLOSED history, exact revision approvals and the second card page', async () => {
    const f = payrollPeriodReadFixture('native'); await f.admit(); const before = f.rowsBefore();
    const first = await detail(f, 1, '2');
    expect(first).toEqual({ period: expectedPeriod(1, null, true), cards: [expectedCard(1), expectedCard(2)], nextCardCursor: expect.any(String), lockedEntries: [], amendments: [] });
    cursorValue(first.nextCardCursor, 'publicId', ownId('card', 2));
    const next = await detail(f, 1, '2', first.nextCardCursor!);
    expect(next).toEqual({ period: expectedPeriod(1, null, true), cards: [expectedCard(3)], nextCardCursor: null, lockedEntries: [], amendments: [] });
    expect(JSON.stringify(first)).not.toContain('old revision'); f.assertClosed(before);
  });
  it('preserves locked/amendment history plus saved export, both line/card pages and reconciliation references', async () => {
    const f = payrollPeriodReadFixture('native'); await f.admit(); const before = f.rowsBefore();
    const first = await read(f, 'detail'); populated(first, 'detail', f);
    const next = await detail(f, 2, '1', first.nextCardCursor!, '1', (first.period.exportBatch as { nextLineCursor: string }).nextLineCursor);
    expect(next).toEqual({ period: expectedPeriod(2, expectedBatch(f, 2), true, f), cards: [expectedCard(8)], nextCardCursor: null,
      lockedEntries: expectedEntries(f), amendments: [expectedAmendment()] }); f.assertClosed(before);
  });
  it('preserves empty card/line detail for an adjustment period while retaining source/decision references', async () => {
    const f = payrollPeriodReadFixture('native'); await f.admit(); const before = f.rowsBefore();
    const value = await detail(f, 3);
    expect(value).toEqual({ period: expectedPeriod(3, null, true), cards: [], nextCardCursor: null, lockedEntries: [], amendments: [expectedAmendment()] }); f.assertClosed(before);
  });
  it('preserves tenant-scoped empty list without domain writes or foreign records', async () => {
    const f = payrollPeriodReadFixture('native'); f.tables.payrollPeriod = f.tables.payrollPeriod.filter(p => p.tenantId !== periodIds.tenant);
    await f.admit(); const before = f.rowsBefore(); expect(await read(f, 'list')).toEqual({ data: [], nextCursor: null }); f.assertClosed(before);
  });
  for (const target of ['missing', 'foreign'] as const) it(`preserves ${target} detail not-found without cross-tenant output`, async () => {
    const f = payrollPeriodReadFixture('native'); await f.admit(); const before = f.rowsBefore();
    const result = await capture(missing(f, target)); f.assertClosed(before); expect(result.error).toBeInstanceOf(ProblemError); expect((result.error as ProblemError).status).toBe(404); expect(result.value).toBeNull();
  });
  for (const bad of ['list-bound', 'list-cursor', 'card-bound', 'card-cursor', 'line-bound', 'line-cursor'] as const) it(`preserves invalid ${bad} refusal before period reads`, async () => {
    const f = payrollPeriodReadFixture('native'); await f.admit(); const before = f.rowsBefore();
    const result = await capture(invalid(f, bad)); f.assertClosed(before); expect(result.error).toBeInstanceOf(ProblemError); expect((result.error as ProblemError).status).toBe(422); expect(result.value).toBeNull();
    expect(f.reads.filter(r => r.phase === 'owner' && r.table === 'payrollPeriod')).toEqual([]);
  });
  it('uses one bounded current payroll proof and exact final actor lock order, separate from unchanged domain controls', async () => {
    const f = payrollPeriodReadFixture('native'); await f.admit(); const before = f.rowsBefore();
    populated(await read(f, 'detail'), 'detail', f); f.assertClosed(before);
    expect(f.observations.filter(o => o.phase === 'owner')).toEqual([{ phase: 'owner', selected: { sub: periodIds.actor, tenantId: periodIds.tenant, sessionId: periodIds.session } }]);
    const contexts = f.contexts.filter(c => c.phase === 'owner'); expect(contexts).toHaveLength(2);
    const locks = f.reads.filter(r => r.phase === 'owner' && r.ordinal === contexts[1].ordinal && r.table === '$raw' && r.text.endsWith('FOR UPDATE'));
    expect(locks.map(r => /FROM "([^"]+)"/.exec(r.text)?.[1])).toEqual(['Tenant', 'User', 'Session', 'Role', 'RolePermission']);
    expect(locks.find(r => r.text.includes('FROM "Session"'))?.values).toEqual([periodIds.session, periodIds.actor]);
  });
  it('preserves the initially captured native reader/session when caller actor fields change during released first owner-context await', async () => {
    const f = payrollPeriodReadFixture('native'); await f.admit(); const before = f.rowsBefore(); f.pauseEntry();
    const result = capture(read(f, 'detail'));
    try {
      expect(await periodBounded(Promise.race([f.arrived.then(() => 'entered'), result.then(() => 'settled')]))).toBe('entered');
      f.identity.sub = 'mutated-reader'; f.identity.sessionId = 'mutated-session'; f.identity.permissions = [];
    } finally { f.release(); await periodBounded(result); }
    const end = await result; expect(end.error).toBeNull(); populated(end.value, 'detail', f); f.assertClosed(before);
    expect(f.observations.filter(o => o.phase === 'owner')).toEqual([{ phase: 'owner', selected: { sub: periodIds.actor, tenantId: periodIds.tenant, sessionId: periodIds.session } }]);
  });
});
