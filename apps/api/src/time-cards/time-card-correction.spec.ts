import { describe, expect, it } from 'vitest';
import { validateTimeCardCorrection } from './time-card-correction';

const current = {
    clockInAt: new Date('2026-07-08T15:00:00.000Z'),
    clockOutAt: new Date('2026-07-08T23:00:00.000Z'),
    breakMinutes: 30,
    updatedAt: new Date('2026-07-08T23:01:00.000Z'),
    breaks: [],
};
const now = new Date('2026-07-15T00:00:00.000Z');

describe('validateTimeCardCorrection', () => {
    it('normalizes ordered break intervals and derives the corrected totals', () => {
        const result = validateTimeCardCorrection({
            clockInAt: '2026-07-08T14:00:00.000Z',
            clockOutAt: '2026-07-08T23:00:00.000Z',
            expectedUpdatedAt: '2026-07-08T23:01:00.000Z',
            reason: 'Employee confirmed corrected punches.',
            breakIntervals: [
                { startAt: '2026-07-08T17:00:00.000Z', endAt: '2026-07-08T17:15:00.000Z' },
                { startAt: '2026-07-08T20:00:00.000Z', endAt: '2026-07-08T20:30:00.000Z' },
            ],
        }, current, now);

        expect(result.breakMinutes).toBe(45);
        expect(result.status).toBe('CLOSED');
        expect(result.breakIntervals?.map((interval) => interval.startAt.toISOString())).toEqual([
            '2026-07-08T17:00:00.000Z',
            '2026-07-08T20:00:00.000Z',
        ]);
    });

    it('preserves legacy aggregate break minutes when intervals are not being corrected', () => {
        const result = validateTimeCardCorrection({
            clockOutAt: '2026-07-08T22:30:00.000Z',
            expectedUpdatedAt: '2026-07-08T23:01:00.000Z',
            reason: 'Corrected forgotten clock out.',
        }, current, now);

        expect(result.breakIntervals).toBeNull();
        expect(result.breakMinutes).toBe(30);
    });

    it.each([
        {
            label: 'out-of-order intervals',
            intervals: [
                { startAt: '2026-07-08T20:00:00.000Z', endAt: '2026-07-08T20:30:00.000Z' },
                { startAt: '2026-07-08T17:00:00.000Z', endAt: '2026-07-08T17:15:00.000Z' },
            ],
            message: 'chronological',
        },
        {
            label: 'overlapping intervals',
            intervals: [
                { startAt: '2026-07-08T17:00:00.000Z', endAt: '2026-07-08T17:30:00.000Z' },
                { startAt: '2026-07-08T17:15:00.000Z', endAt: '2026-07-08T17:45:00.000Z' },
            ],
            message: 'cannot overlap',
        },
        {
            label: 'intervals outside the card',
            intervals: [
                { startAt: '2026-07-08T14:45:00.000Z', endAt: '2026-07-08T15:15:00.000Z' },
            ],
            message: 'inside the time-card window',
        },
    ])('rejects $label', ({ intervals, message }) => {
        expect(() => validateTimeCardCorrection({
            breakIntervals: intervals,
            expectedUpdatedAt: '2026-07-08T23:01:00.000Z',
            reason: 'Corrected break details.',
        }, current, now)).toThrow(message);
    });

    it('rejects timestamp corrections that exclude retained break intervals', () => {
        expect(() => validateTimeCardCorrection({
            clockInAt: '2026-07-08T18:15:00.000Z',
            expectedUpdatedAt: '2026-07-08T23:01:00.000Z',
            reason: 'Attempted narrow punch window.',
        }, {
            ...current,
            breaks: [{
                startAt: '2026-07-08T18:00:00.000Z',
                endAt: '2026-07-08T18:30:00.000Z',
            }],
        }, now)).toThrow('inside the time-card window');
    });
    it('rejects unreasonably long and future correction ranges', () => {
        expect(() => validateTimeCardCorrection({
            clockInAt: '2026-06-01T00:00:00.000Z',
            expectedUpdatedAt: '2026-07-08T23:01:00.000Z',
            reason: 'Attempted oversized correction.',
        }, current, now)).toThrow('31 days');

        expect(() => validateTimeCardCorrection({
            clockOutAt: '2026-07-15T00:06:00.000Z',
            expectedUpdatedAt: '2026-07-08T23:01:00.000Z',
            reason: 'Attempted future correction.',
        }, current, now)).toThrow('five minutes in the future');
    });

    it('requires a bounded reason and optimistic version', () => {
        expect(() => validateTimeCardCorrection({
            clockOutAt: '2026-07-08T22:30:00.000Z',
            expectedUpdatedAt: '2026-07-08T23:01:00.000Z',
            reason: 'no',
        }, current, now)).toThrow('between 5 and 500');

        expect(() => validateTimeCardCorrection({
            clockOutAt: '2026-07-08T22:30:00.000Z',
            reason: 'Missing expected version.',
        }, current, now)).toThrow('expectedUpdatedAt is required');
    });
});
