import type { SchedulerView } from '@lunchlineup/api-contract';
import { ProblemError } from '../platform/problem';

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function normalizeTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value;
  } catch {
    throw new ProblemError(
      500,
      'invalid_location_timezone',
      'The selected location has an invalid timezone.',
      'Location configuration error',
    );
  }
}

function parseLocalDate(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new ProblemError(422, 'invalid_local_date', 'Date must use YYYY-MM-DD.', 'Invalid date');
  }
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (
    calendar.getUTCFullYear() !== parts[0]
    || calendar.getUTCMonth() !== parts[1] - 1
    || calendar.getUTCDate() !== parts[2]
  ) {
    throw new ProblemError(422, 'invalid_local_date', 'Date is not a valid calendar day.', 'Invalid date');
  }
  return parts;
}

function datePlusDays(value: string, days: number): string {
  const [year, month, day] = parseLocalDate(value);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
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

function localMidnight(value: string, timeZone: string): Date {
  const [year, month, day] = parseLocalDate(value);
  const target: ZonedParts = { year, month, day, hour: 0, minute: 0, second: 0 };
  const targetUtc = Date.UTC(year, month - 1, day);
  let guess = targetUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const delta = targetUtc - Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    guess += delta;
    if (delta === 0) break;
  }
  const result = new Date(guess);
  const actual = zonedParts(result, timeZone);
  if (Object.keys(target).some((key) => actual[key as keyof ZonedParts] !== target[key as keyof ZonedParts])) {
    throw new ProblemError(
      422,
      'invalid_local_date',
      'The selected local date cannot be represented in the location timezone.',
      'Invalid date',
    );
  }
  return result;
}

export function boardRange(date: string, view: SchedulerView, timeZoneValue: string): { start: Date; end: Date } {
  const timeZone = normalizeTimeZone(timeZoneValue);
  const days = view === 'day' ? 1 : view === 'threeDay' ? 3 : 7;
  return {
    start: localMidnight(date, timeZone),
    end: localMidnight(datePlusDays(date, days), timeZone),
  };
}
