import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';

import { PERMISSION_METADATA_KEY } from '../auth/require-permission.decorator';
import { PayrollController } from './payroll.controller';

describe('PayrollController', () => {
    it.each([
        ['listPolicies', 'payroll:read'],
        ['getPolicy', 'payroll:read'],
        ['createPolicy', 'payroll:policy_write'],
        ['listPeriods', 'payroll:read'],
        ['getPeriod', 'payroll:read'],
        ['createPeriod', 'payroll:policy_write'],
        ['adoptCards', 'payroll:policy_write'],
        ['startReview', 'payroll:lock'],
        ['decideCards', 'time_cards:approve'],
        ['lockPeriod', 'payroll:lock'],
        ['createAmendment', 'payroll:reconcile'],
        ['decideAmendment', 'time_cards:approve'],
        ['createExport', 'payroll:export'],
        ['exportEntitlement', 'payroll:export'],
        ['getExport', 'payroll:read'],
        ['downloadExport', 'payroll:export'],
        ['reconcileExport', 'payroll:reconcile'],
    ])('requires %s permission on %s', (methodName, permission) => {
        expect(Reflect.getMetadata(
            PERMISSION_METADATA_KEY,
            (PayrollController.prototype as any)[methodName],
        )).toBe(permission);
    });

    it('passes exact expected export cost body and idempotency key to export orchestration', async () => {
        const exports = { create: vi.fn().mockResolvedValue({ id: 'batch-1' }) };
        const controller = new PayrollController(
            {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, exports as any, {} as any,
        );
        const req = { user: { tenantId: 'tenant-1', sub: 'manager-1' } };

        await controller.createExport(req, 'period-1', { expectedCreditCost: 3 }, 'export-key');

        expect(exports.create).toHaveBeenCalledWith(
            { tenantId: 'tenant-1', userId: 'manager-1' },
            'period-1',
            { expectedCreditCost: 3 },
            'export-key',
        );
    });

    it('delegates the payroll-only export entitlement projection for the authenticated tenant', async () => {
        const exports = { entitlement: vi.fn().mockResolvedValue({ creditCost: 3, eligible: true }) };
        const controller = new PayrollController(
            {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, exports as any, {} as any,
        );

        await controller.exportEntitlement({ user: { tenantId: 'tenant-1', sub: 'manager-1' } });

        expect(exports.entitlement).toHaveBeenCalledWith({ tenantId: 'tenant-1', userId: 'manager-1' });
    });

    it('serves verified CSV as a private UTF-8 attachment', async () => {
        const content = Buffer.from('header\n', 'utf8');
        const exports = {
            download: vi.fn().mockResolvedValue({ filename: 'payroll.csv', content }),
        };
        const controller = new PayrollController(
            {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, exports as any, {} as any,
        );
        const response = { setHeader: vi.fn(), send: vi.fn() };

        await controller.downloadExport(
            { user: { tenantId: 'tenant-1', sub: 'manager-1' } },
            'batch-1',
            response,
        );

        expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
        expect(response.setHeader).toHaveBeenCalledWith(
            'Content-Disposition',
            'attachment; filename="payroll.csv"',
        );
        expect(response.send).toHaveBeenCalledWith(content);
    });
});
