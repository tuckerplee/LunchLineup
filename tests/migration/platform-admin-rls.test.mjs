import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { orderMigrationFileNames } from '../../scripts/apply-db-migrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsRoot = join(root, 'packages/db/prisma/migrations');

function readMigration(file) {
  return readFileSync(join(migrationsRoot, file), 'utf8');
}

function orderedForwardMigrations() {
  return orderMigrationFileNames(
    readdirSync(migrationsRoot)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => !file.startsWith('pre_'))
      .filter((file) => !['init_rls.sql', 'audit_log.sql'].includes(file)),
  );
}

function lastPolicyWriter(ordered, policy) {
  return ordered.findLast((file) => {
    const sql = readMigration(file);
    return sql.includes(`DROP POLICY IF EXISTS ${policy} `) || sql.includes(`'${policy}'`);
  });
}

function canReadDirectTenantRow({ platformAdmin, currentTenant }, rowTenantId) {
  return platformAdmin || rowTenantId === currentTenant;
}

function canReadRoleAssignment(context, assignment, users, roles) {
  if (context.platformAdmin) return true;

  return assignment.tenantId === context.currentTenant
    && users.some((user) => user.id === assignment.userId && user.tenantId === context.currentTenant)
    && roles.some((role) => role.id === assignment.roleId && role.tenantId === context.currentTenant);
}

test('final migration order preserves platform-aware workspace and retention policies', () => {
  const ordered = orderedForwardMigrations();
  const platformSetupIndex = ordered.indexOf('20260709_platform_admin_rls.sql');
  const reconciliationIndex = ordered.indexOf('20260712_core_rls_audit_forward_reconciliation.sql');
  const relationHardeningIndex = ordered.indexOf('rls_relation_hardening.sql');

  assert.ok(platformSetupIndex >= 0 && platformSetupIndex < reconciliationIndex);
  assert.equal(relationHardeningIndex, ordered.length - 1, 'relation RLS hardening must remain the final migration');

  const reconciliation = readMigration(ordered[reconciliationIndex]);
  const relationHardening = readMigration(ordered[relationHardeningIndex]);
  const directTenantPredicate = 'is_current_platform_admin() OR "tenantId" = (SELECT get_current_tenant())';
  const tenantRowPredicate = 'is_current_platform_admin() OR "id" = (SELECT get_current_tenant())';

  for (const policy of [
    'tenant_isolation_policy',
    'user_isolation_policy',
    'location_isolation_policy',
    'schedule_isolation_policy',
    'shift_isolation_policy',
    'time_card_isolation_policy',
    'tenant_setting_isolation_policy',
    'role_isolation_policy',
    'billing_event_isolation_policy',
    'stripe_usage_event_isolation_policy',
    'notification_isolation_policy',
    'webhook_endpoint_isolation_policy',
    'credit_transaction_isolation_policy',
    'audit_log_isolation_policy',
  ]) {
    assert.equal(lastPolicyWriter(ordered, policy), '20260712_core_rls_audit_forward_reconciliation.sql', `${policy} must end with the capability-aware reconciliation definition`);
  }

  assert.equal(lastPolicyWriter(ordered, 'role_assignment_tenant_isolation_policy'), 'rls_relation_hardening.sql');

  assert.match(reconciliation, /IF table_name = 'Tenant'[\s\S]*USING \(is_current_platform_admin\(\) OR "id" = \(SELECT get_current_tenant\(\)\)\) WITH CHECK \(is_current_platform_admin\(\) OR "id" = \(SELECT get_current_tenant\(\)\)\)/);
  assert.equal(reconciliation.split(directTenantPredicate).length - 1, 4, 'dynamic policy and AuditLog must each use the same predicate for reads and writes');

  for (const policy of [
    'session_tenant_isolation_policy',
    'role_permission_tenant_isolation_policy',
    'role_assignment_tenant_isolation_policy',
    'break_tenant_isolation_policy',
  ]) {
    const definition = relationHardening.match(new RegExp(`CREATE POLICY ${policy}\\b[\\s\\S]*?;`))?.[0] ?? '';
    assert.match(definition, /USING \([\s\S]*is_current_platform_admin\(\)[\s\S]*WITH CHECK \([\s\S]*is_current_platform_admin\(\)/, `${policy} must preserve capability-aware read and write checks`);
  }

  for (const table of ['Tenant', 'User', 'Role', 'RoleAssignment', 'AuditLog']) {
    assert.match(relationHardening, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
  }

  assert.ok(reconciliation.includes(tenantRowPredicate));
});

test('platform context reads required cross-tenant rows while tenant context cannot cross boundaries', () => {
  const platformContext = { platformAdmin: true, currentTenant: null };
  const tenantAContext = { platformAdmin: false, currentTenant: 'tenant-a' };
  const users = [
    { id: 'user-a', tenantId: 'tenant-a' },
    { id: 'user-b', tenantId: 'tenant-b' },
  ];
  const roles = [
    { id: 'role-a', tenantId: 'tenant-a' },
    { id: 'role-b', tenantId: 'tenant-b' },
  ];
  const assignmentB = { tenantId: 'tenant-b', userId: 'user-b', roleId: 'role-b' };

  for (const [table, rowTenantId] of [
    ['Tenant', 'tenant-b'],
    ['User', users[1].tenantId],
    ['Role', roles[1].tenantId],
    ['AuditLog', 'tenant-b'],
  ]) {
    assert.equal(canReadDirectTenantRow(platformContext, rowTenantId), true, `platform context must read cross-tenant ${table}`);
    assert.equal(canReadDirectTenantRow(tenantAContext, rowTenantId), false, `tenant context must not read cross-tenant ${table}`);
  }

  assert.equal(canReadRoleAssignment(platformContext, assignmentB, users, roles), true);
  assert.equal(canReadRoleAssignment(tenantAContext, assignmentB, users, roles), false);
  assert.equal(canReadRoleAssignment(tenantAContext, { tenantId: 'tenant-a', userId: 'user-a', roleId: 'role-a' }, users, roles), true);
});
