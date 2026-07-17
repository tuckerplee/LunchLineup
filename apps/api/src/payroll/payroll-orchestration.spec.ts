import { describe, expect, it, vi } from 'vitest';

import { payrollRequestIdentity } from './payroll-idempotency';
import { PayrollAmendmentService } from './payroll-amendment.service';
import { PayrollCardService } from './payroll-card.service';
import { PayrollPeriodService } from './payroll-period.service';
import { PayrollPolicyService } from './payroll-policy.service';
import { retryPayrollSerializableMutation } from './payroll-transaction';

const actor = { tenantId: 'tenant-1', userId: 'manager-1' };

function basePeriod(overrides: Record<string, unknown> = {}) {
    return {
        id: 'period-1', tenantId: actor.tenantId, policyVersionId: 'policy-1',
        localStartDate: new Date('2026-06-01T00:00:00Z'),
        localEndDateExclusive: new Date('2026-06-08T00:00:00Z'),
        startsAt: new Date('2026-06-01T00:00:00Z'), endsAt: new Date('2026-06-08T00:00:00Z'),
        timeZone: 'UTC', cadence: 'WEEKLY', status: 'OPEN', revision: 0,
        reviewStartedAt: null, reviewStartedByUserId: null, lockedAt: null, lockedByUserId: null,
        lockedEntrySha256: null, lockedEntryCount: null, totalPayableMinutes: null,
        createdAt: new Date('2026-05-01T00:00:00Z'), updatedAt: new Date('2026-05-01T00:00:00Z'),
        ...overrides,
    };
}

function tenantDb(tx: any) {
    return { withTenant: vi.fn((_tenantId: string, work: (value: any) => unknown) => work(tx)) } as any;
}

