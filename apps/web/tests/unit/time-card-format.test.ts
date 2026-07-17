import { describe, expect, it } from 'vitest';
import {
    formatTimeCardDuration,
    formatTimeCardTimestamp,
    timeCardInstantToLocalInput,
    timeCardLocalInputCandidates,
} from '../../app/dashboard/time-cards/time-card-format';

describe('formatTimeCardDuration', () => {
    it('formats minute-only and hour durations consistently', () => {
        expect(formatTimeCardDuration(0)).toBe('0m');
        expect(formatTimeCardDuration(45)).toBe('45m');
        expect(formatTimeCardDuration(75)).toBe('1h 15m');
    });

    it('clamps invalid negative durations to zero minutes', () => {
        expect(formatTimeCardDuration(-8)).toBe('0m');
    });
    it('formats punches in the location timezone instead of the browser timezone', () => {
        expect(formatTimeCardTimestamp(
            '2026-07-09T16:30:00.000Z',
            'America/Los_Angeles',
        )).toContain('9:30 AM');
        expect(formatTimeCardTimestamp(
            '2026-07-09T16:30:00.000Z',
            'America/New_York',
        )).toContain('12:30 PM');
        expect(timeCardInstantToLocalInput(
            '2026-07-09T16:30:00.000Z',
            'America/Los_Angeles',
        )).toBe('2026-07-09T09:30');
    });

    it('preserves both UTC instants during the repeated DST hour', () => {
        expect(timeCardLocalInputCandidates(
            '2026-11-01T01:30',
            'America/Los_Angeles',
        )).toEqual([
            '2026-11-01T08:30:00.000Z',
            '2026-11-01T09:30:00.000Z',
        ]);
        expect(formatTimeCardTimestamp(
            '2026-11-01T08:30:00.000Z',
            'America/Los_Angeles',
        )).toContain('PDT');
        expect(formatTimeCardTimestamp(
            '2026-11-01T09:30:00.000Z',
            'America/Los_Angeles',
        )).toContain('PST');
    });

    it('rejects a local timestamp skipped by the DST transition', () => {
        expect(() => timeCardLocalInputCandidates(
            '2026-03-08T02:30',
            'America/Los_Angeles',
        )).toThrow('does not exist');
    });
});
