import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildLegacyImportPlan,
  ROLE_PLAN_SHA256,
  ROLE_DEFINITIONS,
  PERMISSIONS,
  DEFAULT_LIMITS,
} from '../../scripts/legacy-import-plan.mjs';
import { executeLegacyImport, readLegacyImportReport } from '../../scripts/legacy-import-executor.mjs';
import { publishLegacyImportReport, legacyImportReportCsv, REPORT_MAX_BYTES, REPORT_MAX_ROWS, REPORT_MAX_CELL_BYTES } from '../../scripts/legacy-import-report.mjs';
import { main as importerMain } from '../../scripts/import-legacy-users.mjs';

// These tests execute the real pure planner and executor against an explicit,
// closed adapter. The adapter stages writes until commit, records attempts
// separately, and models selectors; it does not model PostgreSQL locks/RLS/FKs.
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value) => Buffer.from(JSON.stringify(value));
const clone = (value) => structuredClone(value);
const generation = '11111111-1111-4111-8111-111111111111';
const legacyPassword = `$2b$12$${'a'.repeat(53)}`;

function sourceFixture() {
  return {
    companies: [{ id: 1, name: 'Company One' }],
    stores: [{ id: 9, company_id: 1, name: 'Location One', location: 'Address One' }],
    users: [{ id: 7, company_id: 1, username_plain: 'Alice', name_plain: 'Alice Example', password_hash: legacyPassword }],
    staff: [{ id: 7, company_id: 1, name_plain: 'Bob Example', is_admin: 0 }],
    user_company_roles: [{ user_id: 7, company_id: 1, role: 'super_admin' }],
    user_store_roles: [{ user_id: 7, store_id: 9, role: 'store' }],
  };
}

function input(source = sourceFixture(), patch = {}) {
  const sourceBytes = bytes(source);
  const descriptor = {
    schemaVersion: 1,
    namespace: 'fixture-import-v1',
    targetGenerationId: generation,
    sourceSha256: sha(sourceBytes),
    adapterVersion: 'legacy-combined-v1',
    rolePlanSha256: ROLE_PLAN_SHA256,
    timezone: 'America/Los_Angeles',
    companySlugs: { 1: 'legacy-company-1' },
    limits: clone(DEFAULT_LIMITS),
    ...patch,
  };
  const descriptorBytes = bytes(descriptor);
  return { sourceBytes, descriptorBytes, approval: { expectedDescriptorSha256: sha(descriptorBytes), expectedSourceSha256: sha(sourceBytes) } };
}

function plan(source, patch) {
  const x = input(source, patch);
  return buildLegacyImportPlan(x.sourceBytes, x.descriptorBytes, x.approval);
}

test('approved planner preserves distinct user and staff identities and downgrades customer super admin', () => {
  const result = plan();
  assert.deepEqual(result.counts, { company: 1, location: 1, user: 1, staff: 1 });
  assert.deepEqual(result.accounts.map((x) => [x.sourceType, x.id, x.role]), [['user', '7', 'ADMIN'], ['staff', '7', 'STAFF']]);
  assert.equal(result.accounts[0].note, 'legacy_super_admin_downgraded_to_tenant_admin');
  assert.equal(result.accounts[0].passwordHash, legacyPassword);
  assert.equal(result.accounts[1].passwordHash, null);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.accounts) && Object.isFrozen(result.accounts[0]));
  assert.equal(result.generationUuid, generation);
  assert.match(result.approvalPlanSha256, /^[a-f0-9]{64}$/);
  assert.equal(ROLE_DEFINITIONS.find((x) => x.slug === 'admin').permissions.includes('admin_portal:access'), false);
  assert.equal(ROLE_DEFINITIONS.find((x) => x.slug === 'staff').permissions.includes('lunch_breaks:write'), false);
});

test('external approval hashes reject source or descriptor replacement before executor access', () => {
  const x = input();
  for (const approval of [{}, { ...x.approval, expectedSourceSha256: '0'.repeat(64) }, { ...x.approval, expectedDescriptorSha256: '0'.repeat(64) }]) {
    assert.throws(() => buildLegacyImportPlan(x.sourceBytes, x.descriptorBytes, approval));
  }
  const changedSource = sourceFixture(); changedSource.users[0].name_plain = 'changed';
  assert.throws(() => buildLegacyImportPlan(bytes(changedSource), x.descriptorBytes, x.approval));
  const changedDescriptor = JSON.parse(x.descriptorBytes); changedDescriptor.namespace = 'changed-import';
  assert.throws(() => buildLegacyImportPlan(x.sourceBytes, bytes(changedDescriptor), x.approval));
});

for (const [label, id] of [['zero', 0], ['negative', -1], ['fraction', 1.5], ['unsafe number', Number.MAX_SAFE_INTEGER + 1], ['overflow', '4294967296'], ['leading zero', '01'], ['signed', '+1'], ['exponent', '1e3'], ['space', ' 1'], ['boolean', true], ['null', null]]) {
  test(`planner rejects ${label} legacy identity before any database call`, () => {
    const source = sourceFixture(); source.users[0].id = id;
    assert.throws(() => plan(source));
  });
}

test('planner canonicalizes valid numeric and decimal identities without cross-type collisions', () => {
  const source = sourceFixture();
  source.companies[0].id = '1'; source.users[0].id = '7'; source.staff[0].id = '7';
  const result = plan(source);
  assert.deepEqual(result.accounts.map((x) => [x.sourceType, x.id]), [['user', '7'], ['staff', '7']]);
});

for (const [label, mutate] of [
  ['duplicate canonical user identity', (s) => s.users.push({ ...s.users[0], id: '7' })],
  ['missing account company', (s) => { s.users[0].company_id = 88; }],
  ['missing store company', (s) => { s.stores[0].company_id = 88; }],
  ['missing role user', (s) => { s.user_company_roles[0].user_id = 88; }],
  ['wrong role company', (s) => { s.user_company_roles[0].company_id = 88; }],
  ['missing role store', (s) => { s.user_store_roles[0].store_id = 88; }],
  ['conflicting username aliases', (s) => { s.users[0].username = 'different'; }],
  ['conflicting password aliases', (s) => { s.users[0].passwordHash = 'different'; }],
  ['non-array source collection', (s) => { s.staff = {}; }],
]) {
  test(`planner rejects ${label} as complete preflight`, () => {
    const source = sourceFixture(); mutate(source);
    assert.throws(() => plan(source));
  });
}

for (const [label, patch] of [
  ['changed role digest', { rolePlanSha256: '0'.repeat(64) }],
  ['unknown adapter', { adapterVersion: 'future-adapter' }],
  ['unsafe namespace', { namespace: '../other' }],
  ['invalid target generation', { targetGenerationId: 'not-a-uuid' }],
  ['incomplete slug approval', { companySlugs: {} }],
]) {
  test(`planner rejects ${label} even with fresh descriptor byte approval`, () => assert.throws(() => plan(undefined, patch)));
}

test('approval identity preserves exact source bytes and selected namespace deterministically', () => {
  const first = plan(); const second = plan();
  assert.equal(first.approvalPlanSha256, second.approvalPlanSha256);
  assert.deepEqual(first.accounts, second.accounts);
  assert.notEqual(first.approvalPlanSha256, plan(undefined, { namespace: 'another-approved-import' }).approvalPlanSha256);
});

test('planner admits maximum UINT32 as a string and rejects cross-company associations without partial planning', () => {
  const source = sourceFixture();
  source.staff[0].id = '4294967295';
  assert.equal(plan(source).accounts[1].id, '4294967295');
  source.companies.push({ id: 2, name: 'Other Company' });
  source.user_company_roles[0].company_id = 2;
  assert.throws(() => plan(source, { companySlugs: { 1: 'legacy-company-1', 2: 'legacy-company-2' } }), /crosses company/);
});

