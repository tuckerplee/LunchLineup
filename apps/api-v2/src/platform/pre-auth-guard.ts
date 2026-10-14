import { createHash } from 'node:crypto';
import { NativeQuotaStorageUnavailableError, type NativeQuotaRecord, type NativeQuotaStorage } from './native-quota-storage';
import { ProblemError } from './problem';
import type { PreAuthGuard } from './native-identity';

const WINDOW_MS = 60_000;
/** Generous per-session ceiling (requests/minute) applied before identity database work. */
export const PRE_AUTH_SESSION_LIMIT_PER_MIN = 3000;

/**
 * Flood guard keyed by the signature-verified session locator. It runs before
 * the identity adapter touches the database, so a leaked, revoked or expired
 * but correctly signed token cannot drive unbounded snapshot queries. Storage
 * failure is service unavailability (503), never an implicit admit.
 */
export function createPreAuthGuard(
  storage: Pick<NativeQuotaStorage, 'increment'>,
  limit: number = PRE_AUTH_SESSION_LIMIT_PER_MIN,
): PreAuthGuard {
  return async ({ tenantId, sessionId }) => {
    const key = createHash('sha256').update('api-preauth-session:' + tenantId + ':' + sessionId).digest('hex');
    let result: NativeQuotaRecord;
    try {
      result = await storage.increment(key, WINDOW_MS, limit, WINDOW_MS, 'preAuth');
    } catch (error) {
      if (error instanceof NativeQuotaStorageUnavailableError) {
        throw new ProblemError(503, 'rate_limit_storage_unavailable',
          'Request limits are temporarily unavailable.', 'Service unavailable');
      }
      throw error;
    }
    if (result.isBlocked) {
      const retryAfterSeconds = Math.max(1, result.timeToBlockExpire);
      throw new ProblemError(429, 'rate_limited', 'Too many requests. Try again later.', 'Too many requests', undefined, undefined, { retryAfterSeconds });
    }
  };
}
