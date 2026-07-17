import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import {
    DEFAULT_ROLE_DEFINITIONS,
    MAX_CUSTOM_ROLES_PER_TENANT,
    MAX_ROLES_PER_USER,
    PRIVILEGED_MFA_PERMISSION_KEYS,
    RBAC_PERMISSION_CATALOG,
    RbacService,
} from './rbac.service';

describe('payroll authorization defaults', () => {
    const payrollPermissions = [
        'time_cards:approve',
        'payroll:read',
        'payroll:policy_write',
        'payroll:lock',
        'payroll:export',
        'payroll:reconcile',
    ];

    it('publishes the exact time-card and payroll permission catalog categories', () => {
        const catalog = new Map(RBAC_PERMISSION_CATALOG.map((permission) => [permission.key, permission]));

        expect(payrollPermissions.filter((permission) => catalog.has(permission))).toEqual(payrollPermissions);
        expect(catalog.get('time_cards:approve')?.category).toBe('TIME_CARDS');
        for (const permission of payrollPermissions.slice(1)) {
            expect(catalog.get(permission)?.category).toBe('PAYROLL');
        }
    });

    it('grants all six to admins, only approve/read to managers, and none to staff', () => {
        const permissionsFor = (legacyRole: string) => new Set(
            DEFAULT_ROLE_DEFINITIONS.find((definition) => definition.legacyRole === legacyRole)?.permissions ?? [],
        );

        for (const role of ['SUPER_ADMIN', 'ADMIN']) {
            expect(payrollPermissions.filter((permission) => permissionsFor(role).has(permission)))
                .toEqual(payrollPermissions);
        }
        expect(payrollPermissions.filter((permission) => permissionsFor('MANAGER').has(permission)))
            .toEqual(['time_cards:approve', 'payroll:read']);
        expect(payrollPermissions.filter((permission) => permissionsFor('STAFF').has(permission))).toEqual([]);
        expect(permissionsFor('STAFF').has('time_cards:read')).toBe(true);
        expect(permissionsFor('STAFF').has('time_cards:write')).toBe(true);
    });

    it('derives the exact privileged MFA set from canonical permission metadata', () => {
        const catalogSensitive = RBAC_PERMISSION_CATALOG
            .filter((permission) => permission.requiresMfa === true)
            .map((permission) => permission.key)
            .sort();
        const expected = [
            'account:data_export',
            'admin_portal:access',
            'billing:write',
            'payroll:export',
            'payroll:lock',
            'payroll:policy_write',
            'payroll:read',
            'payroll:reconcile',
            'roles:assign',
            'roles:write',
            'settings:write',
            'tenant_account:lifecycle',
            'time_cards:approve',
            'users:admin',
            'users:write',
        ];

        expect(catalogSensitive).toEqual(expected);
        expect([...PRIVILEGED_MFA_PERMISSION_KEYS].sort()).toEqual(expected);
        expect(PRIVILEGED_MFA_PERMISSION_KEYS.has('payroll:read')).toBe(true);
    });
});