for (const [label, change] of [
  ['total rows', (d) => { d.maxTotalRows = 1; }],
  ['input bytes', (d) => { d.maxBytes = 1; }],
  ['field length', (d) => { d.maxStringLength = 2; }],
  ['expanded timeout', (d) => { d.transactionTimeoutMs = DEFAULT_LIMITS.transactionTimeoutMs + 1; }],
  ['missing limit', (d) => { delete d.maxDurationMs; }],
  ['fractional limit', (d) => { d.maxRowsPerArray = 1.5; }],
]) {
  test(`planner enforces admitted ${label} bound before database access`, () => {
    const limits = clone(DEFAULT_LIMITS); change(limits);
    assert.throws(() => plan(undefined, { limits }));
  });
}

test('planner rejects unsupported password hashes, duplicate role associations, and incomplete combined exports', () => {
  const badPassword = sourceFixture(); badPassword.users[0].password_hash = 'plaintext-secret';
  assert.throws(() => plan(badPassword), /password hash/);
  const duplicate = sourceFixture(); duplicate.user_company_roles.push(clone(duplicate.user_company_roles[0]));
  assert.throws(() => plan(duplicate), /duplicate role/);
  const incomplete = sourceFixture(); delete incomplete.staff;
  assert.throws(() => plan(incomplete), /combined export/);
});

for (const [prefix, cost] of [['2a', '04'], ['2b', '12'], ['2y', '14']]) {
  test(`planner preserves admitted bcrypt ${prefix} cost ${cost} without executing a KDF`, () => {
    const source = sourceFixture(); source.users[0].password_hash = `$${prefix}$${cost}$${'a'.repeat(53)}`;
    assert.equal(plan(source).accounts[0].passwordHash, source.users[0].password_hash);
  });
}
for (const hash of ['$argon2id$v=19$m=65536,t=3,p=4$abc$xyz', ...['00', '03', '15', '31'].map((cost) => `$2b$${cost}$${'a'.repeat(53)}`)]) {
  test(`planner refuses unsupported credential format or cost ${hash.slice(0, 7)}`, () => {
    const source = sourceFixture(); source.users[0].password_hash = hash;
    assert.throws(() => plan(source), /password/);
  });
}
test('approved timezone controls location planning and invalid zones or unapproved changes fail closed', () => {
  const alternate = plan(undefined, { timezone: 'Europe/London' });
  assert.equal(alternate.timezone, 'Europe/London');
  assert.equal(alternate.locations[0].timezone, 'Europe/London');
  assert.throws(() => plan(undefined, { timezone: 'Invalid/Timezone' }));
  const x = input(); const changed = JSON.parse(x.descriptorBytes); changed.timezone = 'Europe/London';
  assert.throws(() => buildLegacyImportPlan(x.sourceBytes, bytes(changed), x.approval), /approval/);
});

const SQL = {
  configure: "SELECT pg_catalog.set_config('statement_timeout', ?, true), pg_catalog.set_config('lock_timeout', ?, true)",
  namespace: 'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))',
  generation: 'SELECT generation_uuid FROM legacy_import.target_generation WHERE singleton = TRUE',
  run: 'SELECT * FROM legacy_import.run WHERE namespace = ? FOR UPDATE',
  insertRun: "INSERT INTO legacy_import.run (namespace, generation_uuid, source_sha256, adapter_version, role_plan_sha256, approval_plan_sha256, expected_company_count, expected_location_count, expected_user_count, expected_staff_count, status) VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, 'INITIALIZED') RETURNING *",
  company: 'SELECT * FROM legacy_import.company WHERE namespace = ? AND company_id = ?::bigint FOR UPDATE',
  lifecycle: 'SELECT public.lock_tenant_lifecycle(?)',
  tenant: 'SELECT "id" FROM public."Tenant" WHERE "id" = ? FOR UPDATE',
  entity: 'SELECT * FROM legacy_import.entity WHERE namespace = ? AND company_id = ?::bigint AND source_type = ? AND legacy_id = ?::bigint FOR UPDATE',
  companies: 'SELECT company_id FROM legacy_import.company WHERE namespace = ?',
  entities: 'SELECT company_id, source_type, legacy_id FROM legacy_import.entity WHERE namespace = ?',
  insertCompany: 'INSERT INTO legacy_import.company (namespace, company_id, target_tenant_id, source_row_sha256, bootstrap_role_ids) VALUES (?, ?::bigint, ?, ?, ?::jsonb)',
  insertEntity: 'INSERT INTO legacy_import.entity (namespace, company_id, source_type, legacy_id, target_id, target_tenant_id, initial_role_id, source_row_sha256) VALUES (?, ?::bigint, ?, ?::bigint, ?, ?, ?, ?)',
  roleLocks: 'SELECT "id" FROM public."Role" WHERE "tenantId" = ? AND "id" = ANY(?::text[]) ORDER BY "id" FOR UPDATE',
  grantLocks: 'SELECT "roleId", "permissionId" FROM public."RolePermission" WHERE "roleId" = ANY(?::text[]) ORDER BY "roleId", "permissionId" FOR UPDATE',
  permissionLocks: 'SELECT "id" FROM public."Permission" WHERE "id" IN (SELECT "permissionId" FROM public."RolePermission" WHERE "roleId" = ANY(?::text[])) ORDER BY "id" FOR UPDATE',
  complete: "UPDATE legacy_import.run SET status = 'COMPLETE', completed_at = pg_catalog.clock_timestamp() WHERE namespace = ? AND status = 'INITIALIZED'",
};

