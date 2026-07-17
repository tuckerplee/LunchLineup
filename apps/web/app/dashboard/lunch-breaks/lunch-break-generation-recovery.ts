import type { IdempotentRequestAttempt } from '../../../lib/client-api';

export const LUNCH_BREAK_GENERATION_RECOVERY_KEY_PREFIX = 'lunchlineup:lunch-break-generation-recovery:v1:';
export const LUNCH_BREAK_GENERATION_MAX_RECOVERIES = 8;

const SHA256_FINGERPRINT = /^[a-f0-9]{64}$/;

export type LunchBreakGenerationRecoveryIdentity = {
  mode: 'manual' | 'scheduled';
  dateValue: string;
  locationId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
};

export type PersistedLunchBreakGenerationRecovery = {
  attempt: IdempotentRequestAttempt;
  sessionFingerprint: string;
  createdAt: number;
};

type LunchBreakGenerationRecovery = PersistedLunchBreakGenerationRecovery & {
  requestBody: unknown;
};

export type LunchBreakGenerationSubmissionState = {
  recoveries: Map<string, LunchBreakGenerationRecovery>;
  inFlight: Set<string>;
};

export type LunchBreakGenerationSubmissionResult<T> =
  | { submitted: false }
  | { submitted: true; value: T };

export class LunchBreakGenerationRecoveryCapacityError extends Error {
  constructor() {
    super('Eight lunch/break generation attempts are still awaiting confirmation in this session. Retry one unchanged attempt before starting another.');
    this.name = 'LunchBreakGenerationRecoveryCapacityError';
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isPrintableKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 255
    && !/[^\x20-\x7E]/.test(value);
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

export function lunchBreakGenerationSessionFingerprint(
  identity: Pick<LunchBreakGenerationRecoveryIdentity, 'tenantId' | 'userId' | 'sessionId'>,
): Promise<string> {
  return sha256(JSON.stringify(sortJsonValue({
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: identity.sessionId,
  })));
}

export function lunchBreakGenerationRecoveryFingerprint(
  identity: LunchBreakGenerationRecoveryIdentity,
  requestBody: unknown,
): Promise<string> {
  return sha256(JSON.stringify(sortJsonValue({ identity, requestBody })));
}

function generationAttemptKey(payloadFingerprint: string): string {
  return `lunch-break-generation:${payloadFingerprint}`;
}

function recoveryStorageKey(sessionFingerprint: string, payloadFingerprint: string): string {
  return `${LUNCH_BREAK_GENERATION_RECOVERY_KEY_PREFIX}${sessionFingerprint}:${payloadFingerprint}`;
}

function parseRecovery(value: unknown): PersistedLunchBreakGenerationRecovery | null {
  if (!isRecord(value)
    || !isRecord(value.attempt)
    || typeof value.createdAt !== 'number'
    || !Number.isSafeInteger(value.createdAt)
    || typeof value.sessionFingerprint !== 'string'
    || !SHA256_FINGERPRINT.test(value.sessionFingerprint)
    || !isPrintableKey(value.attempt.key)
    || typeof value.attempt.payloadFingerprint !== 'string'
    || !SHA256_FINGERPRINT.test(value.attempt.payloadFingerprint)) {
    return null;
  }
  return {
    attempt: {
      key: value.attempt.key,
      payloadFingerprint: value.attempt.payloadFingerprint,
    },
    sessionFingerprint: value.sessionFingerprint,
    createdAt: value.createdAt,
  };
}

function storageKeys(storage: StorageLike): string[] {
  try {
    return Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => typeof key === 'string');
  } catch {
    return [];
  }
}

function removeStorageKey(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // In-memory deterministic recovery remains available when storage is unavailable.
  }
}

