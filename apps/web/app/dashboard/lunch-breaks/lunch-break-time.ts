import {
  addLocalDays,
  dateValueInTimeZone,
  formatTimeInTimeZone,
  localDateRange,
  localDateTimeToIso,
  timeValueInTimeZone,
} from '../../../lib/location-timezone';

export function lunchBreakDayWindow(dateValue: string, timeZone: string) {
  const range = localDateRange(dateValue, 1, timeZone);
  return { startIso: range.start, endIso: range.end };
}

export function lunchBreakTimeValue(iso: string, timeZone: string): string {
  return timeValueInTimeZone(iso, timeZone);
}

export function lunchBreakShiftLabel(startIso: string, endIso: string, timeZone: string): string {
  return `${formatTimeInTimeZone(startIso, timeZone)} - ${formatTimeInTimeZone(endIso, timeZone)}`;
}

export function resolveLunchBreakInstant(
  startIso: string,
  endIso: string,
  timeValue: string,
  timeZone: string,
): string | null {
  try {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

    const startDate = dateValueInTimeZone(startIso, timeZone);
    let candidate = localDateTimeToIso(startDate, timeValue, timeZone);
    if (new Date(candidate).getTime() < startMs) {
      candidate = localDateTimeToIso(addLocalDays(startDate, 1), timeValue, timeZone);
    }
    const candidateMs = new Date(candidate).getTime();
    return candidateMs >= startMs && candidateMs <= endMs ? candidate : null;
  } catch {
    return null;
  }
}

export function lunchBreakShiftRange(
  dateValue: string,
  startTime: string,
  endTime: string,
  timeZone: string,
): { startIso: string; endIso: string } | null {
  try {
    const startIso = localDateTimeToIso(dateValue, startTime, timeZone);
    let endIso = localDateTimeToIso(dateValue, endTime, timeZone);
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      endIso = localDateTimeToIso(addLocalDays(dateValue, 1), endTime, timeZone);
    }
    return { startIso, endIso };
  } catch {
    return null;
  }
}
