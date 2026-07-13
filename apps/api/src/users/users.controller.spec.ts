import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ALLOW_AUTHENTICATED_METADATA_KEY } from '../auth/require-permission.decorator';
import { PERMISSION_METADATA_KEY } from '../auth/require-permission.decorator';
import { UsersController } from './users.controller';

const mockAuthService = {
    buildPinCredentialData: vi.fn(),
    setUserPin: vi.fn(),
    rotateOwnPin: vi.fn(),
};

const mockRbacService = {
    listPermissions: vi.fn(),
    listRolesForTenant: vi.fn(),
    assignRolesToUser: vi.fn(),
    assignRolesToUserInTransaction: vi.fn(),
    getUserRoleAssignments: vi.fn(),
    getEffectiveAccess: vi.fn(),
    createRole: vi.fn(),
    updateRole: vi.fn(),
};

const INVITE_DELEGATOR_PERMISSIONS = [
    'users:write',
    'dashboard:access',
    'auth:login_email',
    'auth:login_pin',
    'auth:login_password',
];

function inviteRequest(overrides: Record<string, unknown> = {}) {
    return {
        user: {
            tenantId: 'tenant-1',
            sub: 'admin-1',
            legacyRole: 'ADMIN',
            permissions: INVITE_DELEGATOR_PERMISSIONS,
            roles: [{ legacyRole: 'ADMIN' }],
            ...overrides,
        },
    };
}

function effectiveAccess(
    legacyRole: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF',
    permissions: string[],
    isSystem = true,
) {
    return {
        primaryRole: legacyRole,
        roles: [{ id: `role-${legacyRole.toLowerCase()}`, name: legacyRole, legacyRole, isSystem }],
        permissions,
    };
}

