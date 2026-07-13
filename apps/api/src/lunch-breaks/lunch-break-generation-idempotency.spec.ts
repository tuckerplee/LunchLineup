import { describe, expect, it } from 'vitest';
import {
    hashLunchBreakGenerationIdempotencyKey,
    lunchBreakGenerationRequestHash,
    normalizeLunchBreakGenerationIdempotencyKey,
} from './lunch-break-generation-idempotency';

describe('lunch-break generation idempotency', () => {
    it('requires a bounded printable Idempotency-Key', () => {
        expect(() => normalizeLunchBreakGenerationIdempotencyKey(undefined)).toThrow('Idempotency-Key header is required');
        expect(() => normalizeLunchBreakGenerationIdempotencyKey('bad\nkey')).toThrow('printable characters');
        expect(normalizeLunchBreakGenerationIdempotencyKey(' attempt-1 ')).toBe('attempt-1');
    });

    it('hashes keys and canonical request objects deterministically', () => {
        expect(hashLunchBreakGenerationIdempotencyKey('attempt-1')).toHaveLength(64);
        expect(lunchBreakGenerationRequestHash({
            persist: true,
            policy: { lunchDurationMinutes: 30, timeStepMinutes: 5 },
            shiftIds: ['shift-1'],
        })).toBe(lunchBreakGenerationRequestHash({
            shiftIds: ['shift-1'],
            policy: { timeStepMinutes: 5, lunchDurationMinutes: 30 },
            persist: true,
        }));
    });
});
