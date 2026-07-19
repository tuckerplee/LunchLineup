import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { PermissionCategory, Prisma, PrismaClient, UserRole } from '@prisma/client';
import { PRIVILEGED_MFA_PERMISSION_KEYS as SHARED_PRIVILEGED_MFA_PERMISSION_KEYS } from '@lunchlineup/rbac';
import {
    lockTenantSchedulingMutations,
    SCHEDULABLE_USER_ROLES,
    unassignEditableShiftsForIneligibleUser,
} from '../common/schedulable-user';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { runSerializableMutationWithRetry } from './serializable-mutation';

type CatalogPermission = {
    key: string;
    label: string;
    description: string;
    category: PermissionCategory;
    requiresMfa?: true;
};

type DefaultRoleDefinition = {
    slug: string;
    name: string;
    description: string;
    legacyRole: UserRole;
    isDefault?: boolean;
    permissions: string[];
};

export const RBAC_PERMISSION_CATALOG: CatalogPermission[] = [
    { key: 'dashboard:access', label: 'Access dashboard', description: 'Sign in to the tenant dashboard.', category: PermissionCategory.AUTH },
    { key: 'admin_portal:access', label: 'Access admin portal', description: 'Access the system administration portal.', category: PermissionCategory.ADMIN, requiresMfa: true },
    { key: 'tenant_account:lifecycle', label: 'Manage tenant lifecycle', description: 'Cancel or request deletion for a tenant account.', category: PermissionCategory.ADMIN, requiresMfa: true },
    { key: 'account:data_export', label: 'Export tenant data', description: 'Export the complete tenant account data set.', category: PermissionCategory.ADMIN, requiresMfa: true },
    { key: 'auth:login_email', label: 'Email login', description: 'Authenticate with work email and one-time passcode.', category: PermissionCategory.AUTH },
    { key: 'auth:login_pin', label: 'PIN login', description: 'Authenticate with username and PIN.', category: PermissionCategory.AUTH },
    { key: 'auth:login_password', label: 'Password login', description: 'Authenticate with migrated username and password.', category: PermissionCategory.AUTH },
    { key: 'users:read', label: 'View staff', description: 'Read staff directory and user details.', category: PermissionCategory.USERS },
    { key: 'users:write', label: 'Create staff', description: 'Invite staff and update basic account details.', category: PermissionCategory.USERS, requiresMfa: true },
    { key: 'users:admin', label: 'Administer staff', description: 'Reset login credentials and deactivate users.', category: PermissionCategory.USERS, requiresMfa: true },
    { key: 'roles:read', label: 'View access roles', description: 'Read role and permission definitions.', category: PermissionCategory.USERS },
    { key: 'roles:write', label: 'Manage access roles', description: 'Create, edit, and delete tenant-defined roles.', category: PermissionCategory.USERS, requiresMfa: true },
    { key: 'roles:assign', label: 'Assign access roles', description: 'Assign or revoke roles for staff members.', category: PermissionCategory.USERS, requiresMfa: true },
    { key: 'locations:read', label: 'View locations', description: 'Read location records.', category: PermissionCategory.LOCATIONS },
    { key: 'locations:write', label: 'Manage locations', description: 'Create and update locations.', category: PermissionCategory.LOCATIONS },
    { key: 'locations:delete', label: 'Delete locations', description: 'Delete locations.', category: PermissionCategory.LOCATIONS },
    { key: 'shifts:read', label: 'View shifts', description: 'Read shifts.', category: PermissionCategory.SHIFTS },
    { key: 'shifts:write', label: 'Manage shifts', description: 'Create and update shifts.', category: PermissionCategory.SHIFTS },
    { key: 'shifts:delete', label: 'Delete shifts', description: 'Delete shifts.', category: PermissionCategory.SHIFTS },
    { key: 'schedules:read', label: 'View schedules', description: 'Read schedules.', category: PermissionCategory.SCHEDULES },
    { key: 'schedules:write', label: 'Manage schedules', description: 'Create and update schedules.', category: PermissionCategory.SCHEDULES },
    { key: 'schedules:publish', label: 'Publish schedules', description: 'Publish schedules.', category: PermissionCategory.SCHEDULES },
    { key: 'lunch_breaks:read', label: 'View breaks', description: 'Read lunch and break plans.', category: PermissionCategory.LUNCH_BREAKS },
    { key: 'lunch_breaks:write', label: 'Manage breaks', description: 'Create and update lunch and break plans.', category: PermissionCategory.LUNCH_BREAKS },
    { key: 'lunch_breaks:delete', label: 'Delete breaks', description: 'Delete lunch and break plans.', category: PermissionCategory.LUNCH_BREAKS },
    { key: 'time_cards:read', label: 'View time cards', description: 'Read clock-in and clock-out history.', category: PermissionCategory.TIME_CARDS },
    { key: 'time_cards:write', label: 'Manage time cards', description: 'Clock in, clock out, and update time cards.', category: PermissionCategory.TIME_CARDS },
    { key: 'time_cards:approve', label: 'Approve time cards', description: 'Approve or reject immutable time-card revisions for payroll.', category: PermissionCategory.TIME_CARDS, requiresMfa: true },
    { key: 'payroll:read', label: 'View payroll controls', description: 'Read payroll policies, periods, locked evidence, exports, and reconciliation.', category: PermissionCategory.PAYROLL, requiresMfa: true },
    { key: 'payroll:policy_write', label: 'Manage payroll policy', description: 'Create future-effective immutable payroll policy versions.', category: PermissionCategory.PAYROLL, requiresMfa: true },
    { key: 'payroll:lock', label: 'Lock payroll periods', description: 'Start review and irreversibly lock approved payroll periods.', category: PermissionCategory.PAYROLL, requiresMfa: true },
    { key: 'payroll:export', label: 'Export payroll', description: 'Create paid deterministic payroll export batches.', category: PermissionCategory.PAYROLL, requiresMfa: true },
    { key: 'payroll:reconcile', label: 'Reconcile payroll', description: 'Create amendments and record provider reconciliation outcomes.', category: PermissionCategory.PAYROLL, requiresMfa: true },
    { key: 'notifications:read', label: 'View notifications', description: 'Read notifications.', category: PermissionCategory.NOTIFICATIONS },
    { key: 'notifications:write', label: 'Manage notifications', description: 'Create and mark notifications.', category: PermissionCategory.NOTIFICATIONS },
    { key: 'billing:read', label: 'View billing', description: 'Read billing and credits data.', category: PermissionCategory.BILLING },
    { key: 'billing:write', label: 'Manage billing', description: 'Modify billing and credits data.', category: PermissionCategory.BILLING, requiresMfa: true },
    { key: 'settings:read', label: 'View settings', description: 'Read tenant settings.', category: PermissionCategory.SETTINGS },
    { key: 'settings:write', label: 'Manage settings', description: 'Update tenant settings.', category: PermissionCategory.SETTINGS, requiresMfa: true },
];

export const ALL_PERMISSION_KEYS = RBAC_PERMISSION_CATALOG.map((permission) => permission.key);
export const PRIVILEGED_MFA_PERMISSION_KEYS: ReadonlySet<string> = SHARED_PRIVILEGED_MFA_PERMISSION_KEYS;
const ALL_PERMISSION_KEY_SET: ReadonlySet<string> = new Set(ALL_PERMISSION_KEYS);
export const PROTECTED_PERMISSION_KEYS: ReadonlySet<string> = new Set([
    'admin_portal:access',
    'tenant_account:lifecycle',
    'account:data_export',
]);

export function canonicalPermissionKey(value: string): string {
    return value.trim().toLowerCase();
}

type RoleMutationOptions = {
    actorUserId: string;
    actorSessionId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
};


type RoleAccessRecord = {
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    legacyRole: UserRole | null;
    deletedAt: Date | null;
    rolePermissions: Array<{ permission: { key: string } }>;
};

type RoleAssignmentAccessRecord = {
    userId: string;
    roleId: string;
    role: RoleAccessRecord;
};

type UserRoleReplacementRequest = {
    actorUserId: string;
    actorSessionId: string;
    targetUserId: string;
    requiredPermission: 'users:admin' | 'roles:assign';
    selfMutationMessage: string;
    auditAction: 'USER_ROLE_UPDATED' | 'USER_ACCESS_UPDATED';
    roleIds?: string[];
    legacyRole?: UserRole;
};

export type PlatformAdminMutationActor = {
    userId: string;
    tenantId: string;
    sessionId: string;
};

export type PlatformAdminMutationTarget = {
    id: string;
    tenantId: string;
    role: UserRole;
    suspendedAt: Date | null;
    deletedAt: Date | null;
    lockedUntil: Date | null;
    pinLockedUntil: Date | null;
};

type PlatformAdminUserLockRow = PlatformAdminMutationTarget;

type PlatformAdminSessionLockRow = {
    id: string;
    userId: string;
    expiresAt: Date;
    revokedAt: Date | null;
};

type PlatformAdminRoleAssignmentLockRow = {
    tenantId: string;
    userId: string;
    roleId: string;
};

type PlatformAdminMutationLockContext = {
    actor: PlatformAdminUserLockRow;
    target: PlatformAdminUserLockRow;
    actorUserId: string;
    actorTenantId: string;
    targetUserId: string;
    targetTenantId: string;
};

export type UserAdministrationAuthorizationRequest = {
    actorUserId: string;
    actorSessionId: string;
    targetUserId: string;
    requiredPermission: 'users:admin';
    selfMutationMessage: string;
};

export type UserAdministrationTarget = {
    id: string;
    role: UserRole;
    username: string | null;
    name: string;
    email: string | null;
    suspendedAt: Date | null;
};

