import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ADAPTER_VERSION, DEFAULT_LIMITS, ROLE_PLAN_SHA256, buildLegacyImportPlan } from '../../scripts/legacy-import-plan.mjs';

// Static ABI and source invariant tests only. These never execute SQL and do
// not prove PostgreSQL parsing, locks, RLS, concurrency, ownership or retries.
const root = new URL('../../', import.meta.url);
const sql = readFileSync(new URL('packages/db/prisma/migrations/20261004_legacy_import_retry_receipts.sql', root), 'utf8');
const provisioner = readFileSync(new URL('scripts/provision-app-db-role.mjs', root), 'utf8');
const withoutComments = text => text.replace(/--[^\n]*/g, '');
const statements = withoutComments(sql);
const tableBodies = new Map([...statements.matchAll(/CREATE TABLE legacy_import\.(\w+) \(([\s\S]*?)\n    \);/g)]
  .map(match => [match[1], match[2]]));
const columns = body => [...body.matchAll(/^        ([a-z][a-z0-9_]*)\s+(BOOLEAN|UUID|TEXT|INTEGER|TIMESTAMPTZ|BIGINT|JSONB)\b/gm)]
  .map(match => [match[1], match[2]]);
function functionBody(name) {
  const match = statements.match(new RegExp(`CREATE FUNCTION legacy_import\\.${name}\\(\\)[\\s\\S]*?AS \\$(\\w+)\\$([\\s\\S]*?)\\$\\1\\$;`));
  assert.ok(match, `Missing ${name}`);
  return match[2];
}
function privateAccessContract(text) {
  const code = withoutComments(text).replace(/'(?:''|[^'])*'/g, "''");
  assert.doesNotMatch(code, /\bGRANT\b|\bSECURITY\s+DEFINER\b|\bCREATE\s+POLICY\b/i);
  assert.doesNotMatch(code, /\bREFERENCES\s+public\.|\bON\s+DELETE\s+CASCADE\b|\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  assert.match(code, /REVOKE ALL ON SCHEMA legacy_import FROM PUBLIC/);
  assert.match(code, /REVOKE ALL ON ALL TABLES IN SCHEMA legacy_import FROM PUBLIC/);
  assert.match(code, /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA legacy_import FROM PUBLIC/);
}

test('private receipt catalog exposes exactly the agreed four snake-case table ABIs', () => {
  assert.deepEqual([...tableBodies.keys()], ['target_generation', 'run', 'company', 'entity']);
  assert.deepEqual(columns(tableBodies.get('target_generation')), [['singleton', 'BOOLEAN'], ['generation_uuid', 'UUID']]);
  assert.deepEqual(columns(tableBodies.get('run')), [
    ['namespace', 'TEXT'], ['generation_uuid', 'UUID'], ['source_sha256', 'TEXT'], ['adapter_version', 'TEXT'],
    ['role_plan_sha256', 'TEXT'], ['approval_plan_sha256', 'TEXT'], ['expected_company_count', 'INTEGER'],
    ['expected_location_count', 'INTEGER'], ['expected_user_count', 'INTEGER'], ['expected_staff_count', 'INTEGER'],
    ['status', 'TEXT'], ['created_at', 'TIMESTAMPTZ'], ['completed_at', 'TIMESTAMPTZ'],
  ]);
  assert.deepEqual(columns(tableBodies.get('company')), [
    ['namespace', 'TEXT'], ['company_id', 'BIGINT'], ['target_tenant_id', 'TEXT'],
    ['source_row_sha256', 'TEXT'], ['bootstrap_role_ids', 'JSONB'],
  ]);
  assert.deepEqual(columns(tableBodies.get('entity')), [
    ['namespace', 'TEXT'], ['company_id', 'BIGINT'], ['source_type', 'TEXT'], ['legacy_id', 'BIGINT'],
    ['target_kind', 'TEXT'], ['target_id', 'TEXT'], ['target_tenant_id', 'TEXT'], ['initial_role_id', 'TEXT'], ['source_row_sha256', 'TEXT'],
  ]);
});

