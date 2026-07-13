export const DEFAULT_LOCATION_TIME_ZONE = 'America/New_York';

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function safeTimeZone(value: unknown): string {
  const timeZone = typeof value === 'string' ? value.trim() : '';
  if (!timeZone) return DEFAULT_LOCATION_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    return DEFAULT_LOCATION_TIME_ZONE;
  }
}

export function addLocalDays(dateValue: string, days: number): string {
  const [year, month, day] = parseDateValue(dateValue);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function localDateTimeToIso(dateValue: string, timeValue: string, timeZoneValue: unknown): string {
  const [year, month, day] = parseDateValue(dateValue);
  const [hour, minute] = parseTimeValue(timeValue);
  return zonedDateTimeToUtc({ year, month, day, hour, minute, second: 0 }, safeTimeZone(timeZoneValue)).toISOString();
}

export function localDateRange(dateValue: string, days: number, timeZoneValue: unknown) {
  return {
    start: localDateTimeToIso(dateValue, '00:00', timeZoneValue),
    end: localDateTimeToIso(addLocalDays(dateValue, days), '00:00', timeZoneValue),
  };
}

export function dateValueInTimeZone(value: Date | string, timeZoneValue: unknown): string {
  const parts = zonedParts(requiredDate(value), safeTimeZone(timeZoneValue));
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function timeValueInTimeZone(value: Date | string, timeZoneValue: unknown): string {
  const parts = zonedParts(requiredDate(value), safeTimeZone(timeZoneValue));
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatDateInTimeZone(value: Date | string, timeZoneValue: unknown, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZoneValue),
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(requiredDate(value));
}

export function formatTimeInTimeZone(value: Date | string, timeZoneValue: unknown, hour12 = true): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZoneValue),
    hour: 'numeric',
    minute: '2-digit',
    hour12,
  }).format(requiredDate(value));
}

export function instantToWallClockDate(value: Date | string, timeZoneValue: unknown): Date {
  const parts = zonedParts(requiredDate(value), safeTimeZone(timeZoneValue));
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
}

export function wallClockDateToIso(value: Date, timeZoneValue: unknown): string {
  return zonedDateTimeToUtc({
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
    hour: value.getHours(),
    minute: value.getMinutes(),
    second: value.getSeconds(),
  }, safeTimeZone(timeZoneValue)).toISOString();
}

function zonedDateTimeToUtc(target: ZonedParts, timeZone: string): Date {
  const targetUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  const calendar = new Date(targetUtc);
  if (calendar.getUTCFullYear() !== target.year || calendar.getUTCMonth() + 1 !== target.month || calendar.getUTCDate() !== target.day) {
    throw new Error('Invalid local calendar date.');
  }
  let guess = targetUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const delta = targetUtc - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += delta;
    if (delta === 0) break;
  }
  const result = new Date(guess);
  const actual = zonedParts(result, timeZone);
  if (Object.keys(target).some((key) => actual[key as keyof ZonedParts] !== target[key as keyof ZonedParts])) {
    throw new Error('Local date/time does not exist in the location timezone.');
  }
  return result;
}

function zonedParts(value: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.get('year')),
    month: Number(map.get('month')),
    day: Number(map.get('day')),
    hour: Number(map.get('hour')),
    minute: Number(map.get('minute')),
    second: Number(map.get('second')),
  };
}

function parseDateValue(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('Date must use YYYY-MM-DD.');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseTimeValue(value: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Time must use HH:MM.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error('Time is outside the valid range.');
  return [hour, minute];
}

function requiredDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date/time value.');
  return date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
