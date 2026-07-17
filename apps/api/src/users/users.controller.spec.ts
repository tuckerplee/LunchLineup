import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ALLOW_AUTHENTICATED_METADATA_KEY } from '../auth/require-permission.decorator';
import { PERMISSION_METADATA_KEY } from '../auth/require-permission.decorator';
import { UsersController } from './users.controller';
import { decodeBoundedListCursor, encodeBoundedListCursor } from '../common/bounded-pagination';
import { MAX_ROLES_PER_USER } from '../auth/rbac.service';
import { ProductionExceptionFilter } from '../common/production-exception.filter';

const mockAuthService = {
    buildPinCredentialData: vi.fn(),
    resetUserPinAsAdmin: vi.fn(),
    rotateOwnPin: vi.fn(),
};

const mockRbacService = {
    ensureTenantRoles: vi.fn(),
    listPermissions: vi.fn(),
    listRolesForTenant: vi.fn(),
    assignRolesToUser: vi.fn(),
    assignRolesToUserInTransaction: vi.fn(),
    getUserRoleAssignments: vi.fn(),
    replaceUserRolesAsActor: vi.fn(),
    authorizeUserAdministrationInTransaction: vi.fn(),
    authorizeUserInvitationInTransaction: vi.fn(),
    getEffectiveAccess: vi.fn(),
    createRole: vi.fn(),
    updateRole: vi.fn(),
    deleteRole: vi.fn(),
};
const mockStaffInvitationOutbox = {
    enqueueInTransaction: vi.fn(),
    statusInTransaction: vi.fn(),
    retryInTransaction: vi.fn(),
    reissueInTransaction: vi.fn(),
    toResponse: vi.fn(),
    notApplicable: vi.fn(),
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
            sessionId: 'session-1',
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

function productionFilterResponse(error: unknown) {
    const response = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
    };
    const host = {
        switchToHttp: () => ({
            getRequest: () => ({
                method: 'POST',
                originalUrl: '/api/v1/users/roles',
                correlationId: 'role-create-test',
            }),
            getResponse: () => response,
        }),
    };
    new ProductionExceptionFilter().catch(error, host as any);
    return {
        status: response.status.mock.calls[0][0] as number,
        body: response.json.mock.calls[0][0] as Record<string, unknown>,
    };
}

