import {
  idempotentRequestAttempt,
  type IdempotentRequestAttempt,
} from '../../../lib/client-api';

export const SHIFT_BREAK_UPDATE_RECOVERY_KEY_PREFIX = 'lunchlineup:shift-break-update-recovery:v1:';
export const SHIFT_BREAK_UPDATE_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;

export type ShiftBreakUpdateIdentity = {
  shiftId: string;
  dateValue: string;
  locationId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
};

export type ShiftBreakUpdateRequestBody = {
  locationId: string;
  breaks: Array<{
    type: 'break1' | 'lunch' | 'break2';
    startTime?: string;
    durationMinutes?: number;
    skip: boolean;
  }>;
};

export type ShiftBreakUpdateRecovery = {
  attempt: IdempotentRequestAttempt;
  identity: ShiftBreakUpdateIdentity;
  expiresAt: number;
  requestBody: ShiftBreakUpdateRequestBody;
};

export type ShiftBreakUpdateSubmissionState = {
  recoveries: Map<string, ShiftBreakUpdateRecovery>;
  inFlight: Set<string>;
};

export type ShiftBreakUpdateSubmissionResult<T> =
  | { submitted: false }
  | { submitted: true; value: T };

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isScopePart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255;
}

function isPrintableKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 255
    && !/[^\x20-\x7E]/.test(value);
}

function isIdentity(value: unknown): value is ShiftBreakUpdateIdentity {
  return isRecord(value)
    && isScopePart(value.shiftId)
    && typeof value.dateValue === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value.dateValue)
    && isScopePart(value.locationId)
    && isScopePart(value.tenantId)
    && isScopePart(value.userId)
    && isScopePart(value.sessionId);
}

function identityMatches(left: ShiftBreakUpdateIdentity, right: ShiftBreakUpdateIdentity): boolean {
  return left.shiftId === right.shiftId
    && left.dateValue === right.dateValue
    && left.locationId === right.locationId
    && left.tenantId === right.tenantId
    && left.userId === right.userId
    && left.sessionId === right.sessionId;
}

function isRequestBody(value: unknown): value is ShiftBreakUpdateRequestBody {
  if (!isRecord(value) || !isScopePart(value.locationId) || !Array.isArray(value.breaks)) return false;
  const seen = new Set<string>();
  return value.breaks.every((entry) => {
    if (!isRecord(entry)
      || !['break1', 'lunch', 'break2'].includes(String(entry.type))
      || typeof entry.skip !== 'boolean'
      || seen.has(String(entry.type))) return false;
    seen.add(String(entry.type));
    if (entry.skip) return true;
    return typeof entry.startTime === 'string'
      && entry.startTime.length > 0
      && typeof entry.durationMinutes === 'number'
      && Number.isSafeInteger(entry.durationMinutes)
      && entry.durationMinutes > 0;
  });
}

function scopeKey(identity: ShiftBreakUpdateIdentity): string {
  return [
    identity.tenantId,
    identity.userId,
    identity.sessionId,
    identity.dateValue,
    identity.locationId,
    identity.shiftId,
  ].map(encodeURIComponent).join(':');
}

function storageKey(identity: ShiftBreakUpdateIdentity): string {
  return `${SHIFT_BREAK_UPDATE_RECOVERY_KEY_PREFIX}${scopeKey(identity)}`;
}

function parseRecovery(value: unknown): ShiftBreakUpdateRecovery | null {
  if (!isRecord(value)
    || !isRecord(value.attempt)
    || !isIdentity(value.identity)
    || !isRequestBody(value.requestBody)
    || value.requestBody.locationId !== value.identity.locationId
    || typeof value.expiresAt !== 'number'
    || !Number.isSafeInteger(value.expiresAt)
    || !isPrintableKey(value.attempt.key)
    || typeof value.attempt.payloadFingerprint !== 'string') return null;
  return {
    attempt: {
      key: value.attempt.key,
      payloadFingerprint: value.attempt.payloadFingerprint,
    },
    identity: value.identity,
    expiresAt: value.expiresAt,
    requestBody: value.requestBody,
  };
}

function removeRecovery(storage: StorageLike, identity: ShiftBreakUpdateIdentity): void {
  try {
    storage.removeItem(storageKey(identity));
  } catch {
    // In-memory state still protects same-page retry behavior.
  }
}

export function readShiftBreakUpdateRecovery(
  storage: StorageLike,
  expectedIdentity: ShiftBreakUpdateIdentity,
  now = Date.now(),
): ShiftBreakUpdateRecovery | null {
  if (!isIdentity(expectedIdentity)) return null;
  try {
    const recovery = parseRecovery(JSON.parse(storage.getItem(storageKey(expectedIdentity)) ?? 'null'));
    if (!recovery
      || recovery.expiresAt <= now
      || recovery.expiresAt > now + SHIFT_BREAK_UPDATE_RECOVERY_TTL_MS
      || !identityMatches(recovery.identity, expectedIdentity)) {
      removeRecovery(storage, expectedIdentity);
      return null;
    }
    return recovery;
  } catch {
    removeRecovery(storage, expectedIdentity);
    return null;
  }
}

