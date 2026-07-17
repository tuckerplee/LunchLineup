import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AvailabilityImportsController } from './availability-imports.controller';

describe('AvailabilityImportsController', () => {
    it('binds upload creation and status reads to the authenticated tenant', async () => {
        const imports = {
            createImport: vi.fn().mockResolvedValue({ id: 'import-1', status: 'PENDING' }),
            getImport: vi.fn().mockResolvedValue({ id: 'import-1', status: 'SUCCEEDED' }),
        };
        const controller = new AvailabilityImportsController(imports as any);
        const request = {
            user: { sub: 'manager-1', tenantId: 'tenant-1' },
            headers: { 'idempotency-key': 'request-1' },
        };
        const file = {
            buffer: Buffer.from('%PDF-1.7\n'),
            mimetype: 'application/pdf',
            originalname: 'availability.pdf',
            size: 9,
        };

        await controller.create(request, 'staff-1', file, ' EMP-10492 ');
        await controller.get(request, 'import-1');

        expect(imports.createImport).toHaveBeenCalledWith({
            tenantId: 'tenant-1',
            requestedByUserId: 'manager-1',
            userId: 'staff-1',
            idempotencyKey: 'request-1',
            staffIdentity: ' EMP-10492 ',
            file,
        });
        expect(imports.getImport).toHaveBeenCalledWith('tenant-1', 'import-1');
    });

    it('rejects uploads without an idempotency key before service execution', async () => {
        const imports = { createImport: vi.fn(), getImport: vi.fn() };
        const controller = new AvailabilityImportsController(imports as any);

        await expect(controller.create({
            user: { sub: 'manager-1', tenantId: 'tenant-1' },
            headers: {},
        }, 'staff-1', undefined, undefined)).rejects.toBeInstanceOf(BadRequestException);
        expect(imports.createImport).not.toHaveBeenCalled();
    });
});
