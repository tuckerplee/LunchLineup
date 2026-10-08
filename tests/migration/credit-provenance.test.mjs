import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildLegacyImportPlan, ROLE_PLAN_SHA256, DEFAULT_LIMITS, PERMISSIONS } from '../../scripts/legacy-import-plan.mjs';
import { executeLegacyImport } from '../../scripts/legacy-import-executor.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

test('legacy tenant imports create no implicit usage-credit grant', async () => {
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const generation = '11111111-1111-4111-8111-111111111111';
  const source = Buffer.from(JSON.stringify({ companies: [{ id: 1, name: 'Credit Fixture' }], stores: [], users: [], staff: [], user_company_roles: [], user_store_roles: [] }));
  const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, namespace: 'credit-fixture', targetGenerationId: generation, sourceSha256: sha(source), adapterVersion: 'legacy-combined-v1', rolePlanSha256: ROLE_PLAN_SHA256, timezone: 'America/Los_Angeles', companySlugs: { 1: 'legacy-company-1' }, limits: DEFAULT_LIMITS }));
  const plan = buildLegacyImportPlan(source, descriptor, { expectedSourceSha256: sha(source), expectedDescriptorSha256: sha(descriptor) });
  let state = { run: null, company: null, tenant: null, provenance: [], roles: [] };
  // Closed company-only transaction adapter. No credit-ledger delegate exists;
  // an attempted implicit grant fails the actual executor call. Native SQL,
  // RLS and lock behavior are outside this local contract test.
  const db = { async $transaction(operation, options) {
    assert.equal(options.isolationLevel, 'ReadCommitted'); const draft = structuredClone(state);
    const tx = {
      async $executeRaw(parts, ...args) {
        const sql = parts.join('?');
        if (sql === "SELECT pg_catalog.set_config('statement_timeout', ?, true), pg_catalog.set_config('lock_timeout', ?, true)") { assert.deepEqual(args, [String(options.timeout), String(options.maxWait)]); return 1; }
        if (sql === 'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))') { assert.deepEqual(JSON.parse(args[0]), ['legacy-import-namespace-v1', plan.namespace]); return 1; }
        if (sql === 'SELECT public.lock_tenant_lifecycle(?)') { assert.deepEqual(args, ['credit-tenant']); return 1; }
        if (sql === 'INSERT INTO legacy_import.company (namespace, company_id, target_tenant_id, source_row_sha256, bootstrap_role_ids) VALUES (?, ?::bigint, ?, ?, ?::jsonb)') { draft.company = { namespace: args[0], company_id: BigInt(args[1]), target_tenant_id: args[2], source_row_sha256: args[3], bootstrap_role_ids: JSON.parse(args[4]) }; return 1; }
        if (sql === "UPDATE legacy_import.run SET status = 'COMPLETE', completed_at = pg_catalog.clock_timestamp() WHERE namespace = ? AND status = 'INITIALIZED'") { assert.deepEqual(args, [plan.namespace]); draft.run.status = 'COMPLETE'; return 1; }
        assert.fail(`unsupported credit fixture statement: ${sql}`);
      },
      async $queryRaw(parts, ...args) {
        const sql = parts.join('?');
        if (sql === 'SELECT generation_uuid FROM legacy_import.target_generation WHERE singleton = TRUE') return [{ generation_uuid: generation }];
        if (sql === 'SELECT * FROM legacy_import.run WHERE namespace = ? FOR UPDATE') { assert.deepEqual(args, [plan.namespace]); return draft.run ? [structuredClone(draft.run)] : []; }
        if (sql === "INSERT INTO legacy_import.run (namespace, generation_uuid, source_sha256, adapter_version, role_plan_sha256, approval_plan_sha256, expected_company_count, expected_location_count, expected_user_count, expected_staff_count, status) VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, 'INITIALIZED') RETURNING *") { draft.run = { namespace: args[0], generation_uuid: args[1], source_sha256: args[2], adapter_version: args[3], role_plan_sha256: args[4], approval_plan_sha256: args[5], expected_company_count: args[6], expected_location_count: args[7], expected_user_count: args[8], expected_staff_count: args[9], status: 'INITIALIZED' }; return [structuredClone(draft.run)]; }
        if (sql === 'SELECT * FROM legacy_import.company WHERE namespace = ? AND company_id = ?::bigint FOR UPDATE') { assert.deepEqual(args, [plan.namespace, '1']); return draft.company ? [structuredClone(draft.company)] : []; }
        if (sql === 'SELECT "id" FROM public."Tenant" WHERE "id" = ? FOR UPDATE') { assert.deepEqual(args, ['credit-tenant']); return [{ id: 'credit-tenant' }]; }
        if (sql === 'SELECT company_id FROM legacy_import.company WHERE namespace = ?') return [{ company_id: 1n }];
        if (sql === 'SELECT company_id, source_type, legacy_id FROM legacy_import.entity WHERE namespace = ?') return [];
        assert.fail(`unsupported credit fixture query: ${sql}`);
      },
      tenant: {
        async findUnique({ where }) { return where.slug ? null : structuredClone(draft.tenant); },
        async create({ data }) { assert.equal(data.usageCredits, 0); draft.tenant = { id: 'credit-tenant', deletedAt: null, applicationDataPurgedAt: null, ...structuredClone(data) }; return structuredClone(draft.tenant); },
      },
      platformConfig: { async create({ data }) { draft.provenance.push(structuredClone(data)); return structuredClone(data); } },
      permission: { async findMany() { return PERMISSIONS.map(([key], index) => ({ id: `permission-${index}`, key })); } },
      role: { async create({ data }) { const row = { id: `role-${draft.roles.length}`, ...structuredClone(data) }; draft.roles.push(row); return structuredClone(row); } },
      rolePermission: { async createMany({ data }) { return { count: data.length }; } },
    };
    const result = await operation(tx); state = draft; return result;
  } };
  await executeLegacyImport(plan, { db });
  assert.equal(state.run.status, 'COMPLETE'); assert.equal(state.tenant.usageCredits, 0);
  assert.equal(state.provenance.length, 1);
  assert.deepEqual(state.provenance[0].value, { version: 1, tenantId: 'credit-tenant', sourceSha256: sha(source), initialCreditPolicy: 'zero-wallet-no-ledger', initialCreditGrant: 0 });
  const before = structuredClone(state); await executeLegacyImport(plan, { db });
  assert.deepEqual(state, before, 'retry does not replenish wallet or issue provenance twice');
});

