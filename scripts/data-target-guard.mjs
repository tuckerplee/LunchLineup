#!/usr/bin/env node
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_ENV_KEY = 'DATA_TARGET_ENV';
const NON_PRODUCTION_SEED_TARGETS = new Set(['test', 'disposable', 'development']);
const E2E_TARGETS = new Set(['test', 'disposable']);
const LEGACY_IMPORT_TARGETS = new Set([
  'test',
  'disposable',
  'development',
  'staging',
  'production-cutover',
]);
const MIGRATION_TARGETS = new Set(['test', 'disposable', 'development', 'staging', 'production']);
const LEGACY_PRODUCTION_CONFIRMATION = 'import-legacy-users-production-cutover';
const MIGRATION_PRODUCTION_CONFIRMATION = 'apply-lunchlineup-production-migrations';
const PRODUCTION_ENV_KEYS = ['NODE_ENV', 'APP_ENV', 'DEPLOY_ENV', 'NEXT_PUBLIC_APP_ENV'];
const PRODUCTION_MARKER = /(^|[\s._:/-])(prod|production)($|[\s._:/-])/i;

function explicitTargetEnvironment(env, allowed, operation) {
  const target = String(env[TARGET_ENV_KEY] ?? '').trim().toLowerCase();
  if (!allowed.has(target)) {
    throw new Error(
      `${operation} requires ${TARGET_ENV_KEY} to be one of: ${[...allowed].join(', ')}.`,
    );
  }
  return target;
}

function databaseTarget(env, operation) {
  const databaseUrl = String(env.DATABASE_URL ?? '').trim();
  if (!databaseUrl) throw new Error(`${operation} requires DATABASE_URL before any database client is loaded.`);
  try {
    const parsed = new URL(databaseUrl);
    return `${parsed.username} ${parsed.hostname} ${parsed.pathname}`;
  } catch {
    throw new Error(`${operation} requires a valid DATABASE_URL.`);
  }
}

function assertNonProductionDatabase(env, operation, { allowProductionNodeEnv = false } = {}) {
  const target = databaseTarget(env, operation);
  const productionEnvironment = PRODUCTION_ENV_KEYS.some(
    (key) => String(env[key] ?? '').trim().toLowerCase() === 'production',
  );
  if ((!allowProductionNodeEnv && productionEnvironment) || PRODUCTION_MARKER.test(target)) {
    throw new Error(`${operation} refuses a production-like environment or DATABASE_URL.`);
  }
}

export function assertE2ESeedTarget(env = process.env) {
  const target = explicitTargetEnvironment(env, E2E_TARGETS, 'E2E seed');
  assertNonProductionDatabase(env, 'E2E seed');
  return target;
}

export function assertDevelopmentSeedTarget(env = process.env) {
  const target = explicitTargetEnvironment(env, NON_PRODUCTION_SEED_TARGETS, 'Development Prisma seed');
  assertNonProductionDatabase(env, 'Development Prisma seed');
  return target;
}

export function assertLegacyImportTarget({
  env = process.env,
  actualSourceSha256,
} = {}) {
  const target = explicitTargetEnvironment(env, LEGACY_IMPORT_TARGETS, 'Legacy import');
  if (target !== 'production-cutover') {
    assertNonProductionDatabase(env, 'Legacy import', { allowProductionNodeEnv: target === 'staging' });
    return target;
  }

  databaseTarget(env, 'Legacy import');
  if (String(env.NODE_ENV ?? '').trim().toLowerCase() !== 'production') {
    throw new Error('Production legacy import requires NODE_ENV=production.');
  }

  if (env.LEGACY_IMPORT_PRODUCTION_CONFIRM !== LEGACY_PRODUCTION_CONFIRMATION) {
    throw new Error(
      `Production legacy import requires LEGACY_IMPORT_PRODUCTION_CONFIRM=${LEGACY_PRODUCTION_CONFIRMATION}.`,
    );
  }

  const expectedSha256 = String(env.LEGACY_SOURCE_EXPORT_SHA256 ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error('Production legacy import requires LEGACY_SOURCE_EXPORT_SHA256 as exactly 64 hexadecimal characters.');
  }
  if (String(actualSourceSha256 ?? '').toLowerCase() !== expectedSha256) {
    throw new Error('LEGACY_SOURCE_EXPORT_SHA256 does not match the selected legacy export.');
  }
  return target;
}

export function assertMigrationDeploymentTarget(env = process.env) {
  const target = explicitTargetEnvironment(env, MIGRATION_TARGETS, 'Database migration');
  if (target !== 'production') {
    assertNonProductionDatabase(env, 'Database migration', { allowProductionNodeEnv: target === 'staging' });
    return target;
  }

  databaseTarget(env, 'Database migration');
  if (String(env.NODE_ENV ?? '').trim().toLowerCase() !== 'production') {
    throw new Error('Production database migration requires NODE_ENV=production.');
  }
  if (env.MIGRATION_PRODUCTION_CONFIRM !== MIGRATION_PRODUCTION_CONFIRMATION) {
    throw new Error(
      `Production database migration requires MIGRATION_PRODUCTION_CONFIRM=${MIGRATION_PRODUCTION_CONFIRMATION}.`,
    );
  }
  return target;
}

function runCli() {
  const command = process.argv[2];
  if (command === 'development-seed') {
    assertDevelopmentSeedTarget(process.env);
    return;
  }
  throw new Error('Usage: node scripts/data-target-guard.mjs development-seed');
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
