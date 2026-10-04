import { describe, expect, it, vi } from 'vitest';
import { LunchBreakService } from './lunch-breaks.service';

describe('generation recovery and standalone shifts', () => {
  it('reclaims a rolled-back concurrency rejection with the original key', async () => {
    const transaction = { lunchBreakGenerationRequest: {
      findUnique: vi.fn().mockResolvedValue({ id: 'attempt', requestHash: 'body', status: 'FAILED', failureStatus: 409 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    } };
    const service = new LunchBreakService({ withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(transaction) } as never);
    await expect(service['claimGeneration']({ run: async (fn: (tx: unknown, identity: unknown, guard: () => void) => unknown) => fn(transaction, {}, () => undefined) } as never, 'tenant', 'retained-key', 'body')).resolves.toMatchObject({ requestId: 'attempt' });
    expect(transaction.lunchBreakGenerationRequest.updateMany).toHaveBeenCalledOnce();
  });
  it('accepts a saved standalone shift but rejects a changed snapshot', async () => {
    const row = { id: 'shift', publicId: 'public', scheduleId: null, schedule: null, location: { publicId: 'location' }, startTime: new Date('2026-09-08T12:00:00Z'), endTime: new Date('2026-09-08T20:00:00Z'), updatedAt: new Date('2026-09-08T10:00:00Z') };
    const transaction = { $queryRaw: vi.fn().mockResolvedValue([]), shift: { findMany: vi.fn().mockResolvedValue([row]) } };
    const service = new LunchBreakService({} as never);
    const prepared = { locationId: 'location', data: [{}], snapshot: [{ id: row.id, publicId: row.publicId, scheduleId: null, startTime: row.startTime.toISOString(), endTime: row.endTime.toISOString(), updatedAt: row.updatedAt.toISOString() }] };
    await expect(service['assertPersistableGeneration'](transaction as never, 'tenant', prepared as never)).resolves.toBeUndefined();
    row.updatedAt = new Date('2026-09-08T11:00:00Z');
    await expect(service['assertPersistableGeneration'](transaction as never, 'tenant', prepared as never)).rejects.toMatchObject({ code: 'generation_scope_changed' });
  });
});
