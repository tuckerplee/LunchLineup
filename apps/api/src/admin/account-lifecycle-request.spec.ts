import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_LIFECYCLE_REQUEST_PREFIX, projectAccountLifecycleRequest, recordAccountLifecycleRequest } from './account-lifecycle-request';
const base = { requestId: 'request-1', kind: 'CANCELLATION', state: 'PENDING', requestedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' };
afterEach(() => vi.useRealTimers());
describe('customer lifecycle request records', () => {
  it.each([null, [], {}, { ...base, requestId: '' }, { ...base, requestId: 'x'.repeat(256) }, { ...base, kind: 'EXPORT' }, { ...base, state: 'ASSUMED_COMPLETE' }, { ...base, requestedAt: 'bad' }, { ...base, updatedAt: 'bad' }])('omits malformed record %j', value => {
    expect(projectAccountLifecycleRequest(value)).toBeNull();
  });
  it('projects only the five public fields and never leaks actor/provider/lease data', () => {
    expect(projectAccountLifecycleRequest({ ...base, actorUserId: 'private', leaseOwner: 'private', providerResult: { secret: 'private' } })).toEqual(base);
  });
  it.each(['COMPLETED', 'BLOCKED', 'SUPERSEDED'] as const)('preserves original requestedAt and exact ID through %s retry update', async state => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
    const tx: any = { tenantSetting: { findUnique: vi.fn().mockResolvedValue({ value: base }), upsert: vi.fn() } };
    await recordAccountLifecycleRequest(tx, { tenantId: 'tenant-A', requestId: base.requestId, kind: 'CANCELLATION', state, requestedAt: new Date() });
    const where = { tenantId_key: { tenantId: 'tenant-A', key: ACCOUNT_LIFECYCLE_REQUEST_PREFIX + base.requestId } };
    const value = { ...base, state, updatedAt: new Date().toISOString() };
    expect(tx.tenantSetting.findUnique).toHaveBeenCalledExactlyOnceWith({ where, select: { value: true } });
    expect(tx.tenantSetting.upsert).toHaveBeenCalledExactlyOnceWith({ where, create: { tenantId: 'tenant-A', key: ACCOUNT_LIFECYCLE_REQUEST_PREFIX + base.requestId, value }, update: { value } });
  });
  it('propagates receipt write failure instead of claiming a successful transition', async () => {
    const tx: any = { tenantSetting: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockRejectedValue(new Error('controlled receipt failure')) } };
    await expect(recordAccountLifecycleRequest(tx, { tenantId: 'tenant-A', requestId: 'delete-A', kind: 'DELETION', state: 'PENDING' })).rejects.toThrow('controlled receipt failure');
  });
});
