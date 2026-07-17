import { fetchWithSession, withIdempotencyKey } from '../../lib/client-api';
import type { PendingFirstLocation } from './first-location-recovery';

export async function provisionPendingFirstLocation(pending: PendingFirstLocation): Promise<Response> {
  return fetchWithSession('/locations', withIdempotencyKey({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: pending.firstLocationName,
      tenantName: pending.tenantName,
      timezone: pending.timezone,
      workspaceSlug: pending.workspaceSlug,
    }),
  }, pending.requestKey));
}
