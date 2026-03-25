import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PermissionCategory, PrismaClient, UserRole } from '@prisma/client';

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
    { key: 'auth:login_email', label: 'Email login', description: 'Authenticate with work email and one-time passcode.', category: PermissionCategory.AUTH },
    { key: 'auth:login_pin', label: 'PIN login', description: 'Authenticate with username and PIN.', category: PermissionCategory.AUTH },
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
    { key: 'notifications:read', label: 'View notifications', description: 'Read notifications.', category: PermissionCategory.NOTIFICATIONS },
    { key: 'notifications:write', label: 'Manage notifications', description: 'Create and mark notifications.', category: PermissionCategory.NOTIFICATIONS },
    { key: 'billing:read', label: 'View billing', description: 'Read billing and credits data.', category: PermissionCategory.BILLING },
    { key: 'billing:write', label: 'Manage billing', description: 'Modify billing and credits data.', category: PermissionCategory.BILLING },
    { key: 'settings:read', label: 'View settings', description: 'Read tenant settings.', category: PermissionCategory.SETTINGS },
    { key: 'settings:write', label: 'Manage settings', description: 'Update tenant settings.', category: PermissionCategory.SETTINGS },
];

const ALL_PERMISSION_KEYS = RBAC_PERMISSION_CATALOG.map((permission) => permission.key);

const DEFAULT_ROLE_DEFINITIONS: DefaultRoleDefinition[] = [
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
            'notifications:read',
            'notifications:write',
            'billing:read',
            'billing:write',
            'settings:read',
            'settings:write',
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
            'auth:login_pin',
            'locations:read',
            'shifts:read',
            'schedules:read',
            'lunch_breaks:read',
            'lunch_breaks:write',
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
    private prisma = new PrismaClient();

    private slugify(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48);
    }

    async ensurePermissionCatalog(): Promise<void> {
        await Promise.all(
            RBAC_PERMISSION_CATALOG.map((permission) =>
                this.prisma.permission.upsert({
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

    async ensureTenantRoles(tenantId: string): Promise<void> {
        await this.ensurePermissionCatalog();

        const permissionRows = await this.prisma.permission.findMany({
            where: { key: { in: ALL_PERMISSION_KEYS } },
            select: { id: true, key: true },
        });
        const permissionIdByKey = new Map(permissionRows.map((row) => [row.key, row.id]));

        for (const definition of DEFAULT_ROLE_DEFINITIONS) {
            const role = await this.prisma.role.upsert({
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

            await this.prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
            if (definition.permissions.length > 0) {
                await this.prisma.rolePermission.createMany({
                    data: definition.permissions
                        .map((key) => permissionIdByKey.get(key))
                        .filter((value): value is string => Boolean(value))
                        .map((permissionId) => ({ roleId: role.id, permissionId })),
                    skipDuplicates: true,
                });
            }
        }
    }

    async assignLegacySystemRole(userId: string, tenantId: string, legacyRole: UserRole): Promise<void> {
        await this.ensureTenantRoles(tenantId);
        const role = await this.prisma.role.findFirst({
            where: { tenantId, legacyRole, deletedAt: null },
            select: { id: true },
        });
        if (!role) {
            throw new ForbiddenException(`No RBAC role is configured for legacy role ${legacyRole}`);
        }
        await this.prisma.roleAssignment.create({
            data: { userId, roleId: role.id },
        });
    }

    async getEffectiveAccess(userId: string, tenantId: string): Promise<EffectiveAccess> {
        const assignments = await this.prisma.roleAssignment.findMany({
            where: {
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
        });

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
        return this.prisma.role.findMany({
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
        });
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

    async createRole(tenantId: string, input: { name: string; description?: string; permissionKeys: string[] }) {
        await this.ensureTenantRoles(tenantId);
        const name = input.name.trim();
        const slugBase = this.slugify(name);
        const slug = slugBase || `role-${Date.now().toString(36)}`;
        const permissions = await this.prisma.permission.findMany({
            where: { key: { in: input.permissionKeys } },
            select: { id: true },
        });

        const role = await this.prisma.role.create({
            data: {
                tenantId,
                name,
                slug,
                description: input.description?.trim() || null,
                isSystem: false,
                rolePermissions: {
                    createMany: {
                        data: permissions.map((permission) => ({ permissionId: permission.id })),
                    },
                },
            },
            include: {
                rolePermissions: {
                    include: { permission: true },
                },
            },
        });

        return role;
    }

    async updateRole(tenantId: string, roleId: string, input: { name: string; description?: string; permissionKeys: string[] }) {
        const role = await this.prisma.role.findFirst({
            where: { id: roleId, tenantId, deletedAt: null },
            select: { id: true, isSystem: true },
        });
        if (!role) return null;

        const permissions = await this.prisma.permission.findMany({
            where: { key: { in: input.permissionKeys } },
            select: { id: true },
        });

        await this.prisma.rolePermission.deleteMany({ where: { roleId } });
        return this.prisma.role.update({
            where: { id: roleId },
            data: {
                name: input.name.trim(),
                description: input.description?.trim() || null,
                rolePermissions: {
                    createMany: {
                        data: permissions.map((permission) => ({ permissionId: permission.id })),
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
    }

    async deleteRole(tenantId: string, roleId: string) {
        const role = await this.prisma.role.findFirst({
            where: { id: roleId, tenantId, deletedAt: null },
            select: { id: true, isSystem: true },
        });
        if (!role || role.isSystem) return false;

        await this.prisma.role.update({
            where: { id: roleId },
            data: { deletedAt: new Date() },
        });
        await this.prisma.roleAssignment.deleteMany({ where: { roleId } });
        return true;
    }

    async assignRolesToUser(userId: string, tenantId: string, roleIds: string[]) {
        const roles = await this.prisma.role.findMany({
            where: {
                tenantId,
                id: { in: roleIds },
                deletedAt: null,
            },
            select: { id: true },
        });
        const validRoleIds = roles.map((role) => role.id);

        await this.prisma.roleAssignment.deleteMany({ where: { userId } });
        if (validRoleIds.length > 0) {
            await this.prisma.roleAssignment.createMany({
                data: validRoleIds.map((roleId) => ({ userId, roleId })),
                skipDuplicates: true,
            });
        }

        return this.getUserRoleAssignments(userId, tenantId);
    }

    async getUserRoleAssignments(userId: string, tenantId: string) {
        const assignments = await this.prisma.roleAssignment.findMany({
            where: {
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
        });

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
