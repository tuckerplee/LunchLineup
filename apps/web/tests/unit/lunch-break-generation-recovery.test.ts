import { describe, expect, it, vi } from 'vitest';

import {
  createLunchBreakGenerationSubmissionState,
  LUNCH_BREAK_GENERATION_MAX_RECOVERIES,
  LUNCH_BREAK_GENERATION_RECOVERY_KEY_PREFIX,
  LunchBreakGenerationRecoveryCapacityError,
  lunchBreakGenerationRecoveryFingerprint,
  readLunchBreakGenerationRecovery,
  submitLunchBreakGeneration,
  type LunchBreakGenerationRecoveryIdentity,
} from '../../app/dashboard/lunch-breaks/lunch-break-generation-recovery';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

const IDENTITY_A: LunchBreakGenerationRecoveryIdentity = {
  mode: 'scheduled',
  dateValue: '2026-07-16',
  locationId: 'location-a',
  tenantId: 'tenant-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

const REQUEST_A = {
  locationId: 'location-a',
  shiftIds: ['shift-a'],
  persist: true,
  policy: { lunchOffsetMinutes: 240 },
};

describe('lunch-break generation recovery', () => {
  it('reuses one A identity and debit across A-to-B-to-A, response loss, and reload', async () => {
    const storage = memoryStorage();
    const committed = new Map<string, { generated: string }>();
    const debits = new Map<string, number>();
    let loseFirstAResponse = true;
    const calls: Array<{ locationId: string; key: string }> = [];
    const send = vi.fn(async (body: typeof REQUEST_A, key: string) => {
      calls.push({ locationId: body.locationId, key });
      let response = committed.get(key);
      if (!response) {
        response = { generated: body.locationId };
        committed.set(key, response);
        debits.set(key, (debits.get(key) ?? 0) + 1);
      }
      if (body.locationId === 'location-a' && loseFirstAResponse) {
        loseFirstAResponse = false;
        throw new Error('Response lost after commit');
      }
      return response;
    });

    await expect(submitLunchBreakGeneration(
      createLunchBreakGenerationSubmissionState(),
      IDENTITY_A,
      REQUEST_A,
      storage,
      send,
    )).rejects.toThrow('Response lost after commit');

    const identityB = { ...IDENTITY_A, locationId: 'location-b' };
    const requestB = { ...REQUEST_A, locationId: 'location-b', shiftIds: ['shift-b'] };
    await submitLunchBreakGeneration(
      createLunchBreakGenerationSubmissionState(),
      identityB,
      requestB,
      storage,
      send,
    );

    const reloadResult = await submitLunchBreakGeneration(
      createLunchBreakGenerationSubmissionState(),
      { ...IDENTITY_A },
      { ...REQUEST_A, shiftIds: [...REQUEST_A.shiftIds] },
      storage,
      send,
    );

    const aCalls = calls.filter((call) => call.locationId === 'location-a');
    expect(reloadResult).toEqual({ submitted: true, value: { generated: 'location-a' } });
    expect(aCalls).toHaveLength(2);
    expect(new Set(aCalls.map((call) => call.key)).size).toBe(1);
    expect(debits.get(aCalls[0].key)).toBe(1);
    expect(committed.size).toBe(2);
  });

  it('derives the same key after storage loss and never stores generation payloads', async () => {
    const storage = memoryStorage();
    const keys: string[] = [];
    await expect(submitLunchBreakGeneration(
      createLunchBreakGenerationSubmissionState(),
      IDENTITY_A,
      REQUEST_A,
      storage,
      async (_body, key) => {
        keys.push(key);
        throw new Error('Lost response');
      },
    )).rejects.toThrow('Lost response');

    const fingerprint = await lunchBreakGenerationRecoveryFingerprint(IDENTITY_A, REQUEST_A);
    const persisted = readLunchBreakGenerationRecovery(storage, fingerprint);
    expect(persisted?.attempt.key).toBe(`lunch-break-generation:${fingerprint}`);
    const raw = Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index) ?? '') ?? '').join('');
    expect(raw).not.toMatch(/shift-a|location-a|tenant-1|user-1|session-1|requestBody/);
    expect(Array.from({ length: storage.length }, (_, index) => storage.key(index)))
      .toEqual([expect.stringMatching(new RegExp(`^${LUNCH_BREAK_GENERATION_RECOVERY_KEY_PREFIX}`))]);

    storage.clear();
    await submitLunchBreakGeneration(
      createLunchBreakGenerationSubmissionState(),
      IDENTITY_A,
      REQUEST_A,
      storage,
      async (_body, key) => {
        keys.push(key);
        return { generated: 'location-a' };
      },
    );
    expect(keys).toEqual([
      `lunch-break-generation:${fingerprint}`,
      `lunch-break-generation:${fingerprint}`,
    ]);
  });

  it.each([
    ['paid subscription restored', 403, 'Paid subscription is inactive.'],
    ['separate credits restored', 403, 'Insufficient usage credits balance.'],
    ['rolled-back transient persistence', 503, 'Lunch/break persistence temporarily failed.'],
  ])('retries unchanged intent after %s with one original key and debit', async (_label, status, message) => {
    const storage = memoryStorage();
    const state = createLunchBreakGenerationSubmissionState();
    const calls: Array<{ body: typeof REQUEST_A; key: string }> = [];
    let committedDebitCount = 0;
    const send = vi.fn(async (body: typeof REQUEST_A, key: string) => {
      calls.push({ body, key });
      if (calls.length === 1) {
        throw Object.assign(new Error(message), { status });
      }
      committedDebitCount += 1;
      return { generated: body.locationId };
    });

    await expect(submitLunchBreakGeneration(
      state,
      IDENTITY_A,
      REQUEST_A,
      storage,
      send,
    )).rejects.toMatchObject({ message, status });

    await expect(submitLunchBreakGeneration(
      state,
      { ...IDENTITY_A },
      { ...REQUEST_A, shiftIds: [...REQUEST_A.shiftIds] },
      storage,
      send,
    )).resolves.toEqual({ submitted: true, value: { generated: 'location-a' } });

    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual(calls[0].body);
    expect(calls[1].key).toBe(calls[0].key);
    expect(committedDebitCount).toBe(1);
  });

  it.each([
    ['mode', { ...IDENTITY_A, mode: 'manual' as const }],
    ['date', { ...IDENTITY_A, dateValue: '2026-07-17' }],
    ['location', { ...IDENTITY_A, locationId: 'location-b' }],
    ['tenant', { ...IDENTITY_A, tenantId: 'tenant-2' }],
    ['user', { ...IDENTITY_A, userId: 'user-2' }],
    ['session', { ...IDENTITY_A, sessionId: 'session-2' }],
  ])('binds the generation identity to %s', async (_part, changedIdentity) => {
    expect(await lunchBreakGenerationRecoveryFingerprint(changedIdentity, REQUEST_A))
      .not.toBe(await lunchBreakGenerationRecoveryFingerprint(IDENTITY_A, REQUEST_A));
  });

  it('partitions the recovery cap by opaque session identity', async () => {
    const storage = memoryStorage();
    const firstSessionState = createLunchBreakGenerationSubmissionState();
    for (let index = 0; index < LUNCH_BREAK_GENERATION_MAX_RECOVERIES; index += 1) {
      await expect(submitLunchBreakGeneration(
        firstSessionState,
        { ...IDENTITY_A, locationId: `location-${index}` },
        { ...REQUEST_A, locationId: `location-${index}`, shiftIds: [`shift-${index}`] },
        storage,
        vi.fn().mockRejectedValue(new Error('Lost response')),
      )).rejects.toThrow('Lost response');
    }

    const nextSessionSend = vi.fn().mockResolvedValue({ generated: 'next-session' });
    await expect(submitLunchBreakGeneration(
      createLunchBreakGenerationSubmissionState(),
      { ...IDENTITY_A, sessionId: 'session-2', locationId: 'next-location' },
      { ...REQUEST_A, locationId: 'next-location', shiftIds: ['next-shift'] },
      storage,
      nextSessionSend,
    )).resolves.toEqual({ submitted: true, value: { generated: 'next-session' } });
    expect(nextSessionSend).toHaveBeenCalledOnce();
  });

  it('preserves all eight same-session recoveries on ninth overflow and retries the oldest original key', async () => {
    const storage = memoryStorage();
    const state = createLunchBreakGenerationSubmissionState();
    const unresolved: Array<{
      identity: LunchBreakGenerationRecoveryIdentity;
      request: typeof REQUEST_A;
      key: string;
    }> = [];
    for (let index = 0; index < LUNCH_BREAK_GENERATION_MAX_RECOVERIES; index += 1) {
      const identity = { ...IDENTITY_A, locationId: `location-${index}` };
      const request = { ...REQUEST_A, locationId: `location-${index}`, shiftIds: [`shift-${index}`] };
      const key = `original-generation-key-${index}`;
      unresolved.push({ identity, request, key });
      await expect(submitLunchBreakGeneration(
        state,
        identity,
        request,
        storage,
        vi.fn().mockRejectedValue(new Error('Lost response')),
        () => key,
        () => index + 1,
      )).rejects.toThrow('Lost response');
    }

    const storedBeforeOverflow = Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index) ?? '';
      return [key, storage.getItem(key)] as const;
    }).sort(([left], [right]) => left.localeCompare(right));
    const overflowSend = vi.fn().mockResolvedValue({ generated: 'overflow' });
    await expect(submitLunchBreakGeneration(
      state,
      { ...IDENTITY_A, locationId: 'location-9' },
      { ...REQUEST_A, locationId: 'location-9', shiftIds: ['shift-9'] },
      storage,
      overflowSend,
    )).rejects.toBeInstanceOf(LunchBreakGenerationRecoveryCapacityError);
    expect(overflowSend).not.toHaveBeenCalled();
    expect(Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index) ?? '';
      return [key, storage.getItem(key)] as const;
    }).sort(([left], [right]) => left.localeCompare(right))).toEqual(storedBeforeOverflow);

    const oldest = unresolved[0];
    const replacementKeyFactory = vi.fn(() => 'replacement-key-must-not-be-used');
    const retrySend = vi.fn().mockResolvedValue({ generated: 'oldest' });
    await expect(submitLunchBreakGeneration(
      createLunchBreakGenerationSubmissionState(),
      oldest.identity,
      oldest.request,
      storage,
      retrySend,
      replacementKeyFactory,
    )).resolves.toEqual({ submitted: true, value: { generated: 'oldest' } });
    expect(retrySend).toHaveBeenCalledWith(oldest.request, oldest.key);
    expect(replacementKeyFactory).not.toHaveBeenCalled();
    expect(storage.length).toBe(LUNCH_BREAK_GENERATION_MAX_RECOVERIES - 1);
  });
});
