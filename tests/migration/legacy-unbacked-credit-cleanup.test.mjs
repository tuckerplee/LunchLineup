import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildLegacyImportPlan, DEFAULT_LIMITS, ROLE_PLAN_SHA256, PERMISSIONS, ROLE_DEFINITIONS } from '../../scripts/legacy-import-plan.mjs';
import { executeLegacyImport } from '../../scripts/legacy-import-executor.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const migrationPath = 'packages/db/prisma/migrations/20260716_legacy_unbacked_credit_cleanup.sql';
const migration = read(migrationPath);

function creditBootstrapFixture({ failBootstrap = false } = {}) {
  const generation = '11111111-1111-4111-8111-111111111111';
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const source = Buffer.from(JSON.stringify({ companies: [{ id: 1, name: 'Conservation Fixture' }], stores: [], users: [], staff: [], user_company_roles: [], user_store_roles: [] }));
  const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, namespace: 'credit-conservation', targetGenerationId: generation, sourceSha256: sha(source), adapterVersion: 'legacy-combined-v1', rolePlanSha256: ROLE_PLAN_SHA256, timezone: 'America/Los_Angeles', companySlugs: { 1: 'legacy-company-1' }, limits: DEFAULT_LIMITS }));
  const plan = buildLegacyImportPlan(source, descriptor, { expectedSourceSha256: sha(source), expectedDescriptorSha256: sha(descriptor) });
  let state = { sequence: 0, run: null, company: null, tenants: [{ id: 'paid-tenant', slug: 'paid-customer', usageCredits: 337, status: 'ACTIVE', deletedAt: null }], ledger: [{ id: 'paid-purchase', tenantId: 'paid-tenant', amount: 337 }], provenance: [], roles: [], grants: [], permissions: PERMISSIONS.map(([key, label, description, category], index) => ({ id: `permission-${index}`, key, label: `Existing ${label}`, description: `Existing ${description}`, category })) };
  const attempted = []; const committed = []; let transaction = 0;
  const snapshot = () => structuredClone(state);
  // Explicit company-only staged adapter. A CreditTransaction write or unknown
  // delegate/SQL fails; ledger rows below are passive conservation controls.
  // This proves local executor behavior, not PostgreSQL lock/FK/RLS semantics.
  const db = { async $transaction(operation, options) {
    assert.equal(options.isolationLevel, 'ReadCommitted');
    const draft = snapshot(); const txId = ++transaction; const effects = [];
    function effect(name, data, apply) { const entry = { tx: txId, name, data: structuredClone(data) }; attempted.push(entry); effects.push(entry); apply(); }
    const owner = {
      async $executeRaw(parts, ...args) {
        const sql = parts.join('?');
        if (sql === "SELECT pg_catalog.set_config('statement_timeout', ?, true), pg_catalog.set_config('lock_timeout', ?, true)") { assert.deepEqual(args, [String(options.timeout), String(options.maxWait)]); return 1; }
        if (sql === 'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))') { assert.deepEqual(JSON.parse(args[0]), ['legacy-import-namespace-v1', plan.namespace]); return 1; }
        if (sql === 'SELECT public.lock_tenant_lifecycle(?)') { assert.deepEqual(args, ['fresh-tenant']); return 1; }
        if (sql === 'INSERT INTO legacy_import.company (namespace, company_id, target_tenant_id, source_row_sha256, bootstrap_role_ids) VALUES (?, ?::bigint, ?, ?, ?::jsonb)') {
          assert.equal(args.length, 5);
          const row = { namespace: args[0], company_id: BigInt(args[1]), target_tenant_id: args[2], source_row_sha256: args[3], bootstrap_role_ids: JSON.parse(args[4]) };
          effect('company.receipt', row, () => { draft.company = row; }); return 1;
        }
        if (sql === "UPDATE legacy_import.run SET status = 'COMPLETE', completed_at = pg_catalog.clock_timestamp() WHERE namespace = ? AND status = 'INITIALIZED'") { assert.deepEqual(args, [plan.namespace]); effect('run.complete', {}, () => { draft.run.status = 'COMPLETE'; }); return 1; }
        assert.fail(`unknown conservation fixture statement: ${sql}`);
      },
      async $queryRaw(parts, ...args) {
        const sql = parts.join('?');
        if (sql === 'SELECT generation_uuid FROM legacy_import.target_generation WHERE singleton = TRUE') { assert.equal(args.length, 0); return [{ generation_uuid: generation }]; }
        if (sql === 'SELECT * FROM legacy_import.run WHERE namespace = ? FOR UPDATE') { assert.deepEqual(args, [plan.namespace]); return draft.run ? [structuredClone(draft.run)] : []; }
        if (sql === "INSERT INTO legacy_import.run (namespace, generation_uuid, source_sha256, adapter_version, role_plan_sha256, approval_plan_sha256, expected_company_count, expected_location_count, expected_user_count, expected_staff_count, status) VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, 'INITIALIZED') RETURNING *") {
          assert.equal(args.length, 10);
          const row = { namespace: args[0], generation_uuid: args[1], source_sha256: args[2], adapter_version: args[3], role_plan_sha256: args[4], approval_plan_sha256: args[5], expected_company_count: args[6], expected_location_count: args[7], expected_user_count: args[8], expected_staff_count: args[9], status: 'INITIALIZED' };
          effect('run.initialize', row, () => { draft.run = row; }); return [structuredClone(row)];
        }
        if (sql === 'SELECT * FROM legacy_import.company WHERE namespace = ? AND company_id = ?::bigint FOR UPDATE') { assert.deepEqual(args, [plan.namespace, '1']); return draft.company ? [structuredClone(draft.company)] : []; }
        if (sql === 'SELECT "id" FROM public."Tenant" WHERE "id" = ? FOR UPDATE') { assert.deepEqual(args, ['fresh-tenant']); return [{ id: 'fresh-tenant' }]; }
        if (sql === 'SELECT company_id FROM legacy_import.company WHERE namespace = ?') { assert.deepEqual(args, [plan.namespace]); return draft.company ? [{ company_id: 1n }] : []; }
        if (sql === 'SELECT company_id, source_type, legacy_id FROM legacy_import.entity WHERE namespace = ?') { assert.deepEqual(args, [plan.namespace]); return []; }
        assert.fail(`unknown conservation fixture query: ${sql}`);
      },
      tenant: {
        async findUnique({ where }) { assert.equal(Object.keys(where).length, 1); assert.ok('slug' in where || 'id' in where); return structuredClone(draft.tenants.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null); },
        async create({ data }) { assert.deepEqual(Object.keys(data).sort(), ['name', 'planTier', 'slug', 'status', 'usageCredits']); const row = { id: 'fresh-tenant', deletedAt: null, applicationDataPurgedAt: null, ...structuredClone(data) }; effect('tenant.create', data, () => draft.tenants.push(row)); return structuredClone(row); },
      },
      platformConfig: { async create({ data }) { assert.deepEqual(Object.keys(data).sort(), ['id', 'key', 'updatedBy', 'value']); effect('credit.provenance', data, () => draft.provenance.push(structuredClone(data))); return structuredClone(data); } },
      permission: { async findMany({ where, select }) { assert.deepEqual(where, { key: { in: PERMISSIONS.map(([key]) => key) } }); assert.deepEqual(select, { id: true, key: true }); return draft.permissions.map(({ id, key }) => ({ id, key })); } },
      role: { async create({ data }) { assert.deepEqual(Object.keys(data).sort(), ['isDefault', 'isSystem', 'legacyRole', 'name', 'slug', 'tenantId']); const row = { id: `fresh-role-${++draft.sequence}`, ...structuredClone(data) }; effect('role.create', data, () => draft.roles.push(row)); return structuredClone(row); } },
      rolePermission: { async createMany({ data }) {
        for (const row of data) { assert.deepEqual(Object.keys(row).sort(), ['permissionId', 'roleId']); assert.ok(draft.roles.some((role) => role.id === row.roleId)); assert.ok(draft.permissions.some((permission) => permission.id === row.permissionId)); }
        effect('role.grants', data, () => draft.grants.push(...structuredClone(data)));
        if (failBootstrap) throw new Error('synthetic bootstrap completion failure');
        return { count: data.length };
      } },
    };
    const result = await operation(owner); state = draft; committed.push(...effects); return result;
  } };
  return { db, plan, snapshot, attempted, committed, mutate: (change) => change(state) };
}

