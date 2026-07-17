import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';

const root = resolve(import.meta.dirname, '../..');
process.env.TS_NODE_PROJECT = resolve(root, 'apps/api/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { TenantAccountLifecycleService } =
  require('../../apps/api/src/admin/tenant-account-lifecycle.service.ts');
const {
  PrismaTenantCancellationIntentStore,
  TenantCancellationLifecycleService,
} = require('../../apps/api/src/admin/tenant-cancellation-lifecycle.service.ts');
const { StripeService } = require('../../apps/api/src/billing/stripe.service.ts');
const { TenantPrismaService } =
  require('../../apps/api/src/database/tenant-prisma.service.ts');

const CUSTOMER_INTENT_KEY =
  'internal:tenant-lifecycle-intent:customer_cancellation';
const PLATFORM_INTENT_KEY =
  'internal:tenant-lifecycle-intent:platform_archive';
const PROVIDER_OPERATION_METADATA_KEY =
  'lunchlineupCancellationOperationId';

function required(name) {
  const value = process.env[name]?.trim();
  assert.ok(
    value,
    `${name} is required for mandatory tenant-cancellation PostgreSQL integration proof`,
  );
  return value;
}

function cloneSubscription(subscription) {
  return {
    ...subscription,
    metadata: { ...subscription.metadata },
  };
}

async function cleanupFixture(owner, tenantId, capability) {
  await owner.$executeRaw`
    DELETE FROM "TenantSetting"
    WHERE "tenantId" = ${tenantId}
      AND "key" IN (${CUSTOMER_INTENT_KEY}, ${PLATFORM_INTENT_KEY})
  `.catch(() => undefined);
  await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
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
    await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
  }).catch(() => undefined);
  await owner.$executeRaw`
    DELETE FROM "Session"
    WHERE "userId" IN (
      SELECT "id" FROM "User" WHERE "tenantId" = ${tenantId}
    )
  `.catch(() => undefined);
  await owner.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${tenantId}`
    .catch(() => undefined);
  await owner.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`
    .catch(() => undefined);
}

