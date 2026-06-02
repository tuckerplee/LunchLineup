import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function exists(path) {
  return existsSync(join(root, path));
}

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

test('legacy PHP source includes the business-critical workflow endpoints', () => {
  const required = [
    'old/public/login.php',
    'old/public/logout.php',
    'old/public/app.php',
    'old/public/print_pdf.php',
    'old/public/api/auth.php',
    'old/public/api/schedule.php',
    'old/public/api/print_schedule.php',
    'old/public/api/import_pdf.php',
    'old/public/admin/index.php',
    'old/public/superadmin/index.php',
    'old/public/superadmin-api/backup.php',
    'old/scripts/backup.php',
    'old/scripts/restore.php',
    'old/scripts/schema.sql',
  ];

  assert.deepEqual(required.filter((path) => !exists(path)), []);
});

test('legacy PHP tests cover auth, tenant scoping, schedules, print, admin, and hygiene behaviors', () => {
  const requiredTests = [
    'old/tests/login_lockout_test.php',
    'old/tests/permission_check_test.php',
    'old/tests/store_company_workflow_test.php',
    'old/tests/user_store_switch_test.php',
    'old/tests/staff_admin_filter_test.php',
    'old/tests/schedule_admin_reject_test.php',
    'old/tests/schedule_parser_company_filter_test.php',
    'old/tests/print_schedule_chore_assignment_test.php',
    'old/tests/sanitization_test.php',
    'old/tests/invalid_json_body_test.php',
  ];

  assert.deepEqual(requiredTests.filter((path) => !exists(path)), []);
});

test('TypeScript platform exposes health, auth, tenant-scoped schedule, admin, and settings surfaces', () => {
  const required = [
    'apps/api/src/app.controller.ts',
    'apps/api/src/auth/auth.controller.ts',
    'apps/api/src/auth/jwt-auth.guard.ts',
    'apps/api/src/auth/rbac.guard.ts',
    'apps/api/src/schedules/schedules.controller.ts',
    'apps/api/src/admin/admin.controller.ts',
    'apps/api/src/settings/settings.controller.ts',
    'apps/web/tests/e2e/core-flows.spec.ts',
  ];

  assert.deepEqual(required.filter((path) => !exists(path)), []);

  assert.match(read('apps/api/src/app.controller.ts'), /@Get\('health'\)/);
  assert.match(read('apps/api/src/schedules/schedules.controller.ts'), /tenantId:\s*req\.user\.tenantId/);
  assert.match(read('apps/api/src/auth/rbac.guard.ts'), /requiredPermission/);
  assert.match(read('apps/api/src/auth/jwt-auth.guard.ts'), /CSRF validation failed/);
});

test('database schema contains SaaS tenant, role, audit, schedule, and billing foundations', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  for (const expected of [
    'model Tenant',
    'model User',
    'model Role',
    'model Permission',
    'model AuditLog',
    'model Schedule',
    'model Shift',
    'model BillingEvent',
    'tenantId',
  ]) {
    assert.match(schema, new RegExp(expected));
  }
});

test('migration parity documentation captures workflows that must be proven before cutover', () => {
  const doc = read('docs/testing/README.md');
  for (const workflow of [
    'login',
    'schedule edit/save',
    'print',
    'PDF import',
    'admin',
    'superadmin',
    'backup/restore',
    'tenant scoping',
    'deploy-source verification',
  ]) {
    assert.match(doc, new RegExp(workflow, 'i'));
  }
});