export type UserInvitationAuthorizationRequest = {
    actorUserId: string;
    actorSessionId: string;
    targetUserId?: string;
    requestedRoleId?: string;
    requestedLegacyRole?: UserRole;
};

export type AuthorizedInvitationRole = RoleAccessRecord;

export type SelfSecurityMutationAuthorizationRequest = {
    actorUserId: string;
    actorSessionId: string;
    requiredPermission?: 'auth:login_pin';
};

export type AssignedRole = {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    legacyRole: UserRole | null;
    permissions: string[];
};

export type RoleReplacementResult = {
    legacyRole: UserRole;
    assignedRoles: AssignedRole[];
};

export type UserRoleReplacementResult = RoleReplacementResult & {
    changed: boolean;
    sessionsRevoked: number;
};

export type PlatformAdminSystemRoleReplacementResult = RoleReplacementResult & {
    changed: boolean;
    previousLegacyRole: UserRole;
    previousRoleIds: string[];
    roleId: string;
};

const USER_ROLE_RANK: Record<UserRole, number> = {
    [UserRole.STAFF]: 1,
    [UserRole.MANAGER]: 2,
    [UserRole.ADMIN]: 3,
    [UserRole.SUPER_ADMIN]: 4,
};
export const DEFAULT_ROLE_DEFINITIONS: DefaultRoleDefinition[] = [
    {
        slug: 'super-admin',
        name: 'System Admin',
        description: 'Full platform access.',
        legacyRole: UserRole.SUPER_ADMIN,
        permissions: ALL_PERMISSION_KEYS,
    },
    {
        slug: 'admin',
        name: 'Admin',
        description: 'Tenant administrator with staff and operations access.',
        legacyRole: UserRole.ADMIN,
        isDefault: true,
        permissions: [
            'dashboard:access',
            'auth:login_email',
            'auth:login_pin',
            'auth:login_password',
            'users:read',
            'users:write',
            'users:admin',
            'roles:read',
            'roles:write',
            'roles:assign',
            'locations:read',
            'locations:write',
            'locations:delete',
            'shifts:read',
            'shifts:write',
            'shifts:delete',
            'schedules:read',
            'schedules:write',
            'schedules:publish',
            'lunch_breaks:read',
            'lunch_breaks:write',
            'lunch_breaks:delete',
            'time_cards:read',
            'time_cards:write',
            'time_cards:approve',
            'payroll:read',
            'payroll:policy_write',
            'payroll:lock',
            'payroll:export',
            'payroll:reconcile',
            'notifications:read',
            'notifications:write',
            'billing:read',
            'billing:write',
            'settings:read',
            'settings:write',
            'tenant_account:lifecycle',
            'account:data_export',
        ],
    },
    {
        slug: 'manager',
        name: 'Manager',
        description: 'Store manager with scheduling and people access.',
        legacyRole: UserRole.MANAGER,
        permissions: [
            'dashboard:access',
            'auth:login_email',
            'auth:login_pin',
            'auth:login_password',
            'users:read',
            'users:write',
            'roles:read',
            'locations:read',
            'shifts:read',
            'shifts:write',
            'schedules:read',
            'schedules:write',
            'schedules:publish',
            'lunch_breaks:read',
            'lunch_breaks:write',
            'time_cards:read',
            'time_cards:write',
            'time_cards:approve',
            'payroll:read',
            'notifications:read',
            'notifications:write',
        ],
    },
    {
        slug: 'staff',
        name: 'Staff',
        description: 'Frontline staff member.',
        legacyRole: UserRole.STAFF,
        permissions: [
            'dashboard:access',
            'auth:login_email',
            'auth:login_pin',
            'auth:login_password',
            'locations:read',
            'shifts:read',
            'schedules:read',
            'lunch_breaks:read',
            'time_cards:read',
            'time_cards:write',
            'notifications:read',
            'notifications:write',
        ],
    },
];

export const MAX_CUSTOM_ROLES_PER_TENANT = 100;
export const MAX_ROLES_PER_USER = 100;
const ROLE_NAME_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const ROLE_NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_ROLE_NAME_LENGTH = 80;

export function migrationSafeRoleName(value: unknown): string {
    if (typeof value !== 'string') return 'Unknown role';
    const normalized = value
        .replace(ROLE_NAME_CONTROL_CHARACTERS, ' ')
        .replace(/ {2,}/g, ' ')
        .trim()
        .slice(0, MAX_ROLE_NAME_LENGTH);
    return normalized || 'Unknown role';
}

export type EffectiveAccess = {
    primaryRole: string;
    roles: Array<{ id: string; name: string; isSystem: boolean; legacyRole: UserRole | null }>;
    permissions: string[];
};

@Injectable()
export class RbacService {
    private readonly prisma: PrismaClient;
    private readonly tenantDb: TenantPrismaService;

    constructor(@Optional() tenantDb?: TenantPrismaService) {
        this.prisma = tenantDb?.client ?? new PrismaClient();
        this.tenantDb = tenantDb ?? new TenantPrismaService(this.prisma);
    }

    private async runActorAuthorizedSerializableMutation<T>(
        tenantId: string,
        operation: (tx: TenantPrismaTransaction) => Promise<T>,
    ): Promise<T> {
        return runSerializableMutationWithRetry(
            () => this.tenantDb.withTenant(tenantId, operation, { isolationLevel: 'Serializable' }),
            { conflictMessage: 'Authorization or access state changed concurrently; retry the request' },
        );
    }

    private assertMutationActorUnlocked(
        actor: { lockedUntil?: Date | null; pinLockedUntil?: Date | null },
        label = 'Administrator',
    ): void {
        const now = Date.now();
        if ((actor.lockedUntil?.getTime() ?? 0) > now || (actor.pinLockedUntil?.getTime() ?? 0) > now) {
            throw new ForbiddenException(`${label} account is locked`);
        }
    }

