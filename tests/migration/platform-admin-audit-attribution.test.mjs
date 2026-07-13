import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

test('platform audit attribution preserves target user semantics and immutable actor identity', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const sql = read('packages/db/prisma/migrations/20260712_platform_admin_audit_actor_attribution.sql');
  const migrationsReadme = read('packages/db/prisma/migrations/README.md');

  assert.match(schema, /model AuditLog \{[\s\S]*userId\s+String\?[\s\S]*actorUserId\s+String\?[\s\S]*actorTenantId\s+String\?/);
  assert.match(schema, /@@index\(\[actorTenantId, actorUserId\]\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "actorUserId" TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "actorTenantId" TEXT/);
  assert.doesNotMatch(sql, /REFERENCES\s+"(?:User|Tenant)"/i);
  assert.match(sql, /BEFORE UPDATE OF "actorUserId", "actorTenantId" ON "AuditLog"/);
  assert.match(sql, /RAISE EXCEPTION 'Audit actor identity is immutable\.'/);
  assert.doesNotMatch(sql, /(?:CREATE|DROP) POLICY|ROW LEVEL SECURITY/i);
  assert.match(migrationsReadme, /20260712_platform_admin_audit_actor_attribution\.sql/);
});
