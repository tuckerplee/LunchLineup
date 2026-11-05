import type { ScheduleBoardResponse } from '@lunchlineup/api-contract';

import {
  addLocalDays,
  dateValueInTimeZone,
  formatDateInTimeZone,
  formatTimeInTimeZone,
  safeTimeZone,
} from './location-timezone';

export type MyScheduleBoard = ScheduleBoardResponse['data'];
export type MyScheduleBreak = { startTime: string; endTime: string; paid: boolean };
export type MyShift = {
  id: string;
  locationId: string;
  locationName: string;
  timeZone: string;
  startTime: string;
  endTime: string;
  role: string | null;
  breaks: MyScheduleBreak[];
};
export type MyScheduleDay = {
  dateValue: string;
  label: string;
  shifts: MyShift[];
};

export type MyScheduleBoardClient = {
  getScheduleBoard(query: { date: string; view: 'week'; locationId?: string }): Promise<ScheduleBoardResponse>;
};

/** Upper bound on board reads per week so one account cannot fan out across hundreds of locations. */
export const MY_SCHEDULE_MAX_LOCATIONS = 12;
const LOCATION_FETCH_CONCURRENCY = 3;

function parseDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('Date must use YYYY-MM-DD.');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** Monday of the week containing the given YYYY-MM-DD calendar date. */
export function weekStartFor(dateValue: string): string {
  const weekday = parseDate(dateValue).getUTCDay();
  return addLocalDays(dateValue, -((weekday + 6) % 7));
}

/** Monday of the current week for `now` as seen in `timeZone`. */
export function currentWeekStart(now: Date, timeZone: unknown): string {
  return weekStartFor(dateValueInTimeZone(now, safeTimeZone(timeZone)));
}

export function weekRangeLabel(weekStart: string): string {
  const start = formatDateInTimeZone(`${weekStart}T12:00:00.000Z`, 'UTC');
  const end = formatDateInTimeZone(`${addLocalDays(weekStart, 6)}T12:00:00.000Z`, 'UTC', { year: 'numeric' });
  return `${start} - ${end}`;
}

export function dayLabel(dateValue: string): string {
  return formatDateInTimeZone(`${dateValue}T12:00:00.000Z`, 'UTC', { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * Shape one board response into the caller's own shifts on published schedules.
 * The API already restricts staff to this view; the filter keeps the page correct
 * (and never shows drafts) for roles that can see the whole board.
 */
export function selectOwnPublishedShifts(board: MyScheduleBoard, currentUserId: string): MyShift[] {
  const publishedScheduleIds = new Set(
    board.schedules.filter((schedule) => schedule.status === 'PUBLISHED').map((schedule) => schedule.id),
  );
  const locationsById = new Map(board.locations.map((location) => [location.id, location]));
  return board.shifts.flatMap((shift) => {
    if (shift.userId !== currentUserId || !publishedScheduleIds.has(shift.scheduleId)) return [];
    const location = locationsById.get(shift.locationId);
    return [{
      id: shift.id,
      locationId: shift.locationId,
      locationName: location?.name ?? 'Location',
      timeZone: safeTimeZone(location?.timezone),
      startTime: shift.startTime,
      endTime: shift.endTime,
      role: shift.role?.trim() ? shift.role.trim() : null,
      breaks: shift.breaks.map((item) => ({ startTime: item.startTime, endTime: item.endTime, paid: item.paid })),
    }];
  });
}

/** Group shifts by the local start day, keep only the 7-day window, and order by time. */
export function groupShiftsByDay(shifts: readonly MyShift[], weekStart: string): MyScheduleDay[] {
  const days = new Set(Array.from({ length: 7 }, (_, index) => addLocalDays(weekStart, index)));
  const byDay = new Map<string, MyShift[]>();
  const seen = new Set<string>();
  for (const shift of shifts) {
    if (seen.has(shift.id)) continue;
    seen.add(shift.id);
    const dateValue = dateValueInTimeZone(shift.startTime, shift.timeZone);
    if (!days.has(dateValue)) continue;
    byDay.set(dateValue, [...(byDay.get(dateValue) ?? []), shift]);
  }
  return [...byDay.keys()].sort().map((dateValue) => ({
    dateValue,
    label: dayLabel(dateValue),
    shifts: (byDay.get(dateValue) ?? []).sort((left, right) => (
      Date.parse(left.startTime) - Date.parse(right.startTime) || left.id.localeCompare(right.id)
    )),
  }));
}

export function formatShiftRange(shift: Pick<MyShift, 'startTime' | 'endTime' | 'timeZone'>): string {
  return `${formatTimeInTimeZone(shift.startTime, shift.timeZone)} - ${formatTimeInTimeZone(shift.endTime, shift.timeZone)}`;
}

export function formatBreak(item: MyScheduleBreak, timeZone: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(item.endTime) - Date.parse(item.startTime)) / 60_000));
  // The generator stores lunch as the unpaid meal period and short breaks as paid.
  const kind = item.paid ? 'Break' : 'Lunch';
  return `${kind} ${formatTimeInTimeZone(item.startTime, timeZone)} - ${formatTimeInTimeZone(item.endTime, timeZone)} (${minutes} min${item.paid ? ', paid' : ', unpaid'})`;
}

export type MyScheduleResult = {
  days: MyScheduleDay[];
  locationsChecked: number;
  locationsTruncated: boolean;
};

/**
 * Load one week of the caller's published shifts through the existing board endpoint.
 * The board is location-scoped, so the first read discovers locations and the rest
 * are read in small bounded batches.
 */
export async function loadMySchedule(
  client: MyScheduleBoardClient,
  weekStart: string,
  currentUserId: string,
): Promise<MyScheduleResult> {
  const first = await client.getScheduleBoard({ date: weekStart, view: 'week' });
  const shifts = selectOwnPublishedShifts(first.data, currentUserId);
  const remaining = first.data.locations
    .filter((location) => location.id !== first.data.selectedLocationId)
    .slice(0, Math.max(0, MY_SCHEDULE_MAX_LOCATIONS - 1));
  for (let index = 0; index < remaining.length; index += LOCATION_FETCH_CONCURRENCY) {
    const batch = remaining.slice(index, index + LOCATION_FETCH_CONCURRENCY);
    const boards = await Promise.all(batch.map((location) => (
      client.getScheduleBoard({ date: weekStart, view: 'week', locationId: location.id })
    )));
    for (const board of boards) shifts.push(...selectOwnPublishedShifts(board.data, currentUserId));
  }
  const totalLocations = first.data.locations.length;
  return {
    days: groupShiftsByDay(shifts, weekStart),
    locationsChecked: Math.min(totalLocations, MY_SCHEDULE_MAX_LOCATIONS),
    locationsTruncated: first.data.locationsTruncated || totalLocations > MY_SCHEDULE_MAX_LOCATIONS,
  };
}
