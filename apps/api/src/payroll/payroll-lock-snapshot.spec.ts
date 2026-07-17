import { describe, expect, it } from 'vitest';

import { materializeLockedSnapshots, payrollLockAggregateSha256 } from './payroll-lock-snapshot';

describe('payroll locked snapshots', () => {
    it('sorts deterministically and retains signed amendment deltas in aggregate evidence', () => {
        const result = materializeLockedSnapshots({
            tenantId: 'tenant-1',
            periodId: 'period-1',
            sources: [
                {
                    sourceType: 'AMENDMENT', sourceId: 'amendment-1', sourceRevision: 1,
                    employeeId: 'employee-b', locationId: null, workTimeZone: 'UTC',
                    clockInAt: '2026-07-01T09:00:00Z', clockOutAt: '2026-07-01T10:00:00Z',
                    breakMinutes: 0, payableMinutes: -20,
                    approvedAt: '2026-07-02T00:00:00Z', approvedByUserId: 'approver-2',
                },
                {
                    sourceType: 'TIME_CARD', sourceId: 'card-1', sourceRevision: 2,
                    employeeId: 'employee-a', locationId: 'location-1', workTimeZone: 'UTC',
                    clockInAt: '2026-07-01T08:00:00Z', clockOutAt: '2026-07-01T09:00:00Z',
                    breakMinutes: 0, payableMinutes: 60,
                    approvedAt: '2026-07-02T00:00:00Z', approvedByUserId: 'approver-1',
                },
            ],
        });
        expect(result.entries.map((entry) => entry.sourceId)).toEqual(['card-1', 'amendment-1']);
        expect(result.entries.map((entry) => entry.sequence)).toEqual([0, 1]);
        expect(result.totalPayableMinutes).toBe(40);
        expect(result.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('materializes deterministic zero-entry aggregate evidence and supports independent readback', () => {
        const empty = materializeLockedSnapshots({ tenantId: 'tenant-1', periodId: 'period-empty', sources: [] });

        expect(empty.entries).toEqual([]);
        expect(empty.totalPayableMinutes).toBe(0);
        expect(empty.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(payrollLockAggregateSha256({
            tenantId: 'tenant-1',
            periodId: 'period-empty',
            entryHashes: [],
            totalPayableMinutes: 0,
        })).toBe(empty.aggregateSha256);
    });
});
