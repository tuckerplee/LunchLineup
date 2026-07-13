import { dateValueInTimeZone, localDateRange } from '../../../lib/location-timezone';

export type ManualShiftSchedule = {
  id: string;
  locationId: string;
  startDate: string;
  endDate: string;
  status: string;
};

export function containingDraftScheduleForShift<T extends ManualShiftSchedule>(
  schedules: T[],
  locationId: string,
  startTime: string,
  endTime: string,
): T | null {
  const shiftStart = Date.parse(startTime);
  const shiftEnd = Date.parse(endTime);
  if (!Number.isFinite(shiftStart) || !Number.isFinite(shiftEnd) || shiftEnd <= shiftStart) return null;

  return schedules.find((schedule) => {
    const scheduleStart = Date.parse(schedule.startDate);
    const scheduleEnd = Date.parse(schedule.endDate);
    return schedule.locationId === locationId
      && schedule.status === 'DRAFT'
      && Number.isFinite(scheduleStart)
      && Number.isFinite(scheduleEnd)
      && scheduleStart <= shiftStart
      && scheduleEnd >= shiftEnd;
  }) ?? null;
}

export function fallbackDraftWindowForShift(startTime: string, endTime: string, timeZone: string) {
  const inclusiveEnd = new Date(new Date(endTime).getTime() - 1);
  const startDay = localDateRange(dateValueInTimeZone(startTime, timeZone), 1, timeZone);
  const endDay = localDateRange(dateValueInTimeZone(inclusiveEnd, timeZone), 1, timeZone);
  return { start: startDay.start, end: endDay.end };
}
