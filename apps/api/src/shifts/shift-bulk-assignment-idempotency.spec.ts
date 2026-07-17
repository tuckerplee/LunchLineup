import { describe, expect, it } from 'vitest';
import {
    normalizeShiftBulkAssignmentIdempotencyKey,
    shiftBulkAssignmentOperationId,
    shiftBulkAssignmentRequestHash,
} from './shift-bulk-assignment-idempotency';

describe('shift bulk assignment idempotency', () => {
    it('requires a bounded printable key', () => {
        expect(() => normalizeShiftBulkAssignmentIdempotencyKey(undefined)).toThrow('Idempotency-Key header is required');
        expect(() => normalizeShiftBulkAssignmentIdempotencyKey(`key-${'x'.repeat(252)}`)).toThrow('255 printable');
        expect(() => normalizeShiftBulkAssignmentIdempotencyKey('key\nvalue')).toThrow('255 printable');
        expect(normalizeShiftBulkAssignmentIdempotencyKey(' bulk-assign-1 ')).toBe('bulk-assign-1');
    });

    it('creates a tenant-scoped operation identity distinct from shift creation', () => {
        const operationId = shiftBulkAssignmentOperationId('tenant-1', 'bulk-assign-1');
        expect(operationId).toHaveLength(64);
        expect(operationId).not.toContain('bulk-assign-1');
        expect(operationId).not.toBe(shiftBulkAssignmentOperationId('tenant-2', 'bulk-assign-1'));
    });

    it('canonicalizes assignment order while retaining assignment drift', () => {
        const first = {
            assignments: [
                { shiftId: 'shift-2', userId: null },
                { shiftId: 'shift-1', userId: 'user-1' },
            ],
        };
        const reordered = {
            assignments: [
                { shiftId: 'shift-1', userId: 'user-1' },
                { shiftId: 'shift-2', userId: null },
            ],
        };
        expect(shiftBulkAssignmentRequestHash(first)).toBe(shiftBulkAssignmentRequestHash(reordered));
        expect(shiftBulkAssignmentRequestHash(first)).not.toBe(shiftBulkAssignmentRequestHash({
            assignments: [
                { shiftId: 'shift-2', userId: 'user-2' },
                { shiftId: 'shift-1', userId: 'user-1' },
            ],
        }));
    });
});