function stagedDatabase({ failAfter = Infinity, loseAcknowledgementAfter = Infinity, afterRead = async () => {} } = {}) {
  let state = { sequence: 0, generationRows: [{ generation_uuid: generation }], runs: [], companies: [], entities: [], tenants: [], locations: [], users: [], sessions: [], permissions: [], roles: [], rolePermissions: [], assignments: [], provenance: [] };
  const attempts = []; const committed = []; const reads = []; const transactions = [];
  let txNumber = 0; let effectNumber = 0;
  let failedStart; let active = false;
  const db = {
    async $transaction(operation, options) {
      assert.equal(active, false, 'fixture forbids nested transactions');
      assert.deepEqual(Object.keys(options).sort(), ['isolationLevel', 'maxWait', 'timeout']);
      assert.equal(options.isolationLevel, 'ReadCommitted');
      assert.ok(options.maxWait > 0 && options.timeout > 0);
      const draft = clone(state); const start = clone(state); const tx = ++txNumber; const effects = [];
      const id = (kind) => `${kind}-${++draft.sequence}`;
      const effect = (name, data, apply) => {
        const entry = { tx, ordinal: ++effectNumber, name, data: clone(data) };
        attempts.push(entry); effects.push(entry); apply();
        if (effectNumber === failAfter) throw new Error(`synthetic precommit failure after ${name}`);
      };
      const read = (name, args) => reads.push({ tx, name, args: clone(args) });
      function project(row, select) {
        if (!row) return null;
        if (!select) return clone(row);
        assert.ok(Object.values(select).every((x) => x === true));
        return Object.fromEntries(Object.keys(select).map((key) => [key, clone(row[key])]));
      }
      const owner = {
        async $queryRaw(parts, ...args) {
          const sql = parts.join('?'); read(sql, args);
          await afterRead(sql, clone(args), tx);
          if (sql === SQL.generation) { assert.equal(args.length, 0); return clone(draft.generationRows); }
          if (sql === SQL.run) { assert.equal(args.length, 1); return clone(draft.runs.filter((x) => x.namespace === args[0])); }
          if (sql === SQL.insertRun) {
            assert.equal(args.length, 10); assert.ok(!draft.runs.some((x) => x.namespace === args[0]));
            const row = { namespace: args[0], generation_uuid: args[1], source_sha256: args[2], adapter_version: args[3], role_plan_sha256: args[4], approval_plan_sha256: args[5], expected_company_count: args[6], expected_location_count: args[7], expected_user_count: args[8], expected_staff_count: args[9], status: 'INITIALIZED', completed_at: null };
            effect('run.insert', row, () => draft.runs.push(row)); return [clone(row)];
          }
          if (sql === SQL.company) { assert.equal(args.length, 2); assert.match(args[1], /^[1-9][0-9]*$/); return clone(draft.companies.filter((x) => x.namespace === args[0] && String(x.company_id) === args[1])); }
          if (sql === SQL.tenant) { assert.equal(args.length, 1); assert.equal(typeof args[0], 'string'); return draft.tenants.some((x) => x.id === args[0]) ? [{ id: args[0] }] : []; }
          if (sql === SQL.roleLocks) { assert.equal(args.length, 2); assert.equal(typeof args[0], 'string'); assert.deepEqual(args[1], [...args[1]].sort()); return draft.roles.filter((x) => x.tenantId === args[0] && args[1].includes(x.id)).map((x) => ({ id: x.id })); }
          if (sql === SQL.grantLocks || sql === SQL.permissionLocks) { assert.equal(args.length, 1); assert.deepEqual(args[0], [...args[0]].sort()); const grants = draft.rolePermissions.filter((x) => args[0].includes(x.roleId)); return sql === SQL.grantLocks ? clone(grants) : draft.permissions.filter((x) => grants.some((g) => g.permissionId === x.id)).map((x) => ({ id: x.id })); }
          if (sql === SQL.entity) { assert.equal(args.length, 4); assert.ok(['location', 'user', 'staff'].includes(args[2])); assert.match(args[1], /^[1-9][0-9]*$/); assert.match(args[3], /^[1-9][0-9]*$/); return clone(draft.entities.filter((x) => x.namespace === args[0] && String(x.company_id) === args[1] && x.source_type === args[2] && String(x.legacy_id) === args[3])); }
          if (sql === SQL.companies) { assert.equal(args.length, 1); return draft.companies.filter((x) => x.namespace === args[0]).map((x) => ({ company_id: x.company_id })); }
          if (sql === SQL.entities) { assert.equal(args.length, 1); return draft.entities.filter((x) => x.namespace === args[0]).map((x) => ({ company_id: x.company_id, source_type: x.source_type, legacy_id: x.legacy_id })); }
          assert.fail(`unsupported fixture query: ${sql}`);
        },
        async $executeRaw(parts, ...args) {
          const sql = parts.join('?'); read(sql, args);
          await afterRead(sql, clone(args), tx);
          if (sql === SQL.configure) { assert.deepEqual(args, [String(options.timeout), String(options.maxWait)]); return 1; }
          if (sql === SQL.namespace) { assert.equal(args.length, 1); const identity = JSON.parse(args[0]); assert.equal(identity.length, 2); assert.equal(identity[0], 'legacy-import-namespace-v1'); assert.equal(typeof identity[1], 'string'); return 1; }
          if (sql === SQL.lifecycle) { assert.equal(args.length, 1); assert.equal(typeof args[0], 'string'); return 1; }
          if (sql === SQL.insertCompany) {
            assert.equal(args.length, 5); const row = { namespace: args[0], company_id: BigInt(args[1]), target_tenant_id: args[2], source_row_sha256: args[3], bootstrap_role_ids: JSON.parse(args[4]) };
            assert.ok(draft.tenants.some((x) => x.id === row.target_tenant_id));
            assert.ok(!draft.companies.some((x) => x.namespace === row.namespace && x.company_id === row.company_id));
            effect('company.receipt', row, () => draft.companies.push(row)); return 1;
          }
          if (sql === SQL.insertEntity) {
            assert.equal(args.length, 8); const row = { namespace: args[0], company_id: BigInt(args[1]), source_type: args[2], legacy_id: BigInt(args[3]), target_kind: args[2] === 'location' ? 'location' : 'account', target_id: args[4], target_tenant_id: args[5], initial_role_id: args[6], source_row_sha256: args[7] };
            assert.ok(draft.companies.some((x) => x.namespace === row.namespace && x.company_id === row.company_id && x.target_tenant_id === row.target_tenant_id));
            assert.ok(!draft.entities.some((x) => x.namespace === row.namespace && x.company_id === row.company_id && x.source_type === row.source_type && x.legacy_id === row.legacy_id));
            const targets = row.target_kind === 'location' ? draft.locations : draft.users;
            assert.ok(targets.some((x) => x.id === row.target_id && x.tenantId === row.target_tenant_id));
            assert.equal(row.initial_role_id === null, row.source_type === 'location');
            effect(`entity.receipt.${row.source_type}`, row, () => draft.entities.push(row)); return 1;
          }
          if (sql === SQL.complete) {
            assert.equal(args.length, 1); const run = draft.runs.find((x) => x.namespace === args[0] && x.status === 'INITIALIZED'); assert.ok(run);
            const count = (type) => draft.entities.filter((x) => x.namespace === run.namespace && x.source_type === type).length;
            assert.equal(draft.companies.filter((x) => x.namespace === run.namespace).length, run.expected_company_count);
            assert.equal(count('location'), run.expected_location_count); assert.equal(count('user'), run.expected_user_count); assert.equal(count('staff'), run.expected_staff_count);
            effect('run.complete', { namespace: run.namespace }, () => { run.status = 'COMPLETE'; run.completed_at = new Date('2030-01-01T00:00:00Z'); }); return 1;
          }
          assert.fail(`unsupported fixture execute: ${sql}`);
        },
        tenant: {
          async findUnique({ where }) { assert.equal(Object.keys(where).length, 1); assert.ok('id' in where || 'slug' in where); read('tenant.findUnique', where); return project(draft.tenants.find((x) => Object.entries(where).every(([k, v]) => x[k] === v))); },
          async create({ data }) { assert.deepEqual(Object.keys(data).sort(), ['name', 'planTier', 'slug', 'status', 'usageCredits']); assert.equal(data.usageCredits, 0); assert.ok(!draft.tenants.some((x) => x.slug === data.slug)); const row = { id: id('tenant'), deletedAt: null, applicationDataPurgedAt: null, ...clone(data) }; effect('tenant.create', data, () => draft.tenants.push(row)); return clone(row); },
        },
        platformConfig: {
          async create({ data }) { assert.deepEqual(Object.keys(data).sort(), ['id', 'key', 'updatedBy', 'value']); assert.equal(data.value.initialCreditGrant, 0); assert.equal(data.value.initialCreditPolicy, 'zero-wallet-no-ledger'); assert.equal(data.value.version, 1); const row = clone(data); effect('credit.provenance', data, () => draft.provenance.push(row)); return clone(row); },
        },
        permission: {
          async findMany({ where, select }) { assert.deepEqual(select, { id: true, key: true }); assert.deepEqual(Object.keys(where), ['key']); assert.deepEqual(where.key.in, PERMISSIONS.map(([key]) => key)); read('permission.findMany', where); return draft.permissions.filter((x) => where.key.in.includes(x.key)).map((x) => project(x, select)); },
          async createMany({ data, skipDuplicates }) { assert.equal(skipDuplicates, true); for (const row of data) assert.deepEqual(Object.keys(row).sort(), ['category', 'description', 'key', 'label']); effect('permission.createMany', data, () => { for (const row of data) if (!draft.permissions.some((x) => x.key === row.key)) draft.permissions.push({ id: id('permission'), ...clone(row) }); }); return { count: data.length }; },
        },
        role: {
          async create({ data }) { assert.deepEqual(Object.keys(data).sort(), ['isDefault', 'isSystem', 'legacyRole', 'name', 'slug', 'tenantId']); const row = { id: id('role'), deletedAt: null, ...clone(data) }; effect('role.create', data, () => draft.roles.push(row)); return clone(row); },
          async findMany({ where, include }) { assert.deepEqual(include, { rolePermissions: { include: { permission: true } } }); assert.deepEqual(Object.keys(where).sort(), ['id', 'tenantId']); assert.ok(Array.isArray(where.id.in)); read('role.findMany', where); return draft.roles.filter((x) => x.tenantId === where.tenantId && where.id.in.includes(x.id)).map((x) => ({ ...clone(x), rolePermissions: draft.rolePermissions.filter((grant) => grant.roleId === x.id).map((grant) => ({ ...clone(grant), permission: clone(draft.permissions.find((p) => p.id === grant.permissionId)) })) })); },
        },
        rolePermission: {
          async createMany({ data }) { for (const row of data) { assert.deepEqual(Object.keys(row).sort(), ['permissionId', 'roleId']); assert.ok(draft.roles.some((x) => x.id === row.roleId)); assert.ok(draft.permissions.some((x) => x.id === row.permissionId)); } effect('role.grants', data, () => draft.rolePermissions.push(...clone(data))); return { count: data.length }; },
        },
        location: {
          async findUnique({ where }) { assert.deepEqual(Object.keys(where), ['id']); read('location.findUnique', where); return project(draft.locations.find((x) => x.id === where.id)); },
          async create({ data }) { assert.deepEqual(Object.keys(data).sort(), ['address', 'name', 'tenantId', 'timezone']); const row = { id: id('location'), deletedAt: null, ...clone(data) }; effect('location.create', data, () => draft.locations.push(row)); return clone(row); },
        },
        user: {
          async findUnique({ where }) { assert.deepEqual(Object.keys(where), ['id']); read('user.findUnique', where); return project(draft.users.find((x) => x.id === where.id)); },
          async findFirst({ where, select }) { assert.deepEqual(Object.keys(where).sort(), ['tenantId', 'username']); assert.deepEqual(select, { id: true }); read('user.findFirst', where); return project(draft.users.find((x) => x.tenantId === where.tenantId && x.username === where.username), select); },
          async create({ data }) { assert.deepEqual(Object.keys(data).sort(), ['email', 'name', 'passwordHash', 'pinResetRequired', 'role', 'tenantId', 'username']); assert.equal(data.pinResetRequired, false); assert.ok(!draft.users.some((x) => x.tenantId === data.tenantId && x.username === data.username)); const row = { id: id('user'), deletedAt: null, pinHash: null, pinSetAt: null, pinLoginAttempts: 0, pinLockedUntil: null, ...clone(data) }; effect('user.create', data, () => draft.users.push(row)); return clone(row); },
        },
        roleAssignment: {
          async create({ data }) { assert.deepEqual(Object.keys(data).sort(), ['roleId', 'tenantId', 'userId']); assert.ok(draft.users.some((x) => x.id === data.userId && x.tenantId === data.tenantId)); assert.ok(draft.roles.some((x) => x.id === data.roleId && x.tenantId === data.tenantId)); const row = { id: id('assignment'), ...clone(data) }; effect('role.assignment', data, () => draft.assignments.push(row)); return clone(row); },
        },
      };
      active = true;
      try {
        const result = await operation(owner);
        state = draft; committed.push(...clone(effects)); transactions.push({ tx, status: 'committed', effects: effects.length });
        if (tx === loseAcknowledgementAfter) throw new Error('synthetic lost acknowledgement after committed transaction');
        return result;
      } catch (error) {
        if (!transactions.some((x) => x.tx === tx)) { failedStart = start; transactions.push({ tx, status: 'rolled-back', effects: effects.length }); }
        throw error;
      } finally { active = false; }
    },
  };
  return {
    db, attempts, committed, reads, transactions,
    snapshot: () => clone(state),
    mutate: (change) => change(state),
    failedStart: () => clone(failedStart),
    clearFailure: () => { failAfter = Infinity; loseAcknowledgementAfter = Infinity; },
  };
}

