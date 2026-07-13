import { describe, expect, it } from 'vitest';
import {
  dateForTimelineOffset,
  projectIntervalIntoDailyWindows,
  timelineOffsetForDate,
} from '../../components/scheduling/scheduler-projection';

const days = Array.from({ length: 7 }, (_, index) => new Date(2026, 6, 6 + index));

describe('compact scheduler projection', () => {
  it('places day-two opening time after one compact day', () => {
    const start = new Date(2026, 6, 7, 9);
    const [segment] = projectIntervalIntoDailyWindows(start, new Date(2026, 6, 7, 10), days, 9, 22);
    expect(segment).toMatchObject({ dayIndex: 1, leftHours: 13, durationHours: 1 });
    expect(dateForTimelineOffset(13, days, 9, 22)).toEqual(start);
  });

  it('keeps a late Sunday shift inside the seven-day range', () => {
    const [segment] = projectIntervalIntoDailyWindows(
      new Date(2026, 6, 12, 21),
      new Date(2026, 6, 12, 22),
      days,
      9,
      22,
    );
    expect(segment).toMatchObject({ dayIndex: 6, leftHours: 90, durationHours: 1 });
  });

  it('clips an overnight shift into each visible daily window', () => {
    const segments = projectIntervalIntoDailyWindows(
      new Date(2026, 6, 6, 21),
      new Date(2026, 6, 7, 10),
      days,
      9,
      22,
    );
    expect(segments.map(({ dayIndex, leftHours, durationHours }) => ({ dayIndex, leftHours, durationHours }))).toEqual([
      { dayIndex: 0, leftHours: 12, durationHours: 1 },
      { dayIndex: 1, leftHours: 13, durationHours: 1 },
    ]);
  });

  it('keeps a fully after-hours overnight shift visible at the day boundary', () => {
    const [segment] = projectIntervalIntoDailyWindows(
      new Date(2026, 6, 6, 22),
      new Date(2026, 6, 7, 2),
      days,
      9,
      22,
    );
    expect(segment).toMatchObject({ dayIndex: 0, leftHours: 12.75, durationHours: 0.25 });
  });
  it('round-trips visible compact offsets without the hidden overnight gap', () => {
    const value = new Date(2026, 6, 8, 15, 30);
    const offset = timelineOffsetForDate(value, days, 9, 22);
    expect(offset).toBe(32.5);
    expect(dateForTimelineOffset(offset!, days, 9, 22)).toEqual(value);
  });
});