test('singleton generation and admitted run identity are independently constrained', () => {
  assert.match(tableBodies.get('target_generation'), /singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK \(singleton IS TRUE\)/);
  assert.match(tableBodies.get('target_generation'), /generation_uuid UUID NOT NULL UNIQUE/);
  const run = tableBodies.get('run');
  assert.match(run, /namespace TEXT PRIMARY KEY CHECK/);
  assert.match(run, /generation_uuid UUID NOT NULL REFERENCES legacy_import\.target_generation\(generation_uuid\)/);
  for (const digest of ['source_sha256', 'role_plan_sha256', 'approval_plan_sha256']) {
    assert.ok(run.includes(`${digest} TEXT NOT NULL CHECK (${digest} ~ '^[0-9a-f]{64}$')`), digest);
  }
  for (const kind of ['company', 'location', 'user', 'staff']) {
    assert.ok(run.includes(`expected_${kind}_count INTEGER NOT NULL CHECK (expected_${kind}_count >= 0)`), kind);
  }
  assert.match(run, /status IN \('INITIALIZED', 'COMPLETE'\)/);
  assert.match(run, /status = 'INITIALIZED' AND completed_at IS NULL/);
  assert.match(run, /status = 'COMPLETE' AND completed_at IS NOT NULL/);
  assert.match(run, /isfinite\(completed_at\) AND completed_at >= created_at/);
});

test('actual planner agrees with the declared namespace pattern on bounded ordinary ASCII cases', () => {
  const source = Buffer.from(JSON.stringify({ companies: [{ id: 1, name: 'Synthetic receipt company' }],
    stores: [], users: [], staff: [], user_company_roles: [], user_store_roles: [] }));
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const sqlPattern = tableBodies.get('run').match(/namespace TEXT PRIMARY KEY CHECK \(namespace ~ '([^']+)'/);
  assert.ok(sqlPattern);
  // This JavaScript regexp checks the declared source pattern over ordinary
  // ASCII cases only; it does not evaluate PostgreSQL regexp semantics.
  const namespaceRule = new RegExp(sqlPattern[1]);
  for (const [namespace, accepted] of [
    ['abc', true], ['source:one', true], ['a-b', true], ['a.b', true], ['a_0', true], ['a' + 'b'.repeat(127), true],
    ['', false], ['a', false], ['ab', false], ['0bc', false], ['Abc', false], ['a/b', false],
    ['abc ', false], ['abc;', false], ['a' + 'b'.repeat(128), false],
  ]) {
    const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, namespace,
      targetGenerationId: '12345678-1234-4234-8234-123456789abc', sourceSha256: sha(source),
      adapterVersion: ADAPTER_VERSION, rolePlanSha256: ROLE_PLAN_SHA256,
      companySlugs: { 1: 'legacy-company-synthetic' }, timezone: 'UTC', limits: { ...DEFAULT_LIMITS } }));
    const plan = () => buildLegacyImportPlan(source, descriptor,
      { expectedDescriptorSha256: sha(descriptor), expectedSourceSha256: sha(source) });
    assert.equal(namespaceRule.test(namespace), accepted, `declared ordinary ASCII pattern: ${JSON.stringify(namespace)}`);
    if (accepted) assert.equal(plan().namespace, namespace);
    else assert.throws(plan, /namespace must be explicitly selected and canonical/);
  }
});

test('actual planner rejects namespace terminators and SQL declares all four explicit bans', () => {
  const source = Buffer.from(JSON.stringify({ companies: [{ id: 1, name: 'Synthetic receipt company' }],
    stores: [], users: [], staff: [], user_company_roles: [], user_store_roles: [] }));
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const run = tableBodies.get('run');
  for (const codePoint of [10, 13, 8232, 8233]) {
    assert.ok(run.includes(`AND pg_catalog.strpos(namespace, pg_catalog.chr(${codePoint})) = 0`),
      `SQL source explicitly bans terminator ${codePoint}; this assertion does not execute SQL`);
    const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1,
      namespace: `abc${String.fromCodePoint(codePoint)}`,
      targetGenerationId: '12345678-1234-4234-8234-123456789abc', sourceSha256: sha(source),
      adapterVersion: ADAPTER_VERSION, rolePlanSha256: ROLE_PLAN_SHA256,
      companySlugs: { 1: 'legacy-company-synthetic' }, timezone: 'UTC', limits: { ...DEFAULT_LIMITS } }));
    assert.throws(() => buildLegacyImportPlan(source, descriptor,
      { expectedDescriptorSha256: sha(descriptor), expectedSourceSha256: sha(source) }),
    /namespace must be explicitly selected and canonical/);
  }
});

test('mapping identifiers are bounded UINT32 and receipts contain no mutable user or credential payload', () => {
  for (const [name, fields] of [['company', ['company_id']], ['entity', ['company_id', 'legacy_id']]]) {
    for (const field of fields) assert.ok(tableBodies.get(name).includes(`${field} BETWEEN 1 AND 4294967295`));
  }
  for (const [name, body] of tableBodies) {
    assert.doesNotMatch(body, /\b(password|pin_hash|pin|email|username|mfa_secret|source_payload|source_provenance|credentials)\b/i, name);
  }
  for (const field of ['target_id', 'target_tenant_id', 'initial_role_id']) {
    assert.match(tableBodies.get('entity'), new RegExp(`octet_length\\(${field}\\) BETWEEN 1 AND 256`));
  }
});

