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

    it('passes bounded list filters and continuation to the service', async () => {
        const service = { listLunchBreaks: vi.fn().mockResolvedValue({ data: [] }) };
        const controller = new LunchBreaksController(service as any);
        const req = { user: { tenantId: 'tenant-1', sub: 'manager-1' } };

        await controller.list(
            req,
            'schedule-1',
            'location-1',
            'shift-1, shift-2',
            '2026-03-05T00:00:00.000Z',
            '2026-03-06T00:00:00.000Z',
            '50',
            'cursor-1',
        );

        expect(service.listLunchBreaks).toHaveBeenCalledWith('tenant-1', {
            scheduleId: 'schedule-1',
            locationId: 'location-1',
            shiftIds: ['shift-1', 'shift-2'],
            startDate: '2026-03-05T00:00:00.000Z',
            endDate: '2026-03-06T00:00:00.000Z',
            limit: '50',
            cursor: 'cursor-1',
        }, req.user);
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

    it('requires a bounded Idempotency-Key before setup shift work', async () => {
        const service = { persistSetupShifts: vi.fn() };
        const controller = new LunchBreaksController(service as any);

        await expect(controller.persistSetupShifts(
            { user: { tenantId: 'tenant-1', sub: 'manager-1' } },
            { locationId: 'location-1', rows: [] },
            undefined,
        )).rejects.toThrow('Idempotency-Key header is required for setup shift persistence');

        expect(service.persistSetupShifts).not.toHaveBeenCalled();
    });

    it('passes the normalized setup key and actor to the service', async () => {
        const service = { persistSetupShifts: vi.fn().mockResolvedValue({ shiftIds: [] }) };
        const controller = new LunchBreaksController(service as any);
        const req = { user: { tenantId: 'tenant-1', sub: 'manager-1' } };
        const body = { locationId: 'location-1', rows: [] };

        await controller.persistSetupShifts(req, body, ' setup-attempt-1 ');

        expect(service.persistSetupShifts).toHaveBeenCalledWith(
            'tenant-1',
            body,
            'setup-attempt-1',
            req.user,
        );
    });

    it('requires a bounded Idempotency-Key before manual break replacement', async () => {
        const service = { updateShiftBreaks: vi.fn() };
        const controller = new LunchBreaksController(service as any);

        await expect(controller.updateShiftBreaks(
            { user: { tenantId: 'tenant-1', sub: 'manager-1' } },
            'shift-1',
            { locationId: 'location-1', breaks: [] },
            undefined,
        )).rejects.toThrow('Idempotency-Key header is required for shift lunch/break replacement');

        expect(service.updateShiftBreaks).not.toHaveBeenCalled();
    });

    it('passes the normalized manual-break key and actor to the service', async () => {
        const service = { updateShiftBreaks: vi.fn().mockResolvedValue({ shiftId: 'shift-1' }) };
        const controller = new LunchBreaksController(service as any);
        const req = { user: { tenantId: 'tenant-1', sub: 'manager-1' } };
        const body = { locationId: 'location-1', breaks: [] };

        await controller.updateShiftBreaks(req, 'shift-1', body, ' break-attempt-1 ');

        expect(service.updateShiftBreaks).toHaveBeenCalledWith(
            'tenant-1',
            'shift-1',
            body,
            'break-attempt-1',
            req.user,
        );
    });
});
