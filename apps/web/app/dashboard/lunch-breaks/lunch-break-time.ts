import {
  addLocalDays,
  dateValueInTimeZone,
  formatTimeInTimeZone,
  localDateRange,
  unambiguousLocalDateTimeToIso,
  timeValueInTimeZone,
} from '../../../lib/location-timezone';

export type LunchBreakShiftDayOffset = 0 | 1;

export type LunchBreakShiftDraft = {
  dateValue: string;
  startTime: string;
  endTime: string;
  endDayOffset: LunchBreakShiftDayOffset;
};

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

export function lunchBreakShiftDraft(
  startIso: string,
  endIso: string,
  timeZone: string,
): LunchBreakShiftDraft | null {
  try {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

    const dateValue = dateValueInTimeZone(startIso, timeZone);
    const endDateValue = dateValueInTimeZone(endIso, timeZone);
    const endDayOffset: LunchBreakShiftDayOffset | null = endDateValue === dateValue
      ? 0
      : endDateValue === addLocalDays(dateValue, 1)
        ? 1
        : null;
    if (endDayOffset === null) return null;

    return {
      dateValue,
      startTime: timeValueInTimeZone(startIso, timeZone),
      endTime: timeValueInTimeZone(endIso, timeZone),
      endDayOffset,
    };
  } catch {
    return null;
  }
}

export function resolveLunchBreakInstant(
  startIso: string,
  endIso: string,
  timeValue: string,
  timeZone: string,
  originalStartIso?: string | null,
): string | null {
  try {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

    const startDate = dateValueInTimeZone(startIso, timeZone);
    // A persisted instant identifies the occurrence of a repeated wall clock.
    // Retain that occurrence only while the edited clock still matches and the
    // authoritative instant belongs to this shift's actual calendar interval.
    if (originalStartIso) {
      const originalMs = new Date(originalStartIso).getTime();
      if (Number.isFinite(originalMs) && originalMs >= startMs && originalMs < endMs) {
        const originalDate = dateValueInTimeZone(originalStartIso, timeZone);
        if (originalDate >= startDate
          && originalDate <= dateValueInTimeZone(endIso, timeZone)
          && timeValueInTimeZone(originalStartIso, timeZone) === timeValue) {
          return new Date(originalMs).toISOString();
        }
      }
    }
    // Choose the shift's local day before resolving the wall clock. An overnight
    // break may be unambiguous tomorrow even when today's clock repeats it.
    const breakDate = timeValue < timeValueInTimeZone(startIso, timeZone)
      ? addLocalDays(startDate, 1)
      : startDate;
    const candidate = unambiguousLocalDateTimeToIso(breakDate, timeValue, timeZone);
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
  endDayOffset: LunchBreakShiftDayOffset,
  timeZone: string,
): { startIso: string; endIso: string } | null {
  try {
    if (endDayOffset !== 0 && endDayOffset !== 1) return null;
    const startIso = unambiguousLocalDateTimeToIso(dateValue, startTime, timeZone);
    const endIso = unambiguousLocalDateTimeToIso(addLocalDays(dateValue, endDayOffset), endTime, timeZone);
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) return null;
    return { startIso, endIso };
  } catch {
    return null;
  }
}