function assertImportedCardinality(state) {
  assert.deepEqual({ tenants: state.tenants.length, locations: state.locations.length, users: state.users.length, assignments: state.assignments.length, companies: state.companies.length, entities: state.entities.length, provenance: state.provenance.length }, { tenants: 1, locations: 1, users: 2, assignments: 2, companies: 1, entities: 3, provenance: 1 });
  assert.equal(state.runs.length, 1); assert.equal(state.runs[0].status, 'COMPLETE');
  assert.deepEqual(state.entities.map((x) => [x.source_type, x.legacy_id]), [['location', 9n], ['user', 7n], ['staff', 7n]]);
  assert.notEqual(state.entities[1].target_id, state.entities[2].target_id);
  assert.equal(state.tenants[0].usageCredits, 0);
}

test('two importer invocations preserve account edits and exact entity cardinality', async () => {
  const fixture = stagedDatabase(); const admitted = plan();
  const firstReport = await executeLegacyImport(admitted, { db: fixture.db });
  assertImportedCardinality(fixture.snapshot());
  assert.deepEqual(firstReport.counts, { company: 1, location: 1, user: 1, staff: 1 });
  assert.equal(firstReport.rows.length, 3);
  assert.deepEqual(firstReport.rows.map((x) => [x.sourceType, x.currentPasswordCredentialPresent]), [['location', false], ['user', true], ['staff', false]]);
  assert.deepEqual(firstReport.companies, [{ companyId: '1', tenantId: fixture.snapshot().tenants[0].id }]);
  assert.equal(firstReport.rows.some((x) => 'passwordHash' in x || 'pinHash' in x), false);
  fixture.mutate((state) => {
    Object.assign(state.users[0], { username: 'edited.username', name: 'Edited Name', email: 'edited@example.test', passwordHash: `$2y$12$${'b'.repeat(53)}`, pinHash: 'edited-pin-hash', pinSetAt: new Date('2031-01-01Z'), pinResetRequired: true, pinLoginAttempts: 4, pinLockedUntil: new Date('2032-01-01Z'), mfaEnabled: true, mfaSecret: 'synthetic-preserved-encrypted-mfa', mfaBackupCodes: ['synthetic-backup-hash'], oidcIssuer: 'https://synthetic-issuer.example.test', oidcSubject: 'synthetic-subject', loginAttempts: 3, lockedUntil: new Date('2032-01-02Z'), suspendedAt: new Date('2030-02-01Z'), lastLoginAt: new Date('2030-03-01Z'), role: 'MANAGER', deletedAt: new Date('2030-01-01Z') });
    Object.assign(state.tenants[0], { name: 'Edited Tenant', usageCredits: 927, status: 'SUSPENDED' });
    Object.assign(state.locations[0], { name: 'Edited Location', address: 'Edited Address', timezone: 'Europe/London', deletedAt: new Date('2030-01-01Z') });
    state.assignments[0].roleId = state.roles.find((x) => x.legacyRole === 'MANAGER').id;
    Object.assign(state.roles.find((x) => x.legacyRole === 'STAFF'), { name: 'Edited Role Name', isDefault: true, deletedAt: new Date('2030-01-01Z') });
    Object.assign(state.permissions[0], { label: 'Edited Global Permission Label', description: 'Edited Global Permission Description' });
    state.rolePermissions = state.rolePermissions.filter((x) => x.roleId !== state.roles.find((x) => x.legacyRole === 'ADMIN').id);
    // Passive state stand-in only: this test proves the executor never invokes
    // Session mutation delegates, not native Session trigger behavior.
    state.sessions.push({ id: 'preserved-session', userId: state.users[0].id, expiresAt: new Date('2035-01-01Z'), revokedAt: null, mfaEnrollmentSecret: 'synthetic-encrypted-pending', mfaEnrollmentExpiresAt: new Date('2030-01-01Z') });
  });
  const edited = fixture.snapshot(); const effectsBefore = fixture.committed.length;
  const secondReport = await executeLegacyImport(admitted, { db: fixture.db });
  assert.deepEqual(fixture.snapshot(), edited, 'completed import never restores old names, credentials, grants, status or wallet');
  assert.equal(fixture.committed.length, effectsBefore, 'completed resume has zero domain or receipt writes');
  assert.equal(secondReport.rows.find((x) => x.sourceType === 'user').currentUsername, 'edited.username');
  assert.equal(secondReport.rows.find((x) => x.sourceType === 'user').currentName, 'Edited Name');
  assert.equal(secondReport.rows.find((x) => x.sourceType === 'user').deleted, true);
  assert.equal(secondReport.rows.find((x) => x.sourceType === 'location').currentName, 'Edited Location');
  assert.deepEqual(firstReport.rows.map((x) => x.targetId), secondReport.rows.map((x) => x.targetId));
});

