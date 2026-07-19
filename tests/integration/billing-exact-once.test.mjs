import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.env.TS_NODE_PROJECT = join(root, 'apps/api/tsconfig.json');
const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { PrismaClient } = require('@prisma/client');
const { AdminController } = require('../../apps/api/src/admin/admin.controller.ts');
const { FeatureAccessService } = require('../../apps/api/src/billing/feature-access.service.ts');
const { MeteringService } = require('../../apps/api/src/billing/metering.service.ts');
const { StripeCreditPurchaseService } = require('../../apps/api/src/billing/stripe-credit-purchase.service.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');

const postgresImage = 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const database = 'billing_exact_once_test';

function docker(args, { allowFailure = false, input, timeout = 30_000 } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8', input, timeout, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Docker failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

function psql(container, sql, { allowFailure = false } = {}) {
  return docker([
    'exec', '-i', container,
    'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
    '--username', 'postgres', '--dbname', database,
  ], { allowFailure, input: sql });
}

function scalar(container, sql) {
  return docker([
    'exec', container,
    'psql', '--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1',
    '--username', 'postgres', '--dbname', database, '--command', sql,
  ]).stdout.trim();
}

const baseSchema = `
CREATE TYPE public."PlanTier" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'ENTERPRISE');
CREATE TYPE public."TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'PURGED');

CREATE TABLE public."Tenant" (
  "id" TEXT PRIMARY KEY,
  "planTier" public."PlanTier" NOT NULL DEFAULT 'FREE',
  "stripeCustomerId" TEXT,
  "stripeSubscriptionId" TEXT,
  "status" public."TenantStatus" NOT NULL DEFAULT 'TRIAL',
  "trialEndsAt" TIMESTAMP(3),
  "usageCredits" INTEGER NOT NULL DEFAULT 0,
  "deletedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."CreditTransaction" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"("id"),
  "amount" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."PlanDefinition" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "monthlyPriceCents" INTEGER,
  "locationLimit" INTEGER,
  "userLimit" INTEGER,
  "creditQuotaLimit" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."BillingEvent" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"("id"),
  "type" TEXT NOT NULL,
  "stripeEventId" TEXT UNIQUE,
  "amount" INTEGER,
  "currency" TEXT DEFAULT 'usd',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."TenantSetting" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"("id"),
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("tenantId", "key")
);

CREATE TABLE public."AuditLog" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT,
  "actorUserId" TEXT,
  "actorTenantId" TEXT,
  "action" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "resourceId" TEXT,
  "oldValue" JSONB,
  "newValue" JSONB,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."User" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"("id"),
  "deletedAt" TIMESTAMP(3),
  "suspendedAt" TIMESTAMP(3)
);

CREATE TABLE public."AvailabilityImportJob" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"("id"),
  "userId" TEXT NOT NULL REFERENCES public."User"("id"),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "storageKey" TEXT,
  "fileSha256" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "encryptedSourcePayload" BYTEA,
  "creditConsumption" JSONB NOT NULL,
  "executionToken" TEXT,
  "executionLeaseUntil" TIMESTAMP(3),
  "requestHash" TEXT NOT NULL,
  "targetIdentityHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "parsedAvailability" JSONB,
  "resultErasedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE FUNCTION public.set_current_tenant(TEXT) RETURNS void
LANGUAGE sql AS 'SELECT NULL::void';
CREATE FUNCTION public.set_current_platform_admin(BOOLEAN, TEXT) RETURNS void
LANGUAGE sql AS 'SELECT NULL::void';
`;

const pythonWorkerProbe = String.raw`
import json
import sys
sys.path.insert(0, sys.argv[1])
from availability_import_store import AvailabilityImportRejected, ImportPayload, claim_import, complete_import

mode, tenant_id, import_id, token = sys.argv[2:6]
try:
    payload = ImportPayload(import_id, tenant_id)
    if mode == "claim":
        result = claim_import(payload, 0, token)
        output = {"ok": True, "status": result.status}
    else:
        complete_import(
            payload,
            token,
            "1" * 64,
            [{"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}],
        )
        output = {"ok": True, "status": "completed"}
except AvailabilityImportRejected as error:
    output = {"ok": False, "error": str(error)}
print(json.dumps(output))
`;

function workerProbe(databaseUrl, mode, tenantId, importId, token) {
  const run = spawnSync('python', [
    '-c', pythonWorkerProbe,
    join(root, 'apps/worker/src'), mode, tenantId, importId, token,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(run.stderr.trim() || run.stdout.trim());
  return JSON.parse(run.stdout.trim());
}

test('paid-through, exact admin grant, and deterministic replay hold in real PostgreSQL', {
  timeout: 120_000,
}, async (t) => {
  const available = docker(['version', '--format', '{{.Server.Version}}'], {
    allowFailure: true,
    timeout: 10_000,
  });
  if (available.status !== 0) {
    t.skip('Docker is required for the disposable PostgreSQL proof');
    return;
  }

  const container = `lunchlineup-billing-${process.pid}-${randomUUID()}`;
  let started = false;
  let prisma;
  try {
    docker([
      'run', '--detach', '--rm', '--name', container,
      '--env', 'POSTGRES_PASSWORD=disposable-test-only',
      '--env', `POSTGRES_DB=${database}`,
      '--publish', '127.0.0.1::5432',
      postgresImage,
    ], { timeout: 90_000 });
    started = true;

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = docker([
        'exec', container, 'sh', '-c',
        `test "$(cat /proc/1/comm)" = postgres && pg_isready --username postgres --dbname ${database}`,
      ], { allowFailure: true, timeout: 5_000 });
      if (probe.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.equal(ready, true, 'disposable PostgreSQL did not become ready');

    psql(container, baseSchema);
    psql(container, `
      INSERT INTO public."Tenant"
        ("id", "planTier", "status", "stripeCustomerId", "stripeSubscriptionId", "usageCredits")
      VALUES
        ('credit-pack', 'GROWTH', 'ACTIVE', 'cus_credit_pack', 'sub_credit_pack', 10);
      INSERT INTO public."CreditTransaction" ("id", "tenantId", "amount", "reason")
      VALUES
        ('stripe-credit-purchase-cs_real_pg_legacy', 'credit-pack', 100,
         'Stripe credit pack purchase CREDITS_100');
    `);
    psql(container, require('node:fs').readFileSync(
      join(root, 'packages/db/prisma/migrations/20260716_zzzzzz_billing_exact_once.sql'),
      'utf8',
    ));
    assert.equal(scalar(container, `SELECT count(*) FROM public."CreditTransaction" WHERE "id" = 'stripe-credit-purchase-cs_real_pg_legacy' AND "balanceAfter" IS NULL;`), '1');
    const retainedWriterSettlement = psql(container, `
      INSERT INTO public."CreditTransaction" ("id", "tenantId", "amount", "reason", "balanceAfter")
      VALUES ('retained-writer-null-settlement', 'credit-pack', 1, 'retained release compatibility', NULL);
    `, { allowFailure: true });
    assert.equal(retainedWriterSettlement.status, 0);
    assert.equal(scalar(container, `
      SELECT count(*) FROM public."CreditTransaction"
      WHERE "id" = 'retained-writer-null-settlement' AND "balanceAfter" IS NULL;
    `), '1');
    const refundDebtMigration = require('node:fs').readFileSync(
      join(root, 'packages/db/prisma/migrations/20260717_credit_refund_debt.sql'),
      'utf8',
    );
    psql(container, `BEGIN;\n${refundDebtMigration}\nCOMMIT;\n`);
    assert.equal(scalar(container, `
      SELECT count(*) FROM public."CreditTransaction"
      WHERE "debtAmount" = 0 AND "debtAfter" = 0;
    `), '2');

    psql(container, `
      INSERT INTO public."Tenant"
        ("id", "planTier", "status", "usageCredits", "creditDebt")
      VALUES ('legacy-debt', 'GROWTH', 'ACTIVE', 10, 40);
    `);
    const retainedDebtWriter = psql(container, `
      BEGIN;
      UPDATE public."Tenant"
      SET "usageCredits" = "usageCredits" + 5
      WHERE "id" = 'legacy-debt';
      INSERT INTO public."CreditTransaction"
        ("id", "tenantId", "amount", "reason", "balanceAfter")
      VALUES
        ('legacy-debt-old-writer', 'legacy-debt', 5, 'retained old writer', 15);
      COMMIT;
    `, { allowFailure: true });
    assert.notEqual(retainedDebtWriter.status, 0);
    assert.equal(scalar(container, `
      SELECT "usageCredits"::text || ':' || "creditDebt"::text
      FROM public."Tenant"
      WHERE "id" = 'legacy-debt';
    `), '10:40');
    assert.equal(scalar(container, `
      SELECT count(*)
      FROM public."CreditTransaction"
      WHERE "id" = 'legacy-debt-old-writer';
    `), '0');

    psql(container, `
      INSERT INTO public."Tenant"
        ("id", "planTier", "status", "usageCredits", "creditDebt")
      VALUES ('debt-first', 'GROWTH', 'ACTIVE', 10, 40);
    `);
    assert.equal(scalar(container, `
      SELECT
        "spendableAmount"::text || ':' ||
        "repaidDebt"::text || ':' ||
        "newBalance"::text || ':' ||
        "debtAfter"::text || ':' ||
        "replayed"::text
      FROM public.settle_positive_credit_value(
        'debt-first',
        100,
        'Disposable debt-first proof',
        'debt-first-settlement'
      );
    `), '60:40:70:0:false');
    assert.equal(scalar(container, `
      SELECT
        "spendableAmount"::text || ':' ||
        "repaidDebt"::text || ':' ||
        "newBalance"::text || ':' ||
        "debtAfter"::text || ':' ||
        "replayed"::text
      FROM public.settle_positive_credit_value(
        'debt-first',
        100,
        'Disposable debt-first proof',
        'debt-first-settlement'
      );
    `), '60:40:70:0:true');
    assert.equal(scalar(container, `
      SELECT "usageCredits"::text || ':' || "creditDebt"::text
      FROM public."Tenant"
      WHERE "id" = 'debt-first';
    `), '70:0');
    assert.equal(scalar(container, `
      SELECT count(*)
      FROM public."CreditTransaction"
      WHERE "id" = 'debt-first-settlement'
        AND "amount" = 60
        AND "debtAmount" = -40
        AND "balanceAfter" = 70
        AND "debtAfter" = 0;
    `), '1');
    const conflictingDebtReplay = psql(container, `
      SELECT *
      FROM public.settle_positive_credit_value(
        'debt-first',
        99,
        'Disposable debt-first proof',
        'debt-first-settlement'
      );
    `, { allowFailure: true });
    assert.notEqual(conflictingDebtReplay.status, 0);
    assert.equal(scalar(container, `
      SELECT "usageCredits"::text || ':' || "creditDebt"::text
      FROM public."Tenant"
      WHERE "id" = 'debt-first';
    `), '70:0');

    psql(container, `
      INSERT INTO public."PlanDefinition"
        ("id", "code", "name", "locationLimit", "userLimit", "active", "metadata")
      VALUES
        ('plan-free', 'FREE', 'Free', 1, 10, true, '{"features":[]}'::jsonb),
        ('plan-growth', 'GROWTH', 'Growth', 25, 250, true, '{"features":["scheduling"]}'::jsonb);

      INSERT INTO public."Tenant"
        ("id", "planTier", "status", "stripeSubscriptionId", "stripeSubscriptionCurrentPeriodEnd", "usageCredits")
      VALUES
        ('api-missing', 'GROWTH', 'ACTIVE', 'sub_missing', NULL, 500),
        ('api-expired', 'GROWTH', 'ACTIVE', 'sub_expired', CURRENT_TIMESTAMP - INTERVAL '1 second', 500),
        ('api-future', 'GROWTH', 'ACTIVE', 'sub_future', CURRENT_TIMESTAMP + INTERVAL '1 day', 5),
        ('api-no-credits', 'GROWTH', 'ACTIVE', 'sub_no_credits', CURRENT_TIMESTAMP + INTERVAL '1 day', 0),
        ('metering', 'GROWTH', 'ACTIVE', 'sub_metering', CURRENT_TIMESTAMP + INTERVAL '1 day', 10),
        ('admin-target', 'GROWTH', 'ACTIVE', 'sub_admin', CURRENT_TIMESTAMP + INTERVAL '1 day', 10),
        ('admin-audit-fail', 'GROWTH', 'ACTIVE', 'sub_admin_fail', CURRENT_TIMESTAMP + INTERVAL '1 day', 10),
        ('worker-missing', 'GROWTH', 'ACTIVE', 'sub_worker_missing', NULL, 50),
        ('worker-expired', 'GROWTH', 'ACTIVE', 'sub_worker_expired', CURRENT_TIMESTAMP - INTERVAL '1 second', 50),
        ('worker-free', 'FREE', 'ACTIVE', 'sub_worker_free', CURRENT_TIMESTAMP + INTERVAL '1 day', 50),
        ('worker-future', 'GROWTH', 'ACTIVE', 'sub_worker_future', CURRENT_TIMESTAMP + INTERVAL '1 day', 4),
        ('worker-commit-expired', 'GROWTH', 'ACTIVE', 'sub_worker_commit', CURRENT_TIMESTAMP + INTERVAL '1 day', 4),
        ('worker-commit-free', 'GROWTH', 'ACTIVE', 'sub_worker_commit_free', CURRENT_TIMESTAMP + INTERVAL '1 day', 4);

      UPDATE public."Tenant"
      SET "planTier" = 'GROWTH',
          "status" = 'ACTIVE',
          "stripeCustomerId" = 'cus_credit_pack',
          "stripeSubscriptionId" = 'sub_credit_pack',
          "stripeSubscriptionCurrentPeriodEnd" = CURRENT_TIMESTAMP + INTERVAL '1 day',
          "usageCredits" = 10
      WHERE "id" = 'credit-pack';

      INSERT INTO public."User" ("id", "tenantId") VALUES
        ('user-worker-missing', 'worker-missing'),
        ('user-worker-expired', 'worker-expired'),
        ('user-worker-free', 'worker-free'),
        ('user-worker-future', 'worker-future'),
        ('user-worker-commit-expired', 'worker-commit-expired'),
        ('user-worker-commit-free', 'worker-commit-free');

      INSERT INTO public."AvailabilityImportJob"
        ("id", "tenantId", "userId", "fileSha256", "fileSize", "encryptedSourcePayload",
         "creditConsumption", "requestHash", "targetIdentityHash", "expiresAt")
      VALUES
        ('import-missing', 'worker-missing', 'user-worker-missing', repeat('a', 64), 9, decode('4c4c41490300', 'hex'), '{"consumedCredits":1,"newBalance":4}', repeat('1', 64), repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '1 day'),
        ('import-expired', 'worker-expired', 'user-worker-expired', repeat('a', 64), 9, decode('4c4c41490300', 'hex'), '{"consumedCredits":1,"newBalance":4}', repeat('1', 64), repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '1 day'),
        ('import-free', 'worker-free', 'user-worker-free', repeat('a', 64), 9, decode('4c4c41490300', 'hex'), '{"consumedCredits":1,"newBalance":4}', repeat('1', 64), repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '1 day'),
        ('import-future', 'worker-future', 'user-worker-future', repeat('a', 64), 9, decode('4c4c41490300', 'hex'), '{"consumedCredits":1,"newBalance":4}', repeat('1', 64), repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '1 day'),
        ('import-commit-expired', 'worker-commit-expired', 'user-worker-commit-expired', repeat('a', 64), 9, decode('4c4c41490300', 'hex'), '{"consumedCredits":1,"newBalance":4}', repeat('1', 64), repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '1 day'),
        ('import-commit-free', 'worker-commit-free', 'user-worker-commit-free', repeat('a', 64), 9, decode('4c4c41490300', 'hex'), '{"consumedCredits":1,"newBalance":4}', repeat('1', 64), repeat('2', 64), CURRENT_TIMESTAMP + INTERVAL '1 day');

      INSERT INTO public."CreditTransaction" ("id", "tenantId", "amount", "reason", "balanceAfter") VALUES
        ('feature-usage-availability-import:import-missing', 'worker-missing', -1, 'Availability PDF import (import-missing)', 4),
        ('feature-usage-availability-import:import-expired', 'worker-expired', -1, 'Availability PDF import (import-expired)', 4),
        ('feature-usage-availability-import:import-free', 'worker-free', -1, 'Availability PDF import (import-free)', 4),
        ('feature-usage-availability-import:import-future', 'worker-future', -1, 'Availability PDF import (import-future)', 4),
        ('feature-usage-availability-import:import-commit-expired', 'worker-commit-expired', -1, 'Availability PDF import (import-commit-expired)', 4),
        ('feature-usage-availability-import:import-commit-free', 'worker-commit-free', -1, 'Availability PDF import (import-commit-free)', 4);
    `);

    const portOutput = docker(['port', container, '5432/tcp']).stdout.trim();
    const port = Number.parseInt(portOutput.slice(portOutput.lastIndexOf(':') + 1), 10);
    assert.ok(Number.isInteger(port) && port > 0, `unexpected PostgreSQL port: ${portOutput}`);
    const databaseUrl = `postgresql://postgres:disposable-test-only@127.0.0.1:${port}/${database}`;
    prisma = new PrismaClient({ datasources: { db: { url: `${databaseUrl}?schema=public&connection_limit=4` } } });
    const tenantDb = new TenantPrismaService(prisma);
    const metering = new MeteringService(tenantDb);
    const featureAccess = new FeatureAccessService(metering, tenantDb);

    for (const tenantId of ['api-missing', 'api-expired']) {
      const matrix = await featureAccess.resolveTenantFeatures(tenantId);
      assert.equal(matrix.usageCredits, 500);
      assert.equal(matrix.stripeSubscriptionActive, false);
      assert.equal(matrix.features.scheduling.enabled, false);
    }
    const paid = await featureAccess.resolveTenantFeatures('api-future');
    assert.equal(paid.stripeSubscriptionActive, true);
    assert.equal(paid.features.scheduling.enabled, true);
    const noCredits = await featureAccess.resolveTenantFeatures('api-no-credits');
    assert.equal(noCredits.stripeSubscriptionActive, true);
    assert.equal(noCredits.features.scheduling.enabled, false);
    assert.match(noCredits.features.scheduling.reason, /separately purchased usage credit/i);

    const firstGrant = await tenantDb.withTenant('metering', (tx) => metering.grantCreditsInTransaction(tx, {
      tenantId: 'metering', amount: 5, reason: 'Real PG correction', idempotencyKey: 'grant-1',
    }));
    const firstUsage = await tenantDb.withTenant('metering', (tx) => metering.recordFeatureUsageInTransaction(tx, {
      tenantId: 'metering', source: 'credits', cost: 1, reason: 'Real PG feature use', operationId: 'real-pg-1',
    }));
    await tenantDb.withTenant('metering', (tx) => metering.grantCreditsInTransaction(tx, {
      tenantId: 'metering', amount: 3, reason: 'Intervening correction', idempotencyKey: 'grant-2',
    }));
    const grantReplay = await tenantDb.withTenant('metering', (tx) => metering.grantCreditsInTransaction(tx, {
      tenantId: 'metering', amount: 5, reason: 'Real PG correction', idempotencyKey: 'grant-1',
    }));
    const usageReplay = await tenantDb.withTenant('metering', (tx) => metering.recordFeatureUsageInTransaction(tx, {
      tenantId: 'metering', source: 'credits', cost: 1, reason: 'Real PG feature use', operationId: 'real-pg-1',
    }));
    assert.equal(firstGrant.newBalance, 15);
    assert.equal(firstUsage.newBalance, 14);
    assert.equal(grantReplay.newBalance, 15);
    assert.equal(usageReplay.newBalance, 14);
    assert.equal((await prisma.tenant.findUnique({ where: { id: 'metering' }, select: { usageCredits: true } })).usageCredits, 17);

    const creditPurchaseSession = {
      id: 'cs_real_pg_credit',
      mode: 'payment',
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_real_pg_credit',
      customer: 'cus_credit_pack',
      client_reference_id: 'credit-pack',
      amount_subtotal: 1200,
      amount_total: 1200,
      currency: 'usd',
      metadata: {
        purchaseType: 'credit_pack',
        tenantId: 'credit-pack',
        creditPackCode: 'CREDITS_100',
        creditAmount: '100',
        priceId: 'price_credit_100',
        unitAmount: '1200',
        currency: 'usd',
        quantity: '1',
      },
    };
    const creditPurchases = new StripeCreditPurchaseService(
      {
        get: (key) => ({
          STRIPE_SECRET_KEY: 'sk_test_real_pg',
          STRIPE_PRICE_GROWTH: 'price_plan_growth',
        })[key],
      },
      tenantDb,
    );
    const refundCalls = [];
    creditPurchases.stripe = {
      checkout: {
        sessions: {
          retrieve: async (sessionId) => ({ ...creditPurchaseSession, id: sessionId }),
          listLineItems: async () => ({
            data: [{
              id: 'li_real_pg_credit',
              price: { id: 'price_credit_100' },
              quantity: 1,
              amount_subtotal: 1200,
              amount_total: 1200,
              currency: 'usd',
            }],
            has_more: false,
          }),
        },
      },
      subscriptions: {
        retrieve: async () => ({
          id: 'sub_credit_pack',
          status: 'active',
          customer: 'cus_credit_pack',
          metadata: { tenantId: 'credit-pack' },
          items: { data: [{ price: { id: 'price_plan_growth' } }] },
        }),
      },
      refunds: {
        create: async (input) => {
          refundCalls.push(input);
          return {
            id: `re_${input.metadata.checkoutSessionId}`,
            status: 'succeeded',
            amount: input.amount,
            currency: 'usd',
            payment_intent: input.payment_intent,
            metadata: input.metadata,
          };
        },
      },
    };
    const firstPurchase = await creditPurchases.handleCheckoutSessionCompleted({
      id: 'evt_real_pg_credit_first',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_real_pg_credit' } },
    });
    const interveningPurchaseWallet = await prisma.tenant.updateMany({
      where: { id: 'credit-pack' },
      data: { usageCredits: { increment: 7 } },
    });
    assert.equal(interveningPurchaseWallet.count, 1);
    const purchaseReplay = await creditPurchases.handleCheckoutSessionCompleted({
      id: 'evt_real_pg_credit_replay',
      type: 'checkout.session.async_payment_succeeded',
      data: { object: { id: 'cs_real_pg_credit' } },
    });
    assert.deepEqual(firstPurchase, {
      transactionId: 'stripe-credit-purchase-cs_real_pg_credit',
      newBalance: 110,
      replayed: false,
    });
    assert.deepEqual(purchaseReplay, {
      transactionId: 'stripe-credit-purchase-cs_real_pg_credit',
      newBalance: 110,
      replayed: true,
    });
    assert.equal(scalar(container, `SELECT "usageCredits" FROM public."Tenant" WHERE "id" = 'credit-pack';`), '117');
    assert.equal(scalar(container, `SELECT count(*) FROM public."CreditTransaction" WHERE "id" = 'stripe-credit-purchase-cs_real_pg_credit' AND "balanceAfter" = 110;`), '1');

    psql(container, `UPDATE public."Tenant" SET "planTier" = 'FREE' WHERE "id" = 'credit-pack';`);
    await creditPurchases.handleCheckoutSessionCompleted({
      id: 'evt_real_pg_credit_late_free',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_real_pg_late_free' } },
    });
    psql(container, `
      UPDATE public."Tenant"
      SET "planTier" = 'GROWTH',
          "stripeSubscriptionCurrentPeriodEnd" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = 'credit-pack';
    `);
    await creditPurchases.handleCheckoutSessionCompleted({
      id: 'evt_real_pg_credit_late_expired',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_real_pg_late_expired' } },
    });
    assert.equal(refundCalls.length, 2);
    assert.equal(scalar(container, `SELECT "usageCredits" FROM public."Tenant" WHERE "id" = 'credit-pack';`), '117');
    assert.equal(scalar(container, `SELECT count(*) FROM public."CreditTransaction" WHERE "id" IN ('stripe-credit-purchase-cs_real_pg_late_free', 'stripe-credit-purchase-cs_real_pg_late_expired');`), '0');
    assert.equal(scalar(container, `SELECT count(*) FROM public."BillingEvent" WHERE "tenantId" = 'credit-pack' AND "type" = 'credit_purchase.refund.succeeded' AND "metadata"->>'outcomeState' = 'refund_confirmed';`), '2');

    await assert.rejects(
      creditPurchases.handleCheckoutSessionCompleted({
        id: 'evt_real_pg_credit_legacy',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_real_pg_legacy' } },
      }),
      /settlement is malformed or mismatched/,
    );

    const immutableUpdate = psql(container, `UPDATE public."CreditTransaction" SET "balanceAfter" = 999 WHERE "id" = 'feature-usage-real-pg-1';`, { allowFailure: true });
    assert.notEqual(immutableUpdate.status, 0);
    assert.match(immutableUpdate.stderr, /settlement rows are immutable/);

    process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET = 'real-pg-platform-capability';
    const authorizationCalls = [];
    const controller = new AdminController(
      { get: () => undefined },
      {},
      metering,
      tenantDb,
      undefined,
      {
        authorizePlatformAdminTenantMutationInTransaction: async (_tx, tenantId, actor) => {
          authorizationCalls.push({ tenantId, actor });
        },
      },
    );
    const request = {
      ip: '203.0.113.50',
      headers: { 'user-agent': 'real-pg-test' },
      user: {
        tenantId: 'platform-tenant', sub: 'platform-admin', sessionId: 'platform-session',
        permissions: ['admin_portal:access'],
      },
    };
    const adminFirst = await controller.grantCredits(
      request,
      { tenantId: 'admin-target', amount: 5, reason: 'Audited correction' },
      'admin-real-pg-1',
    );
    await tenantDb.withTenant('admin-target', (tx) => metering.recordFeatureUsageInTransaction(tx, {
      tenantId: 'admin-target', source: 'credits', cost: 1, reason: 'Intervening admin target use', operationId: 'admin-target-use',
    }));
    const adminReplay = await controller.grantCredits(
      request,
      { tenantId: 'admin-target', amount: 5, reason: 'Audited correction' },
      'admin-real-pg-1',
    );
    assert.deepEqual(adminFirst, { success: true, newBalance: 15 });
    assert.deepEqual(adminReplay, { success: true, newBalance: 15 });
    assert.equal(authorizationCalls.length, 2);
    assert.equal(authorizationCalls[0].actor.sessionId, 'platform-session');
    assert.equal(scalar(container, `SELECT count(*) FROM public."AuditLog" WHERE "tenantId" = 'admin-target' AND "action" = 'TENANT_CREDITS_GRANTED';`), '1');
    assert.equal(scalar(container, `SELECT count(*) FROM public."CreditTransaction" WHERE "tenantId" = 'admin-target' AND "amount" = 5;`), '1');

    psql(container, `
      CREATE FUNCTION public.reject_exact_once_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."tenantId" = 'admin-audit-fail' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_exact_once_audit BEFORE INSERT ON public."AuditLog"
      FOR EACH ROW EXECUTE FUNCTION public.reject_exact_once_audit();
    `);
    await assert.rejects(
      controller.grantCredits(
        request,
        { tenantId: 'admin-audit-fail', amount: 5, reason: 'Must roll back' },
        'admin-real-pg-fail',
      ),
      /forced audit failure/,
    );
    assert.equal(scalar(container, `SELECT "usageCredits" FROM public."Tenant" WHERE "id" = 'admin-audit-fail';`), '10');
    assert.equal(scalar(container, `SELECT count(*) FROM public."CreditTransaction" WHERE "tenantId" = 'admin-audit-fail';`), '0');
    assert.equal(scalar(container, `SELECT count(*) FROM public."AuditLog" WHERE "tenantId" = 'admin-audit-fail';`), '0');

    for (const [tenantId, importId] of [
      ['worker-missing', 'import-missing'],
      ['worker-expired', 'import-expired'],
      ['worker-free', 'import-free'],
    ]) {
      const result = workerProbe(databaseUrl, 'claim', tenantId, importId, `token-${importId}`);
      assert.equal(result.ok, false);
      assert.match(result.error, /active paid subscription/);
    }
    const futureClaim = workerProbe(databaseUrl, 'claim', 'worker-future', 'import-future', 'token-future');
    assert.deepEqual(futureClaim, { ok: true, status: 'claimed' });
    const futureCommit = workerProbe(databaseUrl, 'complete', 'worker-future', 'import-future', 'token-future');
    assert.deepEqual(futureCommit, { ok: true, status: 'completed' });
    assert.equal(scalar(container, `SELECT "status" FROM public."AvailabilityImportJob" WHERE "id" = 'import-future';`), 'SUCCEEDED');

    const expiringClaim = workerProbe(databaseUrl, 'claim', 'worker-commit-expired', 'import-commit-expired', 'token-expiring');
    assert.equal(expiringClaim.ok, true);
    psql(container, `UPDATE public."Tenant" SET "stripeSubscriptionCurrentPeriodEnd" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = 'worker-commit-expired';`);
    const expiredCommit = workerProbe(databaseUrl, 'complete', 'worker-commit-expired', 'import-commit-expired', 'token-expiring');
    assert.equal(expiredCommit.ok, false);
    assert.match(expiredCommit.error, /active paid subscription/);
    assert.equal(scalar(container, `SELECT "status" FROM public."AvailabilityImportJob" WHERE "id" = 'import-commit-expired';`), 'RUNNING');

    const freeTransitionClaim = workerProbe(databaseUrl, 'claim', 'worker-commit-free', 'import-commit-free', 'token-free-transition');
    assert.equal(freeTransitionClaim.ok, true);
    psql(container, `UPDATE public."Tenant" SET "planTier" = 'FREE' WHERE "id" = 'worker-commit-free';`);
    const freeTransitionCommit = workerProbe(databaseUrl, 'complete', 'worker-commit-free', 'import-commit-free', 'token-free-transition');
    assert.equal(freeTransitionCommit.ok, false);
    assert.match(freeTransitionCommit.error, /active paid subscription/);
    assert.equal(scalar(container, `SELECT "status" FROM public."AvailabilityImportJob" WHERE "id" = 'import-commit-free';`), 'RUNNING');
  } finally {
    delete process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET;
    if (prisma) await prisma.$disconnect();
    if (started) docker(['rm', '--force', container], { allowFailure: true, timeout: 20_000 });
  }
});