test('company bootstrap receipt has an exact four-role object of bounded strings', () => {
  const body = tableBodies.get('company');
  assert.match(body, /jsonb_typeof\(bootstrap_role_ids\) = 'object'/);
  assert.match(body, /bootstrap_role_ids \?& ARRAY\['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'\]/);
  assert.match(body, /bootstrap_role_ids - ARRAY\['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'\] = '\{\}'::jsonb/);
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']) {
    assert.ok(body.includes(`jsonb_typeof(bootstrap_role_ids->'${role}') = 'string'`));
    assert.ok(body.includes(`octet_length(bootstrap_role_ids->>'${role}') BETWEEN 1 AND 256`));
  }
  const roles = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'];
  for (let left = 0; left < roles.length; left++) for (let right = left + 1; right < roles.length; right++) {
    assert.ok(body.includes(`bootstrap_role_ids->>'${roles[left]}' <> bootstrap_role_ids->>'${roles[right]}'`),
      `${roles[left]} and ${roles[right]} cannot alias`);
  }
});

test('source types share account target uniqueness and retain exact company ownership', () => {
  const body = tableBodies.get('entity');
  assert.match(body, /source_type IN \('location', 'user', 'staff'\)/);
  assert.match(body, /target_kind TEXT GENERATED ALWAYS AS \(CASE WHEN source_type = 'location' THEN 'location' ELSE 'account' END\) STORED/);
  assert.match(body, /PRIMARY KEY \(namespace, company_id, source_type, legacy_id\)/);
  assert.match(body, /UNIQUE \(target_kind, target_id\)/);
  assert.doesNotMatch(body, /UNIQUE \(source_type, target_id\)/);
  assert.match(body, /FOREIGN KEY \(namespace, company_id, target_tenant_id\)\s+REFERENCES legacy_import\.company\(namespace, company_id, target_tenant_id\)/);
  assert.match(body, /source_type = 'location' AND initial_role_id IS NULL/);
  assert.match(body, /source_type IN \('user', 'staff'\) AND initial_role_id IS NOT NULL/);
  assert.match(tableBodies.get('company'), /target_tenant_id TEXT NOT NULL UNIQUE/);
  assert.match(tableBodies.get('company'), /UNIQUE \(namespace, company_id, target_tenant_id\)/);
});

test('all reference edges stay private so live application deletion cannot erase tombstones', () => {
  const references = [...statements.matchAll(/\bREFERENCES\s+([\w.]+)/g)].map(match => match[1]);
  assert.deepEqual(references, ['legacy_import.target_generation', 'legacy_import.run', 'legacy_import.company']);
  assert.doesNotMatch(statements, /\bDROP\s+(?:TABLE|SCHEMA|FUNCTION|TRIGGER)|\bTRUNCATE\s+TABLE|\bDELETE\s+FROM/i);
  assert.doesNotMatch(statements, /public\./);
});

test('generation and mappings refuse both row mutation and TRUNCATE', () => {
  assert.match(functionBody('refuse_receipt_mutation'), /RAISE EXCEPTION[\s\S]*ERRCODE = '42501'/);
  for (const table of ['target_generation', 'company', 'entity']) {
    assert.match(statements, new RegExp(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON legacy_import\\.${table}\\s+FOR EACH ROW EXECUTE FUNCTION legacy_import\\.refuse_receipt_mutation\\(\\)`));
    assert.match(statements, new RegExp(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON legacy_import\\.${table}\\s+FOR EACH STATEMENT EXECUTE FUNCTION legacy_import\\.refuse_receipt_mutation\\(\\)`));
  }
});

test('the run transition keeps all admission fields immutable and requires exact completion counts', () => {
  const body = functionBody('guard_run_transition');
  assert.match(body, /TG_OP IN \('DELETE', 'TRUNCATE'\)/);
  assert.match(body, /TG_OP = 'INSERT'[\s\S]*NEW\.status <> 'INITIALIZED' OR NEW\.completed_at IS NOT NULL/);
  assert.match(body, /to_jsonb\(NEW\) - 'status' - 'completed_at'[\s\S]*to_jsonb\(OLD\) - 'status' - 'completed_at'/);
  assert.match(body, /OLD\.status <> 'INITIALIZED'[\s\S]*NEW\.status <> 'COMPLETE'/);
  assert.match(body, /count\(\*\) FROM legacy_import\.company WHERE namespace = OLD\.namespace\) <> OLD\.expected_company_count/);
  for (const kind of ['location', 'user', 'staff']) {
    assert.ok(body.includes(`source_type = '${kind}') <> OLD.expected_${kind}_count`), kind);
  }
  assert.match(statements, /run_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON legacy_import\.run/);
  assert.match(statements, /run_no_truncate BEFORE TRUNCATE ON legacy_import\.run/);
});

