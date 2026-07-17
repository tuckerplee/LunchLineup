import {
  addLocalDays,
  dateValueInTimeZone,
  timeValueInTimeZone,
  unambiguousLocalDateTimeToIso,
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
