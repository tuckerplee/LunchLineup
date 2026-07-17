import { describe, expect, it } from 'vitest';
import {
    normalizeShiftUpdateIdempotencyKey,
    shiftUpdateOperationId,
    shiftUpdateRequestHash,
} from './shift-update-idempotency';

describe('shift update idempotency', () => {
    it('requires a bounded printable key', () => {
        expect(() => normalizeShiftUpdateIdempotencyKey(undefined)).toThrow('Idempotency-Key header is required');
        expect(() => normalizeShiftUpdateIdempotencyKey(`key-${'x'.repeat(252)}`)).toThrow('255 printable');
        expect(() => normalizeShiftUpdateIdempotencyKey('key\nvalue')).toThrow('255 printable');
        expect(normalizeShiftUpdateIdempotencyKey(' shift-update-1 ')).toBe('shift-update-1');
    });

    it('scopes the stable operation identity to the tenant and mutation type', () => {
        const operationId = shiftUpdateOperationId('tenant-1', 'shift-update-1');
        expect(operationId).toHaveLength(64);
        expect(operationId).not.toContain('shift-update-1');
        expect(operationId).not.toBe(shiftUpdateOperationId('tenant-2', 'shift-update-1'));
    });

    it('hashes normalized update semantics including the target shift', () => {
        const request = {
            shiftId: 'shift-1',
            userId: null,
            startTime: '2026-03-10T17:00:00.000Z',
            endTime: '2026-03-10T21:00:00.000Z',
        };
        expect(shiftUpdateRequestHash(request)).toBe(shiftUpdateRequestHash({ ...request }));
        expect(shiftUpdateRequestHash(request)).not.toBe(shiftUpdateRequestHash({
            ...request,
            shiftId: 'shift-2',
        }));
        expect(shiftUpdateRequestHash(request)).not.toBe(shiftUpdateRequestHash({
            ...request,
            userId: 'user-1',
        }));
    });
});
