import type { LunchBreakRow, ScheduleSummary, ShiftSummary } from '@lunchlineup/api-contract';
import { ProblemError } from '../platform/problem';

type StoredBreak = {
  id?: string;
  type: string | null;
  startTime: Date;
  endTime: Date;
  paid: boolean;
};

type PublicShiftRow = {
  publicId: string;
  userId: string | null;
  location: { publicId: string };
  schedule: { publicId: string } | null;
  startTime: Date;
  endTime: Date;
  role: string | null;
  user: { publicId: string; name: string; role: string } | null;
  breaks: StoredBreak[];
};

const BREAK_TYPES = ['break1', 'lunch', 'break2'] as const;
type BreakType = (typeof BREAK_TYPES)[number];

function publicBreakType(value: string | null): BreakType | null {
  if (value === 'BREAK1') return 'break1';
  if (value === 'LUNCH') return 'lunch';
  if (value === 'BREAK2') return 'break2';
  return null;
}

export function serializeSchedule(row: {
  publicId: string;
  location: { publicId: string };
  startDate: Date;
  endDate: Date;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: Date | null;
  revision: number;
}): ScheduleSummary {
  return {
    id: row.publicId,
    locationId: row.location.publicId,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate.toISOString(),
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    revision: row.revision,
  };
}

export function serializeShift(row: PublicShiftRow): ShiftSummary {
  return {
    id: row.publicId,
    userId: row.user?.publicId ?? null,
    locationId: row.location.publicId,
    scheduleId: row.schedule?.publicId ?? null,
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
    role: row.role,
    user: row.user
      ? {
          id: row.user.publicId,
          name: row.user.name || 'Unnamed',
          role: row.user.role === 'MANAGER' ? 'MANAGER' : 'STAFF',
        }
      : null,
    breaks: serializeBreaks(row.breaks),
  };
}

export function serializeLunchBreakRow(row: PublicShiftRow): LunchBreakRow {
  return {
    shiftId: row.publicId,
    userId: row.user?.publicId ?? null,
    employeeName: row.user?.name || null,
    startTime: row.startTime.toISOString(),
    endTime: row.endTime.toISOString(),
    breaks: serializeBreaks(row.breaks),
  };
}

export function serializeBreaks(entries: readonly StoredBreak[]) {
  const ordered = [...entries].sort((left, right) => (
    left.startTime.getTime() - right.startTime.getTime() || (left.id ?? '').localeCompare(right.id ?? '')
  ));
  const typed = new Map<BreakType, StoredBreak>();
  const untyped: StoredBreak[] = [];
  for (const entry of ordered) {
    const type = publicBreakType(entry.type);
    if (type && !typed.has(type)) {
      typed.set(type, entry);
    } else if (!type) {
      untyped.push(entry);
    }
  }
  const paid = untyped.filter((entry) => entry.paid);
  const unpaid = untyped.filter((entry) => !entry.paid);
  const fallback: Record<BreakType, StoredBreak | null> = {
    break1: typed.get('break1') ?? paid[0] ?? untyped[0] ?? null,
    lunch: typed.get('lunch') ?? unpaid[0] ?? untyped[Math.floor(untyped.length / 2)] ?? null,
    break2: typed.get('break2') ?? paid[1] ?? untyped.at(-1) ?? null,
  };
  const used = new Set<StoredBreak>();
  return BREAK_TYPES.flatMap((type) => {
    const entry = fallback[type];
    if (!entry || used.has(entry)) return [];
    used.add(entry);
    const durationMinutes = Math.round((entry.endTime.getTime() - entry.startTime.getTime()) / 60_000);
    if (durationMinutes < 1 || entry.endTime <= entry.startTime) {
      throw new ProblemError(
        500,
        'invalid_lunch_break_record',
        'A saved lunch or break record is invalid.',
        'Lunch and break data error',
      );
    }
    return [{
      type,
      startTime: entry.startTime.toISOString(),
      endTime: entry.endTime.toISOString(),
      durationMinutes,
      paid: Boolean(entry.paid),
    }];
  });
}
