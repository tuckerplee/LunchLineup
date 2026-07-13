import {
  addLocalDays,
  dateValueInTimeZone,
  localDateTimeToIso,
  timeValueInTimeZone,
} from '../../../lib/location-timezone';

export type LocalTimeWindow = {
  date: string;
  startTime: string;
  endTime: string;
};

export type SerializedTimeWindow = {
  startTime: string;
  endTime: string;
};

export function serializeLocalTimeWindow(window: LocalTimeWindow, timeZone: string): SerializedTimeWindow {
  const startTime = unambiguousLocalDateTimeToIso(window.date, window.startTime, timeZone);
  if (window.endTime === window.startTime) {
    throw new Error('End time must be after start time.');
  }

  const endDate = window.endTime < window.startTime ? addLocalDays(window.date, 1) : window.date;
  const endTime = unambiguousLocalDateTimeToIso(endDate, window.endTime, timeZone);
  return { startTime, endTime };
}

function unambiguousLocalDateTimeToIso(date: string, time: string, timeZone: string): string {
  const iso = localDateTimeToIso(date, time, timeZone);
  const instant = new Date(iso);
  const ambiguous = [30, 60, 90, 120].some((minutes) => (
    matchesWallTime(new Date(instant.getTime() - minutes * 60_000), date, time, timeZone)
    || matchesWallTime(new Date(instant.getTime() + minutes * 60_000), date, time, timeZone)
  ));
  if (ambiguous) {
    throw new Error('Local date/time is ambiguous during the daylight-saving fallback. Choose a different time.');
  }
  return iso;
}

function matchesWallTime(instant: Date, date: string, time: string, timeZone: string): boolean {
  return dateValueInTimeZone(instant, timeZone) === date
    && timeValueInTimeZone(instant, timeZone) === time;
}

export function localTimeWindowFromInstants(
  startTime: string,
  endTime: string,
  timeZone: string,
): LocalTimeWindow {
  return {
    date: dateValueInTimeZone(startTime, timeZone),
    startTime: timeValueInTimeZone(startTime, timeZone),
    endTime: timeValueInTimeZone(endTime, timeZone),
  };
}
