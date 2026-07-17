import { describe, expect, it } from 'vitest';

import {
    MAX_PAYROLL_REQUEST_ITEMS,
    parseAdoption,
    parseAmendment,
    parseApprovalDecisions,
    parseBoundedLimit,
} from './payroll-validation';

describe('payroll request validation', () => {
    it('bounds pagination and adoption batches with unique optimistic revisions', () => {
        expect(parseBoundedLimit('50', { field: 'limit', defaultValue: 25, maximum: 50 })).toBe(50);
        expect(() => parseBoundedLimit('51', { field: 'limit', defaultValue: 25, maximum: 50 })).toThrow('between');
        expect(parseAdoption({ cards: [{ id: 'card-b', expectedRevision: 2 }, { id: 'card-a', expectedRevision: 1 }] }))
            .toEqual([{ id: 'card-a', expectedRevision: 1 }, { id: 'card-b', expectedRevision: 2 }]);
        expect(() => parseAdoption({ cards: Array.from({ length: MAX_PAYROLL_REQUEST_ITEMS + 1 }, (_, index) => ({
            id: `card-${index}`, expectedRevision: 1,
        })) })).toThrow('100');
    });

    it('requires exact UTC revisions and bounded decision reasons', () => {
        expect(parseApprovalDecisions({ decisions: [{
            timeCardId: 'card-1', expectedRevision: 3, decision: 'REJECTED', reason: 'Needs correction',
        }] })[0]).toMatchObject({ timeCardId: 'card-1', expectedRevision: 3, decision: 'REJECTED' });
        expect(() => parseApprovalDecisions({ decisions: [{
            timeCardId: 'card-1', expectedRevision: -1, decision: 'APPROVED',
        }] })).toThrow('non-negative');
    });

    it('validates replacement payable time separately from its later signed delta', () => {
        const amendment = parseAmendment({
            adjustmentPeriodId: 'period-2', replacementClockInAt: '2026-07-01T08:00:00Z',
            replacementClockOutAt: '2026-07-01T09:00:00Z', replacementBreakMinutes: 10,
            reason: 'Corrected source record',
        });
        expect(amendment.replacementBreakMinutes).toBe(10);
        expect(() => parseAmendment({
            adjustmentPeriodId: 'period-2', replacementClockInAt: '2026-07-01T08:00:00Z',
            replacementClockOutAt: '2026-07-01T09:00:00Z', replacementBreakMinutes: 60,
            reason: 'Corrected source record',
        })).toThrow('invalid');
    });
});
