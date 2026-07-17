import { describe, expect, it, vi } from 'vitest';

import { PayrollReadService } from './payroll-read.service';

const actor = { tenantId: 'tenant-1', userId: 'manager-1' };
const startsAt = new Date('2026-06-01T00:00:00Z');
const endsAt = new Date('2026-06-08T00:00:00Z');

function period(overrides: Record<string, unknown> = {}) {
    return {
        id: 'period-1', tenantId: actor.tenantId, policyVersionId: 'policy-1',
        localStartDate: new Date('2026-06-01T00:00:00Z'),
        localEndDateExclusive: new Date('2026-06-08T00:00:00Z'),
        startsAt, endsAt, timeZone: 'UTC', cadence: 'WEEKLY', status: 'OPEN', revision: 0,
        reviewStartedAt: null, reviewStartedByUserId: null, lockedAt: null, lockedByUserId: null,
        lockedEntrySha256: null, lockedEntryCount: null, totalPayableMinutes: null,
        createdAt: new Date('2026-05-01T00:00:00Z'), updatedAt: new Date('2026-05-01T00:00:00Z'),
        ...overrides,
    };
}

function summaryRow() {
    return [{
        periodId: 'period-1',
        cardCount: 1, closedCardCount: 1, approvedCardCount: 1, rejectedCardCount: 0,
        amendmentCount: 0, pendingAmendmentCount: 0, approvedAmendmentCount: 0, lockedEntryCount: 0,
    }];
}

function db(tx: any) {
    return { withTenant: vi.fn((_tenantId: string, work: (value: any) => unknown) => work(tx)) } as any;
}

