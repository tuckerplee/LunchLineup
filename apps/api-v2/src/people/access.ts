import { Prisma, type UserRole } from '@prisma/client';
import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';

export const MAX_CUSTOM_ROLES_PER_TENANT = 100;
export const MAX_ROLES_PER_USER = 100;

const SYSTEM_EMAIL_DOMAIN = 'staff.lunchlineup.local';
const PROTECTED_PERMISSION_KEYS = new Set([
  'admin_portal:access',
  'tenant_account:lifecycle',
  'account:data_export',
]);

const ROLE_RANK: Record<UserRole, number> = {
  STAFF: 1,
  MANAGER: 2,
  ADMIN: 3,
  SUPER_ADMIN: 4,
};

export type RoleWithPermissions = {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  description: string | null;
  isSystem: boolean;
  isDefault: boolean;
  legacyRole: UserRole | null;
  deletedAt?: Date | null;
  rolePermissions: Array<{ permission: { key: string } }>;
  _count?: { assignments: number };
};

export type LockedUser = {
  id: string;
  publicId: string;
  role: UserRole;
  name: string;
  email: string | null;
  username: string | null;
  suspendedAt: Date | null;
  deletedAt: Date | null;
  lockedUntil: Date | null;
  pinLockedUntil: Date | null;
};

export type AccessSnapshot = {
  roles: RoleWithPermissions[];
  permissions: Set<string>;
  legacyRole: UserRole;
  rank: number;
  isSystemAdmin: boolean;
};

export type MutationAuthority = {
  actor: LockedUser;
  actorAccess: AccessSnapshot;
  target?: LockedUser;
  targetAccess?: AccessSnapshot;
};

function forbidden(detail: string): ProblemError {
  return new ProblemError(403, 'permission_denied', detail, 'Forbidden');
}

function notFound(detail: string): ProblemError {
  return new ProblemError(404, 'staff_not_found', detail, 'Staff member not found');
}

function conflict(detail: string): ProblemError {
  return new ProblemError(409, 'concurrent_change', detail, 'Concurrent change');
}

function safeRoleName(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 80);
  return normalized || 'Unknown role';
}

function canonicalPermission(value: string): string {
  return value.trim().toLowerCase();
}

export function isSystemGeneratedEmail(email: string | null): boolean {
  return Boolean(email?.endsWith(`@${SYSTEM_EMAIL_DOMAIN}`));
}

export function safeEmail(email: string | null): string {
  return !email || isSystemGeneratedEmail(email) ? '' : email;
}

export function accessFor(userRole: UserRole, roles: RoleWithPermissions[]): AccessSnapshot {
  const permissions = new Set<string>();
  let legacyRole: UserRole = 'STAFF';
  for (const role of roles) {
    for (const assignment of role.rolePermissions) permissions.add(canonicalPermission(assignment.permission.key));
    if (role.isSystem && role.legacyRole && ROLE_RANK[role.legacyRole] > ROLE_RANK[legacyRole]) {
      legacyRole = role.legacyRole;
    }
  }
  return {
    roles,
    permissions,
    legacyRole,
    rank: ROLE_RANK[legacyRole],
    isSystemAdmin: userRole === 'SUPER_ADMIN'
      && roles.some((role) => role.isSystem && role.legacyRole === 'SUPER_ADMIN'),
  };
}

export function accessFromIdentity(identity: SessionIdentity): AccessSnapshot {
  const legacyRole = identity.legacyRole === 'SUPER_ADMIN'
    || identity.legacyRole === 'ADMIN'
    || identity.legacyRole === 'MANAGER'
    || identity.legacyRole === 'STAFF'
    ? identity.legacyRole
    : 'STAFF';
  return {
    roles: [],
    permissions: new Set(identity.permissions.map(canonicalPermission)),
    legacyRole,
    rank: ROLE_RANK[legacyRole],
    isSystemAdmin: legacyRole === 'SUPER_ADMIN'
      && identity.roles.some((role) => role.isSystem === true && role.legacyRole === 'SUPER_ADMIN'),
  };
}

export function assignedRole(role: RoleWithPermissions) {
  return {
    id: role.publicId,
    name: safeRoleName(role.name),
    description: role.description,
    isSystem: role.isSystem,
    legacyRole: role.legacyRole,
    permissions: role.rolePermissions.map((item) => canonicalPermission(item.permission.key)).sort(),
  };
}

