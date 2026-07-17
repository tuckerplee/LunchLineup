import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { orderMigrationFileNames } from '../../scripts/apply-db-migrations.mjs';

const root = process.cwd();
const migrationsRoot = join(root, 'packages/db/prisma/migrations');
const migrationName = '20260716_zzzz_tenant_data_governance_p1.sql';
const read = (path) => readFileSync(join(root, path), 'utf8');
const migration = read(join('packages/db/prisma/migrations', migrationName));
const schema = read('packages/db/prisma/schema.prisma');

function effectiveFunctionWriter(functionName) {
  return orderMigrationFileNames(
    readdirSync(migrationsRoot)
      .filter((file) => file.endsWith('.sql') && !file.startsWith('pre_')),
  ).filter((file) => {
    const sql = read(join('packages/db/prisma/migrations', file));
    return new RegExp(`CREATE OR REPLACE FUNCTION\\s+(?:public\\.)?${functionName}\\s*\\(`).test(sql);
  }).at(-1);
}

test('platform capability proof is null-safe false in the effective forward migration', () => {
  assert.equal(effectiveFunctionWriter('is_current_platform_admin'), migrationName);
  assert.match(migration, /RETURN COALESCE\([\s\S]*current_setting\('app\.platform_admin_proof', TRUE\)[\s\S]*FALSE[\s\S]*\);/);
  assert.match(migration, /LANGUAGE plpgsql STABLE SECURITY DEFINER/);
});

test('every platform retention owner checks capability before data mutation', () => {
  const routines = new Map([
    ['purge_expired_audit_logs', migration],
    ['redact_retained_tenant_audit_logs', migration],
    ['redact_deleted_user_audit_records', migration],
    ['purge_expired_onboarding_signup_attempts', read('packages/db/prisma/migrations/20260714_onboarding_signup_attempt_retention.sql')],
    ['purge_expired_password_reset_tokens', read('packages/db/prisma/migrations/20260714_password_reset_token_retention.sql')],
    ['purge_dormant_sessions', read('packages/db/prisma/migrations/20260714_session_retention.sql')],
    ['purge_staff_invitation_outbox_diagnostics', read('packages/db/prisma/migrations/20260715_staff_invitation_outbox.sql')],
    ['purge_payroll_operational_time_cards', read('packages/db/prisma/migrations/20260716_payroll_controls.sql')],
    ['purge_expired_payroll_records', read('packages/db/prisma/migrations/20260716_payroll_controls.sql')],
  ]);

  for (const [name, sql] of routines) {
    const start = sql.search(new RegExp(`CREATE OR REPLACE FUNCTION\\s+public\\.${name}\\s*\\(`));
    assert.notEqual(start, -1, `${name} definition is missing`);
    const body = sql.slice(start, sql.indexOf('REVOKE ALL ON FUNCTION', start));
    const guard = body.search(/is_current_platform_admin\(\)(?: IS NOT TRUE)?/);
    const mutation = body.search(/\b(?:DELETE FROM|UPDATE)\b/);
    assert.ok(guard >= 0, `${name} lacks a platform capability guard`);
    assert.ok(mutation === -1 || guard < mutation, `${name} mutates before checking capability`);
  }
});

test('audit purge and redaction owners cannot cross an active tenant legal hold', () => {
  for (const name of [
    'purge_expired_audit_logs',
    'redact_retained_tenant_audit_logs',
    'redact_deleted_user_audit_records',
  ]) {
    assert.equal(effectiveFunctionWriter(name), migrationName);
  }
  assert.equal((migration.match(/"retentionLegalHoldAt" IS NULL/g) ?? []).length, 3);
  assert.match(migration, /audit-log user redaction is blocked by tenant retention policy/);
  assert.match(migration, /USING ERRCODE = '42501'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.block_audit_actor_identity_modification\(\)/);
  assert.match(migration, /current_setting\('app\.audit_log_redaction_txid', TRUE\)[\s\S]*txid_current\(\)::TEXT/);
  assert.match(migration, /NEW\."actorTenantId" IS NOT DISTINCT FROM OLD\."actorTenantId"/);
  assert.match(migration, /NEW\."actorUserId" LIKE 'deleted-user:%'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.lock_tenant_lifecycle\(target_tenant_id TEXT\)/);
  assert.equal((migration.match(/PERFORM public\.lock_tenant_lifecycle\(target_tenant_id\)/g) ?? []).length, 3);
  assert.match(migration, /invalidate_deleted_user_auth_artifacts\(\)[\s\S]*PERFORM public\.lock_tenant_lifecycle\(NEW\."tenantId"\)[\s\S]*retentionLegalHoldAt[\s\S]*ERRCODE = '42501'/);
});

