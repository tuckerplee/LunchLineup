import { vi } from 'vitest';
import { AdminController } from './admin.controller';
import { MeteringService } from '../billing/metering.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';

// Closed transaction/authority seams for the actual controller + Metering owner.
// No DB/socket/session verification. The HTTP companion uses the real production
// error filter and registered API-v2 route, but synthetic native identity/context.
export const grantActorRequest = {
  method: 'POST', url: '/v1/admin/credits/grant', originalUrl: '/v1/admin/credits/grant',
  ip: '192.0.2.21', headers: { 'user-agent': 'closed-grant-boundary-test' },
  user: { sub: 'actor-opaque-id', tenantId: 'platform-opaque-id', sessionId: 'synthetic-session',
    role: 'SUPER_ADMIN', permissions: ['admin_portal:access'] },
};
export const validGrantInput = { tenantId: 'legacy-opaque-tenant', amount: 25, reason: 'Boundary grant' };
export const rejectedGrantInputs = [
  { label: 'null body', body: null }, { label: 'array body', body: [] },
  { label: 'string body', body: 'grant' }, { label: 'number body', body: 25 }, { label: 'boolean body', body: true },
  { label: 'missing fields', body: {} },
  ...[null, 7, true, [], {}].map((tenantId, index) => ({ label: `tenant type ${index}`, body: { ...validGrantInput, tenantId } })),
  { label: 'blank tenant', body: { ...validGrantInput, tenantId: ' \t ' } },
  { label: 'missing reason', body: { tenantId: validGrantInput.tenantId, amount: 25 } },
  ...[null, 7, true, [], {}].map((reason, index) => ({ label: `reason type ${index}`, body: { ...validGrantInput, reason } })),
  { label: 'blank reason', body: { ...validGrantInput, reason: ' \n ' } },
  { label: '501 reason units', body: { ...validGrantInput, reason: 'r'.repeat(501) } },
  { label: 'padded 501 reason units', body: { ...validGrantInput, reason: `  ${'r'.repeat(501)}  ` } },
  { label: '502 Unicode reason units', body: { ...validGrantInput, reason: '😀'.repeat(251) } },
  { label: 'missing amount', body: { tenantId: validGrantInput.tenantId, reason: 'Boundary grant' } },
  ...[null, '25', true, [25], {}, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((amount, index) => ({
    label: `amount type or range ${index}`, body: { ...validGrantInput, amount },
  })),
] as const;
export function grantInputHarness(initial = { wallet: 40, debt: 0 }) {
  let wallet = initial.wallet, debt = initial.debt;
  const ledger = new Map<string, any>(), audits = new Map<string, any>();
  const prisma: any = {
    $executeRaw: vi.fn(async () => 1), $queryRaw: vi.fn(async () => [{ id: validGrantInput.tenantId }]),
    $disconnect: vi.fn(async () => undefined),
    tenant: {
      findUniqueOrThrow: vi.fn(async () => ({ usageCredits: wallet, creditDebt: debt })),
      update: vi.fn(async ({ data }: any) => {
        wallet += data.usageCredits.increment; debt -= data.creditDebt.decrement;
        return { usageCredits: wallet, creditDebt: debt };
      }),
    },
    creditTransaction: {
      findUnique: vi.fn(async ({ where }: any) => ledger.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { ledger.set(data.id, { ...data }); return { id: data.id }; }),
    },
    auditLog: {
      findUnique: vi.fn(async ({ where }: any) => audits.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { audits.set(data.id, { ...data }); return { id: data.id }; }),
    },
  };
  prisma.$transaction = vi.fn(async (operation: (tx: any) => Promise<unknown>) => {
    const before = { wallet, debt, ledger: new Map(ledger), audits: new Map(audits) };
    try { return await operation(prisma); }
    catch (error) {
      wallet = before.wallet; debt = before.debt; ledger.clear(); audits.clear();
      for (const [key, value] of before.ledger) ledger.set(key, value);
      for (const [key, value] of before.audits) audits.set(key, value);
      throw error;
    }
  });
  const tenantDb = new TenantPrismaService(prisma), metering = new MeteringService(tenantDb);
  const settle = vi.spyOn(metering, 'grantCreditsInTransaction');
  const authority = vi.fn(async () => undefined);
  const config = { get: vi.fn() } as any, metrics = {} as any;
  const rbac = { authorizePlatformAdminTenantMutationInTransaction: authority } as any;
  const controller = new AdminController(config, metrics, metering, tenantDb, undefined, rbac);
  // Stop only the unrelated export maintenance timer before any async test/setup work.
  controller.onModuleDestroy();
  return { controller, prisma, authority, settle, ledger, audits, dependencies: { config, metrics, metering, tenantDb, rbac },
    state: () => ({ wallet, debt, ledger: [...ledger.values()], audits: [...audits.values()] }),
    close: () => controller.onModuleDestroy() };
}
