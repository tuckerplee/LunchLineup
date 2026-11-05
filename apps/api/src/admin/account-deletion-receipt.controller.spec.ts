import { describe, expect, it, vi } from 'vitest';
import { AccountDeletionReceiptController } from './account-deletion-receipt.controller';

function fixture(tx: Record<string, unknown>) {
  const database = { withTenant: vi.fn(async (_: string, work: any) => work(tx)), withPlatformAdmin: vi.fn(async (work: any) => work(tx)) };
  return { controller: new AccountDeletionReceiptController(database as never), database };
}
describe('deletion receipt capabilities', () => {
  it('stores only a hash and requires matching workspace confirmation', async () => {
    const create = vi.fn();
    const { controller } = fixture({ tenant: { findUniqueOrThrow: vi.fn(async () => ({ slug: 'qa', status: 'ACTIVE' })) }, auditLog: { create } });
    await expect(controller.prepare({ user: { tenantId: 'tenant', sub: 'actor' } }, { confirmation: 'wrong' })).rejects.toThrow('Confirmation');
    expect(create).not.toHaveBeenCalled();
    const result = await controller.prepare({ user: { tenantId: 'tenant', sub: 'actor' } }, { confirmation: 'qa' });
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(create.mock.calls)).not.toContain(result.token);
  });
  it('rejects invalid or unknown capabilities', async () => {
    const { controller, database } = fixture({ auditLog: { findFirst: vi.fn(async () => null) } });
    await expect(controller.receipt({ token: 'short' })).rejects.toThrow('unavailable');
    expect(database.withPlatformAdmin).not.toHaveBeenCalled();
    await expect(controller.receipt({ token: 'a'.repeat(64) })).rejects.toThrow('unavailable');
  });
  it('never treats a prepared receipt as proof deletion happened', async () => {
    const { controller } = fixture({
      auditLog: { findFirst: vi.fn().mockResolvedValueOnce({ tenantId: 'tenant' }).mockResolvedValueOnce(null) },
      tenant: { findUnique: vi.fn(async () => ({ status: 'ACTIVE', deletedAt: null })) },
    });
    expect(await controller.receipt({ token: 'a'.repeat(64) })).toEqual({ state: 'NOT_RECORDED', receipt: null });
  });
  it('recovers a finalized receipt without returning tenant identifiers', async () => {
    const { controller } = fixture({
      auditLog: { findFirst: vi.fn(async () => ({ tenantId: 'private-tenant' })) },
      tenant: { findUnique: vi.fn(async () => ({ status: 'PURGED', deletedAt: new Date('2026-09-08T00:00:00Z') })) },
    });
    const result = await controller.receipt({ token: 'a'.repeat(64) });
    expect(result).toMatchObject({ state: 'CONFIRMED', receipt: { deletionState: 'FINALIZED' } });
    expect(JSON.stringify(result)).not.toContain('private-tenant');
  });
});
