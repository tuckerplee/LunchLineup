import { describe, expect, it } from 'vitest';

import { buildPayrollCsv, payrollContentSha256, payrollExportLineSha256, payrollWorkedMinutes } from './payroll-csv';

const lines = [
    {
        id: 'line-2', lineNumber: 2, sourceType: 'AMENDMENT' as const, sourceId: 'amendment-1',
        employeeId: 'employee-b', locationId: null, workTimeZone: 'UTC',
        clockInAt: '2026-07-01T10:00:00.000Z', clockOutAt: '2026-07-01T11:00:00.000Z',
        breakMinutes: 0, payableMinutes: -15,
    },
    {
        id: 'line-1', lineNumber: 1, sourceType: 'TIME_CARD' as const, sourceId: 'card-1',
        employeeId: 'employee-a', locationId: 'location-1', workTimeZone: 'America/Los_Angeles',
        clockInAt: '2026-07-01T08:00:00.000Z', clockOutAt: '2026-07-01T09:00:00.000Z',
        breakMinutes: 5, payableMinutes: 55,
    },
];

describe('payroll CSV', () => {
    it('is deterministic UTF-8 with LF endings and signed amendment minutes', () => {
        const first = buildPayrollCsv(lines);
        const second = buildPayrollCsv([...lines].reverse());
        expect(first.equals(second)).toBe(true);
        expect(first.toString('utf8')).toContain('"-15"\n');
        expect(first.toString('utf8')).not.toContain('\r');
        expect(payrollContentSha256(first)).toMatch(/^[a-f0-9]{64}$/);
    });

    it('binds line hashes to the batch, locked entry, and exact copied line', () => {
        const hash = payrollExportLineSha256({
            tenantId: 'tenant-1', batchId: 'batch-1', lockedEntryId: 'entry-1', line: lines[1],
        });
        const drift = payrollExportLineSha256({
            tenantId: 'tenant-1', batchId: 'batch-1', lockedEntryId: 'entry-1',
            line: { ...lines[1], payableMinutes: 54 },
        });
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
        expect(hash).not.toBe(drift);
    });

    it('safely rounds a positive sub-minute closed card to zero payable minutes', () => {
        expect(payrollWorkedMinutes({
            clockInAt: '2026-07-01T08:00:00.000Z',
            clockOutAt: '2026-07-01T08:00:30.000Z',
            breakMinutes: 0,
        })).toBe(0);
        expect(() => payrollWorkedMinutes({
            clockInAt: '2026-07-01T08:00:00.000Z',
            clockOutAt: '2026-07-01T08:00:00.000Z',
            breakMinutes: 0,
        })).toThrow('duration');
    });
});
