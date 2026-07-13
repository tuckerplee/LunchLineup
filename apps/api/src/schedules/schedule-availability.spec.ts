import { describe, expect, it } from 'vitest';
import { assertAvailabilityWindow, availabilityTime, availabilityWindowCoversLocalSegment } from './schedule-availability';

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
});
