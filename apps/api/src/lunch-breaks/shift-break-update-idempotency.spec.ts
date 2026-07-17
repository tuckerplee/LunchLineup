import { describe, expect, it } from 'vitest';
import {
    normalizeShiftBreakUpdateIdempotencyKey,
    shiftBreakUpdateOperationId,
    shiftBreakUpdateRequestHash,
} from './shift-break-update-idempotency';

describe('shift lunch/break update idempotency', () => {
    it('requires a bounded printable key', () => {
        expect(() => normalizeShiftBreakUpdateIdempotencyKey(undefined)).toThrow('Idempotency-Key header is required');
        expect(() => normalizeShiftBreakUpdateIdempotencyKey(`key-${'x'.repeat(252)}`)).toThrow('255 printable');
        expect(() => normalizeShiftBreakUpdateIdempotencyKey('key\nvalue')).toThrow('255 printable');
        expect(normalizeShiftBreakUpdateIdempotencyKey(' update-1 ')).toBe('update-1');
    });

    it('binds operation identity to tenant, shift, and opaque key', () => {
        const operationId = shiftBreakUpdateOperationId('tenant-1', 'shift-1', 'update-1');
        expect(operationId).toHaveLength(64);
        expect(operationId).not.toContain('update-1');
        expect(operationId).not.toBe(shiftBreakUpdateOperationId('tenant-2', 'shift-1', 'update-1'));
        expect(operationId).not.toBe(shiftBreakUpdateOperationId('tenant-1', 'shift-2', 'update-1'));
    });

    it('hashes semantic break order and ignores skipped-row details', () => {
        const first = {
            locationId: 'location-1',
            breaks: [
                { type: 'lunch' as const, startTime: '2026-03-05T13:00:00.000Z', durationMinutes: 30, skip: false },
                { type: 'break1' as const, startTime: 'ignored', durationMinutes: 999, skip: true },
            ],
        };
        const reordered = {
            locationId: 'location-1',
            breaks: [
                { type: 'break1' as const, skip: true },
                first.breaks[0],
            ],
        };

        expect(shiftBreakUpdateRequestHash(first)).toBe(shiftBreakUpdateRequestHash(reordered));
        expect(shiftBreakUpdateRequestHash(first)).not.toBe(shiftBreakUpdateRequestHash({
            ...first,
            breaks: [{ ...first.breaks[0], durationMinutes: 45 }],
        }));
    });
});
