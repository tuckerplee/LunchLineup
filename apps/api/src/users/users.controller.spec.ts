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
            user: {
                create: vi.fn(),
                findFirst: vi.fn(),
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
