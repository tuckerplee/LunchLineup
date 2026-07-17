import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('dormant session retention is privileged, bounded, and excludes active sessions', () => {
  const sql = read('packages/db/prisma/migrations/20260714_session_retention.sql');

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.purge_dormant_sessions/);
  assert.match(sql, /IF NOT public\.is_current_platform_admin\(\)/);
  assert.match(sql, /"expiresAt" <= p_as_of - INTERVAL '24 hours'/);
  assert.match(sql, /"revokedAt" <= p_as_of - INTERVAL '30 days'/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /LIMIT p_limit/);
  assert.match(sql, /DELETE FROM public\."Session"/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.purge_dormant_sessions/);
});

test('schema and scheduled retention endpoint expose the session cleanup contract', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const lifecycle = read('apps/api/src/admin/tenant-account-lifecycle.ts');
  const controller = read('apps/api/src/admin/admin.controller.ts');

  assert.match(schema, /model Session[\s\S]*@@index\(\[revokedAt\]\)/);
  assert.match(schema, /model RefreshTokenReplay[\s\S]*onDelete: Cascade/);
  assert.match(lifecycle, /applyDormantSessionRetention/);
  assert.match(lifecycle, /expiredGraceHours: 24/);
  assert.match(lifecycle, /revokedRetentionDays: 30/);
  assert.match(controller, /applyDormantSessionRetention\(tx, asOf, dryRun\)/);
});