describe('RbacService role mutation protections', () => {
    let service: RbacService;
    let prisma: any;

    beforeEach(() => {
        prisma = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn().mockResolvedValue([{ set_current_tenant: null }]),
            $transaction: vi.fn(async (operation: (tx: any) => Promise<unknown>) => operation(prisma)),
            user: {
                findFirst: vi.fn(),
                findUnique: vi.fn(),
                findMany: vi.fn(),
                update: vi.fn(),
            },
            role: {
                count: vi.fn().mockResolvedValue(0),
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
            session: {
                updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            shift: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            schedule: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            auditLog: {
                create: vi.fn(),
            },
        };
        prisma.user.findFirst.mockResolvedValue({ id: 'actor-1', role: 'ADMIN' });
        prisma.roleAssignment.findMany.mockResolvedValue([{
            userId: 'actor-1',
            roleId: 'role-writer',
            role: {
                id: 'role-writer',
                tenantId: 'tenant-1',
                name: 'Role writer',
                description: null,
                isSystem: false,
                legacyRole: null,
                deletedAt: null,
                rolePermissions: [{ permission: { key: 'roles:write' } }],
            },
        }]);
        service = new RbacService(new TenantPrismaService(prisma));
    });

    function accessRole(
        id: string,
        legacyRole: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF' | null,
        permissionKeys: string[],
        isSystem = legacyRole !== null,
    ) {
        return {
            id,
            tenantId: 'tenant-1',
            name: id,
            description: null,
            isSystem,
            legacyRole,
            deletedAt: null,
            rolePermissions: permissionKeys.map((key) => ({ permission: { key } })),
        };
    }

    function installUserRoleReplacementScenario(input: {
        actor: { id: string; role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF'; suspendedAt?: Date | null };
        target: { id: string; role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF'; suspendedAt?: Date | null };
        assignments: Array<{ userId: string; roleId: string; role: ReturnType<typeof accessRole> }>;
        requestedRoles: Array<ReturnType<typeof accessRole>>;
    }) {
        prisma.user.findMany.mockResolvedValue([input.actor, input.target]);
        prisma.user.findFirst.mockImplementation(async ({ where }: any) =>
            [input.actor, input.target].find((user) => user.id === where.id) ?? null);
        prisma.roleAssignment.findMany
            .mockResolvedValueOnce(input.assignments.map(({ userId, roleId }) => ({ userId, roleId })))
            .mockResolvedValueOnce(input.assignments);
        prisma.role.findMany.mockImplementation(async ({ where, select }: any) => {
            const matches = input.requestedRoles.filter((role) =>
                (!where.legacyRole || role.legacyRole === where.legacyRole)
                && (!where.id?.in || where.id.in.includes(role.id)));
            return select && Object.keys(select).length === 1 && select.id
                ? matches.map((role) => ({ id: role.id }))
                : matches;
        });
        prisma.roleAssignment.deleteMany.mockResolvedValue({ count: 1 });
        prisma.roleAssignment.createMany.mockResolvedValue({ count: input.requestedRoles.length });
        prisma.session.updateMany.mockResolvedValue({ count: 2 });
    }

    function installRoleMutationRaceHarness() {
        const state = {
            deleted: false,
            assigned: false,
        };
        let transactionSequence = 0;
        let allowFirstLock: (() => void) | undefined;
        let resolveFirstLockAcquired: (() => void) | undefined;
        let resolveSecondLockQueued: (() => void) | undefined;
        let markFirstTransactionComplete: (() => void) | undefined;
        const firstLockAcquired = new Promise<void>((resolve) => {
            resolveFirstLockAcquired = resolve;
        });
        const secondLockQueued = new Promise<void>((resolve) => {
            resolveSecondLockQueued = resolve;
        });
        const firstLockGate = new Promise<void>((resolve) => {
            allowFirstLock = resolve;
        });
        const firstTransactionComplete = new Promise<void>((resolve) => {
            markFirstTransactionComplete = resolve;
        });

        prisma.$transaction.mockImplementation(async (operation: (tx: any) => Promise<unknown>) => {
            const transactionId = ++transactionSequence;
            const tx = Object.create(prisma);
            tx.$queryRaw = async (...call: any[]) => {
                const sql = Array.from(call[0] as TemplateStringsArray).join('?');
                const locksCustomRole = sql.includes('FROM "Role"') && call.slice(1).includes('role-custom');
                if (locksCustomRole && transactionId === 1) {
                    resolveFirstLockAcquired?.();
                    await firstLockGate;
                } else if (locksCustomRole && transactionId === 2) {
                    resolveSecondLockQueued?.();
                    await firstTransactionComplete;
                }
                return [{ id: 'role-custom' }];
            };
            try {
                return await operation(tx);
            } finally {
                if (transactionId === 1) markFirstTransactionComplete?.();
            }
        });
        prisma.user.findFirst.mockImplementation(async ({ where }: any) => ({
            id: where.id,
            role: where.id === 'actor-1' ? 'ADMIN' : 'STAFF',
            suspendedAt: null,
        }));
        prisma.role.findFirst.mockImplementation(async () => (
            state.deleted ? null : { id: 'role-custom', isSystem: false, name: 'Custom' }
        ));
        prisma.role.findMany.mockImplementation(async () => (
            state.deleted ? [] : [{
                id: 'role-custom',
                tenantId: 'tenant-1',
                name: 'Custom',
                description: null,
                isSystem: false,
                legacyRole: null,
                deletedAt: null,
                rolePermissions: [],
            }]
        ));
        prisma.role.update.mockImplementation(async ({ data }: any) => {
            state.deleted = Boolean(data.deletedAt);
            return { id: 'role-custom' };
        });
        prisma.roleAssignment.count.mockImplementation(async () => state.assigned ? 1 : 0);
        prisma.roleAssignment.deleteMany.mockImplementation(async () => {
            state.assigned = false;
            return { count: 1 };
        });
        prisma.roleAssignment.createMany.mockImplementation(async () => {
            state.assigned = true;
            return { count: 1 };
        });
        prisma.roleAssignment.findMany.mockImplementation(async ({ where, select }: any) => {
            if (where.userId === 'actor-1') {
                const actorAssignment = {
                    userId: 'actor-1',
                    roleId: 'role-writer',
                    role: {
                        id: 'role-writer',
                        tenantId: 'tenant-1',
                        name: 'Role writer',
                        description: null,
                        isSystem: false,
                        legacyRole: null,
                        deletedAt: null,
                        rolePermissions: [{ permission: { key: 'roles:write' } }],
                    },
                };
                return select ? [{ userId: actorAssignment.userId, roleId: actorAssignment.roleId }] : [actorAssignment];
            }
            if (!state.assigned || state.deleted) return [];
            const assignment = {
                userId: 'user-1',
                roleId: 'role-custom',
                role: {
                    id: 'role-custom',
                    tenantId: 'tenant-1',
                    name: 'Custom',
                    description: null,
                    isSystem: false,
                    legacyRole: null,
                    deletedAt: null,
                    rolePermissions: [],
                },
            };
            return select ? [{ userId: assignment.userId, roleId: assignment.roleId }] : [assignment];
        });

        return { state, firstLockAcquired, secondLockQueued, releaseFirstLock: () => allowFirstLock?.() };
    }

    function installUserAdministrationScenario(input: {
        actor: {
            id: string;
            role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
            username?: string | null;
            suspendedAt?: Date | null;
            lockedUntil?: Date | null;
            pinLockedUntil?: Date | null;
        };
        target: {
            id: string;
            role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
            username?: string | null;
            suspendedAt?: Date | null;
            lockedUntil?: Date | null;
            pinLockedUntil?: Date | null;
        };
        assignments: Array<{ userId: string; roleId: string; role: ReturnType<typeof accessRole> }>;
    }) {
        const users = [input.actor, input.target].map((user) => ({
            username: null,
            name: user.id,
            email: null,
            ...user,
        }));
        prisma.user.findMany.mockResolvedValue(users);
        prisma.roleAssignment.findMany
            .mockResolvedValueOnce(input.assignments.map(({ userId, roleId }) => ({ userId, roleId })))
            .mockResolvedValueOnce(input.assignments);
    }

    function installPlatformAdminMutationScenario(input: {
        revokedAt?: Date | null;
        permissionKeys?: string[];
    } = {}) {
        const actorRole = accessRole(
            'role-platform-admin',
            'SUPER_ADMIN',
            input.permissionKeys ?? ['admin_portal:access'],
        );
        prisma.user.findUnique.mockResolvedValue({ tenantId: 'target-tenant' });
        prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
            const sql = Array.from(query).join('?');
            if (sql.includes('FROM "User"')) {
                return [
                    {
                        id: 'actor-1', tenantId: 'tenant-1', role: 'SUPER_ADMIN',
                        suspendedAt: null, deletedAt: null,
                    },
                    {
                        id: 'target-1', tenantId: 'target-tenant', role: 'STAFF',
                        suspendedAt: null, deletedAt: null,
                    },
                ];
            }
            if (sql.includes('FROM "Session"')) {
                return [{
                    id: 'session-1',
                    userId: 'actor-1',
                    expiresAt: new Date(Date.now() + 60_000),
                    revokedAt: input.revokedAt ?? null,
                }];
            }
            if (sql.includes('FROM "RoleAssignment"')) {
                return [{ tenantId: 'tenant-1', userId: 'actor-1', roleId: actorRole.id }];
            }
            return [];
        });
        prisma.roleAssignment.findMany
            .mockResolvedValueOnce([{ userId: 'actor-1', roleId: actorRole.id }])
            .mockResolvedValueOnce([{ userId: 'actor-1', roleId: actorRole.id, role: actorRole }]);
        prisma.role.findMany.mockResolvedValue([actorRole]);
    }

    it('locks tenant, users, exact session, and current RBAC state before platform user mutation', async () => {
        installPlatformAdminMutationScenario();

        await expect(service.authorizePlatformAdminUserMutationInTransaction(
            prisma,
            'target-1',
            { userId: 'actor-1', tenantId: 'tenant-1', sessionId: 'session-1' },
            'target-tenant',
        )).resolves.toMatchObject({ id: 'target-1', tenantId: 'target-tenant' });

        const lockSql = prisma.$queryRaw.mock.calls.map((call: any[]) =>
            Array.from(call[0] as TemplateStringsArray).join('?'));
        expect(lockSql[0]).toContain('FROM "Tenant"');
        expect(lockSql[1]).toContain('FROM "User"');
        expect(lockSql[2]).toContain('FROM "Session"');
        expect(lockSql[3]).toContain('FROM "RoleAssignment"');
        expect(lockSql[4]).toContain('FROM "Role"');
        expect(lockSql[5]).toContain('FROM "RolePermission"');
        expect(lockSql[0]).toContain('FOR KEY SHARE');
        expect(lockSql.slice(1).every((sql: string) => sql.includes('FOR UPDATE'))).toBe(true);
    });

    it('rejects a revoked exact actor session before target mutation authorization', async () => {
        installPlatformAdminMutationScenario({ revokedAt: new Date() });

        await expect(service.authorizePlatformAdminUserMutationInTransaction(
            prisma,
            'target-1',
            { userId: 'actor-1', tenantId: 'tenant-1', sessionId: 'session-1' },
            'target-tenant',
        )).rejects.toThrow('Platform administrator session is no longer active');

        expect(prisma.roleAssignment.findMany).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects a demoted platform actor after locking current role permissions', async () => {
        installPlatformAdminMutationScenario({ permissionKeys: ['dashboard:access'] });

        await expect(service.authorizePlatformAdminUserMutationInTransaction(
            prisma,
            'target-1',
            { userId: 'actor-1', tenantId: 'tenant-1', sessionId: 'session-1' },
            'target-tenant',
        )).rejects.toThrow('Platform administrator authority is no longer active');

        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects a delegated custom platform admin mutating a dual-source system admin target', async () => {
        installPlatformAdminMutationScenario();
        const actorRole = accessRole(
            'role-custom-platform-admin',
            null,
            ['admin_portal:access'],
            false,
        );
        const targetRole = {
            ...accessRole('role-target-super', 'SUPER_ADMIN', ['admin_portal:access']),
            tenantId: 'target-tenant',
        };
        const baseQueryRaw = prisma.$queryRaw.getMockImplementation();
        prisma.$queryRaw.mockImplementation(async (...args: any[]) => {
            const sql = Array.from(args[0] as TemplateStringsArray).join('?');
            if (sql.includes('FROM "User"')) {
                return [
                    {
                        id: 'actor-1', tenantId: 'tenant-1', role: 'SUPER_ADMIN',
                        suspendedAt: null, deletedAt: null,
                    },
                    {
                        id: 'target-1', tenantId: 'target-tenant', role: 'SUPER_ADMIN',
                        suspendedAt: null, deletedAt: null,
                    },
                ];
            }
            if (sql.includes('FROM "RoleAssignment"')) {
                return [
                    { tenantId: 'tenant-1', userId: 'actor-1', roleId: actorRole.id },
                    { tenantId: 'target-tenant', userId: 'target-1', roleId: targetRole.id },
                ];
            }
            return baseQueryRaw!(...args);
        });
        prisma.role.findMany.mockResolvedValue([actorRole, targetRole]);

        await expect(service.authorizePlatformAdminUserMutationInTransaction(
            prisma,
            'target-1',
            { userId: 'actor-1', tenantId: 'tenant-1', sessionId: 'session-1' },
            'target-tenant',
        )).rejects.toThrow('Only system admins can administer system admins');

        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('accepts a dual-source system admin and locks the combined cross-tenant role set once', async () => {
        installPlatformAdminMutationScenario();
        const actorRole = accessRole(
            'role-a-actor-super',
            'SUPER_ADMIN',
            ['admin_portal:access', 'dashboard:access'],
        );
        const targetRole = {
            ...accessRole('role-z-target-super', 'SUPER_ADMIN', ['admin_portal:access']),
            tenantId: 'target-tenant',
        };
        const currentTargetRole = {
            ...accessRole('role-m-target-staff', 'STAFF', ['dashboard:access']),
            tenantId: 'target-tenant',
        };
        const baseQueryRaw = prisma.$queryRaw.getMockImplementation();
        prisma.$queryRaw.mockImplementation(async (...args: any[]) => {
            const sql = Array.from(args[0] as TemplateStringsArray).join('?');
            if (sql.includes('FROM "RoleAssignment"')) {
                return [
                { tenantId: 'tenant-1', userId: 'actor-1', roleId: actorRole.id },
                { tenantId: 'target-tenant', userId: 'target-1', roleId: 'role-m-target-staff' },
                ];
            }
            return baseQueryRaw!(...args);
        });
        prisma.role.findFirst.mockResolvedValue({ id: targetRole.id });
        prisma.role.findMany
            .mockResolvedValueOnce([actorRole])
            .mockResolvedValueOnce([currentTargetRole])
            .mockResolvedValueOnce([targetRole]);
        prisma.roleAssignment.deleteMany.mockResolvedValue({ count: 1 });
        prisma.roleAssignment.createMany.mockResolvedValue({ count: 1 });
        prisma.user.update.mockResolvedValue({ id: 'target-1', role: 'SUPER_ADMIN' });

        const result = await service.replaceLegacySystemRoleForPlatformAdminActorInTransaction(
            prisma,
            'target-1',
            'target-tenant',
            'SUPER_ADMIN' as any,
            { userId: 'actor-1', tenantId: 'tenant-1', sessionId: 'session-1' },
        );

        const roleLockCallIndex = prisma.$queryRaw.mock.calls.findIndex((call: any[]) => {
            const sql = Array.from(call[0] as TemplateStringsArray).join('?');
            return sql.includes('FROM "Role"') && !sql.includes('FROM "RolePermission"');
        });
        const roleLockCalls = prisma.$queryRaw.mock.calls.filter((call: any[]) => {
            const sql = Array.from(call[0] as TemplateStringsArray).join('?');
            return sql.includes('FROM "Role"') && !sql.includes('FROM "RolePermission"');
        });
        expect(roleLockCallIndex).toBeGreaterThanOrEqual(0);
        expect(roleLockCalls).toHaveLength(1);
        expect(Array.from(roleLockCalls[0][0] as TemplateStringsArray).join('?'))
            .toContain('ORDER BY "id"');
        const flattenValues = (value: any): any[] => Array.isArray(value?.values)
            ? value.values.flatMap(flattenValues)
            : [value];
        expect(roleLockCalls[0].slice(1).flatMap(flattenValues)).toEqual([
            'role-a-actor-super',
            'role-m-target-staff',
            'role-z-target-super',
        ]);
        const assignmentLockCallIndex = prisma.$queryRaw.mock.calls.findIndex((call: any[]) =>
            Array.from(call[0] as TemplateStringsArray).join('?').includes('FROM "RoleAssignment"'));
        expect(prisma.$queryRaw.mock.invocationCallOrder[assignmentLockCallIndex])
            .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[roleLockCallIndex]);
        expect(prisma.$queryRaw.mock.invocationCallOrder[roleLockCallIndex])
            .toBeLessThan(prisma.roleAssignment.deleteMany.mock.invocationCallOrder[0]);
        expect(result).toMatchObject({
            changed: true,
            legacyRole: 'SUPER_ADMIN',
            previousRoleIds: ['role-m-target-staff'],
            roleId: 'role-z-target-super',
        });
    });

    it('rejects SUPER_ADMIN promotion when a legacy SUPER_ADMIN only holds a custom admin role', async () => {
        installPlatformAdminMutationScenario();
        const customActorRole = accessRole(
            'role-a-custom-platform-admin',
            null,
            ['admin_portal:access', 'dashboard:access'],
            false,
        );
        const targetRole = {
            ...accessRole('role-z-target-super', 'SUPER_ADMIN', ['admin_portal:access']),
            tenantId: 'target-tenant',
        };
        const baseQueryRaw = prisma.$queryRaw.getMockImplementation();
        prisma.$queryRaw.mockImplementation(async (...args: any[]) => {
            const sql = Array.from(args[0] as TemplateStringsArray).join('?');
            if (sql.includes('FROM "RoleAssignment"')) {
                return [
                    { tenantId: 'tenant-1', userId: 'actor-1', roleId: customActorRole.id },
                    { tenantId: 'target-tenant', userId: 'target-1', roleId: 'role-m-target-staff' },
                ];
            }
            return baseQueryRaw!(...args);
        });
        prisma.role.findFirst.mockResolvedValue({ id: targetRole.id });
        prisma.role.findMany.mockResolvedValueOnce([customActorRole]);

        await expect(service.replaceLegacySystemRoleForPlatformAdminActorInTransaction(
            prisma,
            'target-1',
            'target-tenant',
            'SUPER_ADMIN' as any,
            { userId: 'actor-1', tenantId: 'tenant-1', sessionId: 'session-1' },
        )).rejects.toThrow('Only system admins can grant system admin access');

        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.createMany).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('locks and re-reads live actor and target access before authorizing user administration', async () => {
        const actorRole = accessRole('role-admin', 'ADMIN', [
            'users:admin',
            'auth:login_pin',
            'dashboard:access',
        ]);
        const targetRole = accessRole('role-staff', 'STAFF', [
            'auth:login_pin',
            'dashboard:access',
        ]);
        installUserAdministrationScenario({
            actor: { id: 'actor-z', role: 'ADMIN' },
            target: { id: 'target-a', role: 'STAFF', username: 'crewlead' },
            assignments: [
                { userId: 'actor-z', roleId: actorRole.id, role: actorRole },
                { userId: 'target-a', roleId: targetRole.id, role: targetRole },
            ],
        });

        const result = await service.authorizeUserAdministrationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'actor-z',
                actorSessionId: 'session-1',
                targetUserId: 'target-a',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'Use self service',
            },
        );

        expect(result).toMatchObject({ id: 'target-a', role: 'STAFF', username: 'crewlead' });
        expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: { in: ['actor-z', 'target-a'] } }),
        }));
        expect(prisma.roleAssignment.findMany).toHaveBeenCalledTimes(2);
        const lockSql = prisma.$queryRaw.mock.calls
            .map(([query]: [TemplateStringsArray]) => Array.from(query).join('?'));
        expect(lockSql[0]).toContain('ORDER BY "id"');
        expect(lockSql.some((sql: string) => sql.includes('FROM "Session"'))).toBe(true);
        expect(lockSql.some((sql: string) => sql.includes('ORDER BY "userId", "roleId"'))).toBe(true);
        expect(lockSql.at(-1)).toContain('FROM "RolePermission"');
    });

    it('denies user administration after the locked actor permissions are revoked', async () => {
        const actorRole = accessRole('role-manager', 'MANAGER', ['dashboard:access']);
        const targetRole = accessRole('role-staff', 'STAFF', []);
        installUserAdministrationScenario({
            actor: { id: 'actor-1', role: 'ADMIN' },
            target: { id: 'target-1', role: 'STAFF' },
            assignments: [
                { userId: 'actor-1', roleId: actorRole.id, role: actorRole },
                { userId: 'target-1', roleId: targetRole.id, role: targetRole },
            ],
        });

        await expect(service.authorizeUserAdministrationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'actor-1',
                actorSessionId: 'session-1',
                targetUserId: 'target-1',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'Use self service',
            },
        )).rejects.toThrow('users:admin permission is no longer active');
    });

    it('rejects a suspended actor after locking live state while allowing suspended targets to be recovered', async () => {
        const actorRole = accessRole('role-admin', 'ADMIN', ['users:admin', 'dashboard:access']);
        const targetRole = accessRole('role-staff', 'STAFF', ['dashboard:access']);
        installUserAdministrationScenario({
            actor: { id: 'actor-1', role: 'ADMIN', suspendedAt: new Date() },
            target: { id: 'target-1', role: 'STAFF', suspendedAt: null },
            assignments: [
                { userId: 'actor-1', roleId: actorRole.id, role: actorRole },
                { userId: 'target-1', roleId: targetRole.id, role: targetRole },
            ],
        });

        await expect(service.authorizeUserAdministrationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'actor-1',
                actorSessionId: 'session-1',
                targetUserId: 'target-1',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'Use self service',
            },
        )).rejects.toThrow('Administrator account is suspended');

        installUserAdministrationScenario({
            actor: { id: 'actor-1', role: 'ADMIN', suspendedAt: null },
            target: { id: 'target-1', role: 'STAFF', suspendedAt: new Date() },
            assignments: [
                { userId: 'actor-1', roleId: actorRole.id, role: actorRole },
                { userId: 'target-1', roleId: targetRole.id, role: targetRole },
            ],
        });
        await expect(service.authorizeUserAdministrationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'actor-1',
                actorSessionId: 'session-1',
                targetUserId: 'target-1',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'Use self service',
            },
        )).resolves.toMatchObject({ id: 'target-1', suspendedAt: expect.any(Date) });
    });

    it.each(['lockedUntil', 'pinLockedUntil'] as const)(
        'denies user administration while the actor has a future %s',
        async (field) => {
            const actorRole = accessRole('role-admin', 'ADMIN', ['users:admin']);
            installUserAdministrationScenario({
                actor: {
                    id: 'actor-1',
                    role: 'ADMIN',
                    [field]: new Date(Date.now() + 60_000),
                },
                target: { id: 'target-1', role: 'STAFF' },
                assignments: [{ userId: 'actor-1', roleId: actorRole.id, role: actorRole }],
            });

            await expect(service.authorizeUserAdministrationInTransaction(
                prisma,
                'tenant-1',
                {
                    actorUserId: 'actor-1',
                    actorSessionId: 'session-1',
                    targetUserId: 'target-1',
                    requiredPermission: 'users:admin',
                    selfMutationMessage: 'Use self service',
                },
            )).rejects.toThrow('Administrator account is locked');
            expect(prisma.roleAssignment.findMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );

    it('binds self-service security mutation authority to the exact session and current login permission', async () => {
        const pinRole = accessRole('role-pin', 'STAFF', ['auth:login_pin']);
        prisma.user.findFirst.mockResolvedValue({
            id: 'actor-1',
            role: 'STAFF',
            lockedUntil: null,
            pinLockedUntil: null,
        });
        prisma.roleAssignment.findMany.mockResolvedValue([
            { userId: 'actor-1', roleId: pinRole.id },
        ]);
        prisma.role.findMany.mockResolvedValue([pinRole]);

        await expect(service.authorizeSelfSecurityMutationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'actor-1',
                actorSessionId: 'session-1',
                requiredPermission: 'auth:login_pin',
            },
        )).resolves.toMatchObject({
            primaryRole: 'role-pin',
            permissions: ['auth:login_pin'],
        });

        const lockSql = prisma.$queryRaw.mock.calls
            .map(([query]: [TemplateStringsArray]) => Array.from(query).join('?'));
        expect(lockSql[0]).toContain('FROM "Tenant"');
        expect(lockSql[1]).toContain('FROM "User"');
        expect(lockSql[2]).toContain('FROM "Session"');
        expect(lockSql[3]).toContain('FROM "RoleAssignment"');
        expect(lockSql[4]).toContain('FROM "Role"');
        expect(lockSql[5]).toContain('FROM "RolePermission"');
    });

    it('denies user administration after the locked target is promoted to equal access', async () => {
        const adminRole = accessRole('role-admin', 'ADMIN', ['users:admin', 'dashboard:access']);
        installUserAdministrationScenario({
            actor: { id: 'actor-1', role: 'ADMIN' },
            target: { id: 'target-1', role: 'ADMIN' },
            assignments: [
                { userId: 'actor-1', roleId: adminRole.id, role: adminRole },
                { userId: 'target-1', roleId: adminRole.id, role: adminRole },
            ],
        });

        await expect(service.authorizeUserAdministrationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'actor-1',
                actorSessionId: 'session-1',
                targetUserId: 'target-1',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'Use self service',
            },
        )).rejects.toThrow('equal or greater access');
    });

    it('requires dual-source system-admin authority for the equal-rank override', async () => {
        const adminRole = accessRole('role-admin', 'ADMIN', ['users:admin']);
        const superRole = accessRole('role-super', 'SUPER_ADMIN', ['users:admin']);
        installUserAdministrationScenario({
            actor: { id: 'stale-super', role: 'SUPER_ADMIN' },
            target: { id: 'target-admin', role: 'ADMIN' },
            assignments: [
                { userId: 'stale-super', roleId: adminRole.id, role: adminRole },
                { userId: 'target-admin', roleId: adminRole.id, role: adminRole },
            ],
        });
        await expect(service.authorizeUserAdministrationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'stale-super',
                actorSessionId: 'session-1',
                targetUserId: 'target-admin',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'Use self service',
            },
        )).rejects.toThrow('equal or greater access');

        prisma.$queryRaw.mockClear();
        prisma.roleAssignment.findMany.mockReset();
        installUserAdministrationScenario({
            actor: { id: 'live-super', role: 'SUPER_ADMIN' },
            target: { id: 'target-super', role: 'SUPER_ADMIN' },
            assignments: [
                { userId: 'live-super', roleId: superRole.id, role: superRole },
                { userId: 'target-super', roleId: superRole.id, role: superRole },
            ],
        });
        await expect(service.authorizeUserAdministrationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'live-super',
                actorSessionId: 'session-1',
                targetUserId: 'target-super',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'Use self service',
            },
        )).resolves.toMatchObject({ id: 'target-super' });
    });

    it('rejects updates to system roles before changing role permissions', async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 'role-system', isSystem: true });

        await expect(
            service.updateRole('tenant-1', 'role-system', {
                name: 'Edited System Role',
                permissionKeys: ['schedules:write'],
            }, { actorUserId: 'actor-1', actorSessionId: 'session-1' }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.permission.findMany).not.toHaveBeenCalled();
        expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled();
        expect(prisma.role.update).not.toHaveBeenCalled();
    });

    it.each(['Payroll\rLead', 'Payroll\nLead', 'Payroll\u0000Lead']) (
        'rejects control-bearing role name %j on create and update',
        async (name) => {
            const ensureTenantRoles = vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);

            await expect(service.createRole('tenant-1', {
                name,
                permissionKeys: [],
            }, { actorUserId: 'actor-1', actorSessionId: 'session-1' })).rejects.toThrow('must not contain control characters');
            await expect(service.updateRole('tenant-1', 'role-custom', {
                name,
                permissionKeys: [],
            }, { actorUserId: 'actor-1', actorSessionId: 'session-1' })).rejects.toThrow('must not contain control characters');

            expect(ensureTenantRoles).not.toHaveBeenCalled();
            expect(prisma.role.create).not.toHaveBeenCalled();
            expect(prisma.role.update).not.toHaveBeenCalled();
        },
    );

    it('sanitizes legacy control-bearing names on effective-access reads without changing role ids', async () => {
        prisma.roleAssignment.findMany.mockResolvedValue([{
            role: {
                ...accessRole('role-payroll', null, ['dashboard:access'], false),
                name: 'Payroll\r\nLead',
            },
        }]);

        await expect(service.getEffectiveAccess('user-1', 'tenant-1')).resolves.toEqual({
            primaryRole: 'Payroll Lead',
            roles: [{
                id: 'role-payroll',
                name: 'Payroll Lead',
                isSystem: false,
                legacyRole: null,
            }],
            permissions: ['dashboard:access'],
        });
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
        }, { actorUserId: 'actor-1', actorSessionId: 'session-1' })).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.permission.findMany).not.toHaveBeenCalled();
        expect(prisma.role.create).not.toHaveBeenCalled();
    });

    it('allows a system-admin caller to grant a canonicalized protected permission', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.user.findFirst.mockResolvedValue({ id: 'system-admin-1', role: 'SUPER_ADMIN' });
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
        }, { actorUserId: 'system-admin-1', actorSessionId: 'session-1' });

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

    it('rejects legacy SUPER_ADMIN authority without an active system SUPER_ADMIN assignment', async () => {
        const actorRole = accessRole('role-admin', 'ADMIN', ['roles:assign', 'dashboard:access']);
        const targetRole = accessRole('role-staff', 'STAFF', ['dashboard:access']);
        const requestedRole = accessRole('role-super', 'SUPER_ADMIN', [
            'roles:assign',
            'dashboard:access',
            'admin_portal:access',
        ]);
        installUserRoleReplacementScenario({
            actor: { id: 'stale-super', role: 'SUPER_ADMIN' },
            target: { id: 'lower-user', role: 'STAFF' },
            assignments: [
                { userId: 'stale-super', roleId: actorRole.id, role: actorRole },
                { userId: 'lower-user', roleId: targetRole.id, role: targetRole },
            ],
            requestedRoles: [requestedRole],
        });

        await expect(service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'stale-super',
            actorSessionId: 'session-1',
            targetUserId: 'lower-user',
            roleIds: [requestedRole.id],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        })).rejects.toThrow('Only system admins can grant system admin access');

        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects a suspended actor inside actor-authorized role replacement without mutating the target', async () => {
        const actorRole = accessRole('role-admin', 'ADMIN', ['roles:assign', 'dashboard:access']);
        const targetRole = accessRole('role-staff', 'STAFF', ['dashboard:access']);
        installUserRoleReplacementScenario({
            actor: { id: 'actor-1', role: 'ADMIN', suspendedAt: new Date() },
            target: { id: 'target-1', role: 'STAFF', suspendedAt: null },
            assignments: [
                { userId: 'actor-1', roleId: actorRole.id, role: actorRole },
                { userId: 'target-1', roleId: targetRole.id, role: targetRole },
            ],
            requestedRoles: [targetRole],
        });

        await expect(service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'actor-1',
            actorSessionId: 'session-1',
            targetUserId: 'target-1',
            roleIds: [targetRole.id],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        })).rejects.toThrow('Administrator account is suspended');

        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it.each([
        { code: 'P2034' },
        { code: 'P2010', meta: { code: '40001' } },
        { code: 'P2010', meta: { code: '40P01' } },
    ])('maps actor-authorized Serializable conflict $code to a controlled response', async (error) => {
        prisma.$transaction.mockRejectedValue(error);

        await expect(service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'actor-1',
            actorSessionId: 'session-1',
            targetUserId: 'target-1',
            roleIds: [],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        })).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('retries one actor-authorized Serializable conflict as a fresh role transaction', async () => {
        const actorRole = accessRole('role-super', 'SUPER_ADMIN', ['roles:assign', 'dashboard:access']);
        const targetRole = accessRole('role-staff', 'STAFF', ['dashboard:access']);
        const requestedRole = accessRole('role-manager', 'MANAGER', ['dashboard:access']);
        installUserRoleReplacementScenario({
            actor: { id: 'actor-1', role: 'SUPER_ADMIN' },
            target: { id: 'target-1', role: 'STAFF' },
            assignments: [
                { userId: 'actor-1', roleId: actorRole.id, role: actorRole },
                { userId: 'target-1', roleId: targetRole.id, role: targetRole },
            ],
            requestedRoles: [requestedRole],
        });
        prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });

        await expect(service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'actor-1',
            actorSessionId: 'session-1',
            targetUserId: 'target-1',
            roleIds: [requestedRole.id],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        })).resolves.toMatchObject({ legacyRole: 'MANAGER', changed: true });

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('does not mask an unrelated actor-authorized mutation error', async () => {
        const error = { code: 'P2002' };
        prisma.$transaction.mockRejectedValueOnce(error);

        await expect(service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'actor-1',
            actorSessionId: 'session-1',
            targetUserId: 'target-1',
            roleIds: [],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        })).rejects.toBe(error);
    });

    it('rejects tenant role replacement when the exact request session is revoked', async () => {
        const actorRole = accessRole('role-admin', 'ADMIN', ['roles:assign', 'dashboard:access']);
        const targetRole = accessRole('role-staff', 'STAFF', ['dashboard:access']);
        installUserRoleReplacementScenario({
            actor: { id: 'actor-1', role: 'ADMIN' },
            target: { id: 'target-1', role: 'STAFF' },
            assignments: [
                { userId: 'actor-1', roleId: actorRole.id, role: actorRole },
                { userId: 'target-1', roleId: targetRole.id, role: targetRole },
            ],
            requestedRoles: [targetRole],
        });
        prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
            const sql = Array.from((query as any).strings ?? query).join('?');
            if (sql.includes('FROM "Session"')) {
                return [{
                    id: 'session-revoked', userId: 'actor-1',
                    expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date(),
                }];
            }
            return [];
        });

        await expect(service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'actor-1',
            actorSessionId: 'session-revoked',
            targetUserId: 'target-1',
            roleIds: [targetRole.id],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        })).rejects.toThrow('Administrator session is no longer active');

        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('serializes demotion, repairs stale legacy state, audits, and revokes every active session', async () => {
        const actorRole = accessRole('role-super', 'SUPER_ADMIN', [
            'roles:assign',
            'dashboard:access',
            'admin_portal:access',
        ]);
        const targetRole = accessRole('role-admin', 'ADMIN', ['dashboard:access']);
        const requestedRole = accessRole('role-staff', 'STAFF', ['dashboard:access']);
        installUserRoleReplacementScenario({
            actor: { id: 'system-admin', role: 'SUPER_ADMIN' },
            target: { id: 'demoted-user', role: 'SUPER_ADMIN' },
            assignments: [
                { userId: 'system-admin', roleId: actorRole.id, role: actorRole },
                { userId: 'demoted-user', roleId: targetRole.id, role: targetRole },
            ],
            requestedRoles: [requestedRole],
        });

        const result = await service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'system-admin',
            actorSessionId: 'session-1',
            targetUserId: 'demoted-user',
            roleIds: [requestedRole.id],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        });

        expect(result).toMatchObject({ legacyRole: 'STAFF', changed: true, sessionsRevoked: 2 });
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'demoted-user' },
            data: { role: 'STAFF' },
        });
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'demoted-user', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                userId: 'system-admin',
                actorUserId: 'system-admin',
                actorTenantId: 'tenant-1',
                action: 'USER_ACCESS_UPDATED',
                resource: 'User',
                resourceId: 'demoted-user',
                oldValue: { role: 'SUPER_ADMIN', roleIds: ['role-admin'] },
                newValue: { role: 'STAFF', roleIds: ['role-staff'] },
            }),
        });
        expect(prisma.$transaction).toHaveBeenLastCalledWith(
            expect.any(Function),
            { isolationLevel: 'Serializable' },
        );
        const lockOrders = prisma.$queryRaw.mock.invocationCallOrder;
        expect(lockOrders[0]).toBeLessThan(lockOrders[1]);
        expect(lockOrders[1]).toBeLessThan(prisma.user.findMany.mock.invocationCallOrder[0]);
        expect(prisma.user.findMany.mock.invocationCallOrder[0]).toBeLessThan(lockOrders[2]);
        expect(lockOrders[2]).toBeLessThan(prisma.roleAssignment.findMany.mock.invocationCallOrder[0]);
    });

    it('unassigns editable draft shifts when role replacement makes a user unschedulable', async () => {
        const actorRole = accessRole('role-super', 'SUPER_ADMIN', [
            'roles:assign',
            'dashboard:access',
            'admin_portal:access',
        ]);
        const targetRole = accessRole('role-staff', 'STAFF', ['dashboard:access']);
        const requestedRole = accessRole('role-admin', 'ADMIN', ['dashboard:access']);
        installUserRoleReplacementScenario({
            actor: { id: 'system-admin', role: 'SUPER_ADMIN' },
            target: { id: 'target-1', role: 'STAFF' },
            assignments: [
                { userId: 'system-admin', roleId: actorRole.id, role: actorRole },
                { userId: 'target-1', roleId: targetRole.id, role: targetRole },
            ],
            requestedRoles: [requestedRole],
        });
        prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
            const sql = Array.from((query as any).strings ?? query).join('?');
            if (sql.includes('FROM "Schedule" schedule_row')) return [];
            if (sql.includes('FROM "Shift" shift_row')) {
                return [{
                    id: 'shift-1',
                    scheduleId: 'schedule-1',
                    scheduleTenantId: 'tenant-1',
                    scheduleStatus: 'DRAFT',
                    scheduleDeletedAt: null,
                }];
            }
            if (sql.includes('FROM "Session"')) {
                return [{
                    id: 'session-1',
                    userId: 'system-admin',
                    expiresAt: new Date(Date.now() + 60_000),
                    revokedAt: null,
                }];
            }
            return [{ set_current_tenant: null }];
        });

        await expect(service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'system-admin',
            actorSessionId: 'session-1',
            targetUserId: 'target-1',
            roleIds: [requestedRole.id],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        })).resolves.toMatchObject({ legacyRole: 'ADMIN', changed: true });

        expect(prisma.shift.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['shift-1'] },
                tenantId: 'tenant-1',
                userId: 'target-1',
                deletedAt: null,
            },
            data: { userId: null },
        });
        expect(prisma.schedule.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['schedule-1'] },
                tenantId: 'tenant-1',
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
    });

    it('requires dual-source tenant authority to administer a dual-source system admin target', async () => {
        const delegatedRole = accessRole('role-delegated-admin', null, ['users:admin'], false);
        const superRole = accessRole('role-super', 'SUPER_ADMIN', ['users:admin']);
        installUserAdministrationScenario({
            actor: { id: 'delegated-admin', role: 'SUPER_ADMIN' },
            target: { id: 'target-super', role: 'SUPER_ADMIN' },
            assignments: [
                { userId: 'delegated-admin', roleId: delegatedRole.id, role: delegatedRole },
                { userId: 'target-super', roleId: superRole.id, role: superRole },
            ],
        });

        await expect(service.authorizeUserAdministrationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'delegated-admin',
                actorSessionId: 'session-1',
                targetUserId: 'target-super',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'Use self service',
            },
        )).rejects.toThrow('Only system admins can administer system admins');

        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('locks and rejects a revoked exact session before invitation delegation or writes', async () => {
        prisma.user.findMany.mockResolvedValue([{
            id: 'actor-1', role: 'ADMIN', suspendedAt: null, deletedAt: null,
        }]);
        prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
            const sql = Array.from(query).join('?');
            if (sql.includes('FROM "Session"')) {
                return [{
                    id: 'session-1', userId: 'actor-1',
                    expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date(),
                }];
            }
            return [];
        });

        await expect(service.authorizeUserInvitationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'actor-1',
                actorSessionId: 'session-1',
                requestedLegacyRole: 'STAFF' as any,
            },
        )).rejects.toThrow('Administrator session is no longer active');

        expect(prisma.roleAssignment.findMany).not.toHaveBeenCalled();
        expect(prisma.role.findFirst).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects delegated reactivation of an archived dual-source system admin', async () => {
        const delegatedRole = accessRole('role-delegated-admin', null, ['users:write'], false);
        const targetRole = accessRole('role-target-super', 'SUPER_ADMIN', ['admin_portal:access']);
        const invitedRole = accessRole('role-staff', 'STAFF', ['auth:login_email']);
        prisma.user.findMany.mockResolvedValue([
            { id: 'actor-1', role: 'SUPER_ADMIN', suspendedAt: null, deletedAt: null },
            { id: 'target-1', role: 'SUPER_ADMIN', suspendedAt: null, deletedAt: new Date() },
        ]);
        prisma.roleAssignment.findMany.mockResolvedValue([
            { userId: 'actor-1', roleId: delegatedRole.id },
            { userId: 'target-1', roleId: targetRole.id },
        ]);
        prisma.role.findFirst.mockResolvedValue({ id: invitedRole.id });
        prisma.role.findMany.mockResolvedValue([delegatedRole, invitedRole, targetRole]);

        await expect(service.authorizeUserInvitationInTransaction(
            prisma,
            'tenant-1',
            {
                actorUserId: 'actor-1',
                actorSessionId: 'session-1',
                targetUserId: 'target-1',
                requestedRoleId: invitedRole.id,
            },
        )).rejects.toThrow('Only system admins can administer system admins');

        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects equal-rank system-admin target mutation', async () => {
        const actorRole = accessRole('role-super', 'SUPER_ADMIN', ['roles:assign', 'dashboard:access']);
        const requestedRole = accessRole('role-staff', 'STAFF', ['dashboard:access']);
        installUserRoleReplacementScenario({
            actor: { id: 'system-admin-a', role: 'SUPER_ADMIN' },
            target: { id: 'system-admin-b', role: 'SUPER_ADMIN' },
            assignments: [
                { userId: 'system-admin-a', roleId: actorRole.id, role: actorRole },
                { userId: 'system-admin-b', roleId: actorRole.id, role: actorRole },
            ],
            requestedRoles: [requestedRole],
        });

        await expect(service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'system-admin-a',
            actorSessionId: 'session-1',
            targetUserId: 'system-admin-b',
            roleIds: [requestedRole.id],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        })).rejects.toThrow('Cannot administer an account with equal or greater access');

        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant role ids inside the locked mutation transaction', async () => {
        const actorRole = accessRole('role-super', 'SUPER_ADMIN', ['roles:assign', 'dashboard:access']);
        const targetRole = accessRole('role-staff', 'STAFF', ['dashboard:access']);
        installUserRoleReplacementScenario({
            actor: { id: 'system-admin', role: 'SUPER_ADMIN' },
            target: { id: 'lower-user', role: 'STAFF' },
            assignments: [
                { userId: 'system-admin', roleId: actorRole.id, role: actorRole },
                { userId: 'lower-user', roleId: targetRole.id, role: targetRole },
            ],
            requestedRoles: [],
        });

        await expect(service.replaceUserRolesAsActor('tenant-1', {
            actorUserId: 'system-admin',
            actorSessionId: 'session-1',
            targetUserId: 'lower-user',
            roleIds: ['foreign-role'],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'No self mutation',
            auditAction: 'USER_ACCESS_UPDATED',
        })).rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('reconciles the legacy user role to the highest assigned active system role', async () => {
        const customRole = accessRole('role-custom', null, ['dashboard:access'], false);
        const managerRole = accessRole('role-manager', 'MANAGER', ['dashboard:access']);
        const adminRole = accessRole('role-admin', 'ADMIN', ['dashboard:access']);
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1', role: 'SUPER_ADMIN' });
        prisma.role.findMany.mockResolvedValue([customRole, managerRole, adminRole]);

        const result = await service.assignRolesToUserInTransaction(
            prisma,
            'user-1',
            'tenant-1',
            [customRole.id, managerRole.id, adminRole.id],
        );

        expect(result.legacyRole).toBe('ADMIN');
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { role: 'ADMIN' },
        });
    });

    it.each([
        { label: 'custom-only', roles: [accessRole('role-custom', null, ['dashboard:access'], false)] },
        { label: 'empty', roles: [] },
    ])('falls back legacy user state to STAFF for $label assignments', async ({ roles }) => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1', role: 'SUPER_ADMIN' });
        prisma.role.findMany.mockResolvedValue(roles);

        const result = await service.assignRolesToUserInTransaction(
            prisma,
            'user-1',
            'tenant-1',
            roles.map((role) => role.id),
        );

        expect(result.legacyRole).toBe('STAFF');
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { role: 'STAFF' },
        });
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
        }, { actorUserId: 'actor-1', actorSessionId: 'session-1' })).rejects.toThrow('permissions you do not currently hold');

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
        }, { actorUserId: 'actor-1', actorSessionId: 'session-1' })).rejects.toThrow('permissions you do not currently hold');

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
        }, { actorUserId: 'actor-1', actorSessionId: 'session-1' });

        expect(prisma.role.create).toHaveBeenCalled();
        expect(prisma.$transaction).toHaveBeenLastCalledWith(
            expect.any(Function),
            { isolationLevel: 'Serializable' },
        );
    });

    it('rejects custom-role mutation when the exact request session is revoked', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
            const sql = Array.from(query).join('?');
            if (sql.includes('FROM "Session"')) {
                return [{
                    id: 'session-revoked', userId: 'actor-1',
                    expiresAt: new Date(Date.now() + 60_000), revokedAt: new Date(),
                }];
            }
            return [];
        });

        await expect(service.createRole('tenant-1', {
            name: 'Denied role',
            permissionKeys: ['users:read'],
        }, {
            actorUserId: 'actor-1',
            actorSessionId: 'session-revoked',
        })).rejects.toThrow('Administrator session is no longer active');

        expect(prisma.roleAssignment.findMany).not.toHaveBeenCalled();
        expect(prisma.role.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('creates exactly one attributed custom-role audit with canonical permissions', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.roleAssignment.findMany.mockResolvedValue([{
            userId: 'actor-1',
            roleId: 'role-writer',
            role: {
                ...accessRole('role-writer', null, [
                    'roles:write',
                    'users:read',
                    'dashboard:access',
                ], false),
            },
        }]);
        prisma.permission.findMany.mockResolvedValue([
            { id: 'permission-dashboard', key: 'dashboard:access' },
            { id: 'permission-users-read', key: 'users:read' },
        ]);
        prisma.role.create.mockResolvedValue({
            id: 'role-reader',
            name: 'Reader',
            description: 'Can read users',
            isSystem: false,
            rolePermissions: [],
        });

        await service.createRole('tenant-1', {
            name: 'Reader',
            description: 'Can read users',
            permissionKeys: [' users:read ', 'DASHBOARD:ACCESS'],
        }, {
            actorUserId: 'actor-1',
            actorSessionId: 'session-1',
            ipAddress: '203.0.113.40',
            userAgent: 'rbac-spec',
        });

        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'actor-1',
                actorUserId: 'actor-1',
                actorTenantId: 'tenant-1',
                ipAddress: '203.0.113.40',
                userAgent: 'rbac-spec',
                action: 'ACCESS_ROLE_CREATED',
                resource: 'Role',
                resourceId: 'role-reader',
                oldValue: { name: null, description: null, permissions: [] },
                newValue: {
                    name: 'Reader',
                    description: 'Can read users',
                    permissions: ['dashboard:access', 'users:read'],
                },
            },
        });
    });

    it('fails custom-role creation when its same-transaction audit fails', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.roleAssignment.findMany.mockResolvedValue([{
            userId: 'actor-1',
            roleId: 'role-writer',
            role: accessRole('role-writer', null, ['roles:write', 'users:read'], false),
        }]);
        prisma.permission.findMany.mockResolvedValue([{ id: 'permission-users-read', key: 'users:read' }]);
        prisma.role.create.mockResolvedValue({ id: 'role-reader', rolePermissions: [] });
        prisma.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

        await expect(service.createRole('tenant-1', {
            name: 'Reader',
            permissionKeys: ['users:read'],
        }, {
            actorUserId: 'actor-1',
            actorSessionId: 'session-1',
        })).rejects.toThrow('audit unavailable');

        expect(prisma.role.create).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('does not duplicate a custom-role audit after one serializable retry', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.roleAssignment.findMany.mockResolvedValue([{
            userId: 'actor-1',
            roleId: 'role-writer',
            role: accessRole('role-writer', null, ['roles:write', 'users:read'], false),
        }]);
        prisma.permission.findMany.mockResolvedValue([{ id: 'permission-users-read', key: 'users:read' }]);
        prisma.role.create.mockResolvedValue({ id: 'role-reader', rolePermissions: [] });
        prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });

        await expect(service.createRole('tenant-1', {
            name: 'Reader',
            permissionKeys: ['users:read'],
        }, {
            actorUserId: 'actor-1',
            actorSessionId: 'session-1',
        })).resolves.toMatchObject({ id: 'role-reader' });

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.role.create).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('updates exactly one attributed custom-role audit with canonical before and after permissions', async () => {
        prisma.roleAssignment.findMany.mockResolvedValue([{
            userId: 'actor-1',
            roleId: 'role-writer',
            role: accessRole('role-writer', null, [
                'roles:write',
                'users:read',
                'dashboard:access',
            ], false),
        }]);
        prisma.permission.findMany.mockResolvedValue([{ id: 'permission-users-read', key: 'users:read' }]);
        prisma.role.findFirst.mockResolvedValue({
            id: 'role-reader',
            isSystem: false,
            name: 'Old reader',
            description: 'Old description',
            rolePermissions: [
                { permission: { key: 'USERS:READ' } },
                { permission: { key: ' dashboard:access ' } },
            ],
        });
        prisma.role.update.mockResolvedValue({
            id: 'role-reader',
            name: 'Reader',
            description: null,
            isSystem: false,
            rolePermissions: [],
            _count: { assignments: 0 },
        });

        await service.updateRole('tenant-1', 'role-reader', {
            name: 'Reader',
            permissionKeys: [' USERS:READ '],
        }, {
            actorUserId: 'actor-1',
            actorSessionId: 'session-1',
            ipAddress: '203.0.113.41',
            userAgent: 'rbac-spec-update',
        });

        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                userId: 'actor-1',
                actorUserId: 'actor-1',
                actorTenantId: 'tenant-1',
                ipAddress: '203.0.113.41',
                userAgent: 'rbac-spec-update',
                action: 'ACCESS_ROLE_UPDATED',
                resource: 'Role',
                resourceId: 'role-reader',
                oldValue: {
                    name: 'Old reader',
                    description: 'Old description',
                    permissions: ['dashboard:access', 'users:read'],
                },
                newValue: {
                    name: 'Reader',
                    description: null,
                    permissions: ['users:read'],
                },
            }),
        });
    });

    it('rejects custom role creation at the tenant cap after live actor authorization', async () => {
        vi.spyOn(service, 'ensureTenantRoles').mockResolvedValue(undefined);
        prisma.roleAssignment.findMany.mockResolvedValue([{
            userId: 'actor-1',
            roleId: 'role-writer',
            role: {
                id: 'role-writer',
                tenantId: 'tenant-1',
                name: 'Role writer',
                description: null,
                isSystem: false,
                legacyRole: null,
                deletedAt: null,
                rolePermissions: [
                    { permission: { key: 'roles:write' } },
                    { permission: { key: 'users:read' } },
                ],
            },
        }]);
        prisma.permission.findMany.mockResolvedValue([{ id: 'permission-users-read', key: 'users:read' }]);
        prisma.role.count.mockResolvedValue(MAX_CUSTOM_ROLES_PER_TENANT);

        await expect(service.createRole('tenant-1', {
            name: 'One role too many',
            permissionKeys: ['users:read'],
        }, { actorUserId: 'actor-1', actorSessionId: 'session-1' })).rejects.toThrow(
            'at most ' + MAX_CUSTOM_ROLES_PER_TENANT + ' custom roles',
        );

        expect(prisma.role.count).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', isSystem: false, deletedAt: null },
        });
        expect(prisma.permission.findMany).toHaveBeenCalledWith({
            where: { key: { in: ['users:read'] } },
            select: { id: true, key: true },
        });
        expect(prisma.role.create).not.toHaveBeenCalled();
    });

    it('rejects deletes for system roles before soft-deleting or removing assignments', async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 'role-system', isSystem: true });

        await expect(service.deleteRole(
            'tenant-1',
            'role-system',
            { actorUserId: 'actor-1', actorSessionId: 'session-1' },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.role.update).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects custom role deletion while assignments exist without changing the role or assignments', async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 'role-custom', isSystem: false });
        prisma.roleAssignment.count.mockResolvedValue(2);

        await expect(service.deleteRole('tenant-1', 'role-custom', {
            actorUserId: 'actor-1', actorSessionId: 'session-1',
        }))
            .rejects.toThrow('Role cannot be deleted while 2 assignments exist');

        expect(prisma.roleAssignment.count).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', roleId: 'role-custom' },
        });
        expect(prisma.role.update).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
    });

    it('soft-deletes an unassigned custom role without deleting assignment rows', async () => {
        prisma.role.findFirst.mockResolvedValue({ id: 'role-custom', isSystem: false, name: 'Dispatch' });
        prisma.roleAssignment.count.mockResolvedValue(0);
        prisma.role.update.mockResolvedValue({ id: 'role-custom' });

        await expect(service.deleteRole(
            'tenant-1',
            'role-custom',
            { actorUserId: 'actor-1', actorSessionId: 'session-1' },
        )).resolves.toBe(true);

        expect(prisma.role.update).toHaveBeenCalledWith({
            where: { id: 'role-custom' },
            data: { deletedAt: expect.any(Date) },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'actor-1',
                actorUserId: 'actor-1',
                actorTenantId: 'tenant-1',
                ipAddress: null,
                userAgent: null,
                action: 'ACCESS_ROLE_DELETED',
                resource: 'Role',
                resourceId: 'role-custom',
                oldValue: { name: 'Dispatch' },
                newValue: { deleted: true },
            },
        });
        expect(prisma.$transaction).toHaveBeenLastCalledWith(
            expect.any(Function),
            { isolationLevel: 'Serializable' },
        );
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
            },
        });
        expect(prisma.roleAssignment.createMany).toHaveBeenCalledWith({
            data: [{ tenantId: 'tenant-1', userId: 'user-1', roleId: 'role-admin' }],
            skipDuplicates: true,
        });
        expect(prisma.$executeRaw).toHaveBeenCalled();
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

    it('accepts exactly the supported per-user role assignment maximum', async () => {
        const roleIds = Array.from({ length: MAX_ROLES_PER_USER }, (_, index) => `role-${index + 1}`);
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1', role: 'STAFF' });
        prisma.roleAssignment.findMany.mockResolvedValue([]);
        prisma.role.findMany.mockResolvedValue(roleIds.map((roleId) => accessRole(
            roleId,
            null,
            ['dashboard:access'],
            false,
        )));

        const result = await service.assignRolesToUserInTransaction(
            prisma,
            'user-1',
            'tenant-1',
            roleIds,
        );

        expect(result.assignedRoles).toHaveLength(MAX_ROLES_PER_USER);
        expect(prisma.roleAssignment.createMany).toHaveBeenCalledWith({
            data: roleIds.map((roleId) => ({ tenantId: 'tenant-1', userId: 'user-1', roleId })),
            skipDuplicates: true,
        });
    });

    it('rejects one role above the per-user maximum before locking or replacing assignments', async () => {
        const roleIds = Array.from({ length: MAX_ROLES_PER_USER + 1 }, (_, index) => `role-${index + 1}`);

        await expect(service.assignRolesToUserInTransaction(
            prisma,
            'user-1',
            'tenant-1',
            roleIds,
        )).rejects.toThrow(`at most ${MAX_ROLES_PER_USER} roles`);

        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.createMany).not.toHaveBeenCalled();
    });

    it('locks the tenant before the user, assignments, and tenant roles in canonical stable order', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
        prisma.roleAssignment.findMany.mockResolvedValueOnce([]);
        prisma.role.findMany.mockResolvedValue([{ id: 'role-a' }, { id: 'role-b' }]);

        await service.assignRolesToUserInTransaction(
            prisma,
            'user-1',
            'tenant-1',
            ['role-b', 'role-a', 'role-b'],
        );

        const lockSql = prisma.$queryRaw.mock.calls.map((call: any[]) => Array.from(call[0]).join('?'));
        expect(lockSql[0]).toContain('FROM "Tenant"');
        expect(lockSql[1]).toContain('FROM "User"');
        expect(lockSql[2]).toContain('FROM "RoleAssignment"');
        const roleLockValues = prisma.$queryRaw.mock.calls
            .filter((call: any[]) => Array.from(call[0]).join('?').includes('FROM "Role"'))
            .map((call: any[]) => call.slice(1));
        expect(roleLockValues).toEqual([
            ['tenant-1', 'role-a'],
            ['tenant-1', 'role-b'],
        ]);
        expect(prisma.$queryRaw.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[1]);
        expect(prisma.$queryRaw.mock.invocationCallOrder[1])
            .toBeLessThan(prisma.user.findFirst.mock.invocationCallOrder[0]);
        expect(prisma.user.findFirst.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[2]);
        expect(prisma.$queryRaw.mock.invocationCallOrder[2])
            .toBeLessThan(prisma.role.findMany.mock.invocationCallOrder[0]);
    });

    it('rejects a deleted or foreign-tenant role after taking the tenant-scoped lock', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
        prisma.roleAssignment.findMany.mockResolvedValueOnce([]);
        prisma.role.findMany.mockResolvedValue([]);

        await expect(service.assignRolesToUserInTransaction(
            prisma,
            'user-1',
            'tenant-1',
            ['role-foreign'],
        )).rejects.toBeInstanceOf(BadRequestException);

        const roleLock = prisma.$queryRaw.mock.calls.find((call: any[]) =>
            Array.from(call[0]).join('?').includes('FROM "Role"'));
        expect(roleLock?.slice(1)).toEqual(['tenant-1', 'role-foreign']);
        expect(prisma.role.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                tenantId: 'tenant-1',
                id: { in: ['role-foreign'] },
                deletedAt: null,
            },
        }));
        expect(prisma.roleAssignment.createMany).not.toHaveBeenCalled();
    });

    it('lets assignment commit first and makes the waiting deletion observe the assignment', async () => {
        const race = installRoleMutationRaceHarness();

        const assignment = service.assignRolesToUser('user-1', 'tenant-1', ['role-custom']);
        await race.firstLockAcquired;
        const deletion = service.deleteRole('tenant-1', 'role-custom', {
            actorUserId: 'actor-1', actorSessionId: 'session-1',
        });
        await race.secondLockQueued;
        race.releaseFirstLock();

        const [assignmentResult, deletionResult] = await Promise.allSettled([assignment, deletion]);
        expect(assignmentResult.status).toBe('fulfilled');
        expect(deletionResult.status).toBe('rejected');
        if (deletionResult.status === 'rejected') {
            expect(deletionResult.reason).toBeInstanceOf(ConflictException);
        }
        expect(race.state).toEqual({ deleted: false, assigned: true });
    });

    it('lets deletion commit first and makes the waiting assignment reject the deleted role', async () => {
        const race = installRoleMutationRaceHarness();

        const deletion = service.deleteRole('tenant-1', 'role-custom', {
            actorUserId: 'actor-1', actorSessionId: 'session-1',
        });
        await race.firstLockAcquired;
        const assignment = service.assignRolesToUser('user-1', 'tenant-1', ['role-custom']);
        await race.secondLockQueued;
        race.releaseFirstLock();

        const [deletionResult, assignmentResult] = await Promise.allSettled([deletion, assignment]);
        expect(deletionResult).toEqual({ status: 'fulfilled', value: true });
        expect(assignmentResult.status).toBe('rejected');
        if (assignmentResult.status === 'rejected') {
            expect(assignmentResult.reason).toBeInstanceOf(BadRequestException);
        }
        expect(race.state).toEqual({ deleted: true, assigned: false });
    });

    it('keeps repeated role deletion idempotent under the same tenant lock', async () => {
        prisma.role.findFirst
            .mockResolvedValueOnce({ id: 'role-custom', isSystem: false })
            .mockResolvedValueOnce(null);
        prisma.roleAssignment.count.mockResolvedValue(0);
        prisma.role.update.mockResolvedValue({ id: 'role-custom' });

        await expect(service.deleteRole(
            'tenant-1',
            'role-custom',
            { actorUserId: 'actor-1', actorSessionId: 'session-1' },
        )).resolves.toBe(true);
        await expect(service.deleteRole(
            'tenant-1',
            'role-custom',
            { actorUserId: 'actor-1', actorSessionId: 'session-1' },
        )).resolves.toBe(false);

        expect(prisma.role.update).toHaveBeenCalledOnce();
        const roleLocks = prisma.$queryRaw.mock.calls
            .filter((call: any[]) => Array.from(call[0]).join('?').includes('FROM "Role"'))
            .map((call: any[]) => call.slice(1));
        expect(roleLocks.filter((values: any[]) => values[1] === 'role-custom')).toEqual([
            ['tenant-1', 'role-custom'],
            ['tenant-1', 'role-custom'],
        ]);
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

    it('authoritatively replaces ADMIN access with the target-tenant STAFF system role', async () => {
        const staffRole = accessRole('role-staff', 'STAFF', [
            'dashboard:access',
            'schedules:read',
        ]);
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1', role: 'ADMIN' });
        prisma.roleAssignment.findMany.mockResolvedValue([{ roleId: 'role-admin' }]);
        prisma.role.findFirst.mockResolvedValue({ id: 'role-staff' });
        prisma.role.findMany.mockResolvedValue([staffRole]);
        prisma.roleAssignment.deleteMany.mockResolvedValue({ count: 1 });
        prisma.roleAssignment.createMany.mockResolvedValue({ count: 1 });

        const result = await service.replaceLegacySystemRoleForPlatformAdminInTransaction(
            prisma,
            'user-1',
            'tenant-1',
            'STAFF' as any,
        );

        expect(prisma.role.findFirst).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                slug: 'staff',
                isSystem: true,
                legacyRole: 'STAFF',
                deletedAt: null,
            },
            select: { id: true },
        });
        expect(prisma.roleAssignment.deleteMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                userId: 'user-1',
            },
        });
        expect(prisma.roleAssignment.createMany).toHaveBeenCalledWith({
            data: [{ tenantId: 'tenant-1', userId: 'user-1', roleId: 'role-staff' }],
            skipDuplicates: true,
        });
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { role: 'STAFF' },
        });
        expect(result).toMatchObject({
            changed: true,
            legacyRole: 'STAFF',
            previousLegacyRole: 'ADMIN',
            previousRoleIds: ['role-admin'],
            roleId: 'role-staff',
        });
        expect(result.assignedRoles[0].permissions).toEqual(['dashboard:access', 'schedules:read']);
        expect(result.assignedRoles[0].permissions).not.toContain('users:admin');
    });

    it('rejects a missing target-tenant system role before deleting assignments', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1', role: 'ADMIN' });
        prisma.roleAssignment.findMany.mockResolvedValue([{ roleId: 'role-admin' }]);
        prisma.role.findFirst.mockResolvedValue(null);

        await expect(service.replaceLegacySystemRoleForPlatformAdminInTransaction(
            prisma,
            'user-1',
            'tenant-1',
            'STAFF' as any,
        )).rejects.toThrow(/invalid for this tenant/i);

        expect(prisma.roleAssignment.deleteMany).not.toHaveBeenCalled();
        expect(prisma.roleAssignment.createMany).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
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
