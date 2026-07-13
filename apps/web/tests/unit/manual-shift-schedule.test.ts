import { describe, expect, it } from 'vitest';
import {
  containingDraftScheduleForShift,
  fallbackDraftWindowForShift,
} from '../../app/dashboard/scheduling/manual-shift-schedule';

describe('manual shift schedule selection', () => {
  it('selects the weekly draft containing the complete overnight interval', () => {
    const weeklyDraft = {
      id: 'schedule-week',
      locationId: 'loc-1',
      startDate: '2026-07-06T04:00:00.000Z',
      endDate: '2026-07-13T04:00:00.000Z',
      status: 'DRAFT',
    };

    expect(containingDraftScheduleForShift(
      [weeklyDraft],
      'loc-1',
      '2026-07-12T02:00:00.000Z',
      '2026-07-12T06:00:00.000Z',
    )).toBe(weeklyDraft);
  });

  it('does not select a draft that ends before the overnight shift', () => {
    expect(containingDraftScheduleForShift([{
      id: 'schedule-day',
      locationId: 'loc-1',
      startDate: '2026-07-11T04:00:00.000Z',
      endDate: '2026-07-12T04:00:00.000Z',
      status: 'DRAFT',
    }], 'loc-1', '2026-07-12T02:00:00.000Z', '2026-07-12T06:00:00.000Z')).toBeNull();
  });

  it('derives a DST-aware two-day fallback window for an overnight shift', () => {
    expect(fallbackDraftWindowForShift(
      '2026-03-08T03:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
      'America/New_York',
    )).toEqual({
      start: '2026-03-07T05:00:00.000Z',
      end: '2026-03-09T04:00:00.000Z',
    });
  });
});