function retainRecovery(storage: StorageLike, recovery: ShiftBreakUpdateRecovery): void {
  try {
    storage.setItem(storageKey(recovery.identity), JSON.stringify(recovery));
  } catch {
    // In-memory state still protects same-page retry behavior.
  }
}

function clearRecovery(
  storage: StorageLike,
  identity: ShiftBreakUpdateIdentity,
  attemptKey: string,
): void {
  const current = readShiftBreakUpdateRecovery(storage, identity);
  if (current && current.attempt.key !== attemptKey) return;
  removeRecovery(storage, identity);
}

export function createShiftBreakUpdateSubmissionState(): ShiftBreakUpdateSubmissionState {
  return { recoveries: new Map(), inFlight: new Set() };
}

export async function submitShiftBreakUpdate<T>(
  state: ShiftBreakUpdateSubmissionState,
  identity: ShiftBreakUpdateIdentity,
  requestBody: ShiftBreakUpdateRequestBody,
  storage: StorageLike,
  send: (retainedBody: ShiftBreakUpdateRequestBody, idempotencyKey: string) => Promise<T>,
  keyFactory?: () => string,
  nowFactory: () => number = Date.now,
): Promise<ShiftBreakUpdateSubmissionResult<T>> {
  if (!isIdentity(identity) || !isRequestBody(requestBody) || requestBody.locationId !== identity.locationId) {
    throw new Error('Shift lunch/break recovery scope is invalid. Refresh and try again.');
  }
  const key = scopeKey(identity);
  if (state.inFlight.has(key)) return { submitted: false };

  state.inFlight.add(key);
  try {
    const now = nowFactory();
    const retained = state.recoveries.get(key);
    const inMemoryRecovery = retained
      && retained.expiresAt > now
      && retained.expiresAt <= now + SHIFT_BREAK_UPDATE_RECOVERY_TTL_MS
      && identityMatches(retained.identity, identity)
      ? retained
      : null;
    if (retained && !inMemoryRecovery) state.recoveries.delete(key);
    const current = inMemoryRecovery ?? readShiftBreakUpdateRecovery(storage, identity, now);
    const attempt = idempotentRequestAttempt({ identity, requestBody }, current?.attempt, keyFactory);
    const recovery = current && attempt === current.attempt
      ? current
      : {
          attempt,
          identity,
          expiresAt: now + SHIFT_BREAK_UPDATE_RECOVERY_TTL_MS,
          requestBody,
        };
    state.recoveries.set(key, recovery);
    retainRecovery(storage, recovery);

    const value = await send(recovery.requestBody, recovery.attempt.key);
    clearRecovery(storage, identity, recovery.attempt.key);
    if (state.recoveries.get(key)?.attempt.key === recovery.attempt.key) state.recoveries.delete(key);
    return { submitted: true, value };
  } finally {
    state.inFlight.delete(key);
  }
}

export type ShiftBreakUpdatePublicErrorCode =
  | 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED'
  | 'SHIFT_BREAKS_CONFLICT';

export class ShiftBreakUpdateRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ShiftBreakUpdatePublicErrorCode | null = null,
    readonly remediation: string | null = null,
  ) {
    super(message);
    this.name = 'ShiftBreakUpdateRequestError';
  }
}

const PUBLIC_ERROR_STATUS: Record<ShiftBreakUpdatePublicErrorCode, number> = {
  SHIFT_BREAKS_ENTITLEMENT_REQUIRED: 403,
  SHIFT_BREAKS_CONFLICT: 409,
};

export async function readShiftBreakUpdateResponse<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return payload as T;

  const code = isRecord(payload)
    && typeof payload.code === 'string'
    && payload.code in PUBLIC_ERROR_STATUS
    && PUBLIC_ERROR_STATUS[payload.code as ShiftBreakUpdatePublicErrorCode] === response.status
    ? payload.code as ShiftBreakUpdatePublicErrorCode
    : null;
  const message = isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()
    ? payload.message.trim()
    : response.status === 403
      ? 'Saving manual lunch/break changes requires an active paid subscription and enough configured usage credits.'
      : response.status === 409
        ? 'This shift lunch/break save conflicts with its stored result. Retry unchanged values to recover it, or change the values to start a new attempt.'
        : `Unable to save shift lunch/breaks (${response.status}).`;
  const remediation = isRecord(payload) && typeof payload.remediation === 'string' && payload.remediation.trim()
    ? payload.remediation.trim()
    : null;
  throw new ShiftBreakUpdateRequestError(message, response.status, code, remediation);
}
