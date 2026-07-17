import { describe, expect, it, vi } from 'vitest';

import { PayrollExportService } from './payroll-export.service';
import { payrollContentSha256 } from './payroll-csv';
import { materializeLockedSnapshots } from './payroll-lock-snapshot';

const actor = { tenantId: 'tenant-1', userId: 'manager-1' };

function exportHarness(options: { zero?: boolean; tamperedAggregate?: boolean; initialCost?: number } = {}) {
    const sources = options.zero ? [] : [{
        sourceType: 'TIME_CARD' as const,
        sourceId: 'card-1',
        sourceRevision: 4,
        employeeId: 'employee-1',
        locationId: null,
        workTimeZone: 'UTC',
        clockInAt: new Date('2026-05-02T08:00:00Z'),
        clockOutAt: new Date('2026-05-02T16:00:00Z'),
        breakMinutes: 30,
        payableMinutes: 450,
        approvedAt: new Date('2026-05-09T00:00:00Z'),
        approvedByUserId: 'approver-1',
    }];
    const snapshot = materializeLockedSnapshots({
        tenantId: actor.tenantId,
        periodId: 'period-1',
        sources,
    });
    const entries = snapshot.entries.map((entry, index) => ({
        id: `entry-${index + 1}`,
        tenantId: actor.tenantId,
        periodId: 'period-1',
        ...entry,
    }));
    const period = {
        id: 'period-1', tenantId: actor.tenantId, status: 'LOCKED',
        lockedEntryCount: entries.length, totalPayableMinutes: snapshot.totalPayableMinutes,
        lockedEntrySha256: options.tamperedAggregate ? 'f'.repeat(64) : snapshot.aggregateSha256,
        localStartDate: new Date('2026-05-01T00:00:00Z'),
    };
    const state: {
        batch: any;
        lines: any[];
        cost: number;
        debitCount: number;
        creditTransaction: any;
    } = {
        batch: null,
        lines: [],
        cost: options.initialCost ?? 3,
        debitCount: 0,
        creditTransaction: null,
    };
    const batchCreate = vi.fn(async ({ data }: any) => {
        state.batch = {
            ...data,
            status: 'GENERATED',
            createdAt: new Date('2026-05-09T00:00:00Z'),
            downloadedAt: null,
            reconciledAt: null,
            updatedAt: new Date('2026-05-09T00:00:00Z'),
        };
        return state.batch;
    });
    const tx = {
        $queryRaw: vi.fn(async () => state.batch ? [{ id: state.batch.id }] : []),
        $executeRaw: vi.fn().mockResolvedValue(1),
        payrollExportBatch: {
            findUnique: vi.fn(async ({ where }: any) => (
                state.batch?.operationId === where.operationId ? state.batch : null
            )),
            findFirst: vi.fn(async () => state.batch),
            create: batchCreate,
            updateMany: vi.fn(async ({ data }: any) => {
                state.batch = { ...state.batch, ...data, status: 'DOWNLOADED' };
                return { count: 1 };
            }),
        },
        payrollPeriod: { findFirst: vi.fn().mockResolvedValue(period) },
        payrollLockedEntry: { findMany: vi.fn().mockResolvedValue(entries) },
        creditTransaction: {
            findUnique: vi.fn(async ({ where }: any) => (
                state.creditTransaction?.id === where.id ? state.creditTransaction : null
            )),
        },
        payrollExportLine: {
            createMany: vi.fn(async ({ data }: any) => {
                state.lines = data;
                return { count: data.length };
            }),
            findMany: vi.fn(async () => state.lines),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const tenantDb = {
        withTenant: vi.fn((_tenantId: string, work: (value: any) => unknown) => work(tx)),
    } as any;
    const featureAccess = {
        getFeatureMatrix: vi.fn(async () => ({
            planTier: 'ENTERPRISE', usageCredits: 999,
            features: { time_cards: { enabled: true, source: 'credits', reason: 'hidden', creditCost: state.cost } },
        })),
        lockTenantInTransaction: vi.fn().mockResolvedValue(undefined),
        assertFeatureEnabledInTransaction: vi.fn(async () => ({
            enabled: true,
            source: 'credits',
            creditCost: state.cost,
        })),
        recordFeatureUsageInTransaction: vi.fn(async (
            _tx: unknown,
            tenantId: string,
            _resolution: unknown,
            reason: string,
            operationId: string,
        ) => {
            state.debitCount += 1;
            const newBalance = 20 - state.cost;
            state.creditTransaction = {
                id: `feature-usage-${operationId}`,
                tenantId,
                amount: -state.cost,
                reason,
                balanceAfter: newBalance,
            };
            return { consumedCredits: state.cost, newBalance };
        }),
    } as any;
    return {
        service: new PayrollExportService(tenantDb, featureAccess),
        state,
        tx,
        tenantDb,
        featureAccess,
        batchCreate,
    };
}

describe('PayrollExportService', () => {
    it('projects current payroll export eligibility, cost, and authoritative reason', async () => {
        const harness = exportHarness({ initialCost: 4 });

        const result = await harness.service.entitlement(actor);

        expect(result).toEqual({ creditCost: 4, eligible: true, reason: 'hidden' });
        expect(Object.keys(result).sort()).toEqual(['creditCost', 'eligible', 'reason']);
        expect(harness.featureAccess.getFeatureMatrix).toHaveBeenCalledWith(actor.tenantId);
    });

    it.each([
        ['inactive subscription', 'Billable features require a current active paid subscription.', 500],
        ['insufficient separate credits', 'Feature requires 4 separately purchased usage credits.', 0],
    ])('retains cost and reason for %s ineligibility', async (_label, reason, usageCredits) => {
        const harness = exportHarness({ initialCost: 4 });
        harness.featureAccess.getFeatureMatrix.mockResolvedValueOnce({
            planTier: 'ENTERPRISE',
            usageCredits,
            features: {
                time_cards: {
                    enabled: false,
                    source: 'disabled',
                    reason,
                    creditCost: 4,
                },
            },
        });

        const result = await harness.service.entitlement(actor);

        expect(result).toEqual({ creditCost: 4, eligible: false, reason });
    });

    it('locks the tenant row before payroll advisory locks', async () => {
        const harness = exportHarness();

        await harness.service.create(actor, 'period-1', { expectedCreditCost: 3 }, 'lock-order-key');

        expect(harness.featureAccess.lockTenantInTransaction).toHaveBeenCalledWith(
            harness.tx,
            actor.tenantId,
        );
        expect(harness.featureAccess.lockTenantInTransaction.mock.invocationCallOrder[0])
            .toBeLessThan(harness.tx.$executeRaw.mock.invocationCallOrder[0]);
    });

    it('retries one serialization conflict without duplicating settlement or export rows', async () => {
        const harness = exportHarness();
        const runTransaction = harness.tenantDb.withTenant.getMockImplementation();
        let transactionCalls = 0;
        harness.tenantDb.withTenant.mockImplementation((...args: any[]) => {
            transactionCalls += 1;
            if (transactionCalls === 2) return Promise.reject({ code: 'P2034' });
            return runTransaction!(...args);
        });

        const result = await harness.service.create(
            actor,
            'period-1',
            { expectedCreditCost: 3 },
            'serialization-retry-key',
        );

        expect(result.id).toBe(harness.state.batch.id);
        expect(transactionCalls).toBe(3);
        expect(harness.state.debitCount).toBe(1);
        expect(harness.batchCreate).toHaveBeenCalledTimes(1);
        expect(harness.tx.payrollExportLine.createMany).toHaveBeenCalledTimes(1);
    });

    it('does not normalize or retry a PostgreSQL deadlock', async () => {
        const harness = exportHarness();
        const runTransaction = harness.tenantDb.withTenant.getMockImplementation();
        let transactionCalls = 0;
        harness.tenantDb.withTenant.mockImplementation((...args: any[]) => {
            transactionCalls += 1;
            if (transactionCalls === 2) return Promise.reject({ code: '40P01' });
            return runTransaction!(...args);
        });

        await expect(harness.service.create(
            actor,
            'period-1',
            { expectedCreditCost: 3 },
            'deadlock-not-retried-key',
        )).rejects.toMatchObject({ code: '40P01' });

        expect(transactionCalls).toBe(2);
        expect(harness.state.debitCount).toBe(0);
        expect(harness.batchCreate).not.toHaveBeenCalled();
    });

    it('rejects changed configured cost before debit or batch creation', async () => {
        const harness = exportHarness({ initialCost: 4 });

        await expect(harness.service.create(
            actor, 'period-1', { expectedCreditCost: 3 }, 'export-key',
        )).rejects.toThrow('credit cost changed');

        expect(harness.state.debitCount).toBe(0);
        expect(harness.tx.payrollLockedEntry.findMany).not.toHaveBeenCalled();
        expect(harness.batchCreate).not.toHaveBeenCalled();
    });

    it('rejects tampered lock aggregate evidence after eligibility but before debit', async () => {
        const harness = exportHarness({ tamperedAggregate: true });

        await expect(harness.service.create(
            actor, 'period-1', { expectedCreditCost: 3 }, 'tamper-key',
        )).rejects.toThrow('integrity evidence');

        expect(harness.featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledOnce();
        expect(harness.state.debitCount).toBe(0);
        expect(harness.batchCreate).not.toHaveBeenCalled();
    });

    it('rejects a zero-line export after eligibility but before debit or writes', async () => {
        const harness = exportHarness({ zero: true });

        await expect(harness.service.create(
            actor, 'period-1', { expectedCreditCost: 3 }, 'zero-key',
        )).rejects.toThrow('entry count');

        expect(harness.featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledOnce();
        expect(harness.state.debitCount).toBe(0);
        expect(harness.batchCreate).not.toHaveBeenCalled();
    });

    it.each([
        'Billable features require a current active paid subscription.',
        'Feature requires 3 separately purchased usage credits.',
    ])('rejects ineligible value work before loading payroll entries: %s', async (reason) => {
        const harness = exportHarness();
        harness.featureAccess.assertFeatureEnabledInTransaction.mockRejectedValueOnce(new Error(reason));

        await expect(harness.service.create(
            actor,
            'period-1',
            { expectedCreditCost: 3 },
            `ineligible-${reason.length}`,
        )).rejects.toThrow(reason);

        expect(harness.tx.payrollLockedEntry.findMany).not.toHaveBeenCalled();
        expect(harness.featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(harness.batchCreate).not.toHaveBeenCalled();
    });

    it('returns a controlled retryable result after an unresolved payroll lock timeout', async () => {
        const harness = exportHarness();
        const runTransaction = harness.tenantDb.withTenant.getMockImplementation();
        let transactionCalls = 0;
        harness.tenantDb.withTenant.mockImplementation((...args: any[]) => {
            transactionCalls += 1;
            if (transactionCalls === 2) return Promise.reject({ code: '55P03' });
            return runTransaction!(...args);
        });

        await expect(harness.service.create(
            actor,
            'period-1',
            { expectedCreditCost: 3 },
            'lock-timeout-key',
        )).rejects.toThrow('Retry safely');

        expect(transactionCalls).toBe(3);
        expect(harness.state.debitCount).toBe(0);
        expect(harness.batchCreate).not.toHaveBeenCalled();
    });

    it('debits exact cost once and replays the stored settlement after configured cost changes', async () => {
        const harness = exportHarness({ initialCost: 3 });

        const first = await harness.service.create(
            actor, 'period-1', { expectedCreditCost: 3 }, 'replay-key',
        );
        harness.state.cost = 9;
        const replay = await harness.service.create(
            actor, 'period-1', { expectedCreditCost: 3 }, 'replay-key',
        );

        expect(first).toEqual(replay);
        expect(first).toMatchObject({
            periodId: 'period-1', contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            settlement: { consumedCredits: 3, newBalance: 17 },
        });
        expect(harness.state.debitCount).toBe(1);
        expect(harness.batchCreate).toHaveBeenCalledOnce();
    });

    it('regenerates and verifies the immutable CSV on download without another charge', async () => {
        const harness = exportHarness({ initialCost: 3 });
        const batch = await harness.service.create(
            actor, 'period-1', { expectedCreditCost: 3 }, 'download-key',
        );
        const artifact = await harness.service.download(actor, batch.id);

        expect(artifact.filename).toContain(batch.id);
        expect(artifact.content.toString('utf8')).toContain('payroll_line_id');
        expect(payrollContentSha256(artifact.content)).toBe(batch.contentSha256);
        expect(harness.state.debitCount).toBe(1);
        expect(harness.tx.payrollExportBatch.updateMany).toHaveBeenCalledOnce();
    });

    it('fails replay and download when the stored batch loses its exact debit provenance', async () => {
        const harness = exportHarness({ initialCost: 3 });
        const batch = await harness.service.create(
            actor,
            'period-1',
            { expectedCreditCost: 3 },
            'provenance-key',
        );
        harness.state.creditTransaction.amount = -2;

        await expect(harness.service.create(
            actor,
            'period-1',
            { expectedCreditCost: 3 },
            'provenance-key',
        )).rejects.toThrow('integrity verification');
        await expect(harness.service.download(actor, batch.id))
            .rejects.toThrow('integrity verification');
    });
});
