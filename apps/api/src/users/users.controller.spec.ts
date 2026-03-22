import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UsersController } from './users.controller';

const mockAuthService = {
    setUserPin: vi.fn(),
    rotateOwnPin: vi.fn(),
};

describe('UsersController', () => {
    let controller: UsersController;
    let prisma: any;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new UsersController(mockAuthService as any);
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
                count: vi.fn().mockResolvedValue(0),
            },
            auditLog: {
                create: vi.fn(),
            },
        };
        (controller as any).prisma = prisma;
    });

    afterEach(() => {
        vi.restoreAllMocks();
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
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
        );

        expect(mockAuthService.setUserPin).toHaveBeenCalledWith('user-1', '100000', true);
        expect(result.username).toBe('shiftlead');
        expect(result.temporaryPin).toBe('100000');
        expect(result.pinResetRequired).toBe(true);
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
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
        );

        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
        expect(result.email).toBe('manager@company.com');
        expect(result.temporaryPin).toBe(null);
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
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
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
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
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
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
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
            { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
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
                { user: { tenantId: 'tenant-1', sub: 'admin-1' } },
            ),
        ).rejects.toThrow(/User limit reached/i);

        expect(prisma.user.create).not.toHaveBeenCalled();
        expect(mockAuthService.setUserPin).not.toHaveBeenCalled();
    });

    it('resets PIN for username account and returns temporary PIN', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);

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

        expect(mockAuthService.setUserPin).toHaveBeenCalledWith('user-3', '100000', true);
        expect(result).toEqual({
            id: 'user-3',
            username: 'crewlead',
            temporaryPin: '100000',
            pinResetRequired: true,
        });
    });

    it('delegates self PIN rotation to AuthService', async () => {
        mockAuthService.rotateOwnPin.mockResolvedValue(undefined);

        const result = await controller.rotateOwnPin(
            { user: { sub: 'user-4' } },
            { currentPin: '1234', newPin: '5678' },
        );

        expect(mockAuthService.rotateOwnPin).toHaveBeenCalledWith('user-4', '1234', '5678');
        expect(result).toEqual({ success: true });
    });
});
