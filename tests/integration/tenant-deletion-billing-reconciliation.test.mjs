import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPrisma, requireServiceUrl } from './schedule-solve-harness.mjs';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');
const {
  TenantDeletionBillingService,
} = require('../../apps/api/src/admin/tenant-deletion-billing.service.ts');
const {
  TenantDeletionBillingReconcilerProcessor,
} = require('../../apps/api/src/admin/tenant-deletion-billing-reconciler.processor.ts');
const { StripeService } = require('../../apps/api/src/billing/stripe.service.ts');

const billingPurge = {
  expiredCheckoutSessionIds: [],
  canceledSubscriptionIds: [],
  alreadyTerminalSubscriptionIds: [],
};

function bounded(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function source(service) {
  return {
    claimEligible: (limit, excludedTenantIds) =>
      service.claimEligibleDeletionBillingCandidates(limit, excludedTenantIds),
    reconcileClaimed: (claim, signal) =>
      service.reconcileClaimedDeletionBillingCandidate(claim, signal),
    readBacklog: () => service.readPendingDeletionBillingBacklog(),
  };
}

async function insertBarrier(prisma, fixture) {
  const auditId = `audit-${fixture.tenantId}`;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET})`;
    await tx.$executeRaw`
      INSERT INTO "Tenant"
        ("id", "name", "slug", "status", "usageCredits", "createdAt", "updatedAt")
      VALUES
        (${fixture.tenantId}, 'Deletion Billing Integration', ${fixture.slug},
         'SUSPENDED'::"TenantStatus", 0, ${fixture.barrierCreatedAt}, ${fixture.barrierCreatedAt})
    `;
    await tx.$executeRaw`
      INSERT INTO "AuditLog"
        ("id", "tenantId", "action", "resource", "resourceId", "createdAt")
      VALUES
        (${auditId}, ${fixture.tenantId}, 'TENANT_DELETION_BARRIER_COMMITTED',
         'Tenant', ${fixture.tenantId}, ${fixture.barrierCreatedAt})
    `;
    await tx.$executeRaw`
      INSERT INTO "TenantDeletionBillingReconciliation"
        ("tenantId", "operationId", "barrierCreatedAt", "state", "attemptCount",
         "nextAttemptAt", "createdAt", "updatedAt")
      VALUES
        (${fixture.tenantId}, ${`tenant-deletion-${auditId}`}, ${fixture.barrierCreatedAt},
         'PENDING'::"TenantDeletionBillingReconciliationState", 0,
         ${fixture.barrierCreatedAt}, ${fixture.barrierCreatedAt}, ${fixture.barrierCreatedAt})
    `;
  });
}

async function cleanupFixtures(prisma, tenantIds) {
  for (const tenantId of tenantIds) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_platform_admin(true, ${process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET})`;
      await tx.$executeRaw`
        UPDATE "Tenant"
        SET "status" = 'PURGED'::"TenantStatus",
            "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
            "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
            "retentionLegalHoldAt" = NULL,
            "retentionLegalHoldReason" = NULL,
            "retentionLegalHoldByUserId" = NULL,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${tenantId}
      `;
      await tx.$executeRaw`
        DELETE FROM "TenantDeletionBillingReconciliation" WHERE "tenantId" = ${tenantId}
      `;
      await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
      await tx.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`;
    }).catch(() => undefined);
  }
}

test('real Postgres JIT claims prevent a second tenant from double-entering after the first exceeds its lease', {
  timeout: 30_000,
}, async () => {
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  assert.ok(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  const firstPrisma = createPrisma(ownerUrl);
  const secondPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const fixtures = [
    {
      tenantId: `tenant-deletion-fence-first-${runId}`,
      slug: `tenant-deletion-fence-first-${runId}`,
      barrierCreatedAt: new Date(Date.now() - 60_000),
    },
    {
      tenantId: `tenant-deletion-fence-second-${runId}`,
      slug: `tenant-deletion-fence-second-${runId}`,
      barrierCreatedAt: new Date(Date.now() - 59_000),
    },
  ];
  let releaseProvider;
  let providerEntered;
  const providerStarted = new Promise((resolveStarted) => { providerEntered = resolveStarted; });
  const providerRelease = new Promise((resolveRelease) => { releaseProvider = resolveRelease; });
  const activeProviderCalls = new Map();
  const maximumActiveProviderCalls = new Map();
  const providerCallCount = new Map();
  const provider = {
    async finalizeTenantBillingForPurge(tenantId) {
      providerCallCount.set(tenantId, (providerCallCount.get(tenantId) ?? 0) + 1);
      activeProviderCalls.set(tenantId, (activeProviderCalls.get(tenantId) ?? 0) + 1);
      maximumActiveProviderCalls.set(
        tenantId,
        Math.max(maximumActiveProviderCalls.get(tenantId) ?? 0, activeProviderCalls.get(tenantId)),
      );
      if (tenantId === fixtures[0].tenantId) {
        providerEntered();
        await providerRelease;
      }
      activeProviderCalls.set(tenantId, activeProviderCalls.get(tenantId) - 1);
      return billingPurge;
    },
  };

  try {
    for (const fixture of fixtures) await insertBarrier(firstPrisma, fixture);
    const firstService = new TenantDeletionBillingService(
      new TenantPrismaService(firstPrisma),
      () => provider,
      { leaseMs: 250, providerAttemptTimeoutMs: 5_000 },
    );
    const secondService = new TenantDeletionBillingService(
      new TenantPrismaService(secondPrisma),
      () => provider,
      { leaseMs: 250, providerAttemptTimeoutMs: 5_000 },
    );
    const first = new TenantDeletionBillingReconcilerProcessor(source(firstService), { batchSize: 2 });
    const second = new TenantDeletionBillingReconcilerProcessor(source(secondService), { batchSize: 1 });

    const firstSweep = first.sweepNow();
    await bounded(providerStarted, 5_000, 'first replica never entered the controlled provider barrier');
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    const firstClaim = await firstPrisma.tenantDeletionBillingReconciliation.findUnique({
      where: { tenantId: fixtures[0].tenantId },
      select: { attemptCount: true, leaseExpiresAt: true },
    });
    assert.equal(firstClaim.attemptCount, 1);
    assert.ok(firstClaim.leaseExpiresAt > new Date(), 'heartbeat must keep the active first claim live');

    const secondSummary = await bounded(second.sweepNow(), 5_000, 'second replica did not process the unclaimed second tenant');

    assert.deepEqual(secondSummary, { claimed: 1, succeeded: 1, failed: 0, backlog: 1 });
    assert.equal(providerCallCount.get(fixtures[0].tenantId), 1);
    assert.equal(providerCallCount.get(fixtures[1].tenantId), 1);
    assert.equal(maximumActiveProviderCalls.get(fixtures[0].tenantId), 1);
    assert.equal(maximumActiveProviderCalls.get(fixtures[1].tenantId), 1);
    releaseProvider();
    const firstSummary = await bounded(firstSweep, 5_000, 'first replica did not finalize after provider release');
    assert.deepEqual(firstSummary, { claimed: 1, succeeded: 1, failed: 0, backlog: 0 });
    assert.equal(providerCallCount.get(fixtures[1].tenantId), 1, 'stale serial work must not enter the second provider');
    assert.deepEqual(await firstPrisma.tenant.findUnique({
      where: { id: fixtures[0].tenantId },
      select: { status: true, deletedAt: true },
    }), {
      status: 'PURGED',
      deletedAt: fixtures[0].barrierCreatedAt,
    });
    assert.deepEqual(await firstPrisma.tenantDeletionBillingReconciliation.findUnique({
      where: { tenantId: fixtures[0].tenantId },
      select: { state: true, attemptCount: true, leaseOwner: true, leaseToken: true },
    }), {
      state: 'FINALIZED',
      attemptCount: 1,
      leaseOwner: null,
      leaseToken: null,
    });
  } finally {
    releaseProvider?.();
    await cleanupFixtures(firstPrisma, fixtures.map((fixture) => fixture.tenantId));
    await firstPrisma.$disconnect();
    await secondPrisma.$disconnect();
  }
});

test('real Postgres backoff moves a full limit of old failures behind a newer healthy barrier', {
  timeout: 30_000,
}, async () => {
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  assert.ok(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  const prisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const base = Date.now() - 10 * 60_000;
  const fixtures = [
    { tenantId: `tenant-old-failure-a-${runId}`, slug: `old-failure-a-${runId}`, barrierCreatedAt: new Date(base) },
    { tenantId: `tenant-old-failure-b-${runId}`, slug: `old-failure-b-${runId}`, barrierCreatedAt: new Date(base + 1_000) },
    { tenantId: `tenant-new-healthy-${runId}`, slug: `new-healthy-${runId}`, barrierCreatedAt: new Date(base + 2_000) },
  ];
  const failedIds = new Set(fixtures.slice(0, 2).map((fixture) => fixture.tenantId));
  const providerCalls = [];
  const provider = {
    async finalizeTenantBillingForPurge(tenantId) {
      providerCalls.push(tenantId);
      if (failedIds.has(tenantId)) throw new Error('controlled provider failure');
      return billingPurge;
    },
  };

  try {
    for (const fixture of fixtures) await insertBarrier(prisma, fixture);
    const service = new TenantDeletionBillingService(
      new TenantPrismaService(prisma),
      () => provider,
    );
    const processor = new TenantDeletionBillingReconcilerProcessor(source(service), { batchSize: 2 });

    const first = await processor.sweepNow();
    assert.deepEqual(first, { claimed: 2, succeeded: 0, failed: 2, backlog: 3 });
    const second = await processor.sweepNow();
    assert.deepEqual(second, { claimed: 1, succeeded: 1, failed: 0, backlog: 2 });
    assert.deepEqual(providerCalls, fixtures.map((fixture) => fixture.tenantId));

    const rows = await prisma.tenantDeletionBillingReconciliation.findMany({
      where: { tenantId: { in: fixtures.map((fixture) => fixture.tenantId) } },
      orderBy: { barrierCreatedAt: 'asc' },
      select: {
        tenantId: true,
        state: true,
        attemptCount: true,
        nextAttemptAt: true,
        lastFailureAt: true,
        leaseOwner: true,
      },
    });
    assert.equal(rows[0].attemptCount, 1);
    assert.equal(rows[1].attemptCount, 1);
    assert.ok(rows[0].nextAttemptAt > rows[0].lastFailureAt);
    assert.ok(rows[1].nextAttemptAt > rows[1].lastFailureAt);
    assert.equal(rows[2].state, 'FINALIZED');
    assert.equal(rows[2].leaseOwner, null);

    if (process.env.DATABASE_URL) {
      const restricted = createPrisma(requireServiceUrl('DATABASE_URL').toString());
      try {
        const visible = await restricted.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_current_tenant(${fixtures[0].tenantId})`;
          return tx.tenantDeletionBillingReconciliation.findMany({
            where: { tenantId: { in: fixtures.map((fixture) => fixture.tenantId) } },
            select: { tenantId: true },
          });
        });
        assert.deepEqual(visible, [{ tenantId: fixtures[0].tenantId }]);
      } finally {
        await restricted.$disconnect();
      }
    }
  } finally {
    await cleanupFixtures(prisma, fixtures.map((fixture) => fixture.tenantId));
    await prisma.$disconnect();
  }
});