describe('UsersController', () => {
    let controller: UsersController;
    let prisma: any;
    let tenantDb: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockRbacService.listRolesForTenant.mockResolvedValue([
            {
                id: 'role-staff',
                name: 'Staff',
                rolePermissions: [
                    { permission: { key: 'dashboard:access' } },
                    { permission: { key: 'auth:login_email' } },
                    { permission: { key: 'auth:login_pin' } },
                    { permission: { key: 'auth:login_password' } },
                ],
                legacyRole: 'STAFF',
                isDefault: true,
            },
            {
                id: 'role-manager',
                name: 'Manager',
                rolePermissions: [
                    { permission: { key: 'dashboard:access' } },
                    { permission: { key: 'auth:login_email' } },
                    { permission: { key: 'auth:login_pin' } },
                ],
                legacyRole: 'MANAGER',
                isDefault: false,
            },
        ]);
        mockRbacService.listPermissions.mockResolvedValue([
            { key: 'dashboard:access', label: 'Dashboard', description: null, category: 'General' },
        ]);
        mockRbacService.assignRolesToUser.mockResolvedValue([{ id: 'role-staff', name: 'Staff', permissions: ['auth:login_pin'] }]);
        mockRbacService.assignRolesToUserInTransaction.mockResolvedValue(undefined);
        mockRbacService.getUserRoleAssignments.mockResolvedValue([{ id: 'role-staff', name: 'Staff', permissions: ['auth:login_pin'] }]);
        prisma = {
            tenant: {
                findUnique: vi.fn().mockResolvedValue({ planTier: 'FREE' }),
            },
            tenantSetting: {
                findUnique: vi.fn().mockResolvedValue(null),
            },
            user: {
                create: vi.fn(),
                findFirst: vi.fn(),
                findMany: vi.fn(),
                update: vi.fn(),
                updateMany: vi.fn(),
                count: vi.fn().mockResolvedValue(0),
            },
            session: {
                updateMany: vi.fn(),
            },
            passwordResetToken: {
                updateMany: vi.fn(),
            },
            passwordResetEmailOutbox: {
                updateMany: vi.fn(),
            },
            mfaTotpClaim: {
                deleteMany: vi.fn(),
            },
            location: {
                findMany: vi.fn(),
            },
            staffAvailability: {
                findMany: vi.fn().mockResolvedValue([]),
                deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
                createMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            staffSkill: {
                findMany: vi.fn().mockResolvedValue([]),
                deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
                createMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            schedule: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'user-8' }]),
            auditLog: {
                create: vi.fn(),
            },
        };
        tenantDb = {
            withTenant: vi.fn((_tenantId: string, operation: (tx: any) => unknown) => operation(prisma)),
        };
        prisma.user.findMany.mockImplementation(async ({ where }: any) => (where.id.in as string[])
            .filter((id) => id !== 'user-foreign')
            .map((id) => ({
                id,
                role: id === 'owner-1'
                    ? 'SUPER_ADMIN'
                    : id === 'admin-1'
                        ? 'ADMIN'
                        : id === 'manager-1'
                            ? 'MANAGER'
                            : 'STAFF',
            })));
        mockRbacService.getEffectiveAccess.mockImplementation(async (userId: string) => {
            if (userId === 'owner-1') {
                return effectiveAccess('SUPER_ADMIN', ['admin_portal:access', 'users:admin', 'roles:assign']);
            }
            if (userId === 'admin-1') {
                return effectiveAccess('ADMIN', ['users:admin', 'roles:assign', 'auth:login_pin', 'dashboard:access']);
            }
            if (userId === 'manager-1') {
                return effectiveAccess('MANAGER', ['roles:assign', 'dashboard:access', 'auth:login_pin']);
            }
            return effectiveAccess('STAFF', ['auth:login_pin', 'dashboard:access']);
        });
        mockAuthService.buildPinCredentialData.mockImplementation((pin: string, pinResetRequired: boolean, now: Date) => ({
            pinHash: `hash:${pin}`,
            pinSetAt: now,
            pinResetRequired,
            pinLoginAttempts: 0,
            pinLockedUntil: null,
        }));
        controller = new UsersController(mockAuthService as any, mockRbacService as any, tenantDb);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('marks caller-delegable roles and selects the configured delegable invite default', async () => {
        prisma.tenantSetting.findUnique.mockResolvedValue({ value: { team: { defaultInviteRole: 'MANAGER' } } });
        mockRbacService.listRolesForTenant.mockResolvedValue([
            {
                id: 'role-admin', name: 'Admin', slug: 'admin', description: null, isSystem: true, isDefault: true,
                legacyRole: 'ADMIN', _count: { assignments: 1 },
                rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
            },
            {
                id: 'role-manager', name: 'Manager', slug: 'manager', description: null, isSystem: true, isDefault: false,
                legacyRole: 'MANAGER', _count: { assignments: 2 },
                rolePermissions: [{ permission: { key: 'dashboard:access' } }],
            },
            {
                id: 'role-staff', name: 'Staff', slug: 'staff', description: null, isSystem: true, isDefault: false,
                legacyRole: 'STAFF', _count: { assignments: 4 },
                rolePermissions: [{ permission: { key: 'dashboard:access' } }],
            },
        ]);

        const result = await controller.accessCatalog({
            user: { tenantId: 'tenant-1', legacyRole: 'ADMIN', permissions: ['dashboard:access'] },
        });

        expect(result.defaultInviteRoleId).toBe('role-manager');
        expect(result.roles.map((role) => [role.id, role.canDelegate])).toEqual([
            ['role-admin', false],
            ['role-manager', true],
            ['role-staff', true],
        ]);
    });

    it('falls back to Staff when the configured invite role is not delegable', async () => {
        prisma.tenantSetting.findUnique.mockResolvedValue({ value: { team: { defaultInviteRole: 'MANAGER' } } });
        mockRbacService.listRolesForTenant.mockResolvedValue([
            {
                id: 'role-manager', name: 'Manager', slug: 'manager', description: null, isSystem: true, isDefault: true,
                legacyRole: 'MANAGER', _count: { assignments: 2 },
                rolePermissions: [{ permission: { key: 'users:admin' } }],
            },
            {
                id: 'role-staff', name: 'Staff', slug: 'staff', description: null, isSystem: true, isDefault: false,
                legacyRole: 'STAFF', _count: { assignments: 4 },
                rolePermissions: [{ permission: { key: 'dashboard:access' } }],
            },
        ]);

        const result = await controller.accessCatalog({
            user: { tenantId: 'tenant-1', legacyRole: 'ADMIN', permissions: ['dashboard:access'] },
        });

        expect(result.defaultInviteRoleId).toBe('role-staff');
        expect(result.roles.find((role) => role.id === 'role-manager')?.canDelegate).toBe(false);
    });

    it('invites username-based staff and provisions a temporary PIN', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        prisma.user.create.mockResolvedValue({
            id: 'user-1',
            email: null,
            username: 'shiftlead',
            name: 'Shift Lead',
            role: 'STAFF',
            pinHash: null,
        });
        prisma.auditLog.create.mockResolvedValue({});

        const result = await controller.invite(
            { name: 'Shift Lead', username: 'shiftlead', role: 'STAFF' },
            inviteRequest(),
        );

        expect(mockAuthService.buildPinCredentialData).toHaveBeenCalledWith('100000', true, expect.any(Date));
        expect(prisma.user.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ pinHash: 'hash:100000', pinResetRequired: true }),
        });
        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
        expect(result.username).toBe('shiftlead');
        expect(result.temporaryPin).toBe('100000');
        expect(result.pinResetRequired).toBe(true);
        expect(mockRbacService.assignRolesToUserInTransaction).toHaveBeenCalledWith(
            prisma,
            'user-1',
            'tenant-1',
            ['role-staff'],
        );
    });

    it('invites email-based manager without PIN provisioning', async () => {
        prisma.user.create.mockResolvedValue({
            id: 'user-2',
            email: 'manager@company.com',
            username: null,
            name: 'Manager',
            role: 'MANAGER',
            pinHash: null,
        });
        prisma.auditLog.create.mockResolvedValue({});

        const result = await controller.invite(
            { name: 'Manager', email: 'manager@company.com', role: 'MANAGER' },
            inviteRequest(),
        );

        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
        expect(result.email).toBe('manager@company.com');
        expect(result.temporaryPin).toBe(null);
    });

    it('reactivates an email user while invalidating all prior credentials, recovery, and sessions', async () => {
        prisma.user.findFirst.mockResolvedValueOnce({ id: 'archived-user' });
        prisma.user.update.mockResolvedValue({
            id: 'archived-user',
            email: 'returning@company.com',
            username: null,
            name: 'Returning Manager',
            role: 'MANAGER',
        });
        prisma.auditLog.create.mockResolvedValue({});

        const result = await controller.invite(
            { name: 'Returning Manager', email: 'returning@company.com', role: 'MANAGER' },
            inviteRequest(),
        );

        expect(prisma.user.findFirst).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                deletedAt: { not: null },
                email: 'returning@company.com',
            },
            select: { id: true },
        });
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'archived-user' },
            data: expect.objectContaining({
                deletedAt: null,
                passwordHash: null,
                pinHash: null,
                pinSetAt: null,
                pinResetRequired: false,
                oidcIssuer: null,
                oidcSubject: null,
                mfaEnabled: false,
                mfaSecret: null,
                mfaBackupCodes: [],
                loginAttempts: 0,
                lockedUntil: null,
                pinLoginAttempts: 0,
                pinLockedUntil: null,
                lastLoginAt: null,
            }),
        });
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'archived-user', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'archived-user', consumedAt: null },
            data: { consumedAt: expect.any(Date) },
        });
        expect(prisma.passwordResetEmailOutbox.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                userId: 'archived-user',
                status: { in: ['PENDING', 'SENDING', 'FAILED'] },
            },
            data: {
                status: 'DEAD_LETTERED',
                deadLetteredAt: expect.any(Date),
                leaseUntil: null,
                lastError: 'User credentials reprovisioned',
            },
        });
        expect(prisma.mfaTotpClaim.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'archived-user' },
        });
        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ action: 'USER_REACTIVATED', resourceId: 'archived-user' }),
        });
        expect(mockAuthService.buildPinCredentialData).not.toHaveBeenCalled();
        expect(result.email).toBe('returning@company.com');
    });

    it('reactivates a username user with only the newly requested PIN credential', async () => {
        prisma.user.findFirst.mockResolvedValueOnce({ id: 'archived-pin-user' });
        prisma.user.update.mockResolvedValue({
            id: 'archived-pin-user',
            email: null,
            username: 'returning.staff',
            name: 'Returning Staff',
            role: 'STAFF',
            pinHash: 'hash:246810',
            pinResetRequired: false,
        });

        const result = await controller.invite(
            { name: 'Returning Staff', username: 'returning.staff', pin: '246810', role: 'STAFF' },
            inviteRequest(),
        );

        expect(mockAuthService.buildPinCredentialData).toHaveBeenCalledWith('246810', false, expect.any(Date));
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'archived-pin-user' },
            data: expect.objectContaining({
                email: null,
                username: 'returning.staff',
                passwordHash: null,
                pinHash: 'hash:246810',
                pinResetRequired: false,
                oidcIssuer: null,
                oidcSubject: null,
                mfaEnabled: false,
                mfaSecret: null,
                mfaBackupCodes: [],
                deletedAt: null,
            }),
        });
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'archived-pin-user', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
        expect(result.temporaryPin).toBe('246810');
    });
    it('rejects email-only invites for password-only roles without credential bootstrap', async () => {
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([{
            id: 'role-password-only',
            name: 'Password only',
            rolePermissions: [{ permission: { key: 'auth:login_password' } }],
            legacyRole: null,
            isDefault: false,
        }]);

        await expect(controller.invite(
            { name: 'Unusable User', email: 'unusable@example.com', roleId: 'role-password-only' },
            inviteRequest(),
        )).rejects.toThrow('Email login is not enabled for the selected role');

        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
    });

    it('rejects invited email identities that the OTP login endpoint cannot accept', async () => {
        await expect(controller.invite(
            { name: 'Invalid Email', email: 'owner<script>@example.com', role: 'STAFF' },
            inviteRequest(),
        )).rejects.toThrow('Invalid email address');

        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('invites a PIN-based manager when the selected role supports both login methods', async () => {
        prisma.user.create.mockResolvedValue({
            id: 'user-2b',
            email: null,
            username: 'floor.manager',
            name: 'Floor Manager',
            role: 'MANAGER',
            pinHash: null,
        });
        prisma.auditLog.create.mockResolvedValue({});

        const result = await controller.invite(
            { name: 'Floor Manager', username: 'floor.manager', pin: '135790', roleId: 'role-manager' },
            inviteRequest(),
        );

        expect(prisma.user.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                email: null,
                username: 'floor.manager',
                name: 'Floor Manager',
                role: 'MANAGER',
                pinHash: 'hash:135790',
                pinResetRequired: false,
            }),
        });
        expect(mockAuthService.buildPinCredentialData).toHaveBeenCalledWith('135790', false, expect.any(Date));
        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
        expect(result.role).toBe('MANAGER');
    });

    it('uses the configured team default invite role when role is omitted', async () => {
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                team: {
                    defaultInviteRole: 'MANAGER',
                },
            },
        });
        prisma.user.create.mockResolvedValue({
            id: 'user-3',
            email: 'invitee@company.com',
            username: null,
            name: 'Invitee',
            role: 'MANAGER',
            pinHash: null,
        });
        prisma.auditLog.create.mockResolvedValue({});

        const result = await controller.invite(
            { name: 'Invitee', email: 'invitee@company.com' },
            inviteRequest(),
        );

        expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
            where: {
                tenantId_key: {
                    tenantId: 'tenant-1',
                    key: 'workspace_settings',
                },
            },
            select: { value: true },
        });
        expect(prisma.user.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                email: 'invitee@company.com',
                username: null,
                name: 'Invitee',
                role: 'MANAGER',
            },
        });
        expect(result.role).toBe('MANAGER');
    });

    it('keeps an explicit invite role even when a team default is configured', async () => {
        prisma.tenantSetting.findUnique.mockResolvedValue({
            value: {
                team: {
                    defaultInviteRole: 'MANAGER',
                },
            },
        });
        prisma.user.create.mockResolvedValue({
            id: 'user-4',
            email: 'staff@company.com',
            username: null,
            name: 'Staff',
            role: 'STAFF',
            pinHash: null,
        });
        prisma.auditLog.create.mockResolvedValue({});

        const result = await controller.invite(
            { name: 'Staff', email: 'staff@company.com', role: 'STAFF' },
            inviteRequest(),
        );

        expect(prisma.tenantSetting.findUnique).not.toHaveBeenCalled();
        expect(prisma.user.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                email: 'staff@company.com',
                username: null,
                name: 'Staff',
                role: 'STAFF',
            },
        });
        expect(result.role).toBe('STAFF');
    });

    it('falls back to STAFF when the team default invite role is missing or invalid', async () => {
        prisma.user.create.mockResolvedValue({
            id: 'user-5',
            email: 'fallback@company.com',
            username: null,
            name: 'Fallback',
            role: 'STAFF',
            pinHash: null,
        });
        prisma.auditLog.create.mockResolvedValue({});

        prisma.tenantSetting.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                value: {
                    team: {
                        defaultInviteRole: 'LEAD',
                    },
                },
            });

        const missingConfigResult = await controller.invite(
            { name: 'Fallback', email: 'fallback@company.com' },
            inviteRequest(),
        );

        expect(missingConfigResult.role).toBe('STAFF');

        prisma.user.create.mockResolvedValueOnce({
            id: 'user-6',
            email: 'fallback-2@company.com',
            username: null,
            name: 'Fallback Two',
            role: 'STAFF',
            pinHash: null,
        });

        const invalidConfigResult = await controller.invite(
            { name: 'Fallback Two', email: 'fallback-2@company.com' },
            inviteRequest(),
        );

        expect(invalidConfigResult.role).toBe('STAFF');
        expect(prisma.user.create).toHaveBeenLastCalledWith({
            data: {
                tenantId: 'tenant-1',
                email: 'fallback-2@company.com',
                username: null,
                name: 'Fallback Two',
                role: 'STAFF',
            },
        });
    });

    it('rejects invites when the tenant is already at the active user limit', async () => {
        prisma.user.count.mockResolvedValueOnce(10);

        await expect(
            controller.invite(
                { name: 'Overflow User', email: 'overflow@example.com', role: 'STAFF' },
                inviteRequest(),
            ),
        ).rejects.toThrow(/User limit reached/i);

        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
    });

    it('does not commit an invited user when transactional role assignment fails', async () => {
        const committedUsers: any[] = [];
        tenantDb.withTenant.mockImplementation(async (_tenantId: string, operation: (tx: any) => Promise<unknown>) => {
            let stagedUser: any = null;
            const tx = {
                ...prisma,
                user: {
                    ...prisma.user,
                    create: vi.fn(async ({ data }: any) => {
                        stagedUser = { id: 'orphan-candidate', pinHash: null, ...data };
                        return stagedUser;
                    }),
                },
            };
            const result = await operation(tx);
            if (stagedUser) committedUsers.push(stagedUser);
            return result;
        });
        mockRbacService.assignRolesToUserInTransaction.mockRejectedValueOnce(new Error('assignment failed'));

        await expect(controller.invite(
            { name: 'Atomic Invite', email: 'atomic@example.com', role: 'STAFF' },
            inviteRequest(),
        )).rejects.toThrow('assignment failed');

        expect(committedUsers).toEqual([]);
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
    });

    it('rejects an invite role containing permissions the caller does not hold', async () => {
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([{
            id: 'role-billing',
            name: 'Billing Manager',
            rolePermissions: [
                { permission: { key: 'auth:login_email' } },
                { permission: { key: 'billing:write' } },
            ],
            legacyRole: null,
            isDefault: false,
        }]);

        await expect(controller.invite(
            { name: 'Escalated Invite', email: 'escalated@example.com', roleId: 'role-billing' },
            inviteRequest(),
        )).rejects.toThrow('Cannot grant a role with permissions you do not hold');

        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(mockRbacService.assignRolesToUserInTransaction).not.toHaveBeenCalled();
    });

    it('allows an admin to reset a lower-rank username account', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

        prisma.user.findMany.mockResolvedValue([
            { id: 'admin-1', role: 'ADMIN' },
            { id: 'user-3', role: 'STAFF' },
        ]);
        prisma.user.findFirst.mockResolvedValue({
            id: 'user-3',
            username: 'crewlead',
            role: 'STAFF',
        });
        prisma.auditLog.create.mockResolvedValue({});

        const result = await controller.resetUserPin(
            'user-3',
            {},
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
        );

        expect(mockAuthService.setUserPin).toHaveBeenCalledWith('user-3', '100000', true, 'tenant-1');
        expect(result).toEqual({
            id: 'user-3',
            username: 'crewlead',
            temporaryPin: '100000',
            pinResetRequired: true,
        });
    });

    it.each([
        ['manager', 'MANAGER', 'ADMIN'],
        ['admin', 'ADMIN', 'SUPER_ADMIN'],
        ['same-rank admin', 'ADMIN', 'ADMIN'],
    ] as const)('blocks %s PIN reset takeover', async (_label, actorRole, targetRole) => {
        const actorId = 'actor-1';
        const targetId = 'target-1';
        prisma.user.findMany.mockResolvedValue([
            { id: actorId, role: actorRole },
            { id: targetId, role: targetRole },
        ]);
        mockRbacService.getEffectiveAccess.mockImplementation(async (userId: string) => userId === actorId
            ? effectiveAccess(actorRole, ['users:admin', 'auth:login_pin', 'dashboard:access'])
            : effectiveAccess(targetRole, ['auth:login_pin', 'dashboard:access']));

        await expect(controller.resetUserPin(
            targetId,
            {},
            { user: { tenantId: 'tenant-1', sub: actorId } },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('blocks reset of a lower nominal role when the target has an unheld effective permission', async () => {
        prisma.user.findMany.mockResolvedValue([
            { id: 'admin-1', role: 'ADMIN' },
            { id: 'privileged-staff', role: 'STAFF' },
        ]);
        mockRbacService.getEffectiveAccess.mockImplementation(async (userId: string) => userId === 'admin-1'
            ? effectiveAccess('ADMIN', ['users:admin', 'auth:login_pin', 'dashboard:access'])
            : effectiveAccess('STAFF', ['auth:login_pin', 'dashboard:access', 'billing:write'], false));

        await expect(controller.resetUserPin(
            'privileged-staff',
            {},
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
    });

    it('does not treat a stale SUPER_ADMIN user row as exceptional authority', async () => {
        prisma.user.findMany.mockResolvedValue([
            { id: 'stale-super', role: 'SUPER_ADMIN' },
            { id: 'target-admin', role: 'ADMIN' },
        ]);
        mockRbacService.getEffectiveAccess.mockImplementation(async (userId: string) => userId === 'stale-super'
            ? effectiveAccess('ADMIN', ['users:admin', 'auth:login_pin', 'dashboard:access'])
            : effectiveAccess('ADMIN', ['auth:login_pin', 'dashboard:access']));

        await expect(controller.resetUserPin(
            'target-admin',
            {},
            { user: { tenantId: 'tenant-1', sub: 'stale-super' } },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
    });

    it('allows a true system super admin to reset another non-self super admin', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        prisma.user.findMany.mockResolvedValue([
            { id: 'system-super', role: 'SUPER_ADMIN' },
            { id: 'target-super', role: 'SUPER_ADMIN' },
        ]);
        prisma.user.findFirst.mockResolvedValue({
            id: 'target-super',
            username: 'platform.owner',
            role: 'SUPER_ADMIN',
            name: 'Platform Owner',
            email: null,
        });
        prisma.auditLog.create.mockResolvedValue({});
        mockRbacService.getEffectiveAccess.mockImplementation(async (userId: string) => userId === 'system-super'
            ? effectiveAccess('SUPER_ADMIN', ['users:admin', 'auth:login_pin', 'dashboard:access'])
            : effectiveAccess('SUPER_ADMIN', ['users:admin', 'auth:login_pin', 'dashboard:access']));

        await expect(controller.resetUserPin(
            'target-super',
            {},
            { user: { tenantId: 'tenant-1', sub: 'system-super' } },
        )).resolves.toEqual(expect.objectContaining({
            id: 'target-super',
            pinResetRequired: true,
        }));

        expect(mockAuthService.setUserPin).toHaveBeenCalledWith(
            'target-super',
            '100000',
            true,
            'tenant-1',
        );
    });

    it('blocks self reset through the admin route', async () => {
        await expect(controller.resetUserPin(
            'admin-1',
            {},
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
    });

    it('delegates self PIN rotation to AuthService', async () => {
        mockAuthService.rotateOwnPin.mockResolvedValue(undefined);

        const result = await controller.rotateOwnPin(
            { user: { sub: 'user-4', tenantId: 'tenant-1' } },
            { currentPin: '1234', newPin: '5678' },
        );

        expect(mockAuthService.rotateOwnPin).toHaveBeenCalledWith('user-4', '1234', '5678', 'tenant-1');
        expect(result).toEqual({ success: true });
    });

    it('marks self PIN rotation as authenticated-only instead of permission-gated', () => {
        const method = UsersController.prototype.rotateOwnPin;

        expect(Reflect.getMetadata(ALLOW_AUTHENTICATED_METADATA_KEY, method)).toBe(true);
    });

    it('rejects non-system admin invites into system admin access', async () => {
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([
            {
                id: 'role-super',
                name: 'System Admin',
                rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
                legacyRole: 'SUPER_ADMIN',
                isDefault: false,
            },
        ]);

        await expect(
            controller.invite(
                { name: 'Platform Owner', email: 'owner@company.com', role: 'SUPER_ADMIN' },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', legacyRole: 'ADMIN', permissions: ['users:write'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('never lets a client role forge SUPER_ADMIN through a custom role invite', async () => {
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([
            {
                id: 'role-custom',
                name: 'Schedule Coordinator',
                rolePermissions: [
                    { permission: { key: 'dashboard:access' } },
                    { permission: { key: 'auth:login_email' } },
                ],
                legacyRole: null,
                isDefault: false,
            },
        ]);
        prisma.user.create.mockResolvedValue({
            id: 'user-custom',
            email: 'coordinator@company.com',
            username: null,
            name: 'Coordinator',
            role: 'STAFF',
            pinHash: null,
        });

        await controller.invite(
            {
                name: 'Coordinator',
                email: 'coordinator@company.com',
                roleId: 'role-custom',
                role: 'SUPER_ADMIN',
            },
            inviteRequest(),
        );

        expect(prisma.user.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                email: 'coordinator@company.com',
                username: null,
                name: 'Coordinator',
                role: 'STAFF',
            },
        });
        expect(mockRbacService.assignRolesToUserInTransaction).toHaveBeenCalledWith(
            prisma,
            'user-custom',
            'tenant-1',
            ['role-custom'],
        );
    });

    it('rejects non-system admin legacy role promotion to SUPER_ADMIN', async () => {
        await expect(
            controller.updateRole(
                'user-7',
                { role: 'SUPER_ADMIN' },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', legacyRole: 'ADMIN', permissions: ['users:admin'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('rejects changing the caller own role before resolving or mutating the replacement role', async () => {
        await expect(
            controller.updateRole(
                'admin-1',
                { role: 'STAFF' },
                inviteRequest({ permissions: ['users:admin', ...INVITE_DELEGATOR_PERMISSIONS] }),
            ),
        ).rejects.toThrow('You cannot change your own role');

        expect(mockRbacService.listRolesForTenant).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockRbacService.assignRolesToUserInTransaction).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: 'system admin',
            targetId: 'owner-1',
            targetRole: 'SUPER_ADMIN' as const,
            targetAccess: effectiveAccess('SUPER_ADMIN', ['admin_portal:access', 'users:admin']),
        },
        {
            label: 'platform admin',
            targetId: 'platform-admin-1',
            targetRole: 'STAFF' as const,
            targetAccess: effectiveAccess('STAFF', ['dashboard:access', 'admin_portal:access'], false),
        },
    ])('rejects a tenant admin demoting a $label', async ({ targetId, targetRole, targetAccess }) => {
        prisma.user.findMany.mockResolvedValueOnce([
            { id: 'admin-1', role: 'ADMIN' },
            { id: targetId, role: targetRole },
        ]);
        mockRbacService.getEffectiveAccess.mockImplementationOnce(async () => (
            effectiveAccess('ADMIN', ['users:admin', 'dashboard:access'])
        )).mockImplementationOnce(async () => targetAccess);

        await expect(
            controller.updateRole(
                targetId,
                { role: 'STAFF' },
                inviteRequest({ permissions: ['users:admin', ...INVITE_DELEGATOR_PERMISSIONS] }),
            ),
        ).rejects.toThrow('Cannot administer an account with equal or greater access');

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockRbacService.assignRolesToUserInTransaction).not.toHaveBeenCalled();
    });

    it.each([
        { label: 'equal-rank', targetId: 'peer-admin-1', targetRole: 'ADMIN' as const },
        { label: 'higher-rank', targetId: 'owner-1', targetRole: 'SUPER_ADMIN' as const },
    ])('rejects changing an $label target role', async ({ targetId, targetRole }) => {
        prisma.user.findMany.mockResolvedValueOnce([
            { id: 'admin-1', role: 'ADMIN' },
            { id: targetId, role: targetRole },
        ]);
        mockRbacService.getEffectiveAccess.mockImplementationOnce(async () => (
            effectiveAccess('ADMIN', ['users:admin', 'dashboard:access'])
        )).mockImplementationOnce(async () => (
            effectiveAccess(targetRole, ['dashboard:access'])
        ));

        await expect(
            controller.updateRole(
                targetId,
                { role: 'STAFF' },
                inviteRequest({ permissions: ['users:admin', ...INVITE_DELEGATOR_PERMISSIONS] }),
            ),
        ).rejects.toThrow('Cannot administer an account with equal or greater access');

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockRbacService.assignRolesToUserInTransaction).not.toHaveBeenCalled();
    });

    it('rejects changing a lower-rank target that holds an unheld permission', async () => {
        mockRbacService.getEffectiveAccess.mockImplementationOnce(async () => (
            effectiveAccess('ADMIN', ['users:admin', 'dashboard:access'])
        )).mockImplementationOnce(async () => (
            effectiveAccess('STAFF', ['dashboard:access', 'schedules:publish'])
        ));

        await expect(
            controller.updateRole(
                'user-7',
                { role: 'STAFF' },
                inviteRequest({ permissions: ['users:admin', ...INVITE_DELEGATOR_PERMISSIONS] }),
            ),
        ).rejects.toThrow('Cannot administer an account with equal or greater access');

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockRbacService.assignRolesToUserInTransaction).not.toHaveBeenCalled();
    });

    it('updates a lower-rank target when the actor holds all target and replacement-role permissions', async () => {
        prisma.user.updateMany.mockResolvedValueOnce({ count: 1 });

        const result = await controller.updateRole(
            'user-7',
            { role: 'MANAGER' },
            inviteRequest({ permissions: ['users:admin', ...INVITE_DELEGATOR_PERMISSIONS] }),
        );

        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: 'user-7', tenantId: 'tenant-1' },
            data: { role: 'MANAGER' },
        });
        expect(mockRbacService.assignRolesToUserInTransaction).toHaveBeenCalledWith(
            prisma,
            'user-7',
            'tenant-1',
            ['role-manager'],
        );
        expect(result).toEqual({
            id: 'user-7',
            role: 'MANAGER',
            assignedRoles: [{ id: 'role-staff', name: 'Staff', permissions: ['auth:login_pin'] }],
        });
    });

    it('rejects non-system admin assignment of platform access roles', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-8' });
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([
            {
                id: 'role-platform',
                name: 'Platform Access',
                rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
                legacyRole: null,
                isDefault: false,
            },
        ]);

        await expect(
            controller.updateUserAccess(
                'user-8',
                { roleIds: ['role-platform'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', legacyRole: 'ADMIN', permissions: ['roles:assign'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('rejects non-system admin assignment of tenant lifecycle roles', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-8' });
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([
            {
                id: 'role-lifecycle',
                name: 'Tenant Lifecycle',
                rolePermissions: [{ permission: { key: 'tenant_account:lifecycle' } }],
                legacyRole: null,
                isDefault: false,
            },
        ]);

        await expect(
            controller.updateUserAccess(
                'user-8',
                { roleIds: ['role-lifecycle'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', legacyRole: 'ADMIN', permissions: ['roles:assign'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('rejects role assignment requests with role ids outside the tenant', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-8' });
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([
            {
                id: 'role-staff',
                name: 'Staff',
                rolePermissions: [{ permission: { key: 'dashboard:access' } }],
                legacyRole: 'STAFF',
                isDefault: true,
            },
        ]);

        await expect(
            controller.updateUserAccess(
                'user-8',
                { roleIds: ['role-staff', 'role-foreign'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', legacyRole: 'ADMIN', permissions: ['roles:assign'] } },
            ),
        ).rejects.toThrow('One or more roles are invalid for this tenant');

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('rejects role assignment containing permissions the caller does not hold', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-8' });
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([{
            id: 'role-billing',
            name: 'Billing Manager',
            rolePermissions: [
                { permission: { key: 'dashboard:access' } },
                { permission: { key: 'billing:write' } },
            ],
            legacyRole: null,
            isDefault: false,
        }]);

        await expect(controller.updateUserAccess(
            'user-8',
            { roleIds: ['role-billing'] },
            {
                user: {
                    tenantId: 'tenant-1',
                    sub: 'manager-1',
                    legacyRole: 'MANAGER',
                    permissions: ['roles:assign', 'dashboard:access'],
                    roles: [{ legacyRole: 'MANAGER' }],
                },
            },
        )).rejects.toThrow('Cannot grant a role with permissions you do not hold');

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('allows assignment when every delegated permission is held by the caller', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-8' });
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([{
            id: 'role-staff',
            name: 'Staff',
            rolePermissions: [{ permission: { key: 'dashboard:access' } }],
            legacyRole: 'STAFF',
            isDefault: true,
        }]);

        await controller.updateUserAccess(
            'user-8',
            { roleIds: ['role-staff'] },
            {
                user: {
                    tenantId: 'tenant-1',
                    sub: 'manager-1',
                    legacyRole: 'MANAGER',
                    permissions: ['roles:assign', 'dashboard:access'],
                    roles: [{ legacyRole: 'MANAGER' }],
                },
            },
        );

        expect(mockRbacService.assignRolesToUser).toHaveBeenCalledWith('user-8', 'tenant-1', ['role-staff']);
    });

    it('allows an actual system admin to assign protected system-admin access', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-8' });
        mockRbacService.listRolesForTenant.mockResolvedValueOnce([{
            id: 'role-super',
            name: 'System Admin',
            rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
            legacyRole: 'SUPER_ADMIN',
            isDefault: false,
        }]);

        await controller.updateUserAccess(
            'user-8',
            { roleIds: ['role-super'] },
            {
                user: {
                    tenantId: 'tenant-1',
                    sub: 'owner-1',
                    legacyRole: 'SUPER_ADMIN',
                    permissions: ['roles:assign', 'admin_portal:access'],
                    roles: [{ legacyRole: 'SUPER_ADMIN' }],
                },
            },
        );

        expect(mockRbacService.assignRolesToUser).toHaveBeenCalledWith('user-8', 'tenant-1', ['role-super']);
    });

    it('rejects changing the caller own role assignments', async () => {
        await expect(controller.updateUserAccess(
            'admin-1',
            { roleIds: [] },
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
        )).rejects.toThrow('You cannot change your own access roles');

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('rejects a lower-privilege role administrator changing a tenant owner', async () => {
        await expect(controller.updateUserAccess(
            'owner-1',
            { roleIds: [] },
            { user: { tenantId: 'tenant-1', sub: 'manager-1' } },
        )).rejects.toThrow('Cannot administer an account with equal or greater access');

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('deactivates only a tenant-owned user before revoking sessions', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-9' });
        prisma.user.updateMany.mockResolvedValue({ count: 1 });
        prisma.session.updateMany.mockResolvedValue({ count: 2 });

        await controller.deactivate('user-9', { user: { tenantId: 'tenant-1', sub: 'admin-1' } });

        expect(prisma.user.findFirst).toHaveBeenCalledWith({
            where: { id: 'user-9', tenantId: 'tenant-1', deletedAt: null },
            select: { id: true },
        });
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-9',
                user: {
                    tenantId: 'tenant-1',
                },
            },
            data: { revokedAt: expect.any(Date) },
        });
    });

    it('does not revoke sessions when deactivation target is outside the tenant', async () => {
        await expect(controller.deactivate(
            'user-foreign',
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
        )).rejects.toThrow('User not found');

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('rejects self-deactivation before mutating the account', async () => {
        await expect(controller.deactivate(
            'admin-1',
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
        )).rejects.toThrow('You cannot deactivate your own account');

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a lower-privilege user administrator deactivating a tenant owner', async () => {
        mockRbacService.getEffectiveAccess.mockImplementation(async (userId: string) => userId === 'owner-1'
            ? effectiveAccess('SUPER_ADMIN', ['admin_portal:access', 'users:admin'], true)
            : effectiveAccess('MANAGER', ['users:admin'], true));

        await expect(controller.deactivate(
            'owner-1',
            { user: { tenantId: 'tenant-1', sub: 'manager-1' } },
        )).rejects.toThrow('Cannot administer an account with equal or greater access');

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('rejects non-system admin custom roles with platform admin permissions', async () => {
        await expect(
            controller.createAccessRole(
                { name: 'Platform Access', permissionKeys: ['admin_portal:access'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.createRole).not.toHaveBeenCalled();
    });

    it.each([
        ' admin_portal:access ',
        '\tTENANT_ACCOUNT:LIFECYCLE\r\n',
        '\u00a0ADMIN_PORTAL:ACCESS\u00a0',
    ])('rejects non-system admin custom roles after canonicalizing %j', async (permissionKey) => {
        await expect(
            controller.createAccessRole(
                { name: 'Escalated access', permissionKeys: [permissionKey] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.createRole).not.toHaveBeenCalled();
    });

    it('passes canonical permission keys and explicit authority to the RBAC service', async () => {
        mockRbacService.createRole.mockResolvedValue({
            id: 'role-platform',
            name: 'Platform access',
            description: null,
            isSystem: false,
            rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
        });

        await controller.createAccessRole(
            { name: 'Platform access', permissionKeys: ['  ADMIN_PORTAL:ACCESS  '] },
            { user: { tenantId: 'tenant-1', sub: 'owner-1', legacyRole: 'SUPER_ADMIN', permissions: ['roles:write'] } },
        );

        expect(mockRbacService.createRole).toHaveBeenCalledWith(
            'tenant-1',
            { name: 'Platform access', permissionKeys: ['admin_portal:access'] },
            { actorUserId: 'owner-1' },
        );
    });

    it('passes the live actor identity when updating a custom role', async () => {
        mockRbacService.updateRole.mockResolvedValue({
            id: 'role-reader',
            name: 'Reader',
            description: null,
            isSystem: false,
            rolePermissions: [{ permission: { key: 'users:read' } }],
            _count: { assignments: 1 },
        });

        await controller.updateAccessRole(
            'role-reader',
            { name: 'Reader', permissionKeys: ['users:read'] },
            { user: { tenantId: 'tenant-1', sub: 'admin-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
        );

        expect(mockRbacService.updateRole).toHaveBeenCalledWith(
            'tenant-1',
            'role-reader',
            { name: 'Reader', permissionKeys: ['users:read'] },
            { actorUserId: 'admin-1' },
        );
    });

    it('rejects non-system admin custom roles with tenant lifecycle permissions', async () => {
        await expect(
            controller.createAccessRole(
                { name: 'Tenant Lifecycle', permissionKeys: ['tenant_account:lifecycle'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.createRole).not.toHaveBeenCalled();
    });

    it('reads a tenant-scoped scheduling profile and exposes missing availability explicitly', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-8', name: 'Avery' });
        prisma.staffSkill.findMany.mockResolvedValue([{ skill: 'expo' }]);

        await expect(controller.schedulingProfile('user-8', {
            user: { tenantId: 'tenant-1' },
        })).resolves.toEqual({
            user: { id: 'user-8', name: 'Avery' },
            skills: ['expo'],
            availability: [],
            availabilityConfigured: false,
        });
        expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'user-8', tenantId: 'tenant-1', deletedAt: null },
        }));
        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    });

    it('atomically replaces a normalized scheduling profile after locking active tenant scope', async () => {
        prisma.staffSkill.findMany.mockResolvedValue([
            { skill: 'expo' },
            { skill: 'grill cook' },
        ]);
        prisma.$queryRaw
            .mockResolvedValueOnce([{ id: 'user-8', role: 'STAFF' }])
            .mockResolvedValueOnce([{ id: 'loc-1' }])
            .mockResolvedValueOnce([{ id: 'sch-1' }]);

        await expect(controller.replaceSchedulingProfile('user-8', {
            skills: [' Grill   Cook ', 'grill cook', 'EXPO'],
            availability: [{
                locationId: 'loc-1',
                dayOfWeek: 5,
                startTimeMinutes: 1320,
                endTimeMinutes: 120,
            }],
        }, { user: { tenantId: 'tenant-1' } })).resolves.toEqual({
            user: { id: 'user-8' },
            skills: ['expo', 'grill cook'],
            availability: [{
                locationId: 'loc-1',
                dayOfWeek: 5,
                startTimeMinutes: 1320,
                endTimeMinutes: 120,
            }],
            availabilityConfigured: true,
        });

        expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
        expect(prisma.schedule.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['sch-1'] },
                tenantId: 'tenant-1',
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
        expect(prisma.staffSkill.createMany).toHaveBeenCalledWith({ data: [
            { tenantId: 'tenant-1', userId: 'user-8', skill: 'expo' },
            { tenantId: 'tenant-1', userId: 'user-8', skill: 'grill cook' },
        ] });
        const invalidationQuery = prisma.$queryRaw.mock.calls[2][0];
        const invalidationSql = invalidationQuery.strings.join(' ');
        expect(invalidationSql).toContain('FROM "Schedule" schedule');
        expect(invalidationSql).toContain('schedule."status" = \'DRAFT\'');
        expect(invalidationSql).toContain('schedule."tenantId"');
        expect(invalidationSql).toContain('schedule."locationId"');
        expect(invalidationSql).toContain('generate_series');
        expect(invalidationSql).toContain('EXTRACT(DOW FROM local_day)');
        expect(invalidationSql).toContain('ORDER BY schedule."id" ASC');
        expect(invalidationSql).toContain('FOR UPDATE OF schedule');
        expect(invalidationQuery.values).toEqual(expect.arrayContaining(['tenant-1', 'loc-1', 5, 6]));

        expect(prisma.staffAvailability.createMany).toHaveBeenCalledWith({ data: [{
            tenantId: 'tenant-1',
            userId: 'user-8',
            locationId: 'loc-1',
            dayOfWeek: 5,
            startTimeMinutes: 1320,
            endTimeMinutes: 120,
        }] });
        expect(prisma.staffAvailability.deleteMany.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.staffAvailability.createMany.mock.invocationCallOrder[0]);
        expect(prisma.staffSkill.deleteMany.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.staffSkill.createMany.mock.invocationCallOrder[0]);
    });
    it('invalidates every tenant draft when a schedulable staff skill changes', async () => {
        prisma.$queryRaw
            .mockResolvedValueOnce([{ id: 'user-8', role: 'MANAGER' }])
            .mockResolvedValueOnce([{ id: 'sch-1' }, { id: 'sch-2' }]);

        await controller.replaceSchedulingProfile('user-8', {
            skills: ['expo'],
            availability: [],
        }, { user: { tenantId: 'tenant-1' } });

        const invalidationQuery = prisma.$queryRaw.mock.calls[1][0];
        const invalidationSql = invalidationQuery.strings.join(' ');
        expect(invalidationSql).toContain('schedule."tenantId"');
        expect(invalidationSql).toContain('schedule."status" = \'DRAFT\'');
        expect(invalidationSql).not.toContain('generate_series');
        expect(prisma.schedule.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['sch-1', 'sch-2'] },
                tenantId: 'tenant-1',
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
    });

    it('does not invalidate drafts when normalized scheduling inputs are unchanged', async () => {
        prisma.staffSkill.findMany.mockResolvedValue([{ skill: 'expo' }]);
        prisma.staffAvailability.findMany.mockResolvedValue([{
            locationId: null,
            dayOfWeek: 1,
            startTimeMinutes: 540,
            endTimeMinutes: 1020,
        }]);
        prisma.$queryRaw.mockResolvedValueOnce([{ id: 'user-8', role: 'STAFF' }]);

        await controller.replaceSchedulingProfile('user-8', {
            skills: ['EXPO'],
            availability: [{
                locationId: null,
                dayOfWeek: 1,
                startTimeMinutes: 540,
                endTimeMinutes: 1020,
            }],
        }, { user: { tenantId: 'tenant-1' } });

        expect(prisma.$queryRaw).toHaveBeenCalledOnce();
        expect(prisma.schedule.updateMany).not.toHaveBeenCalled();
    });


    it('rejects inactive or cross-tenant locations before replacing rows', async () => {
        prisma.$queryRaw
            .mockResolvedValueOnce([{ id: 'user-8' }])
            .mockResolvedValueOnce([]);

        await expect(controller.replaceSchedulingProfile('user-8', {
            skills: ['expo'],
            availability: [{
                locationId: 'loc-foreign',
                dayOfWeek: 1,
                startTimeMinutes: 540,
                endTimeMinutes: 1020,
            }],
        }, { user: { tenantId: 'tenant-1' } })).rejects.toThrow(
            'Every availability location must be an active tenant location',
        );
        expect(prisma.staffAvailability.deleteMany).not.toHaveBeenCalled();
        expect(prisma.staffSkill.deleteMany).not.toHaveBeenCalled();
    });

    it('permission-guards scheduling profile reads and replacements', () => {
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.schedulingProfile)).toBe('users:read');
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.replaceSchedulingProfile)).toBe('users:write');
    });
});