test('receipt insertion fences the exact open run before bounded counts and role ownership checks', () => {
  const body = functionBody('guard_receipt_insert');
  const lock = body.indexOf('WHERE namespace = NEW.namespace FOR UPDATE');
  const counts = body.indexOf('SELECT count(*)');
  assert.ok(lock >= 0 && counts > lock);
  assert.match(body, /NOT FOUND OR admitted\.status <> 'INITIALIZED'/);
  assert.match(body, /expected_count IS NULL OR actual_count >= expected_count/);
  assert.match(body, /company\.namespace = NEW\.namespace AND company\.company_id = NEW\.company_id/);
  assert.match(body, /company\.target_tenant_id = NEW\.target_tenant_id AND role_id\.value = NEW\.initial_role_id/);
  for (const table of ['company', 'entity']) assert.match(statements,
    new RegExp(`${table}_insert_guard BEFORE INSERT ON legacy_import\\.${table}\\s+FOR EACH ROW EXECUTE FUNCTION legacy_import\\.guard_receipt_insert\\(\\)`));
});

test('private default-deny access leaves application provisioning and owner bypass unchanged', () => {
  privateAccessContract(sql);
  for (const table of tableBodies.keys()) assert.ok(statements.includes(`ALTER TABLE legacy_import.${table} ENABLE ROW LEVEL SECURITY`));
  assert.match(statements, /permission\.grantee <> owner_oid/);
  assert.match(statements, /Legacy import schema inherited an unapproved grant/);
  assert.doesNotMatch(provisioner, /legacy_import/);
  assert.match(provisioner, /GRANT USAGE ON SCHEMA public/);
  assert.match(provisioner, /IN SCHEMA public GRANT/);
});

test('repeat migration checks ownership and complete catalog checksum before returning without writes', () => {
  const repeat = statements.slice(statements.indexOf('IF namespace_oid IS NOT NULL THEN'), statements.indexOf('CREATE SCHEMA legacy_import;'));
  assert.match(repeat, /nspowner[\s\S]*<> owner_oid/);
  for (const owner of ['relowner', 'proowner', 'typowner']) assert.match(repeat, new RegExp(`${owner} <> owner_oid`));
  assert.match(repeat, /recorded_checksum IS NULL OR recorded_checksum !~/);
  assert.match(repeat, /EXECUTE catalog_query INTO catalog_checksum/);
  assert.match(repeat, /recorded_checksum <> 'lunchlineup-legacy-import-receipts-v1:' \|\| catalog_checksum/);
  assert.match(repeat, /count\(\*\) FROM legacy_import\.target_generation\) <> 1/);
  assert.match(repeat, /set_config\('search_path', old_search_path, true\);\s+RETURN/);
  assert.doesNotMatch(statements, /\bIF NOT EXISTS\b|\bCREATE OR REPLACE\b/i);
  for (const catalog of ['pg_namespace', 'pg_class', 'pg_attribute', 'pg_constraint', 'pg_index', 'pg_trigger', 'pg_proc', 'pg_policy', 'pg_type']) {
    assert.ok(statements.includes(catalog), catalog);
  }
  assert.match(statements, /pg_get_functiondef\(p\.oid\)/);
  assert.match(statements, /c\.relacl::text/);
  assert.match(statements, /t\.tgenabled/);
});

test('static access oracle rejects deliberately unsafe grant, definer, public FK and RLS changes', () => {
  for (const unsafe of [
    'GRANT USAGE ON SCHEMA legacy_import TO lunchlineup_app;',
    'CREATE FUNCTION legacy_import.unsafe() RETURNS void SECURITY DEFINER AS $$ $$ LANGUAGE sql;',
    'ALTER TABLE legacy_import.company ADD FOREIGN KEY (target_tenant_id) REFERENCES public."Tenant"(id);',
    'ALTER TABLE legacy_import.company FORCE ROW LEVEL SECURITY;',
    'CREATE POLICY app_receipts ON legacy_import.company USING (true);',
  ]) assert.throws(() => privateAccessContract(`${sql}\n${unsafe}`));
});