test('real Postgres deadlines retain the claim until provider transport terminates, then let newer work progress', {
  timeout: 30_000,
}, async () => {
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  assert.ok(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  const prisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const fixtures = [
    {
      tenantId: `tenant-deadline-hung-${runId}`,
      slug: `tenant-deadline-hung-${runId}`,
      barrierCreatedAt: new Date(Date.now() - 60_000),
    },
    {
      tenantId: `tenant-deadline-healthy-${runId}`,
      slug: `tenant-deadline-healthy-${runId}`,
      barrierCreatedAt: new Date(Date.now() - 59_000),
    },
  ];
  const providerCalls = [];
  const providerEvents = [];
  let releaseTerminatedTransport;
  let markProviderAbortObserved;
  const terminatedTransportRelease = new Promise((resolveRelease) => {
    releaseTerminatedTransport = resolveRelease;
  });
  const providerAbortObserved = new Promise((resolveObserved) => {
    markProviderAbortObserved = resolveObserved;
  });
  const provider = {
    async finalizeTenantBillingForPurge(tenantId, context) {
      providerCalls.push(tenantId);
      if (tenantId === fixtures[0].tenantId) {
        await new Promise((resolveAbort) => {
          const onAbort = () => {
            providerEvents.push('provider-aborted');
            markProviderAbortObserved();
            resolveAbort();
          };
          if (context.signal.aborted) onAbort();
          else context.signal.addEventListener('abort', onAbort, { once: true });
        });
        await terminatedTransportRelease;
        providerEvents.push('provider-transport-terminated');
      }
      return billingPurge;
    },
  };

  try {
    for (const fixture of fixtures) await insertBarrier(prisma, fixture);
    const service = new TenantDeletionBillingService(
      new TenantPrismaService(prisma),
      () => provider,
      {
        leaseMs: 250,
        providerAttemptTimeoutMs: 200,
        retryBaseMs: 2_000,
      },
    );
    const processor = new TenantDeletionBillingReconcilerProcessor(source(service), { batchSize: 1 });

    const firstSweep = processor.sweepNow();
    await bounded(providerAbortObserved, 3_000, 'provider attempt did not observe its owner deadline');
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const retained = await prisma.tenantDeletionBillingReconciliation.findUnique({
      where: { tenantId: fixtures[0].tenantId },
      select: { leaseOwner: true, leaseToken: true, leaseExpiresAt: true },
    });
    assert.ok(retained.leaseOwner, 'deadline must not release the claim before transport termination');
    assert.ok(retained.leaseToken, 'deadline must retain the exact fencing token while transport is active');
    assert.ok(retained.leaseExpiresAt > new Date(), 'heartbeat must retain the lease while transport terminates');

    releaseTerminatedTransport();
    const first = await bounded(firstSweep, 3_000, 'provider attempt did not release after transport termination');
    assert.deepEqual(first, { claimed: 1, succeeded: 0, failed: 1, backlog: 2 });
    assert.deepEqual(providerEvents, ['provider-aborted', 'provider-transport-terminated']);
    const failed = await prisma.tenantDeletionBillingReconciliation.findUnique({
      where: { tenantId: fixtures[0].tenantId },
      select: {
        attemptCount: true,
        nextAttemptAt: true,
        lastFailureAt: true,
        lastErrorCode: true,
        leaseOwner: true,
        leaseToken: true,
        leaseExpiresAt: true,
      },
    });
    assert.equal(failed.attemptCount, 1);
    assert.equal(failed.lastErrorCode, 'PROVIDER_ATTEMPT_DEADLINE_EXCEEDED');
    assert.ok(failed.nextAttemptAt > failed.lastFailureAt);
    assert.equal(failed.leaseOwner, null);
    assert.equal(failed.leaseToken, null);
    assert.equal(failed.leaseExpiresAt, null);

    const second = await bounded(processor.sweepNow(), 3_000, 'newer healthy barrier did not progress after deadline backoff');
    assert.deepEqual(second, { claimed: 1, succeeded: 1, failed: 0, backlog: 1 });
    assert.deepEqual(providerCalls, fixtures.map((fixture) => fixture.tenantId));
  } finally {
    releaseTerminatedTransport?.();
    await cleanupFixtures(prisma, fixtures.map((fixture) => fixture.tenantId));
    await prisma.$disconnect();
  }
});

test('production StripeService retains the lease through late success, then readback converges without duplicate mutation', {
  timeout: 30_000,
}, async () => {
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  assert.ok(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  const firstPrisma = createPrisma(ownerUrl);
  const secondPrisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const tenantId = `tenant-reverse-provider-${runId}`;
  const slug = `tenant-reverse-provider-${runId}`;
  const customerId = `cus-reverse-provider-${runId}`;
  const subscriptionId = `sub-reverse-provider-${runId}`;
  const locationId = `location-reverse-provider-${runId}`;
  const scheduleId = `schedule-reverse-provider-${runId}`;
  const solveJobId = `solve-reverse-provider-${runId}`;
  const debitId = `schedule-credit-${solveJobId}`;
  const refundId = `schedule-credit-refund-${solveJobId}`;
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  let releaseFirstProvider;
  let markFirstProviderEntered;
  let markFirstProviderCompleted;
  const firstProviderRelease = new Promise((resolveRelease) => {
    releaseFirstProvider = resolveRelease;
  });
  const firstProviderEntered = new Promise((resolveEntered) => {
    markFirstProviderEntered = resolveEntered;
  });
  const firstProviderCompleted = new Promise((resolveCompleted) => {
    markFirstProviderCompleted = resolveCompleted;
  });
  const providerContexts = [];
  const subscriptionMutationKeys = [];
  const customerMutationKeys = [];
  let providerCallCount = 0;
  let subscriptionCancelAttempts = 0;
  let effectiveSubscriptionCancellationCount = 0;
  let customerDeleteAttempts = 0;
  let effectiveCustomerDeletionCount = 0;
  let subscriptionStatus = 'active';
  let customerDeleted = false;
  const stripeSdk = {
    customers: {
      async retrieve(requestedCustomerId) {
        assert.equal(requestedCustomerId, customerId);
        return customerDeleted
          ? { id: customerId, deleted: true }
          : { id: customerId, deleted: false, metadata: { tenantId } };
      },
      async del(requestedCustomerId, requestOptions) {
        assert.equal(requestedCustomerId, customerId);
        customerDeleteAttempts += 1;
        customerMutationKeys.push(requestOptions?.idempotencyKey);
        if (!customerDeleted) effectiveCustomerDeletionCount += 1;
        customerDeleted = true;
        return { id: customerId, deleted: true };
      },
    },
    checkout: {
      sessions: {
        async list() { return { data: [] }; },
        async expire() { throw new Error('no checkout session should be expired in this fixture'); },
        async retrieve() { throw new Error('no checkout session should be retrieved in this fixture'); },
      },
    },
    subscriptions: {
      async list() {
        return {
          data: [{
            id: subscriptionId,
            status: subscriptionStatus,
            customer: customerId,
            metadata: { tenantId },
          }],
        };
      },
      async retrieve(requestedSubscriptionId) {
        assert.equal(requestedSubscriptionId, subscriptionId);
        return {
          id: subscriptionId,
          status: subscriptionStatus,
          customer: customerId,
          metadata: { tenantId },
        };
      },
      async cancel(requestedSubscriptionId, requestOptions) {
        assert.equal(requestedSubscriptionId, subscriptionId);
        subscriptionCancelAttempts += 1;
        subscriptionMutationKeys.push(requestOptions?.idempotencyKey);
        if (subscriptionCancelAttempts === 1) {
          markFirstProviderEntered();
          await firstProviderRelease;
        }
        if (subscriptionStatus !== 'canceled') effectiveSubscriptionCancellationCount += 1;
        subscriptionStatus = 'canceled';
        return {
          id: subscriptionId,
          status: subscriptionStatus,
          customer: customerId,
          metadata: { tenantId },
        };
      },
    },
  };
  const productionProvider = (prisma, onSettled) => {
    const stripeService = new StripeService({
      get: (key) => key === 'STRIPE_SECRET_KEY' ? 'sk_test_deletion_race' : undefined,
    }, new TenantPrismaService(prisma));
    stripeService.stripe = stripeSdk;
    return {
      async finalizeTenantBillingForPurge(providerTenantId, context) {
        assert.equal(providerTenantId, tenantId);
        providerCallCount += 1;
        providerContexts.push(context);
        try {
          return await stripeService.finalizeTenantBillingForPurge(providerTenantId, context);
        } finally {
          onSettled?.();
        }
      },
    };
  };
  const firstProvider = productionProvider(firstPrisma, () => markFirstProviderCompleted());
  const secondProvider = productionProvider(secondPrisma);

  const readEvidence = async () => {
    const [tenant, reconciliation, audits, refunds] = await Promise.all([
      firstPrisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          status: true,
          deletedAt: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          usageCredits: true,
        },
      }),
      firstPrisma.tenantDeletionBillingReconciliation.findUnique({
        where: { tenantId },
        select: {
          operationId: true,
          state: true,
          attemptCount: true,
          leaseOwner: true,
          leaseToken: true,
          leaseExpiresAt: true,
          finalizedAt: true,
          updatedAt: true,
        },
      }),
      firstPrisma.$queryRaw`
        SELECT "action", COUNT(*)::integer AS "count"
        FROM "AuditLog"
        WHERE "tenantId" = ${tenantId}
          AND "action" IN (
            'TENANT_DELETION_BARRIER_COMMITTED',
            'TENANT_DELETION_REQUESTED_BY_CUSTOMER'
          )
        GROUP BY "action"
        ORDER BY "action"
      `,
      firstPrisma.$queryRaw`
        SELECT "id", "amount"
        FROM "CreditTransaction"
        WHERE "tenantId" = ${tenantId}
          AND "id" = ${refundId}
        ORDER BY "id"
      `,
    ]);
    return { tenant, reconciliation, audits, refunds };
  };

  try {
    await firstPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_platform_admin(true, ${process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET})`;
      await tx.$executeRaw`
        INSERT INTO "Tenant"
          ("id", "name", "slug", "status", "stripeCustomerId", "stripeSubscriptionId",
           "usageCredits", "createdAt", "updatedAt")
        VALUES
          (${tenantId}, 'Reverse Provider Completion', ${slug}, 'ACTIVE'::"TenantStatus",
           ${customerId}, ${subscriptionId}, 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        INSERT INTO "Location" ("id", "tenantId", "name", "timezone", "createdAt", "updatedAt")
        VALUES (${locationId}, ${tenantId}, 'Reverse Completion Location', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        INSERT INTO "Schedule"
          ("id", "tenantId", "locationId", "startDate", "endDate", "status", "createdAt", "updatedAt")
        VALUES
          (${scheduleId}, ${tenantId}, ${locationId}, CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP + INTERVAL '7 days', 'DRAFT'::"ScheduleStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        INSERT INTO "CreditTransaction"
          ("id", "tenantId", "amount", "debtAmount", "reason", "balanceAfter", "debtAfter", "createdAt")
        VALUES
          (${debitId}, ${tenantId}, -4, 0, ${`Schedule generation (${solveJobId})`}, 7, 0, CURRENT_TIMESTAMP)
      `;
      await tx.$executeRaw`
        INSERT INTO "ScheduleSolveJob"
          ("id", "tenantId", "scheduleId", "locationId", "requestKeyHash", "requestHash",
           "status", "creditConsumption", "createdAt", "updatedAt")
        VALUES
          (${solveJobId}, ${tenantId}, ${scheduleId}, ${locationId}, ${digest(`key-${runId}`)}, ${digest(`request-${runId}`)},
           'QUEUED', ${JSON.stringify({ source: 'credits', consumedCredits: 4, newBalance: 7 })}::jsonb,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
    });

    const firstService = new TenantDeletionBillingService(
      new TenantPrismaService(firstPrisma),
      () => firstProvider,
      { leaseMs: 250, providerAttemptTimeoutMs: 100, retryBaseMs: 1_000 },
    );
    const secondService = new TenantDeletionBillingService(
      new TenantPrismaService(secondPrisma),
      () => secondProvider,
      { leaseMs: 250, providerAttemptTimeoutMs: 3_000, retryBaseMs: 1_000 },
    );

    let firstRequestSettled = false;
    const firstRequest = firstService.requestDeletion({
      tenantId,
      userId: null,
      ipAddress: '127.0.0.1',
      userAgent: 'tenant-deletion-reverse-completion-test',
    }, { confirmation: slug }).finally(() => { firstRequestSettled = true; });
    await bounded(firstProviderEntered, 3_000, 'first deletion request never entered Stripe mutation');
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    assert.equal(firstRequestSettled, false, 'request must remain active after deadline while transport is active');

    const duringLateSuccess = await readEvidence();
    assert.ok(duringLateSuccess.reconciliation.leaseOwner, 'active transport must retain its lease owner');
    assert.ok(duringLateSuccess.reconciliation.leaseToken, 'active transport must retain its fence token');
    assert.ok(duringLateSuccess.reconciliation.leaseExpiresAt > new Date(), 'heartbeat must renew through late success');
    assert.deepEqual(
      await secondService.claimEligibleDeletionBillingCandidates(1),
      [],
      'a second replica must not reclaim while the first Stripe request is active',
    );

    releaseFirstProvider();
    const pending = await bounded(firstRequest, 5_000, 'first deletion request did not release after provider termination');
    await bounded(firstProviderCompleted, 2_000, 'first provider attempt did not terminate after release');
    assert.equal(pending.deletionState, 'PENDING_BILLING_CLEANUP');
    assert.equal(providerCallCount, 1);
    assert.equal(providerContexts[0].signal.aborted, true);

    const afterTimeout = await readEvidence();
    assert.equal(afterTimeout.tenant.status, 'SUSPENDED');
    assert.equal(afterTimeout.tenant.stripeCustomerId, customerId);
    assert.equal(afterTimeout.tenant.stripeSubscriptionId, subscriptionId);
    assert.equal(afterTimeout.tenant.usageCredits, 11);
    assert.equal(afterTimeout.reconciliation.state, 'PENDING');
    assert.equal(afterTimeout.reconciliation.attemptCount, 1);
    assert.equal(afterTimeout.reconciliation.leaseOwner, null);
    assert.equal(afterTimeout.reconciliation.leaseToken, null);
    assert.deepEqual(afterTimeout.audits, [
      { action: 'TENANT_DELETION_BARRIER_COMMITTED', count: 1 },
    ]);
    assert.deepEqual(afterTimeout.refunds, [{ id: refundId, amount: 4 }]);

    await firstPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_platform_admin(true, ${process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET})`;
      await tx.$executeRaw`
        UPDATE "TenantDeletionBillingReconciliation"
        SET "nextAttemptAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "tenantId" = ${tenantId}
          AND "state" = 'PENDING'::"TenantDeletionBillingReconciliationState"
      `;
    });
    const [retryClaim] = await secondService.claimEligibleDeletionBillingCandidates(1);
    assert.ok(retryClaim, 'same tenant must be reclaimable after the timed-out attempt');
    assert.equal(retryClaim.operationId, afterTimeout.reconciliation.operationId);
    await bounded(
      secondService.reconcileClaimedDeletionBillingCandidate(retryClaim),
      5_000,
      'same-tenant retry did not finalize before the older provider completion',
    );

    const beforeOldCompletion = await readEvidence();
    assert.equal(providerCallCount, 2);
    assert.equal(providerContexts[1].operationId, providerContexts[0].operationId);
    assert.equal(subscriptionCancelAttempts, 1);
    assert.equal(new Set(subscriptionMutationKeys).size, 1);
    assert.equal(effectiveSubscriptionCancellationCount, 1);
    assert.equal(customerDeleteAttempts, 1);
    assert.equal(new Set(customerMutationKeys).size, 1);
    assert.equal(effectiveCustomerDeletionCount, 1);
    assert.notEqual(subscriptionMutationKeys[0], customerMutationKeys[0]);
    assert.deepEqual(beforeOldCompletion.tenant, {
      status: 'PURGED',
      deletedAt: beforeOldCompletion.tenant.deletedAt,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      usageCredits: 11,
    });
    assert.ok(beforeOldCompletion.tenant.deletedAt);
    assert.deepEqual(beforeOldCompletion.reconciliation, {
      operationId: afterTimeout.reconciliation.operationId,
      state: 'FINALIZED',
      attemptCount: 2,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      finalizedAt: beforeOldCompletion.reconciliation.finalizedAt,
      updatedAt: beforeOldCompletion.reconciliation.updatedAt,
    });
    assert.ok(beforeOldCompletion.reconciliation.finalizedAt);
    assert.deepEqual(beforeOldCompletion.audits, [
      { action: 'TENANT_DELETION_BARRIER_COMMITTED', count: 1 },
      { action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER', count: 1 },
    ]);
    assert.deepEqual(beforeOldCompletion.refunds, [{ id: refundId, amount: 4 }]);

    assert.equal(effectiveSubscriptionCancellationCount, 1);
    assert.equal(effectiveCustomerDeletionCount, 1);
    assert.equal(customerDeleteAttempts, 1);
    assert.equal(subscriptionMutationKeys.length, 1);
  } finally {
    releaseFirstProvider?.();
    await bounded(firstProviderCompleted, 2_000, 'older provider cleanup did not drain').catch(() => undefined);
    await firstPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_platform_admin(true, ${process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET})`;
      await tx.$executeRaw`DELETE FROM "ScheduleSolveJob" WHERE "tenantId" = ${tenantId}`;
      await tx.$executeRaw`DELETE FROM "Schedule" WHERE "tenantId" = ${tenantId}`;
      await tx.$executeRaw`DELETE FROM "Location" WHERE "tenantId" = ${tenantId}`;
      await tx.$executeRaw`DELETE FROM "CreditTransaction" WHERE "tenantId" = ${tenantId}`;
    }).catch(() => undefined);
    await cleanupFixtures(firstPrisma, [tenantId]);
    await firstPrisma.$disconnect();
    await secondPrisma.$disconnect();
  }
});

