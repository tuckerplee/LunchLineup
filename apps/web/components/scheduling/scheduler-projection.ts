export type DailyWindowSegment = {
  dayIndex: number;
  segmentStart: Date;
  segmentEnd: Date;
  leftHours: number;
  durationHours: number;
};

export type SchedulerTimelineViewMode = 'day' | 'threeDay' | 'week';

export type SchedulerTimelineLayout = {
  hourWidth: number;
  timelineWidth: number;
  allowsHorizontalScroll: boolean;
};

export const SCHEDULER_DESKTOP_FIT_MIN_WIDTH = 640;

const SCROLL_HOUR_WIDTH: Record<SchedulerTimelineViewMode, number> = {
  day: 70,
  threeDay: 48,
  week: 24,
};

const HOUR_MS = 3_600_000;

export function resolveSchedulerTimelineLayout(
  viewMode: SchedulerTimelineViewMode,
  viewportWidth: number,
  totalHours: number,
): SchedulerTimelineLayout {
  const usableViewportWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const usableTotalHours = Number.isFinite(totalHours) ? Math.max(1, totalHours) : 1;
  const fitsDesktopViewport = viewMode !== 'week'
    && usableViewportWidth >= SCHEDULER_DESKTOP_FIT_MIN_WIDTH;
  const hourWidth = fitsDesktopViewport
    ? usableViewportWidth / usableTotalHours
    : SCROLL_HOUR_WIDTH[viewMode];

  return {
    hourWidth,
    timelineWidth: fitsDesktopViewport ? usableViewportWidth : usableTotalHours * hourWidth,
    allowsHorizontalScroll: !fitsDesktopViewport,
  };
}

function sameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export function projectIntervalIntoDailyWindows(
  start: Date,
  end: Date,
  dayStarts: Date[],
  minHour: number,
  maxHour: number,
): DailyWindowSegment[] {
  if (!(end > start) || maxHour <= minHour) return [];
  const hoursPerDay = maxHour - minHour;
  const segments: DailyWindowSegment[] = [];

  dayStarts.forEach((day, dayIndex) => {
    const windowStart = new Date(day);
    windowStart.setHours(minHour, 0, 0, 0);
    const windowEnd = new Date(day);
    windowEnd.setHours(maxHour, 0, 0, 0);
    const segmentStart = start > windowStart ? start : windowStart;
    const segmentEnd = end < windowEnd ? end : windowEnd;
    if (!(segmentEnd > segmentStart)) return;

    segments.push({
      dayIndex,
      segmentStart,
      segmentEnd,
      leftHours: dayIndex * hoursPerDay + (segmentStart.getTime() - windowStart.getTime()) / HOUR_MS,
      durationHours: (segmentEnd.getTime() - segmentStart.getTime()) / HOUR_MS,
    });
  });

  if (segments.length === 0) {
    const startDayIndex = dayStarts.findIndex((day) => sameLocalDate(day, start));
    const endDayIndex = dayStarts.findIndex((day) => sameLocalDate(day, end));
    const dayIndex = startDayIndex >= 0 ? startDayIndex : endDayIndex;
    if (dayIndex >= 0) {
      const dayStart = new Date(dayStarts[dayIndex]);
      dayStart.setHours(0, 0, 0, 0);
      const startHours = (start.getTime() - dayStart.getTime()) / HOUR_MS;
      const boundaryOffset = startDayIndex >= 0 && startHours >= maxHour
        ? hoursPerDay - 0.25
        : 0;
      segments.push({
        dayIndex,
        segmentStart: start,
        segmentEnd: end,
        leftHours: dayIndex * hoursPerDay + boundaryOffset,
        durationHours: 0.25,
      });
    }
  }

  return segments;
}

export function timelineOffsetForDate(
  value: Date,
  dayStarts: Date[],
  minHour: number,
  maxHour: number,
): number | null {
  const dayIndex = dayStarts.findIndex((day) => sameLocalDate(day, value));
  if (dayIndex < 0) return null;
  const hoursPerDay = maxHour - minHour;
  const windowStart = new Date(dayStarts[dayIndex]);
  windowStart.setHours(minHour, 0, 0, 0);
  const hours = (value.getTime() - windowStart.getTime()) / HOUR_MS;
  return dayIndex * hoursPerDay + Math.max(0, Math.min(hoursPerDay, hours));
}

export function dateForTimelineOffset(
  offsetHours: number,
  dayStarts: Date[],
  minHour: number,
  maxHour: number,
): Date {
  if (dayStarts.length === 0) throw new Error('At least one timeline day is required.');
  const hoursPerDay = maxHour - minHour;
  const bounded = Math.max(0, Math.min(dayStarts.length * hoursPerDay, offsetHours));
  const dayIndex = Math.min(dayStarts.length - 1, Math.floor(bounded / hoursPerDay));
  const hourInDay = dayIndex === dayStarts.length - 1 && bounded === dayStarts.length * hoursPerDay
    ? hoursPerDay
    : bounded - dayIndex * hoursPerDay;
  const result = new Date(dayStarts[dayIndex]);
  const wholeHours = Math.floor(hourInDay);
  const minutes = Math.round((hourInDay - wholeHours) * 60);
  result.setHours(minHour + wholeHours, minutes, 0, 0);
  return result;
}
