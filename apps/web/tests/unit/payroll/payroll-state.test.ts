import { describe, expect, it } from 'vitest';
import {
  appendPayrollCards,
  appendPayrollExportLines,
  buildExpectedRevisions,
  canCreatePayrollAmendmentForEntry,
  classifyPayrollMutationError,
  formatSignedMinutes,
  hasExportablePayrollEntries,
  isBatchFullyReconciled,
  isCalendarDate,
  isIanaTimeZone,
  MAX_PAYROLL_BULK_ROWS,
  parsePayrollExportCreditCost,
  payrollReadiness,
  payrollAmendmentDecisionBlocker,
  payrollStatusExplanation,
  reconciliationEditableLines,
  validatePayrollPolicy,
  validateReconciliation,
} from '../../../app/dashboard/payroll/payroll-contract';
import type { PayrollCard, PayrollExportBatch, PayrollPeriodSummary, PayrollPolicyVersion } from '../../../app/dashboard/payroll/payroll-types';

const readiness = {
  cardCount: 3,
  closedCardCount: 3,
  approvedCardCount: 2,
  rejectedCardCount: 0,
  pendingCardCount: 1,
  amendmentCount: 0,
  pendingAmendmentCount: 0,
  approvedAmendmentCount: 0,
  lockedEntryCount: 0,
};

const period = (overrides: Partial<PayrollPeriodSummary> = {}): PayrollPeriodSummary => ({
  id: 'period-1', policyVersionId: 'policy-2', localStartDate: '2026-07-01', localEndDateExclusive: '2026-07-15',
  startsAt: '2026-07-01T07:00:00.000Z', endsAt: '2026-07-15T07:00:00.000Z', timeZone: 'America/Los_Angeles',
  cadence: 'BIWEEKLY', status: 'REVIEW', revision: 4, summary: readiness, ...overrides,
});

const card = (id: string, updatedAt = `2026-07-16T00:00:0${id}.000Z`): PayrollCard => ({
  id, timeCardRevision: Number(id), user: { id: `user-${id}`, name: `User ${id}`, username: `user${id}` },
  clockInAt: '2026-07-15T16:00:00.000Z', clockOutAt: '2026-07-16T00:00:00.000Z', breakMinutes: 30,
  payableMinutes: 450, updatedAt, displayTimeZone: 'America/Los_Angeles', included: true, adoptionEligible: false,
  decisionIsCurrent: false,
});

const batch = (overrides: Partial<PayrollExportBatch> = {}): PayrollExportBatch => ({
  id: 'batch-1', periodId: 'period-1', formatVersion: 1, status: 'RECONCILED', contentSha256: 'a'.repeat(64),
  rowCount: 1, totalPayableMinutes: 450, settlement: { consumedCredits: 2, newBalance: 8 }, createdAt: '2026-07-16T00:00:00.000Z',
  lines: [{ id: 'line-1', lineNumber: 1, lockedEntryId: 'entry-1', employeeId: 'user-1', payableMinutes: 450, canonicalSha256: 'b'.repeat(64), reconciliationStatus: 'ACCEPTED' }],
  nextLineCursor: null,
  reconciliation: { acceptedCount: 1, rejectedCount: 0, pendingCount: 0, providerTotalMinutes: 450 },
  ...overrides,
});

describe('immutable payroll policy', () => {
  const latestPolicy: PayrollPolicyVersion = {
    id: 'policy-1', version: 1, timeZone: 'America/Los_Angeles', cadence: 'BIWEEKLY',
    anchorDate: '2026-07-01', effectiveFrom: '2026-07-01', createdByUserId: 'manager-1', createdAt: '2026-07-01T00:00:00.000Z',
  };

  it('allows an aligned historical boundary only for the initial version', () => {
    expect(isIanaTimeZone('America/Los_Angeles')).toBe(true);
    expect(isIanaTimeZone('+08:00')).toBe(false);
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(validatePayrollPolicy({ timeZone: 'America/Los_Angeles', cadence: 'BIWEEKLY', anchorDate: '2026-07-01', effectiveFrom: '2026-07-01' }, '2026-07-16')).toEqual({});
    expect(validatePayrollPolicy({ timeZone: 'America/Los_Angeles', cadence: 'WEEKLY', anchorDate: '2026-07-01', effectiveFrom: '2026-07-29' }, '2026-07-16')).toEqual({});
    expect(validatePayrollPolicy({ timeZone: 'Bad/Zone', cadence: 'WEEKLY', anchorDate: '2026-02-30', effectiveFrom: 'invalid' }, '2026-07-16')).toEqual({
      timeZone: 'Enter a valid IANA time zone, such as America/Los_Angeles.',
      anchorDate: 'Choose a valid calendar anchor date.',
      effectiveFrom: 'Choose a valid effective date.',
    });
  });

  it('fixes timezone and aligns later versions to both prior and new cadences', () => {
    expect(validatePayrollPolicy({ timeZone: 'America/Los_Angeles', cadence: 'WEEKLY', anchorDate: '2026-07-01', effectiveFrom: '2026-07-29' }, '2026-07-16', latestPolicy)).toEqual({});
    expect(validatePayrollPolicy({ timeZone: 'America/New_York', cadence: 'WEEKLY', anchorDate: '2026-07-01', effectiveFrom: '2026-07-29' }, '2026-07-16', latestPolicy).timeZone).toContain('fixed');
    expect(validatePayrollPolicy({ timeZone: 'America/Los_Angeles', cadence: 'WEEKLY', anchorDate: '2026-07-02', effectiveFrom: '2026-07-23' }, '2026-07-16', latestPolicy).effectiveFrom).toContain('both');
    expect(validatePayrollPolicy({ timeZone: 'America/Los_Angeles', cadence: 'BIWEEKLY', anchorDate: '2026-07-01', effectiveFrom: '2026-07-15' }, '2026-07-16', latestPolicy).effectiveFrom).toContain('future');
  });
});

