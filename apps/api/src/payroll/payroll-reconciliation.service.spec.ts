import { describe, expect, it, vi } from 'vitest';

import {
    normalizeReconciliation,
    reconciliationPayloadSha256,
} from './payroll-reconciliation';
import { PayrollReconciliationService } from './payroll-reconciliation.service';

const actor = { tenantId: 'tenant-1', userId: 'manager-1' };
const batchId = 'batch-1';

function tenantDb(tx: any) {
    return { withTenant: vi.fn((_tenantId: string, work: (value: any) => unknown) => work(tx)) } as any;
}

describe('PayrollReconciliationService', () => {
    it('replays an exact provider event and rejects digest drift', async () => {
        const body = {
            provider: 'provider-a', providerEventId: 'event-1', providerTotalMinutes: -30,
            outcomes: [{ lineId: 'line-1', status: 'ACCEPTED' }],
        };
        const payload = normalizeReconciliation(body);
        const payloadSha256 = reconciliationPayloadSha256({
            tenantId: actor.tenantId, actorUserId: actor.userId, batchId, payload,
        });
        const receipt = {
            id: 'receipt-1', tenantId: actor.tenantId, batchId,
            provider: payload.provider, providerEventId: payload.providerEventId, payloadSha256,
            providerTotalMinutes: -30, acceptedCount: 1, rejectedCount: 0, pendingCount: 0,
            receivedByUserId: actor.userId, receivedAt: new Date('2026-06-01T00:00:00Z'),
        };
        const tx = {
            payrollReconciliationReceipt: { findUnique: vi.fn().mockResolvedValue(receipt) },
        };
        const service = new PayrollReconciliationService(tenantDb(tx));

        await expect(service.reconcile(actor, batchId, body)).resolves.toMatchObject({
            id: receipt.id, providerTotalMinutes: -30,
        });
        await expect(service.reconcile(actor, batchId, {
            ...body, providerTotalMinutes: -29,
        })).rejects.toThrow('Idempotency-Key');
    });

    it('terminalizes after a rejected line and all-accepted wrong total are corrected', async () => {
        const body = {
            provider: 'provider-a', providerEventId: 'event-correction', providerTotalMinutes: 450,
            outcomes: [{ lineId: 'line-1', status: 'ACCEPTED' }],
        };
        const batch = {
            id: batchId, tenantId: actor.tenantId, periodId: 'period-1',
            status: 'RECONCILING', rowCount: 1, totalPayableMinutes: 450,
        };
        const receipt = {
            id: 'receipt-correction', tenantId: actor.tenantId, batchId,
            provider: body.provider, providerEventId: body.providerEventId, payloadSha256: 'a'.repeat(64),
            providerTotalMinutes: 450, acceptedCount: 1, rejectedCount: 0, pendingCount: 0,
            receivedByUserId: actor.userId, receivedAt: new Date('2026-06-01T00:00:00Z'),
        };
        let lineStatus = 'REJECTED';
        const terminalUpdate = vi.fn().mockResolvedValue({ count: 1 });
        const tx = {
            $queryRaw: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: batchId }]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollExportBatch: {
                findFirst: vi.fn().mockResolvedValue(batch),
                updateMany: terminalUpdate,
            },
            payrollReconciliationReceipt: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(async ({ data }: any) => ({ ...receipt, ...data })),
            },
            payrollExportLine: { findMany: vi.fn().mockResolvedValue([{ id: 'line-1' }]) },
            payrollReconciliationLineEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
            payrollReconciliationLineState: {
                upsert: vi.fn(async ({ update }: any) => { lineStatus = update.status; return {}; }),
                count: vi.fn(async () => lineStatus === 'ACCEPTED' ? 1 : 0),
            },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };

        await new PayrollReconciliationService(tenantDb(tx)).reconcile(actor, batchId, body);

        expect(tx.payrollReconciliationLineState.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { batchId_lineId: { batchId, lineId: 'line-1' } },
            update: expect.objectContaining({ status: 'ACCEPTED' }),
        }));
        expect(terminalUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ status: 'RECONCILING' }),
            data: expect.objectContaining({ status: 'RECONCILED' }),
        }));
    });
});
