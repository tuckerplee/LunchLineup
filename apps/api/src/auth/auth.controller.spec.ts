import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';

function createResponseMock() {
    return {
        cookie: vi.fn(),
        redirect: vi.fn(),
        json: vi.fn(),
        clearCookie: vi.fn(),
    } as any;
}

describe('AuthController', () => {
    let controller: AuthController;
    let authService: any;
    let otpService: any;
    let emailService: any;

    beforeEach(() => {
        authService = {
            resolveLoginMethod: vi.fn(),
            loginWithUsernamePin: vi.fn(),
            loginWithEmail: vi.fn(),
            handleOidcCallback: vi.fn(),
            refreshAccessToken: vi.fn(),
            validateMfa: vi.fn(),
            revokeSession: vi.fn(),
        };
        otpService = {
            generateOtp: vi.fn(),
            verifyOtp: vi.fn(),
        };
        emailService = {
            sendOtp: vi.fn(),
        };
        controller = new AuthController(authService, otpService, emailService);
    });

    it('resolves login flow for identifier', async () => {
        authService.resolveLoginMethod.mockResolvedValue({
            flow: 'USERNAME_PIN',
            normalizedIdentifier: 'shiftlead',
            pinResetRequired: true,
        });

        const result = await controller.resolveLoginFlow({ identifier: 'ShiftLead' });

        expect(authService.resolveLoginMethod).toHaveBeenCalledWith('ShiftLead');
        expect(result).toEqual({
            success: true,
            flow: 'USERNAME_PIN',
            identifier: 'shiftlead',
            pinResetRequired: true,
        });
    });

    it('verifies PIN and returns JSON payload when redirect mode is off', async () => {
        const res = createResponseMock();
        const req = { query: {} } as any;
        authService.loginWithUsernamePin.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            user: { id: 'u1', role: 'STAFF' },
        });

        await controller.verifyPin({ identifier: 'ShiftLead', pin: '1234' }, req, res);

        expect(authService.loginWithUsernamePin).toHaveBeenCalledWith('shiftlead', '1234');
        expect(res.cookie).toHaveBeenCalledTimes(3);
        expect(res.json).toHaveBeenCalledWith({
            success: true,
            redirectTo: '/dashboard',
            pinResetRequired: false,
        });
    });

    it('verifies PIN and redirects when redirect mode is on', async () => {
        const res = createResponseMock();
        const req = { query: { redirect: '1', next: '/dashboard/staff' } } as any;
        authService.loginWithUsernamePin.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
            csrfToken: 'c',
            user: { id: 'u1', role: 'STAFF' },
        });

        await controller.verifyPin({ identifier: 'shiftlead', pin: '1234' }, req, res);

        expect(res.redirect).toHaveBeenCalledWith(302, '/dashboard/staff');
    });

    it('redirects to login with error on invalid PIN in redirect mode', async () => {
        const res = createResponseMock();
        const req = { query: { redirect: '1', next: '/dashboard/staff' } } as any;
        authService.loginWithUsernamePin.mockRejectedValue(new UnauthorizedException('Invalid username or PIN'));

        await controller.verifyPin({ identifier: 'ShiftLead', pin: '0000' }, req, res);

        const expected = '/auth/login?step=pin&identifier=shiftlead&error=invalid&next=%2Fdashboard%2Fstaff';
        expect(res.redirect).toHaveBeenCalledWith(302, expected);
    });
});