test('schedule refund migration fails closed on debit drift and refunds from the ledger row once', () => {
  const migration = read('packages/db/prisma/migrations/20260709_yyyyyy_schedule_solve_credit_refund_provenance_guard.sql');

  assert.match(migration, /LOCK TABLE "Tenant"[\s\S]*LOCK TABLE "ScheduleSolveJob"[\s\S]*LOCK TABLE "CreditTransaction"/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migration, /COUNT\(\*\)::integer AS "rowCount"/);
  assert.match(migration, /debit\."rowCount" <> 1/);
  assert.match(migration, /debit\."tenantId" IS DISTINCT FROM job\."tenantId"/);
  assert.match(migration, /debit\."amount" IS DISTINCT FROM -configured\."amount"/);
  assert.match(migration, /RAISE EXCEPTION 'Schedule solve credit refund provenance is missing, mismatched, or duplicated'/);
  assert.match(migration, /'schedule-credit-' \|\| job\."id"/);
  assert.match(migration, /'schedule-credit-refund-' \|\| candidate\."jobId"/);
  assert.match(migration, /-candidate\."debitAmount"/);
  assert.doesNotMatch(migration, /SELECT[\s\S]{0,180}\("creditConsumption"->>'consumedCredits'\)::integer,[\s\S]{0,80}'Schedule generation refund/);
  assert.match(migration, /ON CONFLICT \("id"\) DO NOTHING[\s\S]*RETURNING "tenantId", "amount"/);
  assert.match(migration, /FROM inserted_refunds[\s\S]*GROUP BY "tenantId"/);
  assert.ok(
    '20260709_yyyyyy_schedule_solve_credit_refund_provenance_guard.sql'
      .localeCompare('20260709_zzzzzz_schedule_solve_credit_refunds.sql') < 0,
    'the exact-provenance settlement must run before the retained historical backfill',
  );
});
