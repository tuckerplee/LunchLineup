import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMigrationDeploymentTarget } from './data-target-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const prismaCli = join(root, 'node_modules/prisma/build/index.js');
const schemaPath = 'packages/db/prisma/schema.prisma';
const migrationsRoot = join(root, 'packages/db/prisma/migrations');
const productionAdminBootstrapPath = join(root, 'scripts/bootstrap-production-admin.mjs');
const appRoleProvisionPath = join(root, 'scripts/provision-app-db-role.mjs');
const webhookSecretRotationPath = join(root, 'scripts/rotate-webhook-endpoint-secrets.mjs');
const supersededMigrations = new Set([
  'init_rls.sql',
  'audit_log.sql',
  '20260310_username_pin_auth.sql',
  '20260325_rbac_roles_permissions.sql',
]);
function requireMigrationDatabaseUrl() {
  if (!process.env.MIGRATION_DATABASE_URL) {
    throw new Error('MIGRATION_DATABASE_URL is required to apply database migrations');
  }
  return process.env.MIGRATION_DATABASE_URL;
}

export function migrationRank(file) {
  if (file === '20260712_tenant_context_helpers.sql') return 1;
  if (file === '20260709_platform_admin_rls.sql') return 2;
  if (file === '20260712_rbac_seed_forward_reconciliation.sql') return 3;
  if (/^\d+_/.test(file)) return 4;
  return 5;
}

export function orderMigrationFileNames(files) {
  return [...files]
    .sort((left, right) => migrationRank(left) - migrationRank(right) || left.localeCompare(right));
}
export function shouldApplyMigrationFile(file) {
  return file.endsWith('.sql')
    && !file.startsWith('pre_')
    && !supersededMigrations.has(file);
}

function sortedSqlFiles(files) {
  return orderMigrationFileNames(files)
    .map((file) => join(migrationsRoot, file));
}

function preMigrationFiles() {
  return sortedSqlFiles(
    readdirSync(migrationsRoot)
      .filter((file) => file.startsWith('pre_') && file.endsWith('.sql')),
  );
}

function migrationFiles() {
  return orderMigrationFileNames(
    readdirSync(migrationsRoot)
      .filter(shouldApplyMigrationFile),
  )
    .map((file) => join(migrationsRoot, file));
}

function runPrisma(args) {
  execFileSync(node, [prismaCli, ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
}

function shouldBootstrapProductionAdmin(deploymentTarget) {
  return deploymentTarget === 'production';
}

function runProductionAdminBootstrap() {
  execFileSync(node, [productionAdminBootstrapPath], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
}

function rotateWebhookEndpointSecrets() {
  execFileSync(node, [webhookSecretRotationPath], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
}

function provisionAppRole(runtimeDatabaseUrl) {
  execFileSync(node, [appRoleProvisionPath], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: runtimeDatabaseUrl ?? '',
    },
    stdio: 'inherit',
  });
}

export function applyDbMigrations() {
  const deploymentTarget = assertMigrationDeploymentTarget(process.env);
  const runtimeDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = requireMigrationDatabaseUrl();

  if (!existsSync(join(root, schemaPath))) {
    throw new Error(`Prisma schema not found: ${schemaPath}`);
  }

  rotateWebhookEndpointSecrets();

  for (const migrationFile of preMigrationFiles()) {
    runPrisma(['db', 'execute', '--schema', schemaPath, '--file', migrationFile]);
  }

  runPrisma(['db', 'push', '--schema', schemaPath, '--skip-generate']);
  for (const migrationFile of migrationFiles()) {
    runPrisma(['db', 'execute', '--schema', schemaPath, '--file', migrationFile]);
  }

  provisionAppRole(runtimeDatabaseUrl);
  if (shouldBootstrapProductionAdmin(deploymentTarget)) {
    runProductionAdminBootstrap();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyDbMigrations();
}
