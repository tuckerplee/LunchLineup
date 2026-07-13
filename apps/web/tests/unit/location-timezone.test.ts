import { describe, expect, it } from 'vitest';
import { dateValueInTimeZone, localDateRange, localDateTimeToIso, timeValueInTimeZone } from '../../lib/location-timezone';

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
});