describe('authoritative review and terminal lock readiness', () => {
  it('uses aggregate fields independent of loaded cards', () => {
    expect(payrollReadiness(period())).toEqual({ canStartReview: false, canLock: false, remainingExactDecisions: 1 });
    expect(payrollReadiness(period({ summary: { ...readiness, approvedCardCount: 3, pendingCardCount: 0 } })).canLock).toBe(true);
    expect(payrollReadiness(period({ status: 'OPEN', summary: { ...readiness, approvedCardCount: 0, pendingCardCount: 3 } })).canStartReview).toBe(true);
  });

  it('allows ended empty periods through review and terminal lock', () => {
    const emptySummary = {
      ...readiness,
      cardCount: 0,
      closedCardCount: 0,
      approvedCardCount: 0,
      pendingCardCount: 0,
    };

    expect(payrollReadiness(period({ status: 'OPEN', summary: emptySummary })).canStartReview).toBe(true);
    expect(payrollReadiness(period({ status: 'REVIEW', summary: emptySummary })).canLock).toBe(true);
    expect(payrollReadiness(period({ status: 'REVIEW', summary: { ...emptySummary, pendingAmendmentCount: 1 } })).canLock).toBe(false);
  });

  it('allows export commands only for non-empty terminal snapshots', () => {
    expect(hasExportablePayrollEntries(period({ status: 'LOCKED', lockedEntryCount: 0, summary: { ...readiness, lockedEntryCount: 0 } }))).toBe(false);
    expect(hasExportablePayrollEntries(period({ status: 'LOCKED', lockedEntryCount: 1, summary: { ...readiness, lockedEntryCount: 1 } }))).toBe(true);
    expect(hasExportablePayrollEntries(period({ status: 'REVIEW', lockedEntryCount: 1, summary: { ...readiness, lockedEntryCount: 1 } }))).toBe(false);
  });

  it('describes LOCKED as terminal with future amendments', () => {
    expect(payrollStatusExplanation(period({ status: 'LOCKED' }))).toContain('Terminal locked snapshot');
    expect(payrollStatusExplanation(period({ status: 'LOCKED' }))).toContain('future-period amendments');
  });
});

describe('bounded loaded-row decisions', () => {
  it('merges pages, binds exact versions, and caps bulk payloads at 100', () => {
    const merged = appendPayrollCards([card('1'), card('2')], [card('2', 'new'), card('3')]);
    expect(merged.map((entry) => entry.id)).toEqual(['1', '2', '3']);
    expect(buildExpectedRevisions(merged, ['1', '3'])).toEqual({ '1': 1, '3': 3 });
    expect(appendPayrollExportLines([
      { ...batch().lines[0], id: 'line-2', lineNumber: 2 },
    ], [batch().lines[0]]) .map((line) => line.lineNumber)).toEqual([1, 2]);
    expect(() => buildExpectedRevisions(Array.from({ length: MAX_PAYROLL_BULK_ROWS + 1 }, (_, index) => card(String(index + 1))), Array.from({ length: MAX_PAYROLL_BULK_ROWS + 1 }, (_, index) => String(index + 1)))).toThrow('Select between 1 and 100');
  });

  it('classifies revision conflicts and ambiguous transport for readback', () => {
    expect(classifyPayrollMutationError(409)).toBe('stale');
    expect(classifyPayrollMutationError(412)).toBe('stale');
    expect(classifyPayrollMutationError(null)).toBe('ambiguous');
    expect(classifyPayrollMutationError(503)).toBe('ambiguous');
  });
});

