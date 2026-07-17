import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { orderMigrationFileNames, shouldApplyMigrationFile } from '../../scripts/apply-db-migrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const historicalSeedMigration = '20260712_rbac_seed_forward_reconciliation.sql';
const baselineMigration = '20260716_rbac_seed_super_admin_forward_reconciliation.sql';
const lifecycleMigration = '20260713_tenant_account_lifecycle_rbac_reconciliation.sql';

function readMigration(file) {
  return readFileSync(join(root, 'packages/db/prisma/migrations', file), 'utf8');
}

test('fresh and upgraded databases apply lifecycle RBAC reconciliation after the baseline seed', () => {
  const baselineSql = readMigration(baselineMigration);
  const lifecycleSql = readMigration(lifecycleMigration);

  assert.equal(shouldApplyMigrationFile(historicalSeedMigration), false);
  assert.equal(shouldApplyMigrationFile(baselineMigration), true);
  assert.equal(shouldApplyMigrationFile(lifecycleMigration), true);
  assert.deepEqual(
    orderMigrationFileNames([lifecycleMigration, baselineMigration]),
    [baselineMigration, lifecycleMigration],
  );
  assert.doesNotMatch(baselineSql, /tenant_account:lifecycle/);
  assert.match(
    lifecycleSql,
    /'tenant_account:lifecycle',\s*'Manage tenant lifecycle',\s*'Cancel or request deletion for a tenant account\.',\s*'ADMIN'/,
  );
});

test('lifecycle reconciliation is duplicate-safe for permission and role grants', () => {
  const sql = readMigration(lifecycleMigration);

  assert.match(sql, /ON CONFLICT \("key"\) DO UPDATE/);
  assert.match(sql, /ON CONFLICT \("roleId", "permissionId"\) DO NOTHING/);
  assert.equal((sql.match(/INSERT INTO "Permission"/g) ?? []).length, 1);
  assert.equal((sql.match(/INSERT INTO "RolePermission"/g) ?? []).length, 1);
});

test('lifecycle reconciliation grants every active system Admin role without expanding custom roles', () => {
  const sql = readMigration(lifecycleMigration);
  const grantSql = sql.slice(sql.indexOf('INSERT INTO "RolePermission"'));

  assert.match(grantSql, /JOIN "Permission" p ON p\."key" = 'tenant_account:lifecycle'/);
  assert.match(grantSql, /WHERE r\."isSystem" = true/);
  assert.match(grantSql, /r\."legacyRole" IN \('SUPER_ADMIN', 'ADMIN'\)/);
  assert.match(grantSql, /r\."deletedAt" IS NULL/);
  assert.doesNotMatch(grantSql, /r\."slug"/);
  assert.doesNotMatch(grantSql, /'MANAGER'|'STAFF'/);
});
