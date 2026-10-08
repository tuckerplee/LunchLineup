import assert from 'node:assert/strict';
import test from 'node:test';
import { readOnlyDatabase, verifyAppliedMigrationRows, verifyIntegrationDatabaseTarget, verifyRestrictedIntegrationRole } from '../../scripts/read-internal-ci-migrations.mjs';
import { buildRawMigrationInventory } from '../../scripts/raw-migration-inventory.mjs';
import { resolve } from 'node:path';

const sourceSha = 'a'.repeat(40);
function targetFixture() {
  const runId = '20260930T210000Z-lunchlineup-aaaaaaaa-abcdef';
  const temporary = `/var/lib/custom-ci/runs/${runId}/tmp/job-tmp`;
  const context = { runId, sourceSha };
  const env = { DATA_TARGET_ENV: 'disposable', RUNNER_TEMP: temporary,
    DATABASE_URL: 'postgresql://lunchlineup_ci_app:synthetic@127.0.0.1:15432/lunchlineup_test',
    MIGRATION_DATABASE_URL: 'postgresql://root:synthetic@127.0.0.1:15432/lunchlineup_test' };
  const prefix = `lunchlineup-integration-${runId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const target = { runId, sourceSha, temporaryRoot: temporary, workspace: `/var/lib/custom-ci/workspaces/${runId}`,
    store: `${temporary}/lunchlineup-integration-containers-${runId}`, database: 'lunchlineup_test',
    mutationRole: 'lunchlineup_ci_app', dataTargetEnvironment: 'disposable',
    containers: ['postgres', 'redis', 'rabbitmq'].map(name => `${prefix}-${name}`) };
  return { context, env, target };
}
test('readback admits only the exact disposable target and same loopback database for both distinct roles', () => {
  const { env, context, target } = targetFixture(); verifyIntegrationDatabaseTarget(env, context, target);
});
test('malformed owner URL never exposes its credential in the failure', () => {
  const v = targetFixture(), credential = 'synthetic-private-token';
  v.env.MIGRATION_DATABASE_URL = `postgresql://root:${credential}@[invalid/lunchlineup_test`;
  assert.throws(() => verifyIntegrationDatabaseTarget(v.env, v.context, v.target), error =>
    error.message === 'Invalid disposable PostgreSQL URL.' && !error.message.includes(credential) && !('input' in error));
});
for (const [name, mutate] of [
  ['production environment', v => { v.env.NODE_ENV = 'production'; }],
  ['production target', v => { v.env.DATA_TARGET_ENV = 'production'; }],
  ['absent explicit target', v => { delete v.env.DATA_TARGET_ENV; }],
  ['foreign run receipt', v => { v.target.runId += '-foreign'; }],
  ['foreign source receipt', v => { v.target.sourceSha = 'b'.repeat(40); }],
  ['foreign store', v => { v.target.store = '/var/lib/containers'; }],
  ['foreign workspace', v => { v.target.workspace = '/var/lib/custom-ci/workspaces/other'; }],
  ['foreign container', v => { v.target.containers[0] = 'shared-postgres'; }],
  ['foreign database receipt', v => { v.target.database = 'lunchlineup_ci'; }],
  ['remote application DB', v => { v.env.DATABASE_URL = v.env.DATABASE_URL.replace('127.0.0.1', '192.0.2.1'); }],
  ['remote owner DB', v => { v.env.MIGRATION_DATABASE_URL = v.env.MIGRATION_DATABASE_URL.replace('127.0.0.1', '192.0.2.1'); }],
  ['owner used for application reads', v => { v.env.DATABASE_URL = v.env.MIGRATION_DATABASE_URL; }],
  ['different owner port', v => { v.env.MIGRATION_DATABASE_URL = v.env.MIGRATION_DATABASE_URL.replace('15432', '15433'); }],
  ['URL options', v => { v.env.DATABASE_URL += '?options=anything'; }],
]) test(`target rejects ${name} before a database client is loaded`, () => {
  const v = targetFixture(); mutate(v); assert.throws(() => verifyIntegrationDatabaseTarget(v.env, v.context, v.target));
});
const inventory = [{ relativePath: 'packages/db/prisma/migrations/pre_one.sql', sha256: 'b'.repeat(64), bytes: 8, phase: 'pre' },
  { relativePath: 'packages/db/prisma/migrations/two.sql', sha256: 'c'.repeat(64), bytes: 9, phase: 'post' }];
