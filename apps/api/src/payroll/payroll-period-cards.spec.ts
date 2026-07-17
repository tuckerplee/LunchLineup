import { describe, expect, it } from 'vitest';

import {
    isHistoricalPayrollCardInWindow,
    type PayrollCandidateCard,
    validatePayrollCandidateCards,
} from './payroll-period-cards';

const period = {
    id: 'period-1',
    startsAt: new Date('2026-06-01T00:00:00Z'),
    endsAt: new Date('2026-06-08T00:00:00Z'),
};

function card(overrides: Partial<PayrollCandidateCard> = {}): PayrollCandidateCard {
    return {
        id: 'card-1',
        tenantId: 'tenant-1',
        userId: 'employee-1',
        locationId: null,
        payrollPeriodId: period.id,
        workTimeZone: 'UTC',
        revision: 3,
        clockInAt: new Date('2026-06-02T08:00:00Z'),
        clockOutAt: new Date('2026-06-02T16:00:00Z'),
        breakMinutes: 30,
        status: 'CLOSED',
        deletedAt: null,
        ...overrides,
    };
}

describe('payroll period card preflight', () => {
    it('accepts an empty period and valid assigned closed cards', () => {
        expect(validatePayrollCandidateCards([], period)).toEqual([]);
        expect(validatePayrollCandidateCards([card()], period)).toHaveLength(1);
        expect(validatePayrollCandidateCards([card({
            clockOutAt: new Date('2026-06-02T08:00:30Z'),
            breakMinutes: 0,
        })], period)).toHaveLength(1);
    });

    it.each([
        ['open card', card({ status: 'OPEN', clockOutAt: null })],
        ['void card', card({ status: 'VOID' })],
        ['deleted card', card({ deletedAt: new Date() })],
        ['unassigned overlap', card({ payrollPeriodId: null })],
        ['other-period overlap', card({ payrollPeriodId: 'period-2' })],
        ['cross-boundary card', card({ clockInAt: new Date('2026-05-31T23:00:00Z') })],
    ])('rejects %s before forward-only review', (_label, candidate) => {
        expect(() => validatePayrollCandidateCards([candidate], period)).toThrow();
    });

    it('classifies only unassigned closed undeleted wholly in-window history as adoptable', () => {
        const eligible = card({ payrollPeriodId: null });
        expect(isHistoricalPayrollCardInWindow(eligible, period)).toBe(true);
        expect(isHistoricalPayrollCardInWindow(card({ payrollPeriodId: null, status: 'OPEN' }), period)).toBe(false);
        expect(isHistoricalPayrollCardInWindow(card({ payrollPeriodId: null, deletedAt: new Date() }), period)).toBe(false);
        expect(isHistoricalPayrollCardInWindow(card({ payrollPeriodId: 'period-2' }), period)).toBe(false);
        expect(isHistoricalPayrollCardInWindow(card({
            payrollPeriodId: null,
            clockInAt: new Date('2026-05-31T23:00:00Z'),
        }), period)).toBe(false);
        expect(isHistoricalPayrollCardInWindow(card({
            payrollPeriodId: null,
            clockOutAt: new Date('2026-06-08T00:01:00Z'),
        }), period)).toBe(false);
    });
});
