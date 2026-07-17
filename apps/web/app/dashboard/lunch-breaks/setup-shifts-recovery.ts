import type { IdempotentRequestAttempt } from '../../../lib/client-api';

export const SETUP_SHIFTS_RECOVERY_KEY = 'lunchlineup:setup-shifts-recovery:v2';
export const SETUP_SHIFTS_RECOVERY_RECORD_PREFIX = 'lunchlineup:setup-shifts-recovery:v3:';
export const SETUP_SHIFTS_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
export const SETUP_SHIFTS_MAX_RECOVERIES = 8;

const LEGACY_SETUP_SHIFTS_RECOVERY_KEY = 'lunchlineup:setup-shifts-recovery:v1';
const SHA256_FINGERPRINT = /^[a-f0-9]{64}$/;

export type SetupShiftsRecoveryIdentity = {
  dateValue: string;
  locationId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
};

export type SetupShiftPersistenceRow = {
  shiftId: string | null;
  startTime: string;
  endTime: string;
  userId?: string;
};

export type SetupShiftsRequestBody = {
  locationId: string;
  rows: SetupShiftPersistenceRow[];
};

export type SetupShiftsIntent = SetupShiftsRecoveryIdentity & {
  rows: Array<{
    employeeId: string;
    startTime: string;
    endTime: string;
  }>;
};

export type PersistedSetupShiftsRecovery = {
  attempt: IdempotentRequestAttempt;
  sessionFingerprint: string;
  createdAt: number;
  // Retained only for v2 diagnostics and migration. It never rotates an unresolved v3 identity.
  expiresAt: number;
};

export type SetupShiftsRecovery = PersistedSetupShiftsRecovery & {
  requestBody: SetupShiftsRequestBody;
};

export type SetupShiftsSubmissionState = {
  recoveries: Map<string, SetupShiftsRecovery>;
  inFlight: Set<string>;
};

export type SetupShiftsSubmissionResult<T> =
  | { submitted: false }
  | { submitted: true; value: T };

export class SetupShiftsRecoveryCapacityError extends Error {
  constructor() {
    super('Eight setup-shift attempts are still awaiting confirmation in this session. Retry one of those unchanged attempts before starting another.');
    this.name = 'SetupShiftsRecoveryCapacityError';
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

type SetupShiftsRecoveryManifestEntry = {
  attempt: IdempotentRequestAttempt;
  sessionFingerprint?: string;
  createdAt?: number;
  expiresAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isPrintableKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 255
    && !/[^\x20-\x7E]/.test(value);
}

function parseManifestRecovery(value: unknown): SetupShiftsRecoveryManifestEntry | null {
  if (!isRecord(value)
    || !isRecord(value.attempt)
    || typeof value.expiresAt !== 'number'
    || !Number.isSafeInteger(value.expiresAt)) {
    return null;
  }
  if (!isPrintableKey(value.attempt.key)
    || typeof value.attempt.payloadFingerprint !== 'string'
    || !SHA256_FINGERPRINT.test(value.attempt.payloadFingerprint)) return null;
  const recovery: SetupShiftsRecoveryManifestEntry = {
    attempt: {
      key: value.attempt.key,
      payloadFingerprint: value.attempt.payloadFingerprint,
    },
    expiresAt: value.expiresAt,
  };
  if (typeof value.sessionFingerprint === 'string' && SHA256_FINGERPRINT.test(value.sessionFingerprint)) {
    recovery.sessionFingerprint = value.sessionFingerprint;
  }
  if (typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt)) {
    recovery.createdAt = value.createdAt;
  }
  return recovery;
}

function parseSetupShiftsRecovery(value: unknown): PersistedSetupShiftsRecovery | null {
  const manifestRecovery = parseManifestRecovery(value);
  if (!manifestRecovery
    || !manifestRecovery.sessionFingerprint
    || manifestRecovery.createdAt === undefined) return null;
  return {
    ...manifestRecovery,
    sessionFingerprint: manifestRecovery.sessionFingerprint,
    createdAt: manifestRecovery.createdAt,
  };
}

function removeStorageKey(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Recovery cleanup is best effort when browser storage is unavailable.
  }
}

function removeLegacyRecovery(storage: StorageLike): void {
  removeStorageKey(storage, LEGACY_SETUP_SHIFTS_RECOVERY_KEY);
}

function storageKeys(storage: StorageLike): string[] {
  try {
    return Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => typeof key === 'string');
  } catch {
    return [];
  }
}

