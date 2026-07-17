import { describe, expect, it } from 'vitest';
import {
  beginShiftUpdateAttempt,
  clearShiftUpdateAttempt,
  readShiftUpdateRecoveries,
} from '../../app/dashboard/scheduling/shift-update-recovery';

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

describe('shift update response-loss recovery', () => {
  it('reuses one payload-bound key after a browser reload', () => {
    const storage = memoryStorage();
    const payload = { startTime: '2026-03-10T17:00:00.000Z', endTime: '2026-03-10T21:00:00.000Z' };
    const first = beginShiftUpdateAttempt(storage, 'shift-1', payload, null, () => 'attempt-1', 1_000);
    const afterReload = beginShiftUpdateAttempt(storage, 'shift-1', { ...payload }, null, () => 'attempt-2', 2_000);

    expect(afterReload).toEqual(first);
    expect(readShiftUpdateRecoveries(storage, 2_000)).toEqual([
      expect.objectContaining({ shiftId: 'shift-1', attempt: first }),
    ]);
  });

  it('rotates for changed write semantics and only clears the matching completion', () => {
    const storage = memoryStorage();
    const first = beginShiftUpdateAttempt(storage, 'shift-1', { endTime: '21:00' }, null, () => 'attempt-1', 1_000);
    const changed = beginShiftUpdateAttempt(storage, 'shift-1', { endTime: '22:00' }, first, () => 'attempt-2', 2_000);

    expect(changed.key).toBe('attempt-2');
    clearShiftUpdateAttempt(storage, 'shift-1', first.key, 3_000);
    expect(readShiftUpdateRecoveries(storage, 3_000)[0]?.attempt.key).toBe('attempt-2');
    clearShiftUpdateAttempt(storage, 'shift-1', changed.key, 3_000);
    expect(readShiftUpdateRecoveries(storage, 3_000)).toEqual([]);
  });

  it('drops stale recovery keys after 24 hours', () => {
    const storage = memoryStorage();
    beginShiftUpdateAttempt(storage, 'shift-1', { endTime: '21:00' }, null, () => 'attempt-1', 1_000);
    expect(readShiftUpdateRecoveries(storage, 24 * 60 * 60 * 1000 + 1_001)).toEqual([]);
  });
});
