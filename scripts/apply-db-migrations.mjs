import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMigrationDeploymentTarget } from './data-target-guard.mjs';
import { runBoundedProcess } from './bounded-child-process.mjs';
import {
  buildRawMigrationInventory,
  migrationRank,
  orderMigrationFileNames,
  shouldApplyMigrationFile,
} from './raw-migration-inventory.mjs';
import { RawMigrationLedgerSession } from './raw-migration-ledger.mjs';

export { migrationRank, orderMigrationFileNames, shouldApplyMigrationFile };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const PRISMA_COMMAND_TIMEOUT_MS = 600_000;
const BOOTSTRAP_COMMAND_TIMEOUT_MS = 120_000;
const APP_ROLE_PROVISION_TIMEOUT_MS = 120_000;
const WEBHOOK_ROTATION_TIMEOUT_MS = 150_000;
const prismaCli = join(root, 'node_modules/prisma/build/index.js');
const schemaPath = 'packages/db/prisma/schema.prisma';
const migrationsRoot = join(root, 'packages/db/prisma/migrations');
const rawMigrationPolicyPath = join(root, 'scripts/raw-migration-rollback-policy.json');
const productionAdminBootstrapPath = join(root, 'scripts/bootstrap-production-admin.mjs');
const appRoleProvisionPath = join(root, 'scripts/provision-app-db-role.mjs');
const webhookSecretRotationPath = join(root, 'scripts/rotate-webhook-endpoint-secrets.mjs');

function requireMigrationDatabaseUrl() {
  if (!process.env.MIGRATION_DATABASE_URL) {
    throw new Error('MIGRATION_DATABASE_URL is required to apply database migrations');
  }
  return process.env.MIGRATION_DATABASE_URL;
}

function runPrisma(args) {
  return runBoundedProcess(node, [prismaCli, ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    timeoutMs: PRISMA_COMMAND_TIMEOUT_MS,
    label: 'Prisma migration command',
  });
}

function shouldBootstrapProductionAdmin(deploymentTarget) {
  return deploymentTarget === 'production';
}

function runProductionAdminBootstrap() {
  return runBoundedProcess(node, [productionAdminBootstrapPath], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    label: 'production admin bootstrap',
  });
}

function runProductionAdminPreflight() {
  return runBoundedProcess(node, [productionAdminBootstrapPath, '--preflight-only'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    label: 'production admin preflight',
  });
}

function runWebhookEndpointSecretCommand(args = []) {
  return runBoundedProcess(node, [webhookSecretRotationPath, ...args], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    timeoutMs: WEBHOOK_ROTATION_TIMEOUT_MS,
    label: 'webhook endpoint secret command',
  });
}

export async function runMigrationSequence(operations) {
  await operations.preflightProductionAdmin?.();
  await operations.verifyWebhookEndpointSecrets();
  await operations.applyPreMigrations();
  await operations.pushSchema();
  await operations.applyRawMigrations();
  await operations.provisionAppRole();
  await operations.bootstrapProductionAdmin();
  await operations.rotateWebhookEndpointSecrets();
}

function provisionAppRole(runtimeDatabaseUrl) {
  return runBoundedProcess(node, [appRoleProvisionPath], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: runtimeDatabaseUrl ?? '',
    },
    stdio: 'inherit',
    timeoutMs: APP_ROLE_PROVISION_TIMEOUT_MS,
    label: 'application database role provisioning',
  });
}

export async function applyDbMigrations() {
  const deploymentTarget = assertMigrationDeploymentTarget(process.env);
  const runtimeDatabaseUrl = process.env.DATABASE_URL;
  const migrationDatabaseUrl = requireMigrationDatabaseUrl();
  process.env.DATABASE_URL = migrationDatabaseUrl;

  if (!existsSync(join(root, schemaPath))) {
    throw new Error(`Prisma schema not found: ${schemaPath}`);
  }

  const inventory = buildRawMigrationInventory(root, migrationsRoot);
  const policy = JSON.parse(readFileSync(rawMigrationPolicyPath, 'utf8'));
  const ledger = await RawMigrationLedgerSession.open({
    baselineSourceSha: process.env.MIGRATION_BASELINE_SOURCE_SHA,
    databaseUrl: migrationDatabaseUrl,
    deploymentTarget,
    freshProductionConfirm: process.env.MIGRATION_FRESH_DATABASE_CONFIRM,
    inventory,
    policy,
    sourceSha: process.env.MIGRATION_SOURCE_SHA,
  });
  try {
    await runMigrationSequence({
      preflightProductionAdmin: () => {
        if (shouldBootstrapProductionAdmin(deploymentTarget)) return runProductionAdminPreflight();
        return undefined;
      },
      verifyWebhookEndpointSecrets: () => runWebhookEndpointSecretCommand(['--verify-only']),
      applyPreMigrations: () => ledger.applyAll(inventory.pre),
      pushSchema: () => runPrisma(['db', 'push', '--schema', schemaPath, '--skip-generate']),
      applyRawMigrations: () => ledger.applyAll(inventory.post),
      provisionAppRole: () => provisionAppRole(runtimeDatabaseUrl),
      bootstrapProductionAdmin: () => {
        if (shouldBootstrapProductionAdmin(deploymentTarget)) return runProductionAdminBootstrap();
        return undefined;
      },
      rotateWebhookEndpointSecrets: () => runWebhookEndpointSecretCommand(),
    });
  } finally {
    await ledger.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await applyDbMigrations();
}
