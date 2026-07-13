export const PENDING_FIRST_LOCATION_KEY = 'lunchlineup:onboarding:first-location:v1';
export const PENDING_FIRST_LOCATION_MAX_AGE_MS = 30 * 60 * 1000;

export type PendingFirstLocation = {
  requestKey: string;
  workspaceSlug: string;
  tenantName: string;
  firstLocationName: string;
  timezone: string;
  createdAt: number;
};

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isPendingFirstLocation(value: unknown): value is PendingFirstLocation {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingFirstLocation>;
  return typeof pending.createdAt === 'number'
    && Number.isFinite(pending.createdAt)
    && typeof pending.requestKey === 'string'
    && Boolean(pending.requestKey.trim())
    && typeof pending.workspaceSlug === 'string'
    && Boolean(pending.workspaceSlug.trim())
    && typeof pending.tenantName === 'string'
    && Boolean(pending.tenantName.trim())
    && typeof pending.firstLocationName === 'string'
    && Boolean(pending.firstLocationName.trim())
    && typeof pending.timezone === 'string'
    && Boolean(pending.timezone.trim());
}

export function savePendingFirstLocation(
  storage: RecoveryStorage,
  pending: PendingFirstLocation,
): void {
  storage.setItem(PENDING_FIRST_LOCATION_KEY, JSON.stringify({
    requestKey: pending.requestKey,
    workspaceSlug: pending.workspaceSlug,
    tenantName: pending.tenantName,
    firstLocationName: pending.firstLocationName,
    timezone: pending.timezone,
    createdAt: pending.createdAt,
  } satisfies PendingFirstLocation));
}

export function readPendingFirstLocation(
  storage: RecoveryStorage,
  now = Date.now(),
): PendingFirstLocation | null {
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_FIRST_LOCATION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const pending: unknown = JSON.parse(raw);
    if (!isPendingFirstLocation(pending)) return null;

    const age = now - pending.createdAt;
    if (age < 0 || age > PENDING_FIRST_LOCATION_MAX_AGE_MS) {
      storage.removeItem(PENDING_FIRST_LOCATION_KEY);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

export function clearPendingFirstLocation(storage: RecoveryStorage): void {
  storage.removeItem(PENDING_FIRST_LOCATION_KEY);
}
