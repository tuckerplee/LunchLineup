import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOW_AUTHENTICATED_METADATA_KEY, PERMISSION_METADATA_KEY } from './require-permission.decorator';
import { RbacGuard } from './rbac.guard';

function createContext(handler: Function, request: Record<string, unknown> = {}, controllerClass: Function = class TestController {}) {
    return {
        getHandler: () => handler,
        getClass: () => controllerClass,
        switchToHttp: () => ({
            getRequest: () => request,
        }),
    } as any;
}

describe('RbacGuard default-deny policy', () => {
    let rbacService: any;
    let guard: RbacGuard;

    beforeEach(() => {
        rbacService = {
            getEffectiveAccess: vi.fn(),
        };
        guard = new RbacGuard(new Reflector(), rbacService);
    });

    it('allows public routes without a user or permission metadata', async () => {
        const handler = function publicRoute() {};
        Reflect.defineMetadata('isPublic', true, handler);

        await expect(guard.canActivate(createContext(handler))).resolves.toBe(true);
    });

    it('allows explicitly authenticated-only routes after JwtAuthGuard attaches a user', async () => {
        const handler = function authOnlyRoute() {};
        Reflect.defineMetadata(ALLOW_AUTHENTICATED_METADATA_KEY, true, handler);

        await expect(guard.canActivate(createContext(handler, {
            user: { sub: 'user-1', tenantId: 'tenant-1' },
        }))).resolves.toBe(true);
    });

    it('rejects authenticated routes that are missing both permission and authenticated-only metadata', async () => {
        const handler = function missingMetadataRoute() {};

        await expect(guard.canActivate(createContext(handler, {
            user: { sub: 'user-1', tenantId: 'tenant-1', permissions: ['dashboard:access'] },
        }))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects authenticated-only routes when no user context exists', async () => {
        const handler = function authOnlyRoute() {};
        Reflect.defineMetadata(ALLOW_AUTHENTICATED_METADATA_KEY, true, handler);

        await expect(guard.canActivate(createContext(handler))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows routes when the user has the required permission', async () => {
        const handler = function protectedRoute() {};
        Reflect.defineMetadata(PERMISSION_METADATA_KEY, 'users:read', handler);

        await expect(guard.canActivate(createContext(handler, {
            user: { sub: 'user-1', tenantId: 'tenant-1', role: 'Admin', permissions: ['users:read'] },
        }))).resolves.toBe(true);
    });

    it('allows routes only when the user has every required permission', async () => {
        const handler = function protectedRoute() {};
        Reflect.defineMetadata(PERMISSION_METADATA_KEY, ['lunch_breaks:write', 'shifts:write'], handler);

        await expect(guard.canActivate(createContext(handler, {
            user: {
                sub: 'manager-1',
                tenantId: 'tenant-1',
                role: 'MANAGER',
                permissions: ['lunch_breaks:write', 'shifts:write'],
            },
        }))).resolves.toBe(true);

        await expect(guard.canActivate(createContext(handler, {
            user: {
                sub: 'manager-1',
                tenantId: 'tenant-1',
                role: 'MANAGER',
                permissions: ['lunch_breaks:write'],
            },
        }))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects routes when the user lacks the required permission', async () => {
        const handler = function protectedRoute() {};
        Reflect.defineMetadata(PERMISSION_METADATA_KEY, 'users:admin', handler);

        await expect(guard.canActivate(createContext(handler, {
            user: { sub: 'user-1', tenantId: 'tenant-1', role: 'Staff', permissions: ['users:read'] },
        }))).rejects.toBeInstanceOf(ForbiddenException);
    });
});
