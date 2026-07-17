import { describe, expect, it } from 'vitest';

import {
    assertFutureEffectiveBoundary,
    assertPayrollAnchorAlignment,
    normalizePayrollPolicy,
    payrollPeriodBoundaries,
} from './payroll-policy';

describe('payroll policy dates', () => {
    it('uses 23-hour and 25-hour DST-correct local period boundaries', () => {
        const spring = payrollPeriodBoundaries('2026-03-08', {
            timeZone: 'America/Los_Angeles',
            cadence: 'WEEKLY',
            anchorDate: '2026-03-08',
        });
        const fall = payrollPeriodBoundaries('2026-11-01', {
            timeZone: 'America/Los_Angeles',
            cadence: 'WEEKLY',
            anchorDate: '2026-11-01',
        });

        expect(spring.startsAt.toISOString()).toBe('2026-03-08T08:00:00.000Z');
        expect(spring.endsAt.toISOString()).toBe('2026-03-15T07:00:00.000Z');
        expect((spring.endsAt.getTime() - spring.startsAt.getTime()) / 3_600_000).toBe(167);
        expect(fall.startsAt.toISOString()).toBe('2026-11-01T07:00:00.000Z');
        expect(fall.endsAt.toISOString()).toBe('2026-11-08T08:00:00.000Z');
        expect((fall.endsAt.getTime() - fall.startsAt.getTime()) / 3_600_000).toBe(169);
    });

    it('supports aligned boundaries before and after an anchor and rejects drift', () => {
        expect(() => assertPayrollAnchorAlignment('2026-07-06', '2026-07-20', 'BIWEEKLY')).not.toThrow();
        expect(() => assertPayrollAnchorAlignment('2026-07-13', '2026-07-20', 'BIWEEKLY'))
            .toThrow('align');
    });

    it('requires a future effective aligned boundary and a required IANA timezone', () => {
        const policy = normalizePayrollPolicy({
            timeZone: 'America/New_York',
            cadence: 'WEEKLY',
            anchorDate: '2026-08-03',
            effectiveFrom: '2026-08-10',
        });
        expect(() => assertFutureEffectiveBoundary(policy, new Date('2026-08-01T12:00:00Z'))).not.toThrow();
        expect(() => assertFutureEffectiveBoundary(policy, new Date('2026-08-10T12:00:00Z'))).toThrow('future');
        expect(() => normalizePayrollPolicy({
            timeZone: '', cadence: 'WEEKLY', anchorDate: '2026-08-03', effectiveFrom: '2026-08-10',
        })).toThrow('timeZone');
    });
});