function recoveryStorageKey(sessionFingerprint: string, payloadFingerprint: string): string {
  return `${SETUP_SHIFTS_RECOVERY_RECORD_PREFIX}${sessionFingerprint}:${payloadFingerprint}`;
}

function writeRecoveryManifest(
  storage: StorageLike,
  recoveries: SetupShiftsRecoveryManifestEntry[],
): void {
  try {
    if (recoveries.length === 0) {
      storage.removeItem(SETUP_SHIFTS_RECOVERY_KEY);
      return;
    }
    storage.setItem(SETUP_SHIFTS_RECOVERY_KEY, JSON.stringify(recoveries));
  } catch {
    // The deterministic key and per-record storage remain authoritative.
  }
}

function readRecoveryManifest(storage: StorageLike): SetupShiftsRecoveryManifestEntry[] {
  removeLegacyRecovery(storage);
  try {
    const value: unknown = JSON.parse(storage.getItem(SETUP_SHIFTS_RECOVERY_KEY) ?? '[]');
    if (!Array.isArray(value)) {
      removeStorageKey(storage, SETUP_SHIFTS_RECOVERY_KEY);
      return [];
    }
    const byFingerprint = new Map<string, SetupShiftsRecoveryManifestEntry>();
    for (const entry of value) {
      const recovery = parseManifestRecovery(entry);
      if (!recovery) continue;
      byFingerprint.set(recovery.attempt.payloadFingerprint, recovery);
    }
    return [...byFingerprint.values()];
  } catch {
    removeStorageKey(storage, SETUP_SHIFTS_RECOVERY_KEY);
    return [];
  }
}

function readSetupShiftsRecoveries(storage: StorageLike): PersistedSetupShiftsRecovery[] {
  const recoveries: PersistedSetupShiftsRecovery[] = [];
  for (const key of storageKeys(storage)) {
    if (!key.startsWith(SETUP_SHIFTS_RECOVERY_RECORD_PREFIX)) continue;
    try {
      const recovery = parseSetupShiftsRecovery(JSON.parse(storage.getItem(key) ?? 'null'));
      if (!recovery || key !== recoveryStorageKey(
        recovery.sessionFingerprint,
        recovery.attempt.payloadFingerprint,
      )) {
        removeStorageKey(storage, key);
        continue;
      }
      recoveries.push(recovery);
    } catch {
      removeStorageKey(storage, key);
    }
  }
  return recoveries;
}

