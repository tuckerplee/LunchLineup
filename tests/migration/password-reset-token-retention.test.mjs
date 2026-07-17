import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const migration = read('packages/db/prisma/migrations/20260714_password_reset_token_retention.sql');

test('terminal password-reset token retention is capability-gated and bounded', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.purge_expired_password_reset_tokens/);
  assert.match(migration, /IF NOT public\.is_current_platform_admin\(\)/);
  assert.match(migration, /p_limit < 1 OR p_limit > 10000/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/);
  assert.match(migration, /LIMIT p_limit/);
  assert.match(migration, /DELETE FROM public\."PasswordResetToken"/);
  assert.match(migration, /SECURITY DEFINER SET search_path = pg_catalog, public/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.purge_expired_password_reset_tokens[\s\S]*FROM PUBLIC/);
});

test('the fixed terminal grace preserves active unexpired reset credentials', () => {
  assert.match(migration, /COALESCE\(token\."consumedAt", token\."expiresAt"\)[\s\S]*<= p_as_of - INTERVAL '24 hours'/);
  assert.match(migration, /PasswordResetToken_retentionDeadline_id_idx/);
  assert.doesNotMatch(migration, /UPDATE public\."PasswordResetToken"/);

  const schema = read('packages/db/prisma/schema.prisma');
  assert.match(schema, /model PasswordResetToken[\s\S]*tokenHash\s+String\s+@unique/);
  assert.match(schema, /model PasswordResetToken[\s\S]*expiresAt\s+DateTime/);
  assert.match(schema, /model PasswordResetToken[\s\S]*consumedAt\s+DateTime\?/);
});

test('the daily application-data owner reports dry-run and purge counts', () => {
  const lifecycle = read('apps/api/src/admin/tenant-account-lifecycle.ts');
  const controller = read('apps/api/src/admin/admin.controller.ts');
  const runbook = read('docs/runbooks/data-retention-delete-export.md');

  assert.match(lifecycle, /PASSWORD_RESET_TOKEN_RETENTION_POLICY[\s\S]*terminalGraceHours: 24[\s\S]*batchLimit: 5_000/);
  assert.match(lifecycle, /applyPasswordResetTokenRetention[\s\S]*purge_expired_password_reset_tokens/);
  assert.match(controller, /stage === 'application_data' && !continuation[\s\S]*applyPasswordResetTokenRetention/);
  assert.match(controller, /passwordResetTokenRetention,/);
  assert.match(runbook, /password-reset token hashes/i);
});