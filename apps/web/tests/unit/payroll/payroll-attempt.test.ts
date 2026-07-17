import { describe, expect, it } from 'vitest';
import {
  clearPayrollAttempt,
  clearPayrollBrowserSession,
  createReconciliationReplay,
  getOrCreatePayrollAttempt,
  preparePayrollBrowserStorage,
  type PayrollAttemptStorage,
} from '../../../app/dashboard/payroll/payroll-attempt';

type MemoryStorage = PayrollAttemptStorage & {
  entries(): Array<[string, string]>;
};

function memoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    key: (index) => [...values.keys()][index] ?? null,
    entries: () => [...values.entries()],
  };
}

function serialized(storage: MemoryStorage): string {
  return JSON.stringify(storage.entries());
}

describe('payroll Idempotency-Key persistence', () => {
  it('replays one session key from SHA-256 digests without storing raw payroll payloads', async () => {
    const storage = memoryStorage();
    const markers = {
      periodId: 'P1_PERIOD_IDENTIFIER_93f49d',
      employeeId: 'P1_EMPLOYEE_IDENTIFIER_a8496f',
      reason: 'P1_AMENDMENT_REASON_d1670b',
      occurredAt: 'P1_TIMESTAMP_2026-07-16T21:44:12.345Z',
    };
    const first = await getOrCreatePayrollAttempt(storage, 'amendment-create', markers.periodId, markers, null, () => 'key-1');
    const replayed = await getOrCreatePayrollAttempt(storage, 'amendment-create', markers.periodId, { ...markers }, null, () => 'key-2');

    expect(replayed).toEqual(first);
    expect(first.scopeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.length).toBe(1);
    for (const marker of Object.values(markers)) expect(serialized(storage)).not.toContain(marker);
  });

  it('rotates the key when a sensitive payload changes', async () => {
    const storage = memoryStorage();
    const first = await getOrCreatePayrollAttempt(storage, 'export', 'period-1', { expectedCreditCost: 2 }, null, () => 'key-1');
    const changed = await getOrCreatePayrollAttempt(storage, 'export', 'period-1', { expectedCreditCost: 3 }, first, () => 'key-2');
    expect(changed.key).toBe('key-2');
    expect(changed.payloadDigest).not.toBe(first.payloadDigest);
  });

  it('scopes policy, lock, amendment, and export mutations independently', async () => {
    const storage = memoryStorage();
    const policy = await getOrCreatePayrollAttempt(storage, 'policy', 'tenant', { effectiveFrom: '2026-08-01' }, null, () => 'policy-key');
    const lock = await getOrCreatePayrollAttempt(storage, 'lock', 'period-1', { expectedRevision: 5 }, null, () => 'lock-key');
    const amendment = await getOrCreatePayrollAttempt(storage, 'amendment-create', 'entry-1', { reason: 'Correction' }, null, () => 'amend-key');
    expect([policy.key, lock.key, amendment.key]).toEqual(['policy-key', 'lock-key', 'amend-key']);
    expect(storage.length).toBe(3);
  });

  it('clears only a confirmed keyed mutation', async () => {
    const storage = memoryStorage();
    const attempt = await getOrCreatePayrollAttempt(storage, 'export', 'period-1', { expectedRevision: 4 }, null, () => 'key-1');
    clearPayrollAttempt(storage, attempt);
    expect(storage.length).toBe(0);
  });
});

describe('payroll browser-session boundaries', () => {
  it('purges legacy localStorage payloads and prevents cross-user attempt replay', async () => {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    const legacyMarkers = [
      'P1_PROVIDER_IDENTIFIER_17c75d',
      'P1_EVENT_IDENTIFIER_c820d9',
      'P1_OUTCOME_IDENTIFIER_78e617',
      'P1_REJECTION_REASON_b598ab',
      'P1_TIMESTAMP_2026-07-16T22:01:00.000Z',
    ];
    localStorage.setItem('lunchlineup.payroll-reconciliation.v1:batch-raw', JSON.stringify(legacyMarkers));
    sessionStorage.setItem('lunchlineup.payroll-attempt.v2:export:period-raw', JSON.stringify(legacyMarkers));

    const firstStorage = await preparePayrollBrowserStorage('P1_USER_A_f72fb8', { localStorage, sessionStorage });
    expect(firstStorage).toBe(sessionStorage);
    expect(localStorage.length).toBe(0);
    const first = await getOrCreatePayrollAttempt(firstStorage, 'export', 'P1_SCOPE_c95931', { marker: legacyMarkers[0] }, null, () => 'user-a-key');

    const secondStorage = await preparePayrollBrowserStorage('P1_USER_B_f152db', { localStorage, sessionStorage });
    const second = await getOrCreatePayrollAttempt(secondStorage, 'export', 'P1_SCOPE_c95931', { marker: legacyMarkers[0] }, null, () => 'user-b-key');
    expect(second.key).toBe('user-b-key');
    expect(second.key).not.toBe(first.key);
    for (const marker of [...legacyMarkers, 'P1_USER_A_f72fb8', 'P1_USER_B_f152db', 'P1_SCOPE_c95931']) {
      expect(serialized(sessionStorage)).not.toContain(marker);
    }

    clearPayrollBrowserSession(secondStorage);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps exact ambiguous reconciliation replay in memory only', () => {
    const localStorage = memoryStorage();
    const sessionStorage = memoryStorage();
    const payload = {
      provider: 'P1_PROVIDER_RAW_5330f6',
      providerEventId: 'P1_EVENT_RAW_3a54b7',
      providerTotalMinutes: 450,
      lines: [{ lineId: 'P1_OUTCOME_RAW_47fe12', status: 'REJECTED' as const, reason: 'P1_REJECTION_RAW_81bc3a' }],
    };

    const replay = createReconciliationReplay('batch-1', payload);
    expect(replay.payload).toEqual(payload);
    expect(replay.payload).not.toBe(payload);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
