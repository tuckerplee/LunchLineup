import {
  dateValueInTimeZone,
  localDateBoundaryUtc,
  normalizeTimeZone,
} from "../common/location-timezone";

export type ExistingWeeklyMinutes = Record<string, Record<string, number>>;

export type ExistingShiftRange = {
  userId: string | null;
  startTime: Date | string;
  endTime: Date | string;
};

export type CalendarWeekRange = {
  start: Date;
  end: Date;
  weekStarts: Array<{ date: string; start: Date; end: Date }>;
};

export function calendarWeekRange(
  startValue: Date | string,
  endValue: Date | string,
  timeZoneValue: unknown,
): CalendarWeekRange {
  const timeZone = normalizeTimeZone(timeZoneValue);
  const start = requiredDate(startValue);
  const end = requiredDate(endValue);
  if (end <= start)
    throw new Error("Calendar week range end must be after start.");

  const firstWeekDate = mondayDate(dateValueInTimeZone(start, timeZone));
  const weekStarts: CalendarWeekRange["weekStarts"] = [];
  let weekDate = firstWeekDate;
  while (localDateBoundaryUtc(weekDate, timeZone) < end) {
    const nextWeekDate = addDateValues(weekDate, 7);
    weekStarts.push({
      date: weekDate,
      start: localDateBoundaryUtc(weekDate, timeZone),
      end: localDateBoundaryUtc(nextWeekDate, timeZone),
    });
    weekDate = nextWeekDate;
  }

  return {
    start: weekStarts[0].start,
    end: weekStarts[weekStarts.length - 1].end,
    weekStarts,
  };
}

export function aggregateExistingWeeklyMinutes(
  shifts: ExistingShiftRange[],
  weeks: CalendarWeekRange,
  staffIds: string[],
): ExistingWeeklyMinutes {
  const allowedStaff = new Set(staffIds);
  const totals: ExistingWeeklyMinutes = {};

  for (const shift of shifts) {
    if (!shift.userId || !allowedStaff.has(shift.userId)) continue;
    const shiftStart = requiredDate(shift.startTime);
    const shiftEnd = requiredDate(shift.endTime);
    if (shiftEnd <= shiftStart) continue;

    for (const week of weeks.weekStarts) {
      const overlapStart = Math.max(shiftStart.getTime(), week.start.getTime());
      const overlapEnd = Math.min(shiftEnd.getTime(), week.end.getTime());
      if (overlapEnd <= overlapStart) continue;
      const minutes = Math.round((overlapEnd - overlapStart) / 60_000);
      const staffWeeks = totals[shift.userId] ?? {};
      staffWeeks[week.date] = (staffWeeks[week.date] ?? 0) + minutes;
      totals[shift.userId] = staffWeeks;
    }
  }

  return totals;
}

function mondayDate(dateValue: string): string {
  const date = parseDateValue(dateValue);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayOffset);
  return formatDateValue(date);
}

function addDateValues(dateValue: string, days: number): string {
  const date = parseDateValue(dateValue);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateValue(date);
}

function parseDateValue(dateValue: string): Date {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Invalid calendar date.");
  return date;
}

function formatDateValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function requiredDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("Invalid shift date/time.");
  return date;
}
