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

test('forward audit redaction migration preserves the separately scoped expiry-delete capability', () => {
  const sql = read('packages/db/prisma/migrations/20260711_zz_audit_log_user_redaction.sql');

  assert.match(sql, /TG_OP = 'DELETE'/);
  assert.match(sql, /current_setting\('app\.allow_audit_log_delete', true\) = 'retention_expired'/);
  assert.match(sql, /RETURN OLD/);
});

test('effective lexical migration order preserves the restricted audit userId redaction branch', () => {
  const migrationsRoot = join(root, 'packages/db/prisma/migrations');
  const ordered = orderMigrationFileNames(
    readdirSync(migrationsRoot)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => !file.startsWith('pre_'))
      .filter((file) => !['init_rls.sql', 'audit_log.sql'].includes(file)),
  );
  const functionWriters = ordered.filter((file) => (
    read(join('packages/db/prisma/migrations', file))
      .includes('CREATE OR REPLACE FUNCTION block_audit_log_modification()')
  ));

  assert.equal(
    functionWriters.at(-1),
    '20260712_core_rls_audit_forward_reconciliation.sql',
    'the reconciliation migration must remain the effective audit trigger function writer',
  );

  const effectiveSql = read(join('packages/db/prisma/migrations', functionWriters.at(-1)));
  assert.match(effectiveSql, /TG_OP = 'UPDATE'/);
  assert.match(effectiveSql, /AND public\.is_current_platform_admin\(\)/);
  assert.match(effectiveSql, /current_setting\('app\.audit_log_user_redaction_tenant', true\) = OLD\."tenantId"/);
  assert.match(effectiveSql, /OLD\."userId" IS NOT NULL/);
  assert.match(effectiveSql, /NEW\."userId" IS NULL/);
  assert.match(effectiveSql, /ROW\([\s\S]*NEW\."id"[\s\S]*\) IS NOT DISTINCT FROM ROW\([\s\S]*OLD\."id"/);
  assert.match(effectiveSql, /RAISE EXCEPTION 'Audit logs are append-only and cannot be modified or deleted\.'/);
});
