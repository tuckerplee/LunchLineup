import type { TimeCardCorrectionRequest } from '@lunchlineup/api-contract';
import { ProblemError } from '../platform/problem';
import { invalidTimeCardInput, parseTimeCardInstant } from './pagination';

const MAX_CORRECTION_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_BREAK_INTERVALS = 24;

export type PersistedBreakInterval = {
  startAt: Date;
  endAt: Date;
};

export type CorrectableTimeCard = {
  clockInAt: Date;
  clockOutAt: Date | null;
  breakMinutes: number;
  updatedAt: Date;
  breaks: readonly PersistedBreakInterval[];
};

export type ValidatedTimeCardCorrection = {
  clockInAt: Date;
  clockOutAt: Date | null;
  breakIntervals: PersistedBreakInterval[] | null;
  breakMinutes: number;
  expectedUpdatedAt: Date;
  reason: string;
  status: 'OPEN' | 'CLOSED';
};

export function validateTimeCardCorrection(
  body: TimeCardCorrectionRequest,
  current: CorrectableTimeCard,
  now = new Date(),
): ValidatedTimeCardCorrection {
  const reason = requiredReason(body.reason);
  const expectedUpdatedAt = parseTimeCardInstant(body.expectedUpdatedAt, 'expectedUpdatedAt');
  const hasClockIn = hasOwn(body, 'clockInAt');
  const hasClockOut = hasOwn(body, 'clockOutAt');
  const hasBreakIntervals = hasOwn(body, 'breakIntervals');
  if (!hasClockIn && !hasClockOut && !hasBreakIntervals) {
    throw invalidTimeCardInput('Provide at least one time-card field to correct.');
  }

  const clockInAt = hasClockIn ? parseTimeCardInstant(body.clockInAt, 'clockInAt') : current.clockInAt;
  const clockOutAt = hasClockOut
    ? body.clockOutAt === null ? null : parseTimeCardInstant(body.clockOutAt, 'clockOutAt')
    : current.clockOutAt;
  assertCorrectionWindow(clockInAt, clockOutAt, now);

  const intervals = hasBreakIntervals
    ? validateBreakIntervals(body.breakIntervals, clockInAt, clockOutAt, now)
    : validateBreakIntervals(current.breaks, clockInAt, clockOutAt, now);
  const breakMinutes = intervals.reduce((total, interval) => total + durationMinutes(interval), 0);
  if (!hasBreakIntervals && intervals.length > 0 && breakMinutes !== current.breakMinutes) {
    throw invalidTimeCardInput('Stored break intervals do not match aggregate break minutes.');
  }
  const effectiveEnd = clockOutAt ?? now;
  const grossMinutes = Math.floor((effectiveEnd.getTime() - clockInAt.getTime()) / 60_000);
  const nextBreakMinutes = hasBreakIntervals ? breakMinutes : current.breakMinutes;
  if (nextBreakMinutes > 0 && nextBreakMinutes >= grossMinutes) {
    throw invalidTimeCardInput('Break time must be less than the time-card window.');
  }

  return {
    clockInAt,
    clockOutAt,
    breakIntervals: hasBreakIntervals ? intervals : null,
    breakMinutes: nextBreakMinutes,
    expectedUpdatedAt,
    reason,
    status: clockOutAt ? 'CLOSED' : 'OPEN',
  };
}

export function normalizeTimeCardNotes(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidTimeCardInput('notes must be a string.');
  const normalized = value.trim();
  if (normalized.length > 1_000) throw invalidTimeCardInput('notes must be at most 1000 characters.');
  return normalized || null;
}

export function normalizeClockOutBreakMinutes(value: unknown, totalMinutes: number): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidTimeCardInput('Break minutes must be a non-negative whole number.');
  }
  if (value > 0 && value >= totalMinutes) {
    throw invalidTimeCardInput('Break minutes must be less than worked minutes.');
  }
  return value;
}

