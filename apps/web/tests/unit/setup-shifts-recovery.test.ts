import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createSetupShiftsSubmissionState,
  readSetupShiftsRecovery,
  readSetupShiftsResponse,
  SETUP_SHIFTS_MAX_RECOVERIES,
  SETUP_SHIFTS_RECOVERY_KEY,
  SETUP_SHIFTS_RECOVERY_TTL_MS,
  SetupShiftsRecoveryCapacityError,
  setupShiftsRecoveryFingerprint,
  submitSetupShifts,
  type SetupShiftsRecoveryIdentity,
  type SetupShiftsIntent,
  type SetupShiftsRequestBody,
} from '../../app/dashboard/lunch-breaks/setup-shifts-recovery';
import {
  createShiftBreakUpdateSubmissionState,
  readShiftBreakUpdateRecovery,
  readShiftBreakUpdateResponse,
  SHIFT_BREAK_UPDATE_RECOVERY_TTL_MS,
  submitShiftBreakUpdate,
  type ShiftBreakUpdateIdentity,
  type ShiftBreakUpdateRequestBody,
} from '../../app/dashboard/lunch-breaks/shift-break-update-recovery';

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

const IDENTITY: SetupShiftsRecoveryIdentity = {
  dateValue: '2026-07-16',
  locationId: 'location-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

const INTENT: SetupShiftsIntent = {
  ...IDENTITY,
  rows: [{ employeeId: 'employee-1', startTime: '09:00', endTime: '17:00' }],
};

const REQUEST: SetupShiftsRequestBody = {
  locationId: 'location-1',
  rows: [{
    shiftId: null,
    userId: 'employee-1',
    startTime: '2026-07-16T16:00:00.000Z',
    endTime: '2026-07-17T00:00:00.000Z',
  }],
};

describe('setup-shifts response-loss recovery', () => {
  it('reuses the original key for the same request after a lost response and browser reload', async () => {
    const storage = memoryStorage();
    const keyFactory = vi.fn(() => 'setup-attempt-1');
    const firstState = createSetupShiftsSubmissionState();

    await expect(submitSetupShifts(
      firstState,
      INTENT,
      REQUEST,
      storage,
      vi.fn().mockRejectedValue(new Error('Lost response')),
      keyFactory,
    )).rejects.toThrow('Lost response');

    const unchangedBody: SetupShiftsRequestBody = {
      ...REQUEST,
      rows: REQUEST.rows.map((row) => ({ ...row })),
    };
    const afterReloadSend = vi.fn().mockResolvedValue({ shiftIds: ['server-created-shift-1'] });
    const result = await submitSetupShifts(
      createSetupShiftsSubmissionState(),
      { ...INTENT, rows: INTENT.rows.map((row) => ({ ...row })) },
      unchangedBody,
      storage,
      afterReloadSend,
      keyFactory,
    );

    expect(result).toEqual({ submitted: true, value: { shiftIds: ['server-created-shift-1'] } });
    expect(afterReloadSend).toHaveBeenCalledWith(REQUEST, 'setup-attempt-1');
    expect(keyFactory).toHaveBeenCalledOnce();
    const fingerprint = await setupShiftsRecoveryFingerprint(INTENT, REQUEST);
    expect(readSetupShiftsRecovery(storage, fingerprint)).toBeNull();
  });

  it('persists only an opaque full-scope/request fingerprint, key, session partition, and diagnostic timestamp', async () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 6, 16, 12);

    await expect(submitSetupShifts(
      createSetupShiftsSubmissionState(),
      INTENT,
      REQUEST,
      storage,
      vi.fn().mockRejectedValue(new Error('Lost response')),
      () => 'setup-attempt-1',
      () => now,
    )).rejects.toThrow('Lost response');

    const fingerprint = await setupShiftsRecoveryFingerprint(INTENT, REQUEST);
    expect(readSetupShiftsRecovery(storage, fingerprint, now)).toMatchObject({
      expiresAt: now + SETUP_SHIFTS_RECOVERY_TTL_MS,
      attempt: {
        key: 'setup-attempt-1',
        payloadFingerprint: fingerprint,
      },
    });
    const raw = storage.getItem(SETUP_SHIFTS_RECOVERY_KEY) ?? '';
    expect(JSON.parse(raw)).toHaveLength(1);
    expect(raw).not.toMatch(/requestBody|rows|employee-1|tenant-1|user-1|session-1|location-1|2026-07-16/);
  });

  it.each([
    ['date', { ...IDENTITY, dateValue: '2026-07-17' }],
    ['location', { ...IDENTITY, locationId: 'location-2' }],
    ['tenant', { ...IDENTITY, tenantId: 'tenant-2' }],
    ['user', { ...IDENTITY, userId: 'user-2' }],
    ['session', { ...IDENTITY, sessionId: 'session-2' }],
  ])('rejects recovery from a different %s scope without deleting the original', async (_scope, differentIdentity) => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 6, 16, 12);
    await expect(submitSetupShifts(
      createSetupShiftsSubmissionState(),
      INTENT,
      REQUEST,
      storage,
      vi.fn().mockRejectedValue(new Error('Lost response')),
      () => 'setup-attempt-1',
      () => now,
    )).rejects.toThrow();

    const differentIntent = { ...INTENT, ...differentIdentity };
    const differentRequest = differentIdentity.locationId === REQUEST.locationId
      ? REQUEST
      : { ...REQUEST, locationId: differentIdentity.locationId };
    const differentFingerprint = await setupShiftsRecoveryFingerprint(differentIntent, differentRequest);
    const originalFingerprint = await setupShiftsRecoveryFingerprint(INTENT, REQUEST);
    expect(readSetupShiftsRecovery(storage, differentFingerprint, now)).toBeNull();
    expect(readSetupShiftsRecovery(storage, originalFingerprint, now)).not.toBeNull();
  });

  it('does not rotate an unresolved identity after 24 hours or local storage loss', async () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 6, 16, 12);
    const attemptedKeys: string[] = [];
    await expect(submitSetupShifts(
      createSetupShiftsSubmissionState(),
      INTENT,
      REQUEST,
      storage,
      async (_body, key) => {
        attemptedKeys.push(key);
        throw new Error('Lost response');
      },
      undefined,
      () => now,
    )).rejects.toThrow();

    const fingerprint = await setupShiftsRecoveryFingerprint(INTENT, REQUEST);
    expect(readSetupShiftsRecovery(storage, fingerprint, now + SETUP_SHIFTS_RECOVERY_TTL_MS * 2)).not.toBeNull();
    storage.clear();
    await submitSetupShifts(
      createSetupShiftsSubmissionState(),
      INTENT,
      REQUEST,
      storage,
      async (_body, key) => {
        attemptedKeys.push(key);
        return { shiftIds: ['server-created-shift-1'] };
      },
      undefined,
      () => now + SETUP_SHIFTS_RECOVERY_TTL_MS * 2,
    );
    expect(attemptedKeys).toEqual([
      `setup-shifts:${fingerprint}`,
      `setup-shifts:${fingerprint}`,
    ]);
  });

  it('retains A across a failed B attempt and reuses A in an A-to-B-to-A retry', async () => {
    const storage = memoryStorage();
    const state = createSetupShiftsSubmissionState();
    const locationBIntent: SetupShiftsIntent = { ...INTENT, locationId: 'location-2' };
    const locationBRequest: SetupShiftsRequestBody = { ...REQUEST, locationId: 'location-2' };
    const keyFactory = vi.fn()
      .mockReturnValueOnce('setup-attempt-a')
      .mockReturnValueOnce('setup-attempt-b');
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('Lost A response'))
      .mockRejectedValueOnce(new Error('Lost B response'))
      .mockResolvedValueOnce({ shiftIds: ['shift-a'] });

    await expect(submitSetupShifts(state, INTENT, REQUEST, storage, send, keyFactory))
      .rejects.toThrow('Lost A response');
    await expect(submitSetupShifts(state, locationBIntent, locationBRequest, storage, send, keyFactory))
      .rejects.toThrow('Lost B response');
    await expect(submitSetupShifts(state, INTENT, { ...REQUEST, rows: REQUEST.rows.map((row) => ({ ...row })) }, storage, send, keyFactory))
      .resolves.toEqual({ submitted: true, value: { shiftIds: ['shift-a'] } });

    expect(send.mock.calls.map((call) => [call[0].locationId, call[1]])).toEqual([
      ['location-1', 'setup-attempt-a'],
      ['location-2', 'setup-attempt-b'],
      ['location-1', 'setup-attempt-a'],
    ]);
    expect(keyFactory).toHaveBeenCalledTimes(2);
    const fingerprintA = await setupShiftsRecoveryFingerprint(INTENT, REQUEST);
    const fingerprintB = await setupShiftsRecoveryFingerprint(locationBIntent, locationBRequest);
    expect(readSetupShiftsRecovery(storage, fingerprintA)).toBeNull();
    expect(readSetupShiftsRecovery(storage, fingerprintB)?.attempt.key).toBe('setup-attempt-b');
  });

  it('fails closed at capacity and preserves the oldest live key for an unchanged retry', async () => {
    const storage = memoryStorage();
    const state = createSetupShiftsSubmissionState();
    const baseNow = Date.UTC(2026, 6, 16, 12);
    const fingerprints: string[] = [];
    let keyIndex = 0;
    const keyFactory = vi.fn(() => `setup-attempt-${keyIndex++}`);
    const send = vi.fn().mockRejectedValue(new Error('Lost response'));

    for (let index = 0; index < SETUP_SHIFTS_MAX_RECOVERIES; index += 1) {
      const intent: SetupShiftsIntent = {
        ...INTENT,
        locationId: `location-${index}`,
        rows: [{ ...INTENT.rows[0], employeeId: `employee-${index}` }],
      };
      const request: SetupShiftsRequestBody = {
        ...REQUEST,
        locationId: intent.locationId,
        rows: [{ ...REQUEST.rows[0], userId: `employee-${index}` }],
      };
      fingerprints.push(await setupShiftsRecoveryFingerprint(intent, request));
      await expect(submitSetupShifts(
        state,
        intent,
        request,
        storage,
        send,
        keyFactory,
        () => baseNow + index,
      )).rejects.toThrow('Lost response');
    }

    const overflowIntent: SetupShiftsIntent = {
      ...INTENT,
      locationId: 'location-overflow',
      rows: [{ ...INTENT.rows[0], employeeId: 'employee-overflow' }],
    };
    const overflowRequest: SetupShiftsRequestBody = {
      ...REQUEST,
      locationId: overflowIntent.locationId,
      rows: [{ ...REQUEST.rows[0], userId: 'employee-overflow' }],
    };
    const finalNow = baseNow + SETUP_SHIFTS_MAX_RECOVERIES;
    await expect(submitSetupShifts(
      createSetupShiftsSubmissionState(),
      overflowIntent,
      overflowRequest,
      storage,
      send,
      keyFactory,
      () => finalNow,
    )).rejects.toBeInstanceOf(SetupShiftsRecoveryCapacityError);

    const persisted = JSON.parse(storage.getItem(SETUP_SHIFTS_RECOVERY_KEY) ?? '[]') as Array<{
      attempt: { key: string; payloadFingerprint: string };
    }>;
    expect(persisted).toHaveLength(SETUP_SHIFTS_MAX_RECOVERIES);
    expect(persisted.map((entry) => entry.attempt.key)).toEqual(
      Array.from({ length: SETUP_SHIFTS_MAX_RECOVERIES }, (_, index) => `setup-attempt-${index}`),
    );
    expect(keyFactory).toHaveBeenCalledTimes(SETUP_SHIFTS_MAX_RECOVERIES);
    expect(send).toHaveBeenCalledTimes(SETUP_SHIFTS_MAX_RECOVERIES);
    expect(readSetupShiftsRecovery(storage, fingerprints[0], finalNow)?.attempt.key).toBe('setup-attempt-0');

    const retrySend = vi.fn().mockResolvedValue({ shiftIds: ['replayed-shift-0'] });
    await expect(submitSetupShifts(
      createSetupShiftsSubmissionState(),
      {
        ...INTENT,
        locationId: 'location-0',
        rows: [{ ...INTENT.rows[0], employeeId: 'employee-0' }],
      },
      { ...REQUEST, locationId: 'location-0', rows: [{ ...REQUEST.rows[0], userId: 'employee-0' }] },
      storage,
      retrySend,
      keyFactory,
      () => finalNow,
    )).resolves.toEqual({ submitted: true, value: { shiftIds: ['replayed-shift-0'] } });
    expect(retrySend).toHaveBeenCalledWith(expect.any(Object), 'setup-attempt-0');
    expect(keyFactory).toHaveBeenCalledTimes(SETUP_SHIFTS_MAX_RECOVERIES);
  });

  it('partitions capacity by opaque session so a new login is not blocked by the prior session', async () => {
    const storage = memoryStorage();
    const priorSessionState = createSetupShiftsSubmissionState();
    const sendLost = vi.fn().mockRejectedValue(new Error('Lost response'));

    for (let index = 0; index < SETUP_SHIFTS_MAX_RECOVERIES; index += 1) {
      const intent: SetupShiftsIntent = {
        ...INTENT,
        locationId: `prior-location-${index}`,
      };
      await expect(submitSetupShifts(
        priorSessionState,
        intent,
        { ...REQUEST, locationId: intent.locationId },
        storage,
        sendLost,
      )).rejects.toThrow('Lost response');
    }

    const nextSessionIntent: SetupShiftsIntent = {
      ...INTENT,
      sessionId: 'session-2',
      locationId: 'next-session-location',
    };
    const nextSessionRequest = { ...REQUEST, locationId: nextSessionIntent.locationId };
    const nextSessionSend = vi.fn().mockResolvedValue({ shiftIds: ['next-session-shift'] });
    await expect(submitSetupShifts(
      createSetupShiftsSubmissionState(),
      nextSessionIntent,
      nextSessionRequest,
      storage,
      nextSessionSend,
    )).resolves.toEqual({ submitted: true, value: { shiftIds: ['next-session-shift'] } });

    expect(sendLost).toHaveBeenCalledTimes(SETUP_SHIFTS_MAX_RECOVERIES);
    expect(nextSessionSend).toHaveBeenCalledOnce();
    for (let index = 0; index < SETUP_SHIFTS_MAX_RECOVERIES; index += 1) {
      const intent: SetupShiftsIntent = { ...INTENT, locationId: `prior-location-${index}` };
      const request = { ...REQUEST, locationId: intent.locationId };
      const fingerprint = await setupShiftsRecoveryFingerprint(intent, request);
      expect(readSetupShiftsRecovery(storage, fingerprint)).not.toBeNull();
    }
  });

  it('keeps a deterministic identity after success and changes it only with full intent', async () => {
    const storage = memoryStorage();
    const state = createSetupShiftsSubmissionState();
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ shiftIds: ['shift-1'] })
      .mockResolvedValueOnce({ shiftIds: ['shift-2'] })
      .mockResolvedValueOnce({ shiftIds: ['shift-2'] });

    await expect(submitSetupShifts(state, INTENT, REQUEST, storage, send)).rejects.toThrow();
    await submitSetupShifts(state, INTENT, REQUEST, storage, send);

    const changedIntent = {
      ...INTENT,
      rows: [{ ...INTENT.rows[0], endTime: '18:00' }],
    };
    const changedRequest = {
      ...REQUEST,
      rows: [{ ...REQUEST.rows[0], endTime: '2026-07-17T01:00:00.000Z' }],
    };
    await submitSetupShifts(state, changedIntent, changedRequest, storage, send);
    await submitSetupShifts(state, changedIntent, changedRequest, storage, send);

    const originalFingerprint = await setupShiftsRecoveryFingerprint(INTENT, REQUEST);
    const changedFingerprint = await setupShiftsRecoveryFingerprint(changedIntent, changedRequest);

    expect(send.mock.calls.map((call) => call[1])).toEqual([
      `setup-shifts:${originalFingerprint}`,
      `setup-shifts:${originalFingerprint}`,
      `setup-shifts:${changedFingerprint}`,
      `setup-shifts:${changedFingerprint}`,
    ]);
  });

  it('uses one deterministic key and one semantic debit across a two-page race', async () => {
    const storage = memoryStorage();
    const committed = new Map<string, { shiftIds: string[] }>();
    let debits = 0;
    const send = vi.fn(async (_body: SetupShiftsRequestBody, key: string) => {
      await Promise.resolve();
      const replay = committed.get(key);
      if (replay) return replay;
      const response = { shiftIds: ['server-created-shift-1'] };
      committed.set(key, response);
      debits += 1;
      return response;
    });

    const [first, second] = await Promise.all([
      submitSetupShifts(createSetupShiftsSubmissionState(), INTENT, REQUEST, storage, send),
      submitSetupShifts(createSetupShiftsSubmissionState(), INTENT, REQUEST, storage, send),
    ]);
    const fingerprint = await setupShiftsRecoveryFingerprint(INTENT, REQUEST);

    expect(first).toEqual(second);
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      `setup-shifts:${fingerprint}`,
      `setup-shifts:${fingerprint}`,
    ]);
    expect(committed.size).toBe(1);
    expect(debits).toBe(1);
  });

  it('rejects a concurrent duplicate while the first request is unresolved', async () => {
    const storage = memoryStorage();
    const state = createSetupShiftsSubmissionState();
    let resolveSend: ((value: { shiftIds: string[] }) => void) | undefined;
    const send = vi.fn(() => new Promise<{ shiftIds: string[] }>((resolvePromise) => {
      resolveSend = resolvePromise;
    }));

    const first = submitSetupShifts(state, INTENT, REQUEST, storage, send, () => 'setup-attempt-1');
    await expect(submitSetupShifts(state, INTENT, REQUEST, storage, send)).resolves.toEqual({ submitted: false });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    resolveSend?.({ shiftIds: ['shift-1'] });
    await expect(first).resolves.toEqual({ submitted: true, value: { shiftIds: ['shift-1'] } });
  });

  it('allows a newer location scope to submit while an older scope remains unresolved', async () => {
    const storage = memoryStorage();
    const state = createSetupShiftsSubmissionState();
    const resolvers = new Map<string, (value: { shiftIds: string[] }) => void>();
    const send = vi.fn((body: SetupShiftsRequestBody) => new Promise<{ shiftIds: string[] }>((resolvePromise) => {
      resolvers.set(body.locationId, resolvePromise);
    }));
    const intentB: SetupShiftsIntent = {
      ...INTENT,
      locationId: 'location-2',
    };
    const requestB: SetupShiftsRequestBody = {
      ...REQUEST,
      locationId: 'location-2',
    };

    const first = submitSetupShifts(state, INTENT, REQUEST, storage, send);
    const second = submitSetupShifts(state, intentB, requestB, storage, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    resolvers.get('location-1')?.({ shiftIds: ['shift-a'] });
    await expect(first).resolves.toEqual({ submitted: true, value: { shiftIds: ['shift-a'] } });
    expect(state.inFlight.size).toBe(1);
    resolvers.get('location-2')?.({ shiftIds: ['shift-b'] });
    await expect(second).resolves.toEqual({ submitted: true, value: { shiftIds: ['shift-b'] } });
    expect(state.inFlight.size).toBe(0);
  });

  it.each([
    [403, 'SETUP_SHIFTS_ENTITLEMENT_REQUIRED', 'An active paid subscription and configured usage credits are required.'],
    [409, 'SETUP_SHIFTS_CONFLICT', 'Setup-shift request is already in progress.'],
  ])('surfaces the stable server code, message, and HTTP %i without treating it as success', async (status, code, message) => {
    const response = new Response(JSON.stringify({ code, message, remediation: 'Retry safely.' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(readSetupShiftsResponse(response)).rejects.toMatchObject({
      status,
      code,
      message,
      remediation: 'Retry safely.',
    });
  });

  it('provides actionable fallbacks for non-JSON 403 and 409 responses', async () => {
    await expect(readSetupShiftsResponse(new Response('unavailable', { status: 403 }))).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/active paid subscription.*usage credits/i),
    });
    await expect(readSetupShiftsResponse(new Response('conflict', { status: 409 }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/retry unchanged setup.*change the setup details/i),
    });
  });

  it('wires the retained request body and key into the setup-shifts request', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/dashboard/lunch-breaks/page.tsx'),
      'utf8',
    );
    expect(source).toContain("fetchLunchBreakMutation('/lunch-breaks/setup-shifts'");
    expect(source).toContain("withIdempotencyKey(jsonWriteInit('POST', retainedRequestBody), idempotencyKey)");
    expect(source).toContain("isApplyingSetupShifts ? 'Saving setup shifts...' : 'Continue to planner'");
  });
});