describe('UsersController', () => {
    let controller: UsersController;
    let prisma: any;
    let tenantDb: any;

    beforeEach(() => {
        vi.resetAllMocks();
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
        mockRbacService.authorizeUserAdministrationInTransaction.mockImplementation(
            async (_tx: unknown, _tenantId: string, request: any) => ({
                id: request.targetUserId,
                role: 'STAFF',
                username: null,
                name: 'Target user',
                email: null,
                suspendedAt: null,
            }),
        );
        mockRbacService.authorizeUserInvitationInTransaction.mockImplementation(
            async (_tx: unknown, _tenantId: string, request: any) => {
                const roles = await mockRbacService.listRolesForTenant('tenant-1');
                return roles.find((role: any) => request.requestedRoleId
                    ? role.id === request.requestedRoleId
                    : role.legacyRole === request.requestedLegacyRole) ?? roles[0];
            },
        );
        mockRbacService.deleteRole.mockResolvedValue(true);
        mockStaffInvitationOutbox.enqueueInTransaction.mockResolvedValue({
            id: 'outbox-1',
            status: 'PENDING',
            attempts: 0,
        });
        mockStaffInvitationOutbox.toResponse.mockReturnValue({
            status: 'queued',
            attempts: 0,
            canRetry: false,
            canReissue: false,
        });
        mockStaffInvitationOutbox.notApplicable.mockReturnValue({
            status: 'not_applicable',
            attempts: 0,
            canRetry: false,
            canReissue: false,
        });
        mockRbacService.replaceUserRolesAsActor.mockImplementation(async (tenantId: string, request: any) => {
            if (request.legacyRole) {
                await prisma.user.updateMany({
                    where: { id: request.targetUserId, tenantId },
                    data: { role: request.legacyRole },
                });
                await mockRbacService.assignRolesToUserInTransaction(
                    prisma,
                    request.targetUserId,
                    tenantId,
                    [`role-${request.legacyRole.toLowerCase()}`],
                );
            } else {
                await mockRbacService.assignRolesToUser(request.targetUserId, tenantId, request.roleIds ?? []);
            }
            return {
                legacyRole: request.legacyRole ?? 'STAFF',
                assignedRoles: request.legacyRole
                    ? [{ id: 'role-staff', name: 'Staff', permissions: ['auth:login_pin'] }]
                    : (request.roleIds ?? []).map((id: string) => ({ id, name: id, permissions: [] })),
                changed: true,
                sessionsRevoked: 1,
            };
        });
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
                deleteMany: vi.fn(),
            },
            passwordResetEmailOutbox: {
                updateMany: vi.fn(),
                deleteMany: vi.fn(),
            },
            staffInvitationOutbox: {
                updateMany: vi.fn(),
            },
            availabilityImportJob: {
                updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            onboardingSignupAttempt: {
                deleteMany: vi.fn(),
            },
            notificationOutbox: {
                deleteMany: vi.fn(),
            },
            notification: {
                deleteMany: vi.fn(),
            },
            mfaTotpClaim: {
                deleteMany: vi.fn(),
            },
            roleAssignment: {
                findMany: vi.fn(),
                deleteMany: vi.fn(),
            },
            refreshTokenReplay: {
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
            $executeRaw: vi.fn().mockResolvedValue(0),
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
        mockAuthService.resetUserPinAsAdmin.mockResolvedValue({ username: 'crewlead' });
        controller = new UsersController(mockAuthService as any, mockRbacService as any, mockStaffInvitationOutbox as any, tenantDb);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('loads one user page and its role assignments in bounded tenant detail queries', async () => {
        prisma.user.findMany.mockResolvedValue([
            {
                id: 'user-1',
                name: 'Ada',
                email: 'ada@example.test',
                username: 'ada',
                role: 'MANAGER',
                pinHash: 'hash',
                pinResetRequired: false,
            },
            {
                id: 'user-2',
                name: 'Grace',
                email: null,
                username: 'grace',
                role: 'STAFF',
                pinHash: null,
                pinResetRequired: true,
            },
        ]);
        prisma.roleAssignment.findMany.mockResolvedValue([
            {
                userId: 'user-1',
                role: {
                    id: 'role-manager',
                    name: 'Manager\r\nOperations',
                    description: null,
                    isSystem: true,
                    legacyRole: 'MANAGER',
                    rolePermissions: [
                        { permission: { key: 'shifts:write' } },
                        { permission: { key: 'dashboard:access' } },
                    ],
                },
            },
            {
                userId: 'user-2',
                role: {
                    id: 'role-staff',
                    name: 'Staff',
                    description: 'Staff access',
                    isSystem: true,
                    legacyRole: 'STAFF',
                    rolePermissions: [{ permission: { key: 'dashboard:access' } }],
                },
            },
        ]);

        const result = await controller.findAll({ user: { tenantId: 'tenant-1' } });

        expect(mockRbacService.ensureTenantRoles).toHaveBeenCalledWith('tenant-1');
        expect(prisma.user.findMany).toHaveBeenCalledOnce();
        expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId: 'tenant-1', deletedAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 101,
        }));
        expect(prisma.roleAssignment.findMany).toHaveBeenCalledOnce();
        expect(mockRbacService.getUserRoleAssignments).not.toHaveBeenCalled();
        expect(result.data).toEqual([
            expect.objectContaining({
                id: 'user-1',
                pinEnabled: true,
                assignedRoles: [expect.objectContaining({
                    id: 'role-manager',
                    name: 'Manager Operations',
                    permissions: ['dashboard:access', 'shifts:write'],
                })],
            }),
            expect.objectContaining({
                id: 'user-2',
                pinEnabled: false,
                pinResetRequired: true,
                assignedRoles: [expect.objectContaining({
                    id: 'role-staff',
                    permissions: ['dashboard:access'],
                })],
            }),
        ]);
    });

    it('uses a tenant-scoped createdAt/id cursor and loads assignments only for the visible page', async () => {
        const firstCreatedAt = new Date('2026-07-14T10:00:00.000Z');
        const secondCreatedAt = new Date('2026-07-14T10:00:01.000Z');
        const incomingCursor = encodeBoundedListCursor(
            new Date('2026-07-14T09:59:00.000Z'),
            'user-before',
        );
        prisma.user.findMany.mockResolvedValue([
            {
                id: 'user-visible',
                createdAt: firstCreatedAt,
                name: 'Visible Person',
                email: 'visible@example.test',
                username: 'visible',
                role: 'STAFF',
                pinHash: 'sensitive-hash',
                pinResetRequired: false,
            },
            {
                id: 'user-sentinel',
                createdAt: secondCreatedAt,
                name: 'Sentinel Person',
                email: 'sentinel@example.test',
                username: null,
                role: 'MANAGER',
                pinHash: null,
                pinResetRequired: false,
            },
        ]);
        prisma.roleAssignment.findMany.mockResolvedValue([]);

        const result = await controller.findAll(
            { user: { tenantId: 'tenant-1' } },
            undefined,
            '1',
            incomingCursor,
        );

        expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                tenantId: 'tenant-1',
                deletedAt: null,
                OR: [
                    { createdAt: { gt: new Date('2026-07-14T09:59:00.000Z') } },
                    {
                        createdAt: new Date('2026-07-14T09:59:00.000Z'),
                        id: { gt: 'user-before' },
                    },
                ],
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 2,
        }));
        expect(prisma.roleAssignment.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                tenantId: 'tenant-1',
                userId: { in: ['user-visible'] },
            }),
        }));
        expect(result.data).toHaveLength(1);
        expect(result.data[0]).not.toHaveProperty('createdAt');
        expect(result.data[0]).not.toHaveProperty('pinHash');
        expect(result.pagination).toMatchObject({
            limit: 1,
            returned: 1,
            hasMore: true,
        });
        expect(decodeBoundedListCursor(result.pagination.nextCursor)).toEqual({
            timestamp: firstCreatedAt,
            id: 'user-visible',
        });
        const cursorPayload = Buffer.from(result.pagination.nextCursor ?? '', 'base64url').toString('utf8');
        expect(cursorPayload).not.toContain('Visible Person');
        expect(cursorPayload).not.toContain('visible@example.test');
        expect(cursorPayload).not.toContain('sensitive-hash');
    });

    it('rejects invalid directory pagination before querying tenant users', async () => {
        await expect(controller.findAll(
            { user: { tenantId: 'tenant-1' } },
            undefined,
            '0',
        )).rejects.toThrow('Invalid limit');
        await expect(controller.findAll(
            { user: { tenantId: 'tenant-1' } },
            undefined,
            '50',
            'not-a-cursor',
        )).rejects.toThrow('Invalid cursor');
        expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('includes PII-free aggregate totals on the initial bounded directory page', async () => {
        prisma.user.findMany.mockResolvedValue([]);
        prisma.$queryRaw.mockResolvedValueOnce([{
            totalUsers: 24n,
            staffCount: 20n,
            managerCount: 4n,
            privilegedUsers: 3n,
            pinAccounts: 12n,
        }]);

        const result = await controller.findAll({
            user: { tenantId: 'tenant-1' },
        }, undefined, '1');
        expect(result.summary).toEqual({
            totalUsers: 24,
            staffCount: 20,
            managerCount: 4,
            privilegedUsers: 3,
            pinAccounts: 12,
        });

        const query = prisma.$queryRaw.mock.calls[0][0];
        const sql = query.strings.join('?');
        expect(sql).toContain('user_row."tenantId"');
        expect(sql).toContain('user_row."deletedAt" IS NULL');
        expect(sql).toContain('COUNT(*) FILTER');
        expect(sql).toContain("permission.\"key\" IN ('roles:assign', 'users:admin')");
        expect(query.values).toEqual(['tenant-1']);
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.findAll)).toBe('users:read');
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
        const generatedPin = mockAuthService.buildPinCredentialData.mock.calls[0]?.[0] as string;

        expect(generatedPin).toMatch(/^\d{6}$/);
        expect(mockAuthService.buildPinCredentialData).toHaveBeenCalledWith(generatedPin, true, expect.any(Date));
        expect(prisma.user.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ pinHash: `hash:${generatedPin}`, pinResetRequired: true }),
        });
        expect(mockAuthService.resetUserPinAsAdmin).not.toHaveBeenCalled();
        expect(result.username).toBe('shiftlead');
        expect(result.temporaryPin).toBe(generatedPin);
        expect(result.pinResetRequired).toBe(true);
        expect(mockRbacService.assignRolesToUserInTransaction).toHaveBeenCalledWith(
            prisma,
            'user-1',
            'tenant-1',
            ['role-staff'],
        );
        expect(mockRbacService.authorizeUserInvitationInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            {
                actorUserId: 'admin-1',
                actorSessionId: 'session-1',
                targetUserId: undefined,
                requestedRoleId: undefined,
                requestedLegacyRole: 'STAFF',
            },
        );
        expect(mockRbacService.authorizeUserInvitationInTransaction.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.user.create.mock.invocationCallOrder[0]);
        expect(prisma.user.create.mock.invocationCallOrder[0])
            .toBeLessThan(mockRbacService.assignRolesToUserInTransaction.mock.invocationCallOrder[0]);
        expect(result.invitationDelivery).toEqual({
            status: 'not_applicable',
            attempts: 0,
            canRetry: false,
            canReissue: false,
        });
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

        expect(mockAuthService.resetUserPinAsAdmin).not.toHaveBeenCalled();
        expect(result.email).toBe('manager@company.com');
        expect(result.temporaryPin).toBe(null);
        expect(result.invitationDelivery).toEqual({
            status: 'queued',
            attempts: 0,
            canRetry: false,
            canReissue: false,
        });
        expect(mockStaffInvitationOutbox.enqueueInTransaction).toHaveBeenCalledWith(prisma, {
            tenantId: 'tenant-1',
            userId: 'user-2',
            recipient: 'manager@company.com',
        });
    });

    it('rolls back an email invite when durable delivery intent creation fails', async () => {
        prisma.user.create.mockResolvedValue({
            id: 'user-rollback',
            email: 'rollback@example.com',
            username: null,
            name: 'Rollback User',
            role: 'STAFF',
            pinHash: null,
        });
        mockStaffInvitationOutbox.enqueueInTransaction.mockRejectedValueOnce(
            new Error('durable outbox unavailable'),
        );

        await expect(controller.invite(
            { name: 'Rollback User', email: 'rollback@example.com', role: 'STAFF' },
            inviteRequest(),
        )).rejects.toThrow('durable outbox unavailable');

        expect(mockRbacService.assignRolesToUserInTransaction).toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(tenantDb.withTenant).toHaveBeenCalledWith(
            'tenant-1',
            expect.any(Function),
            { isolationLevel: 'Serializable' },
        );
    });

    it('retries the whole invitation transaction once without duplicating writes or audit', async () => {
        prisma.user.create.mockResolvedValue({
            id: 'user-retried',
            email: 'retried@example.com',
            username: null,
            name: 'Retried User',
            role: 'STAFF',
            pinHash: null,
        });
        tenantDb.withTenant.mockRejectedValueOnce({ code: 'P2034' });

        await expect(controller.invite(
            { name: 'Retried User', email: 'retried@example.com', role: 'STAFF' },
            inviteRequest(),
        )).resolves.toMatchObject({ id: 'user-retried' });

        expect(tenantDb.withTenant).toHaveBeenCalledTimes(2);
        expect(mockRbacService.authorizeUserInvitationInTransaction).toHaveBeenCalledOnce();
        expect(prisma.user.create).toHaveBeenCalledOnce();
        expect(mockRbacService.assignRolesToUserInTransaction).toHaveBeenCalledOnce();
        expect(mockStaffInvitationOutbox.enqueueInTransaction).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('returns tenant-scoped invitation status and idempotent retry contracts', async () => {
        mockStaffInvitationOutbox.statusInTransaction.mockResolvedValueOnce({
            status: 'failed',
            attempts: 2,
            canRetry: true,
            canReissue: false,
        });
        mockStaffInvitationOutbox.retryInTransaction.mockResolvedValueOnce({
            status: 'queued',
            attempts: 2,
            canRetry: false,
            canReissue: false,
        });
        mockStaffInvitationOutbox.reissueInTransaction.mockResolvedValueOnce({
            deliveryId: 'reissued-outbox',
            status: 'queued',
            attempts: 0,
            canRetry: false,
            canReissue: false,
        });

        await expect(controller.invitationStatus('user-2', {
            user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' },
        })).resolves.toEqual({
            invitationDelivery: {
                status: 'failed',
                attempts: 2,
                canRetry: true,
                canReissue: false,
            },
        });
        await expect(controller.retryInvitation('user-2', {
            user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' },
        })).resolves.toEqual({
            invitationDelivery: {
                status: 'queued',
                attempts: 2,
                canRetry: false,
                canReissue: false,
            },
        });
        await expect(controller.reissueInvitation('user-2', {
            user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' },
        }, 'reissue-key-1')).resolves.toEqual({
            invitationDelivery: {
                deliveryId: 'reissued-outbox',
                status: 'queued',
                attempts: 0,
                canRetry: false,
                canReissue: false,
            },
        });

        expect(mockStaffInvitationOutbox.statusInTransaction)
            .toHaveBeenCalledWith(prisma, 'tenant-1', 'user-2');
        expect(mockRbacService.authorizeUserAdministrationInTransaction).toHaveBeenNthCalledWith(
            1,
            prisma,
            'tenant-1',
            {
                actorUserId: 'admin-1',
                actorSessionId: 'session-1',
                targetUserId: 'user-2',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'You cannot retry your own invitation delivery',
            },
        );
        expect(mockRbacService.authorizeUserAdministrationInTransaction).toHaveBeenNthCalledWith(
            2,
            prisma,
            'tenant-1',
            {
                actorUserId: 'admin-1',
                actorSessionId: 'session-1',
                targetUserId: 'user-2',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'You cannot reissue your own invitation delivery',
            },
        );
        expect(mockStaffInvitationOutbox.retryInTransaction).toHaveBeenCalledWith(prisma, {
            tenantId: 'tenant-1',
            userId: 'user-2',
            actorUserId: 'admin-1',
        });
        expect(mockStaffInvitationOutbox.reissueInTransaction).toHaveBeenCalledWith(prisma, {
            tenantId: 'tenant-1',
            userId: 'user-2',
            actorUserId: 'admin-1',
            idempotencyKey: 'reissue-key-1',
        });
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.invitationStatus))
            .toBe('users:admin');
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.retryInvitation))
            .toBe('users:admin');
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.reissueInvitation))
            .toBe('users:admin');

    });

    it.each([
        ['revoked exact session', new ForbiddenException('Administrator session is no longer active')],
        ['demoted actor', new ForbiddenException('users:admin permission is no longer active for this account')],
        ['promoted dual-source target', new ForbiddenException('Only system admins can administer system admins')],
    ])('denies invitation retry and reissue for a %s before outbox or audit writes', async (_label, error) => {
        mockRbacService.authorizeUserAdministrationInTransaction.mockRejectedValue(error);
        const request = { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } };

        await expect(controller.retryInvitation('user-2', request)).rejects.toBe(error);
        await expect(controller.reissueInvitation('user-2', request, 'reissue-key')).rejects.toBe(error);

        expect(mockStaffInvitationOutbox.retryInTransaction).not.toHaveBeenCalled();
        expect(mockStaffInvitationOutbox.reissueInTransaction).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it.each(['retry', 'reissue'] as const)(
        'retries one invitation %s conflict and maps two conflicts without duplicate writes',
        async (operation) => {
            const request = { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } };
            tenantDb.withTenant.mockRejectedValueOnce({ code: 'P2034' });

            if (operation === 'retry') {
                await expect(controller.retryInvitation('user-2', request)).resolves.toBeDefined();
                expect(mockStaffInvitationOutbox.retryInTransaction).toHaveBeenCalledOnce();
            } else {
                await expect(controller.reissueInvitation('user-2', request, 'reissue-key')).resolves.toBeDefined();
                expect(mockStaffInvitationOutbox.reissueInTransaction).toHaveBeenCalledOnce();
            }
            expect(mockRbacService.authorizeUserAdministrationInTransaction).toHaveBeenCalledOnce();

            vi.clearAllMocks();
            tenantDb.withTenant
                .mockRejectedValueOnce({ code: 'P2034' })
                .mockRejectedValueOnce({ code: 'P2034' });
            const denied = operation === 'retry'
                ? controller.retryInvitation('user-2', request)
                : controller.reissueInvitation('user-2', request, 'reissue-key');
            await expect(denied).rejects.toBeInstanceOf(ConflictException);
            expect(tenantDb.withTenant).toHaveBeenCalledTimes(2);
            expect(mockStaffInvitationOutbox.retryInTransaction).not.toHaveBeenCalled();
            expect(mockStaffInvitationOutbox.reissueInTransaction).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );
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
        expect(mockAuthService.resetUserPinAsAdmin).not.toHaveBeenCalled();
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
        expect(mockAuthService.resetUserPinAsAdmin).not.toHaveBeenCalled();
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
        expect(mockAuthService.resetUserPinAsAdmin).not.toHaveBeenCalled();
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
        expect(mockAuthService.resetUserPinAsAdmin).not.toHaveBeenCalled();
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
        expect(mockAuthService.resetUserPinAsAdmin).not.toHaveBeenCalled();
    });

    it('rejects an invite role containing permissions the caller does not hold', async () => {
        mockRbacService.authorizeUserInvitationInTransaction.mockRejectedValueOnce(
            new ForbiddenException('Cannot grant a role with permissions you do not hold'),
        );
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
        const result = await controller.resetUserPin(
            'user-3',
            {},
            {
                user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' },
                ip: '203.0.113.61',
                headers: { 'user-agent': 'Users Controller PIN Reset' },
            },
        );
        const generatedPin = mockAuthService.resetUserPinAsAdmin.mock.calls[0]?.[1] as string;

        expect(generatedPin).toMatch(/^\d{6}$/);
        expect(mockAuthService.resetUserPinAsAdmin).toHaveBeenCalledWith(
            'user-3',
            generatedPin,
            'tenant-1',
            'admin-1',
            'session-1',
            { ipAddress: '203.0.113.61', userAgent: 'Users Controller PIN Reset' },
        );
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(result).toEqual({
            id: 'user-3',
            username: 'crewlead',
            temporaryPin: generatedPin,
            pinResetRequired: true,
        });
    });

    it.each([
        ['manager versus admin'],
        ['admin versus super admin'],
        ['same-rank admin'],
        ['target with an unheld permission'],
        ['stale super-admin row'],
    ] as const)('propagates the transaction-owned %s PIN reset denial without a controller preflight', async () => {
        const actorId = 'actor-1';
        const targetId = 'target-1';
        mockAuthService.resetUserPinAsAdmin.mockRejectedValueOnce(
            new ForbiddenException('Cannot administer an account with equal or greater access'),
        );

        await expect(controller.resetUserPin(
            targetId,
            {},
            { user: { tenantId: 'tenant-1', sub: actorId, sessionId: 'session-1' } },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockAuthService.resetUserPinAsAdmin).toHaveBeenCalledOnce();
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('allows a true system super admin to reset another non-self super admin', async () => {
        mockAuthService.resetUserPinAsAdmin.mockResolvedValueOnce({ username: 'platform.owner' });

        await expect(controller.resetUserPin(
            'target-super',
            {},
            { user: { tenantId: 'tenant-1', sub: 'system-super', sessionId: 'session-1' } },
        )).resolves.toEqual(expect.objectContaining({
            id: 'target-super',
            pinResetRequired: true,
        }));
        const generatedPin = mockAuthService.resetUserPinAsAdmin.mock.calls[0]?.[1] as string;

        expect(generatedPin).toMatch(/^\d{6}$/);
        expect(mockAuthService.resetUserPinAsAdmin).toHaveBeenCalledWith(
            'target-super',
            generatedPin,
            'tenant-1',
            'system-super',
            'session-1',
            { ipAddress: null, userAgent: null },
        );
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
    });

    it('blocks self reset through the admin route', async () => {
        mockAuthService.resetUserPinAsAdmin.mockRejectedValueOnce(
            new ForbiddenException('Use the self-service PIN rotation route for your own account'),
        );
        await expect(controller.resetUserPin(
            'admin-1',
            {},
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.getEffectiveAccess).not.toHaveBeenCalled();
        expect(mockAuthService.resetUserPinAsAdmin).toHaveBeenCalledOnce();
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
    });

    it('delegates self PIN rotation to AuthService', async () => {
        mockAuthService.rotateOwnPin.mockResolvedValue(undefined);

        const result = await controller.rotateOwnPin(
            {
                user: { sub: 'user-4', tenantId: 'tenant-1', sessionId: 'session-1' },
                ip: '203.0.113.62',
                headers: { 'user-agent': ['Users Controller PIN Rotation'] },
            },
            { currentPin: '1234', newPin: '5678' },
        );

        expect(mockAuthService.rotateOwnPin).toHaveBeenCalledWith(
            'user-4',
            '1234',
            '5678',
            'tenant-1',
            'session-1',
            { ipAddress: '203.0.113.62', userAgent: 'Users Controller PIN Rotation' },
        );
        expect(result).toEqual({ success: true });
    });

    it('marks self PIN rotation as authenticated-only instead of permission-gated', () => {
        const method = UsersController.prototype.rotateOwnPin;

        expect(Reflect.getMetadata(ALLOW_AUTHENTICATED_METADATA_KEY, method)).toBe(true);
    });

    it('rejects non-system admin invites into system admin access', async () => {
        mockRbacService.authorizeUserInvitationInTransaction.mockRejectedValueOnce(
            new ForbiddenException('Only system admins can grant system admin access'),
        );
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
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['users:write'] } },
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
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('Only system admins can grant system admin access'));
        await expect(
            controller.updateRole(
                'user-7',
                { role: 'SUPER_ADMIN' },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['users:admin'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('delegates stale SUPER_ADMIN claims to the live transactional authority check', async () => {
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(
            new ForbiddenException('Only system admins can grant system admin access'),
        );
        const request = {
            user: {
                tenantId: 'tenant-1',
                sub: 'stale-super',
                sessionId: 'session-1',
                legacyRole: 'SUPER_ADMIN',
                permissions: ['roles:assign', 'admin_portal:access'],
                roles: [{ isSystem: true, legacyRole: 'SUPER_ADMIN' }],
            },
        };

        await expect(controller.updateUserAccess(
            'lower-user',
            { roleIds: ['role-super'] },
            request,
        )).rejects.toThrow('Only system admins can grant system admin access');

        expect(mockRbacService.replaceUserRolesAsActor).toHaveBeenCalledWith('tenant-1', {
            actorUserId: 'stale-super',
            actorSessionId: 'session-1',
            targetUserId: 'lower-user',
            roleIds: ['role-super'],
            requiredPermission: 'roles:assign',
            selfMutationMessage: 'You cannot change your own access roles',
            auditAction: 'USER_ACCESS_UPDATED',
        });
    });

    it('rejects changing the caller own role before resolving or mutating the replacement role', async () => {
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('You cannot change your own role'));
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
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('Cannot administer an account with equal or greater access'));
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
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('Cannot administer an account with equal or greater access'));
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
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('Cannot administer an account with equal or greater access'));
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
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('Only system admins can grant system admin access'));
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
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:assign'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('rejects non-system admin assignment of tenant lifecycle roles', async () => {
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('Only system admins can grant system admin access'));
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
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:assign'] } },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('rejects role assignment requests with role ids outside the tenant', async () => {
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new Error('One or more roles are invalid for this tenant'));
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
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:assign'] } },
            ),
        ).rejects.toThrow('One or more roles are invalid for this tenant');

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('rejects role assignment containing permissions the caller does not hold', async () => {
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('Cannot grant a role with permissions you do not hold'));
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
                    sessionId: 'session-1',
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
                    sessionId: 'session-1',
                    legacyRole: 'MANAGER',
                    permissions: ['roles:assign', 'dashboard:access'],
                    roles: [{ legacyRole: 'MANAGER' }],
                },
            },
        );

        expect(mockRbacService.assignRolesToUser).toHaveBeenCalledWith('user-8', 'tenant-1', ['role-staff']);
    });

    it('passes exactly the supported role assignment maximum to the transactional boundary', async () => {
        const roleIds = Array.from({ length: MAX_ROLES_PER_USER }, (_, index) => `role-${index + 1}`);

        await controller.updateUserAccess(
            'user-8',
            { roleIds },
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        );

        expect(mockRbacService.replaceUserRolesAsActor).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
            targetUserId: 'user-8',
            roleIds,
        }));
    });

    it('rejects one role above the supported assignment maximum before the service boundary', async () => {
        const roleIds = Array.from({ length: MAX_ROLES_PER_USER + 1 }, (_, index) => `role-${index + 1}`);

        await expect(controller.updateUserAccess(
            'user-8',
            { roleIds },
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        )).rejects.toBeInstanceOf(BadRequestException);

        expect(mockRbacService.replaceUserRolesAsActor).not.toHaveBeenCalled();
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
                    sessionId: 'session-1',
                    legacyRole: 'SUPER_ADMIN',
                    permissions: ['roles:assign', 'admin_portal:access'],
                    roles: [{ legacyRole: 'SUPER_ADMIN' }],
                },
            },
        );

        expect(mockRbacService.assignRolesToUser).toHaveBeenCalledWith('user-8', 'tenant-1', ['role-super']);
    });

    it('rejects changing the caller own role assignments', async () => {
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('You cannot change your own access roles'));
        await expect(controller.updateUserAccess(
            'admin-1',
            { roleIds: [] },
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        )).rejects.toThrow('You cannot change your own access roles');

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('rejects a lower-privilege role administrator changing a tenant owner', async () => {
        mockRbacService.replaceUserRolesAsActor.mockRejectedValueOnce(new ForbiddenException('Cannot administer an account with equal or greater access'));
        await expect(controller.updateUserAccess(
            'owner-1',
            { roleIds: [] },
            { user: { tenantId: 'tenant-1', sub: 'manager-1', sessionId: 'session-1' } },
        )).rejects.toThrow('Cannot administer an account with equal or greater access');

        expect(mockRbacService.assignRolesToUser).not.toHaveBeenCalled();
    });

    it('irreversibly anonymizes a tenant-owned user and invalidates authentication material', async () => {
        prisma.user.updateMany.mockResolvedValue({ count: 1 });
        prisma.$queryRaw.mockResolvedValue([]);

        await controller.deactivate('user-9', { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } });

        expect(mockRbacService.authorizeUserAdministrationInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            {
                actorUserId: 'admin-1',
                actorSessionId: 'session-1',
                targetUserId: 'user-9',
                requiredPermission: 'users:admin',
                selfMutationMessage: 'You cannot deactivate your own account',
            },
        );
        expect(mockRbacService.authorizeUserAdministrationInTransaction.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.user.updateMany.mock.invocationCallOrder[0]);
        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: 'user-9', tenantId: 'tenant-1', deletedAt: null },
            data: expect.objectContaining({
                name: 'Deleted user',
                email: null,
                username: null,
                phone: null,
                oidcIssuer: null,
                oidcSubject: null,
                passwordHash: null,
                pinHash: null,
                mfaEnabled: false,
                mfaSecret: null,
                mfaBackupCodes: [],
                emailDeliverySuppressedAt: null,
                emailDeliverySuppressionReason: null,
                emailDeliveryLastEventAt: null,
                deletedAt: expect.any(Date),
            }),
        });
        expect(prisma.refreshTokenReplay.deleteMany).toHaveBeenCalledWith({
            where: { session: { userId: 'user-9' } },
        });
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
        expect(prisma.passwordResetEmailOutbox.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'user-9' },
        });
        expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'user-9' },
        });
        expect(prisma.mfaTotpClaim.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'user-9' },
        });
        expect(prisma.roleAssignment.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'user-9' },
        });
        expect(prisma.onboardingSignupAttempt.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'user-9' },
        });
        expect(prisma.notificationOutbox.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'user-9' },
        });
        expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'user-9' },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'admin-1',
                actorUserId: 'admin-1',
                actorTenantId: 'tenant-1',
                action: 'USER_DELETED',
                resource: 'User',
                resourceId: 'user-9',
            },
        });
    });

    it('does not revoke sessions when deactivation target is outside the tenant', async () => {
        mockRbacService.authorizeUserAdministrationInTransaction.mockRejectedValueOnce(
            new Error('User not found'),
        );
        await expect(controller.deactivate(
            'user-foreign',
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        )).rejects.toThrow('User not found');

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('rejects self-deactivation before mutating the account', async () => {
        mockRbacService.authorizeUserAdministrationInTransaction.mockRejectedValueOnce(
            new ForbiddenException('You cannot deactivate your own account'),
        );
        await expect(controller.deactivate(
            'admin-1',
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        )).rejects.toThrow('You cannot deactivate your own account');

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a lower-privilege user administrator deactivating a tenant owner', async () => {
        mockRbacService.authorizeUserAdministrationInTransaction.mockRejectedValueOnce(
            new ForbiddenException('Cannot administer an account with equal or greater access'),
        );

        await expect(controller.deactivate(
            'owner-1',
            { user: { tenantId: 'tenant-1', sub: 'manager-1', sessionId: 'session-1' } },
        )).rejects.toThrow('Cannot administer an account with equal or greater access');

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('retries one deactivation conflict, maps two conflicts, and does not mask unrelated failures', async () => {
        prisma.$queryRaw.mockResolvedValue([]);
        prisma.user.updateMany.mockResolvedValue({ count: 1 });
        tenantDb.withTenant.mockRejectedValueOnce({ code: 'P2010', meta: { code: '40001' } });
        await expect(controller.deactivate(
            'user-9',
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        )).resolves.toBeUndefined();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();

        vi.clearAllMocks();
        tenantDb.withTenant
            .mockRejectedValueOnce({ code: 'P2034' })
            .mockRejectedValueOnce({ code: 'P2034' });
        await expect(controller.deactivate(
            'user-9',
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        )).rejects.toBeInstanceOf(ConflictException);
        expect(tenantDb.withTenant).toHaveBeenCalledTimes(2);
        expect(prisma.auditLog.create).not.toHaveBeenCalled();

        const unrelated = { code: 'P2002' };
        tenantDb.withTenant.mockRejectedValueOnce(unrelated);
        await expect(controller.deactivate(
            'user-9',
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        )).rejects.toBe(unrelated);
    });

    it('carries actor identity into custom-role deletion', async () => {
        await controller.deleteAccessRole(
            'role-custom',
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1' } },
        );

        expect(mockRbacService.deleteRole).toHaveBeenCalledWith(
            'tenant-1',
            'role-custom',
            {
                actorUserId: 'admin-1',
                actorSessionId: 'session-1',
                ipAddress: null,
                userAgent: null,
            },
        );
    });

    it('rejects non-system admin custom roles with platform admin permissions', async () => {
        await expect(
            controller.createAccessRole(
                { name: 'Platform Access', permissionKeys: ['admin_portal:access'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
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
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
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
            { user: { tenantId: 'tenant-1', sub: 'owner-1', sessionId: 'session-1', legacyRole: 'SUPER_ADMIN', permissions: ['roles:write'], roles: [{ isSystem: true, legacyRole: 'SUPER_ADMIN' }] } },
        );

        expect(mockRbacService.createRole).toHaveBeenCalledWith(
            'tenant-1',
            { name: 'Platform access', permissionKeys: ['admin_portal:access'] },
            {
                actorUserId: 'owner-1',
                actorSessionId: 'session-1',
                ipAddress: null,
                userAgent: null,
            },
        );
    });

    it.each([
        ['unique constraint', { code: 'P2002' }],
        ['serialization conflict', { code: 'P2034' }],
        ['domain conflict', new ConflictException('Role changed concurrently')],
    ])('classifies only recognized %s failures as a safe 409', async (_label, failure) => {
        mockRbacService.createRole.mockRejectedValue(failure);

        let rejected: unknown;
        try {
            await controller.createAccessRole(
                { name: 'Reader', permissionKeys: ['users:read'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
            );
        } catch (error) {
            rejected = error;
        }

        expect(rejected).toBeInstanceOf(ConflictException);
        expect(productionFilterResponse(rejected)).toMatchObject({
            status: 409,
            body: { statusCode: 409, message: 'Conflict' },
        });
    });

    it('preserves atomic role rollback and safe 500 classification when its audit fails', async () => {
        const secret = 'postgres://admin:super-secret@db.internal/lunchlineup';
        const auditFailure = new Error(`audit unavailable at ${secret}`);
        const committedRoleIds: string[] = [];
        mockRbacService.createRole.mockImplementation(async () => {
            const transactionDraft = [...committedRoleIds, 'role-reader'];
            await Promise.reject(auditFailure);
            committedRoleIds.splice(0, committedRoleIds.length, ...transactionDraft);
        });
        const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        let rejected: unknown;
        try {
            await controller.createAccessRole(
                { name: 'Reader', permissionKeys: ['users:read'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
            );
        } catch (error) {
            rejected = error;
        }

        expect(rejected).toBe(auditFailure);
        expect(committedRoleIds).toEqual([]);
        expect(mockRbacService.createRole).toHaveBeenCalledOnce();
        const filtered = productionFilterResponse(rejected);
        expect(filtered).toMatchObject({
            status: 500,
            body: { statusCode: 500, message: 'Internal server error' },
        });
        expect(JSON.stringify(filtered)).not.toContain('super-secret');
        expect(JSON.stringify(logger.mock.calls)).not.toContain('super-secret');
    });

    it.each([
        [
            'database failure',
            Object.assign(new Error('database unavailable at postgres://admin:db-secret@db.internal/app'), { code: 'P1001' }),
            500,
            'Internal server error',
        ],
        [
            'explicit unavailable failure',
            new ServiceUnavailableException('private provider detail'),
            503,
            'Request failed',
        ],
    ])('preserves safe production classification for a raw %s', async (_label, failure, status, message) => {
        mockRbacService.createRole.mockRejectedValue(failure);
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        let rejected: unknown;
        try {
            await controller.createAccessRole(
                { name: 'Reader', permissionKeys: ['users:read'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
            );
        } catch (error) {
            rejected = error;
        }

        expect(rejected).toBe(failure);
        const filtered = productionFilterResponse(rejected);
        expect(filtered).toMatchObject({
            status,
            body: { statusCode: status, message },
        });
        expect(JSON.stringify(filtered)).not.toContain('private provider detail');
        expect(JSON.stringify(filtered)).not.toContain('db-secret');
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
            { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
        );

        expect(mockRbacService.updateRole).toHaveBeenCalledWith(
            'tenant-1',
            'role-reader',
            { name: 'Reader', permissionKeys: ['users:read'] },
            {
                actorUserId: 'admin-1',
                actorSessionId: 'session-1',
                ipAddress: null,
                userAgent: null,
            },
        );
    });

    it('rejects non-system admin custom roles with tenant lifecycle permissions', async () => {
        await expect(
            controller.createAccessRole(
                { name: 'Tenant Lifecycle', permissionKeys: ['tenant_account:lifecycle'] },
                { user: { tenantId: 'tenant-1', sub: 'admin-1', sessionId: 'session-1', legacyRole: 'ADMIN', permissions: ['roles:write'] } },
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
            where: {
                id: 'user-8',
                tenantId: 'tenant-1',
                deletedAt: null,
                suspendedAt: null,
                role: { in: ['MANAGER', 'STAFF'] },
            },
        }));
        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    });

    it('atomically replaces a normalized scheduling profile after locking active tenant scope', async () => {
        prisma.staffSkill.findMany.mockResolvedValue([
            { skill: 'expo' },
            { skill: 'grill cook' },
        ]);
        prisma.$queryRaw
            .mockResolvedValueOnce([{ id: 'tenant-1' }])
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

        expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
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
        const tenantLockQuery = prisma.$queryRaw.mock.calls[0][0];
        expect(tenantLockQuery.strings.join(' ')).toContain('FROM "Tenant"');
        expect(tenantLockQuery.strings.join(' ')).toContain('FOR UPDATE');
        const schedulingLockOrder = prisma.$executeRaw.mock.invocationCallOrder[0];
        expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(schedulingLockOrder);
        expect(schedulingLockOrder).toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[1]);
        const invalidationQuery = prisma.$queryRaw.mock.calls[3][0];
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
            .mockResolvedValueOnce([{ id: 'tenant-1' }])
            .mockResolvedValueOnce([{ id: 'user-8', role: 'MANAGER' }])
            .mockResolvedValueOnce([{ id: 'sch-1' }, { id: 'sch-2' }]);

        await controller.replaceSchedulingProfile('user-8', {
            skills: ['expo'],
            availability: [],
        }, { user: { tenantId: 'tenant-1' } });

        const invalidationQuery = prisma.$queryRaw.mock.calls[2][0];
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
        prisma.$queryRaw
            .mockResolvedValueOnce([{ id: 'tenant-1' }])
            .mockResolvedValueOnce([{ id: 'user-8', role: 'STAFF' }]);

        await controller.replaceSchedulingProfile('user-8', {
            skills: ['EXPO'],
            availability: [{
                locationId: null,
                dayOfWeek: 1,
                startTimeMinutes: 540,
                endTimeMinutes: 1020,
            }],
        }, { user: { tenantId: 'tenant-1' } });

        expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
        expect(prisma.schedule.updateMany).not.toHaveBeenCalled();
    });


    it('rejects inactive or cross-tenant locations before replacing rows', async () => {
        prisma.$queryRaw
            .mockResolvedValueOnce([{ id: 'tenant-1' }])
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

    it('rejects a suspended or non-schedulable profile target before replacing rows', async () => {
        prisma.$queryRaw
            .mockResolvedValueOnce([{ id: 'tenant-1' }])
            .mockResolvedValueOnce([]);

        await expect(controller.replaceSchedulingProfile('user-admin', {
            skills: ['expo'],
            availability: [],
        }, { user: { tenantId: 'tenant-1' } })).rejects.toThrow('User not found');

        const userLock = prisma.$queryRaw.mock.calls[1][0];
        expect(userLock.strings.join(' ')).toContain(
            '"role" IN (\'MANAGER\'::"UserRole", \'STAFF\'::"UserRole")',
        );
        expect(userLock.strings.join(' ')).toContain('"suspendedAt" IS NULL');
        expect(prisma.staffAvailability.deleteMany).not.toHaveBeenCalled();
        expect(prisma.staffSkill.deleteMany).not.toHaveBeenCalled();
    });

    it('permission-guards scheduling profile reads and replacements', () => {
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.schedulingProfile)).toBe('users:read');
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, controller.replaceSchedulingProfile)).toBe('users:write');
    });
});
