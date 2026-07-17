import { describe, expect, it } from 'vitest';
import {
  dateValueInTimeZone,
  localDateRange,
  localDateTimeToIso,
  timeValueInTimeZone,
  unambiguousLocalDateTimeToIso,
  wallClockDateToIso,
} from '../../lib/location-timezone';

describe('web location timezone helpers', () => {
  it('builds local-day query ranges across DST', () => {
    expect(localDateRange('2026-03-08', 1, 'America/Los_Angeles')).toEqual({
      start: '2026-03-08T08:00:00.000Z',
      end: '2026-03-09T07:00:00.000Z',
    });
  });

  it('round trips location wall clock values to UTC persistence', () => {
    const iso = localDateTimeToIso('2026-07-09', '09:30', 'America/Los_Angeles');
    expect(iso).toBe('2026-07-09T16:30:00.000Z');
    expect(dateValueInTimeZone(iso, 'America/Los_Angeles')).toBe('2026-07-09');
    expect(timeValueInTimeZone(iso, 'America/Los_Angeles')).toBe('09:30');
  });

  it('rejects nonexistent and repeated location wall times before persistence', () => {
    expect(() => unambiguousLocalDateTimeToIso('2026-03-08', '02:30', 'America/Los_Angeles'))
      .toThrow('does not exist');
    expect(() => unambiguousLocalDateTimeToIso('2026-11-01', '01:30', 'America/Los_Angeles'))
      .toThrow('ambiguous during the daylight-saving fallback');
    expect(() => wallClockDateToIso(new Date(2026, 10, 1, 1, 30), 'America/Los_Angeles'))
      .toThrow('ambiguous during the daylight-saving fallback');
  });
});
