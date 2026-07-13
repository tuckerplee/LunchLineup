import { describe, expect, it } from 'vitest';
import {
  lunchBreakDayWindow,
  lunchBreakShiftRange,
  lunchBreakTimeValue,
  resolveLunchBreakInstant,
} from '../../app/dashboard/lunch-breaks/lunch-break-time';

describe('lunch break location time helpers', () => {
  it('queries the selected location calendar day across DST', () => {
    expect(lunchBreakDayWindow('2026-03-08', 'America/Los_Angeles')).toEqual({
      startIso: '2026-03-08T08:00:00.000Z',
      endIso: '2026-03-09T07:00:00.000Z',
    });
  });

  it('persists wall-clock setup shifts in the selected location timezone', () => {
    expect(lunchBreakShiftRange('2026-07-09', '09:00', '17:00', 'America/Los_Angeles')).toEqual({
      startIso: '2026-07-09T16:00:00.000Z',
      endIso: '2026-07-10T00:00:00.000Z',
    });
  });

  it('keeps overnight shifts on local calendar boundaries', () => {
    const range = lunchBreakShiftRange('2026-11-01', '22:00', '02:00', 'America/Los_Angeles');
    expect(range).toEqual({
      startIso: '2026-11-02T06:00:00.000Z',
      endIso: '2026-11-02T10:00:00.000Z',
    });
    expect(resolveLunchBreakInstant(range!.startIso, range!.endIso, '01:30', 'America/Los_Angeles')).toBe(
      '2026-11-02T09:30:00.000Z',
    );
    expect(lunchBreakTimeValue(range!.startIso, 'America/Los_Angeles')).toBe('22:00');
  });
});