test('every reached precommit effect rolls back its transaction draft', async () => {
  const positive = stagedDatabase(); const admitted = plan();
  await executeLegacyImport(admitted, { db: positive.db });
  const expected = ['run.insert', 'tenant.create', 'credit.provenance', 'permission.createMany', ...Array.from({ length: 4 }, () => ['role.create', 'role.grants']).flat(), 'company.receipt', 'location.create', 'entity.receipt.location', 'user.create', 'role.assignment', 'entity.receipt.user', 'user.create', 'role.assignment', 'entity.receipt.staff', 'run.complete'];
  assert.deepEqual(positive.committed.map((x) => x.name), expected, 'positive path reaches every independently named domain and receipt effect');
  for (let ordinal = 1; ordinal <= expected.length; ordinal += 1) {
    const fixture = stagedDatabase({ failAfter: ordinal });
    await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /synthetic precommit failure/);
    assert.equal(fixture.attempts.at(-1).name, expected[ordinal - 1]);
    assert.deepEqual(fixture.snapshot(), fixture.failedStart(), `full failed transaction rollback at ${ordinal}:${expected[ordinal - 1]}`);
    const failedTx = fixture.transactions.at(-1).tx;
    assert.equal(fixture.transactions.at(-1).status, 'rolled-back');
    assert.equal(fixture.committed.some((x) => x.tx === failedTx), false);
    fixture.clearFailure();
    await executeLegacyImport(admitted, { db: fixture.db });
    assertImportedCardinality(fixture.snapshot());
  }
});

test('a committed import survives lost acknowledgement and resumes without duplicate entities', async () => {
  // Every commit boundary, including final COMPLETE publication, can lose its
  // caller acknowledgement. Each fresh invocation reconciles durable maps.
  for (const lostTx of [1, 2, 3, 4, 5, 6]) {
    const fixture = stagedDatabase({ loseAcknowledgementAfter: lostTx }); const admitted = plan();
    await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /lost acknowledgement/);
    assert.equal(fixture.transactions.at(-1).status, 'committed');
    const before = fixture.snapshot(); const oldTargets = before.entities.map((x) => x.target_id);
    fixture.clearFailure();
    await executeLegacyImport(admitted, { db: fixture.db });
    const final = fixture.snapshot(); assertImportedCardinality(final);
    assert.deepEqual(final.entities.slice(0, oldTargets.length).map((x) => x.target_id), oldTargets);
    assert.equal(final.provenance.length, 1);
  }
});

test('admitted namespace source target and approval changes refuse before domain effects', async () => {
  for (const [label, changed] of [
    ['namespace', () => plan(undefined, { namespace: 'another-import' })],
    ['source digest', () => { const source = sourceFixture(); source.users[0].name_plain = 'Changed Source'; return plan(source); }],
    ['target generation', () => plan(undefined, { targetGenerationId: '22222222-2222-4222-8222-222222222222' })],
    ['approval descriptor', () => plan(undefined, { timezone: 'Europe/London' })],
  ]) {
    const fixture = stagedDatabase(); await executeLegacyImport(plan(), { db: fixture.db });
    const domain = fixture.snapshot(); const effects = fixture.committed.length;
    await assert.rejects(executeLegacyImport(changed(), { db: fixture.db }), /Legacy import conflict/, label);
    const after = fixture.snapshot();
    for (const key of ['tenants', 'locations', 'users', 'roles', 'rolePermissions', 'assignments', 'provenance', 'companies', 'entities']) assert.deepEqual(after[key], domain[key], label);
    assert.equal(fixture.committed.slice(effects).some((x) => x.name !== 'run.insert'), false, 'only a newly admitted namespace receipt may initialize; existing domain is never adopted');
  }
});

test('missing mapped account or location is refused and never recreated', async () => {
  for (const table of ['users', 'locations', 'tenants']) {
    const fixture = stagedDatabase(); const admitted = plan(); await executeLegacyImport(admitted, { db: fixture.db });
    fixture.mutate((state) => { state[table].splice(0, 1); });
    const before = fixture.snapshot(); const effects = fixture.committed.length;
    await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /mapped .* missing/);
    assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.committed.length, effects);
  }
});

test('unfinished imports reject bootstrap role drift while completed imports preserve intentional role edits', async () => {
  const fixture = stagedDatabase({ failAfter: 16 }); const admitted = plan();
  await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /precommit/);
  fixture.clearFailure();
  fixture.mutate((state) => { state.roles.find((x) => x.legacyRole === 'STAFF').name = 'Edited Staff Role'; });
  const before = fixture.snapshot(); const effects = fixture.committed.length;
  await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /role plan drift/);
  assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.committed.length, effects);
  fixture.mutate((state) => { state.roles.find((x) => x.legacyRole === 'STAFF').name = ROLE_DEFINITIONS.find((x) => x.legacyRole === 'STAFF').name; });
  await executeLegacyImport(admitted, { db: fixture.db });
  fixture.mutate((state) => { state.roles.find((x) => x.legacyRole === 'STAFF').name = 'Edited Staff Role'; });
  const completeEdited = fixture.snapshot();
  await executeLegacyImport(admitted, { db: fixture.db });
  assert.deepEqual(fixture.snapshot(), completeEdited);
});

for (const [label, mutate] of [
  ['company source digest', (s) => { s.companies[0].source_row_sha256 = '0'.repeat(64); }],
  ['entity source digest', (s) => { s.entities[0].source_row_sha256 = '0'.repeat(64); }],
  ['entity target type', (s) => { s.entities[0].target_kind = 'account'; }],
  ['entity company scope', (s) => { s.entities[0].target_tenant_id = 'foreign-tenant'; }],
  ['entity target owner', (s) => { s.users[0].tenantId = 'foreign-tenant'; }],
  ['entity initial role', (s) => { s.entities[1].initial_role_id = 'foreign-role'; }],
  ['duplicate receipt identity', (s) => { s.entities.push(clone(s.entities[0])); }],
  ['missing receipt identity', (s) => { s.entities.splice(0, 1); }],
  ['ambiguous company receipt', (s) => { s.companies.push(clone(s.companies[0])); }],
  ['ambiguous database generation', (s) => { s.generationRows.push(clone(s.generationRows[0])); }],
  ['malformed bootstrap role IDs', (s) => { s.companies[0].bootstrap_role_ids.STAFF = s.companies[0].bootstrap_role_ids.ADMIN; }],
]) {
  test(`retry refuses ${label} without repairing durable identities`, async () => {
    const fixture = stagedDatabase(); const admitted = plan(); await executeLegacyImport(admitted, { db: fixture.db });
    fixture.mutate(mutate); const before = fixture.snapshot(); const effects = fixture.committed.length;
    await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /Legacy import conflict/);
    assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.committed.length, effects);
  });
}