test(
  'later explicit customer cancellation owns the provider marker and fences stale platform compensation',
  { timeout: 30_000 },
  async () => {
    const ownerUrl = required('MIGRATION_DATABASE_URL');
    const restrictedUrl = required('DATABASE_URL');
    const capability = required('PLATFORM_ADMIN_DB_CONTEXT_SECRET');
    const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    const platformClient = new PrismaClient({
      datasources: { db: { url: restrictedUrl } },
    });
    const customerClient = new PrismaClient({
      datasources: { db: { url: restrictedUrl } },
    });
    const holdClient = new PrismaClient({
      datasources: { db: { url: restrictedUrl } },
    });
    const suffix = randomUUID();
    const tenantId = `tenant-cancellation-integration-${suffix}`;
    const tenantSlug = `cancellation-integration-${suffix}`;
    const userId = `user-cancellation-integration-${suffix}`;
    const sessionId = `session-cancellation-integration-${suffix}`;
    const subscriptionId = `sub-cancellation-integration-${suffix}`;
    const platformActor = {
      userId: `platform-cancellation-integration-${suffix}`,
      tenantId: `platform-cancellation-tenant-${suffix}`,
      ipAddress: '203.0.113.71',
      userAgent: 'cancellation-integration-platform',
    };
    const customerActor = {
      userId,
      tenantId,
      ipAddress: '203.0.113.72',
      userAgent: 'cancellation-integration-customer',
    };
    let providerSubscription = {
      id: subscriptionId,
      status: 'active',
      customer: `cus-cancellation-integration-${suffix}`,
      cancel_at_period_end: false,
      current_period_end: 1_800_000_000,
      metadata: { tenantId },
    };
    const providerUpdates = [];
    let platformProviderOperationId = null;
    let markStaleCompensationEntered;
    let releaseStaleCompensation;
    const staleCompensationEntered = new Promise((resolveEntered) => {
      markStaleCompensationEntered = resolveEntered;
    });
    const staleCompensationRelease = new Promise((resolveRelease) => {
      releaseStaleCompensation = resolveRelease;
    });
    const provider = {
      subscriptions: {
        retrieve: async (requestedSubscriptionId) => {
          assert.equal(requestedSubscriptionId, subscriptionId);
          return cloneSubscription(providerSubscription);
        },
        update: async (requestedSubscriptionId, update, options) => {
          assert.equal(requestedSubscriptionId, subscriptionId);
          providerUpdates.push({
            update: structuredClone(update),
            options: structuredClone(options),
          });
          if (update.cancel_at_period_end === false) {
            markStaleCompensationEntered();
            await staleCompensationRelease;
          }
          providerSubscription = {
            ...providerSubscription,
            cancel_at_period_end: update.cancel_at_period_end,
            metadata: {
              ...providerSubscription.metadata,
              ...update.metadata,
            },
          };
          const marker = update.metadata?.[PROVIDER_OPERATION_METADATA_KEY];
          if (update.cancel_at_period_end === true && !platformProviderOperationId) {
            platformProviderOperationId = marker;
          }
          return cloneSubscription(providerSubscription);
        },
      },
    };
    const platformDb = new TenantPrismaService(platformClient);
    const customerDb = new TenantPrismaService(customerClient);
    const stripe = new StripeService({
      get: (name) => ({
        STRIPE_SECRET_KEY: 'sk_test_cancellation_integration',
        STRIPE_WEBHOOK_SECRET: 'whsec_cancellation_integration',
      })[name],
    }, platformDb);
    stripe.stripe = provider;
    const originalCompensation =
      stripe.compensateTenantSubscriptionCancellation.bind(stripe);
    let compensationCalls = 0;
    stripe.compensateTenantSubscriptionCancellation = async (...args) => {
      compensationCalls += 1;
      return originalCompensation(...args);
    };
    const platformStore = new PrismaTenantCancellationIntentStore(
      platformDb,
      200,
    );
    let failProviderResultPersistence = true;
    const failureStore = {
      prepare: (input) => platformStore.prepare(input),
      markProviderApplied: async (prepared, outcome, providerMutationOwned) => {
        if (failProviderResultPersistence) {
          failProviderResultPersistence = false;
          throw new Error('injected post-provider persistence failure');
        }
        return platformStore.markProviderApplied(
          prepared,
          outcome,
          providerMutationOwned,
        );
      },
      renewProviderClaim: (prepared) => platformStore.renewProviderClaim(prepared),
      providerLeaseRenewalIntervalMs: () =>
        platformStore.providerLeaseRenewalIntervalMs(),
      markCompensated: (prepared, outcome) =>
        platformStore.markCompensated(prepared, outcome),
      releaseProviderClaim: (prepared) => platformStore.releaseProviderClaim(prepared),
      finalize: (prepared) => platformStore.finalize(prepared),
    };
    const platformLifecycle = new TenantCancellationLifecycleService(
      platformDb,
      () => stripe,
      failureStore,
    );
    const customerStore = new PrismaTenantCancellationIntentStore(
      customerDb,
      200,
    );
    let markCustomerPersistenceEntered;
    let releaseCustomerPersistence;
    const customerPersistenceEntered = new Promise((resolveEntered) => {
      markCustomerPersistenceEntered = resolveEntered;
    });
    const customerPersistenceRelease = new Promise((resolveRelease) => {
      releaseCustomerPersistence = resolveRelease;
    });
    const customerBarrierStore = {
      prepare: (input) => customerStore.prepare(input),
      markProviderApplied: async (prepared, outcome, providerMutationOwned) => {
        markCustomerPersistenceEntered();
        await customerPersistenceRelease;
        return customerStore.markProviderApplied(
          prepared,
          outcome,
          providerMutationOwned,
        );
      },
      renewProviderClaim: (prepared) => customerStore.renewProviderClaim(prepared),
      providerLeaseRenewalIntervalMs: () =>
        customerStore.providerLeaseRenewalIntervalMs(),
      markCompensated: (prepared, outcome) =>
        customerStore.markCompensated(prepared, outcome),
      releaseProviderClaim: (prepared) => customerStore.releaseProviderClaim(prepared),
      finalize: (prepared) => customerStore.finalize(prepared),
    };
    const customerLifecycle = new TenantCancellationLifecycleService(
      customerDb,
      () => stripe,
      customerBarrierStore,
    );
    const holdOwner = new TenantAccountLifecycleService(
      new TenantPrismaService(holdClient),
      stripe,
    );

    try {
      await owner.$executeRaw`
        INSERT INTO "Tenant"
          ("id", "name", "slug", "stripeCustomerId", "stripeSubscriptionId",
           "planTier", "status", "usageCredits", "createdAt", "updatedAt")
        VALUES
          (${tenantId}, 'Cancellation Integration', ${tenantSlug},
           ${providerSubscription.customer}, ${subscriptionId}, 'STARTER'::"PlanTier",
           'ACTIVE'::"TenantStatus", 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await owner.$executeRaw`
        INSERT INTO "User"
          ("id", "tenantId", "name", "username", "role", "mfaEnabled",
           "mfaBackupCodes", "createdAt", "updatedAt")
        VALUES
          (${userId}, ${tenantId}, 'Cancellation Integration Owner',
           ${`cancellation-integration-owner-${suffix}`}, 'ADMIN'::"UserRole",
           FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await owner.$executeRaw`
        INSERT INTO "Session"
          ("id", "userId", "selectorHash", "refreshToken", "ipAddress",
           "userAgent", "expiresAt", "createdAt")
        VALUES
          (${sessionId}, ${userId}, ${`selector-${suffix}`}, ${`refresh-${suffix}`},
           '203.0.113.72', 'cancellation-integration',
           CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP)
      `;

      await assert.rejects(
        platformLifecycle.archivePlatform(platformActor, tenantId),
        /pending reconciliation/i,
      );
      const platformOperationId =
        providerSubscription.metadata[PROVIDER_OPERATION_METADATA_KEY];
      assert.ok(platformOperationId);
      assert.equal(providerSubscription.cancel_at_period_end, true);

      await holdOwner.placeRetentionLegalHold(
        tenantId,
        platformActor,
        { reason: 'Customer cancellation must defeat stale platform compensation.' },
      );
      await delay(300);
      const claims = await platformStore.claimRecoverable(1);
      assert.equal(claims.length, 1);
      assert.equal(claims[0].intent.kind, 'PLATFORM_ARCHIVE');
      const stalePlatformRecovery = platformLifecycle.reconcilePrepared(claims[0]);
      await staleCompensationEntered;

      const customerCancellation = customerLifecycle.cancelCustomer(
        customerActor,
        { confirmation: tenantSlug },
      );
      await customerPersistenceEntered;

      const pendingCustomerSetting = await owner.tenantSetting.findUniqueOrThrow({
        where: {
          tenantId_key: { tenantId, key: CUSTOMER_INTENT_KEY },
        },
        select: { value: true },
      });
      assert.equal(pendingCustomerSetting.value.state, 'PENDING_PROVIDER');
      assert.equal(pendingCustomerSetting.value.providerResult, null);
      assert.notEqual(pendingCustomerSetting.value.operationId, platformOperationId);
      assert.equal(
        providerSubscription.metadata[PROVIDER_OPERATION_METADATA_KEY],
        pendingCustomerSetting.value.operationId,
      );

      releaseStaleCompensation();
      await stalePlatformRecovery;

      assert.equal(compensationCalls, 1);
      assert.equal(providerSubscription.cancel_at_period_end, true);
      assert.equal(
        providerSubscription.metadata[PROVIDER_OPERATION_METADATA_KEY],
        pendingCustomerSetting.value.operationId,
      );
      releaseCustomerPersistence();
      const customerResult = await customerCancellation;
      assert.equal(customerResult.status, 'ACTIVE');
      assert.equal(customerResult.billingCancellation.action, 'already_scheduled');
      assert.equal(customerResult.billingCancellation.cancelAtPeriodEnd, true);
      const customerSetting = await owner.tenantSetting.findUniqueOrThrow({
        where: {
          tenantId_key: { tenantId, key: CUSTOMER_INTENT_KEY },
        },
        select: { value: true },
      });
      const customerIntent = customerSetting.value;
      assert.equal(providerUpdates.length, 4);
      assert.deepEqual(
        providerUpdates.map(({ update }) => update.cancel_at_period_end),
        [true, false, true, true],
      );
      assert.equal(
        providerUpdates[0].options.idempotencyKey,
        createHash('sha256')
          .update(`tenant-cancellation:${platformOperationId}`)
          .digest('hex'),
      );
      assert.equal(
        providerUpdates[2].options.idempotencyKey,
        createHash('sha256')
          .update(`tenant-cancellation:${customerIntent.operationId}`)
          .digest('hex'),
      );
      assert.equal(new Set(providerUpdates.map(({ options }) => options.idempotencyKey)).size, 4);

      const [state] = await owner.$queryRaw`
        SELECT tenant."status"::text AS "status",
               tenant."stripeSubscriptionId" AS "subscriptionId",
               tenant."usageCredits" AS "credits",
               session."revokedAt" AS "sessionRevokedAt",
               platform."value" AS "platformIntent",
               customer."value" AS "customerIntent"
        FROM "Tenant" tenant
        JOIN "Session" session ON session."id" = ${sessionId}
        JOIN "TenantSetting" platform
          ON platform."tenantId" = tenant."id"
         AND platform."key" = ${PLATFORM_INTENT_KEY}
        JOIN "TenantSetting" customer
          ON customer."tenantId" = tenant."id"
         AND customer."key" = ${CUSTOMER_INTENT_KEY}
        WHERE tenant."id" = ${tenantId}
      `;
      assert.deepEqual({
        status: state.status,
        subscriptionId: state.subscriptionId,
        credits: state.credits,
        sessionRevokedAt: state.sessionRevokedAt,
      }, {
        status: 'ACTIVE',
        subscriptionId,
        credits: 100,
        sessionRevokedAt: null,
      });
      assert.deepEqual({
        kind: state.platformIntent.kind,
        state: state.platformIntent.state,
        operationId: state.platformIntent.operationId,
        providerMutationOwned: state.platformIntent.providerMutationOwned,
        providerAction: state.platformIntent.providerResult.action,
        compensationResult: state.platformIntent.compensationResult,
      }, {
        kind: 'PLATFORM_ARCHIVE',
        state: 'BLOCKED',
        operationId: platformOperationId,
        providerMutationOwned: true,
        providerAction: 'already_scheduled',
        compensationResult: {
          action: 'not_owned',
          cancelAtPeriodEnd: true,
        },
      });
      assert.deepEqual({
        kind: state.customerIntent.kind,
        state: state.customerIntent.state,
        operationId: state.customerIntent.operationId,
        providerMutationOwned: state.customerIntent.providerMutationOwned,
        providerAction: state.customerIntent.providerResult.action,
      }, {
        kind: 'CUSTOMER_CANCELLATION',
        state: 'FINALIZED',
        operationId: customerIntent.operationId,
        providerMutationOwned: true,
        providerAction: 'already_scheduled',
      });

      const audits = await owner.auditLog.groupBy({
        by: ['action', 'actorUserId', 'actorTenantId', 'userId'],
        where: { tenantId },
        _count: { _all: true },
      });
      const auditByAction = Object.fromEntries(audits.map((audit) => [
        audit.action,
        {
          count: audit._count._all,
          actorUserId: audit.actorUserId,
          actorTenantId: audit.actorTenantId,
          userId: audit.userId,
        },
      ]));
      assert.deepEqual(auditByAction, {
        TENANT_ARCHIVE_INTENT_RECORDED_BY_PLATFORM: {
          count: 1,
          actorUserId: platformActor.userId,
          actorTenantId: platformActor.tenantId,
          userId: null,
        },
        TENANT_RETENTION_LEGAL_HOLD_PLACED: {
          count: 1,
          actorUserId: platformActor.userId,
          actorTenantId: platformActor.tenantId,
          userId: null,
        },
        TENANT_CANCELLATION_INTENT_RECORDED_BY_CUSTOMER: {
          count: 1,
          actorUserId: userId,
          actorTenantId: tenantId,
          userId,
        },
        TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER: {
          count: 1,
          actorUserId: userId,
          actorTenantId: tenantId,
          userId,
        },
        TENANT_ARCHIVE_BLOCKED_BY_LEGAL_HOLD: {
          count: 1,
          actorUserId: platformActor.userId,
          actorTenantId: platformActor.tenantId,
          userId: null,
        },
      });
    } finally {
      releaseStaleCompensation?.();
      releaseCustomerPersistence?.();
      await cleanupFixture(owner, tenantId, capability);
      await platformClient.$disconnect();
      await customerClient.$disconnect();
      await holdClient.$disconnect();
      await owner.$disconnect();
    }
  },
);

test(
  'terminal customer finalization winning after provider return prevents stale platform local downgrade',
  { timeout: 30_000 },
  async () => {
    const ownerUrl = required('MIGRATION_DATABASE_URL');
    const restrictedUrl = required('DATABASE_URL');
    const capability = required('PLATFORM_ADMIN_DB_CONTEXT_SECRET');
    const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    const platformClient = new PrismaClient({
      datasources: { db: { url: restrictedUrl } },
    });
    const suffix = randomUUID();
    const tenantId = `tenant-cancellation-terminal-${suffix}`;
    const tenantSlug = `cancellation-terminal-${suffix}`;
    const userId = `user-cancellation-terminal-${suffix}`;
    const sessionId = `session-cancellation-terminal-${suffix}`;
    const subscriptionId = `sub-cancellation-terminal-${suffix}`;
    const platformOperationId = `platform-operation-${suffix}`;
    const customerOperationId = `customer-operation-${suffix}`;
    const providerLeaseOwner = `provider-owner-${suffix}`;
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    const scheduledOutcome = {
      action: 'already_scheduled',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: '2027-01-15T08:00:00.000Z',
      cancelAt: null,
      canceledAt: null,
      cancellationBehavior: 'cancel_at_period_end',
    };
    const platformIntent = {
      tenantId,
      kind: 'PLATFORM_ARCHIVE',
      operationId: platformOperationId,
      state: 'COMPENSATION_PENDING',
      actorUserId: `platform-user-${suffix}`,
      actorTenantId: `platform-tenant-${suffix}`,
      ipAddress: '203.0.113.81',
      userAgent: 'terminal-compensation-race',
      reason: null,
      providerSubscriptionId: subscriptionId,
      subscriptionFingerprint: createHash('sha256')
        .update(`${tenantId}:${subscriptionId}`)
        .digest('hex'),
      providerLeaseOwner,
      providerLeaseExpiresAt: leaseExpiresAt.toISOString(),
      providerAttempts: 1,
      providerMutationOwned: true,
      providerResult: scheduledOutcome,
      compensationResult: null,
      terminalReason: null,
      terminalizedAt: null,
    };
    let markCompensationReturned;
    let releaseCompensationResult;
    const compensationReturned = new Promise((resolveReturned) => {
      markCompensationReturned = resolveReturned;
    });
    const compensationResultRelease = new Promise((resolveRelease) => {
      releaseCompensationResult = resolveRelease;
    });
    const platformDb = new TenantPrismaService(platformClient);
    const platformStore = new PrismaTenantCancellationIntentStore(platformDb, 500);
    const lifecycle = new TenantCancellationLifecycleService(
      platformDb,
      () => ({
        cancelTenantSubscriptionAtPeriodEnd: async () => {
          throw new Error('provider cancellation must not run from compensation state');
        },
        compensateTenantSubscriptionCancellation: async () => {
          markCompensationReturned();
          await compensationResultRelease;
          return { action: 'already_terminal', cancelAtPeriodEnd: false };
        },
      }),
      platformStore,
    );

    try {
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
        await tx.$executeRaw`
          INSERT INTO "Tenant"
            ("id", "name", "slug", "stripeCustomerId", "stripeSubscriptionId",
             "planTier", "status", "usageCredits", "createdAt", "updatedAt")
          VALUES
            (${tenantId}, 'Terminal Cancellation Race', ${tenantSlug}, ${`cus-${suffix}`},
             ${subscriptionId}, 'STARTER'::"PlanTier", 'ACTIVE'::"TenantStatus", 100,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
      });
      await owner.$executeRaw`
        INSERT INTO "User"
          ("id", "tenantId", "name", "username", "role", "mfaEnabled",
           "mfaBackupCodes", "createdAt", "updatedAt")
        VALUES
          (${userId}, ${tenantId}, 'Terminal Cancellation Owner',
           ${`terminal-cancellation-owner-${suffix}`}, 'ADMIN'::"UserRole",
           FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
        await tx.$executeRaw`
          UPDATE "Tenant"
          SET "retentionLegalHoldAt" = CURRENT_TIMESTAMP,
              "retentionLegalHoldReason" = 'Terminal customer winner proof',
              "retentionLegalHoldByUserId" = ${userId},
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${tenantId}
        `;
      });
      await owner.$executeRaw`
        INSERT INTO "Session"
          ("id", "userId", "selectorHash", "refreshToken", "ipAddress",
           "userAgent", "expiresAt", "createdAt")
        VALUES
          (${sessionId}, ${userId}, ${`selector-${suffix}`}, ${`refresh-${suffix}`},
           '203.0.113.82', 'terminal-cancellation-race',
           CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP)
      `;
      await owner.$executeRaw`
        INSERT INTO "TenantSetting" ("id", "tenantId", "key", "value", "updatedAt")
        VALUES (${randomUUID()}, ${tenantId}, ${PLATFORM_INTENT_KEY},
                ${JSON.stringify(platformIntent)}::jsonb, CURRENT_TIMESTAMP)
      `;

      const reconciliation = lifecycle.reconcilePrepared({
        tenant: {
          id: tenantId,
          slug: tenantSlug,
          status: 'ACTIVE',
          deletedAt: null,
          retentionLegalHoldAt: new Date(),
          stripeSubscriptionId: subscriptionId,
        },
        intent: {
          ...platformIntent,
          providerLeaseExpiresAt: leaseExpiresAt,
          terminalizedAt: null,
        },
        providerLeaseOwner,
      });
      await compensationReturned;

      const terminalOutcome = {
        ...scheduledOutcome,
        action: 'already_canceled',
        cancelAtPeriodEnd: false,
        canceledAt: new Date().toISOString(),
      };
      const customerIntent = {
        ...platformIntent,
        kind: 'CUSTOMER_CANCELLATION',
        operationId: customerOperationId,
        state: 'FINALIZED',
        actorUserId: userId,
        actorTenantId: tenantId,
        providerLeaseOwner: null,
        providerLeaseExpiresAt: null,
        providerResult: terminalOutcome,
      };
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
        await tx.$executeRaw`
          UPDATE "Tenant"
          SET "status" = 'CANCELLED'::"TenantStatus",
              "stripeSubscriptionId" = NULL,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${tenantId}
        `;
        await tx.$executeRaw`
          INSERT INTO "TenantSetting" ("id", "tenantId", "key", "value", "updatedAt")
          VALUES (${randomUUID()}, ${tenantId}, ${CUSTOMER_INTENT_KEY},
                  ${JSON.stringify(customerIntent)}::jsonb, CURRENT_TIMESTAMP)
        `;
        await tx.$executeRaw`
          INSERT INTO "AuditLog"
            ("id", "tenantId", "userId", "actorUserId", "actorTenantId", "action",
             "resource", "resourceId", "createdAt")
          VALUES
            (${randomUUID()}, ${tenantId}, ${userId}, ${userId}, ${tenantId},
             'TENANT_CANCELLATION_COMPLETED_BY_CUSTOMER', 'Tenant', ${tenantId}, CURRENT_TIMESTAMP)
        `;
      });
      releaseCompensationResult();
      const result = await reconciliation;

      assert.equal(result.intent.state, 'BLOCKED');
      assert.deepEqual(result.intent.compensationResult, {
        action: 'not_owned',
        cancelAtPeriodEnd: false,
      });
      const [state] = await owner.$queryRaw`
        SELECT tenant."status"::text AS "status",
               tenant."stripeSubscriptionId" AS "subscriptionId",
               tenant."usageCredits" AS "credits",
               session."revokedAt" AS "sessionRevokedAt",
               platform."value"->'compensationResult'->>'action' AS "compensationAction",
               COUNT(audit."id") FILTER (
                 WHERE audit."action" = 'TENANT_ARCHIVE_BLOCKED_BY_LEGAL_HOLD'
               )::integer AS "blockedAuditCount",
               COUNT(audit."id") FILTER (
                 WHERE audit."action" = 'TENANT_CANCELLATION_COMPLETED_BY_CUSTOMER'
               )::integer AS "customerCompletedAuditCount"
        FROM "Tenant" tenant
        JOIN "Session" session ON session."id" = ${sessionId}
        JOIN "TenantSetting" platform
          ON platform."tenantId" = tenant."id" AND platform."key" = ${PLATFORM_INTENT_KEY}
        LEFT JOIN "AuditLog" audit ON audit."tenantId" = tenant."id"
        WHERE tenant."id" = ${tenantId}
        GROUP BY tenant."status", tenant."stripeSubscriptionId", tenant."usageCredits",
                 session."revokedAt", platform."value"
      `;
      assert.deepEqual(state, {
        status: 'CANCELLED',
        subscriptionId: null,
        credits: 100,
        sessionRevokedAt: null,
        compensationAction: 'not_owned',
        blockedAuditCount: 1,
        customerCompletedAuditCount: 1,
      });
    } finally {
      releaseCompensationResult?.();
      await cleanupFixture(owner, tenantId, capability);
      await platformClient.$disconnect();
      await owner.$disconnect();
    }
  },
);
