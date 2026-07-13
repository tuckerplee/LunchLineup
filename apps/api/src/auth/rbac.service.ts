import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { PermissionCategory, PrismaClient, UserRole } from '@prisma/client';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';

type CatalogPermission = {
    key: string;
    label: string;
    description: string;
    category: PermissionCategory;
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
    { key: 'admin_portal:access', label: 'Access admin portal', description: 'Access the system administration portal.', category: PermissionCategory.ADMIN },
    { key: 'tenant_account:lifecycle', label: 'Manage tenant lifecycle', description: 'Cancel or request deletion for a tenant account.', category: PermissionCategory.ADMIN },
    { key: 'account:data_export', label: 'Export tenant data', description: 'Export the complete tenant account data set.', category: PermissionCategory.ADMIN },
    { key: 'auth:login_email', label: 'Email login', description: 'Authenticate with work email and one-time passcode.', category: PermissionCategory.AUTH },
    { key: 'auth:login_pin', label: 'PIN login', description: 'Authenticate with username and PIN.', category: PermissionCategory.AUTH },
    { key: 'auth:login_password', label: 'Password login', description: 'Authenticate with migrated username and password.', category: PermissionCategory.AUTH },
    { key: 'users:read', label: 'View staff', description: 'Read staff directory and user details.', category: PermissionCategory.USERS },
    { key: 'users:write', label: 'Create staff', description: 'Invite staff and update basic account details.', category: PermissionCategory.USERS },
    { key: 'users:admin', label: 'Administer staff', description: 'Reset login credentials and deactivate users.', category: PermissionCategory.USERS },
    { key: 'roles:read', label: 'View access roles', description: 'Read role and permission definitions.', category: PermissionCategory.USERS },
    { key: 'roles:write', label: 'Manage access roles', description: 'Create, edit, and delete tenant-defined roles.', category: PermissionCategory.USERS },
    { key: 'roles:assign', label: 'Assign access roles', description: 'Assign or revoke roles for staff members.', category: PermissionCategory.USERS },
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
    { key: 'notifications:read', label: 'View notifications', description: 'Read notifications.', category: PermissionCategory.NOTIFICATIONS },
    { key: 'notifications:write', label: 'Manage notifications', description: 'Create and mark notifications.', category: PermissionCategory.NOTIFICATIONS },
    { key: 'billing:read', label: 'View billing', description: 'Read billing and credits data.', category: PermissionCategory.BILLING },
    { key: 'billing:write', label: 'Manage billing', description: 'Modify billing and credits data.', category: PermissionCategory.BILLING },
    { key: 'settings:read', label: 'View settings', description: 'Read tenant settings.', category: PermissionCategory.SETTINGS },
    { key: 'settings:write', label: 'Manage settings', description: 'Update tenant settings.', category: PermissionCategory.SETTINGS },
];

