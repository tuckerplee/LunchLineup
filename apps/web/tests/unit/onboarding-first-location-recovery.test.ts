import { describe, expect, it } from 'vitest';

import {
  PENDING_FIRST_LOCATION_KEY,
  readPendingFirstLocation,
  savePendingFirstLocation,
  type PendingFirstLocation,
} from '../../app/onboarding/first-location-recovery';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const pending: PendingFirstLocation = {
  requestKey: 'first-location-request-123',
  workspaceSlug: 'acme-dining',
  tenantName: 'Acme Dining',
  firstLocationName: 'Downtown Bistro',
  timezone: 'America/Los_Angeles',
  createdAt: 1_000,
};

describe('first-location recovery', () => {
  it('preserves the same explicit idempotency key across browser recovery', () => {
    const storage = memoryStorage();

    savePendingFirstLocation(storage, pending);

    expect(readPendingFirstLocation(storage, 2_000)).toEqual(pending);
    expect(JSON.parse(storage.getItem(PENDING_FIRST_LOCATION_KEY) ?? '{}')).toMatchObject({
      requestKey: 'first-location-request-123',
    });
  });

  it('rejects legacy recovery state without a durable request key', () => {
    const storage = memoryStorage();
    const legacyPending = {
      workspaceSlug: pending.workspaceSlug,
      tenantName: pending.tenantName,
      firstLocationName: pending.firstLocationName,
      timezone: pending.timezone,
      createdAt: pending.createdAt,
    };
    storage.setItem(PENDING_FIRST_LOCATION_KEY, JSON.stringify(legacyPending));

    expect(readPendingFirstLocation(storage, 2_000)).toBeNull();
  });
});