export function canDelegateRole(access: AccessSnapshot, role: RoleWithPermissions): boolean {
  const permissions = role.rolePermissions.map((item) => canonicalPermission(item.permission.key));
  return (access.isSystemAdmin
    || (role.legacyRole !== 'SUPER_ADMIN' && !permissions.some((permission) => PROTECTED_PERMISSION_KEYS.has(permission))))
    && permissions.every((permission) => access.permissions.has(permission));
}

export function assertCanGrantPermissions(access: AccessSnapshot, permissionKeys: readonly string[]): void {
  if (access.isSystemAdmin) return;
  if (permissionKeys.some((key) => PROTECTED_PERMISSION_KEYS.has(key))) {
    throw forbidden('Only system admins can grant protected administrator permissions.');
  }
  if (permissionKeys.some((key) => !access.permissions.has(key))) {
    throw forbidden('Cannot grant permissions you do not currently hold.');
  }
}

export function assertCanAdministerTarget(
  actor: LockedUser,
  actorAccess: AccessSnapshot,
  target: LockedUser,
  targetAccess: AccessSnapshot,
  selfMessage: string,
): void {
  if (actor.id === target.id) throw forbidden(selfMessage);
  if (targetAccess.isSystemAdmin && !actorAccess.isSystemAdmin) {
    throw forbidden('Only system admins can administer system administrators.');
  }
  if (actorAccess.isSystemAdmin) return;

  const actorRank = Math.max(actor.role === 'SUPER_ADMIN' ? 0 : ROLE_RANK[actor.role], actorAccess.rank);
  const targetRank = Math.max(ROLE_RANK[target.role], targetAccess.rank);
  const targetHasUnheldPermission = [...targetAccess.permissions]
    .some((permission) => !actorAccess.permissions.has(permission));
  const sameEffectivePermissions = actorAccess.permissions.size === targetAccess.permissions.size
    && !targetHasUnheldPermission;
  if (actorRank <= targetRank || targetHasUnheldPermission || sameEffectivePermissions) {
    throw forbidden('Cannot administer an account with equal or greater access.');
  }
}

