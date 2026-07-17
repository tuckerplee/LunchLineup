import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const schema = read('packages/db/prisma/schema.prisma');
const migration = read('packages/db/prisma/migrations/20260715_user_suspension_lifecycle.sql');
const lifecycle = read('apps/api/src/admin/admin-user-lifecycle.service.ts');
const rbac = read('apps/api/src/auth/rbac.service.ts');
const controller = read('apps/api/src/admin/admin.controller.ts');
const auth = read('apps/api/src/auth/auth.service.ts');
const capacity = read('apps/api/src/billing/user-capacity.ts');
const uiContract = read('apps/web/app/admin/users/admin-user-lifecycle.ts');
const ui = read('apps/web/app/admin/users/AdminUsersWorkspace.tsx');

test('schema and forward migration model suspension separately from irreversible deletion', () => {
  assert.match(schema, /model User \{[\s\S]*?suspendedAt\s+DateTime\?[\s\S]*?deletedAt\s+DateTime\?/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /CHECK \("deletedAt" IS NULL OR "suspendedAt" IS NULL\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.scrub_deleted_user_row\(\)[\s\S]*?NEW\."suspendedAt" := NULL/);
  assert.match(migration, /CREATE TRIGGER tr_revoke_suspended_user_sessions[\s\S]*?AFTER INSERT OR UPDATE ON public\."User"/);
  assert.match(migration, /UPDATE public\."Session"[\s\S]*?"userId" = NEW\."id" AND "revokedAt" IS NULL/);
  assert.match(migration, /CREATE TRIGGER tr_block_suspended_user_session_auth[\s\S]*?BEFORE INSERT OR UPDATE ON public\."Session"/);
});

test('admin suspension is idempotent, tenant-safe, session-bound, and never writes deletedAt', () => {
  assert.match(controller, /@Post\('users\/:id\/suspend'\)[\s\S]*?this\.userLifecycle\.suspend/);
  assert.match(controller, /@Post\('users\/:id\/activate'\)[\s\S]*?this\.userLifecycle\.activate/);
  assert.match(lifecycle, /this\.rbac\.authorizePlatformAdminUserMutationInTransaction/);
  assert.match(rbac, /orderedTenantIds[\s\S]*?FROM "Tenant"[\s\S]*?ORDER BY "id"[\s\S]*?FOR KEY SHARE/);
  assert.match(rbac, /orderedUserIds[\s\S]*?FROM "User"[\s\S]*?ORDER BY "id"[\s\S]*?FOR UPDATE/);
  assert.match(rbac, /FROM "Session"[\s\S]*?"id" = \$\{actorSessionId\}[\s\S]*?"userId" = \$\{actorUserId\}[\s\S]*?FOR UPDATE/);
  assert.match(rbac, /FROM "RoleAssignment"[\s\S]*?ORDER BY "tenantId", "userId", "roleId"[\s\S]*?FOR UPDATE/);
  assert.match(rbac, /private async lockPlatformRolesForAssignmentMutation[\s\S]*?FROM "Role"[\s\S]*?ORDER BY "id"[\s\S]*?FOR UPDATE/);
  assert.match(rbac, /private async lockRoleMutationPermissions[\s\S]*?FROM "RolePermission"[\s\S]*?ORDER BY "roleId", "permissionId"[\s\S]*?FOR UPDATE/);
  const owner = rbac.indexOf('private async lockPlatformAdminMutationIdentityInTransaction');
  const tenantLock = rbac.indexOf('lockRoleMutationTenants', owner);
  const userLock = rbac.indexOf('FROM "User"', owner);
  const sessionLock = rbac.indexOf('FROM "Session"', owner);
  const authorizationOwner = rbac.indexOf('authorizePlatformAdminUserMutationInTransaction');
  const assignmentLock = rbac.indexOf('lockPlatformRoleMutationAssignments', authorizationOwner);
  const roleLock = rbac.indexOf('lockPlatformRolesForAssignmentMutation', assignmentLock);
  const permissionLock = rbac.indexOf('lockRoleMutationPermissions', roleLock);
  assert.ok(tenantLock < userLock && userLock < sessionLock && sessionLock < assignmentLock && assignmentLock < roleLock && roleLock < permissionLock);
  assert.match(rbac, /const target = users\.find\(\(user\) => user\.id === targetUserId\)/);
  assert.match(lifecycle, /where: \{ userId: target\.id, revokedAt: null \}/);
  assert.match(lifecycle, /where: \{[\s\S]*?id: target\.id,[\s\S]*?tenantId: target\.tenantId,[\s\S]*?deletedAt: null,[\s\S]*?suspendedAt: null/);
  assert.match(lifecycle, /if \(target\.suspendedAt\)[\s\S]*?changed: false/);
  assert.match(lifecycle, /if \(!target\.suspendedAt\)[\s\S]*?changed: false/);
  assert.doesNotMatch(lifecycle, /data:\s*\{[^}]*deletedAt/s);
  assert.doesNotMatch(lifecycle, /data:\s*\{[^}]*(?:passwordHash|pinHash|email|username)/s);
});

test('suspended users are excluded from authentication and active capacity', () => {
  assert.match(auth, /id: userId,[\s\S]*?tenantId,[\s\S]*?deletedAt: null, suspendedAt: null/);
  assert.match(auth, /session\.user\.suspendedAt/);
  assert.match(capacity, /where: \{[\s\S]*?tenantId,[\s\S]*?deletedAt: null,[\s\S]*?suspendedAt: null/);
});

test('admin UI gives deleted state precedence and promises reversibility only for suspension', () => {
  assert.match(uiContract, /if \(user\.deletedAt\) return 'DELETED';[\s\S]*?if \(user\.suspendedAt\) return 'SUSPENDED';/);
  assert.match(uiContract, /status !== 'DELETED'/);
  assert.match(ui, /Suspension is reversible and preserves identity and credentials\. Deletion is irreversible\./);
  assert.match(ui, /\['ALL', 'ACTIVE', 'LOCKED', 'SUSPENDED', 'DELETED'\]/);
});
