import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grantActorRequest, grantInputHarness, rejectedGrantInputs, validGrantInput } from './admin-credit-grant-input.fixture';

const owners: ReturnType<typeof grantInputHarness>[] = [];
beforeEach(() => vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'closed-grant-input-capability'));
afterEach(() => { for (const owner of owners.splice(0)) owner.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function harness(initial?: { wallet: number; debt: number }) { const h = grantInputHarness(initial); owners.push(h); return h; }
function expectNoWork(h: ReturnType<typeof harness>) {
  expect(h.prisma.$transaction).not.toHaveBeenCalled(); expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
  expect(h.prisma.$queryRaw).not.toHaveBeenCalled(); expect(h.authority).not.toHaveBeenCalled(); expect(h.settle).not.toHaveBeenCalled();
  expect(h.prisma.tenant.findUniqueOrThrow).not.toHaveBeenCalled(); expect(h.prisma.tenant.update).not.toHaveBeenCalled();
  expect(h.prisma.creditTransaction.findUnique).not.toHaveBeenCalled(); expect(h.prisma.creditTransaction.create).not.toHaveBeenCalled();
  expect(h.prisma.auditLog.findUnique).not.toHaveBeenCalled(); expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  expect(h.state()).toEqual({ wallet: 40, debt: 0, ledger: [], audits: [] });
}
describe('Admin credit grant JSON boundary', () => {
  it.each(rejectedGrantInputs)('rejects $label before authority, transaction or settlement work', async ({ body }) => {
    const h = harness();
    const failure = await h.controller.grantCredits(grantActorRequest, body, 'input-contract-key').catch(error => error);
    expect(failure).toBeInstanceOf(BadRequestException); expect(failure.getStatus()).toBe(400); expectNoWork(h);
  });
  it.each([undefined, Number.NaN, Infinity])('rejects non-JSON native caller body %s before work', async body => {
    const h = harness(); await expect(h.controller.grantCredits(grantActorRequest, body, 'input-contract-key')).rejects.toBeInstanceOf(BadRequestException); expectNoWork(h);
  });
  it('checks platform authority before exposing malformed input diagnostics', async () => {
    const h = harness();
    await expect(h.controller.grantCredits({ ...grantActorRequest, user: { ...grantActorRequest.user, permissions: [] } }, null, 'key')).rejects.toBeInstanceOf(ForbiddenException);
    expectNoWork(h);
  });
  it.each([undefined, ' ', 'x'.repeat(256), 'bad\nkey'])('preserves invalid idempotency-key refusal %# before database work', async key => {
    const h = harness(); await expect(h.controller.grantCredits(grantActorRequest, validGrantInput, key)).rejects.toBeInstanceOf(BadRequestException); expectNoWork(h);
  });
  it.each([
    { label: 'one character', reason: 'r' }, { label: '500 characters', reason: 'r'.repeat(500) },
    { label: 'padded500 characters', reason: ` \t${'r'.repeat(500)}\n ` },
    { label: '500 Unicode code units', reason: '😀'.repeat(250) },
  ])('settles $label with trimmed opaque tenant and immutable same-key replay', async ({ reason }) => {
    const h = harness(); const body = { ...validGrantInput, tenantId: '  legacy-opaque-tenant  ', reason };
    await expect(h.controller.grantCredits(grantActorRequest, body, '  boundary-key  ')).resolves.toEqual({ success: true, newBalance: 65 });
    expect(h.settle).toHaveBeenCalledWith(h.prisma, { ...validGrantInput, reason: reason.trim(), idempotencyKey: 'boundary-key' });
    expect(h.ledger.size).toBe(1); expect(h.audits.size).toBe(1);
    expect([...h.ledger.values()][0]).toMatchObject({ tenantId: validGrantInput.tenantId, amount: 25, reason: reason.trim(), balanceAfter: 65 });
    await expect(h.controller.grantCredits(grantActorRequest, body, 'boundary-key')).resolves.toEqual({ success: true, newBalance: 65 });
    expect(h.prisma.tenant.update).toHaveBeenCalledOnce(); expect(h.prisma.creditTransaction.create).toHaveBeenCalledOnce(); expect(h.prisma.auditLog.create).toHaveBeenCalledOnce();
  });
  it('allows a debt-first total above Int32 and replays before current capacity checks', async () => {
    const h = harness({ wallet: 0, debt: 2_147_483_647 }); const body = { ...validGrantInput, amount: 4_294_967_294 };
    await expect(h.controller.grantCredits(grantActorRequest, body, 'combined-capacity')).resolves.toEqual({ success: true, newBalance: 2_147_483_647 });
    const currentReads = h.prisma.tenant.findUniqueOrThrow.mock.calls.length;
    await expect(h.controller.grantCredits(grantActorRequest, body, 'combined-capacity')).resolves.toEqual({ success: true, newBalance: 2_147_483_647 });
    expect(h.prisma.tenant.findUniqueOrThrow).toHaveBeenCalledTimes(currentReads);
    expect(h.state()).toMatchObject({ wallet: 2_147_483_647, debt: 0 }); expect(h.ledger.size).toBe(1); expect(h.audits.size).toBe(1);
  });
});
