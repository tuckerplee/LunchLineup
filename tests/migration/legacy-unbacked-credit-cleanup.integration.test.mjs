import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const { MeteringService } = require('../../apps/api/src/billing/metering.service.ts');
const { TenantPrismaService } = require('../../apps/api/src/database/tenant-prisma.service.ts');
const migration = readFileSync(
  join(root, 'packages/db/prisma/migrations/20260716_legacy_unbacked_credit_cleanup.sql'),
  'utf8',
);
const postgresImage = 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const database = 'legacy_credit_cleanup_test';

function docker(args, { allowFailure = false, input, timeout = 30_000 } = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input,
    timeout,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Docker command failed: ${result.stderr.trim() || result.stdout.trim()}`);
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

function dockerAsync(args, { input, timeout = 30_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`Docker command timed out after ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`Docker command failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.end(input);
  });
}

async function waitForScalar(container, sql, predicate, label) {
  const deadline = Date.now() + 10_000;
  let last = '';
  while (Date.now() < deadline) {
    last = scalar(container, sql);
    if (predicate(last)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`${label}; last value=${last}`);
}

function scalar(container, sql) {
  return docker([
    'exec', container,
    'psql', '--no-psqlrc', '--tuples-only', '--no-align',
    '--set', 'ON_ERROR_STOP=1', '--username', 'postgres', '--dbname', database,
    '--command', sql,
  ]).stdout.trim();
}

const schema = `
CREATE TABLE public."Tenant" (
  "id" TEXT PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "usageCredits" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."CreditTransaction" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES public."Tenant"("id"),
  "amount" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "balanceAfter" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public."PlatformConfig" (
  "id" TEXT PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedBy" TEXT
);

CREATE FUNCTION public.set_current_tenant(tenant_id TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.current_tenant', tenant_id, true);
END;
$$;
`;

test('legacy unbacked credit cleanup is selective, fail-closed, and replay-safe in PostgreSQL', {
  timeout: 120_000,
}, async (t) => {
  const available = docker(['version', '--format', '{{.Server.Version}}'], {
    allowFailure: true,
    timeout: 10_000,
  });
  if (available.status !== 0) {
    t.skip('Docker is required for the disposable PostgreSQL migration proof');
    return;
  }

  const container = `lunchlineup-legacy-credit-${process.pid}-${randomUUID()}`;
  let started = false;
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
    let consecutiveReadyProbes = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = docker([
        'exec', container, 'pg_isready', '--username', 'postgres', '--dbname', database,
      ], { allowFailure: true, timeout: 5_000 });
      if (probe.status === 0) {
        consecutiveReadyProbes += 1;
        if (consecutiveReadyProbes >= 2) {
          ready = true;
          break;
        }
      } else {
        consecutiveReadyProbes = 0;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    assert.equal(ready, true, 'disposable PostgreSQL did not become ready');

    psql(container, `${schema}
      INSERT INTO public."Tenant" ("id", "slug", "usageCredits") VALUES
        ('legacy-fixed-zero', 'legacy-company-fixed', 0),
        ('legacy-zero-ledger', 'legacy-company-1', 1000),
        ('legacy-legitimate', 'legacy-company-2', 1000),
        ('legacy-mixed', 'legacy-company-3', 1250),
        ('ordinary-tenant', 'ordinary-tenant', 1000);
      INSERT INTO public."CreditTransaction" ("id", "tenantId", "amount", "reason") VALUES
        ('legitimate-grant', 'legacy-legitimate', 1000, 'Stripe credit purchase'),
        ('mixed-grant', 'legacy-mixed', 250, 'Admin credit grant');
      INSERT INTO public."PlatformConfig" ("id", "key", "value", "updatedAt", "updatedBy") VALUES
        (
          'legacy-fixed-zero-provenance',
          'legacy-import.credit-provenance.v1.legacy-fixed-zero',
          '{"version":1,"tenantId":"legacy-fixed-zero","sourceSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","initialCreditPolicy":"zero-wallet-no-ledger","initialCreditGrant":0}'::jsonb,
          CURRENT_TIMESTAMP,
          'scripts/import-legacy-users.mjs'
        ),
        (
          'obsolete-global-marker',
          'migration.legacy-unbacked-1000-credit-cleanup.v1',
          '{"knownGrantCredits":1000,"status":"complete","version":1}'::jsonb,
          CURRENT_TIMESTAMP,
          'old-raw-migration'
        );
    `);

    psql(container, migration);
    assert.deepEqual(JSON.parse(scalar(container, `
      SELECT jsonb_object_agg("id", "usageCredits" ORDER BY "id")
      FROM public."Tenant";
    `)), {
      'legacy-fixed-zero': 0,
      'legacy-legitimate': 1000,
      'legacy-mixed': 250,
      'legacy-zero-ledger': 0,
      'ordinary-tenant': 1000,
    });
    assert.equal(
      scalar(container, 'SELECT count(*)::text || \':\' || sum("amount")::text FROM public."CreditTransaction";'),
      '2:1250',
      'ledger-backed credits must remain untouched',
    );
    assert.equal(
      scalar(container, `SELECT count(*) FROM public."PlatformConfig" WHERE "key" LIKE 'legacy-import.credit-provenance.v1.%';`),
      '3',
      'the migration must retain importer provenance and add only per-tenant reconciliation provenance',
    );

    const firstPassState = scalar(container, `
      SELECT jsonb_build_object(
        'wallets', (SELECT jsonb_object_agg("id", "usageCredits" ORDER BY "id") FROM public."Tenant"),
        'ledger', (SELECT jsonb_agg(jsonb_build_array("id", "amount") ORDER BY "id") FROM public."CreditTransaction"),
        'provenance', (SELECT jsonb_object_agg("key", "value" ORDER BY "key") FROM public."PlatformConfig")
      );
    `);
    psql(container, migration);
    assert.equal(scalar(container, `
      SELECT jsonb_build_object(
        'wallets', (SELECT jsonb_object_agg("id", "usageCredits" ORDER BY "id") FROM public."Tenant"),
        'ledger', (SELECT jsonb_agg(jsonb_build_array("id", "amount") ORDER BY "id") FROM public."CreditTransaction"),
        'provenance', (SELECT jsonb_object_agg("key", "value" ORDER BY "key") FROM public."PlatformConfig")
      );
    `), firstPassState, 'a second migration pass must be a no-op');

    psql(container, `
      INSERT INTO public."Tenant" ("id", "slug", "usageCredits") VALUES
        ('legacy-later-unbacked', 'legacy-company-later-unbacked', 1000),
        ('legacy-post-marker-fixed', 'legacy-company-post-marker-fixed', 0);
      INSERT INTO public."PlatformConfig" ("id", "key", "value", "updatedAt", "updatedBy") VALUES (
        'legacy-post-marker-fixed-provenance',
        'legacy-import.credit-provenance.v1.legacy-post-marker-fixed',
        '{"version":1,"tenantId":"legacy-post-marker-fixed","sourceSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","initialCreditPolicy":"zero-wallet-no-ledger","initialCreditGrant":0}'::jsonb,
        CURRENT_TIMESTAMP,
        'scripts/import-legacy-users.mjs'
      );
    `);
    psql(container, migration);
    assert.equal(
      scalar(container, `SELECT "usageCredits" FROM public."Tenant" WHERE "id" = 'legacy-later-unbacked';`),
      '0',
      'a later legacy 1,000-credit row must be reconciled on a repeatable rescan',
    );
    assert.equal(
      scalar(container, `SELECT "usageCredits" FROM public."Tenant" WHERE "id" = 'legacy-post-marker-fixed';`),
      '0',
      'a fixed import after the obsolete global marker must remain unambiguous and unchanged',
    );

    const portOutput = docker(['port', container, '5432/tcp']).stdout.trim();
    const port = Number.parseInt(portOutput.slice(portOutput.lastIndexOf(':') + 1), 10);
    assert.ok(Number.isInteger(port) && port > 0, `unexpected PostgreSQL port mapping: ${portOutput}`);
    const baseUrl = `postgresql://postgres:disposable-test-only@127.0.0.1:${port}/${database}`;
    const grantPrisma = new PrismaClient({
      datasources: { db: { url: `${baseUrl}?schema=public&connection_limit=1&application_name=actual_grant_race` } },
    });
    const barrierPrisma = new PrismaClient({
      datasources: { db: { url: `${baseUrl}?schema=public&connection_limit=1&application_name=grant_barrier` } },
    });
    let releaseBarrier;
    let markBarrierReady;
    let barrier;
    let grant;
    let migrationRace;
    const barrierReady = new Promise((resolveReady) => { markBarrierReady = resolveReady; });
    const barrierRelease = new Promise((resolveRelease) => { releaseBarrier = resolveRelease; });
    const barrierKey = 7_162_026;
    try {
      psql(container, `
        INSERT INTO public."Tenant" ("id", "slug", "usageCredits")
        VALUES ('legacy-grant-race', 'legacy-company-grant-race', 1000);
        CREATE FUNCTION public.hold_actual_grant_after_ledger_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${barrierKey});
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER tr_hold_actual_grant_after_ledger_insert
        AFTER INSERT ON public."CreditTransaction"
        FOR EACH ROW EXECUTE FUNCTION public.hold_actual_grant_after_ledger_insert();
      `);
      barrier = barrierPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1)', barrierKey);
        markBarrierReady();
        await barrierRelease;
      }, { timeout: 30_000 });
      await barrierReady;

      const metering = new MeteringService(new TenantPrismaService(grantPrisma));
      grant = grantPrisma.$transaction((tx) => metering.grantCreditsInTransaction(tx, {
        tenantId: 'legacy-grant-race',
        amount: 5,
        reason: 'Race-safe administrative correction',
        idempotencyKey: 'legacy-cleanup-race-grant',
      }));
      await waitForScalar(
        container,
        `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted;`,
        (value) => Number(value) >= 1,
        'actual grant did not reach the post-ledger barrier',
      );

      migrationRace = dockerAsync([
        'exec', '-i', container,
        'psql', '--no-psqlrc', '--set', 'ON_ERROR_STOP=1',
        '--username', 'postgres', '--dbname', database,
      ], { input: migration, timeout: 30_000 });
      await waitForScalar(
        container,
        `SELECT count(*)
         FROM pg_locks lock
         JOIN pg_class relation ON relation.oid = lock.relation
         WHERE relation.relname = 'Tenant'
           AND lock.mode = 'ShareRowExclusiveLock'
           AND NOT lock.granted;`,
        (value) => Number(value) >= 1,
        'cleanup migration did not wait behind the actual grant tenant lock',
      );

      releaseBarrier();
      const [grantBalance, migrationResult] = await Promise.all([grant, migrationRace, barrier]);
      assert.equal(grantBalance.newBalance, 1005, 'the grant transaction must commit its exact increment before cleanup');
      assert.doesNotMatch(`${migrationResult.stdout}\n${migrationResult.stderr}`, /40P01|deadlock detected/i);
      assert.equal(
        scalar(container, `
          SELECT count(*)::text || ':' || COALESCE(sum("amount"), 0)::text
          FROM public."CreditTransaction"
          WHERE "tenantId" = 'legacy-grant-race';
        `),
        '1:5',
        'the actual grant race must leave exactly one ledger grant',
      );
      assert.equal(
        scalar(container, `
          SELECT tenant."usageCredits"::text || ':' || COALESCE(sum(credit."amount"), 0)::text
          FROM public."Tenant" tenant
          LEFT JOIN public."CreditTransaction" credit ON credit."tenantId" = tenant."id"
          WHERE tenant."id" = 'legacy-grant-race'
          GROUP BY tenant."usageCredits";
        `),
        '5:5',
        'the cleanup race must leave the wallet balanced to its one legitimate grant',
      );
    } finally {
      releaseBarrier?.();
      await Promise.allSettled([barrier, grant, migrationRace].filter(Boolean));
      await Promise.allSettled([grantPrisma.$disconnect(), barrierPrisma.$disconnect()]);
    }

    psql(container, `DROP SCHEMA public CASCADE; CREATE SCHEMA public; ${schema}
      INSERT INTO public."Tenant" ("id", "slug", "usageCredits") VALUES
        ('legacy-safe', 'legacy-company-4', 1000),
        ('legacy-consumed', 'legacy-company-5', 600);
      INSERT INTO public."CreditTransaction" ("id", "tenantId", "amount", "reason") VALUES
        ('consumed-debit', 'legacy-consumed', -400, 'Historical usage');
    `);
    const ambiguous = psql(container, migration, { allowFailure: true });
    assert.notEqual(ambiguous.status, 0, 'consumed legacy history must stop the migration');
    assert.match(ambiguous.stderr, /ambiguous or consumed credit history/);
    assert.equal(
      scalar(container, `SELECT "usageCredits" FROM public."Tenant" WHERE "id" = 'legacy-safe';`),
      '1000',
      'a fail-closed pass must roll back earlier candidate cleanup',
    );
    assert.equal(scalar(container, 'SELECT count(*) FROM public."PlatformConfig";'), '0');

    psql(container, `DROP SCHEMA public CASCADE; CREATE SCHEMA public; ${schema}
      INSERT INTO public."Tenant" ("id", "slug", "usageCredits") VALUES
        ('legacy-fixed-safe', 'legacy-company-fixed-safe', 0),
        ('legacy-zero-ambiguous', 'legacy-company-zero-ambiguous', 0);
      INSERT INTO public."PlatformConfig" ("id", "key", "value", "updatedAt", "updatedBy") VALUES (
        'legacy-fixed-safe-provenance',
        'legacy-import.credit-provenance.v1.legacy-fixed-safe',
        '{"version":1,"tenantId":"legacy-fixed-safe","sourceSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","initialCreditPolicy":"zero-wallet-no-ledger","initialCreditGrant":0}'::jsonb,
        CURRENT_TIMESTAMP,
        'scripts/import-legacy-users.mjs'
      );
    `);
    const zeroAmbiguity = psql(container, migration, { allowFailure: true });
    assert.notEqual(zeroAmbiguity.status, 0, 'zero wallet/no ledger without importer provenance must fail closed');
    assert.match(zeroAmbiguity.stderr, /ambiguous fully consumed or manually cleared/);
    assert.equal(
      scalar(container, `SELECT "usageCredits" FROM public."Tenant" WHERE "id" = 'legacy-fixed-safe';`),
      '0',
      'the fixed-import tenant must remain unchanged when another candidate aborts the pass',
    );
  } finally {
    if (started) {
      const removed = docker(['rm', '--force', container], {
        allowFailure: true,
        timeout: 30_000,
      });
      assert.equal(removed.status, 0, `failed to remove disposable PostgreSQL: ${removed.stderr}`);
      const inspect = docker(['inspect', container], { allowFailure: true, timeout: 10_000 });
      assert.notEqual(inspect.status, 0, 'disposable PostgreSQL container survived cleanup');
    }
  }
});
