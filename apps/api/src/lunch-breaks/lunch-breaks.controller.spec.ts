import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RbacGuard } from '../auth/rbac.guard';
import { LunchBreaksController } from './lunch-breaks.controller';

function createSetupContext(role: string, permissions: string[]) {
    return {
        getHandler: () => LunchBreaksController.prototype.persistSetupShifts,
        getClass: () => LunchBreaksController,
        switchToHttp: () => ({
            getRequest: () => ({
                user: { sub: `${role.toLowerCase()}-1`, tenantId: 'tenant-1', role, permissions },
            }),
        }),
    } as any;
}

describe('LunchBreaksController', () => {
    it('requires lunch-break and shift write permissions for setup shift persistence', () => {
        expect(Reflect.getMetadata(
            'permission',
            LunchBreaksController.prototype.persistSetupShifts,
        )).toEqual(['lunch_breaks:write', 'shifts:write']);
    });

    it.each(['ADMIN', 'MANAGER'])('authorizes %s setup saves with both write permissions', async (role) => {
        const guard = new RbacGuard(new Reflector(), { getEffectiveAccess: vi.fn() } as any);

        await expect(guard.canActivate(createSetupContext(role, [
            'lunch_breaks:write',
            'shifts:write',
        ]))).resolves.toBe(true);
    });

    it('rejects setup saves when one required permission is missing', async () => {
        const guard = new RbacGuard(new Reflector(), { getEffectiveAccess: vi.fn() } as any);

        await expect(guard.canActivate(createSetupContext('MANAGER', [
            'lunch_breaks:write',
        ]))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('requires an Idempotency-Key before generation work', async () => {
        const service = { generateLunchBreaks: vi.fn() };
        const controller = new LunchBreaksController(service as any);

        await expect(controller.generate(
            { user: { tenantId: 'tenant-1' } },
            { shiftIds: ['shift-1'], persist: true },
            undefined,
        )).rejects.toThrow('Idempotency-Key header is required');
        expect(service.generateLunchBreaks).not.toHaveBeenCalled();
    });

    it('passes one normalized attempt key to the generation service', async () => {
        const service = { generateLunchBreaks: vi.fn().mockResolvedValue({ reused: false }) };
        const controller = new LunchBreaksController(service as any);
        const body = { shiftIds: ['shift-1'], persist: true };

        await controller.generate(
            { user: { tenantId: 'tenant-1' } },
            body,
            ' attempt-1 ',
        );

        expect(service.generateLunchBreaks).toHaveBeenCalledWith('tenant-1', body, 'attempt-1');
    });
});
