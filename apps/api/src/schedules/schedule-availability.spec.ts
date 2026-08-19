import { describe, expect, it } from 'vitest';
import {
  assertAvailabilityWindow,
  availabilityTime,
  availabilityWithExceptionsCoversLocalSegment,
  availabilityWindowCoversLocalSegment,
  availabilityWindowsCoverLocalSegment,
} from './schedule-availability';

describe('schedule availability windows', () => {
  it('covers an overnight window through midnight without a 1440 endpoint', () => {
    const throughMidnight = { dayOfWeek: 1, startTimeMinutes: 1320, endTimeMinutes: 0 };
    expect(() => assertAvailabilityWindow(throughMidnight)).not.toThrow();
    expect(availabilityTime(throughMidnight.endTimeMinutes, 'end')).toBe('00:00');
    expect(availabilityWindowCoversLocalSegment(throughMidnight, 'Monday', 1320, 1440)).toBe(true);
    expect(availabilityWindowCoversLocalSegment(throughMidnight, 'Tuesday', 0, 1)).toBe(false);
  });

  it('covers the next-day portion of a bounded overnight window', () => {
    const overnight = { dayOfWeek: 1, startTimeMinutes: 1320, endTimeMinutes: 120 };
    expect(availabilityWindowCoversLocalSegment(overnight, 'Tuesday', 0, 120)).toBe(true);
  });

  it('treats touching and overlapping windows as continuous coverage without crossing gaps', () => {
    const windows = [
      { dayOfWeek: 1, startTimeMinutes: 9 * 60, endTimeMinutes: 12 * 60 },
      { dayOfWeek: 1, startTimeMinutes: 12 * 60, endTimeMinutes: 14 * 60 },
      { dayOfWeek: 1, startTimeMinutes: 13 * 60, endTimeMinutes: 17 * 60 },
    ];

    expect(availabilityWindowsCoverLocalSegment(windows, 'Monday', 9 * 60, 17 * 60)).toBe(true);
    expect(availabilityWindowsCoverLocalSegment(windows, 'Monday', 8 * 60, 17 * 60)).toBe(false);
    expect(availabilityWindowsCoverLocalSegment([
      windows[0],
      { dayOfWeek: 1, startTimeMinutes: 12 * 60 + 1, endTimeMinutes: 17 * 60 },
    ], 'Monday', 9 * 60, 17 * 60)).toBe(false);
  });

  it('lets dated available windows replace the recurring rule for one local date', () => {
    const recurring = [{ dayOfWeek: 1, startTimeMinutes: 9 * 60, endTimeMinutes: 17 * 60 }];
    const exceptions = [{
      localDate: '2026-03-09',
      kind: 'AVAILABLE' as const,
      startTimeMinutes: 12 * 60,
      endTimeMinutes: 20 * 60,
    }];

    expect(availabilityWithExceptionsCoversLocalSegment(
      recurring, exceptions, '2026-03-09', 'Monday', 12 * 60, 20 * 60,
    )).toBe(true);
    expect(availabilityWithExceptionsCoversLocalSegment(
      recurring, exceptions, '2026-03-09', 'Monday', 9 * 60, 10 * 60,
    )).toBe(false);
    expect(availabilityWithExceptionsCoversLocalSegment(
      recurring, exceptions, '2026-03-16', 'Monday', 9 * 60, 17 * 60,
    )).toBe(true);
  });

  it('makes partial and all-day time off win over recurring or dated availability', () => {
    const recurring = [{ dayOfWeek: 2, startTimeMinutes: 9 * 60, endTimeMinutes: 17 * 60 }];
    const partialTimeOff = [{
      localDate: '2026-03-10',
      kind: 'UNAVAILABLE' as const,
      startTimeMinutes: 12 * 60,
      endTimeMinutes: 13 * 60,
    }];
    expect(availabilityWithExceptionsCoversLocalSegment(
      recurring, partialTimeOff, '2026-03-10', 'Tuesday', 9 * 60, 12 * 60,
    )).toBe(true);
    expect(availabilityWithExceptionsCoversLocalSegment(
      recurring, partialTimeOff, '2026-03-10', 'Tuesday', 9 * 60, 17 * 60,
    )).toBe(false);
    expect(availabilityWithExceptionsCoversLocalSegment(
      recurring,
      [
        { localDate: '2026-03-10', kind: 'AVAILABLE', startTimeMinutes: 0, endTimeMinutes: 1440 },
        { localDate: '2026-03-10', kind: 'UNAVAILABLE', startTimeMinutes: 0, endTimeMinutes: 1440 },
      ],
      '2026-03-10',
      'Tuesday',
      0,
      1440,
    )).toBe(false);
  });
});