const rows = () => inventory.map(item => ({ path: item.relativePath, sha256: item.sha256, bytes: item.bytes, phase: item.phase,
  execution_mode: 'APPLIED', source_sha: sourceSha, applied_at: '2026-09-30 21:00:00.123+00' }));
test('exact native ledger allows query order independent from pre/post execution order', () => {
  verifyAppliedMigrationRows(inventory, rows().reverse(), sourceSha);
});
for (const [name, mutate] of [
  ['missing', r => r.pop()], ['foreign extra', r => r.push({ ...r[0], path: 'other.sql' })],
  ['duplicate', r => { r[1] = { ...r[0] }; }], ['renamed', r => { r[0].path = 'other.sql'; }],
  ['hash drift', r => { r[0].sha256 = 'd'.repeat(64); }], ['byte drift', r => { r[0].bytes++; }],
  ['phase drift', r => { r[0].phase = 'post'; }], ['baselined instead of applied', r => { r[0].execution_mode = 'BASELINED'; }],
  ['historical source', r => { r[0].source_sha = 'd'.repeat(40); }], ['missing time', r => { delete r[0].applied_at; }],
  ['invalid time', r => { r[0].applied_at = 'invalid'; }],
]) test(`applied ledger rejects ${name}`, () => {
  const r = rows(); mutate(r); assert.throws(() => verifyAppliedMigrationRows(inventory, r, sourceSha));
});
test('empty inventory cannot conceal the real flat raw migrations', () => {
  assert.throws(() => verifyAppliedMigrationRows([], [], sourceSha));
  const root = resolve('.'), raw = buildRawMigrationInventory(root, resolve('packages/db/prisma/migrations'));
  assert.ok(raw.pre.length > 0 && raw.post.length > 0);
  assert.ok(raw.all.some(item => item.fileName === '20260908_overnight_start_day_ownership.sql'));
  assert.ok(!raw.all.some(item => item.fileName === 'init_rls.sql'));
  assert.ok(raw.all.every(item => item.relativePath.endsWith('.sql') && !item.relativePath.endsWith('/migration.sql')));
});
const role = () => ({ current_user: 'lunchlineup_ci_app', session_user: 'lunchlineup_ci_app', current_database: 'lunchlineup_test',
  rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false });
test('actual restricted identity and explicit role flags pass', () => verifyRestrictedIntegrationRole([role()]));
for (const key of ['current_user', 'session_user', 'current_database', 'rolcanlogin', 'rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls']) {
  test(`role proof rejects altered ${key}`, () => {
    const r = role(); r[key] = typeof r[key] === 'boolean' ? !r[key] : 'foreign';
    assert.throws(() => verifyRestrictedIntegrationRole([r]));
  });
}
test('missing/ambiguous native role rows reject', () => {
  assert.throws(() => verifyRestrictedIntegrationRole([])); assert.throws(() => verifyRestrictedIntegrationRole([role(), role()]));
});
test('actual client uses read-only transaction and disconnects once', async () => {
  const calls = [], client = { connect: async () => calls.push('connect'),
    query: async sql => { calls.push(sql); return { rows: [role()] }; }, end: async () => calls.push('end') };
  assert.deepEqual(await readOnlyDatabase(client, 'SELECT role'), [role()]);
  assert.deepEqual(calls, ['connect', 'BEGIN READ ONLY', 'SELECT role', 'COMMIT', 'end']);
});
for (const stage of ['connect', 'BEGIN READ ONLY', 'SELECT role', 'COMMIT']) test(`disconnect remains mandatory after ${stage} failure`, async () => {
  const primary = new Error(stage), calls = [], client = {
    connect: async () => { if (stage === 'connect') throw primary; },
    query: async sql => { if (sql === stage) throw primary; return { rows: [] }; },
    end: async () => calls.push('end'),
  };
  await assert.rejects(readOnlyDatabase(client, 'SELECT role'), error => error === primary); assert.deepEqual(calls, ['end']);
});
test('query and disconnect failures are both retained', async () => {
  const primary = new Error('read failed'), cleanup = new Error('disconnect failed');
  await assert.rejects(readOnlyDatabase({ connect: async () => {}, query: async () => { throw primary; }, end: async () => { throw cleanup; } }, 'SELECT role'),
    error => error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup);
});