describe('PayrollReadService', () => {
    it('returns assigned cards plus bounded adoption-eligible history with exact current decisions', async () => {
        const assigned = {
            id: 'card-a', userId: 'employee-a', locationId: null, payrollPeriodId: 'period-1',
            workTimeZone: 'UTC', clockInAt: new Date('2026-06-02T08:00:00Z'),
            clockOutAt: new Date('2026-06-02T16:00:00Z'), breakMinutes: 30, status: 'CLOSED',
            revision: 7, updatedAt: new Date('2026-06-02T16:00:00Z'),
            user: { id: 'employee-a', name: 'Assigned', username: 'assigned' },
        };
        const eligible = {
            ...assigned, id: 'card-b', userId: 'employee-b', payrollPeriodId: null, revision: 2,
            user: { id: 'employee-b', name: 'Historical', username: null },
        };
        const timeCardFind = vi.fn().mockResolvedValue([assigned, eligible]);
        const approvalFind = vi.fn().mockResolvedValue([{
            id: 'decision-a', timeCardId: 'card-a', timeCardRevision: 7, decision: 'APPROVED', reason: null,
            decidedAt: new Date('2026-06-09T00:00:00Z'), decidedByUserId: actor.userId,
        }]);
        const tx = {
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue(period()) },
            timeCard: { findMany: timeCardFind },
            payrollTimeCardApproval: { findMany: approvalFind },
            payrollLockedEntry: { findMany: vi.fn().mockResolvedValue([]) },
            user: { findMany: vi.fn() },
            payrollAmendment: { findMany: vi.fn().mockResolvedValue([]) },
            payrollAmendmentDecision: { findMany: vi.fn() },
            payrollExportBatch: { findFirst: vi.fn().mockResolvedValue(null) },
            $queryRaw: vi.fn().mockResolvedValue(summaryRow()),
        };
        const service = new PayrollReadService(db(tx));

        const result = await service.getPeriod(actor, 'period-1', '2');

        expect(result.cards).toMatchObject([
            { id: 'card-a', included: true, adoptionEligible: false, timeCardRevision: 7, payableMinutes: 450 },
            { id: 'card-b', included: false, adoptionEligible: true, timeCardRevision: 2, payableMinutes: 450 },
        ]);
        expect(result.cards[1].user).toEqual({ id: 'employee-b', name: 'Historical', username: '' });
        expect(result.cards[0].decisionIsCurrent).toBe(true);
        expect(result.period.summary.cardCount).toBe(1);
        expect(timeCardFind.mock.calls[0][0].where).toMatchObject({
            tenantId: actor.tenantId,
            deletedAt: null,
            OR: [
                { payrollPeriodId: 'period-1' },
                { payrollPeriodId: null, status: 'CLOSED' },
            ],
        });
        expect(approvalFind.mock.calls[0][0].where.OR).toEqual([
            { timeCardId: 'card-a', timeCardRevision: 7 },
            { timeCardId: 'card-b', timeCardRevision: 2 },
        ]);
        expect(approvalFind.mock.calls[0][0].take).toBe(2);
    });

    it('returns locked entries, source amendments, immutable export lines, hashes, and reconciliation summary', async () => {
        const lockedHash = 'a'.repeat(64);
        const contentHash = 'b'.repeat(64);
        const lineHash = 'c'.repeat(64);
        const lockedEntry = {
            id: 'entry-1', tenantId: actor.tenantId, periodId: 'period-1', sequence: 0,
            sourceType: 'TIME_CARD', sourceId: 'card-1', sourceRevision: 4, employeeId: 'employee-1',
            locationId: null, workTimeZone: 'UTC', clockInAt: new Date('2026-06-02T08:00:00Z'),
            clockOutAt: new Date('2026-06-02T16:00:00Z'), breakMinutes: 30, payableMinutes: 450,
            approvedAt: new Date('2026-06-09T00:00:00Z'), approvedByUserId: 'approver-1',
            canonicalSha256: lockedHash, createdAt: new Date('2026-06-09T00:00:00Z'),
        };
        const amendment = {
            id: 'amendment-1', tenantId: actor.tenantId, lockedEntryId: lockedEntry.id,
            adjustmentPeriodId: 'period-2', requestedByUserId: 'manager-2', reason: 'Correct missed break',
            replacementClockInAt: lockedEntry.clockInAt, replacementClockOutAt: lockedEntry.clockOutAt,
            replacementBreakMinutes: 60, replacementPayableMinutes: 420, minuteDelta: -30,
            createdAt: new Date('2026-06-10T00:00:00Z'), operationId: 'hidden', requestHash: 'hidden',
        };
        const batch = {
            id: 'batch-1', tenantId: actor.tenantId, periodId: 'period-1', formatVersion: 1,
            status: 'RECONCILED', contentSha256: contentHash, rowCount: 1, totalPayableMinutes: 450,
            consumedCredits: 3, newBalance: 9, createdAt: new Date('2026-06-09T00:00:00Z'),
            downloadedAt: new Date('2026-06-09T01:00:00Z'), reconciledAt: new Date('2026-06-10T00:00:00Z'),
            updatedAt: new Date('2026-06-10T00:00:00Z'), operationId: 'hidden', requestHash: 'hidden',
        };
        const line = {
            id: 'line-1', batchId: batch.id, lineNumber: 1, lockedEntryId: lockedEntry.id,
            employeeId: lockedEntry.employeeId, payableMinutes: 450, canonicalSha256: lineHash,
        };
        const tx = {
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue(period({
                status: 'LOCKED', revision: 2, lockedEntrySha256: lockedHash,
                lockedEntryCount: 1, totalPayableMinutes: 450, lockedAt: new Date('2026-06-09T00:00:00Z'),
            })) },
            timeCard: { findMany: vi.fn().mockResolvedValue([]) },
            payrollTimeCardApproval: { findMany: vi.fn() },
            payrollLockedEntry: { findMany: vi.fn().mockResolvedValue([lockedEntry]) },
            user: { findMany: vi.fn().mockResolvedValue([{ id: 'employee-1', name: 'Employee One' }]) },
            payrollAmendment: { findMany: vi.fn().mockResolvedValue([amendment]) },
            payrollAmendmentDecision: { findMany: vi.fn().mockResolvedValue([{
                amendmentId: amendment.id, decision: 'APPROVED', reason: null,
                decidedByUserId: 'approver-2', decidedAt: new Date('2026-06-11T00:00:00Z'),
            }]) },
            payrollExportBatch: { findFirst: vi.fn().mockResolvedValue(batch) },
            payrollExportLine: { findMany: vi.fn().mockResolvedValue([line]) },
            payrollReconciliationLineState: {
                findMany: vi.fn().mockResolvedValue([{
                    lineId: line.id, status: 'ACCEPTED', reason: null,
                }]),
                groupBy: vi.fn().mockResolvedValue([{ status: 'ACCEPTED', _count: { _all: 1 } }]),
            },
            payrollReconciliationReceipt: { findFirst: vi.fn().mockResolvedValue({
                provider: 'provider-a', providerEventId: 'event-1', providerTotalMinutes: 450,
                payloadSha256: 'f'.repeat(64),
                receivedAt: new Date('2026-06-10T00:00:00Z'), id: 'receipt-1',
            }) },
            $queryRaw: vi.fn().mockResolvedValue([{ ...summaryRow()[0], lockedEntryCount: 1 }]),
        };
        const result = await new PayrollReadService(db(tx)).getPeriod(actor, 'period-1');

        expect(result.period.lockedEntrySha256).toBe(lockedHash);
        expect(result.lockedEntries[0]).toMatchObject({
            id: 'entry-1', employeeName: 'Employee One', canonicalSha256: lockedHash,
        });
        expect(result.amendments[0]).toMatchObject({
            id: 'amendment-1', minuteDelta: -30, sourceEmployeeId: 'employee-1',
            decision: { decision: 'APPROVED' },
        });
        expect(result.period.exportBatch).toMatchObject({
            id: 'batch-1', contentSha256: contentHash,
            lines: [{ id: 'line-1', canonicalSha256: lineHash, reconciliationStatus: 'ACCEPTED' }],
            reconciliation: {
                acceptedCount: 1, rejectedCount: 0, pendingCount: 0,
                latestProvider: 'provider-a', latestProviderEventId: 'event-1',
                latestPayloadSha256: 'f'.repeat(64), providerTotalMinutes: 450,
            },
        });
        expect(JSON.stringify(result)).not.toContain('requestHash');
        expect(JSON.stringify(result)).not.toContain('operationId');
    });

    it('resolves source employees for amendments shown from an adjustment period', async () => {
        const amendment = {
            id: 'amendment-1', tenantId: actor.tenantId, lockedEntryId: 'source-entry-1',
            adjustmentPeriodId: 'period-1', requestedByUserId: 'manager-2', reason: 'Correct missed break',
            replacementClockInAt: new Date('2026-05-02T08:00:00Z'),
            replacementClockOutAt: new Date('2026-05-02T16:00:00Z'),
            replacementBreakMinutes: 60, replacementPayableMinutes: 420, minuteDelta: -30,
            createdAt: new Date('2026-06-10T00:00:00Z'), operationId: 'hidden', requestHash: 'hidden',
        };
        const sourceLookup = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: amendment.lockedEntryId, employeeId: 'source-employee-1' }]);
        const tx = {
            payrollPeriod: { findFirst: vi.fn().mockResolvedValue(period({ status: 'REVIEW', revision: 1 })) },
            timeCard: { findMany: vi.fn().mockResolvedValue([]) },
            payrollTimeCardApproval: { findMany: vi.fn() },
            payrollLockedEntry: { findMany: sourceLookup },
            user: { findMany: vi.fn() },
            payrollAmendment: { findMany: vi.fn().mockResolvedValue([amendment]) },
            payrollAmendmentDecision: { findMany: vi.fn().mockResolvedValue([]) },
            payrollExportBatch: { findFirst: vi.fn().mockResolvedValue(null) },
            $queryRaw: vi.fn().mockResolvedValue(summaryRow()),
        };

        const result = await new PayrollReadService(db(tx)).getPeriod(actor, 'period-1');

        expect(result.lockedEntries).toEqual([]);
        expect(result.amendments).toMatchObject([{
            id: amendment.id,
            sourceEmployeeId: 'source-employee-1',
            decision: null,
        }]);
        expect(sourceLookup).toHaveBeenNthCalledWith(2, {
            where: { tenantId: actor.tenantId, id: { in: ['source-entry-1'] } },
            orderBy: { id: 'asc' },
            take: 1,
            select: { id: true, employeeId: true },
        });
    });

    it('pages immutable export lines so line 501 and later remain reachable', async () => {
        const batch = {
            id: 'batch-1', tenantId: actor.tenantId, periodId: 'period-1', formatVersion: 1,
            status: 'RECONCILING', contentSha256: 'd'.repeat(64), rowCount: 501, totalPayableMinutes: 501,
            consumedCredits: 2, newBalance: 8, createdAt: new Date(), downloadedAt: new Date(),
            reconciledAt: null, updatedAt: new Date(),
        };
        const lines = Array.from({ length: 501 }, (_, index) => ({
            id: `line-${index + 1}`, lineNumber: index + 1, lockedEntryId: `entry-${index + 1}`,
            employeeId: `employee-${index + 1}`, payableMinutes: 1, canonicalSha256: 'e'.repeat(64),
        }));
        const findMany = vi.fn(async (args: any) => (
            args.where.lineNumber?.gt === 500 ? [lines[500]] : lines
        ));
        const tx = {
            payrollExportBatch: { findFirst: vi.fn().mockResolvedValue(batch) },
            payrollExportLine: {
                findFirst: vi.fn().mockResolvedValue({ lineNumber: 500 }),
                findMany,
            },
            payrollReconciliationLineState: {
                findMany: vi.fn().mockResolvedValue([]),
                groupBy: vi.fn().mockResolvedValue([]),
            },
            payrollReconciliationReceipt: { findFirst: vi.fn().mockResolvedValue(null) },
        };
        const service = new PayrollReadService(db(tx));

        const first = await service.getExport(actor, batch.id, '500');
        const second = await service.getExport(actor, batch.id, '500', 'line-500');

        expect(first.lines).toHaveLength(500);
        expect(first.nextLineCursor).toBe('line-500');
        expect(first.reconciliation.pendingCount).toBe(501);
        expect(second.lines.map((line: any) => line.id)).toEqual(['line-501']);
        expect(second.nextLineCursor).toBeNull();
        expect(findMany.mock.calls[1][0].where.lineNumber).toEqual({ gt: 500 });
    });
});
