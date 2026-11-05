import { describe, expect, it, vi } from 'vitest';
import type { ScheduleBoardResponse } from '@lunchlineup/api-contract';

import {
  MY_SCHEDULE_MAX_LOCATIONS,
  currentWeekStart,
  formatBreak,
  formatShiftRange,
  groupShiftsByDay,
  loadMySchedule,
  selectOwnPublishedShifts,
  weekRangeLabel,
  weekStartFor,
  type MyShift,
} from '../../lib/my-schedule';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PUBLISHED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DRAFT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type BoardQuery = { date: string; view: 'week'; locationId?: string };

function shift(id: string, userId: string | null, scheduleId: string, start: string, end: string, locationId = LOC_A) {
  return {
    id, userId, locationId, scheduleId, startTime: start, endTime: end, role: 'Server', user: null,
    breaks: [{ startTime: '2026-10-14T20:00:00.000Z', endTime: '2026-10-14T20:30:00.000Z', paid: false }],
  };
}

function board(overrides: Partial<ScheduleBoardResponse['data']> = {}): ScheduleBoardResponse {
  return {
    data: {
      permissions: [],
      locations: [
        { id: LOC_A, name: 'Downtown', timezone: 'America/New_York' },
        { id: LOC_B, name: 'Airport', timezone: 'America/Los_Angeles' },
      ],
      locationsTruncated: false,
      selectedLocationId: LOC_A,
      staff: [],
      schedules: [
        { id: PUBLISHED, locationId: LOC_A, startDate: '2026-10-12T04:00:00.000Z', endDate: '2026-10-19T04:00:00.000Z', status: 'PUBLISHED', publishedAt: '2026-10-10T12:00:00.000Z', revision: 1, etag: 'e1' },
        { id: DRAFT, locationId: LOC_A, startDate: '2026-10-12T04:00:00.000Z', endDate: '2026-10-19T04:00:00.000Z', status: 'DRAFT', publishedAt: null, revision: 1, etag: 'e2' },
      ],
      shifts: [],
      range: { start: '2026-10-12T04:00:00.000Z', end: '2026-10-19T04:00:00.000Z' },
      ...overrides,
    },
    meta: { generatedAt: '2026-10-14T12:00:00.000Z' },
  };
}

describe('my schedule week helpers', () => {
  it('finds the Monday of any calendar date, including Sundays and month boundaries', () => {
    expect(weekStartFor('2026-10-14')).toBe('2026-10-12');
    expect(weekStartFor('2026-10-12')).toBe('2026-10-12');
    expect(weekStartFor('2026-10-18')).toBe('2026-10-12');
    expect(weekStartFor('2026-11-01')).toBe('2026-10-26');
  });

  it('resolves the current week in the supplied time zone', () => {
    const instant = new Date('2026-10-19T02:00:00.000Z');
    expect(currentWeekStart(instant, 'America/New_York')).toBe('2026-10-12');
    expect(currentWeekStart(instant, 'Asia/Tokyo')).toBe('2026-10-19');
    expect(currentWeekStart(instant, 'Not/AZone')).toBe('2026-10-12');
  });

  it('labels a week range', () => {
    expect(weekRangeLabel('2026-10-12')).toBe('Oct 12 - Oct 18, 2026');
  });
});

describe('selectOwnPublishedShifts', () => {
  it('keeps only the caller shifts on published schedules', () => {
    const data = board({
      shifts: [
        shift('s1', ME, PUBLISHED, '2026-10-14T14:00:00.000Z', '2026-10-14T22:00:00.000Z'),
        shift('s2', OTHER, PUBLISHED, '2026-10-14T14:00:00.000Z', '2026-10-14T22:00:00.000Z'),
        shift('s3', ME, DRAFT, '2026-10-15T14:00:00.000Z', '2026-10-15T22:00:00.000Z'),
        shift('s4', null, PUBLISHED, '2026-10-16T14:00:00.000Z', '2026-10-16T22:00:00.000Z'),
      ],
    }).data;
    const result = selectOwnPublishedShifts(data, ME);
    expect(result.map((item) => item.id)).toEqual(['s1']);
    expect(result[0]).toMatchObject({ locationName: 'Downtown', timeZone: 'America/New_York', role: 'Server' });
  });
});

