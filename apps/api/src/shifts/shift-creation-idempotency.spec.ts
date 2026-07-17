import { describe, expect, it } from 'vitest';
import {
    normalizeShiftCreationIdempotencyKey,
    shiftCreationOperationId,
    shiftCreationRequestHash,
} from './shift-creation-idempotency';

describe('shift creation idempotency', () => {
    it('requires a bounded printable key', () => {
        expect(() => normalizeShiftCreationIdempotencyKey(undefined)).toThrow('Idempotency-Key header is required');
        expect(() => normalizeShiftCreationIdempotencyKey(`key-${'x'.repeat(252)}`)).toThrow('255 printable');
        expect(() => normalizeShiftCreationIdempotencyKey('key\nvalue')).toThrow('255 printable');
        expect(normalizeShiftCreationIdempotencyKey(' shift-create-1 ')).toBe('shift-create-1');
    });

    it('scopes operation identity to the tenant without retaining the raw key', () => {
        const operationId = shiftCreationOperationId('tenant-1', 'shift-create-1');
        expect(operationId).toHaveLength(64);
        expect(operationId).not.toContain('shift-create-1');
        expect(operationId).not.toBe(shiftCreationOperationId('tenant-2', 'shift-create-1'));
    });

    it('hashes the complete canonical create request', () => {
        const request = {
            locationId: 'loc-1',
            scheduleId: 'schedule-1',
            userId: null,
            startTime: '2026-03-10T17:00:00.000Z',
            endTime: '2026-03-10T21:00:00.000Z',
            role: 'CASHIER',
        };
        expect(shiftCreationRequestHash(request)).toBe(shiftCreationRequestHash({ ...request }));
        expect(shiftCreationRequestHash(request)).not.toBe(shiftCreationRequestHash({
            ...request,
            role: 'COOK',
        }));
    });
});
