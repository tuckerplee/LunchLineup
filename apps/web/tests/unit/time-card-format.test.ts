import { describe, expect, it } from 'vitest';
import { formatTimeCardDuration } from '../../app/dashboard/time-cards/time-card-format';

describe('formatTimeCardDuration', () => {
    it('formats minute-only and hour durations consistently', () => {
        expect(formatTimeCardDuration(0)).toBe('0m');
        expect(formatTimeCardDuration(45)).toBe('45m');
        expect(formatTimeCardDuration(75)).toBe('1h 15m');
    });

    it('clamps invalid negative durations to zero minutes', () => {
        expect(formatTimeCardDuration(-8)).toBe('0m');
    });
});
