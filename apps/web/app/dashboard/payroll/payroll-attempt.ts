import type { PayrollReconciliationInput } from './payroll-types';

export type PayrollAttemptAction = 'policy' | 'period-create' | 'adopt' | 'review' | 'decisions'
  | 'lock' | 'amendment-create' | 'amendment-decision' | 'export';

export type PayrollMutationAttempt = {
  action: PayrollAttemptAction;
  scope: string;
  scopeDigest: string;
  key: string;
  payloadDigest: string;
};

export type PayrollReconciliationReplay = {
  batchId: string;
  payload: PayrollReconciliationInput;
};

export type PayrollAttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

type PayrollBrowserStorages = {
  localStorage: PayrollAttemptStorage;
  sessionStorage: PayrollAttemptStorage;
};

type StoredPayrollMutationAttempt = Pick<PayrollMutationAttempt, 'action' | 'key' | 'payloadDigest'>;

const PAYROLL_STORAGE_PREFIX = 'lunchlineup.payroll-';
const ATTEMPT_PREFIX = 'lunchlineup.payroll-attempt.v3';
const SESSION_OWNER_KEY = 'lunchlineup.payroll-session.v1:owner';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortJson(entry)]));
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function payrollPayloadDigest(payload: unknown): Promise<string> {
  return sha256(JSON.stringify(sortJson(payload)));
}

function storageKeys(storage: PayrollAttemptStorage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

function clearPayrollKeys(storage: PayrollAttemptStorage, keepCurrentAttempts = false): void {
  try {
    for (const key of storageKeys(storage)) {
      if (!key.startsWith(PAYROLL_STORAGE_PREFIX)) continue;
      if (keepCurrentAttempts && (key === SESSION_OWNER_KEY || key.startsWith(`${ATTEMPT_PREFIX}:`))) continue;
      storage.removeItem(key);
    }
  } catch {
    // Browser storage is optional; in-memory attempts remain available.
  }
}

export function clearPayrollBrowserSession(storage: PayrollAttemptStorage | null): void {
  if (storage) clearPayrollKeys(storage);
}

function browserStorages(): PayrollBrowserStorages | null {
  if (typeof window === 'undefined') return null;
  try {
    return { localStorage: window.localStorage, sessionStorage: window.sessionStorage };
  } catch {
    return null;
  }
}

export async function preparePayrollBrowserStorage(
  currentUserId: string,
  storages: PayrollBrowserStorages | null = browserStorages(),
  isCurrent: () => boolean = () => true,
): Promise<PayrollAttemptStorage | null> {
  if (!storages) return null;

  clearPayrollKeys(storages.localStorage);
  let ownerDigest: string;
  try {
    ownerDigest = await sha256(currentUserId);
  } catch {
    clearPayrollKeys(storages.sessionStorage);
    return null;
  }
  if (!isCurrent()) return null;

  try {
    const priorOwner = storages.sessionStorage.getItem(SESSION_OWNER_KEY);
    clearPayrollKeys(storages.sessionStorage, priorOwner === ownerDigest);
    storages.sessionStorage.setItem(SESSION_OWNER_KEY, ownerDigest);
    return storages.sessionStorage;
  } catch {
    clearPayrollKeys(storages.sessionStorage);
    return null;
  }
}

function attemptStorageKey(action: PayrollAttemptAction, scopeDigest: string): string {
  return `${ATTEMPT_PREFIX}:${action}:${scopeDigest}`;
}

function readAttempt(storage: PayrollAttemptStorage | null, key: string): StoredPayrollMutationAttempt | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? 'null') as Partial<StoredPayrollMutationAttempt> | null;
    return parsed
      && typeof parsed.action === 'string'
      && typeof parsed.key === 'string'
      && parsed.key.length > 0
      && typeof parsed.payloadDigest === 'string'
      && SHA256_PATTERN.test(parsed.payloadDigest)
      ? parsed as StoredPayrollMutationAttempt
      : null;
  } catch {
    return null;
  }
}

export async function getOrCreatePayrollAttempt(
  storage: PayrollAttemptStorage | null,
  action: PayrollAttemptAction,
  scope: string,
  payload: unknown,
  current: PayrollMutationAttempt | null = null,
  keyFactory: () => string = () => globalThis.crypto.randomUUID(),
): Promise<PayrollMutationAttempt> {
  const [scopeDigest, payloadDigest] = await Promise.all([sha256(scope), payrollPayloadDigest(payload)]);
  const storageKey = attemptStorageKey(action, scopeDigest);
  const stored = readAttempt(storage, storageKey);
  if (current?.action === action && current.scope === scope && current.payloadDigest === payloadDigest) return current;
  if (stored?.action === action && stored.payloadDigest === payloadDigest) {
    return { action, scope, scopeDigest, key: stored.key, payloadDigest };
  }

  const key = keyFactory().trim();
  if (!key) throw new Error('Unable to create a stable payroll request key.');
  const attempt = { action, scope, scopeDigest, key, payloadDigest };
  try {
    storage?.setItem(storageKey, JSON.stringify({ action, key, payloadDigest } satisfies StoredPayrollMutationAttempt));
  } catch {
    // The caller retains the attempt in memory if browser storage is unavailable.
  }
  return attempt;
}

export function clearPayrollAttempt(storage: PayrollAttemptStorage | null, attempt: PayrollMutationAttempt): void {
  try {
    const key = attemptStorageKey(attempt.action, attempt.scopeDigest);
    const stored = readAttempt(storage, key);
    if (!stored || stored.key === attempt.key) storage?.removeItem(key);
  } catch {
    // Confirmed responses still clear the caller's in-memory copy.
  }
}

export function createReconciliationReplay(
  batchId: string,
  payload: PayrollReconciliationInput,
): PayrollReconciliationReplay {
  return {
    batchId,
    payload: {
      ...payload,
      lines: payload.lines.map((line) => ({ ...line })),
    },
  };
}
