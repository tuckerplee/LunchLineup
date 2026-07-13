import { describe, expect, it } from 'vitest';
import {
    dateValueInTimeZone,
    localDateBoundaryUtc,
    splitInstantRangeByLocalDay,
} from './location-timezone';

describe('location timezone helpers', () => {
    it('converts date-only boundaries through DST in the location timezone', () => {
        expect(localDateBoundaryUtc('2026-03-08', 'America/Los_Angeles').toISOString())
            .toBe('2026-03-08T08:00:00.000Z');
        expect(localDateBoundaryUtc('2026-03-09', 'America/Los_Angeles').toISOString())
            .toBe('2026-03-09T07:00:00.000Z');
    });

    it('derives the local calendar date from a UTC instant', () => {
        expect(dateValueInTimeZone('2026-03-10T06:30:00.000Z', 'America/Los_Angeles'))
            .toBe('2026-03-09');
    });

    it('splits an overnight range across local weekdays', () => {
        expect(splitInstantRangeByLocalDay(
            '2026-03-10T06:00:00.000Z',
            '2026-03-10T10:00:00.000Z',
            'America/Los_Angeles',
        )).toEqual([
            { weekday: 'Monday', startMinutes: 1380, endMinutes: 1440 },
            { weekday: 'Tuesday', startMinutes: 0, endMinutes: 180 },
        ]);
    });
});
