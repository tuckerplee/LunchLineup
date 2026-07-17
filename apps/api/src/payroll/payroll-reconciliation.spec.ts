import { describe, expect, it } from 'vitest';

import {
    MAX_RECONCILIATION_OUTCOMES,
    normalizeReconciliation,
    reconciliationCounts,
    reconciliationPayloadSha256,
} from './payroll-reconciliation';

describe('payroll reconciliation validation', () => {
    it('canonicalizes outcome order and preserves signed provider totals', () => {
        const payload = normalizeReconciliation({
            provider: 'Acme Payroll', providerEventId: 'event-1', providerTotalMinutes: -15,
            outcomes: [
                { lineId: 'line-b', status: 'REJECTED', reason: 'provider rejected' },
                { lineId: 'line-a', status: 'ACCEPTED' },
            ],
        });
        expect(payload.providerTotalMinutes).toBe(-15);
        expect(payload.outcomes.map((outcome) => outcome.lineId)).toEqual(['line-a', 'line-b']);
        expect(reconciliationCounts(payload)).toEqual({ acceptedCount: 1, rejectedCount: 1, pendingCount: 0 });
        expect(reconciliationPayloadSha256({
            tenantId: 'tenant-1', actorUserId: 'manager-1', batchId: 'batch-1', payload,
        })).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects duplicate, unknown statuses, and oversized outcome collections', () => {
        expect(() => normalizeReconciliation({
            provider: 'p', providerEventId: 'e', providerTotalMinutes: 0,
            outcomes: [{ lineId: 'line-1', status: 'ACCEPTED' }, { lineId: 'line-1', status: 'PENDING' }],
        })).toThrow('repeat');
        expect(() => normalizeReconciliation({
            provider: 'p', providerEventId: 'e', providerTotalMinutes: 0,
            outcomes: [{ lineId: 'line-1', status: 'UNKNOWN' }],
        })).toThrow('status');
        expect(() => normalizeReconciliation({
            provider: 'p', providerEventId: 'e', providerTotalMinutes: 0,
            outcomes: Array.from({ length: MAX_RECONCILIATION_OUTCOMES + 1 }, (_, index) => ({
                lineId: `line-${index}`, status: 'PENDING',
            })),
        })).toThrow('500');
    });
});
