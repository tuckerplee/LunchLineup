import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { RBAC_PERMISSION_CATALOG, RbacService } from './rbac.service';

describe('RbacService role mutation protections', () => {
    let service: RbacService;
    let prisma: any;

    beforeEach(() => {
        prisma = {
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
            $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>) => operation(prisma)),
            user: {
                findFirst: vi.fn(),
            },
            role: {
                create: vi.fn(),
                findFirst: vi.fn(),
                findMany: vi.fn(),
                update: vi.fn(),
                upsert: vi.fn(),
            },
            permission: {
                findMany: vi.fn(),
                upsert: vi.fn(),
            },
            rolePermission: {
                deleteMany: vi.fn(),
                createMany: vi.fn(),
            },
            roleAssignment: {
                count: vi.fn(),
                deleteMany: vi.fn(),
                create: vi.fn(),
                createMany: vi.fn(),
                findMany: vi.fn(),
            },
        };
        service = new RbacService(new TenantPrismaService(prisma));
    });

    it('rejects updates to system roles before changing role permissions', async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 'role-system', isSystem: true });

        await expect(
            service.updateRole('tenant-1', 'role-system', {
                name: 'Edited System Role',
                permissionKeys: ['schedules:write'],
            }, { actorUserId: 'actor-1' }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.permission.findMany).not.toHaveBeenCalled();
        expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled();
        expect(prisma.role.update).not.toHaveBeenCalled();
    });

    it.each([
        ' admin_portal:access ',
        '\tTENANT_ACCOUNT:LIFECYCLE\r\n',
        '\u00a0ADMIN_PORTAL:ACCESS\u00a0',
    ])('rejects canonicalized protected permission %j by default', async (permissionKey) => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.roleAssignment.findMany.mockResolvedValue([{
            role: {
                isSystem: true,
                legacyRole: 'ADMIN',
                rolePermissions: [{ permission: { key: 'roles:write' } }],
            },
        }]);

        await expect(service.createRole('tenant-1', {
            name: 'Escalated role',
            permissionKeys: [permissionKey],
        }, { actorUserId: 'actor-1' })).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.permission.findMany).not.toHaveBeenCalled();
        expect(prisma.role.create).not.toHaveBeenCalled();
    });

    it('allows a system-admin caller to grant a canonicalized protected permission', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.roleAssignment.findMany.mockResolvedValue([{
            role: {
                isSystem: true,
                legacyRole: 'SUPER_ADMIN',
                rolePermissions: [],
            },
        }]);
        prisma.permission.findMany.mockResolvedValue([{ id: 'permission-admin', key: 'admin_portal:access' }]);
        prisma.role.create.mockResolvedValue({ id: 'role-platform', rolePermissions: [] });

        await service.createRole('tenant-1', {
            name: 'Platform access',
            permissionKeys: ['  ADMIN_PORTAL:ACCESS  '],
        }, { actorUserId: 'system-admin-1' });

        expect(prisma.permission.findMany).toHaveBeenCalledWith({
            where: { key: { in: ['admin_portal:access'] } },
            select: { id: true, key: true },
        });
        expect(prisma.role.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                rolePermissions: {
                    createMany: { data: [{ permissionId: 'permission-admin' }] },
                },
            }),
        }));
    });

    it('rejects permissions present only in a stale caller token', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.roleAssignment.findMany.mockResolvedValue([{
            role: {
                isSystem: false,
                legacyRole: null,
                rolePermissions: [{ permission: { key: 'roles:write' } }],
            },
        }]);

        await expect(service.createRole('tenant-1', {
            name: 'Billing escalation',
            permissionKeys: ['roles:write', 'billing:write'],
        }, { actorUserId: 'actor-1' })).rejects.toThrow('permissions you do not currently hold');

        expect(prisma.permission.findMany).not.toHaveBeenCalled();
        expect(prisma.role.create).not.toHaveBeenCalled();
    });

    it('prevents self-escalation when the caller edits their own assigned role', async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 'role-editor', isSystem: false });
        prisma.roleAssignment.findMany.mockResolvedValue([{
            role: {
                isSystem: false,
                legacyRole: null,
                rolePermissions: [{ permission: { key: 'roles:write' } }],
            },
        }]);

        await expect(service.updateRole('tenant-1', 'role-editor', {
            name: 'Role editor',
            permissionKeys: ['roles:write', 'users:admin'],
        }, { actorUserId: 'actor-1' })).rejects.toThrow('permissions you do not currently hold');

        expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled();
        expect(prisma.role.update).not.toHaveBeenCalled();
    });

    it('preserves legitimate subset role creation', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.roleAssignment.findMany.mockResolvedValue([{
            role: {
                isSystem: true,
                legacyRole: 'ADMIN',
                rolePermissions: [
                    { permission: { key: 'roles:write' } },
                    { permission: { key: 'users:read' } },
                ],
            },
        }]);
        prisma.permission.findMany.mockResolvedValue([{ id: 'permission-users-read', key: 'users:read' }]);
        prisma.role.create.mockResolvedValue({ id: 'role-reader', rolePermissions: [] });

        await service.createRole('tenant-1', {
            name: 'User reader',
            permissionKeys: ['users:read'],
        }, { actorUserId: 'actor-1' });

        expect(prisma.role.create).toHaveBeenCalled();
    });

    it('rejects deletes for system roles before soft-deleting or removing assignments', async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 'role-system', isSystem: true });

        await expect(service.deleteRole('tenant-1', 'role-system')).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.role.update).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects custom role deletion while assignments exist without changing the role or assignments', async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 'role-custom', isSystem: false });
        prisma.roleAssignment.count.mockResolvedValue(2);

        await expect(service.deleteRole('tenant-1', 'role-custom'))
            .rejects.toThrow('Role cannot be deleted while 2 assignments exist');

        expect(prisma.roleAssignment.count).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', roleId: 'role-custom' },
        });
        expect(prisma.role.update).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('soft-deletes an unassigned custom role without deleting assignment rows', async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 'role-custom', isSystem: false });
        prisma.roleAssignment.count.mockResolvedValue(0);
        prisma.role.update.mockResolvedValue({ id: 'role-custom' });

        await expect(service.deleteRole('tenant-1', 'role-custom')).resolves.toBe(true);

        expect(prisma.role.update).toHaveBeenCalledWith({
            where: { id: 'role-custom' },
            data: { deletedAt: expect.any(Date) },
        });
        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects role assignment when the user is not in the tenant', async () => {
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(
            service.assignRolesToUser('user-foreign', 'tenant-1', ['role-admin']),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.createMany).not.toHaveBeenCalled();
    });

    it('rejects unknown role ids before replacing assignments', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
        prisma.role.findMany.mockResolvedValue([{ id: 'role-admin' }]);

        await expect(
            service.assignRolesToUser('user-1', 'tenant-1', ['role-admin', 'role-foreign']),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.createMany).not.toHaveBeenCalled();
    });

    it('scopes role replacement deletes to the tenant role set', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
        prisma.role.findMany.mockResolvedValue([{ id: 'role-admin' }]);
        prisma.roleAssignment.findMany.mockResolvedValue([
            {
                role: {
                    id: 'role-admin',
                    name: 'Admin',
                    description: null,
                    isSystem: true,
                    legacyRole: 'ADMIN',
                    rolePermissions: [{ permission: { key: 'users:read' } }],
                },
            },
        ]);

        const result = await service.assignRolesToUser('user-1', 'tenant-1', ['role-admin']);

        expect(prisma.roleAssignment.deleteMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                userId: 'user-1',
                role: {
                    tenantId: 'tenant-1',
                },
            },
        });
        expect(prisma.roleAssignment.createMany).toHaveBeenCalledWith({
            data: [{ tenantId: 'tenant-1', userId: 'user-1', roleId: 'role-admin' }],
            skipDuplicates: true,
        });
        expect(prisma.$queryRaw).toHaveBeenCalled();
        expect(result).toEqual([
            expect.objectContaining({
                id: 'role-admin',
                permissions: ['users:read'],
            }),
        ]);
    });

    it('uses the supplied transaction for atomic role assignment', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
        prisma.role.findMany.mockResolvedValue([{ id: 'role-admin' }]);

        await service.assignRolesToUserInTransaction(prisma, 'user-1', 'tenant-1', ['role-admin']);

        expect(prisma.roleAssignment.deleteMany).toHaveBeenCalled();
        expect(prisma.roleAssignment.createMany).toHaveBeenCalledWith({
            data: [{ tenantId: 'tenant-1', userId: 'user-1', roleId: 'role-admin' }],
            skipDuplicates: true,
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects legacy role assignment when the user is not in the tenant', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.user.findFirst.mockResolvedValue(null);

        await expect(
            service.assignLegacySystemRole('user-foreign', 'tenant-1', 'ADMIN' as any),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(prisma.role.findFirst).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.create).not.toHaveBeenCalled();
    });

    it('writes tenant id when assigning a legacy system role', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
        prisma.role.findFirst.mockResolvedValue({ id: 'role-admin' });

        await service.assignLegacySystemRole('user-1', 'tenant-1', 'ADMIN' as any);

        expect(prisma.roleAssignment.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'user-1',
                roleId: 'role-admin',
            },
        });
    });

    it('provisions default roles and assigns the owner using the supplied transaction', async () => {
        prisma.permission.findMany.mockResolvedValue(
            RBAC_PERMISSION_CATALOG.map((permission, index) => ({
                id: `permission-${index}`,
                key: permission.key,
            })),
        );
        prisma.role.upsert.mockImplementation(async ({ create }: any) => ({ id: `role-${create.slug}` }));
        prisma.user.findFirst.mockResolvedValue({ id: 'owner-1' });
        prisma.role.findFirst.mockResolvedValue({ id: 'role-admin' });

        await service.provisionLegacySystemRole(prisma, 'owner-1', 'tenant-1', 'ADMIN' as any);

        expect(prisma.permission.upsert).toHaveBeenCalledTimes(RBAC_PERMISSION_CATALOG.length);
        expect(prisma.role.upsert).toHaveBeenCalledTimes(4);
        expect(prisma.roleAssignment.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'owner-1',
                roleId: 'role-admin',
            },
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});
