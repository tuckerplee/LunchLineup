import { describe, expect, it, vi } from 'vitest';

import { PayrollLockService } from './payroll-lock.service';

const actor = { tenantId: 'tenant-1', userId: 'manager-1' };

function reviewPeriod(overrides: Record<string, unknown> = {}) {
    return {
        id: 'period-1', tenantId: actor.tenantId, policyVersionId: 'policy-1',
        localStartDate: new Date('2026-05-01T00:00:00Z'),
        localEndDateExclusive: new Date('2026-05-08T00:00:00Z'),
        startsAt: new Date('2026-05-01T00:00:00Z'), endsAt: new Date('2026-05-08T00:00:00Z'),
        timeZone: 'UTC', cadence: 'WEEKLY', status: 'REVIEW', revision: 1,
        reviewStartedAt: new Date('2026-05-09T00:00:00Z'), reviewStartedByUserId: actor.userId,
        lockedAt: null, lockedByUserId: null, lockOperationId: null, lockRequestHash: null,
        lockedEntrySha256: null, lockedEntryCount: null, totalPayableMinutes: null,
        createdAt: new Date('2026-04-01T00:00:00Z'), updatedAt: new Date('2026-05-09T00:00:00Z'),
        ...overrides,
    };
}

describe('PayrollLockService', () => {
    it('terminally locks an ended empty period with deterministic zero aggregate evidence', async () => {
        const review = reviewPeriod();
        let lockData: any;
        const locked = () => ({
            ...review,
            ...lockData,
            status: 'LOCKED',
            revision: 2,
            updatedAt: new Date('2026-05-10T00:00:00Z'),
        });
        const periodFind = vi.fn()
            .mockResolvedValueOnce(review)
            .mockResolvedValueOnce(review)
            .mockResolvedValueOnce(review)
            .mockImplementationOnce(async () => locked());
        const lockedCreateMany = vi.fn();
        const tx = {
            $queryRaw: vi.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{ id: review.id }])
                .mockResolvedValueOnce([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollPeriod: {
                findFirst: periodFind,
                updateMany: vi.fn(async (args: any) => { lockData = args.data; return { count: 1 }; }),
            },
            payrollAmendment: { findMany: vi.fn().mockResolvedValue([]) },
            payrollLockedEntry: { createMany: lockedCreateMany },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        const tenantDb = {
            withTenant: vi.fn(),
        } as any;
        let transactionAttempts = 0;
        tenantDb.withTenant.mockImplementation((_tenantId: string, work: (value: any) => unknown, options?: unknown) => {
            if (options && ++transactionAttempts === 1) return Promise.reject({ code: 'P2034' });
            return work(tx);
        });

        const result = await new PayrollLockService(tenantDb).lock(
            actor,
            review.id,
            { expectedRevision: 1 },
            'empty-lock-key',
        );

        expect(result).toMatchObject({ status: 'LOCKED', revision: 2, lockedEntryCount: 0, totalPayableMinutes: 0 });
        expect(result.lockedEntrySha256).toMatch(/^[a-f0-9]{64}$/);
        expect(transactionAttempts).toBe(2);
        expect(lockedCreateMany).not.toHaveBeenCalled();
        expect(tx.payrollPeriod.updateMany).toHaveBeenCalledOnce();
        expect(tx.auditLog.create).toHaveBeenCalledOnce();
    });
});