    private slugify(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48);
    }

    private normalizeRoleName(value: unknown): string {
        if (typeof value !== 'string') {
            throw new BadRequestException('Role name is required');
        }
        if (ROLE_NAME_CONTROL_CHARACTER.test(value)) {
            throw new BadRequestException('Role name must not contain control characters');
        }
        const name = value.trim();
        if (!name) {
            throw new BadRequestException('Role name is required');
        }
        if (name.length > MAX_ROLE_NAME_LENGTH) {
            throw new BadRequestException(`Role name must be ${MAX_ROLE_NAME_LENGTH} characters or less`);
        }
        return name;
    }

    private normalizeDescription(value: unknown): string | null {
        if (value === undefined || value === null) return null;
        if (typeof value !== 'string') {
            throw new BadRequestException('Role description must be a string');
        }
        const description = value.trim();
        if (description.length > 240) {
            throw new BadRequestException('Role description must be 240 characters or less');
        }
        return description || null;
    }

    private normalizeStringList(value: unknown, field: string): string[] {
        if (!Array.isArray(value)) {
            throw new BadRequestException(`${field} must be an array`);
        }
        const values = value.map((item) => {
            if (typeof item !== 'string') {
                throw new BadRequestException(`${field} must only contain strings`);
            }
            return item.trim();
        }).filter(Boolean);
        return Array.from(new Set(values));
    }

    private normalizePermissionKeys(value: unknown): string[] {
        return this.normalizeStringList(value, 'permissionKeys').map(canonicalPermissionKey);
    }

    private normalizeRoleIds(value: unknown): string[] {
        const roleIds = this.normalizeStringList(value, 'roleIds');
        if (roleIds.length > MAX_ROLES_PER_USER) {
            throw new BadRequestException(`A user may be assigned at most ${MAX_ROLES_PER_USER} roles`);
        }
        return roleIds;
    }

    private assignedRole(role: RoleAccessRecord): AssignedRole {
        return {
            id: role.id,
            name: migrationSafeRoleName(role.name),
            description: role.description,
            isSystem: role.isSystem,
            legacyRole: role.legacyRole,
            permissions: (role.rolePermissions ?? []).map((item) => item.permission.key).sort(),
        };
    }

    private reconciledLegacyRole(roles: RoleAccessRecord[]): UserRole {
        return roles.reduce<UserRole>((highest, role) => {
            if (!role.isSystem || !role.legacyRole) return highest;
            return USER_ROLE_RANK[role.legacyRole] > USER_ROLE_RANK[highest]
                ? role.legacyRole
                : highest;
        }, UserRole.STAFF);
    }

    private currentAccess(userRole: UserRole, assignments: RoleAssignmentAccessRecord[]) {
        const roles = assignments.map((assignment) => assignment.role);
        const permissions = new Set(
            roles.flatMap((role) => role.rolePermissions
                .map((item) => canonicalPermissionKey(item.permission.key))),
        );
        const legacyRole = this.reconciledLegacyRole(roles);
        const isSystemAdmin = userRole === UserRole.SUPER_ADMIN
            && roles.some((role) => role.isSystem && role.legacyRole === UserRole.SUPER_ADMIN);
        return {
            permissions,
            legacyRole,
            rank: USER_ROLE_RANK[legacyRole],
            isSystemAdmin,
        };
    }

    private async lockRoleMutationTenants(
        tx: TenantPrismaTransaction,
        tenantIds: string[],
        lockMode: 'key-share' | 'update' = 'update',
    ): Promise<void> {
        const orderedTenantIds = Array.from(new Set(tenantIds)).sort();
        if (lockMode === 'key-share') {
            await tx.$queryRaw`
                SELECT "id"
                FROM "Tenant"
                WHERE "id" IN (${Prisma.join(orderedTenantIds)})
                ORDER BY "id"
                FOR KEY SHARE
            `;
            return;
        }
        await tx.$queryRaw`
            SELECT "id"
            FROM "Tenant"
            WHERE "id" IN (${Prisma.join(orderedTenantIds)})
            ORDER BY "id"
            FOR UPDATE
        `;
    }

    private async lockRoleMutationUsers(
        tx: TenantPrismaTransaction,
        tenantId: string,
        userIds: string[],
    ): Promise<void> {
        const orderedUserIds = Array.from(new Set(userIds)).sort();
        await tx.$queryRaw`
            SELECT "id"
            FROM "User"
            WHERE "tenantId" = ${tenantId}
              AND "id" IN (${Prisma.join(orderedUserIds)})
              AND "deletedAt" IS NULL
            ORDER BY "id"
            FOR UPDATE
        `;
    }

    private async lockInvitationMutationUsers(
        tx: TenantPrismaTransaction,
        tenantId: string,
        userIds: string[],
    ): Promise<void> {
        const orderedUserIds = Array.from(new Set(userIds)).sort();
        await tx.$queryRaw`
            SELECT "id"
            FROM "User"
            WHERE "tenantId" = ${tenantId}
              AND "id" IN (${Prisma.join(orderedUserIds)})
            ORDER BY "id"
            FOR UPDATE
        `;
    }

    private async lockAndValidateActorSession(
        tx: TenantPrismaTransaction,
        actorUserId: string,
        actorSessionIdRaw: string,
    ): Promise<void> {
        const actorSessionId = actorSessionIdRaw?.trim();
        if (!actorSessionId) {
            throw new ForbiddenException('A live administrator session is required');
        }
        const sessions = await tx.$queryRaw<PlatformAdminSessionLockRow[]>`
            SELECT "id", "userId", "expiresAt", "revokedAt"
            FROM "Session"
            WHERE "id" = ${actorSessionId}
              AND "userId" = ${actorUserId}
            FOR UPDATE
        `;
        const session = sessions[0];
        if (!session || session.revokedAt || session.expiresAt <= new Date()) {
            throw new ForbiddenException('Administrator session is no longer active');
        }
    }

    private async lockRoleMutationAssignments(
        tx: TenantPrismaTransaction,
        tenantId: string,
        userIds: string[],
    ): Promise<void> {
        const orderedUserIds = Array.from(new Set(userIds)).sort();
        await tx.$queryRaw`
            SELECT "userId", "roleId"
            FROM "RoleAssignment"
            WHERE "tenantId" = ${tenantId}
              AND "userId" IN (${Prisma.join(orderedUserIds)})
            ORDER BY "userId", "roleId"
            FOR UPDATE
        `;
    }

    private async lockRoleMutationPermissions(
        tx: TenantPrismaTransaction,
        roleIds: string[],
    ): Promise<void> {
        const orderedRoleIds = Array.from(new Set(roleIds)).sort();
        if (orderedRoleIds.length === 0) return;
        await tx.$queryRaw`
            SELECT "roleId", "permissionId"
            FROM "RolePermission"
            WHERE "roleId" IN (${Prisma.join(orderedRoleIds)})
            ORDER BY "roleId", "permissionId"
            FOR UPDATE
        `;
    }

    private async lockTenantRolesForAssignmentMutation(
        tx: TenantPrismaTransaction,
        tenantId: string,
        roleIds: string[],
    ): Promise<void> {
        // Lock order is tenant role id ascending for every assignment/delete path.
        const orderedRoleIds = Array.from(new Set(roleIds)).sort();
        for (const roleId of orderedRoleIds) {
            await tx.$queryRaw`
                SELECT "id"
                FROM "Role"
                WHERE "tenantId" = ${tenantId} AND "id" = ${roleId}
                FOR UPDATE
            `;
        }
    }

    private async lockPlatformRoleMutationAssignments(
        tx: TenantPrismaTransaction,
        userIds: string[],
    ): Promise<PlatformAdminRoleAssignmentLockRow[]> {
        const orderedUserIds = Array.from(new Set(userIds)).sort();
        return tx.$queryRaw<PlatformAdminRoleAssignmentLockRow[]>`
            SELECT "tenantId", "userId", "roleId"
            FROM "RoleAssignment"
            WHERE "userId" IN (${Prisma.join(orderedUserIds)})
            ORDER BY "tenantId", "userId", "roleId"
            FOR UPDATE
        `;
    }

    private async lockPlatformRolesForAssignmentMutation(
        tx: TenantPrismaTransaction,
        roleIds: string[],
    ): Promise<void> {
        const orderedRoleIds = Array.from(new Set(roleIds)).sort();
        if (orderedRoleIds.length === 0) return;
        await tx.$queryRaw`
            SELECT "id"
            FROM "Role"
            WHERE "id" IN (${Prisma.join(orderedRoleIds)})
            ORDER BY "id"
            FOR UPDATE
        `;
    }

    private async lockPlatformAdminMutationIdentityInTransaction(
        tx: TenantPrismaTransaction,
        targetUserIdRaw: string,
        actorInput: PlatformAdminMutationActor,
        expectedTargetTenantId?: string,
        tenantLockMode: 'key-share' | 'update' = 'key-share',
        lockTargetSchedulingMutations = false,
    ): Promise<PlatformAdminMutationLockContext> {
        const targetUserId = targetUserIdRaw?.trim();
        const actorUserId = actorInput.userId?.trim();
        const actorTenantId = actorInput.tenantId?.trim();
        const actorSessionId = actorInput.sessionId?.trim();
        if (!targetUserId) throw new NotFoundException('User not found');
        if (!actorUserId || !actorTenantId || !actorSessionId) {
            throw new ForbiddenException('A live platform administrator session is required');
        }
        if (actorUserId === targetUserId) {
            throw new ForbiddenException('Platform administrators cannot administer their own account');
        }

        const expectedTenantId = expectedTargetTenantId?.trim();
        if (expectedTenantId && tenantLockMode === 'update') {
            // Cross-tenant role replacements serialize before assignment/RBAC reads,
            // then acquire the combined role set below in the same global order.
            await this.lockRoleMutationTenants(tx, [actorTenantId, expectedTenantId]);
        }

        const targetIdentity = await tx.user.findUnique({
            where: { id: targetUserId },
            select: { tenantId: true },
        });
        if (!targetIdentity) throw new NotFoundException('User not found');
        if (expectedTenantId && targetIdentity.tenantId !== expectedTenantId) {
            throw new ConflictException('User tenant changed before authorization completed');
        }

        if (tenantLockMode === 'key-share') {
            await this.lockRoleMutationTenants(
                tx,
                [actorTenantId, targetIdentity.tenantId],
                'key-share',
            );
        }
        if (lockTargetSchedulingMutations) {
            await lockTenantSchedulingMutations(tx, targetIdentity.tenantId, true);
        }

        const orderedUserIds = Array.from(new Set([actorUserId, targetUserId])).sort();
        const users = await tx.$queryRaw<PlatformAdminUserLockRow[]>`
            SELECT "id", "tenantId", "role", "suspendedAt", "deletedAt", "lockedUntil", "pinLockedUntil"
            FROM "User"
            WHERE "id" IN (${Prisma.join(orderedUserIds)})
            ORDER BY "id"
            FOR UPDATE
        `;
        const actor = users.find((user) => user.id === actorUserId);
        const target = users.find((user) => user.id === targetUserId);
        if (!target || target.deletedAt) throw new NotFoundException('User not found');
        if (target.tenantId !== targetIdentity.tenantId) {
            throw new ConflictException('User tenant changed before authorization completed');
        }
        if (!actor || actor.tenantId !== actorTenantId || actor.deletedAt) {
            throw new ForbiddenException('Platform administrator account is inactive');
        }
        if (actor.suspendedAt) {
            throw new ForbiddenException('Platform administrator account is suspended');
        }
        this.assertMutationActorUnlocked(actor, 'Platform administrator');

        const sessions = await tx.$queryRaw<PlatformAdminSessionLockRow[]>`
            SELECT "id", "userId", "expiresAt", "revokedAt"
            FROM "Session"
            WHERE "id" = ${actorSessionId}
              AND "userId" = ${actorUserId}
            FOR UPDATE
        `;
        const session = sessions[0];
        if (!session || session.revokedAt || session.expiresAt <= new Date()) {
            throw new ForbiddenException('Platform administrator session is no longer active');
        }

        return {
            actor,
            target,
            actorUserId,
            actorTenantId,
            targetUserId,
            targetTenantId: targetIdentity.tenantId,
        };
    }

    private async assertPlatformAdminAuthorityInTransaction(
        tx: TenantPrismaTransaction,
        actor: PlatformAdminUserLockRow,
        actorUserId: string,
        actorTenantId: string,
    ): Promise<void> {
        const assignments = await tx.roleAssignment.findMany({
            where: {
                tenantId: actorTenantId,
                userId: actorUserId,
                role: { tenantId: actorTenantId, deletedAt: null },
            },
            include: {
                role: {
                    include: {
                        rolePermissions: { include: { permission: true } },
                    },
                },
            },
            orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
        });
        const actorAccess = this.currentAccess(actor.role, assignments);
        if (!actorAccess.permissions.has('admin_portal:access')) {
            throw new ForbiddenException('Platform administrator authority is no longer active');
        }
    }

    private async assertPlatformAdminAuthorityForLockedRolesInTransaction(
        tx: TenantPrismaTransaction,
        actor: PlatformAdminUserLockRow,
        actorUserId: string,
        actorTenantId: string,
        actorRoleIds: string[],
        requireSystemAdmin = false,
    ) {
        const roles = await tx.role.findMany({
            where: {
                tenantId: actorTenantId,
                id: { in: actorRoleIds },
                deletedAt: null,
            },
            include: {
                rolePermissions: { include: { permission: true } },
            },
            orderBy: { id: 'asc' },
        });
        const assignments = roles.map((role) => ({
            userId: actorUserId,
            roleId: role.id,
            role,
        }));
        const actorAccess = this.currentAccess(actor.role, assignments);
        if (!actorAccess.permissions.has('admin_portal:access')) {
            throw new ForbiddenException('Platform administrator authority is no longer active');
        }
        if (requireSystemAdmin && !actorAccess.isSystemAdmin) {
            throw new ForbiddenException('Only system admins can grant system admin access');
        }
        return actorAccess;
    }

    async authorizePlatformAdminUserMutationInTransaction(
        tx: TenantPrismaTransaction,
        targetUserIdRaw: string,
        actorInput: PlatformAdminMutationActor,
        expectedTargetTenantId?: string,
        options: { lockTargetSchedulingMutations?: boolean } = {},
    ): Promise<PlatformAdminMutationTarget> {
        const context = await this.lockPlatformAdminMutationIdentityInTransaction(
            tx,
            targetUserIdRaw,
            actorInput,
            expectedTargetTenantId,
            'key-share',
            options.lockTargetSchedulingMutations === true,
        );
        const lockedAssignments = await this.lockPlatformRoleMutationAssignments(
            tx,
            [context.actorUserId, context.targetUserId],
        );
        const roleIds = lockedAssignments.map((assignment) => assignment.roleId);
        await this.lockPlatformRolesForAssignmentMutation(tx, roleIds);
        await this.lockRoleMutationPermissions(tx, roleIds);
        const roles = await tx.role.findMany({
            where: { id: { in: roleIds }, deletedAt: null },
            include: { rolePermissions: { include: { permission: true } } },
            orderBy: { id: 'asc' },
        });
        const roleById = new Map(roles.map((role) => [role.id, role]));
        const assignmentsFor = (tenantId: string, userId: string) => lockedAssignments
            .filter((assignment) => assignment.tenantId === tenantId && assignment.userId === userId)
            .flatMap((assignment) => {
                const role = roleById.get(assignment.roleId);
                return role && role.tenantId === tenantId
                    ? [{ userId, roleId: assignment.roleId, role }]
                    : [];
            });
        const actorAccess = this.currentAccess(
            context.actor.role,
            assignmentsFor(context.actorTenantId, context.actorUserId),
        );
        if (!actorAccess.permissions.has('admin_portal:access')) {
            throw new ForbiddenException('Platform administrator authority is no longer active');
        }
        const targetAccess = this.currentAccess(
            context.target.role,
            assignmentsFor(context.targetTenantId, context.targetUserId),
        );
        if (targetAccess.isSystemAdmin && !actorAccess.isSystemAdmin) {
            throw new ForbiddenException('Only system admins can administer system admins');
        }

        return context.target;
    }

    async authorizePlatformAdminTenantMutationInTransaction(
        tx: TenantPrismaTransaction,
        targetTenantIdRaw: string,
        actorInput: PlatformAdminMutationActor,
    ): Promise<void> {
        const targetTenantId = targetTenantIdRaw?.trim();
        const actorUserId = actorInput.userId?.trim();
        const actorTenantId = actorInput.tenantId?.trim();
        if (!targetTenantId) throw new BadRequestException('Tenant not found');
        if (!actorUserId || !actorTenantId || !actorInput.sessionId?.trim()) {
            throw new ForbiddenException('A live platform administrator session is required');
        }

        await this.lockRoleMutationTenants(tx, [actorTenantId, targetTenantId]);
        await this.lockRoleMutationUsers(tx, actorTenantId, [actorUserId]);
        const actor = await tx.user.findFirst({
            where: { id: actorUserId, tenantId: actorTenantId, deletedAt: null },
            select: { id: true, role: true, suspendedAt: true, lockedUntil: true, pinLockedUntil: true },
        });
        if (!actor) throw new ForbiddenException('Platform administrator account is inactive');
        if (actor.suspendedAt) {
            throw new ForbiddenException('Platform administrator account is suspended');
        }
        this.assertMutationActorUnlocked(actor, 'Platform administrator');
        await this.lockAndValidateActorSession(tx, actorUserId, actorInput.sessionId);
        await this.lockRoleMutationAssignments(tx, actorTenantId, [actorUserId]);
        const lockedAssignments = await tx.roleAssignment.findMany({
            where: { tenantId: actorTenantId, userId: actorUserId },
            select: { userId: true, roleId: true },
            orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
        });
        const roleIds = lockedAssignments.map((assignment) => assignment.roleId);
        await this.lockTenantRolesForAssignmentMutation(tx, actorTenantId, roleIds);
        await this.lockRoleMutationPermissions(tx, roleIds);
        await this.assertPlatformAdminAuthorityInTransaction(tx, {
            id: actor.id,
            tenantId: actorTenantId,
            role: actor.role,
            suspendedAt: actor.suspendedAt,
            deletedAt: null,
            lockedUntil: actor.lockedUntil,
            pinLockedUntil: actor.pinLockedUntil,
        }, actorUserId, actorTenantId);
    }

    async authorizeUserAdministrationInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        request: UserAdministrationAuthorizationRequest,
    ): Promise<UserAdministrationTarget> {
        const actorUserId = request.actorUserId?.trim();
        const targetUserId = request.targetUserId?.trim();
        if (!actorUserId) {
            throw new ForbiddenException('A live actor identity is required to administer users');
        }
        if (!targetUserId) {
            throw new NotFoundException('User not found');
        }
        if (actorUserId === targetUserId) {
            throw new ForbiddenException(request.selfMutationMessage);
        }

        await this.lockRoleMutationTenants(tx, [tenantId]);
        const userIds = [actorUserId, targetUserId];
        await this.lockRoleMutationUsers(tx, tenantId, userIds);
        const users = await tx.user.findMany({
            where: {
                tenantId,
                id: { in: userIds },
                deletedAt: null,
            },
            select: {
                id: true,
                role: true,
                username: true,
                name: true,
                email: true,
                suspendedAt: true,
                lockedUntil: true,
                pinLockedUntil: true,
            },
        });
        const actor = users.find((user) => user.id === actorUserId);
        const target = users.find((user) => user.id === targetUserId);
        if (!target) throw new NotFoundException('User not found');
        if (!actor) throw new ForbiddenException('Administrator account is inactive');
        if (actor.suspendedAt) throw new ForbiddenException('Administrator account is suspended');
        this.assertMutationActorUnlocked(actor);
        await this.lockAndValidateActorSession(tx, actorUserId, request.actorSessionId);

        await this.lockRoleMutationAssignments(tx, tenantId, userIds);
        const lockedAssignments = await tx.roleAssignment.findMany({
            where: { tenantId, userId: { in: userIds } },
            select: { userId: true, roleId: true },
            orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
        });
        const roleIds = lockedAssignments.map((assignment) => assignment.roleId);
        await this.lockTenantRolesForAssignmentMutation(tx, tenantId, roleIds);
        await this.lockRoleMutationPermissions(tx, roleIds);

        const assignments = await tx.roleAssignment.findMany({
            where: {
                tenantId,
                userId: { in: userIds },
                role: { tenantId, deletedAt: null },
            },
            include: {
                role: {
                    include: {
                        rolePermissions: { include: { permission: true } },
                    },
                },
            },
            orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
        });
        const actorAccess = this.currentAccess(
            actor.role,
            assignments.filter((assignment) => assignment.userId === actorUserId),
        );
        const targetAccess = this.currentAccess(
            target.role,
            assignments.filter((assignment) => assignment.userId === targetUserId),
        );

        if (!actorAccess.permissions.has(request.requiredPermission)) {
            throw new ForbiddenException(
                `${request.requiredPermission} permission is no longer active for this account`,
            );
        }
        if (targetAccess.isSystemAdmin && !actorAccess.isSystemAdmin) {
            throw new ForbiddenException('Only system admins can administer system admins');
        }
        if (!actorAccess.isSystemAdmin) {
            const actorRank = Math.max(
                actor.role === UserRole.SUPER_ADMIN ? 0 : USER_ROLE_RANK[actor.role],
                actorAccess.rank,
            );
            const targetRank = Math.max(USER_ROLE_RANK[target.role], targetAccess.rank);
            const targetHasUnheldPermission = Array.from(targetAccess.permissions)
                .some((permission) => !actorAccess.permissions.has(permission));
            const sameEffectivePermissions = actorAccess.permissions.size === targetAccess.permissions.size
                && !targetHasUnheldPermission;
            if (actorRank <= targetRank || targetHasUnheldPermission || sameEffectivePermissions) {
                throw new ForbiddenException('Cannot administer an account with equal or greater access');
            }
        }

        return target;
    }

    async authorizeSelfSecurityMutationInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        request: SelfSecurityMutationAuthorizationRequest,
    ): Promise<EffectiveAccess> {
        const actorUserId = request.actorUserId?.trim();
        if (!actorUserId) {
            throw new ForbiddenException('A live actor identity is required');
        }

        await this.lockRoleMutationTenants(tx, [tenantId]);
        await this.lockRoleMutationUsers(tx, tenantId, [actorUserId]);
        const actor = await tx.user.findFirst({
            where: { id: actorUserId, tenantId, deletedAt: null, suspendedAt: null },
            select: {
                id: true,
                role: true,
                lockedUntil: true,
                pinLockedUntil: true,
            },
        });
        if (!actor) throw new ForbiddenException('User account is inactive');
        this.assertMutationActorUnlocked(actor, 'User');
        await this.lockAndValidateActorSession(tx, actorUserId, request.actorSessionId);

        await this.lockRoleMutationAssignments(tx, tenantId, [actorUserId]);
        const lockedAssignments = await tx.roleAssignment.findMany({
            where: { tenantId, userId: actorUserId },
            select: { userId: true, roleId: true },
            orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
        });
        const roleIds = lockedAssignments.map((assignment) => assignment.roleId);
        await this.lockTenantRolesForAssignmentMutation(tx, tenantId, roleIds);
        await this.lockRoleMutationPermissions(tx, roleIds);
        const roles = await tx.role.findMany({
            where: { tenantId, id: { in: roleIds }, deletedAt: null },
            include: { rolePermissions: { include: { permission: true } } },
            orderBy: { id: 'asc' },
        });
        if (roles.length === 0) {
            throw new UnauthorizedException('Account access has not been migrated to RBAC');
        }

        const permissions = Array.from(new Set(roles.flatMap((role) => role.rolePermissions
            .map((item) => canonicalPermissionKey(item.permission.key))))).sort();
        if (request.requiredPermission && !permissions.includes(request.requiredPermission)) {
            throw new ForbiddenException(
                `${request.requiredPermission} permission is no longer active for this account`,
            );
        }
        return {
            primaryRole: migrationSafeRoleName(roles[0].name),
            roles: roles.map((role) => ({
                id: role.id,
                name: migrationSafeRoleName(role.name),
                isSystem: role.isSystem,
                legacyRole: role.legacyRole,
            })),
            permissions,
        };
    }

    async authorizeUserInvitationInTransaction(
        tx: TenantPrismaTransaction,
        tenantId: string,
        request: UserInvitationAuthorizationRequest,
    ): Promise<AuthorizedInvitationRole> {
        const actorUserId = request.actorUserId?.trim();
        const targetUserId = request.targetUserId?.trim();
        const requestedRoleId = request.requestedRoleId?.trim();
        if (!actorUserId) {
            throw new ForbiddenException('A live actor identity is required to invite users');
        }
        if (!requestedRoleId && !request.requestedLegacyRole) {
            throw new BadRequestException('Selected role is invalid for this tenant');
        }

        await this.lockRoleMutationTenants(tx, [tenantId]);
        const userIds = targetUserId ? [actorUserId, targetUserId] : [actorUserId];
        await this.lockInvitationMutationUsers(tx, tenantId, userIds);
        const users = await tx.user.findMany({
            where: { tenantId, id: { in: userIds } },
            select: {
                id: true,
                role: true,
                suspendedAt: true,
                deletedAt: true,
                lockedUntil: true,
                pinLockedUntil: true,
            },
        });
        const actor = users.find((user) => user.id === actorUserId);
        if (!actor || actor.deletedAt) throw new ForbiddenException('Administrator account is inactive');
        if (actor.suspendedAt) throw new ForbiddenException('Administrator account is suspended');
        this.assertMutationActorUnlocked(actor);
        const target = targetUserId ? users.find((user) => user.id === targetUserId) : undefined;
        if (targetUserId && (!target || !target.deletedAt)) {
            throw new ConflictException('Archived user changed before invitation authorization completed');
        }
        await this.lockAndValidateActorSession(tx, actorUserId, request.actorSessionId);

        await this.lockRoleMutationAssignments(tx, tenantId, userIds);
        const lockedAssignments = await tx.roleAssignment.findMany({
            where: { tenantId, userId: { in: userIds } },
            select: { userId: true, roleId: true },
            orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
        });
        const selectedRoleCandidate = await tx.role.findFirst({
            where: {
                tenantId,
                deletedAt: null,
                ...(requestedRoleId
                    ? { id: requestedRoleId }
                    : {
                        isSystem: true,
                        legacyRole: request.requestedLegacyRole,
                    }),
            },
            select: { id: true },
            orderBy: { id: 'asc' },
        });
        if (!selectedRoleCandidate) {
            throw new BadRequestException('Selected role is invalid for this tenant');
        }
        const roleIds = [
            ...lockedAssignments.map((assignment) => assignment.roleId),
            selectedRoleCandidate.id,
        ];
        await this.lockTenantRolesForAssignmentMutation(tx, tenantId, roleIds);
        await this.lockRoleMutationPermissions(tx, roleIds);
        const roles = await tx.role.findMany({
            where: { tenantId, id: { in: roleIds }, deletedAt: null },
            include: { rolePermissions: { include: { permission: true } } },
            orderBy: { id: 'asc' },
        });
        const selectedRole = roles.find((role) => role.id === selectedRoleCandidate.id);
        if (!selectedRole
            || (requestedRoleId && selectedRole.id !== requestedRoleId)
            || (request.requestedLegacyRole
                && (!selectedRole.isSystem || selectedRole.legacyRole !== request.requestedLegacyRole))) {
            throw new BadRequestException('Selected role is invalid for this tenant');
        }
        const roleById = new Map(roles.map((role) => [role.id, role]));
        const assignmentsFor = (userId: string) => lockedAssignments
            .filter((assignment) => assignment.userId === userId)
            .flatMap((assignment) => {
                const role = roleById.get(assignment.roleId);
                return role ? [{ userId, roleId: assignment.roleId, role }] : [];
            });
        const actorAccess = this.currentAccess(actor.role, assignmentsFor(actorUserId));
        if (!actorAccess.permissions.has('users:write')) {
            throw new ForbiddenException('users:write permission is no longer active for this account');
        }
        if (target) {
            const targetAccess = this.currentAccess(target.role, assignmentsFor(target.id));
            if (targetAccess.isSystemAdmin && !actorAccess.isSystemAdmin) {
                throw new ForbiddenException('Only system admins can administer system admins');
            }
        }

        const requestedPermissions = new Set(selectedRole.rolePermissions
            .map((item) => canonicalPermissionKey(item.permission.key)));
        const requestsProtectedAccess = (
            selectedRole.isSystem && selectedRole.legacyRole === UserRole.SUPER_ADMIN
        ) || Array.from(requestedPermissions).some((permission) => PROTECTED_PERMISSION_KEYS.has(permission));
        if (!actorAccess.isSystemAdmin && requestsProtectedAccess) {
            throw new ForbiddenException('Only system admins can grant system admin access');
        }
        if (!actorAccess.isSystemAdmin
            && Array.from(requestedPermissions).some((permission) => !actorAccess.permissions.has(permission))) {
            throw new ForbiddenException('Cannot grant a role with permissions you do not hold');
        }
        return selectedRole;
    }

    private async resolvePermissionIdsForMutation(
        tx: TenantPrismaTransaction,
        tenantId: string,
        permissionKeysRaw: unknown,
        options: RoleMutationOptions,
        additionalRoleIdsToLock: string[] = [],
    ): Promise<string[]> {
        const permissionKeys = Array.from(new Set(this.normalizePermissionKeys(permissionKeysRaw)));
        if (permissionKeys.some((key) => !ALL_PERMISSION_KEY_SET.has(key))) {
            throw new BadRequestException('One or more permissions are invalid');
        }

        const actorUserId = options.actorUserId?.trim();
        if (!actorUserId) {
            throw new ForbiddenException('A live actor identity is required to modify roles');
        }
        await this.lockRoleMutationTenants(tx, [tenantId]);
        await this.lockRoleMutationUsers(tx, tenantId, [actorUserId]);
        const actor = await tx.user.findFirst({
            where: { id: actorUserId, tenantId, deletedAt: null },
            select: { id: true, role: true, suspendedAt: true, lockedUntil: true, pinLockedUntil: true },
        });
        if (!actor) {
            throw new ForbiddenException('Administrator account is inactive');
        }
        if (actor.suspendedAt) {
            throw new ForbiddenException('Administrator account is suspended');
        }
        this.assertMutationActorUnlocked(actor);
        await this.lockAndValidateActorSession(tx, actorUserId, options.actorSessionId);
        await this.lockRoleMutationAssignments(tx, tenantId, [actorUserId]);
        const lockedAssignments = await tx.roleAssignment.findMany({
            where: { tenantId, userId: actorUserId },
            select: { userId: true, roleId: true },
            orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
        });
        const roleIdsToLock = [
            ...lockedAssignments.map((assignment) => assignment.roleId),
            ...additionalRoleIdsToLock,
        ];
        await this.lockTenantRolesForAssignmentMutation(tx, tenantId, roleIdsToLock);
        await this.lockRoleMutationPermissions(tx, roleIdsToLock);
        const assignments = await tx.roleAssignment.findMany({
            where: {
                tenantId,
                userId: actorUserId,
                role: {
                    tenantId,
                    deletedAt: null,
                },
            },
            include: {
                role: {
                    include: {
                        rolePermissions: {
                            include: { permission: true },
                        },
                    },
                },
            },
            orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
        });
        const actorAccess = this.currentAccess(actor.role, assignments);

        if (!actorAccess.isSystemAdmin && !actorAccess.permissions.has('roles:write')) {
            throw new ForbiddenException('roles:write permission is no longer active for this account');
        }
        if (!actorAccess.isSystemAdmin && permissionKeys.some((key) => PROTECTED_PERMISSION_KEYS.has(key))) {
            throw new ForbiddenException('Only system admins can grant protected admin permissions');
        }
        if (!actorAccess.isSystemAdmin && permissionKeys.some((key) => !actorAccess.permissions.has(key))) {
            throw new ForbiddenException('Cannot grant permissions you do not currently hold');
        }
        if (permissionKeys.length === 0) return [];

        const permissions = await tx.permission.findMany({
            where: { key: { in: permissionKeys } },
            select: { id: true, key: true },
        });
        if (permissions.length !== permissionKeys.length) {
            throw new BadRequestException('One or more permissions are invalid');
        }
        return permissions.map((permission) => permission.id);
    }

    private async ensurePermissionCatalogInTransaction(tx: TenantPrismaTransaction): Promise<void> {
        await Promise.all(
            RBAC_PERMISSION_CATALOG.map((permission) =>
                tx.permission.upsert({
                    where: { key: permission.key },
                    update: {
                        label: permission.label,
                        description: permission.description,
                        category: permission.category,
                    },
                    create: {
                        key: permission.key,
                        label: permission.label,
                        description: permission.description,
                        category: permission.category,
                    },
                }),
            ),
        );
    }

    async ensurePermissionCatalog(): Promise<void> {
        await this.prisma.$transaction((tx) => this.ensurePermissionCatalogInTransaction(tx));
    }

    private async ensureTenantRolesInTransaction(tx: TenantPrismaTransaction, tenantId: string): Promise<void> {
        await this.ensurePermissionCatalogInTransaction(tx);

        const permissionRows = await tx.permission.findMany({
            where: { key: { in: ALL_PERMISSION_KEYS } },
            select: { id: true, key: true },
        });
        const permissionIdByKey = new Map(permissionRows.map((row) => [row.key, row.id]));

        for (const definition of DEFAULT_ROLE_DEFINITIONS) {
            const role = await tx.role.upsert({
                where: { tenantId_slug: { tenantId, slug: definition.slug } },
                update: {
                    name: definition.name,
                    description: definition.description,
                    isSystem: true,
                    isDefault: Boolean(definition.isDefault),
                    legacyRole: definition.legacyRole,
                    deletedAt: null,
                },
                create: {
                    tenantId,
                    slug: definition.slug,
                    name: definition.name,
                    description: definition.description,
                    isSystem: true,
                    isDefault: Boolean(definition.isDefault),
                    legacyRole: definition.legacyRole,
                },
            });

            await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
            if (definition.permissions.length > 0) {
                await tx.rolePermission.createMany({
                    data: definition.permissions
                        .map((key) => permissionIdByKey.get(key))
                        .filter((value): value is string => Boolean(value))
                        .map((permissionId) => ({ roleId: role.id, permissionId })),
                    skipDuplicates: true,
                });
            }
        }
    }

    async ensureTenantRoles(
        tenantId: string,
        transaction?: TenantPrismaTransaction,
    ): Promise<void> {
        if (transaction) {
            await this.ensureTenantRolesInTransaction(transaction, tenantId);
            return;
        }
        await this.tenantDb.withTenant(tenantId, (tx) => this.ensureTenantRolesInTransaction(tx, tenantId));
    }

    private async assignLegacySystemRoleInTransaction(
        tx: TenantPrismaTransaction,
        userId: string,
        tenantId: string,
        legacyRole: UserRole,
    ): Promise<void> {
        const user = await tx.user.findFirst({
            where: { id: userId, tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!user) {
            throw new NotFoundException('User not found for this tenant');
        }

        const role = await tx.role.findFirst({
            where: { tenantId, legacyRole, deletedAt: null },
            select: { id: true },
        });
        if (!role) {
            throw new ForbiddenException(`No RBAC role is configured for legacy role ${legacyRole}`);
        }
        await tx.roleAssignment.create({
            data: { tenantId, userId, roleId: role.id },
        });
    }

    async provisionLegacySystemRole(
        tx: TenantPrismaTransaction,
        userId: string,
        tenantId: string,
        legacyRole: UserRole,
    ): Promise<void> {
        await this.ensureTenantRolesInTransaction(tx, tenantId);
        await this.assignLegacySystemRoleInTransaction(tx, userId, tenantId, legacyRole);
    }

    async assignLegacySystemRole(userId: string, tenantId: string, legacyRole: UserRole): Promise<void> {
        await this.ensureTenantRoles(tenantId);
        await this.tenantDb.withTenant(tenantId, (tx) =>
            this.assignLegacySystemRoleInTransaction(tx, userId, tenantId, legacyRole));
    }

    async getEffectiveAccess(userId: string, tenantId: string): Promise<EffectiveAccess> {
        const assignments = await this.tenantDb.withTenant(tenantId, (tx) => tx.roleAssignment.findMany({
            where: {
                tenantId,
                userId,
                role: {
                    tenantId,
                    deletedAt: null,
                },
            },
            include: {
                role: {
                    include: {
                        rolePermissions: {
                            include: {
                                permission: true,
                            },
                        },
                    },
                },
            },
        }));

        const permissions = new Set<string>();
        const roles = assignments.map((assignment) => {
            assignment.role.rolePermissions.forEach((rolePermission) => permissions.add(rolePermission.permission.key));
            return {
                id: assignment.role.id,
                name: migrationSafeRoleName(assignment.role.name),
                isSystem: assignment.role.isSystem,
                legacyRole: assignment.role.legacyRole,
            };
        });

        if (roles.length === 0) {
            throw new UnauthorizedException('Account access has not been migrated to RBAC');
        }

        const primaryRole = roles[0]?.name ?? 'Unknown';

        return {
            primaryRole,
            roles,
            permissions: Array.from(permissions).sort(),
        };
    }

    async listRolesForTenant(tenantId: string) {
        await this.ensureTenantRoles(tenantId);
        const roles = await this.tenantDb.withTenant(tenantId, (tx) => tx.role.findMany({
            where: { tenantId, deletedAt: null },
            include: {
                rolePermissions: {
                    include: {
                        permission: true,
                    },
                },
                _count: {
                    select: {
                        assignments: true,
                    },
                },
            },
            orderBy: [
                { isSystem: 'desc' },
                { name: 'asc' },
            ],
            take: MAX_CUSTOM_ROLES_PER_TENANT + DEFAULT_ROLE_DEFINITIONS.length,
        }));
        return roles.map((role) => ({ ...role, name: migrationSafeRoleName(role.name) }));
    }

    async listPermissions() {
        await this.ensurePermissionCatalog();
        return this.prisma.permission.findMany({
            orderBy: [
                { category: 'asc' },
                { key: 'asc' },
            ],
        });
    }

    async createRole(
        tenantId: string,
        input: { name: string; description?: string; permissionKeys: string[] },
        options: RoleMutationOptions,
    ) {
        const name = this.normalizeRoleName(input.name);
        const description = this.normalizeDescription(input.description);
        const permissionKeys = this.normalizePermissionKeys(input.permissionKeys).sort();
        const slugBase = this.slugify(name);
        const slug = slugBase || `role-${Date.now().toString(36)}`;

        const role = await this.runActorAuthorizedSerializableMutation(tenantId, async (tx) => {
            await this.lockRoleMutationTenants(tx, [tenantId]);
            await this.ensureTenantRoles(tenantId, tx);
            const permissionIds = await this.resolvePermissionIdsForMutation(
                tx,
                tenantId,
                permissionKeys,
                options,
            );
            const customRoleCount = await tx.role.count({
                where: { tenantId, isSystem: false, deletedAt: null },
            });
            if (customRoleCount >= MAX_CUSTOM_ROLES_PER_TENANT) {
                throw new BadRequestException(
                    'A tenant may configure at most ' + MAX_CUSTOM_ROLES_PER_TENANT + ' custom roles',
                );
            }
            const created = await tx.role.create({
                data: {
                    tenantId,
                    name,
                    slug,
                    description,
                    isSystem: false,
                    rolePermissions: {
                        createMany: {
                            data: permissionIds.map((permissionId) => ({ permissionId })),
                        },
                    },
                },
                include: {
                    rolePermissions: {
                        include: { permission: true },
                    },
                },
            });
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: options.actorUserId,
                    actorUserId: options.actorUserId,
                    actorTenantId: tenantId,
                    ipAddress: options.ipAddress ?? null,
                    userAgent: options.userAgent ?? null,
                    action: 'ACCESS_ROLE_CREATED',
                    resource: 'Role',
                    resourceId: created.id,
                    oldValue: { name: null, description: null, permissions: [] },
                    newValue: { name, description, permissions: permissionKeys },
                },
            });
            return created;
        });

        return role;
    }

    async updateRole(
        tenantId: string,
        roleId: string,
        input: { name: string; description?: string; permissionKeys: string[] },
        options: RoleMutationOptions,
    ) {
        const name = this.normalizeRoleName(input.name);
        const description = this.normalizeDescription(input.description);
        const permissionKeys = this.normalizePermissionKeys(input.permissionKeys).sort();

        return this.runActorAuthorizedSerializableMutation(tenantId, async (tx) => {
            const permissionIds = await this.resolvePermissionIdsForMutation(
                tx,
                tenantId,
                permissionKeys,
                options,
                [roleId],
            );
            const role = await tx.role.findFirst({
                where: { id: roleId, tenantId, deletedAt: null },
                select: {
                    id: true,
                    isSystem: true,
                    name: true,
                    description: true,
                    rolePermissions: { select: { permission: { select: { key: true } } } },
                },
            });
            if (!role) return null;
            if (role.isSystem) {
                throw new ForbiddenException('System roles cannot be modified');
            }

            await tx.rolePermission.deleteMany({ where: { roleId } });
            const updated = await tx.role.update({
                where: { id: roleId },
                data: {
                    name,
                    description,
                    rolePermissions: {
                        createMany: {
                            data: permissionIds.map((permissionId) => ({ permissionId })),
                        },
                    },
                },
                include: {
                    rolePermissions: {
                        include: { permission: true },
                    },
                    _count: {
                        select: { assignments: true },
                    },
                },
            });
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: options.actorUserId,
                    actorUserId: options.actorUserId,
                    actorTenantId: tenantId,
                    ipAddress: options.ipAddress ?? null,
                    userAgent: options.userAgent ?? null,
                    action: 'ACCESS_ROLE_UPDATED',
                    resource: 'Role',
                    resourceId: roleId,
                    oldValue: {
                        name: migrationSafeRoleName(role.name),
                        description: role.description,
                        permissions: role.rolePermissions
                            .map((item) => canonicalPermissionKey(item.permission.key))
                            .sort(),
                    },
                    newValue: { name, description, permissions: permissionKeys },
                },
            });
            return updated;
        });
    }

    async deleteRole(tenantId: string, roleId: string, options: RoleMutationOptions) {
        const actorUserId = options.actorUserId?.trim();
        if (!actorUserId) {
            throw new ForbiddenException('A live actor identity is required to delete roles');
        }
        return this.runActorAuthorizedSerializableMutation(tenantId, async (tx) => {
            await this.resolvePermissionIdsForMutation(tx, tenantId, [], options, [roleId]);
            const role = await tx.role.findFirst({
                where: { id: roleId, tenantId, deletedAt: null },
                select: { id: true, isSystem: true, name: true },
            });
            if (!role) return false;
            if (role.isSystem) {
                throw new ForbiddenException('System roles cannot be deleted');
            }

            const assignmentCount = await tx.roleAssignment.count({ where: { tenantId, roleId } });
            if (assignmentCount > 0) {
                throw new ConflictException(
                    `Role cannot be deleted while ${assignmentCount} ${assignmentCount === 1 ? 'assignment exists' : 'assignments exist'}`,
                );
            }

            await tx.role.update({
                where: { id: roleId },
                data: { deletedAt: new Date() },
            });
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: actorUserId,
                    actorUserId,
                    actorTenantId: tenantId,
                    ipAddress: options.ipAddress ?? null,
                    userAgent: options.userAgent ?? null,
                    action: 'ACCESS_ROLE_DELETED',
                    resource: 'Role',
                    resourceId: roleId,
                    oldValue: { name: role.name },
                    newValue: { deleted: true },
                },
            });
            return true;
        });
    }

    private async replaceRolesForLockedUserInTransaction(
        tx: TenantPrismaTransaction,
        user: { id: string; role: UserRole },
        tenantId: string,
        requestedRoleIds: string[],
    ): Promise<RoleReplacementResult> {
        const roles = await tx.role.findMany({
            where: {
                tenantId,
                id: { in: requestedRoleIds },
                deletedAt: null,
            },
            select: {
                id: true,
                tenantId: true,
                name: true,
                description: true,
                isSystem: true,
                legacyRole: true,
                deletedAt: true,
                rolePermissions: {
                    select: { permission: { select: { key: true } } },
                },
            },
            orderBy: { id: 'asc' },
        });
        const validRoleIds = roles.map((role) => role.id);
        if (validRoleIds.length !== requestedRoleIds.length) {
            throw new BadRequestException('One or more roles are invalid for this tenant');
        }

        await tx.roleAssignment.deleteMany({
            where: {
                tenantId,
                userId: user.id,
            },
        });
        if (validRoleIds.length > 0) {
            await tx.roleAssignment.createMany({
                data: validRoleIds.map((roleId) => ({ tenantId, userId: user.id, roleId })),
                skipDuplicates: true,
            });
        }

        const legacyRole = this.reconciledLegacyRole(roles);
        if (user.role !== legacyRole) {
            await tx.user.update({
                where: { id: user.id },
                data: { role: legacyRole },
            });
        }
        return {
            legacyRole,
            assignedRoles: roles.map((role) => this.assignedRole(role)),
        };
    }

    async assignRolesToUserInTransaction(
        tx: TenantPrismaTransaction,
        userId: string,
        tenantId: string,
        roleIds: string[],
    ): Promise<RoleReplacementResult> {
        const requestedRoleIds = this.normalizeRoleIds(roleIds);
        await this.lockRoleMutationTenants(tx, [tenantId]);
        await this.lockRoleMutationUsers(tx, tenantId, [userId]);
        const user = await tx.user.findFirst({
            where: { id: userId, tenantId, deletedAt: null },
            select: { id: true, role: true },
        });
        if (!user) {
            throw new NotFoundException('User not found for this tenant');
        }
        await this.lockRoleMutationAssignments(tx, tenantId, [userId]);
        const currentAssignments = await tx.roleAssignment.findMany({
            where: { tenantId, userId },
            select: { userId: true, roleId: true },
            orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
        });
        const roleIdsToLock = [
            ...currentAssignments.map((assignment) => assignment.roleId),
            ...requestedRoleIds,
        ];
        await this.lockTenantRolesForAssignmentMutation(tx, tenantId, roleIdsToLock);
        await this.lockRoleMutationPermissions(tx, roleIdsToLock);

        return this.replaceRolesForLockedUserInTransaction(
            tx,
            user,
            tenantId,
            requestedRoleIds,
        );
    }

    async replaceLegacySystemRoleForPlatformAdminInTransaction(
        tx: TenantPrismaTransaction,
        userId: string,
        tenantId: string,
        legacyRole: UserRole,
    ): Promise<PlatformAdminSystemRoleReplacementResult> {
        const definition = DEFAULT_ROLE_DEFINITIONS.find((candidate) => candidate.legacyRole === legacyRole);
        if (!definition) {
            throw new BadRequestException('Selected role is invalid');
        }

        await this.lockRoleMutationTenants(tx, [tenantId]);
        await this.lockRoleMutationUsers(tx, tenantId, [userId]);
        const user = await tx.user.findFirst({
            where: { id: userId, tenantId, deletedAt: null },
            select: { id: true, role: true },
        });
        if (!user) {
            throw new NotFoundException('User not found for this tenant');
        }

        await this.lockRoleMutationAssignments(tx, tenantId, [userId]);
        const previousAssignments = await tx.roleAssignment.findMany({
            where: {
                tenantId,
                userId,
                role: { tenantId },
            },
            select: { roleId: true },
            orderBy: { roleId: 'asc' },
        });
        const targetRole = await tx.role.findFirst({
            where: {
                tenantId,
                slug: definition.slug,
                isSystem: true,
                legacyRole,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!targetRole) {
            throw new BadRequestException('Selected role is invalid for this tenant');
        }

        const previousRoleIds = previousAssignments.map((assignment) => assignment.roleId).sort();
        await this.lockTenantRolesForAssignmentMutation(
            tx,
            tenantId,
            [...previousRoleIds, targetRole.id],
        );
        await this.lockRoleMutationPermissions(tx, [...previousRoleIds, targetRole.id]);
        const replacement = await this.replaceRolesForLockedUserInTransaction(
            tx,
            user,
            tenantId,
            [targetRole.id],
        );
        const changed = user.role !== replacement.legacyRole
            || previousRoleIds.length !== 1
            || previousRoleIds[0] !== targetRole.id;

        return {
            ...replacement,
            changed,
            previousLegacyRole: user.role,
            previousRoleIds,
            roleId: targetRole.id,
        };
    }

    async replaceLegacySystemRoleForPlatformAdminActorInTransaction(
        tx: TenantPrismaTransaction,
        userId: string,
        tenantId: string,
        legacyRole: UserRole,
        actor: PlatformAdminMutationActor,
    ): Promise<PlatformAdminSystemRoleReplacementResult> {
        const definition = DEFAULT_ROLE_DEFINITIONS.find((candidate) => candidate.legacyRole === legacyRole);
        if (!definition) {
            throw new BadRequestException('Selected role is invalid');
        }

        const context = await this.lockPlatformAdminMutationIdentityInTransaction(
            tx,
            userId,
            actor,
            tenantId,
            'update',
        );
        const lockedAssignments = await this.lockPlatformRoleMutationAssignments(
            tx,
            [context.actorUserId, context.targetUserId],
        );
        const targetRole = await tx.role.findFirst({
            where: {
                tenantId: context.targetTenantId,
                slug: definition.slug,
                isSystem: true,
                legacyRole,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!targetRole) {
            throw new BadRequestException('Selected role is invalid for this tenant');
        }

        const roleIdsToLock = [
            ...lockedAssignments.map((assignment) => assignment.roleId),
            targetRole.id,
        ];
        await this.lockPlatformRolesForAssignmentMutation(tx, roleIdsToLock);
        await this.lockRoleMutationPermissions(tx, roleIdsToLock);

        const lockedTargetRole = await tx.role.findFirst({
            where: {
                id: targetRole.id,
                tenantId: context.targetTenantId,
                slug: definition.slug,
                isSystem: true,
                legacyRole,
                deletedAt: null,
            },
            select: { id: true },
        });
        if (!lockedTargetRole) {
            throw new BadRequestException('Selected role is invalid for this tenant');
        }
        const actorAccess = await this.assertPlatformAdminAuthorityForLockedRolesInTransaction(
            tx,
            context.actor,
            context.actorUserId,
            context.actorTenantId,
            lockedAssignments
                .filter((assignment) => assignment.tenantId === context.actorTenantId
                    && assignment.userId === context.actorUserId)
                .map((assignment) => assignment.roleId),
            legacyRole === UserRole.SUPER_ADMIN,
        );

        const targetRoleIds = lockedAssignments
            .filter((assignment) => assignment.tenantId === context.targetTenantId
                && assignment.userId === context.targetUserId)
            .map((assignment) => assignment.roleId);
        const targetRoles = await tx.role.findMany({
            where: {
                tenantId: context.targetTenantId,
                id: { in: targetRoleIds },
                deletedAt: null,
            },
            include: { rolePermissions: { include: { permission: true } } },
            orderBy: { id: 'asc' },
        });
        const targetAccess = this.currentAccess(
            context.target.role,
            targetRoles.map((role) => ({
                userId: context.targetUserId,
                roleId: role.id,
                role,
            })),
        );
        if (targetAccess.isSystemAdmin && !actorAccess.isSystemAdmin) {
            throw new ForbiddenException('Only system admins can administer system admins');
        }

        const previousRoleIds = lockedAssignments
            .filter((assignment) => assignment.tenantId === context.targetTenantId
                && assignment.userId === context.targetUserId)
            .map((assignment) => assignment.roleId)
            .sort();
        const replacement = await this.replaceRolesForLockedUserInTransaction(
            tx,
            context.target,
            context.targetTenantId,
            [lockedTargetRole.id],
        );
        const changed = context.target.role !== replacement.legacyRole
            || previousRoleIds.length !== 1
            || previousRoleIds[0] !== lockedTargetRole.id;

        return {
            ...replacement,
            changed,
            previousLegacyRole: context.target.role,
            previousRoleIds,
            roleId: lockedTargetRole.id,
        };
    }

    async assignRolesToUser(userId: string, tenantId: string, roleIds: string[]) {
        await this.tenantDb.withTenant(tenantId, (tx) =>
            this.assignRolesToUserInTransaction(tx, userId, tenantId, roleIds),
        { isolationLevel: 'Serializable' });

        return this.getUserRoleAssignments(userId, tenantId);
    }

    async replaceUserRolesAsActor(
        tenantId: string,
        request: UserRoleReplacementRequest,
    ): Promise<UserRoleReplacementResult> {
        const actorUserId = request.actorUserId?.trim();
        const targetUserId = request.targetUserId?.trim();
        if (!actorUserId) {
            throw new ForbiddenException('A live actor identity is required to modify user access');
        }
        if (!targetUserId) {
            throw new NotFoundException('User not found');
        }

        return this.runActorAuthorizedSerializableMutation(tenantId, async (tx) => {
            if (actorUserId === targetUserId) {
                throw new ForbiddenException(request.selfMutationMessage);
            }

            await this.lockRoleMutationTenants(tx, [tenantId]);
            await lockTenantSchedulingMutations(tx, tenantId, true);
            const userIds = [actorUserId, targetUserId];
            await this.lockRoleMutationUsers(tx, tenantId, userIds);
            const users = await tx.user.findMany({
                where: {
                    tenantId,
                    id: { in: userIds },
                    deletedAt: null,
                },
                select: {
                    id: true,
                    role: true,
                    suspendedAt: true,
                    lockedUntil: true,
                    pinLockedUntil: true,
                },
            });
            const actor = users.find((user) => user.id === actorUserId);
            const target = users.find((user) => user.id === targetUserId);
            if (!target) throw new NotFoundException('User not found');
            if (!actor) throw new ForbiddenException('Administrator account is inactive');
            if (actor.suspendedAt) throw new ForbiddenException('Administrator account is suspended');
            this.assertMutationActorUnlocked(actor);
            await this.lockAndValidateActorSession(tx, actorUserId, request.actorSessionId);

            await this.lockRoleMutationAssignments(tx, tenantId, userIds);
            const lockedAssignmentRows = await tx.roleAssignment.findMany({
                where: { tenantId, userId: { in: userIds } },
                select: { userId: true, roleId: true },
                orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
            });

            let requestedRoleIds: string[];
            if (request.legacyRole) {
                const legacyRoles = await tx.role.findMany({
                    where: {
                        tenantId,
                        isSystem: true,
                        legacyRole: request.legacyRole,
                        deletedAt: null,
                    },
                    select: { id: true },
                    orderBy: { id: 'asc' },
                });
                const selectedRole = legacyRoles[0];
                if (!selectedRole) {
                    throw new BadRequestException('Selected role is invalid for this tenant');
                }
                requestedRoleIds = [selectedRole.id];
            } else {
                requestedRoleIds = this.normalizeRoleIds(request.roleIds);
            }

            const roleIdsToLock = [
                ...lockedAssignmentRows.map((assignment) => assignment.roleId),
                ...requestedRoleIds,
            ];
            await this.lockTenantRolesForAssignmentMutation(
                tx,
                tenantId,
                roleIdsToLock,
            );
            await this.lockRoleMutationPermissions(tx, roleIdsToLock);

            const assignments = await tx.roleAssignment.findMany({
                where: {
                    tenantId,
                    userId: { in: userIds },
                    role: { tenantId, deletedAt: null },
                },
                include: {
                    role: {
                        include: {
                            rolePermissions: { include: { permission: true } },
                        },
                    },
                },
                orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
            });
            const requestedRoles = await tx.role.findMany({
                where: {
                    tenantId,
                    id: { in: requestedRoleIds },
                    deletedAt: null,
                },
                include: {
                    rolePermissions: { include: { permission: true } },
                },
                orderBy: { id: 'asc' },
            });
            const legacyRoleChangedWhileLocking = request.legacyRole
                && (requestedRoles.length !== 1
                    || !requestedRoles[0].isSystem
                    || requestedRoles[0].legacyRole !== request.legacyRole);
            if (requestedRoles.length !== requestedRoleIds.length || legacyRoleChangedWhileLocking) {
                throw new BadRequestException('One or more roles are invalid for this tenant');
            }

            const actorAssignments = assignments.filter((assignment) => assignment.userId === actorUserId);
            const targetAssignments = assignments.filter((assignment) => assignment.userId === targetUserId);
            const actorAccess = this.currentAccess(actor.role, actorAssignments);
            const targetAccess = this.currentAccess(target.role, targetAssignments);

            if (!actorAccess.permissions.has(request.requiredPermission)) {
                throw new ForbiddenException(
                    `${request.requiredPermission} permission is no longer active for this account`,
                );
            }
            if (targetAccess.isSystemAdmin && !actorAccess.isSystemAdmin) {
                throw new ForbiddenException('Only system admins can administer system admins');
            }
            const targetHasUnheldPermission = Array.from(targetAccess.permissions)
                .some((permission) => !actorAccess.permissions.has(permission));
            const sameEffectivePermissions = actorAccess.permissions.size === targetAccess.permissions.size
                && !targetHasUnheldPermission;
            if (actorAccess.rank <= targetAccess.rank || targetHasUnheldPermission || sameEffectivePermissions) {
                throw new ForbiddenException('Cannot administer an account with equal or greater access');
            }

            const requestedPermissions = new Set(
                requestedRoles.flatMap((role) => role.rolePermissions
                    .map((item) => canonicalPermissionKey(item.permission.key))),
            );
            const requestsSystemAdmin = requestedRoles.some((role) =>
                role.isSystem && role.legacyRole === UserRole.SUPER_ADMIN);
            const requestsProtectedPermission = Array.from(requestedPermissions)
                .some((permission) => PROTECTED_PERMISSION_KEYS.has(permission));
            if (!actorAccess.isSystemAdmin && (requestsSystemAdmin || requestsProtectedPermission)) {
                throw new ForbiddenException('Only system admins can grant system admin access');
            }
            if (Array.from(requestedPermissions)
                .some((permission) => !actorAccess.permissions.has(permission))) {
                throw new ForbiddenException('Cannot grant a role with permissions you do not hold');
            }

            const beforeRoleIds = lockedAssignmentRows
                .filter((assignment) => assignment.userId === targetUserId)
                .map((assignment) => assignment.roleId)
                .sort();
            const replacement = await this.replaceRolesForLockedUserInTransaction(
                tx,
                target,
                tenantId,
                requestedRoleIds,
            );
            if (!SCHEDULABLE_USER_ROLES.includes(replacement.legacyRole)) {
                await unassignEditableShiftsForIneligibleUser(
                    tx,
                    tenantId,
                    targetUserId,
                );
            }
            const afterRoleIds = [...requestedRoleIds].sort();
            const assignmentsChanged = beforeRoleIds.length !== afterRoleIds.length
                || beforeRoleIds.some((roleId, index) => roleId !== afterRoleIds[index]);
            const changed = assignmentsChanged || target.role !== replacement.legacyRole;
            let sessionsRevoked = 0;
            if (changed) {
                const revoked = await tx.session.updateMany({
                    where: { userId: targetUserId, revokedAt: null },
                    data: { revokedAt: new Date() },
                });
                sessionsRevoked = revoked.count;
            }

            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: actorUserId,
                    actorUserId,
                    actorTenantId: tenantId,
                    action: request.auditAction,
                    resource: 'User',
                    resourceId: targetUserId,
                    oldValue: { role: target.role, roleIds: beforeRoleIds },
                    newValue: { role: replacement.legacyRole, roleIds: afterRoleIds },
                },
            });

            return { ...replacement, changed, sessionsRevoked };
        });
    }

    async getUserRoleAssignments(userId: string, tenantId: string) {
        const assignments = await this.tenantDb.withTenant(tenantId, (tx) => tx.roleAssignment.findMany({
            where: {
                tenantId,
                userId,
                role: {
                    tenantId,
                    deletedAt: null,
                },
            },
            include: {
                role: {
                    include: {
                        rolePermissions: {
                            include: {
                                permission: true,
                            },
                        },
                    },
                },
            },
        }));

        return assignments.map((assignment) => ({
            id: assignment.role.id,
            name: migrationSafeRoleName(assignment.role.name),
            description: assignment.role.description,
            isSystem: assignment.role.isSystem,
            legacyRole: assignment.role.legacyRole,
            permissions: assignment.role.rolePermissions.map((item) => item.permission.key).sort(),
        }));
    }
}