test('unmapped tenant slug is never adopted and soft deleted usernames still consume the collision bound', async () => {
  const unmapped = stagedDatabase(); unmapped.mutate((s) => s.tenants.push({ id: 'unmapped', slug: 'legacy-company-1', name: 'Unmapped', usageCredits: 77, status: 'ACTIVE', deletedAt: null }));
  await assert.rejects(executeLegacyImport(plan(), { db: unmapped.db }), /unmapped tenant slug/);
  assert.equal(unmapped.snapshot().companies.length, 0); assert.equal(unmapped.snapshot().tenants[0].usageCredits, 77);
  const fixture = stagedDatabase({ failAfter: 16 });
  const limits = { ...DEFAULT_LIMITS, usernameCollisionLimit: 2 }; const admitted = plan(undefined, { limits });
  await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /precommit/); fixture.clearFailure();
  fixture.mutate((s) => { for (const username of ['alice', 'alice.2']) s.users.push({ id: `existing-${username}`, tenantId: s.tenants[0].id, username, deletedAt: new Date('2030-01-01Z') }); });
  const before = fixture.snapshot();
  await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /collision bound/);
  assert.deepEqual(fixture.snapshot(), before);
  assert.equal(fixture.snapshot().entities.some((x) => x.source_type === 'user'), false);
});

test('monotonic execution budget refuses after a bounded delayed query without domain effects', async () => {
  const fixture = stagedDatabase({ afterRead: async (sql) => { if (sql === SQL.configure) await new Promise((resolve) => setTimeout(resolve, 5)); } });
  const admitted = plan(undefined, { limits: { ...DEFAULT_LIMITS, maxDurationMs: 1 } });
  await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /monotonic execution budget/);
  assert.equal(fixture.attempts.length, 0); assert.equal(fixture.committed.length, 0);
});

test('unfinished import refuses inactive tenant and never writes an account after lifecycle change', async () => {
  for (const changed of [{ status: 'SUSPENDED' }, { deletedAt: new Date('2030-01-01Z') }, { applicationDataPurgedAt: new Date('2030-01-01Z') }]) {
    const fixture = stagedDatabase({ failAfter: 16 }); const admitted = plan();
    await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /precommit/); fixture.clearFailure();
    fixture.mutate((s) => Object.assign(s.tenants[0], changed));
    const before = fixture.snapshot(); const effects = fixture.committed.length;
    await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /no longer eligible|mapped tenant is purged/);
    assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.committed.length, effects);
  }
});

test('actual role lock reads precede unfinished assignment and completed replay does not seed or restore roles', async () => {
  const fixture = stagedDatabase(); const admitted = plan();
  await executeLegacyImport(admitted, { db: fixture.db });
  for (const tx of fixture.transactions.filter((x) => fixture.committed.some((e) => e.tx === x.tx && e.name === 'role.assignment'))) {
    const reads = fixture.reads.filter((x) => x.tx === tx.tx);
    const names = reads.map((x) => x.name);
    assert.ok(names.indexOf(SQL.roleLocks) < names.indexOf(SQL.grantLocks));
    assert.ok(names.indexOf(SQL.grantLocks) < names.indexOf(SQL.permissionLocks));
    assert.ok(names.indexOf(SQL.permissionLocks) < names.indexOf('role.findMany'));
    assert.ok(names.indexOf('role.findMany') < names.indexOf('user.findFirst'));
    const sorted = reads.find((x) => x.name === SQL.roleLocks).args[1];
    assert.equal(sorted.length, 4); assert.deepEqual(sorted, [...new Set(sorted)].sort());
  }
  const effects = fixture.committed.length; const oldReads = fixture.reads.length;
  await executeLegacyImport(admitted, { db: fixture.db });
  assert.equal(fixture.committed.length, effects);
  assert.equal(fixture.reads.slice(oldReads).some((x) => x.name === 'role.findMany'), false);
});

test('report generation is read only and publication never overwrites an existing file', async () => {
  const fixture = stagedDatabase(); const admitted = plan();
  await executeLegacyImport(admitted, { db: fixture.db });
  fixture.mutate((s) => { s.users[0].username = 'current.edited.username'; });
  const before = fixture.snapshot(); const effects = fixture.committed.length;
  const report = await readLegacyImportReport(admitted, { db: fixture.db });
  assert.equal(report.rows.find((x) => x.sourceType === 'user').currentUsername, 'current.edited.username');
  assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.committed.length, effects);
  const directory = mkdtempSync(join(tmpdir(), 'legacy-report-custody-'));
  try {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    const retained = join(directory, 'retained.csv'); writeFileSync(retained, 'original retained evidence', { mode: 0o600 });
    assert.throws(() => publishLegacyImportReport(report, { path: retained }), /already exists/);
    assert.equal(readFileSync(retained, 'utf8'), 'original retained evidence');
    const published = join(directory, 'fresh.csv');
    assert.equal(publishLegacyImportReport(report, { path: published }), published);
    assert.equal(statSync(published).mode & 0o777, 0o600);
    assert.equal(readFileSync(published, 'utf8'), legacyImportReportCsv(report));
    assert.deepEqual(readdirSync(directory).sort(), ['fresh.csv', 'retained.csv']);
    assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.committed.length, effects);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('report-only failure cannot initialize or repair missing durable import receipts', async () => {
  const empty = stagedDatabase(); const admitted = plan(); const before = empty.snapshot();
  await assert.rejects(readLegacyImportReport(admitted, { db: empty.db }), /run receipt is absent/);
  assert.deepEqual(empty.snapshot(), before); assert.equal(empty.attempts.length, 0);
  const incomplete = stagedDatabase({ loseAcknowledgementAfter: 2 });
  await assert.rejects(executeLegacyImport(admitted, { db: incomplete.db }), /lost acknowledgement/);
  incomplete.clearFailure(); const partial = incomplete.snapshot(); const effects = incomplete.committed.length;
  await assert.rejects(readLegacyImportReport(admitted, { db: incomplete.db }), /cardinality/);
  assert.deepEqual(incomplete.snapshot(), partial); assert.equal(incomplete.committed.length, effects);
});

test('failed postcommit report write cleans only its own temporary file and recovers by read-only report', async () => {
  const fixture = stagedDatabase(); const admitted = plan();
  const report = await executeLegacyImport(admitted, { db: fixture.db }); const before = fixture.snapshot(); const effects = fixture.committed.length;
  const directory = mkdtempSync(join(tmpdir(), 'legacy-report-write-fail-')); const target = join(directory, 'fresh.csv');
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = () => { throw new Error('synthetic report disk write failure'); };
    assert.throws(() => publishLegacyImportReport(report, { path: target }), /synthetic report disk write failure/);
    assert.deepEqual(readdirSync(directory), [], 'only unlinked private report temporary is removed');
  } finally { fs.writeFileSync = originalWrite; }
  try {
    const recovered = await readLegacyImportReport(admitted, { db: fixture.db });
    publishLegacyImportReport(recovered, { path: target });
    assert.equal(readFileSync(target, 'utf8'), legacyImportReportCsv(report));
    assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.committed.length, effects);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(cell); cell = ''; if (character === '\n') { rows.push(row); row = []; }
    } else cell += character;
  }
  assert.equal(quoted, false); assert.equal(cell, ''); assert.deepEqual(row, []);
  return rows;
}

