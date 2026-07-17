import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { TenantDeletionBillingService } = require(
  '../../apps/api/src/admin/tenant-deletion-billing.service.ts'
);

const schema = readFileSync(resolve(root, 'packages/db/prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(root, 'packages/db/prisma/migrations/20260716_zzzzz_tenant_deletion_billing_reconciliation.sql'),
  'utf8',
);
const lifecycle = readFileSync(
  resolve(root, 'apps/api/src/admin/tenant-deletion-billing.service.ts'),
  'utf8',
);
const reconciler = readFileSync(
  resolve(root, 'apps/api/src/admin/tenant-deletion-billing-reconciler.processor.ts'),
  'utf8',
);
const appModule = readFileSync(resolve(root, 'apps/api/src/app.module.ts'), 'utf8');

test('Prisma owns durable deletion-billing attempt, ordering, lease, and fence state', () => {
  assert.match(schema, /model TenantDeletionBillingReconciliation \{/);
  for (const field of [
    'operationId',
    'barrierCreatedAt',
    'attemptCount',
    'nextAttemptAt',
    'lastAttemptAt',
    'lastFailureAt',
    'leaseOwner',
    'leaseToken',
    'leaseExpiresAt',
    'finalizedAt',
  ]) {
    assert.match(schema, new RegExp(`\\b${field}\\b`));
  }
  assert.match(schema, /@@index\(\[state, nextAttemptAt, barrierCreatedAt, tenantId\]\)/);
});

test('forward migration backfills barriers and enforces paired leases plus tenant isolation', () => {
  assert.match(migration, /TENANT_DELETION_BARRIER_COMMITTED/);
  assert.match(migration, /ON CONFLICT \("tenantId"\) DO NOTHING/);
  assert.match(migration, /TenantDeletionBillingReconciliation_lease_check/);
  assert.match(migration, /"leaseOwner" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /is_current_platform_admin\(\) OR "tenantId" = \(SELECT get_current_tenant\(\)\)/);
});

test('provider entry follows a committed claim and exact owner plus token fence finalization', async () => {
  const operationId = 'tenant-deletion-audit-1';
  const barrierCreatedAt = new Date('2026-07-16T12:00:00.000Z');
  const events = [];
  const executeCalls = [];
  let claimWriteCount = 0;
  let claimedOwner;
  let claimedToken;

  const tx = {
    tenant: {
      findUnique: async () => ({
        id: 'tenant-1',
        slug: 'tenant-1',
        status: 'SUSPENDED',
        deletedAt: null,
        auditLogs: [{
          id: 'audit-1',
          userId: null,
          actorUserId: null,
          actorTenantId: 'tenant-1',
          ipAddress: null,
          userAgent: 'migration-fence-proof',
          createdAt: barrierCreatedAt,
        }],
      }),
      findUniqueOrThrow: async () => ({
        id: 'tenant-1',
        slug: 'tenant-1',
        status: 'SUSPENDED',
        deletedAt: null,
      }),
      update: async () => ({
        id: 'tenant-1',
        slug: 'tenant-1',
        status: 'PURGED',
        deletedAt: barrierCreatedAt,
      }),
    },
    auditLog: { create: async () => ({}) },
    $queryRaw: async (strings, ...values) => {
      const sql = Array.from(strings).join(' ');
      if (sql.includes('RETURNING reconciliation."operationId"')) {
        claimWriteCount += 1;
        claimedOwner = values[0];
        claimedToken = values[1];
        events.push('claim-written');
        return [{ operationId }];
      }
      return [{ id: 'tenant-1' }];
    },
    $executeRaw: async (strings, ...values) => {
      const sql = Array.from(strings).join(' ');
      executeCalls.push({ sql, values });
      if (sql.includes('SET "leaseExpiresAt" =')) events.push('claim-renewed');
      if (sql.includes('SET "updatedAt" = "updatedAt"')) events.push('exact-finalization-fence');
      if (sql.includes('"state" = \'FINALIZED\'')) events.push('claim-finalized');
      return 1;
    },
  };
  const tenantDb = {
    withPlatformAdmin: async (operation) => {
      const claimsBefore = claimWriteCount;
      const result = await operation(tx);
      if (claimWriteCount > claimsBefore) events.push('claim-committed');
      return result;
    },
    withTenant: async (_tenantId, operation) => operation(tx),
  };
  const provider = {
    async finalizeTenantBillingForPurge(tenantId, context) {
      events.push('provider-entered');
      assert.equal(tenantId, 'tenant-1');
      assert.equal(context.operationId, operationId);
      assert.equal(context.signal.aborted, false);
      return {
        expiredCheckoutSessionIds: [],
        canceledSubscriptionIds: [],
        alreadyTerminalSubscriptionIds: [],
      };
    },
  };
  const service = new TenantDeletionBillingService(tenantDb, () => provider);

  const result = await service.reconcilePendingDeletionBillingCandidate('tenant-1');

  assert.equal(result.outcome, 'processed');
  for (const earlierAndLater of [
    ['claim-written', 'claim-committed'],
    ['claim-committed', 'claim-renewed'],
    ['claim-renewed', 'provider-entered'],
    ['provider-entered', 'exact-finalization-fence'],
    ['exact-finalization-fence', 'claim-finalized'],
  ]) {
    assert.ok(
      events.indexOf(earlierAndLater[0]) < events.indexOf(earlierAndLater[1]),
      `${earlierAndLater[0]} must precede ${earlierAndLater[1]}: ${events.join(', ')}`,
    );
  }
  const exactFence = executeCalls.find(({ sql }) => sql.includes('SET "updatedAt" = "updatedAt"'));
  assert.ok(exactFence);
  assert.match(exactFence.sql, /AND "operationId" =/);
  assert.match(exactFence.sql, /AND "leaseOwner" =/);
  assert.match(exactFence.sql, /AND "leaseToken" =/);
  assert.ok(exactFence.values.includes(operationId));
  assert.ok(exactFence.values.includes(claimedOwner));
  assert.ok(exactFence.values.includes(claimedToken));
});

test('eligible claims are bounded, skip locked, fair ordered, and independently scheduled', () => {
  assert.match(lifecycle, /ORDER BY reconciliation\."nextAttemptAt", reconciliation\."barrierCreatedAt", reconciliation\."tenantId"/);
  assert.match(lifecycle, /FOR UPDATE OF reconciliation SKIP LOCKED/);
  assert.match(lifecycle, /LEAST\([\s\S]*POWER\(2/);
  assert.match(reconciler, /implements OnModuleInit, OnModuleDestroy/);
  assert.match(reconciler, /this\.processor\.start\(\)/);
  assert.match(appModule, /TenantDeletionBillingReconcilerService/);
});