export function timeCardAuditValue(card: {
  userId: string;
  locationId: string | null;
  shiftId: string | null;
  clockInAt: Date;
  clockOutAt: Date | null;
  breakMinutes: number;
  status: string;
  breaks: readonly PersistedBreakInterval[];
}) {
  return {
    targetUserId: card.userId,
    locationId: card.locationId,
    shiftId: card.shiftId,
    clockInAt: card.clockInAt.toISOString(),
    clockOutAt: card.clockOutAt?.toISOString() ?? null,
    breakMinutes: card.breakMinutes,
    breakIntervals: card.breaks.map((interval) => ({
      startAt: interval.startAt.toISOString(),
      endAt: interval.endAt.toISOString(),
    })),
    status: card.status,
  };
}

function validateBreakIntervals(
  value: unknown,
  clockInAt: Date,
  clockOutAt: Date | null,
  now: Date,
): PersistedBreakInterval[] {
  if (!Array.isArray(value)) throw invalidTimeCardInput('breakIntervals must be an array.');
  if (value.length > MAX_BREAK_INTERVALS) {
    throw invalidTimeCardInput(`A time card cannot contain more than ${MAX_BREAK_INTERVALS} break intervals.`);
  }
  const intervals = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw invalidTimeCardInput(`Break ${index + 1} must include startAt and endAt.`);
    }
    const item = entry as { startAt?: unknown; endAt?: unknown };
    return {
      startAt: item.startAt instanceof Date ? item.startAt : parseTimeCardInstant(item.startAt, `breakIntervals[${index}].startAt`),
      endAt: item.endAt instanceof Date ? item.endAt : parseTimeCardInstant(item.endAt, `breakIntervals[${index}].endAt`),
    };
  });
  const cardEnd = clockOutAt ?? now;
  let previousEnd: Date | null = null;
  for (const [index, interval] of intervals.entries()) {
    if (interval.endAt <= interval.startAt) {
      throw invalidTimeCardInput(`Break ${index + 1} must end after it starts.`);
    }
    if ((interval.endAt.getTime() - interval.startAt.getTime()) % 60_000 !== 0) {
      throw invalidTimeCardInput(`Break ${index + 1} must use whole-minute boundaries.`);
    }
    if (interval.startAt < clockInAt || interval.endAt > cardEnd) {
      throw invalidTimeCardInput(`Break ${index + 1} must be inside the time-card window.`);
    }
    if (previousEnd && interval.startAt < previousEnd) {
      throw invalidTimeCardInput('Break intervals must be chronological and cannot overlap.');
    }
    previousEnd = interval.endAt;
  }
  return intervals;
}

function assertCorrectionWindow(clockInAt: Date, clockOutAt: Date | null, now: Date): void {
  const latestAllowed = now.getTime() + MAX_FUTURE_SKEW_MS;
  if (clockInAt.getTime() > latestAllowed || (clockOutAt && clockOutAt.getTime() > latestAllowed)) {
    throw invalidTimeCardInput('Corrected timestamps cannot be more than five minutes in the future.');
  }
  const effectiveEnd = clockOutAt ?? now;
  if (effectiveEnd <= clockInAt) throw invalidTimeCardInput('Clock out must be after clock in.');
  if (effectiveEnd.getTime() - clockInAt.getTime() > MAX_CORRECTION_WINDOW_MS) {
    throw invalidTimeCardInput('A corrected time card cannot span more than 31 days.');
  }
}

function requiredReason(value: unknown): string {
  if (typeof value !== 'string') throw invalidTimeCardInput('A correction reason is required.');
  const reason = value.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw invalidTimeCardInput('Correction reason must be between 5 and 500 characters.');
  }
  return reason;
}

function durationMinutes(interval: PersistedBreakInterval): number {
  return (interval.endAt.getTime() - interval.startAt.getTime()) / 60_000;
}

function hasOwn(value: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

export function isTimeCardOverlap(error: unknown): boolean {
  if (error instanceof ProblemError && error.code === 'time_card_overlap') return true;
  if (error instanceof Error && error.message.includes('TimeCard_employee_no_overlap')) return true;
  try {
    return JSON.stringify(error).includes('TimeCard_employee_no_overlap');
  } catch {
    return false;
  }
}