describe('immutable payroll orchestration services', () => {
    it('bounds serializable replay at two attempts and never retries an ordinary failure', async () => {
        const serializationConflict = { code: 'P2034' };
        const conflicted = vi.fn().mockRejectedValue(serializationConflict);

        await expect(retryPayrollSerializableMutation(conflicted)).rejects.toBe(serializationConflict);
        expect(conflicted).toHaveBeenCalledTimes(2);

        const ordinaryFailure = new Error('ordinary failure');
        const ordinary = vi.fn().mockRejectedValue(ordinaryFailure);
        await expect(retryPayrollSerializableMutation(ordinary)).rejects.toBe(ordinaryFailure);
        expect(ordinary).toHaveBeenCalledOnce();
    });

    it('replays committed period creation using its stored created period ID without creating a duplicate', async () => {
        let operation: any = null;
        const created = basePeriod();
        const periodCreate = vi.fn().mockResolvedValue(created);
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollOperation: {
                findUnique: vi.fn(async () => operation),
                create: vi.fn(async ({ data }: any) => { operation = { ...data }; return operation; }),
            },
            payrollPolicyVersion: { findFirst: vi.fn().mockResolvedValue({
                id: 'policy-1', tenantId: actor.tenantId, version: 1, timeZone: 'UTC', cadence: 'WEEKLY',
                anchorDate: new Date('2026-01-05T00:00:00Z'), effectiveFrom: new Date('2026-01-05T00:00:00Z'),
            }) },
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue(null), create: periodCreate },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        const service = new PayrollPeriodService(tenantDb(tx));

        const first = await service.create(actor, { localStartDate: '2026-06-01' }, 'period-key');
        const replay = await service.create(actor, { localStartDate: '2026-06-01' }, 'period-key');

        expect(replay).toEqual(first);
        expect(periodCreate).toHaveBeenCalledOnce();
        expect(operation).toMatchObject({ kind: 'PERIOD_CREATE', periodId: created.id });
        expect(operation.response.id).toBe(operation.periodId);
    });

    it('retries one serializable adoption conflict and writes one ADOPT operation and audit', async () => {
        let stored: any;
        const open = basePeriod();
        const card = {
            id: 'card-1', tenantId: actor.tenantId, userId: 'employee-1', locationId: null,
            payrollPeriodId: null, workTimeZone: 'UTC', revision: 3,
            clockInAt: new Date('2026-06-02T08:00:00Z'), clockOutAt: new Date('2026-06-02T16:00:00Z'),
            breakMinutes: 30, status: 'CLOSED', deletedAt: null,
        };
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollOperation: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(async ({ data }: any) => { stored = data; return data; }),
            },
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue(open) },
            timeCard: {
                findMany: vi.fn().mockResolvedValue([card]),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };

        const db = tenantDb(tx);
        let transactionAttempts = 0;
        db.withTenant.mockImplementation((_tenantId: string, work: (value: any) => unknown, options?: unknown) => {
            if (options && ++transactionAttempts === 1) return Promise.reject({ code: 'P2034' });
            return work(tx);
        });

        const result = await new PayrollCardService(db).adopt(
            actor,
            open.id,
            { cards: [{ id: card.id, expectedRevision: 3 }] },
            'adopt-key',
        );

        expect(result.cards).toEqual([{ id: card.id, revision: 4 }]);
        expect(stored).toMatchObject({ kind: 'ADOPT', periodId: open.id });
        expect(transactionAttempts).toBe(2);
        expect(tx.payrollOperation.create).toHaveBeenCalledOnce();
        expect(tx.auditLog.create).toHaveBeenCalledOnce();
    });

    it('returns a committed policy replay even after its effective date has passed', async () => {
        const body = {
            timeZone: 'UTC', cadence: 'WEEKLY', anchorDate: '2026-06-01', effectiveFrom: '2026-06-01',
        } as const;
        const identity = payrollRequestIdentity({
            tenantId: actor.tenantId, actorUserId: actor.userId, operation: 'POLICY_CREATE',
            idempotencyKey: 'policy-key', body,
        });
        const committed = {
            id: 'policy-1', tenantId: actor.tenantId, version: 1, timeZone: 'UTC', cadence: 'WEEKLY',
            anchorDate: new Date('2026-06-01T00:00:00Z'), effectiveFrom: new Date('2026-06-01T00:00:00Z'),
            operationId: identity.operationId, requestHash: identity.requestHash,
            createdByUserId: actor.userId, createdAt: new Date('2026-05-01T00:00:00Z'),
        };
        const tx = { payrollPolicyVersion: { findUnique: vi.fn().mockResolvedValue(committed) } };

        const result = await new PayrollPolicyService(tenantDb(tx)).create(actor, body, 'policy-key');

        expect(result).toMatchObject({ id: committed.id, effectiveFrom: '2026-06-01' });
        expect(tx.payrollPolicyVersion.findUnique).toHaveBeenCalledOnce();
    });

    it('creates the first aligned policy with a historical effective boundary', async () => {
        const body = {
            timeZone: 'UTC', cadence: 'WEEKLY', anchorDate: '2026-06-01', effectiveFrom: '2026-06-01',
        } as const;
        const created = {
            id: 'policy-bootstrap', tenantId: actor.tenantId, version: 1,
            ...body,
            anchorDate: new Date('2026-06-01T00:00:00Z'),
            effectiveFrom: new Date('2026-06-01T00:00:00Z'),
            operationId: 'operation-1', requestHash: 'request-1', createdByUserId: actor.userId,
            createdAt: new Date('2026-07-01T00:00:00Z'),
        };
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollPolicyVersion: {
                findUnique: vi.fn().mockResolvedValue(null),
                findFirst: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockResolvedValue(created),
            },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };

        const result = await new PayrollPolicyService(tenantDb(tx)).create(actor, body, 'bootstrap-key');

        expect(result).toMatchObject({ id: created.id, version: 1, effectiveFrom: '2026-06-01' });
        expect(tx.payrollPolicyVersion.create).toHaveBeenCalledOnce();
    });

    it('requires a later policy boundary to align under both previous and incoming cadence anchors', async () => {
        const latest = {
            id: 'policy-1', tenantId: actor.tenantId, version: 1, timeZone: 'UTC', cadence: 'BIWEEKLY',
            anchorDate: new Date('2099-08-03T00:00:00Z'), effectiveFrom: new Date('2099-08-03T00:00:00Z'),
        };
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollPolicyVersion: {
                findUnique: vi.fn().mockResolvedValue(null),
                findFirst: vi.fn().mockResolvedValue(latest),
                create: vi.fn(),
            },
        };

        await expect(new PayrollPolicyService(tenantDb(tx)).create(actor, {
            timeZone: 'UTC', cadence: 'WEEKLY', anchorDate: '2099-08-10', effectiveFrom: '2099-08-10',
        }, 'dual-anchor-key')).rejects.toThrow('align');
        expect(tx.payrollPolicyVersion.create).not.toHaveBeenCalled();
    });

    it('keeps timezone immutable after policy version 1', async () => {
        const latest = {
            id: 'policy-1', tenantId: actor.tenantId, version: 1, timeZone: 'UTC', cadence: 'BIWEEKLY',
            anchorDate: new Date('2099-08-03T00:00:00Z'), effectiveFrom: new Date('2099-08-03T00:00:00Z'),
        };
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollPolicyVersion: {
                findUnique: vi.fn().mockResolvedValue(null),
                findFirst: vi.fn().mockResolvedValue(latest),
                create: vi.fn(),
            },
        };

        await expect(new PayrollPolicyService(tenantDb(tx)).create(actor, {
            timeZone: 'America/New_York', cadence: 'WEEKLY',
            anchorDate: '2099-08-17', effectiveFrom: '2099-08-17',
        }, 'timezone-key')).rejects.toThrow('timezone cannot change');
        expect(tx.payrollPolicyVersion.create).not.toHaveBeenCalled();
    });

    it('keeps a period OPEN when review preflight finds an overlapping unassigned card', async () => {
        const open = basePeriod({ endsAt: new Date('2026-05-08T00:00:00Z') });
        const blocker = {
            id: 'card-blocker', tenantId: actor.tenantId, userId: 'employee-1', locationId: null,
            payrollPeriodId: null, workTimeZone: 'UTC', revision: 1,
            clockInAt: new Date('2026-05-02T08:00:00Z'), clockOutAt: new Date('2026-05-02T16:00:00Z'),
            breakMinutes: 0, status: 'CLOSED', deletedAt: null,
        };
        const updateMany = vi.fn();
        const tx = {
            $queryRaw: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([blocker]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollOperation: { findUnique: vi.fn().mockResolvedValue(null) },
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue(open), updateMany },
        };

        await expect(new PayrollPeriodService(tenantDb(tx)).startReview(
            actor, open.id, { expectedRevision: 0 }, 'review-key',
        )).rejects.toThrow('overlap');
        expect(updateMany).not.toHaveBeenCalled();
        expect(open.status).toBe('OPEN');
    });

    it('allows an ended empty OPEN period to enter REVIEW', async () => {
        const open = basePeriod({ endsAt: new Date('2026-05-08T00:00:00Z') });
        const review = basePeriod({
            endsAt: open.endsAt, status: 'REVIEW', revision: 1,
            reviewStartedAt: new Date('2026-05-09T00:00:00Z'), reviewStartedByUserId: actor.userId,
            updatedAt: new Date('2026-05-09T00:00:00Z'),
        });
        const periodFind = vi.fn().mockResolvedValueOnce(open).mockResolvedValueOnce(review);
        const tx = {
            $queryRaw: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollOperation: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn().mockResolvedValue({}),
            },
            payrollPeriod: { findFirst: periodFind, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };

        const db = tenantDb(tx);
        let transactionAttempts = 0;
        db.withTenant.mockImplementation((_tenantId: string, work: (value: any) => unknown, options?: unknown) => {
            if (options && ++transactionAttempts === 1) return Promise.reject({ code: '40001' });
            return work(tx);
        });

        const result = await new PayrollPeriodService(db).startReview(
            actor, open.id, { expectedRevision: 0 }, 'review-empty-key',
        );

        expect(result).toMatchObject({ status: 'REVIEW', revision: 1 });
        expect(transactionAttempts).toBe(2);
        expect(tx.payrollOperation.create).toHaveBeenCalledOnce();
        expect(tx.auditLog.create).toHaveBeenCalledOnce();
    });

    it.each([
        ['stale revision', { userId: 'employee-1', revision: 4 }, 3, 'stale'],
        ['self approval', { userId: actor.userId, revision: 3 }, 3, 'own time cards'],
    ])('rejects %s before appending a card decision', async (_label, cardValues, expectedRevision, message) => {
        const review = basePeriod({ status: 'REVIEW', revision: 1 });
        const approvalCreate = vi.fn();
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollOperation: { findUnique: vi.fn().mockResolvedValue(null) },
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue(review) },
            timeCard: { findMany: vi.fn().mockResolvedValue([{
                id: 'card-1', tenantId: actor.tenantId, payrollPeriodId: review.id,
                status: 'CLOSED', deletedAt: null, ...cardValues,
            }]) },
            payrollTimeCardApproval: { findMany: vi.fn(), create: approvalCreate },
        };

        await expect(new PayrollCardService(tenantDb(tx)).decide(actor, review.id, {
            decisions: [{
                timeCardId: 'card-1', expectedRevision, decision: 'APPROVED',
            }],
        }, `decision-${_label}`)).rejects.toThrow(message);
        expect(approvalCreate).not.toHaveBeenCalled();
    });

    it('rejects an adjustment period that begins before the source locked period ends', async () => {
        const entry = {
            id: 'entry-1', tenantId: actor.tenantId, periodId: 'source-period', sourceType: 'TIME_CARD',
            employeeId: 'employee-1', payableMinutes: 480,
        };
        const adjustment = basePeriod({
            id: 'adjustment-period', startsAt: new Date('2026-06-01T00:00:00Z'), status: 'OPEN',
        });
        const source = basePeriod({
            id: 'source-period', status: 'LOCKED', endsAt: new Date('2026-06-08T00:00:00Z'),
        });
        const amendmentCreate = vi.fn();
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollAmendment: { findUnique: vi.fn().mockResolvedValue(null), create: amendmentCreate },
            payrollLockedEntry: { findFirst: vi.fn().mockResolvedValue(entry) },
            payrollPeriod: { findFirst: vi.fn(async ({ where }: any) => (
                where.id === adjustment.id ? adjustment : source
            )) },
        };

        await expect(new PayrollAmendmentService(tenantDb(tx)).create(actor, entry.id, {
            adjustmentPeriodId: adjustment.id,
            replacementClockInAt: '2026-06-02T08:00:00Z',
            replacementClockOutAt: '2026-06-02T16:00:00Z',
            replacementBreakMinutes: 30,
            reason: 'Correct payroll duration',
        }, 'amendment-key')).rejects.toThrow('begin after');
        expect(amendmentCreate).not.toHaveBeenCalled();
    });

    it('requires an amendment approver distinct from requester and affected employee', async () => {
        const decisionCreate = vi.fn();
        const tx = {
            $queryRaw: vi.fn().mockResolvedValue([]),
            $executeRaw: vi.fn().mockResolvedValue(1),
            payrollAmendment: {
                findFirst: vi.fn().mockResolvedValue({
                    id: 'amendment-1', tenantId: actor.tenantId, adjustmentPeriodId: 'period-2',
                    lockedEntryId: 'entry-1', requestedByUserId: actor.userId,
                }),
            },
            payrollAmendmentDecision: {
                findUnique: vi.fn().mockResolvedValue(null),
                findFirst: vi.fn().mockResolvedValue(null),
                create: decisionCreate,
            },
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue(basePeriod({ id: 'period-2', status: 'REVIEW' })) },
            payrollLockedEntry: { findFirst: vi.fn().mockResolvedValue({ id: 'entry-1', employeeId: 'employee-1' }) },
        };

        await expect(new PayrollAmendmentService(tenantDb(tx)).decide(actor, 'amendment-1', {
            decision: 'APPROVED',
        }, 'amendment-decision-key')).rejects.toThrow('independent approver');
        expect(decisionCreate).not.toHaveBeenCalled();
    });
});
