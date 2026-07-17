import { describe, expect, it } from 'vitest';
import {
  assertAvailabilityWindow,
  availabilityTime,
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
});
