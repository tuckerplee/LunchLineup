import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const supersededRawMigrations = new Set([
  'init_rls.sql',
  'audit_log.sql',
  '20260310_username_pin_auth.sql',
  '20260325_rbac_roles_permissions.sql',
  '20260712_rbac_seed_forward_reconciliation.sql',
]);

export function migrationRank(file) {
  if (file === '20260712_tenant_context_helpers.sql') return 1;
  if (file === '20260709_platform_admin_rls.sql') return 2;
  if (file === '20260716_rbac_seed_super_admin_forward_reconciliation.sql') return 3;
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
    && !supersededRawMigrations.has(file);
}

export function shouldApplyPreMigrationFile(file) {
  return file.startsWith('pre_')
    && file.endsWith('.sql')
    && !supersededRawMigrations.has(file);
}

function normalizedRelativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function assertLedgerOwnedTransaction(sql, relativePath) {
  const transactionControl = sql.match(
    /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)(?:\s+WORK|\s+TRANSACTION)?\s*;/im,
  );
  if (transactionControl) {
    throw new Error(
      `Raw migration contains top-level transaction control owned by the ledger runner: ${relativePath}`,
    );
  }
}

function entry(root, migrationsRoot, fileName, phase) {
  const absolutePath = join(migrationsRoot, fileName);
  const bytes = readFileSync(absolutePath);
  const sql = bytes.toString('utf8');
  const relativePath = normalizedRelativePath(root, absolutePath);
  assertLedgerOwnedTransaction(sql, relativePath);
  return {
    absolutePath,
    bytes: bytes.length,
    fileName,
    phase,
    relativePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sql,
  };
}

export function buildRawMigrationInventory(root, migrationsRoot) {
  const names = readdirSync(migrationsRoot);
  const pre = orderMigrationFileNames(names.filter(shouldApplyPreMigrationFile))
    .map((fileName) => entry(root, migrationsRoot, fileName, 'pre'));
  const post = orderMigrationFileNames(names.filter(shouldApplyMigrationFile))
    .map((fileName) => entry(root, migrationsRoot, fileName, 'post'));
  return { all: [...pre, ...post], post, pre };
}