test('export artifact quotas remain owned until durable cleanup completes', () => {
  const service = read('apps/api/src/admin/tenant-export.service.ts');
  assert.match(service, /TENANT_EXPORT_GLOBAL_QUOTA_BYTES/);
  assert.match(service, /TENANT_EXPORT_PER_TENANT_QUOTA_BYTES/);
  assert.match(service, /pg_advisory_xact_lock\([\s\S]*tenant-export-artifact-quota/);
  assert.match(service, /SUM\(job\."bytes"\)[\s\S]*job\."bytes" > 0[\s\S]*job\."artifactCleanupState" <> 'COMPLETE'/);
  assert.match(service, /SET "state" = 'RUNNING', "bytes" = \$\{this\.options\.maxArtifactBytes\}/);
  assert.match(service, /"artifactCleanupState" = 'PENDING'/);
  assert.match(service, /removeArtifactDurably/);
  assert.match(service, /SET "artifactCleanupState" = 'COMPLETE'[\s\S]*"artifactKey" = NULL,[\s\S]*"bytes" = 0/);
  assert.match(service, /bytes: job\.state === "READY" \? job\.bytes : 0/);
  for (const field of [
    'artifactCleanupState',
    'artifactCleanupOwner',
    'artifactCleanupLeaseExpiresAt',
    'artifactCleanupAttempts',
  ]) {
    assert.match(schema, new RegExp(`\\b${field}\\b`));
  }
  assert.match(schema, /@@index\(\[artifactCleanupState, artifactCleanupLeaseExpiresAt, updatedAt\], map: "TenantExportJob_artifact_cleanup_idx"\)/);
  assert.doesNotMatch(migration, /ADD COLUMN IF NOT EXISTS "artifactCleanup/);
  assert.doesNotMatch(migration, /CREATE INDEX IF NOT EXISTS "TenantExportJob_artifact_cleanup_idx"/);
  assert.match(migration, /CREATE TRIGGER tr_enforce_tenant_export_artifact_cleanup/);
  assert.match(migration, /tenant export artifact cleanup is not complete/);
});

test('blocking tenant legal-hold locks execute through parameterized Prisma writes', () => {
  const service = read('apps/api/src/admin/tenant-account-lifecycle.service.ts');
  const deletion = read('apps/api/src/admin/tenant-deletion-billing.service.ts');
  assert.match(service, /await tx\.\$executeRaw`[\s\S]*SELECT public\.lock_tenant_lifecycle\(\$\{tenantId\}\)/);
  assert.doesNotMatch(service, /await tx\.\$queryRaw`[\s\S]*SELECT public\.lock_tenant_lifecycle\(\$\{tenantId\}\)/);
  assert.match(deletion, /lockTenantDeletion[\s\S]*SELECT public\.lock_tenant_lifecycle\(\$\{tenantId\}\)[\s\S]*billing-checkout:/);
  assert.match(deletion, /actorUserId: actor\.userId,[\s\S]*actorTenantId: actor\.tenantId,[\s\S]*action: 'TENANT_DELETION_BARRIER_COMMITTED'/);
  assert.match(deletion, /actorUserId: barrier\.actorUserId \?\? barrier\.userId,[\s\S]*actorTenantId: barrier\.actorTenantId \?\? barrier\.tenantId,[\s\S]*action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER'/);
});

test('customer cancellation and platform archive use an attributed durable pre-provider intent', () => {
  const service = read('apps/api/src/admin/tenant-cancellation-lifecycle.service.ts');
  const reconciler = read('apps/api/src/admin/tenant-cancellation-reconciler.processor.ts');
  const appModule = read('apps/api/src/app.module.ts');
  assert.match(service, /internal:tenant-lifecycle-intent:/);
  assert.match(service, /tenantSetting\.upsert/);
  assert.match(service, /'PENDING_PROVIDER'[\s\S]*'PROVIDER_APPLIED'[\s\S]*'FINALIZED'/);
  assert.match(service, /async cancelCustomer\([\s\S]*await this\.store\.prepare\([\s\S]*await this\.reconcilePrepared\(prepared\)/);
  assert.match(service, /async archivePlatform\([\s\S]*await this\.store\.prepare\([\s\S]*await this\.reconcilePrepared\(prepared\)/);
  assert.match(service, /intent-committed|TENANT_CANCELLATION_INTENT_RECORDED_BY_CUSTOMER/);
  assert.match(service, /markProviderApplied[\s\S]*finalize/);
  assert.match(service, /finalStillApplies[\s\S]*if \(finalStillApplies && intent\)/);
  assert.match(service, /assertNoLifecycleBarrier/);
  assert.match(service, /for \(const candidate of candidates\)[\s\S]*await this\.lockTenantLifecycle\(tx, candidate\.tenantId\)[\s\S]*SELECT setting\."value"[\s\S]*FOR UPDATE[\s\S]*intent = parseIntentSetting\(lockedRows\[0\]\.value\)/);
  assert.match(service, /UPDATE "TenantSetting" setting[\s\S]*'providerLeaseOwner'[\s\S]*setting\."value"->>'operationId' = \$\{intent\.operationId\}[\s\S]*RETURNING setting\."value"/);
  assert.match(reconciler, /while \(claimed < this\.batchSize\)[\s\S]*\[prepared\] = await this\.source\.claimRecoverable\([\s\S]*1,[\s\S]*attemptedOperationIds,[\s\S]*await this\.source\.reconcilePrepared\(prepared\)/);
  assert.match(reconciler, /claimRecoverable: \(limit, excludedOperationIds\) =>[\s\S]*store\.claimRecoverable\(limit, excludedOperationIds\)[\s\S]*reconcilePrepared: \(prepared\) => lifecycle\.reconcilePrepared\(prepared\)/);
  assert.match(appModule, /import \{ TenantCancellationReconcilerService \} from '.\/admin\/tenant-cancellation-reconciler\.processor'/);
  assert.match(appModule, /providers:[\s\S]*TenantCancellationReconcilerService/);
  assert.match(service, /Tenant billing lifecycle is pending reconciliation\./);
  assert.doesNotMatch(service, /stripeSubscriptionId:\s*result\.stripeSubscriptionId/);
});

test('export READY follows the complete durable publication sequence and snapshot watermark capture', () => {
  const service = read('apps/api/src/admin/tenant-export.service.ts');
  assert.match(service, /SELECT CURRENT_TIMESTAMP AS "watermark"/);
  assert.match(service, /closeWriter\(writer!\)[\s\S]*syncFile\(partialPath\)[\s\S]*atomicRename\(partialPath, finalPath\)[\s\S]*syncArtifactDirectory\(\)[\s\S]*state: "READY"/);
  assert.match(service, /state: "READY",[\s\S]*watermark: snapshotWatermark/);
});
