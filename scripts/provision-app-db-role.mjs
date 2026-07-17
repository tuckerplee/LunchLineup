#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './bounded-child-process.mjs';

const roleNamePattern = /^[a-z_][a-z0-9_]{0,62}$/;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = join(root, 'node_modules/prisma/build/index.js');
const schemaPath = 'packages/db/prisma/schema.prisma';
const ROLE_PROVISION_COMMAND_TIMEOUT_MS = 90_000;

export const roleProvisionSql = String.raw`DO $provision$
DECLARE
  app_role TEXT := current_setting('app.provision.app_role', true);
  app_password TEXT := current_setting('app.provision.app_password', true);
  requested_platform_admin_capability TEXT := current_setting('app.provision.platform_admin_capability', true);
  runtime_credential_verified BOOLEAN := current_setting('app.provision.runtime_credential_verified', true)::BOOLEAN;
  role_exists BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role);
BEGIN
  IF role_exists AND NOT runtime_credential_verified THEN
    RAISE EXCEPTION 'Existing application role credentials differ; use the rollback-safe credential rotation procedure';
  ELSIF NOT role_exists THEN
    EXECUTE format(
      'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      app_role,
      app_password
    );
  ELSE
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      app_role
    );
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), app_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_role);
  EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO %I', app_role);

  IF EXISTS (
    SELECT 1
    FROM lunchlineup_private.platform_admin_capability
    WHERE singleton = TRUE
      AND secret_hash <> encode(public.digest(requested_platform_admin_capability, 'sha256'), 'hex')
  ) THEN
    RAISE EXCEPTION 'Existing platform-admin capability differs; use the rollback-safe credential rotation procedure';
  END IF;

  INSERT INTO lunchlineup_private.platform_admin_capability (singleton, secret_hash)
  VALUES (TRUE, encode(public.digest(requested_platform_admin_capability, 'sha256'), 'hex'))
  ON CONFLICT (singleton) DO NOTHING;

  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    current_user,
    app_role
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
    current_user,
    app_role
  );
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON ROUTINES TO %I',
    current_user,
    app_role
  );
END;
$provision$;
`;

function sqlLiteral(value) {
  if (value.includes('\0')) throw new Error('Database role provisioning values must not contain null bytes');
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildRoleProvisionSql(config, runtimeCredentialVerified = true) {
  return `BEGIN;
SELECT set_config('app.provision.app_role', ${sqlLiteral(config.appRole)}, true);
SELECT set_config('app.provision.app_password', ${sqlLiteral(config.appPassword)}, true);
SELECT set_config('app.provision.platform_admin_capability', ${sqlLiteral(config.platformAdminCapability)}, true);
SELECT set_config('app.provision.runtime_credential_verified', ${sqlLiteral(String(runtimeCredentialVerified))}, true);
${roleProvisionSql}
COMMIT;
`;
}

function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) throw new Error(`${key} is required to provision the application database role`);
  return value;
}

function parseDatabaseUrl(value, key) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid PostgreSQL URL`);
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1)) {
    throw new Error(`${key} must include a PostgreSQL user, host, and database`);
  }
  return url;
}

function decodedUsername(url, key) {
  try {
    return decodeURIComponent(url.username);
  } catch {
    throw new Error(`${key} contains an invalid encoded username`);
  }
}

export function readRoleProvisionConfig(env = process.env) {
  const appRole = required(env, 'APP_DB_USER');
  const appPassword = required(env, 'APP_DB_PASSWORD');
  const platformAdminCapability = required(env, 'PLATFORM_ADMIN_DB_CONTEXT_SECRET');
  const adminUrl = parseDatabaseUrl(required(env, 'MIGRATION_DATABASE_URL'), 'MIGRATION_DATABASE_URL');
  const adminRole = decodedUsername(adminUrl, 'MIGRATION_DATABASE_URL');
  let adminPassword;
  try {
    adminPassword = decodeURIComponent(adminUrl.password);
  } catch {
    throw new Error('MIGRATION_DATABASE_URL contains an invalid encoded password');
  }

  if (!roleNamePattern.test(appRole)) {
    throw new Error('APP_DB_USER must be a lowercase PostgreSQL identifier with at most 63 characters');
  }
  if (appRole === adminRole || appRole === String(env.POSTGRES_USER ?? '').trim()) {
    throw new Error('APP_DB_USER must be distinct from the migration/owner role');
  }
  if (appPassword === adminPassword || appPassword === String(env.POSTGRES_PASSWORD ?? '')) {
    throw new Error('APP_DB_PASSWORD must be distinct from the migration/owner password');
  }

  const runtimeUrlValue = String(env.DATABASE_URL ?? '').trim();
  let runtimeUrl;
  if (runtimeUrlValue) {
    runtimeUrl = parseDatabaseUrl(runtimeUrlValue, 'DATABASE_URL');
    if (decodedUsername(runtimeUrl, 'DATABASE_URL') !== appRole) {
      throw new Error('DATABASE_URL must authenticate as APP_DB_USER');
    }
    if (decodeURIComponent(runtimeUrl.password) !== appPassword) {
      throw new Error('DATABASE_URL must authenticate with APP_DB_PASSWORD');
    }
  } else {
    runtimeUrl = new URL(adminUrl);
    runtimeUrl.username = appRole;
    runtimeUrl.password = appPassword;
  }

  const sanitizedAdminUrl = new URL(adminUrl);
  sanitizedAdminUrl.password = '';

  return {
    appPassword,
    appRole,
    platformAdminCapability,
    adminPassword,
    migrationDatabaseUrl: adminUrl.toString(),
    runtimeDatabaseUrl: runtimeUrl.toString(),
    sanitizedAdminUrl: sanitizedAdminUrl.toString(),
  };
}

async function runtimeCredentialWorks(config, env) {
  try {
    await runBoundedProcess(
      process.execPath,
      [prismaCli, 'db', 'execute', '--schema', schemaPath, '--stdin'],
      {
        cwd: root,
        env: { ...env, DATABASE_URL: config.runtimeDatabaseUrl },
        input: 'SELECT 1;\n',
        stdio: ['pipe', 'ignore', 'ignore'],
        timeoutMs: ROLE_PROVISION_COMMAND_TIMEOUT_MS,
        label: 'application database credential preflight',
      },
    );
    return true;
  } catch {
    return false;
  }
}

export async function provisionAppDatabaseRole(env = process.env) {
  const config = readRoleProvisionConfig(env);
  const runtimeCredentialVerified = await runtimeCredentialWorks(config, env);
  await runBoundedProcess(process.execPath, [prismaCli, 'db', 'execute', '--schema', schemaPath, '--stdin'], {
    cwd: root,
    env: {
      ...env,
      DATABASE_URL: config.migrationDatabaseUrl,
    },
    input: buildRoleProvisionSql(config, runtimeCredentialVerified),
    stdio: ['pipe', 'inherit', 'inherit'],
    timeoutMs: ROLE_PROVISION_COMMAND_TIMEOUT_MS,
    label: 'application database role SQL',
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  await provisionAppDatabaseRole();
}
