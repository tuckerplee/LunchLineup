import { describe, expect, it } from 'vitest';
import {
    normalizeTimeCardIdempotencyKey,
    timeCardClockInOperationId,
    timeCardClockInRequestHash,
} from './time-card-idempotency';

describe('time-card clock-in idempotency', () => {
    it('requires a bounded printable Idempotency-Key', () => {
        expect(() => normalizeTimeCardIdempotencyKey(undefined)).toThrow('Idempotency-Key header is required');
        expect(() => normalizeTimeCardIdempotencyKey('bad\nkey')).toThrow('printable characters');
        expect(normalizeTimeCardIdempotencyKey(' clock-in-1 ')).toBe('clock-in-1');
    });

    it('scopes operation identity by tenant and hashes stable request input', () => {
        expect(timeCardClockInOperationId('tenant-1', 'clock-in-1')).toHaveLength(64);
        expect(timeCardClockInOperationId('tenant-1', 'clock-in-1')).not.toBe(
            timeCardClockInOperationId('tenant-2', 'clock-in-1'),
        );
        const request = {
            actorUserId: 'manager-1',
            targetUserId: 'staff-1',
            locationId: null,
            shiftId: null,
            clockInAt: null,
            notes: null,
        };
        expect(timeCardClockInRequestHash(request)).toBe(timeCardClockInRequestHash(request));
    });
});