export const ALL_PERMISSION_KEYS = RBAC_PERMISSION_CATALOG.map((permission) => permission.key);
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
        const name = value.trim();
        if (!name) {
            throw new BadRequestException('Role name is required');
        }
        if (name.length > 80) {
            throw new BadRequestException('Role name must be 80 characters or less');
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

    private async resolvePermissionIdsForMutation(
        tx: TenantPrismaTransaction,
        tenantId: string,
        permissionKeysRaw: unknown,
        options: RoleMutationOptions,
    ): Promise<string[]> {
        const permissionKeys = Array.from(new Set(this.normalizePermissionKeys(permissionKeysRaw)));
        if (permissionKeys.some((key) => !ALL_PERMISSION_KEY_SET.has(key))) {
            throw new BadRequestException('One or more permissions are invalid');
        }

        const actorUserId = options.actorUserId?.trim();
        if (!actorUserId) {
            throw new ForbiddenException('A live actor identity is required to modify roles');
        }
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
        });
        const isSystemAdmin = assignments.some((assignment) =>
            assignment.role.isSystem && assignment.role.legacyRole === UserRole.SUPER_ADMIN);
        const actorPermissions = new Set(
            assignments.flatMap((assignment) =>
                assignment.role.rolePermissions.map((item) => canonicalPermissionKey(item.permission.key))),
        );

        if (!isSystemAdmin && !actorPermissions.has('roles:write')) {
            throw new ForbiddenException('roles:write permission is no longer active for this account');
        }
        if (!isSystemAdmin && permissionKeys.some((key) => PROTECTED_PERMISSION_KEYS.has(key))) {
            throw new ForbiddenException('Only system admins can grant protected admin permissions');
        }
        if (!isSystemAdmin && permissionKeys.some((key) => !actorPermissions.has(key))) {
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
                    create: permission,
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

    async ensureTenantRoles(tenantId: string): Promise<void> {
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
                name: assignment.role.name,
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
        return this.tenantDb.withTenant(tenantId, (tx) => tx.role.findMany({
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
        }));
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
        await this.ensureTenantRoles(tenantId);
        const name = this.normalizeRoleName(input.name);
        const description = this.normalizeDescription(input.description);
        const slugBase = this.slugify(name);
        const slug = slugBase || `role-${Date.now().toString(36)}`;

        const role = await this.tenantDb.withTenant(tenantId, async (tx) => {
            const permissionIds = await this.resolvePermissionIdsForMutation(tx, tenantId, input.permissionKeys, options);
            return tx.role.create({
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

        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const role = await tx.role.findFirst({
                where: { id: roleId, tenantId, deletedAt: null },
                select: { id: true, isSystem: true },
            });
            if (!role) return null;
            if (role.isSystem) {
                throw new ForbiddenException('System roles cannot be modified');
            }

            const permissionIds = await this.resolvePermissionIdsForMutation(tx, tenantId, input.permissionKeys, options);
            await tx.rolePermission.deleteMany({ where: { roleId } });
            return tx.role.update({
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
        });
    }

    async deleteRole(tenantId: string, roleId: string) {
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            const role = await tx.role.findFirst({
                where: { id: roleId, tenantId, deletedAt: null },
                select: { id: true, isSystem: true },
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
            return true;
        });
    }

    async assignRolesToUserInTransaction(
        tx: TenantPrismaTransaction,
        userId: string,
        tenantId: string,
        roleIds: string[],
    ): Promise<void> {
        const requestedRoleIds = this.normalizeStringList(roleIds, 'roleIds');
        const user = await tx.user.findFirst({
            where: { id: userId, tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!user) {
            throw new NotFoundException('User not found for this tenant');
        }

        const roles = await tx.role.findMany({
            where: {
                tenantId,
                id: { in: requestedRoleIds },
                deletedAt: null,
            },
            select: { id: true },
        });
        const validRoleIds = roles.map((role) => role.id);
        if (validRoleIds.length !== requestedRoleIds.length) {
            throw new BadRequestException('One or more roles are invalid for this tenant');
        }

        await tx.roleAssignment.deleteMany({
            where: {
                tenantId,
                userId,
                role: {
                    tenantId,
                },
            },
        });
        if (validRoleIds.length > 0) {
            await tx.roleAssignment.createMany({
                data: validRoleIds.map((roleId) => ({ tenantId, userId, roleId })),
                skipDuplicates: true,
            });
        }
    }

    async assignRolesToUser(userId: string, tenantId: string, roleIds: string[]) {
        await this.tenantDb.withTenant(tenantId, (tx) =>
            this.assignRolesToUserInTransaction(tx, userId, tenantId, roleIds));

        return this.getUserRoleAssignments(userId, tenantId);
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
            name: assignment.role.name,
            description: assignment.role.description,
            isSystem: assignment.role.isSystem,
            legacyRole: assignment.role.legacyRole,
            permissions: assignment.role.rolePermissions.map((item) => item.permission.key).sort(),
        }));
    }
}
