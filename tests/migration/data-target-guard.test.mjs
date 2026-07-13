import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertDevelopmentSeedTarget,
  assertE2ESeedTarget,
  assertLegacyImportTarget,
  assertMigrationDeploymentTarget,
} from '../../scripts/data-target-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

test('E2E and development seeds accept only explicit non-production scopes', () => {
  const localDatabase = 'postgresql://root:test@localhost:5432/lunchlineup_test';
  assert.equal(assertE2ESeedTarget({ DATA_TARGET_ENV: 'test', DATABASE_URL: localDatabase }), 'test');
  assert.equal(assertE2ESeedTarget({ DATA_TARGET_ENV: 'disposable', DATABASE_URL: localDatabase }), 'disposable');
  assert.throws(() => assertE2ESeedTarget({}), /DATA_TARGET_ENV/);
  assert.throws(
    () => assertE2ESeedTarget({ DATA_TARGET_ENV: 'production', ALLOW_PRODUCTION_SEED: 'true' }),
    /test, disposable/,
  );

  assert.equal(assertDevelopmentSeedTarget({ DATA_TARGET_ENV: 'development', DATABASE_URL: localDatabase }), 'development');
  assert.throws(
    () => assertDevelopmentSeedTarget({ DATA_TARGET_ENV: 'production', ALLOW_PRODUCTION_SEED: 'true' }),
    /test, disposable, development/,
  );
  assert.throws(
    () => assertE2ESeedTarget({
      DATA_TARGET_ENV: 'disposable',
      DATABASE_URL: 'postgresql://app@production-db.internal:5432/lunchlineup',
    }),
    /production-like/,
  );
  assert.throws(
    () => assertDevelopmentSeedTarget({
      DATA_TARGET_ENV: 'development',
      DATABASE_URL: localDatabase,
      NODE_ENV: 'production',
    }),
    /production-like/,
  );
});

test('production legacy import requires exact confirmation and verified source SHA-256', () => {
  const sourceSha256 = 'a'.repeat(64);
  const baseEnv = {
    DATA_TARGET_ENV: 'production-cutover',
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app@db.internal:5432/lunchlineup',
  };

  assert.throws(
    () => assertLegacyImportTarget({ env: baseEnv, actualSourceSha256: sourceSha256 }),
    /LEGACY_IMPORT_PRODUCTION_CONFIRM=import-legacy-users-production-cutover/,
  );
  assert.throws(
    () => assertLegacyImportTarget({
      env: {
        ...baseEnv,
        LEGACY_IMPORT_PRODUCTION_CONFIRM: 'import-legacy-users-production-cutover',
        LEGACY_SOURCE_EXPORT_SHA256: 'not-a-sha',
      },
      actualSourceSha256: sourceSha256,
    }),
    /exactly 64 hexadecimal characters/,
  );
  assert.throws(
    () => assertLegacyImportTarget({
      env: {
        ...baseEnv,
        LEGACY_IMPORT_PRODUCTION_CONFIRM: 'import-legacy-users-production-cutover',
        LEGACY_SOURCE_EXPORT_SHA256: 'b'.repeat(64),
      },
      actualSourceSha256: sourceSha256,
    }),
    /does not match/,
  );
  assert.equal(
    assertLegacyImportTarget({
      env: {
        ...baseEnv,
        LEGACY_IMPORT_PRODUCTION_CONFIRM: 'import-legacy-users-production-cutover',
        LEGACY_SOURCE_EXPORT_SHA256: sourceSha256,
      },
      actualSourceSha256: sourceSha256,
    }),
    'production-cutover',
  );
});

test('migration deployment context is explicit, including production', () => {
  assert.throws(
    () => assertMigrationDeploymentTarget({ NODE_ENV: 'production' }),
    /DATA_TARGET_ENV/,
  );
  assert.equal(
    assertMigrationDeploymentTarget({
      DATA_TARGET_ENV: 'production',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app@db.internal:5432/lunchlineup',
      MIGRATION_PRODUCTION_CONFIRM: 'apply-lunchlineup-production-migrations',
    }),
    'production',
  );
  assert.throws(
    () => assertMigrationDeploymentTarget({
      DATA_TARGET_ENV: 'production',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app@db.internal:5432/lunchlineup',
    }),
    /MIGRATION_PRODUCTION_CONFIRM/,
  );
});

test('entry points run target guards before loading or invoking Prisma', () => {
  const e2eSeed = read('scripts/seed-e2e.mjs');
  const legacyImport = read('scripts/import-legacy-users.mjs');
  const developmentSeed = read('packages/db/prisma/seed.ts');
  const migrations = read('scripts/apply-db-migrations.mjs');

  assert.ok(e2eSeed.indexOf('assertE2ESeedTarget(process.env)') < e2eSeed.indexOf("await import('@prisma/client')"));
  assert.doesNotMatch(e2eSeed, /import\s+\{[^}]*PrismaClient[^}]*\}\s+from\s+'@prisma\/client'/);

  assert.ok(legacyImport.indexOf('assertLegacyImportTarget') < legacyImport.indexOf("await import('@prisma/client')"));
  assert.doesNotMatch(legacyImport, /from\s+'@prisma\/client'/);

  assert.ok(developmentSeed.indexOf('execFileSync') < developmentSeed.indexOf("require('@lunchlineup/db')"));
  assert.doesNotMatch(developmentSeed, /ALLOW_PRODUCTION_SEED/);

  assert.ok(
    migrations.indexOf('const deploymentTarget = assertMigrationDeploymentTarget') < migrations.indexOf('requireMigrationDatabaseUrl();'),
  );
});

test('E2E seed rejects a missing scope before Prisma is loaded', () => {
  const env = { ...process.env };
  delete env.DATA_TARGET_ENV;
  const result = spawnSync(process.execPath, ['scripts/seed-e2e.mjs'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /E2E seed requires DATA_TARGET_ENV/);
});

test('legacy import and migration wrapper reject missing context before Prisma work', () => {
  const env = { ...process.env, DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' };
  delete env.DATA_TARGET_ENV;
  const tempRoot = mkdtempSync(join(tmpdir(), 'lunchlineup-data-target-'));
  const exportPath = join(tempRoot, 'legacy-export.json');
  writeFileSync(exportPath, '{}');

  try {
    const legacyResult = spawnSync(process.execPath, ['scripts/import-legacy-users.mjs', exportPath], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(legacyResult.status, 0);
    assert.match(`${legacyResult.stdout}\n${legacyResult.stderr}`, /Legacy import requires DATA_TARGET_ENV/);

    const migrationResult = spawnSync(process.execPath, ['scripts/apply-db-migrations.mjs'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(migrationResult.status, 0);
    assert.match(`${migrationResult.stdout}\n${migrationResult.stderr}`, /Database migration requires DATA_TARGET_ENV/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('VM107 bootstrap requires exact confirmation immediately before delete and restore', () => {
  const bootstrap = read('scripts/bootstrap-vm107-dev.sh');
  assert.match(bootstrap, /VM107_DESTRUCTIVE_CONFIRM:-.*DESTRUCTIVE_CONFIRMATION/);
  assert.match(bootstrap, /upsert_env DATA_TARGET_ENV disposable/);
  assert.match(bootstrap, /require_root\s+if \[\[ ! -d "\$APP_DIR\/\.git" \|\| -n "\$BACKUP_FILE" \]\]; then\s+require_destructive_confirmation/);
  assert.match(bootstrap, /require_destructive_confirmation\s+rm -rf "\$APP_DIR"/);
  assert.match(bootstrap, /require_destructive_confirmation\s+echo "Restoring Postgres data/);
});
