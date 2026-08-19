import {
  idempotentRequestAttempt,
  type IdempotentRequestAttempt,
} from '../../../lib/client-api';
import type { ScheduleChangeSetRequest } from '@lunchlineup/api-contract';

export const SHIFT_UPDATE_RECOVERY_KEY = 'lunchlineup:shift-update-recovery:v1';

type ShiftUpdateRecovery = {
  shiftId: string;
  attempt: IdempotentRequestAttempt;
  updatedAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type ShiftUpdateOperation = Extract<
  ScheduleChangeSetRequest['operations'][number],
  { op: 'shift.update' }
>;

const RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECOVERIES = 100;

export function readShiftUpdateRecoveries(
  storage: StorageLike,
  now = Date.now(),
): ShiftUpdateRecovery[] {
  try {
    const value = JSON.parse(storage.getItem(SHIFT_UPDATE_RECOVERY_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is ShiftUpdateRecovery => (
      entry
      && typeof entry.shiftId === 'string'
      && entry.shiftId.length > 0
      && typeof entry.attempt?.key === 'string'
      && entry.attempt.key.length > 0
      && entry.attempt.key.length <= 255
      && !/[^\x20-\x7E]/.test(entry.attempt.key)
      && typeof entry.attempt.payloadFingerprint === 'string'
      && typeof entry.updatedAt === 'number'
      && now >= entry.updatedAt
      && now - entry.updatedAt <= RECOVERY_TTL_MS
    )).slice(-MAX_RECOVERIES);
  } catch {
    return [];
  }
}

export function beginShiftUpdateAttempt(
  storage: StorageLike,
  shiftId: string,
  payload: unknown,
  current?: IdempotentRequestAttempt | null,
  keyFactory?: () => string,
  now = Date.now(),
): IdempotentRequestAttempt {
  const stored = readShiftUpdateRecoveries(storage, now)
    .find((entry) => entry.shiftId === shiftId)?.attempt;
  const attempt = idempotentRequestAttempt(payload, current ?? stored, keyFactory);
  const recoveries = readShiftUpdateRecoveries(storage, now)
    .filter((entry) => entry.shiftId !== shiftId);
  recoveries.push({ shiftId, attempt, updatedAt: now });
  try {
    storage.setItem(SHIFT_UPDATE_RECOVERY_KEY, JSON.stringify(recoveries.slice(-MAX_RECOVERIES)));
  } catch {
    // The in-memory attempt still protects auth refresh and same-page retries.
  }
  return attempt;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && !/[\0\r\n]/.test(value);
}

export function readShiftUpdateRecoveryPayload(
  storage: StorageLike,
  shiftId: string,
  scheduleId: string,
  now = Date.now(),
): { scheduleId: string; operation: ShiftUpdateOperation } | null {
  const recovery = readShiftUpdateRecoveries(storage, now)
    .find((entry) => entry.shiftId === shiftId);
  if (!recovery) return null;

  try {
    const payload = JSON.parse(recovery.attempt.payloadFingerprint) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const payloadRecord = payload as Record<string, unknown>;
    if (
      Object.keys(payloadRecord).sort().join(',') !== 'operation,scheduleId'
      || payloadRecord.scheduleId !== scheduleId
      || !payloadRecord.operation
      || typeof payloadRecord.operation !== 'object'
      || Array.isArray(payloadRecord.operation)
    ) {
      return null;
    }

    const stored = payloadRecord.operation as Record<string, unknown>;
    const keys = Object.keys(stored);
    const allowedKeys = new Set(['op', 'shiftId', 'startTime', 'endTime', 'userId', 'role']);
    if (
      stored.op !== 'shift.update'
      || stored.shiftId !== shiftId
      || keys.some((key) => !allowedKeys.has(key))
      || !keys.some((key) => !['op', 'shiftId'].includes(key))
    ) {
      return null;
    }
    if ('startTime' in stored && !isBoundedString(stored.startTime, 64)) return null;
    if ('endTime' in stored && !isBoundedString(stored.endTime, 64)) return null;
    if (
      'userId' in stored
      && stored.userId !== null
      && !isBoundedString(stored.userId, 255)
    ) {
      return null;
    }
    if (
      'role' in stored
      && stored.role !== null
      && !isBoundedString(stored.role, 64)
    ) {
      return null;
    }

    return {
      scheduleId,
      operation: {
        op: 'shift.update',
        shiftId,
        ...('startTime' in stored ? { startTime: stored.startTime as string } : {}),
        ...('endTime' in stored ? { endTime: stored.endTime as string } : {}),
        ...('userId' in stored ? { userId: stored.userId as string | null } : {}),
        ...('role' in stored ? { role: stored.role as string | null } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function clearShiftUpdateAttempt(
  storage: StorageLike,
  shiftId: string,
  attemptKey: string,
  now = Date.now(),
): void {
  const current = readShiftUpdateRecoveries(storage, now);
  const matching = current.find((entry) => entry.shiftId === shiftId);
  if (matching && matching.attempt.key !== attemptKey) return;
  const remaining = current.filter((entry) => entry.shiftId !== shiftId);
  try {
    if (remaining.length === 0) {
      storage.removeItem(SHIFT_UPDATE_RECOVERY_KEY);
    } else {
      storage.setItem(SHIFT_UPDATE_RECOVERY_KEY, JSON.stringify(remaining));
    }
  } catch {
    // Recovery cleanup is best effort after the server response is authoritative.
  }
}