test('report escapes spreadsheet formulas and bounds output without exposing password hashes', async () => {
  const fixture = stagedDatabase(); const admitted = plan(); await executeLegacyImport(admitted, { db: fixture.db });
  fixture.mutate((s) => { s.users[0].name = '  =HYPERLINK("synthetic", "click")\nSecond line'; s.users[0].username = '@SUM(1)'; s.users[1].name = '\t+1'; s.locations[0].name = '-1'; });
  const report = await readLegacyImportReport(admitted, { db: fixture.db }); const csv = legacyImportReportCsv(report); const rows = parseCsv(csv);
  assert.equal(rows.length, 4); assert.equal(rows[0].length, 11);
  const nameIndex = rows[0].indexOf('currentName'); const usernameIndex = rows[0].indexOf('currentUsername');
  assert.equal(rows[1][nameIndex], "'-1");
  assert.equal(rows[2][usernameIndex], "'@SUM(1)");
  assert.equal(rows[2][nameIndex], "'  =HYPERLINK(\"synthetic\", \"click\")\nSecond line");
  assert.equal(rows[3][nameIndex], "'\t+1");
  assert.equal(csv.includes(legacyPassword), false); assert.equal(csv.includes('passwordHash'), false); assert.equal(csv.includes('pinHash'), false);
  assert.ok(Buffer.byteLength(csv) < 4096, 'positive fixture output remains within independently chosen small bound');
  assert.equal(REPORT_MAX_BYTES, 16777216); assert.equal(REPORT_MAX_ROWS, 20000); assert.equal(REPORT_MAX_CELL_BYTES, 8192);
  const oversizedCell = clone(report); oversizedCell.rows[0].currentName = 'é'.repeat(4097);
  assert.throws(() => legacyImportReportCsv(oversizedCell), /cell exceeds finite bound/);
  const atCellBoundary = clone(report); atCellBoundary.rows[0].currentName = 'é'.repeat(4096);
  assert.equal(parseCsv(legacyImportReportCsv(atCellBoundary))[1][nameIndex], 'é'.repeat(4096));
  const oversizedRows = clone(report); oversizedRows.rows = Array(20001).fill(report.rows[0]);
  assert.throws(() => legacyImportReportCsv(oversizedRows), /row bound/);
  const oversizedBytes = clone(report); oversizedBytes.counts = { company: 1, location: 0, user: 1100, staff: 0 };
  oversizedBytes.rows = Array.from({ length: 1100 }, (_, index) => ({ ...report.rows[1], legacyId: String(index + 1), targetId: `account-${index}`, currentName: 'x'.repeat(8192), currentUsername: 'y'.repeat(8192) }));
  assert.throws(() => legacyImportReportCsv(oversizedBytes), /exceeds byte bound/);
});

test('report publication refuses a symlinked custody directory and nonprivate directory', async () => {
  const fixture = stagedDatabase(); const report = await executeLegacyImport(plan(), { db: fixture.db });
  const directory = mkdtempSync(join(tmpdir(), 'legacy-report-path-')); const alias = `${directory}-alias`;
  try {
    symlinkSync(directory, alias, 'dir');
    assert.throws(() => publishLegacyImportReport(report, { path: join(alias, 'fresh.csv') }), /symlinks/);
    chmodSync(directory, 0o755);
    assert.throws(() => publishLegacyImportReport(report, { path: join(directory, 'fresh.csv') }), /0700/);
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(alias, { force: true }); rmSync(directory, { recursive: true, force: true }); }
});

test('company scoped mappings allocate same username separately and report locks current tenants in sorted order', async () => {
  const source = sourceFixture();
  source.companies.push({ id: 2, name: 'Company Two' });
  source.stores.push({ id: 10, company_id: 2, name: 'Location Two', location: 'Address Two' });
  source.users.push({ id: 8, company_id: 2, username_plain: 'Alice', name_plain: 'Another Alice', password_hash: legacyPassword });
  source.staff.push({ id: 8, company_id: 2, name_plain: 'Bob Example', is_admin: 0 });
  const admitted = plan(source, { companySlugs: { 1: 'legacy-company-1', 2: 'legacy-company-2' } });
  const fixture = stagedDatabase(); const first = await executeLegacyImport(admitted, { db: fixture.db });
  const state = fixture.snapshot();
  assert.equal(state.tenants.length, 2); assert.equal(state.locations.length, 2); assert.equal(state.users.length, 4); assert.equal(state.entities.length, 6); assert.equal(state.assignments.length, 4);
  assert.equal(state.users.filter((x) => x.username === 'alice').length, 2);
  assert.notEqual(state.users[0].tenantId, state.users[1].tenantId);
  const finalTx = fixture.transactions.at(-1).tx;
  assert.deepEqual(fixture.reads.filter((x) => x.tx === finalTx && x.name === SQL.lifecycle).map((x) => x.args[0]), state.tenants.map((x) => x.id).sort((a, b) => a.localeCompare(b)));
  const effects = fixture.committed.length;
  const second = await executeLegacyImport(admitted, { db: fixture.db });
  assert.deepEqual(second, first); assert.deepEqual(fixture.snapshot(), state); assert.equal(fixture.committed.length, effects);
});

test('a repeated user source identity in different companies is rejected before transactional access', () => {
  const source = sourceFixture(); source.companies.push({ id: 2, name: 'Company Two' });
  source.users.push({ ...source.users[0], company_id: 2 });
  assert.throws(() => plan(source, { companySlugs: { 1: 'legacy-company-1', 2: 'legacy-company-2' } }), /duplicate users identity/);
});

for (const [label, mutate] of [
  ['source digest', (s) => { s.runs[0].source_sha256 = '0'.repeat(64); }],
  ['adapter version', (s) => { s.runs[0].adapter_version = 'other'; }],
  ['role plan digest', (s) => { s.runs[0].role_plan_sha256 = '0'.repeat(64); }],
  ['external approval digest', (s) => { s.runs[0].approval_plan_sha256 = '0'.repeat(64); }],
  ['expected source counts', (s) => { s.runs[0].expected_user_count = 2; }],
  ['unsupported status', (s) => { s.runs[0].status = 'BROKEN'; }],
]) {
  test(`durable run ${label} mismatch refuses without source reapplication`, async () => {
    const fixture = stagedDatabase(); const admitted = plan(); await executeLegacyImport(admitted, { db: fixture.db });
    fixture.mutate(mutate); const before = fixture.snapshot(); const effects = fixture.committed.length;
    await assert.rejects(executeLegacyImport(admitted, { db: fixture.db }), /Legacy import conflict/);
    assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.committed.length, effects);
  });
}