test('legacy import and forward cleanup remove only the known unbacked grant', async () => {
  const metering = read('apps/api/src/billing/metering.service.ts');
  const fixture = creditBootstrapFixture(); const initial = fixture.snapshot();
  await executeLegacyImport(fixture.plan, { db: fixture.db });
  const imported = fixture.snapshot(); const fresh = imported.tenants.find((row) => row.id === 'fresh-tenant');
  assert.equal(fresh.usageCredits, 0); assert.equal(fresh.status, 'ACTIVE');
  assert.deepEqual(imported.ledger, initial.ledger); assert.deepEqual(imported.tenants[0], initial.tenants[0]);
  assert.deepEqual(imported.permissions, initial.permissions, 'import does not rewrite existing permission metadata');
  assert.equal(imported.provenance.length, 1);
  assert.deepEqual(imported.provenance[0], { id: 'legacy-import-credit-provenance-fresh-tenant', key: 'legacy-import.credit-provenance.v1.fresh-tenant', value: { version: 1, tenantId: 'fresh-tenant', sourceSha256: fixture.plan.sourceSha256, initialCreditPolicy: 'zero-wallet-no-ledger', initialCreditGrant: 0 }, updatedBy: 'scripts/import-legacy-users.mjs' });
  assert.equal(imported.roles.length, 4);
  for (const definition of ROLE_DEFINITIONS) {
    const role = imported.roles.find((row) => row.legacyRole === definition.legacyRole);
    assert.ok(role); assert.equal(imported.company.bootstrap_role_ids[definition.legacyRole], role.id);
    assert.deepEqual(imported.grants.filter((grant) => grant.roleId === role.id).map((grant) => imported.permissions.find((permission) => permission.id === grant.permissionId).key).sort(), [...definition.permissions].sort());
  }
  const bootstrapEffects = fixture.committed.filter((entry) => ['tenant.create', 'credit.provenance', 'role.create', 'role.grants', 'company.receipt'].includes(entry.name));
  assert.equal(new Set(bootstrapEffects.map((entry) => entry.tx)).size, 1, 'tenant, provenance, complete roles and receipt commit in one staged transaction');
  assert.equal(imported.run.status, 'COMPLETE');
  fixture.mutate((state) => { state.tenants.find((row) => row.id === 'fresh-tenant').usageCredits = 81; state.ledger.push({ id: 'later-admin-grant', tenantId: 'fresh-tenant', amount: 81 }); });
  const paid = fixture.snapshot(); const effects = fixture.committed.length;
  await executeLegacyImport(fixture.plan, { db: fixture.db });
  assert.deepEqual(fixture.snapshot(), paid, 'retry conserves independently granted credits and their ledger rather than clearing or granting again');
  assert.equal(fixture.committed.length, effects);
  const failed = creditBootstrapFixture({ failBootstrap: true }); const beforeFailure = failed.snapshot();
  await assert.rejects(executeLegacyImport(failed.plan, { db: failed.db }), /synthetic bootstrap completion failure/);
  const rolledBack = failed.snapshot();
  for (const key of ['tenants', 'ledger', 'provenance', 'roles', 'grants', 'permissions']) assert.deepEqual(rolledBack[key], beforeFailure[key], `failed bootstrap preserves ${key}`);
  assert.equal(rolledBack.company, null); assert.equal(rolledBack.run.status, 'INITIALIZED');
  assert.ok(failed.attempted.some((entry) => entry.name === 'role.grants'));
  assert.equal(failed.committed.some((entry) => entry.name === 'tenant.create' || entry.name === 'credit.provenance'), false);
  assert.match(migration, /LOCK TABLE public\."Tenant", public\."CreditTransaction", public\."PlatformConfig"[\s\S]*IN SHARE ROW EXCLUSIVE MODE/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migration, /WHERE tenant\."slug" LIKE 'legacy-company-%'[\s\S]*FOR UPDATE/);
  assert.match(migration, /legacy-import\.credit-provenance\.v1\.' \|\| tenant\."id"/);
  assert.match(migration, /candidate\.wallet_balance = candidate\.ledger_balance \+ 1000[\s\S]*candidate\.ledger_balance >= 0/);
  assert.match(migration, /candidate\.ledger_balance BETWEEN -1000 AND -1/);
  assert.match(migration, /candidate\.ledger_debit_row_count = candidate\.ledger_row_count/);
  assert.match(migration, /SET "usageCredits" = reconciled_wallet_balance/);
  assert.match(migration, /legacy-unbacked-1000-consumed-reconciled/);
  assert.match(migration, /'consumedCreditValue', -candidate\.ledger_balance/);
  assert.match(migration, /'removedUnspentCredits', candidate\.wallet_balance/);
  assert.match(migration, /reconciled_wallet_balance := candidate\.ledger_balance::INTEGER/);
  assert.doesNotMatch(migration, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\."CreditTransaction"/i);
  const grantBody = metering.slice(
    metering.indexOf('async grantCreditsInTransaction'),
    metering.indexOf('async recordFeatureUsageInTransaction'),
  );
  const tenantTableLock = grantBody.indexOf('await this.lockCreditSettlementTables(tx)');
  const tenantRowLock = grantBody.indexOf('SELECT "id" FROM "Tenant"');
  const ledgerInsert = grantBody.indexOf('tx.creditTransaction.create');
  assert.match(metering, /LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE/);
  assert.ok(tenantTableLock >= 0 && tenantTableLock < tenantRowLock && tenantRowLock < ledgerInsert);
});

test('legacy cleanup rescans every pass and fails closed on malformed provenance or ambiguous histories', () => {
  assert.match(migration, /candidate\.import_provenance IS NOT NULL[\s\S]*zero-wallet-no-ledger/);
  assert.match(migration, /malformed fixed-import credit provenance/);
  assert.match(migration, /legacy-unbacked-1000-reconciled/);
  assert.match(migration, /malformed consumed-credit reconciliation provenance/);
  assert.match(migration, /candidate\.wallet_balance IS DISTINCT FROM candidate\.ledger_balance \+ provenance_consumed_credits/);
  assert.match(migration, /per-tenant credit provenance has an imbalanced wallet/);
  assert.match(migration, /ledger_row_count = 0 AND candidate\.wallet_balance = 0[\s\S]*ambiguous fully consumed or manually cleared/);
  assert.match(migration, /ambiguous or consumed credit history[\s\S]*manual reconciliation is required/);
  assert.doesNotMatch(migration, /migration\.legacy-unbacked-1000-credit-cleanup\.v1/);
  assert.doesNotMatch(migration, /\bRETURN;/);
  assert.match(migration, /INSERT INTO public\."PlatformConfig"[\s\S]*legacy-import\.credit-provenance\.v1\.' \|\| candidate\.tenant_id/);
});

test('legacy cleanup has one exact digest-bound expand-contract approval', () => {
  const policy = JSON.parse(read('scripts/raw-migration-rollback-policy.json'));
  const digest = createHash('sha256').update(migration).digest('hex');

  assert.equal(policy.migrations[migrationPath], undefined);
  assert.deepEqual(policy.expandContract[migrationPath], {
    sha256: digest,
    phase: 'expand-contract',
    rollbackSchema: 'retain',
    contractPhase: 'compatibility-proven-inline',
    requiresOldReleaseProof: true,
    rationale: 'the locked repeatable legacy wallet reconciliation and per-tenant import/reconciliation provenance remain during rollback; isolated old-release proof is required before production mutation.',
  });
});