const SHIFT_IDENTITY: ShiftBreakUpdateIdentity = {
  shiftId: 'shift-1',
  dateValue: '2026-07-16',
  locationId: 'location-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

const SHIFT_REQUEST: ShiftBreakUpdateRequestBody = {
  locationId: 'location-1',
  breaks: [
    { type: 'break1', skip: true },
    { type: 'lunch', startTime: '2026-07-16T19:00:00.000Z', durationMinutes: 30, skip: false },
    { type: 'break2', skip: true },
  ],
};

describe('manual shift-break response-loss recovery', () => {
  it('reuses the original bounded key and body after a lost response and browser reload', async () => {
    const storage = memoryStorage();
    const keyFactory = vi.fn(() => 'shift-break-attempt-1');

    await expect(submitShiftBreakUpdate(
      createShiftBreakUpdateSubmissionState(),
      SHIFT_IDENTITY,
      SHIFT_REQUEST,
      storage,
      vi.fn().mockRejectedValue(new Error('Lost response')),
      keyFactory,
    )).rejects.toThrow('Lost response');

    const changedBody: ShiftBreakUpdateRequestBody = {
      ...SHIFT_REQUEST,
      breaks: SHIFT_REQUEST.breaks.map((entry) => ({ ...entry })),
    };
    const send = vi.fn().mockResolvedValue({ shiftId: 'shift-1' });
    const result = await submitShiftBreakUpdate(
      createShiftBreakUpdateSubmissionState(),
      { ...SHIFT_IDENTITY },
      changedBody,
      storage,
      send,
      keyFactory,
    );

    expect(result).toEqual({ submitted: true, value: { shiftId: 'shift-1' } });
    expect(send).toHaveBeenCalledWith(SHIFT_REQUEST, 'shift-break-attempt-1');
    expect(keyFactory).toHaveBeenCalledOnce();
    expect(readShiftBreakUpdateRecovery(storage, SHIFT_IDENTITY)).toBeNull();
  });

  it('binds recovery to shift, date, location, tenant, user, and session for 24 hours', async () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 6, 16, 12);
    await expect(submitShiftBreakUpdate(
      createShiftBreakUpdateSubmissionState(),
      SHIFT_IDENTITY,
      SHIFT_REQUEST,
      storage,
      vi.fn().mockRejectedValue(new Error('Lost response')),
      () => 'shift-break-attempt-1',
      () => now,
    )).rejects.toThrow('Lost response');

    expect(readShiftBreakUpdateRecovery(storage, SHIFT_IDENTITY, now)).toMatchObject({
      identity: SHIFT_IDENTITY,
      requestBody: SHIFT_REQUEST,
      expiresAt: now + SHIFT_BREAK_UPDATE_RECOVERY_TTL_MS,
    });
  });

  it.each([
    ['shift', { ...SHIFT_IDENTITY, shiftId: 'shift-2' }],
    ['date', { ...SHIFT_IDENTITY, dateValue: '2026-07-17' }],
    ['location', { ...SHIFT_IDENTITY, locationId: 'location-2' }],
    ['tenant', { ...SHIFT_IDENTITY, tenantId: 'tenant-2' }],
    ['user', { ...SHIFT_IDENTITY, userId: 'user-2' }],
    ['session', { ...SHIFT_IDENTITY, sessionId: 'session-2' }],
  ])('does not replay recovery in a different %s scope', async (_scope, differentIdentity) => {
    const storage = memoryStorage();
    await expect(submitShiftBreakUpdate(
      createShiftBreakUpdateSubmissionState(),
      SHIFT_IDENTITY,
      SHIFT_REQUEST,
      storage,
      vi.fn().mockRejectedValue(new Error('Lost response')),
      () => 'shift-break-attempt-1',
    )).rejects.toThrow();

    expect(readShiftBreakUpdateRecovery(storage, differentIdentity)).toBeNull();
  });

  it('drops expired recovery and rotates the key for a changed value', async () => {
    const storage = memoryStorage();
    const state = createShiftBreakUpdateSubmissionState();
    const now = Date.UTC(2026, 6, 16, 12);
    const keys = vi.fn().mockReturnValueOnce('shift-break-attempt-1').mockReturnValueOnce('shift-break-attempt-2');
    await expect(submitShiftBreakUpdate(
      state,
      SHIFT_IDENTITY,
      SHIFT_REQUEST,
      storage,
      vi.fn().mockRejectedValue(new Error('Lost response')),
      keys,
      () => now,
    )).rejects.toThrow();

    expect(readShiftBreakUpdateRecovery(storage, SHIFT_IDENTITY, now + SHIFT_BREAK_UPDATE_RECOVERY_TTL_MS)).toBeNull();

    const changedRequest: ShiftBreakUpdateRequestBody = {
      ...SHIFT_REQUEST,
      breaks: SHIFT_REQUEST.breaks.map((entry) => entry.type === 'lunch'
        ? { ...entry, durationMinutes: 45 }
        : { ...entry }),
    };
    const send = vi.fn().mockResolvedValue({ shiftId: 'shift-1' });
    await submitShiftBreakUpdate(state, SHIFT_IDENTITY, changedRequest, storage, send, keys, () => now + SHIFT_BREAK_UPDATE_RECOVERY_TTL_MS);

    expect(send).toHaveBeenCalledWith(changedRequest, 'shift-break-attempt-2');
  });

  it('rejects a concurrent duplicate for the same scoped shift', async () => {
    const storage = memoryStorage();
    const state = createShiftBreakUpdateSubmissionState();
    let resolveSend: ((value: { shiftId: string }) => void) | undefined;
    const send = vi.fn(() => new Promise<{ shiftId: string }>((resolvePromise) => {
      resolveSend = resolvePromise;
    }));
    const first = submitShiftBreakUpdate(state, SHIFT_IDENTITY, SHIFT_REQUEST, storage, send, () => 'shift-break-attempt-1');

    await expect(submitShiftBreakUpdate(state, SHIFT_IDENTITY, SHIFT_REQUEST, storage, send)).resolves.toEqual({ submitted: false });
    expect(send).toHaveBeenCalledOnce();
    resolveSend?.({ shiftId: 'shift-1' });
    await expect(first).resolves.toEqual({ submitted: true, value: { shiftId: 'shift-1' } });
  });

  it.each([
    [403, 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED'],
    [409, 'SHIFT_BREAKS_CONFLICT'],
  ])('surfaces stable manual-break code and HTTP %i', async (status, code) => {
    const response = new Response(JSON.stringify({ code, message: 'Public message.', remediation: 'Retry safely.' }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(readShiftBreakUpdateResponse(response)).rejects.toMatchObject({
      status,
      code,
      message: 'Public message.',
      remediation: 'Retry safely.',
    });
  });

  it('wires the retained body and key into the manual shift-break request', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/dashboard/lunch-breaks/page.tsx'), 'utf8');
    expect(source).toContain('submitShiftBreakUpdate(');
    expect(source).toContain("withIdempotencyKey(jsonWriteInit('PUT', retainedBody), idempotencyKey)");
    expect(source).toContain('ShiftBreakUpdateRequestError');
  });
});
