import { describe, expect, it } from 'vitest';
import {
  clearAutoScheduleRecovery,
  readAutoScheduleRecoveries,
  saveAutoScheduleRecovery,
} from '../../app/dashboard/scheduling/auto-schedule-recovery';

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

describe('auto-schedule reload recovery', () => {
  it('preserves the paid request attempt and later job polling identity', () => {
    const storage = memoryStorage();
    saveAutoScheduleRecovery(storage, {
      scheduleId: 'schedule-1', attemptKey: 'attempt-1', confirmReplace: true, updatedAt: 1_000,
    });
    saveAutoScheduleRecovery(storage, {
      scheduleId: 'schedule-1', attemptKey: 'attempt-1', confirmReplace: true,
      jobId: 'job-1', statusUrl: '/schedules/schedule-1/auto-schedule/jobs/job-1', updatedAt: 2_000,
    });

    expect(readAutoScheduleRecoveries(storage, 3_000)).toEqual([expect.objectContaining({
      attemptKey: 'attempt-1', jobId: 'job-1', statusUrl: expect.stringContaining('job-1'),
    })]);
    clearAutoScheduleRecovery(storage, 'schedule-1');
    expect(readAutoScheduleRecoveries(storage, 3_000)).toEqual([]);
  });

  it('drops stale recovery identities after 24 hours', () => {
    const storage = memoryStorage();
    saveAutoScheduleRecovery(storage, {
      scheduleId: 'schedule-1', attemptKey: 'attempt-1', confirmReplace: false, updatedAt: 1_000,
    });
    expect(readAutoScheduleRecoveries(storage, 24 * 60 * 60 * 1000 + 1_001)).toEqual([]);
  });
});
