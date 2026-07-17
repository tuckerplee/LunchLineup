import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  readRoleProvisionConfig,
  roleProvisionSql,
} from '../../scripts/provision-app-db-role.mjs';

const root = resolve(import.meta.dirname, '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function serviceBlock(compose, serviceName) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(start, -1, `missing Compose service: ${serviceName}`);

  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join('\n');
}

test('runtime database services use the restricted application credential', () => {
  const compose = read('docker-compose.yml');

  for (const service of ['api', 'webhook-replay', 'worker', 'pgbouncer']) {
    const block = serviceBlock(compose, service);
    assert.match(block, /DATABASE_URL=\$\{DATABASE_URL:\?Set validated percent-encoded DATABASE_URL in \.env\}/, service);
    assert.doesNotMatch(block, /DATABASE_URL=.*\$\{POSTGRES_USER:/, service);
    assert.doesNotMatch(block, /DATABASE_URL=postgres(?:ql)?:\/\/\$\{APP_DB_USER:/, service);
  }

  const migrate = serviceBlock(compose, 'migrate');
  assert.match(migrate, /MIGRATION_DATABASE_URL=\$\{MIGRATION_DATABASE_URL:\?Set validated percent-encoded MIGRATION_DATABASE_URL in \.env\}/);
  assert.match(migrate, /APP_DB_USER=\$\{APP_DB_USER:/);
  assert.doesNotMatch(migrate, /^\s+- DATABASE_URL=/m);
});

test('role provisioning enforces RLS-capable attributes and complete object grants', () => {
  for (const fragment of [
    'NOSUPERUSER',
    'NOBYPASSRLS',
    'NOCREATEDB',
    'NOCREATEROLE',
    'NOINHERIT',
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public',
    'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public',
    'GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public',
    'ALTER DEFAULT PRIVILEGES',
    'ON TABLES',
    'ON SEQUENCES',
    'ON ROUTINES',
    'lunchlineup_private.platform_admin_capability',
    "public.digest(requested_platform_admin_capability, 'sha256')",
  ]) {
    assert.ok(roleProvisionSql.includes(fragment), `missing role provision fragment: ${fragment}`);
  }

  assert.match(roleProvisionSql, /role_exists BOOLEAN := EXISTS \(SELECT 1 FROM pg_roles/);
  assert.match(roleProvisionSql, /current_setting\('app\.provision\.app_password', true\)/);
  assert.match(roleProvisionSql, /current_setting\('app\.provision\.platform_admin_capability', true\)/);
  assert.doesNotMatch(roleProvisionSql, /public\.digest\(platform_admin_capability,/);
  assert.doesNotMatch(roleProvisionSql, /lunchlineup_app|app-testpass/);
});

test('role provision config rejects owner reuse and strips the admin password from command metadata', () => {
  const base = {
    POSTGRES_USER: 'lunchlineup_admin',
    POSTGRES_PASSWORD: 'owner-secret',
    APP_DB_USER: 'lunchlineup_app',
    APP_DB_PASSWORD: 'app-secret',
    PLATFORM_ADMIN_DB_CONTEXT_SECRET: 'platform-admin-capability-secret',
    DATABASE_URL: 'postgresql://lunchlineup_app:app-secret@postgres:5432/lunchlineup',
    MIGRATION_DATABASE_URL: 'postgresql://lunchlineup_admin:owner-secret@postgres:5432/lunchlineup',
  };

  const config = readRoleProvisionConfig(base);
  assert.equal(config.appRole, 'lunchlineup_app');
  assert.doesNotMatch(config.sanitizedAdminUrl, /owner-secret/);
  assert.equal(new URL(config.sanitizedAdminUrl).password, '');

  assert.throws(
    () => readRoleProvisionConfig({ ...base, APP_DB_USER: 'lunchlineup_admin' }),
    /distinct from the migration\/owner role/,
  );
  assert.throws(
    () => readRoleProvisionConfig({ ...base, APP_DB_PASSWORD: 'owner-secret' }),
    /distinct from the migration\/owner password/,
  );
  assert.throws(
    () => readRoleProvisionConfig({ ...base, DATABASE_URL: base.MIGRATION_DATABASE_URL }),
    /DATABASE_URL must authenticate as APP_DB_USER/,
  );
});

test('role provisioning uses repository-local Prisma stdin without host psql', () => {
  const provisioner = read('scripts/provision-app-db-role.mjs');

  assert.match(provisioner, /node_modules\/prisma\/build\/index\.js/);
  assert.match(provisioner, /'db', 'execute', '--schema', schemaPath, '--stdin'/);
  assert.doesNotMatch(provisioner, /execFileSync\('psql'/);
  assert.match(provisioner, /runBoundedProcess/);
  assert.match(provisioner, /runtimeCredentialWorks/);
  assert.match(provisioner, /rollback-safe credential rotation procedure/);
  assert.doesNotMatch(roleProvisionSql, /ALTER ROLE %I WITH LOGIN PASSWORD/);
});
test('migration runner uses the admin URL for schema work and provisions the RLS capability before admin bootstrap', () => {
  const runner = read('scripts/apply-db-migrations.mjs');
  const switchToAdmin = runner.indexOf('process.env.DATABASE_URL = requireMigrationDatabaseUrl();');
  const sequenceInvocation = runner.indexOf('runMigrationSequence({', switchToAdmin);
  const sequence = runner.match(/export async function runMigrationSequence\(operations\) \{([\s\S]*?)\n\}/)?.[1];

  assert.ok(switchToAdmin >= 0 && switchToAdmin < sequenceInvocation);
  assert.ok(sequence, 'runMigrationSequence must remain exported');
  const schemaPush = sequence.indexOf('operations.pushSchema();');
  const provision = sequence.indexOf('operations.provisionAppRole();');
  const adminBootstrap = sequence.indexOf('operations.bootstrapProductionAdmin();');
  assert.ok(schemaPush >= 0 && schemaPush < provision);
  assert.ok(provision < adminBootstrap);
  assert.match(runner, /DATABASE_URL: runtimeDatabaseUrl \?\? ''/);
  assert.match(read('infrastructure/docker/Dockerfile.migrations'), /postgresql-client/);
});

test('platform-admin RLS elevation requires an unqueryable capability proof', () => {
  const sql = read('packages/db/prisma/migrations/20260709_zzzzzzz_platform_admin_capability.sql');

  assert.match(sql, /set_current_platform_admin\(enabled BOOLEAN, capability TEXT\)/);
  assert.match(sql, /lunchlineup_private\.platform_admin_capability/);
  assert.match(sql, /public\.digest\(capability, 'sha256'\)/);
  assert.match(sql, /app\.platform_admin_proof/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION set_current_platform_admin\(BOOLEAN, TEXT\) FROM PUBLIC/);
  assert.doesNotMatch(sql, /app\.platform_admin'/);
});
