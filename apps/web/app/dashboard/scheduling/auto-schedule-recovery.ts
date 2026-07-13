export const AUTO_SCHEDULE_RECOVERY_KEY = 'lunchlineup:auto-schedule-recovery:v1';

export type AutoScheduleRecovery = {
  scheduleId: string;
  attemptKey: string;
  confirmReplace: boolean;
  jobId?: string;
  statusUrl?: string;
  updatedAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readAutoScheduleRecoveries(
  storage: StorageLike,
  now = Date.now(),
): AutoScheduleRecovery[] {
  try {
    const value = JSON.parse(storage.getItem(AUTO_SCHEDULE_RECOVERY_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is AutoScheduleRecovery => (
      entry
      && typeof entry.scheduleId === 'string'
      && typeof entry.attemptKey === 'string'
      && typeof entry.confirmReplace === 'boolean'
      && typeof entry.updatedAt === 'number'
      && now - entry.updatedAt <= 24 * 60 * 60 * 1000
    ));
  } catch {
    return [];
  }
}

export function saveAutoScheduleRecovery(
  storage: StorageLike,
  recovery: AutoScheduleRecovery,
): void {
  const entries = readAutoScheduleRecoveries(storage)
    .filter((entry) => entry.scheduleId !== recovery.scheduleId);
  entries.push(recovery);
  storage.setItem(AUTO_SCHEDULE_RECOVERY_KEY, JSON.stringify(entries));
}

export function clearAutoScheduleRecovery(storage: StorageLike, scheduleId: string): void {
  const entries = readAutoScheduleRecoveries(storage)
    .filter((entry) => entry.scheduleId !== scheduleId);
  if (entries.length === 0) {
    storage.removeItem(AUTO_SCHEDULE_RECOVERY_KEY);
    return;
  }
  storage.setItem(AUTO_SCHEDULE_RECOVERY_KEY, JSON.stringify(entries));
}
