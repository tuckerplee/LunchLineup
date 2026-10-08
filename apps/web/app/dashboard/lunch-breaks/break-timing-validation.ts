import { resolveLunchBreakInstant } from './lunch-break-time';

type BreakTiming = { time: string; durationMinutes: number; skipped: boolean; originalStartIso?: string | null };
type BreakTimingRow = {
  startTime: string;
  endTime: string;
  break1: BreakTiming;
  lunch: BreakTiming;
  break2: BreakTiming;
};

export function breakTimingIssue(row: BreakTimingRow, timeZone: string): string | null {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const key of ['break1', 'lunch', 'break2'] as const) {
    const entry = row[key];
    if (entry.skipped) continue;
    const start = resolveLunchBreakInstant(row.startTime, row.endTime, entry.time, timeZone, entry.originalStartIso);
    if (!start || !Number.isInteger(entry.durationMinutes) || entry.durationMinutes <= 0) {
      return 'Each planned break needs a valid time and positive whole-minute duration.';
    }
    const interval = { start: Date.parse(start), end: Date.parse(start) + entry.durationMinutes * 60_000 };
    if (interval.end > Date.parse(row.endTime)) return 'A planned break ends outside the shift.';
    if (intervals.some((other) => interval.start < other.end && interval.end > other.start)) {
      return 'Planned breaks overlap. Choose separate times before saving.';
    }
    intervals.push(interval);
  }
  return null;
}
