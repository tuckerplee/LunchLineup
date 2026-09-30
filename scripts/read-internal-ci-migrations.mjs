import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertE2ESeedTarget } from './data-target-guard.mjs';
import { buildRawMigrationInventory } from './raw-migration-inventory.mjs';
import { assertPathInside, assertRegularFile, readInternalCiSourceContext } from './internal-ci-source-context.mjs';
import { assertNoSymlinkComponents, writeExclusiveJson } from './internal-ci-evidence.mjs';

export function verifyIntegrationDatabaseTarget(env, context, target) {
  assert.equal(assertE2ESeedTarget(env), 'disposable');
  const temporary = resolve(env.RUNNER_TEMP);
  assert.equal(target.runId, context.runId);
  assert.equal(target.sourceSha, context.sourceSha);
  assert.equal(target.workspace, resolve(temporary, '../../../..', 'workspaces', context.runId));
  assert.equal(target.temporaryRoot, temporary);
  assert.equal(target.store, join(temporary, `lunchlineup-integration-containers-${context.runId}`));
  assert.equal(target.database, 'lunchlineup_test');
  assert.equal(target.mutationRole, 'lunchlineup_ci_app');
  assert.equal(target.dataTargetEnvironment, 'disposable');
  const prefix = `lunchlineup-integration-${context.runId.replace(/[^a-zA-Z0-9]/g, '')}`;
  assert.deepEqual(target.containers, ['postgres', 'redis', 'rabbitmq'].map(name => `${prefix}-${name}`));
  let app, owner;
  try { app = new URL(env.DATABASE_URL); owner = new URL(env.MIGRATION_DATABASE_URL); }
  catch { throw new Error('Invalid disposable PostgreSQL URL.'); }
  for (const url of [app, owner]) {
    assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, '/lunchlineup_test'); assert.equal(url.search, ''); assert.equal(url.hash, '');
    assert.ok(/^[0-9]+$/.test(url.port) && Number(url.port) >= 1024 && Number(url.port) <= 65535);
    assert.ok(url.password.length > 0);
  }
  assert.equal(app.username, target.mutationRole); assert.equal(owner.username, 'root');
  assert.equal(owner.port, app.port);
}

export function verifyAppliedMigrationRows(inventory, rows, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(inventory) && inventory.length > 0);
  assert.ok(Array.isArray(rows)); assert.equal(rows.length, inventory.length);
  const byPath = new Map(rows.map(row => [row.path, row]));
  assert.equal(byPath.size, rows.length);
  for (const expected of inventory) {
    const row = byPath.get(expected.relativePath); assert.ok(row, 'Missing applied migration');
    assert.equal(row.sha256, expected.sha256); assert.equal(row.bytes, expected.bytes);
    assert.equal(row.phase, expected.phase); assert.equal(row.execution_mode, 'APPLIED');
    assert.equal(row.source_sha, sourceSha);
    assert.ok(typeof row.applied_at === 'string' && Number.isFinite(Date.parse(row.applied_at)));
  }
}

export function verifyRestrictedIntegrationRole(rows) {
  assert.ok(Array.isArray(rows)); assert.equal(rows.length, 1);
  const role = rows[0];
  assert.equal(role.current_user, 'lunchlineup_ci_app'); assert.equal(role.session_user, 'lunchlineup_ci_app');
  assert.equal(role.current_database, 'lunchlineup_test'); assert.equal(role.rolcanlogin, true);
  for (const flag of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls']) assert.equal(role[flag], false);
}

const deadline = async (operation, label) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded the readback deadline`)), 15_000);
  })]); } finally { clearTimeout(timer); }
};

export async function readOnlyDatabase(client, query) {
  let result, primary;
  try {
    await deadline(client.connect(), 'Database connection');
    await deadline(client.query('BEGIN READ ONLY'), 'Read-only transaction');
    result = await deadline(client.query(query), 'Database readback');
    await deadline(client.query('COMMIT'), 'Read-only completion');
  } catch (error) { primary = error; }
  try { await deadline(client.end(), 'Database disconnect'); }
  catch (cleanup) { throw new AggregateError(primary ? [primary, cleanup] : [cleanup], 'Database readback/disconnect failures retained'); }
  if (primary) throw primary;
  return result.rows;
}

async function main() {
  assert.equal(process.argv.length, 4); assert.equal(process.argv[2], '--source-context');
  const context = readInternalCiSourceContext(resolve(process.argv[3]));
  const targetPath = join(context.evidenceRoot, 'integration-target.json');
  assertPathInside(context.evidenceRoot, targetPath); assertRegularFile(targetPath);
  const target = JSON.parse(readFileSync(targetPath, 'utf8'));
  verifyIntegrationDatabaseTarget(process.env, context, target);
  const inventory = buildRawMigrationInventory(context.buildSourcePath, join(context.buildSourcePath, 'packages/db/prisma/migrations')).all;
  assert.ok(inventory.length > 0);
  // Target and authoritative source validation precede loading any DB client.
  const { default: pg } = await import('pg');
  const client = url => new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 12_000, application_name: 'lunchlineup_ci_migration_readback' });
  const role = await readOnlyDatabase(client(process.env.DATABASE_URL),
    'SELECT current_user, session_user, current_database(), rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user');
  verifyRestrictedIntegrationRole(role);
  const ledger = await readOnlyDatabase(client(process.env.MIGRATION_DATABASE_URL),
    'SELECT path, sha256, bytes, phase, execution_mode, source_sha, applied_at::text FROM lunchlineup_migrations.raw_migration_ledger ORDER BY path');
  verifyAppliedMigrationRows(inventory, ledger, context.sourceSha);
  const output = join(context.evidenceRoot, 'integration');
  const receipt = { version: 1, kind: 'lunchlineup-disposable-migration-readback', runId: context.runId,
    sourceSha: context.sourceSha, treeSha: context.treeSha, dataTargetEnvironment: 'disposable',
    database: target.database, migrationCount: inventory.length, restrictedRole: role[0],
    roleProofScope: 'current/session identity and role flags; no assertion of all connections or effective grants',
    inventory: inventory.map(({ relativePath, sha256, bytes, phase }) => ({ relativePath, sha256, bytes, phase })),
    ledger, readOnlyTransactions: true, releaseQualified: false };
  writeExclusiveJson(join(output, 'migration-readback.json'), receipt, { root: context.evidenceRoot });
  const inventoryPath = join(output, 'migration-inventory.txt');
  assertNoSymlinkComponents(inventoryPath, context.evidenceRoot);
  writeFileSync(inventoryPath, inventory.map(item => item.relativePath).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
