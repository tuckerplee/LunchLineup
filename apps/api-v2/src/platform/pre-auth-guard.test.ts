import { describe, expect, it, vi } from 'vitest';
import { NativeQuotaStorageUnavailableError, type NativeQuotaRecord } from './native-quota-storage';
import { createPreAuthGuard } from './pre-auth-guard';

const claims = { tenantId: 'tenant-1', sessionId: 'session-1' };
const allowed: NativeQuotaRecord = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };

describe('pre-auth session guard', () => {
  it('admits under the ceiling using an opaque per-session key', async () => {
    const increment = vi.fn(async () => ({ ...allowed }));
    await expect(createPreAuthGuard({ increment }, 5)(claims)).resolves.toBeUndefined();
    expect(increment).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), 60_000, 5, 60_000, 'preAuth');
  });
  it('maps a blocked bucket to 429', async () => {
    const increment = vi.fn(async () => ({ totalHits: 6, timeToExpire: 30, isBlocked: true, timeToBlockExpire: 42 }));
    await expect(createPreAuthGuard({ increment }, 5)(claims)).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });
  it('fails closed with 503 when storage is unavailable', async () => {
    const increment = vi.fn(async () => { throw new NativeQuotaStorageUnavailableError(); });
    await expect(createPreAuthGuard({ increment })(claims)).rejects.toMatchObject({ status: 503, code: 'rate_limit_storage_unavailable' });
  });
});