function readPersistedRecoveries(storage: StorageLike): PersistedLunchBreakGenerationRecovery[] {
  const recoveries: PersistedLunchBreakGenerationRecovery[] = [];
  for (const key of storageKeys(storage)) {
    if (!key.startsWith(LUNCH_BREAK_GENERATION_RECOVERY_KEY_PREFIX)) continue;
    try {
      const recovery = parseRecovery(JSON.parse(storage.getItem(key) ?? 'null'));
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

function retainRecovery(
  storage: StorageLike,
  recovery: PersistedLunchBreakGenerationRecovery,
): PersistedLunchBreakGenerationRecovery {
  const storageKey = recoveryStorageKey(
    recovery.sessionFingerprint,
    recovery.attempt.payloadFingerprint,
  );
  const existing = readPersistedRecoveries(storage).find((entry) => (
    entry.attempt.payloadFingerprint === recovery.attempt.payloadFingerprint
  ));
  if (existing) return existing;

  try {
    storage.setItem(storageKey, JSON.stringify(recovery));
  } catch {
    return recovery;
  }

  const sessionRecoveries = readPersistedRecoveries(storage)
    .filter((entry) => entry.sessionFingerprint === recovery.sessionFingerprint);
  if (sessionRecoveries.length > LUNCH_BREAK_GENERATION_MAX_RECOVERIES) {
    removeStorageKey(storage, storageKey);
    throw new LunchBreakGenerationRecoveryCapacityError();
  }
  return sessionRecoveries.find((entry) => (
    entry.attempt.payloadFingerprint === recovery.attempt.payloadFingerprint
  )) ?? recovery;
}

export function readLunchBreakGenerationRecovery(
  storage: StorageLike,
  payloadFingerprint: string,
): PersistedLunchBreakGenerationRecovery | null {
  if (!SHA256_FINGERPRINT.test(payloadFingerprint)) return null;
  return readPersistedRecoveries(storage).find((entry) => (
    entry.attempt.payloadFingerprint === payloadFingerprint
  )) ?? null;
}

function clearRecovery(
  storage: StorageLike,
  recovery: PersistedLunchBreakGenerationRecovery,
): void {
  const current = readLunchBreakGenerationRecovery(storage, recovery.attempt.payloadFingerprint);
  if (current?.attempt.key !== recovery.attempt.key) return;
  removeStorageKey(storage, recoveryStorageKey(
    recovery.sessionFingerprint,
    recovery.attempt.payloadFingerprint,
  ));
}

export function createLunchBreakGenerationSubmissionState(): LunchBreakGenerationSubmissionState {
  return { recoveries: new Map(), inFlight: new Set() };
}

export async function submitLunchBreakGeneration<TBody, TResult>(
  state: LunchBreakGenerationSubmissionState,
  identity: LunchBreakGenerationRecoveryIdentity,
  requestBody: TBody,
  storage: StorageLike,
  send: (requestBody: TBody, idempotencyKey: string) => Promise<TResult>,
  keyFactory?: (payloadFingerprint: string) => string,
  nowFactory: () => number = Date.now,
): Promise<LunchBreakGenerationSubmissionResult<TResult>> {
  const [payloadFingerprint, sessionFingerprint] = await Promise.all([
    lunchBreakGenerationRecoveryFingerprint(identity, requestBody),
    lunchBreakGenerationSessionFingerprint(identity),
  ]);
  if (state.inFlight.has(payloadFingerprint)) return { submitted: false };

  const inMemoryRecovery = state.recoveries.get(payloadFingerprint) ?? null;
  const persistedRecoveries = readPersistedRecoveries(storage);
  const persistedRecovery = persistedRecoveries.find((entry) => (
    entry.attempt.payloadFingerprint === payloadFingerprint
  )) ?? null;
  if (!inMemoryRecovery && !persistedRecovery) {
    const currentSessionFingerprints = new Set([
      ...[...state.recoveries.values()]
        .filter((entry) => entry.sessionFingerprint === sessionFingerprint)
        .map((entry) => entry.attempt.payloadFingerprint),
      ...persistedRecoveries
        .filter((entry) => entry.sessionFingerprint === sessionFingerprint)
        .map((entry) => entry.attempt.payloadFingerprint),
    ]);
    if (currentSessionFingerprints.size >= LUNCH_BREAK_GENERATION_MAX_RECOVERIES) {
      throw new LunchBreakGenerationRecoveryCapacityError();
    }
  }

  const candidate: LunchBreakGenerationRecovery = inMemoryRecovery
    ?? (persistedRecovery
      ? { ...persistedRecovery, requestBody }
      : {
          attempt: {
            key: keyFactory
              ? keyFactory(payloadFingerprint)
              : generationAttemptKey(payloadFingerprint),
            payloadFingerprint,
          },
          sessionFingerprint,
          createdAt: nowFactory(),
          requestBody,
        });
  const retained = retainRecovery(storage, {
    attempt: candidate.attempt,
    sessionFingerprint: candidate.sessionFingerprint,
    createdAt: candidate.createdAt,
  });
  const activeRecovery: LunchBreakGenerationRecovery = {
    ...retained,
    requestBody: candidate.requestBody,
  };
  state.recoveries.set(payloadFingerprint, activeRecovery);
  state.inFlight.add(payloadFingerprint);

  try {
    const value = await send(activeRecovery.requestBody as TBody, activeRecovery.attempt.key);
    clearRecovery(storage, activeRecovery);
    if (state.recoveries.get(payloadFingerprint)?.attempt.key === activeRecovery.attempt.key) {
      state.recoveries.delete(payloadFingerprint);
    }
    return { submitted: true, value };
  } finally {
    state.inFlight.delete(payloadFingerprint);
  }
}