async function lockTenant(transaction: TenantTransaction, tenantId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "Tenant"
    WHERE "id" = ${tenantId}
    FOR UPDATE
  `);
}

async function lockUsers(
  transaction: TenantTransaction,
  tenantId: string,
  userIds: readonly string[],
): Promise<LockedUser[]> {
  const ids = [...new Set(userIds.map((userId) => userId.trim()).filter(Boolean))].sort();
  if (ids.length === 0) return [];
  return transaction.$queryRaw<LockedUser[]>(Prisma.sql`
    SELECT
      "id", "publicId"::text AS "publicId", "role", "name", "email", "username",
      "suspendedAt", "deletedAt", "lockedUntil", "pinLockedUntil"
    FROM "User"
    WHERE "tenantId" = ${tenantId}
      AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `);
}

async function lockActorSession(
  transaction: TenantTransaction,
  actorUserId: string,
  sessionId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{
    id: string;
    userId: string;
    expiresAt: Date;
    revokedAt: Date | null;
  }>>(Prisma.sql`
    SELECT "id", "userId", "expiresAt", "revokedAt"
    FROM "Session"
    WHERE "id" = ${sessionId}
      AND "userId" = ${actorUserId}
    FOR UPDATE
  `);
  const session = rows[0];
  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw forbidden('Administrator session is no longer active.');
  }
}

export async function rolesForUsers(
  transaction: TenantTransaction,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, RoleWithPermissions[]>> {
  const ids = [...new Set(userIds)].sort();
  const assignments = ids.length === 0 ? [] : await transaction.roleAssignment.findMany({
    where: { tenantId, userId: { in: ids } },
    select: { userId: true, roleId: true },
    orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
  });
  const roleIds = [...new Set(assignments.map((assignment) => assignment.roleId))].sort();
  for (const roleId of roleIds) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "Role"
      WHERE "tenantId" = ${tenantId} AND "id" = ${roleId}
      FOR UPDATE
    `);
  }
  if (roleIds.length > 0) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "roleId", "permissionId"
      FROM "RolePermission"
      WHERE "roleId" IN (${Prisma.join(roleIds)})
      ORDER BY "roleId", "permissionId"
      FOR UPDATE
    `);
  }
  const roles = roleIds.length === 0 ? [] : await transaction.role.findMany({
    where: { tenantId, id: { in: roleIds }, deletedAt: null },
    select: {
      id: true,
      publicId: true,
      name: true,
      slug: true,
      description: true,
      isSystem: true,
      isDefault: true,
      legacyRole: true,
      rolePermissions: { select: { permission: { select: { key: true } } } },
    },
    orderBy: { id: 'asc' },
  }) as RoleWithPermissions[];
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const output = new Map<string, RoleWithPermissions[]>();
  for (const assignment of assignments) {
    const role = roleById.get(assignment.roleId);
    if (!role) continue;
    const rows = output.get(assignment.userId) ?? [];
    rows.push(role);
    output.set(assignment.userId, rows);
  }
  return output;
}

/**
 * Re-validates live session, tenant membership, and role-derived permission
 * state inside a serialized People mutation. Token claims are never trusted
 * for authorization after the request enters the native owner.
 */
export async function authorizeMutation(
  transaction: TenantTransaction,
  identity: SessionIdentity,
  requiredPermission: string,
  options: {
    targetUserId?: string;
    allowDeletedTarget?: boolean;
    selfMessage?: string;
  } = {},
): Promise<MutationAuthority> {
  const actorUserId = identity.sub.trim();
  const sessionId = identity.sessionId.trim();
  if (!actorUserId || !sessionId) throw forbidden('A live administrator session is required.');
  await lockTenant(transaction, identity.tenantId);
  const users = await lockUsers(transaction, identity.tenantId, [actorUserId, options.targetUserId ?? '']);
  const actor = users.find((user) => user.id === actorUserId);
  const target = options.targetUserId ? users.find((user) => user.id === options.targetUserId) : undefined;
  if (!actor || actor.deletedAt || actor.suspendedAt) throw forbidden('Administrator account is inactive.');
  if ((actor.lockedUntil?.getTime() ?? 0) > Date.now() || (actor.pinLockedUntil?.getTime() ?? 0) > Date.now()) {
    throw forbidden('Administrator account is locked.');
  }
  if (options.targetUserId && (!target || (!options.allowDeletedTarget && target.deletedAt))) {
    throw notFound('The selected staff member was not found.');
  }
  await lockActorSession(transaction, actor.id, sessionId);
  const rolesByUser = await rolesForUsers(
    transaction,
    identity.tenantId,
    [actor.id, ...(target ? [target.id] : [])],
  );
  const actorAccess = accessFor(actor.role, rolesByUser.get(actor.id) ?? []);
  if (actorAccess.roles.length === 0 || !actorAccess.permissions.has(requiredPermission)) {
    throw forbidden(`${requiredPermission} permission is no longer active for this account.`);
  }
  const targetAccess = target ? accessFor(target.role, rolesByUser.get(target.id) ?? []) : undefined;
  return { actor, actorAccess, target, targetAccess };
}

export async function resolveTenantUserPublicIds(
  transaction: TenantTransaction,
  tenantId: string,
  publicIds: readonly string[],
  activeOnly = true,
): Promise<Map<string, string>> {
  const ids = [...new Set(publicIds)];
  if (ids.length === 0) return new Map();
  const rows = await transaction.user.findMany({
    where: { tenantId, publicId: { in: ids }, ...(activeOnly ? { deletedAt: null } : {}) },
    select: { id: true, publicId: true },
  });
  return new Map(rows.map((row) => [row.publicId, row.id]));
}

export async function resolveTenantRolePublicIds(
  transaction: TenantTransaction,
  tenantId: string,
  publicIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(publicIds)];
  if (ids.length === 0) return new Map();
  const rows = await transaction.role.findMany({
    where: { tenantId, publicId: { in: ids }, deletedAt: null },
    select: { id: true, publicId: true },
  });
  return new Map(rows.map((row) => [row.publicId, row.id]));
}

export async function withSerializable<T>(
  database: { withTenant<T>(tenantId: string, operation: (transaction: TenantTransaction) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T> },
  tenantId: string,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await database.withTenant(tenantId, operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code === '40001') throw conflict('Authorization or access state changed concurrently; retry the request.');
    throw error;
  }
}
