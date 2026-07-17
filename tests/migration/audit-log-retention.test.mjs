import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { orderMigrationFileNames } from '../../scripts/apply-db-migrations.mjs';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

test('forward audit redaction migration grants only a fail-closed purge-time userId nulling capability', () => {
  const sql = read('packages/db/prisma/migrations/20260711_zz_audit_log_user_redaction.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(migrationsReadme, /20260711_zz_audit_log_user_redaction\.sql/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION set_audit_log_user_redaction_tenant\(target_tenant_id TEXT\)/);
  assert.match(sql, /IF NOT public\.is_current_platform_admin\(\)/);
  assert.match(sql, /"status" = 'PURGED'::public\."TenantStatus"/);
  assert.match(sql, /"deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 days'/);
  assert.match(sql, /"applicationDataPurgedAt" IS NULL/);
  assert.match(sql, /set_config\('app\.audit_log_user_redaction_tenant', target_tenant_id, true\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION set_audit_log_user_redaction_tenant\(TEXT\) FROM PUBLIC/);
  assert.match(sql, /current_setting\('app\.audit_log_user_redaction_tenant', true\) = OLD\."tenantId"/);
  assert.match(sql, /AND public\.is_current_platform_admin\(\)/);
  assert.match(sql, /OLD\."userId" IS NOT NULL/);
  assert.match(sql, /NEW\."userId" IS NULL/);
  assert.match(sql, /ROW\([\s\S]*NEW\."id"[\s\S]*\) IS NOT DISTINCT FROM ROW\([\s\S]*OLD\."id"/);
  assert.match(sql, /RAISE EXCEPTION 'Audit logs are append-only and cannot be modified or deleted\.'/);
});

test('effective audit retention migration permits deletion only inside the authorized owner function', () => {
  const sql = read('packages/db/prisma/migrations/20260713_audit_log_retention_authorization.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(migrationsReadme, /20260713_audit_log_retention_authorization\.sql/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.purge_expired_audit_logs\(target_tenant_id TEXT\)/);
  assert.match(sql, /IF NOT public\.is_current_platform_admin\(\)/);
  assert.match(sql, /"status" = 'PURGED'::public\."TenantStatus"/);
  assert.match(sql, /"deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '7 years'/);
  assert.match(sql, /"applicationDataPurgedAt" IS NOT NULL/);
  assert.match(sql, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.purge_expired_audit_logs\(TEXT\) FROM PUBLIC/);
  assert.match(sql, /'app\.audit_log_retention_txid'/);
  assert.match(sql, /pg_catalog\.txid_current\(\)::TEXT/);
  assert.match(sql, /CURRENT_USER = \([\s\S]*purge_expired_audit_logs\(text\)/);
  assert.match(sql, /AND public\.is_current_platform_admin\(\)/);
  assert.doesNotMatch(sql, /app\.allow_audit_log_delete/);
});

test('effective lexical migration order preserves redaction and secured retention deletion', () => {
  const migrationsRoot = join(root, 'packages/db/prisma/migrations');
  const ordered = orderMigrationFileNames(
    readdirSync(migrationsRoot)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => !file.startsWith('pre_'))
      .filter((file) => !['init_rls.sql', 'audit_log.sql'].includes(file)),
  );
  const functionWriters = ordered.filter((file) => {
    const sql = read(join('packages/db/prisma/migrations', file));
    return sql.includes('CREATE OR REPLACE FUNCTION public.block_audit_log_modification()')
      || sql.includes('CREATE OR REPLACE FUNCTION block_audit_log_modification()');
  });

  assert.equal(
    functionWriters.at(-1),
    '20260713_audit_log_retention_authorization.sql',
    'the secured retention migration must remain the effective audit trigger function writer',
  );

  const effectiveSql = read(join('packages/db/prisma/migrations', functionWriters.at(-1)));
  assert.match(effectiveSql, /TG_OP = 'DELETE'/);
  assert.match(effectiveSql, /purge_expired_audit_logs\(text\)/);
  assert.match(effectiveSql, /TG_OP = 'UPDATE'/);
  assert.match(effectiveSql, /current_setting\('app\.audit_log_user_redaction_tenant', TRUE\) = OLD\."tenantId"/);
  assert.match(effectiveSql, /OLD\."userId" IS NOT NULL/);
  assert.match(effectiveSql, /NEW\."userId" IS NULL/);
  assert.match(effectiveSql, /ROW\([\s\S]*NEW\."id"[\s\S]*\) IS NOT DISTINCT FROM ROW\([\s\S]*OLD\."id"/);
  assert.match(effectiveSql, /RAISE EXCEPTION 'Audit logs are append-only and cannot be modified or deleted\.'/);
  assert.doesNotMatch(effectiveSql, /app\.allow_audit_log_delete/);
});

test('application retention caller uses only the secured database function', () => {
  const source = read('apps/api/src/admin/tenant-account-lifecycle.ts');

  assert.match(source, /SELECT public\.purge_expired_audit_logs\(\$\{tenantId\}\)/);
  assert.doesNotMatch(source, /app\.allow_audit_log_delete/);
  assert.doesNotMatch(source, /tx\.auditLog\.deleteMany/);
});

test('retained audits preserve immutable event evidence with pseudonymous attribution', () => {
  const sql = read('packages/db/prisma/migrations/20260713_audit_log_retention_authorization.sql');
  const lifecycle = read('apps/api/src/admin/tenant-account-lifecycle.ts');

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.audit_actor_pseudonym/);
  assert.match(sql, /'deleted-user:' \|\| encode/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.redact_retained_tenant_audit_logs/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.redact_deleted_user_audit_records/);
  assert.match(sql, /"deletedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 days'/);
  for (const field of ['oldValue', 'newValue', 'ipAddress', 'userAgent']) {
    assert.match(sql, new RegExp(`"${field}" = NULL`));
  }
  assert.match(sql, /NEW\."actorUserId" LIKE 'deleted-user:%'/);
  assert.match(sql, /NEW\."action"[\s\S]*NEW\."resource"[\s\S]*NEW\."resourceId"[\s\S]*NEW\."createdAt"/);
  assert.match(lifecycle, /SELECT public\.redact_retained_tenant_audit_logs\(\$\{tenantId\}\)/);
});