describe('groupShiftsByDay and formatting', () => {
  const base: MyShift = {
    id: 'a', locationId: LOC_A, locationName: 'Downtown', timeZone: 'America/New_York',
    startTime: '2026-10-14T14:00:00.000Z', endTime: '2026-10-14T22:00:00.000Z', role: null, breaks: [],
  };

  it('groups by local start day, orders by time, and drops shifts outside the week', () => {
    const days = groupShiftsByDay([
      { ...base, id: 'late', startTime: '2026-10-15T01:00:00.000Z', endTime: '2026-10-15T05:00:00.000Z' },
      { ...base, id: 'early' },
      { ...base, id: 'next-week', startTime: '2026-10-19T14:00:00.000Z', endTime: '2026-10-19T22:00:00.000Z' },
      { ...base, id: 'early' },
    ], '2026-10-12');
    // 01:00Z on the 15th is 9pm on the 14th in New York.
    expect(days).toHaveLength(1);
    expect(days[0].dateValue).toBe('2026-10-14');
    expect(days[0].label).toBe('Wednesday, Oct 14');
    expect(days[0].shifts.map((item) => item.id)).toEqual(['early', 'late']);
  });

  it('formats shift and break times in the location time zone', () => {
    expect(formatShiftRange(base)).toBe('10:00 AM - 6:00 PM');
    expect(formatBreak({ startTime: '2026-10-14T17:00:00.000Z', endTime: '2026-10-14T17:30:00.000Z', paid: false }, 'America/New_York'))
      .toBe('Lunch 1:00 PM - 1:30 PM (30 min, unpaid)');
    expect(formatBreak({ startTime: '2026-10-14T15:00:00.000Z', endTime: '2026-10-14T15:15:00.000Z', paid: true }, 'America/New_York'))
      .toBe('Break 11:00 AM - 11:15 AM (15 min, paid)');
  });
});

describe('loadMySchedule', () => {
  it('reads every location once with the week view and merges the caller shifts', async () => {
    const second = board({
      selectedLocationId: LOC_B,
      shifts: [shift('b1', ME, PUBLISHED, '2026-10-15T16:00:00.000Z', '2026-10-16T00:00:00.000Z', LOC_B)],
    });
    const getScheduleBoard = vi.fn(async (query: BoardQuery) => (
      query.locationId === LOC_B
        ? second
        : board({ shifts: [shift('a1', ME, PUBLISHED, '2026-10-14T14:00:00.000Z', '2026-10-14T22:00:00.000Z')] })
    ));

    const result = await loadMySchedule({ getScheduleBoard }, '2026-10-12', ME);

    expect(getScheduleBoard).toHaveBeenCalledTimes(2);
    expect(getScheduleBoard).toHaveBeenNthCalledWith(1, { date: '2026-10-12', view: 'week' });
    expect(getScheduleBoard).toHaveBeenNthCalledWith(2, { date: '2026-10-12', view: 'week', locationId: LOC_B });
    expect(result.days.map((day) => day.dateValue)).toEqual(['2026-10-14', '2026-10-15']);
    expect(result.locationsTruncated).toBe(false);
  });

  it('returns no days for an empty published week', async () => {
    const getScheduleBoard = vi.fn(async (_query: BoardQuery) => board({ locations: [{ id: LOC_A, name: 'Downtown', timezone: 'America/New_York' }] }));
    const result = await loadMySchedule({ getScheduleBoard }, '2026-10-12', ME);
    expect(result.days).toEqual([]);
    expect(getScheduleBoard).toHaveBeenCalledTimes(1);
  });

  it('bounds the location fan-out and reports truncation', async () => {
    const locations = Array.from({ length: MY_SCHEDULE_MAX_LOCATIONS + 5 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: `Loc ${index}`,
      timezone: 'America/New_York',
    }));
    const getScheduleBoard = vi.fn(async (_query: BoardQuery) => board({ locations, selectedLocationId: locations[0].id }));
    const result = await loadMySchedule({ getScheduleBoard }, '2026-10-12', ME);
    expect(getScheduleBoard).toHaveBeenCalledTimes(MY_SCHEDULE_MAX_LOCATIONS);
    expect(result.locationsTruncated).toBe(true);
    expect(result.locationsChecked).toBe(MY_SCHEDULE_MAX_LOCATIONS);
  });

  it('propagates a failed board read instead of showing a partial week', async () => {
    const getScheduleBoard = vi.fn<(query: BoardQuery) => Promise<ScheduleBoardResponse>>()
      .mockResolvedValueOnce(board())
      .mockRejectedValueOnce(new Error('boom'));
    await expect(loadMySchedule({ getScheduleBoard }, '2026-10-12', ME)).rejects.toThrow('boom');
  });
});