describe('paid export, amendments, and line reconciliation', () => {
  it('accepts only an eligible positive integer authoritative time_cards configured cost', () => {
    expect(parsePayrollExportCreditCost({ eligible: true, creditCost: 2, reason: 'Eligible.' })).toBe(2);
    for (const payload of [
      null,
      {},
      { features: { time_cards: { creditCost: 2 } } },
      { eligible: true, creditCost: 0 },
      { eligible: true, creditCost: -1 },
      { eligible: true, creditCost: 1.5 },
    ]) expect(() => parsePayrollExportCreditCost(payload)).toThrow('unavailable');
  });

  it('honors separate subscription and credit ineligibility reasons', () => {
    expect(() => parsePayrollExportCreditCost({
      eligible: false,
      creditCost: 2,
      reason: 'Billable features require a current active paid subscription.',
    })).toThrow('active paid subscription');
    expect(() => parsePayrollExportCreditCost({
      eligible: false,
      creditCost: 2,
      reason: 'Feature requires 2 separately purchased usage credits.',
    })).toThrow('separately purchased usage credits');
  });

  it('formats signed amendment deltas', () => {
    expect(formatSignedMinutes(30)).toBe('+0h 30m');
    expect(formatSignedMinutes(-90)).toBe('-1h 30m');
  });

  it('separates amendment creation and decisions from the source employee and requester', () => {
    expect(canCreatePayrollAmendmentForEntry(true, 'manager-1', 'employee-1')).toBe(true);
    expect(canCreatePayrollAmendmentForEntry(false, 'manager-1', 'employee-1')).toBe(false);
    expect(canCreatePayrollAmendmentForEntry(true, 'employee-1', 'employee-1')).toBe(false);

    const decision = (overrides: Partial<Parameters<typeof payrollAmendmentDecisionBlocker>[0]> = {}) => payrollAmendmentDecisionBlocker({
      hasDecisionPermission: true,
      currentUserId: 'manager-2',
      requestedByUserId: 'manager-1',
      sourceEmployeeId: 'employee-1',
      adjustmentInReview: true,
      ...overrides,
    });
    expect(decision()).toBeNull();
    expect(decision({ hasDecisionPermission: false })).toContain('permission');
    expect(decision({ currentUserId: 'manager-1' })).toContain('requester');
    expect(decision({ currentUserId: 'employee-1' })).toContain('source employee');
    expect(decision({ sourceEmployeeId: null })).toContain('Load source');
    expect(decision({ adjustmentInReview: false })).toContain('in review');
  });

  it('requires explicit bounded line outcomes and rejected-line reasons', () => {
    expect(validateReconciliation({ provider: 'Provider', providerEventId: 'event-1', providerTotalMinutes: 450, lines: [{ lineId: 'line-1', status: 'ACCEPTED' }] })).toBeNull();
    expect(validateReconciliation({ provider: 'Provider', providerEventId: 'event-negative', providerTotalMinutes: -15, lines: [{ lineId: 'line-1', status: 'ACCEPTED' }] })).toBeNull();
    expect(validateReconciliation({ provider: 'Provider', providerEventId: 'event-fraction', providerTotalMinutes: -1.5, lines: [{ lineId: 'line-1', status: 'ACCEPTED' }] })).toContain('signed whole');
    expect(validateReconciliation({ provider: 'Provider', providerEventId: 'event-1', providerTotalMinutes: 450, lines: [{ lineId: 'line-1', status: 'REJECTED' }] })).toContain('require a reason');
    expect(validateReconciliation({ provider: 'Provider', providerEventId: 'event-1', providerTotalMinutes: 450, lines: Array.from({ length: 501 }, (_, index) => ({ lineId: `line-${index}`, status: 'PENDING' as const })) })).toContain('between 1 and 500');
  });

  it('recognizes completeness only with every accepted line and exact totals', () => {
    expect(isBatchFullyReconciled(batch())).toBe(true);
    expect(isBatchFullyReconciled(batch({ status: 'RECONCILING' }))).toBe(false);
    expect(isBatchFullyReconciled(batch({ reconciliation: { acceptedCount: 1, rejectedCount: 0, pendingCount: 0, providerTotalMinutes: 449 } }))).toBe(false);
    expect(isBatchFullyReconciled(batch({ lines: [], nextLineCursor: 'next-page' }))).toBe(true);
    expect(isBatchFullyReconciled(batch({ reconciliation: { acceptedCount: 0, rejectedCount: 1, pendingCount: 0, providerTotalMinutes: 450 } }))).toBe(false);
  });

  it('keeps rejected lines correctable and uses accepted lines to repair a wrong provider total', () => {
    const rejected = { ...batch().lines[0], reconciliationStatus: 'REJECTED' as const, reconciliationReason: 'Provider mismatch' };
    expect(reconciliationEditableLines(batch({
      status: 'RECONCILING',
      lines: [batch().lines[0], rejected],
      reconciliation: { acceptedCount: 1, rejectedCount: 1, pendingCount: 0, providerTotalMinutes: 450 },
    }))).toEqual([rejected]);
    expect(reconciliationEditableLines(batch({
      status: 'RECONCILING',
      reconciliation: { acceptedCount: 1, rejectedCount: 0, pendingCount: 0, providerTotalMinutes: 449 },
    }))).toEqual(batch().lines);
  });
});
