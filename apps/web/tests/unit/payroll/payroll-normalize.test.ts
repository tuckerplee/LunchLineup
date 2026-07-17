import { describe, expect, it } from 'vitest';
import {
  normalizePayrollExport,
  normalizePayrollPeriodDetail,
  normalizePayrollPolicyEnvelope,
} from '../../../app/dashboard/payroll/payroll-normalize';

describe('payroll service response normalization', () => {
  it('reads the current immutable policy from the direct data envelope', () => {
    expect(normalizePayrollPolicyEnvelope({ data: {
      id: 'policy-1', version: 1, timeZone: 'America/Los_Angeles', cadence: 'BIWEEKLY',
      anchorDate: '2026-07-01', effectiveFrom: '2026-08-01', createdByUserId: 'manager-1', createdAt: '2026-07-16T00:00:00.000Z',
    } })).toMatchObject({ id: 'policy-1', version: 1, effectiveFrom: '2026-08-01' });
  });

  it('normalizes a direct period with summary and nested bounded card page', () => {
    const detail = normalizePayrollPeriodDetail({
      id: 'period-1', policyVersionId: 'policy-1', localStartDate: '2026-07-01', localEndDateExclusive: '2026-07-15',
      startsAt: '2026-07-01T07:00:00.000Z', endsAt: '2026-07-15T07:00:00.000Z', timeZone: 'America/Los_Angeles',
      cadence: 'BIWEEKLY', status: 'REVIEW', revision: 3,
      summary: { cardCount: 1, closedCardCount: 1, approvedCardCount: 0, rejectedCardCount: 0, pendingCardCount: 1 },
      cards: { data: [{ id: 'card-1', userId: 'user-1', workTimeZone: 'America/Los_Angeles', clockInAt: '2026-07-02T16:00:00.000Z', clockOutAt: '2026-07-03T00:00:00.000Z', breakMinutes: 30, revision: 4, updatedAt: '2026-07-03T00:01:00.000Z' }], nextCursor: 'card-1' },
    });
    expect(detail.period.summary).toMatchObject({ cardCount: 1, pendingCardCount: 1 });
    expect(detail.cards[0]).toMatchObject({ id: 'card-1', timeCardRevision: 4, payableMinutes: 450, included: true });
    expect(detail.nextCardCursor).toBe('card-1');
  });

  it('normalizes direct deterministic export settlement and bounded line cursor without inventing download charges', () => {
    expect(normalizePayrollExport({ id: 'batch-1', periodId: 'period-1', status: 'GENERATED', rowCount: 2, totalPayableMinutes: 900, settlement: { consumedCredits: 2, newBalance: 8 }, createdAt: '2026-07-16T00:00:00.000Z', lines: [{ id: 'line-1', lineNumber: 1, lockedEntryId: 'entry-1', employeeId: 'user-1', payableMinutes: 450 }], nextLineCursor: 'line-1' })).toMatchObject({
      id: 'batch-1', rowCount: 2, settlement: { consumedCredits: 2, newBalance: 8 }, lines: [{ id: 'line-1', reconciliationStatus: 'PENDING' }], nextLineCursor: 'line-1',
    });
  });
});