test('real Postgres shutdown retains the exact fence until provider transport terminates', {
  timeout: 30_000,
}, async () => {
  const ownerUrl = requireServiceUrl('MIGRATION_DATABASE_URL').toString();
  assert.ok(process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET is required');
  const prisma = createPrisma(ownerUrl);
  const runId = randomUUID();
  const fixture = {
    tenantId: `tenant-stop-hung-${runId}`,
    slug: `tenant-stop-hung-${runId}`,
    barrierCreatedAt: new Date(Date.now() - 60_000),
  };
  let providerEntered;
  let markProviderAbortObserved;
  let terminateProviderTransport;
  const providerStarted = new Promise((resolveStarted) => { providerEntered = resolveStarted; });
  const providerAbortObserved = new Promise((resolveObserved) => {
    markProviderAbortObserved = resolveObserved;
  });
  const providerTransportRelease = new Promise((resolveRelease) => {
    terminateProviderTransport = resolveRelease;
  });
  const provider = {
    async finalizeTenantBillingForPurge(_tenantId, context) {
      providerEntered();
      await new Promise((resolveAbort) => {
        const onAbort = () => {
          markProviderAbortObserved();
          resolveAbort();
        };
        if (context.signal.aborted) onAbort();
        else context.signal.addEventListener('abort', onAbort, { once: true });
      });
      await providerTransportRelease;
      return billingPurge;
    },
  };

  try {
    await insertBarrier(prisma, fixture);
    const service = new TenantDeletionBillingService(
      new TenantPrismaService(prisma),
      () => provider,
      {
        leaseMs: 250,
        providerAttemptTimeoutMs: 5_000,
        retryBaseMs: 2_000,
      },
    );
    const processor = new TenantDeletionBillingReconcilerProcessor(source(service), {
      batchSize: 1,
      stopDrainTimeoutMs: 750,
    });

    const sweep = processor.sweepNow();
    await bounded(providerStarted, 3_000, 'shutdown fixture never entered provider');
    let stopSettled = false;
    const stop = processor.stop().finally(() => { stopSettled = true; });
    await bounded(providerAbortObserved, 3_000, 'shutdown did not abort the provider attempt');
    await new Promise((resolveWait) => setTimeout(resolveWait, 900));
    assert.equal(stopSettled, true, 'shutdown must return after its bounded drain warning threshold');
    const retained = await prisma.tenantDeletionBillingReconciliation.findUnique({
      where: { tenantId: fixture.tenantId },
      select: { leaseOwner: true, leaseToken: true, leaseExpiresAt: true },
    });
    assert.ok(retained.leaseOwner, 'shutdown must retain the lease owner while transport is active');
    assert.ok(retained.leaseToken, 'shutdown must retain the fence token while transport is active');
    assert.ok(retained.leaseExpiresAt > new Date(), 'shutdown heartbeat must retain the active claim');

    terminateProviderTransport();
    await bounded(stop, 3_000, 'processor stop did not finish after provider transport terminated');
    assert.deepEqual(await bounded(sweep, 2_000, 'aborted sweep did not persist release state'), {
      claimed: 1,
      succeeded: 0,
      failed: 1,
      backlog: 1,
    });

    const failed = await prisma.tenantDeletionBillingReconciliation.findUnique({
      where: { tenantId: fixture.tenantId },
      select: {
        lastErrorCode: true,
        nextAttemptAt: true,
        lastFailureAt: true,
        leaseOwner: true,
        leaseToken: true,
        leaseExpiresAt: true,
      },
    });
    assert.equal(failed.lastErrorCode, 'RECONCILER_STOPPED');
    assert.ok(failed.nextAttemptAt > failed.lastFailureAt);
    assert.equal(failed.leaseOwner, null);
    assert.equal(failed.leaseToken, null);
    assert.equal(failed.leaseExpiresAt, null);
  } finally {
    terminateProviderTransport?.();
    await cleanupFixtures(prisma, [fixture.tenantId]);
    await prisma.$disconnect();
  }
});
