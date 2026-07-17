import {
  dateValueInTimeZone,
  localDateTimeToIso,
  timeValueInTimeZone,
} from '../../../lib/location-timezone';

const DST_SEARCH_MINUTES = [30, 60, 90, 120, 150, 180] as const;

export function payrollInstantToLocalInput(timestamp: string, workTimeZone: string): string {
  return `${dateValueInTimeZone(timestamp, workTimeZone)}T${timeValueInTimeZone(timestamp, workTimeZone)}`;
}

export function payrollLocalInputToIso(value: string, workTimeZone: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error('Date and time are required.');
  const iso = localDateTimeToIso(match[1], match[2], workTimeZone);
  const instant = new Date(iso);
  const ambiguous = DST_SEARCH_MINUTES.some((minutes) => (
    matchesLocalInput(new Date(instant.getTime() - minutes * 60_000), value, workTimeZone)
    || matchesLocalInput(new Date(instant.getTime() + minutes * 60_000), value, workTimeZone)
  ));
  if (ambiguous) throw new Error('Choose an unambiguous local time outside the daylight-saving transition.');
  return iso;
}

function matchesLocalInput(instant: Date, value: string, workTimeZone: string): boolean {
  return payrollInstantToLocalInput(instant.toISOString(), workTimeZone) === value;
}