for (const [label, mutate] of [
  ['extra credential key', (r) => { r.rows[0].passwordHash = legacyPassword; }],
  ['changed scoped tenant', (r) => { r.rows[0].tenantId = 'foreign'; }],
  ['duplicate scoped source', (r) => { r.rows.push(clone(r.rows[0])); r.counts.location += 1; }],
  ['duplicate account target across user and staff', (r) => { r.rows[2].targetId = r.rows[1].targetId; }],
  ['numeric legacy identity', (r) => { r.rows[0].legacyId = 9; }],
  ['nonboolean credential presence', (r) => { r.rows[1].currentPasswordCredentialPresent = 'true'; }],
  ['count drift', (r) => { r.counts.user += 1; }],
  ['invalid cell object', (r) => { r.rows[0].currentName = {}; }],
]) {
  test(`report refuses ${label} without publishing partial evidence`, async () => {
    const fixture = stagedDatabase(); const report = await executeLegacyImport(plan(), { db: fixture.db }); mutate(report);
    const directory = mkdtempSync(join(tmpdir(), 'legacy-report-reject-'));
    try {
      assert.throws(() => publishLegacyImportReport(report, { path: join(directory, 'rejected.csv') }));
      assert.deepEqual(readdirSync(directory), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test('company-only source completes with empty account report and repeated import has no effects', async () => {
  const source = sourceFixture(); for (const key of ['stores', 'users', 'staff', 'user_company_roles', 'user_store_roles']) source[key] = [];
  const fixture = stagedDatabase(); const admitted = plan(source); const report = await executeLegacyImport(admitted, { db: fixture.db });
  assert.deepEqual(report.counts, { company: 1, location: 0, user: 0, staff: 0 }); assert.equal(report.rows.length, 0);
  assert.equal(parseCsv(legacyImportReportCsv(report)).length, 1);
  const before = fixture.snapshot(); const effects = fixture.committed.length;
  assert.deepEqual(await executeLegacyImport(admitted, { db: fixture.db }), report);
  assert.deepEqual(fixture.snapshot(), before); assert.equal(fixture.committed.length, effects);
});

test('pre-Prisma admission completes exact approvals before callback and refuses invalid report custody', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-admission-only-')); const x = input();
  const sourcePath = join(directory, 'source.json'); const descriptorPath = join(directory, 'descriptor.json');
  writeFileSync(sourcePath, x.sourceBytes, { mode: 0o600 }); writeFileSync(descriptorPath, x.descriptorBytes, { mode: 0o600 });
  const env = { DATA_TARGET_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:synthetic@localhost:1/no_connection', LEGACY_SOURCE_EXPORT_SHA256: x.approval.expectedSourceSha256, LEGACY_IMPORT_DESCRIPTOR_SHA256: x.approval.expectedDescriptorSha256 };
  let callbacks = 0;
  try {
    chmodSync(directory, 0o755);
    await assert.rejects(importerMain([sourcePath, '--descriptor', descriptorPath, '--report', join(directory, 'never.csv')], env, { onAdmittedPlan(duration) {
      callbacks += 1; assert.equal(duration, DEFAULT_LIMITS.maxDurationMs);
      env.DATABASE_URL = 'postgresql://changed:changed@localhost:1/changed';
      env.LEGACY_SOURCE_EXPORT_SHA256 = '0'.repeat(64); env.LEGACY_IMPORT_DESCRIPTOR_SHA256 = '0'.repeat(64);
    } }), /owned0700 directory/);
    assert.equal(callbacks, 1); assert.match(env.DATABASE_URL, /changed/); assert.equal(env.LEGACY_IMPORT_DESCRIPTOR_SHA256, '0'.repeat(64));
    assert.deepEqual(readdirSync(directory).sort(), ['descriptor.json', 'source.json']);
    // This rejects before dynamic Prisma import. It proves admission ordering
    // and callback isolation only, not which datasource a real client connects.
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('publisher refuses ancestor replacement between custody check and directory open without writing either tree', async () => {
  const fixture = stagedDatabase(); const report = await executeLegacyImport(plan(), { db: fixture.db });
  const originalTree = mkdtempSync(join(tmpdir(), 'legacy-custody-original-'));
  const replacementTree = mkdtempSync(join(tmpdir(), 'legacy-custody-replacement-'));
  const movedTree = `${originalTree}-moved`; const leaf = join(originalTree, 'custody');
  fs.mkdirSync(leaf, { mode: 0o700 }); fs.mkdirSync(join(replacementTree, 'custody'), { mode: 0o700 });
  const originalOpen = fs.openSync; let replaced = false; let publicationError;
  try {
    fs.openSync = (requested, flags, ...rest) => {
      if (requested === leaf && (flags & fs.constants.O_DIRECTORY) !== 0 && !replaced) {
        replaced = true;
        fs.renameSync(originalTree, movedTree); symlinkSync(replacementTree, originalTree, 'dir');
      }
      return originalOpen(requested, flags, ...rest);
    };
    try { publishLegacyImportReport(report, { path: join(leaf, 'never.csv') }); } catch (error) { publicationError = error; }
    assert.equal(replaced, true, 'controlled substitution happens exactly at the real opened-directory boundary');
    assert.deepEqual(readdirSync(join(movedTree, 'custody')), [], 'checked original directory receives no temporary or published evidence');
    assert.deepEqual(readdirSync(join(replacementTree, 'custody')), [], 'replacement owned0700 leaf receives no temporary or published evidence');
    assert.match(publicationError?.message ?? '', /changed|replaced|identity|custody/);
  } finally {
    fs.openSync = originalOpen;
    if (replaced) { rmSync(originalTree, { force: true }); rmSync(movedTree, { recursive: true, force: true }); }
    else rmSync(originalTree, { recursive: true, force: true });
    rmSync(replacementTree, { recursive: true, force: true });
  }
});

for (const [label, terminator] of [['LF', '\n'], ['CR', '\r'], ['LS', '\u2028'], ['PS', '\u2029']]) {
  test(`planner rejects trailing ${label} in SHA256 approvals with canonical validation`, () => {
    const x = input();
    assert.throws(() => buildLegacyImportPlan(x.sourceBytes, x.descriptorBytes, { ...x.approval, expectedSourceSha256: `${x.approval.expectedSourceSha256}${terminator}` }), /external source approval must be lowercase SHA-256/);
    assert.throws(() => buildLegacyImportPlan(x.sourceBytes, x.descriptorBytes, { ...x.approval, expectedDescriptorSha256: `${x.approval.expectedDescriptorSha256}${terminator}` }), /external descriptor approval must be lowercase SHA-256/);
    const descriptor = JSON.parse(x.descriptorBytes); descriptor.sourceSha256 += terminator; const descriptorBytes = bytes(descriptor);
    assert.throws(() => buildLegacyImportPlan(x.sourceBytes, descriptorBytes, { expectedSourceSha256: x.approval.expectedSourceSha256, expectedDescriptorSha256: sha(descriptorBytes) }), /descriptor source digest must be lowercase SHA-256/);
  });
  for (const [field, change] of [
    ['legacy ID', (source, descriptor) => { source.staff[0].id = `7${terminator}`; }],
    ['namespace', (source, descriptor) => { descriptor.namespace += terminator; }],
    ['company slug', (source, descriptor) => { descriptor.companySlugs[1] += terminator; }],
    ['bcrypt hash', (source, descriptor) => { source.users[0].password_hash += terminator; }],
    ['generation UUID', (source, descriptor) => { descriptor.targetGenerationId += terminator; }],
  ]) {
    test(`planner rejects trailing ${label} in canonical ${field} before database access`, () => {
      const source = sourceFixture(); const descriptor = JSON.parse(input().descriptorBytes);
      change(source, descriptor); const sourceBytes = bytes(source); descriptor.sourceSha256 = sha(sourceBytes);
      const descriptorBytes = bytes(descriptor);
      assert.throws(() => buildLegacyImportPlan(sourceBytes, descriptorBytes, { expectedSourceSha256: sha(sourceBytes), expectedDescriptorSha256: sha(descriptorBytes) }));
    });
  }
  for (const [field, change] of [
    ['namespace', (report) => { report.namespace += terminator; }],
    ['generation UUID', (report) => { report.targetGenerationId += terminator; }],
    ['source SHA256', (report) => { report.sourceSha256 += terminator; }],
    ['legacy ID', (report) => { report.rows[0].legacyId += terminator; }],
    ['company ID', (report) => { report.companies[0].companyId += terminator; for (const row of report.rows) row.companyId += terminator; }],
  ]) {
    test(`report rejects trailing ${label} in canonical ${field} without publication`, async () => {
      const fixture = stagedDatabase(); const report = await executeLegacyImport(plan(), { db: fixture.db }); change(report);
      const directory = mkdtempSync(join(tmpdir(), 'legacy-report-terminator-'));
      try {
        assert.throws(() => publishLegacyImportReport(report, { path: join(directory, 'never.csv') }));
        assert.deepEqual(readdirSync(directory), []);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
  }
}

test('planner does not publish newline terminated source usernames as valid email addresses', () => {
  const source = sourceFixture(); source.users[0].username_plain = 'alice@example.test\n';
  const admitted = plan(source);
  assert.equal(admitted.accounts[0].email, null);
  assert.equal(admitted.accounts[0].usernameBase, 'alice.example.test');
});
