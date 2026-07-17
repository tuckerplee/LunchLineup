import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const read = (path) => readFileSync(resolve(path), 'utf8');

test('public retention copy matches executable tenant policy windows', () => {
  const runtime = read('apps/api/src/admin/tenant-account-lifecycle.ts');
  const privacy = read('apps/web/app/privacy/page.tsx');

  assert.match(runtime, /archivedTenantApplicationDataDays:\s*30/);
  assert.match(runtime, /databaseBackupDays:\s*35/);
  assert.match(runtime, /securityLogDays:\s*90/);
  assert.match(runtime, /retainedDatabaseRecordYears:\s*7/);

  for (const period of ['30 days', '35 days', '90 days', 'seven years']) {
    assert.match(privacy, new RegExp(period));
  }
});

test('customer cancellation copy preserves paid-period access and does not start deletion', () => {
  const runbook = read('docs/runbooks/data-retention-delete-export.md');
  const commitments = read('docs/compliance/privacy-security.md');

  assert.match(runbook, /keeps workspace access active through the paid period/);
  assert.match(runbook, /without starting the deletion clock/);
  assert.match(commitments, /keeps workspace access active through the paid period/);
  assert.match(commitments, /without starting the deletion clock/);
  assert.doesNotMatch(runbook, /account\/cancel[^\n]*sets status `CANCELLED`/);
  assert.doesNotMatch(commitments, /account\/cancel[^\n]*marks the tenant `CANCELLED`/);
});

test('export and purge privacy controls remain explicit', () => {
  const controller = read('apps/api/src/admin/admin.controller.ts');
  const exportService = read('apps/api/src/admin/tenant-export.service.ts');
  const lifecycle = read('apps/api/src/admin/tenant-account-lifecycle.ts');

  assert.match(controller, /Cache-Control', 'private, no-store'/);
  assert.match(controller, /X-Content-Type-Options', 'nosniff'/);
  assert.match(exportService, /TENANT_EXPORT_DOWNLOADED/);
  assert.match(exportService, /job\.expiresAt\.getTime\(\) <= Date\.now\(\)/);
  assert.match(exportService, /Account export could not be generated\. Please retry or contact support\./);
  const auditProjection = exportService.slice(
    exportService.indexOf('model: "AuditLog"'),
    exportService.indexOf('];', exportService.indexOf('model: "AuditLog"')),
  );
  for (const field of ['actorUserId', 'actorTenantId', 'ipAddress', 'userAgent', 'oldValue', 'newValue']) {
    assert.doesNotMatch(auditProjection, new RegExp(`\\b${field}:\\s*true`));
  }
  assert.match(lifecycle, /onboardingSignupAttempt\.deleteMany/);
  assert.match(lifecycle, /tenantExportJob\.deleteMany/);
});

test('dormant authentication and retained payload privacy boundaries remain scheduled', () => {
  const controller = read('apps/api/src/admin/admin.controller.ts');
  const lifecycle = read('apps/api/src/admin/tenant-account-lifecycle.ts');
  const exportService = read('apps/api/src/admin/tenant-export.service.ts');
  const retentionScript = read('scripts/invoke-retained-record-purge.mjs');
  const runbook = read('docs/runbooks/data-retention-delete-export.md');

  assert.match(lifecycle, /expiredGraceHours: 24/);
  assert.match(lifecycle, /revokedRetentionDays: 30/);
  assert.match(controller, /stage === 'application_data' && !continuation[\s\S]*applyDormantSessionRetention/);
  assert.match(retentionScript, /sessionEligibleCount/);
  assert.match(retentionScript, /sessionPurgedCount/);
  assert.match(runbook, /expired more than 24 hours ago/);
  assert.match(runbook, /revoked more than 30 days ago/);
  assert.match(lifecycle, /redact_retained_tenant_audit_logs/);
  assert.match(exportService, /stripeUsageEvent\.lastError/);
  assert.match(exportService, /notificationOutbox\.lastError/);
  assert.match(exportService, /scheduleSolveJob\.queuePayload/);
});