function mergeRecoveryManifest(
  legacyEntries: SetupShiftsRecoveryManifestEntry[],
  persistedRecoveries: PersistedSetupShiftsRecovery[],
): SetupShiftsRecoveryManifestEntry[] {
  const byFingerprint = new Map(legacyEntries.map((entry) => [
    entry.attempt.payloadFingerprint,
    entry,
  ]));
  for (const recovery of persistedRecoveries) {
    byFingerprint.set(recovery.attempt.payloadFingerprint, recovery);
  }
  return [...byFingerprint.values()].sort((left, right) => (
    (left.createdAt ?? left.expiresAt) - (right.createdAt ?? right.expiresAt)
  ));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function setupShiftsSessionFingerprint(
  identity: Pick<SetupShiftsRecoveryIdentity, 'tenantId' | 'userId' | 'sessionId'>,
): Promise<string> {
  return sha256(JSON.stringify(sortJsonValue({
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: identity.sessionId,
  })));
}

export function setupShiftsRecoveryFingerprint(
  intent: SetupShiftsIntent,
  requestBody: SetupShiftsRequestBody,
): Promise<string> {
  return sha256(JSON.stringify(sortJsonValue({
    scope: {
      dateValue: intent.dateValue,
      locationId: intent.locationId,
      sessionId: intent.sessionId,
      tenantId: intent.tenantId,
      userId: intent.userId,
    },
    requestBody,
    visibleRows: intent.rows,
  })));
}

export function readSetupShiftsRecovery(
  storage: StorageLike,
  expectedFingerprint: string,
  _now = Date.now(),
): PersistedSetupShiftsRecovery | null {
  if (!SHA256_FINGERPRINT.test(expectedFingerprint)) return null;
  return readSetupShiftsRecoveries(storage)
    .find((recovery) => recovery.attempt.payloadFingerprint === expectedFingerprint)
    ?? null;
}

function retainSetupShiftsRecovery(
  storage: StorageLike,
  recovery: PersistedSetupShiftsRecovery,
): PersistedSetupShiftsRecovery {
  const recoveries = readSetupShiftsRecoveries(storage);
  const existing = recoveries.find((entry) => (
    entry.attempt.payloadFingerprint === recovery.attempt.payloadFingerprint
  ));
  if (existing) return existing;

  const storageKey = recoveryStorageKey(
    recovery.sessionFingerprint,
    recovery.attempt.payloadFingerprint,
  );
  try {
    storage.setItem(storageKey, JSON.stringify(recovery));
  } catch {
    return recovery;
  }

  const currentRecoveries = readSetupShiftsRecoveries(storage);
  const currentSessionRecoveries = currentRecoveries.filter((entry) => (
    entry.sessionFingerprint === recovery.sessionFingerprint
  ));
  if (currentSessionRecoveries.length > SETUP_SHIFTS_MAX_RECOVERIES) {
    removeStorageKey(storage, storageKey);
    writeRecoveryManifest(
      storage,
      mergeRecoveryManifest(
        readRecoveryManifest(storage).filter((entry) => (
          entry.attempt.payloadFingerprint !== recovery.attempt.payloadFingerprint
        )),
        readSetupShiftsRecoveries(storage),
      ),
    );
    throw new SetupShiftsRecoveryCapacityError();
  }
  writeRecoveryManifest(
    storage,
    mergeRecoveryManifest(readRecoveryManifest(storage), currentRecoveries),
  );
  return currentRecoveries.find((entry) => (
    entry.attempt.payloadFingerprint === recovery.attempt.payloadFingerprint
  )) ?? recovery;
}

export function clearSetupShiftsRecovery(
  storage: StorageLike,
  payloadFingerprint: string,
  attemptKey: string,
  _now = Date.now(),
): void {
  for (const recovery of readSetupShiftsRecoveries(storage)) {
    if (recovery.attempt.payloadFingerprint === payloadFingerprint
      && recovery.attempt.key === attemptKey) {
      removeStorageKey(storage, recoveryStorageKey(
        recovery.sessionFingerprint,
        recovery.attempt.payloadFingerprint,
      ));
    }
  }
  const manifest = readRecoveryManifest(storage).filter((recovery) => (
    recovery.attempt.payloadFingerprint !== payloadFingerprint
    || recovery.attempt.key !== attemptKey
  ));
  writeRecoveryManifest(
    storage,
    mergeRecoveryManifest(manifest, readSetupShiftsRecoveries(storage)),
  );
}

export function createSetupShiftsSubmissionState(): SetupShiftsSubmissionState {
  return { recoveries: new Map(), inFlight: new Set() };
}

export async function submitSetupShifts<T>(
  state: SetupShiftsSubmissionState,
  intent: SetupShiftsIntent,
  requestBody: SetupShiftsRequestBody,
  storage: StorageLike,
  send: (requestBody: SetupShiftsRequestBody, idempotencyKey: string) => Promise<T>,
  keyFactory?: () => string,
  nowFactory: () => number = Date.now,
): Promise<SetupShiftsSubmissionResult<T>> {
  const [payloadFingerprint, sessionFingerprint] = await Promise.all([
    setupShiftsRecoveryFingerprint(intent, requestBody),
    setupShiftsSessionFingerprint(intent),
  ]);
  if (state.inFlight.has(payloadFingerprint)) return { submitted: false };

  state.inFlight.add(payloadFingerprint);
  try {
    const now = nowFactory();
    const inMemoryRecovery = state.recoveries.get(payloadFingerprint) ?? null;
    const persistedRecoveries = readSetupShiftsRecoveries(storage);
    const storedRecovery = persistedRecoveries.find((entry) => (
      entry.attempt.payloadFingerprint === payloadFingerprint
    )) ?? null;
    const legacyRecovery = storedRecovery
      ? null
      : readRecoveryManifest(storage).find((entry) => (
          entry.attempt.payloadFingerprint === payloadFingerprint
        )) ?? null;
    const persistedRecovery = storedRecovery
      ?? (legacyRecovery
        ? {
            attempt: legacyRecovery.attempt,
            sessionFingerprint,
            createdAt: legacyRecovery.createdAt ?? now,
            expiresAt: legacyRecovery.expiresAt,
          }
        : null);
    if (!inMemoryRecovery && !persistedRecovery) {
      const liveFingerprints = new Set([
        ...[...state.recoveries.values()]
          .filter((entry) => entry.sessionFingerprint === sessionFingerprint)
          .map((entry) => entry.attempt.payloadFingerprint),
        ...persistedRecoveries
          .filter((entry) => entry.sessionFingerprint === sessionFingerprint)
          .map((entry) => entry.attempt.payloadFingerprint),
      ]);
      if (liveFingerprints.size >= SETUP_SHIFTS_MAX_RECOVERIES) {
        throw new SetupShiftsRecoveryCapacityError();
      }
    }
    const recovery: SetupShiftsRecovery = inMemoryRecovery
      ?? (persistedRecovery
        ? { ...persistedRecovery, requestBody }
        : {
            attempt: {
              key: keyFactory ? keyFactory() : `setup-shifts:${payloadFingerprint}`,
              payloadFingerprint,
            },
            sessionFingerprint,
            createdAt: now,
            expiresAt: now + SETUP_SHIFTS_RECOVERY_TTL_MS,
            requestBody,
          });
    const retainedRecovery = retainSetupShiftsRecovery(storage, {
      attempt: recovery.attempt,
      sessionFingerprint: recovery.sessionFingerprint,
      createdAt: recovery.createdAt,
      expiresAt: recovery.expiresAt,
    });
    const activeRecovery: SetupShiftsRecovery = {
      ...retainedRecovery,
      requestBody: recovery.requestBody,
    };
    state.recoveries.set(payloadFingerprint, activeRecovery);

    const value = await send(activeRecovery.requestBody, activeRecovery.attempt.key);
    clearSetupShiftsRecovery(storage, payloadFingerprint, activeRecovery.attempt.key, now);
    if (state.recoveries.get(payloadFingerprint)?.attempt.key === activeRecovery.attempt.key) {
      state.recoveries.delete(payloadFingerprint);
    }
    return { submitted: true, value };
  } finally {
    state.inFlight.delete(payloadFingerprint);
  }
}

export class SetupShiftsRequestError extends Error {
  readonly status: number;
  readonly code: SetupShiftsPublicErrorCode | null;
  readonly remediation: string | null;

  constructor(
    message: string,
    status: number,
    code: SetupShiftsPublicErrorCode | null = null,
    remediation: string | null = null,
  ) {
    super(message);
    this.name = 'SetupShiftsRequestError';
    this.status = status;
    this.code = code;
    this.remediation = remediation;
  }
}

export type SetupShiftsPublicErrorCode =
  | 'SETUP_SHIFTS_ENTITLEMENT_REQUIRED'
  | 'SETUP_SHIFTS_CONFLICT';

const PUBLIC_ERROR_STATUS: Record<SetupShiftsPublicErrorCode, number> = {
  SETUP_SHIFTS_ENTITLEMENT_REQUIRED: 403,
  SETUP_SHIFTS_CONFLICT: 409,
};

function publicErrorDetails(
  payload: unknown,
  status: number,
): { code: SetupShiftsPublicErrorCode; remediation: string | null } | null {
  if (!isRecord(payload) || typeof payload.code !== 'string') return null;
  if (!(payload.code in PUBLIC_ERROR_STATUS)) return null;
  const code = payload.code as SetupShiftsPublicErrorCode;
  if (PUBLIC_ERROR_STATUS[code] !== status) return null;
  return {
    code,
    remediation: typeof payload.remediation === 'string' && payload.remediation.trim()
      ? payload.remediation.trim()
      : null,
  };
}

function responseMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  if (Array.isArray(payload.message)) {
    const messages = payload.message.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
    if (messages.length > 0) return messages.join(' ');
  }
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
  return null;
}

function fallbackResponseMessage(status: number): string {
  if (status === 403) {
    return 'Setup shifts require an active paid subscription and enough separately purchased usage credits.';
  }
  if (status === 409) {
    return 'This setup-shift attempt conflicts with its stored result. Retry unchanged setup to recover it, or change the setup details to start a new attempt.';
  }
  return `Unable to persist setup shifts (${status}).`;
}

export async function readSetupShiftsResponse(response: Response): Promise<{ shiftIds: string[] }> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const publicError = publicErrorDetails(payload, response.status);
    throw new SetupShiftsRequestError(
      responseMessage(payload) ?? fallbackResponseMessage(response.status),
      response.status,
      publicError?.code ?? null,
      publicError?.remediation ?? null,
    );
  }

  const shiftIds = isRecord(payload) && Array.isArray(payload.shiftIds)
    ? payload.shiftIds.filter((value): value is string => typeof value === 'string')
    : [];
  return { shiftIds };
}
