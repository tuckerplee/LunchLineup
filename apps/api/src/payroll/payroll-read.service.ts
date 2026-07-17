import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantPrismaService, type TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { payrollWorkedMinutes } from './payroll-csv';
import { isHistoricalPayrollCardInWindow } from './payroll-period-cards';
import { loadPayrollPeriodSummary } from './payroll-period-summary';
import {
    serializePayrollAmendment,
    serializePayrollAmendmentDecision,
    serializePayrollExport,
    serializePayrollExportLine,
    serializePayrollLockedEntry,
    serializePayrollPeriod,
} from './payroll-records';
import type { PayrollActor } from './payroll-transaction';
import {
    MAX_PAYROLL_CARD_PAGE_SIZE,
    MAX_PAYROLL_EXPORT_LINE_PAGE_SIZE,
    MAX_PAYROLL_LOCK_ENTRIES,
    parseBoundedLimit,
    parseOpaqueCursor,
    requiredId,
} from './payroll-validation';

@Injectable()
export class PayrollReadService {
    constructor(private readonly tenantDb: TenantPrismaService) {}

    async getPeriod(
        actor: PayrollActor,
        periodIdRaw: unknown,
        cardLimitRaw?: unknown,
        cardCursorRaw?: unknown,
        lineLimitRaw?: unknown,
        lineCursorRaw?: unknown,
    ) {
        const periodId = requiredId(periodIdRaw, 'periodId');
        const cardLimit = parseBoundedLimit(cardLimitRaw, {
            field: 'cardLimit',
            defaultValue: 100,
            maximum: MAX_PAYROLL_CARD_PAGE_SIZE,
        });
        const cardCursor = parseOpaqueCursor(cardCursorRaw, 'cardCursor');
        const lineLimit = this.lineLimit(lineLimitRaw);
        const lineCursor = parseOpaqueCursor(lineCursorRaw, 'lineCursor');

        return this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            const period = await tx.payrollPeriod.findFirst({ where: { id: periodId, tenantId: actor.tenantId } });
            if (!period) throw new NotFoundException('Payroll period not found.');

            const rows = await tx.timeCard.findMany({
                where: period.status === 'OPEN' ? {
                    tenantId: actor.tenantId,
                    deletedAt: null,
                    OR: [
                        { payrollPeriodId: period.id },
                        {
                            payrollPeriodId: null,
                            status: 'CLOSED',
                            clockInAt: { gte: period.startsAt, lt: period.endsAt },
                            clockOutAt: { not: null, lte: period.endsAt },
                        },
                    ],
                } : {
                    tenantId: actor.tenantId,
                    payrollPeriodId: period.id,
                    deletedAt: null,
                },
                orderBy: [{ id: 'asc' }],
                take: cardLimit + 1,
                ...(cardCursor ? { cursor: { id: cardCursor }, skip: 1 } : {}),
                select: {
                    id: true,
                    userId: true,
                    locationId: true,
                    payrollPeriodId: true,
                    workTimeZone: true,
                    clockInAt: true,
                    clockOutAt: true,
                    breakMinutes: true,
                    status: true,
                    revision: true,
                    updatedAt: true,
                    user: { select: { id: true, name: true, username: true } },
                },
            });
            const page = rows.slice(0, cardLimit);
            const approvals = page.length === 0 ? [] : await tx.payrollTimeCardApproval.findMany({
                where: {
                    tenantId: actor.tenantId,
                    periodId: period.id,
                    OR: page.map((card) => ({
                        timeCardId: card.id,
                        timeCardRevision: card.revision,
                    })),
                },
                orderBy: [{ timeCardId: 'asc' }],
                take: page.length,
            });
            const currentDecision = new Map(
                approvals.map((approval) => [`${approval.timeCardId}:${approval.timeCardRevision}`, approval]),
            );
            const lockedEntries = await this.lockedEntries(tx, actor.tenantId, period.id);
            const amendments = await this.amendments(tx, actor.tenantId, period, lockedEntries.map((row) => row.id));
            const exportBatch = await this.exportForPeriod(
                tx,
                actor.tenantId,
                period.id,
                lineLimit,
                lineCursor,
            );
            const summary = await loadPayrollPeriodSummary(tx, actor.tenantId, period.id);

            return {
                period: {
                    ...serializePayrollPeriod(period),
                    summary,
                    exportBatch,
                },
                cards: page.map((card) => {
                    const decision = currentDecision.get(`${card.id}:${card.revision}`);
                    const payableMinutes = this.cardPayableMinutes(card.clockInAt, card.clockOutAt, card.breakMinutes);
                    const included = card.payrollPeriodId === period.id;
                    const adoptionEligible = period.status === 'OPEN'
                        && isHistoricalPayrollCardInWindow(card, period)
                        && payableMinutes !== null;
                    return {
                        id: card.id,
                        timeCardRevision: card.revision,
                        user: {
                            id: card.user.id,
                            name: card.user.name,
                            username: card.user.username ?? '',
                        },
                        locationId: card.locationId,
                        clockInAt: card.clockInAt.toISOString(),
                        clockOutAt: card.clockOutAt?.toISOString() ?? '',
                        breakMinutes: card.breakMinutes,
                        payableMinutes: payableMinutes ?? 0,
                        updatedAt: card.updatedAt.toISOString(),
                        displayTimeZone: card.workTimeZone || period.timeZone,
                        included,
                        adoptionEligible,
                        decision: this.serializeApproval(decision),
                        decisionIsCurrent: Boolean(decision),
                    };
                }),
                nextCardCursor: rows.length > cardLimit && page.length > 0 ? page[page.length - 1].id : null,
                lockedEntries: lockedEntries.map((row) => row.serialized),
                amendments,
            };
        });
    }

    async getExport(actor: PayrollActor, batchIdRaw: unknown, lineLimitRaw?: unknown, lineCursorRaw?: unknown) {
        const batchId = requiredId(batchIdRaw, 'exportId');
        const lineLimit = this.lineLimit(lineLimitRaw);
        const lineCursor = parseOpaqueCursor(lineCursorRaw, 'lineCursor');
        return this.tenantDb.withTenant(actor.tenantId, async (tx) => {
            const batch = await tx.payrollExportBatch.findFirst({
                where: { id: batchId, tenantId: actor.tenantId },
            });
            if (!batch) throw new NotFoundException('Payroll export not found.');
            return this.serializeExportPage(tx, actor.tenantId, batch, lineLimit, lineCursor);
        });
    }

    private async lockedEntries(tx: TenantPrismaTransaction, tenantId: string, periodId: string) {
        const rows = await tx.payrollLockedEntry.findMany({
            where: { tenantId, periodId },
            orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
            take: MAX_PAYROLL_LOCK_ENTRIES + 1,
        });
        if (rows.length > MAX_PAYROLL_LOCK_ENTRIES) {
            throw new ConflictException('Stored payroll locked-entry count exceeds the supported limit.');
        }
        const employeeIds = [...new Set(rows.map((row) => row.employeeId))];
        const users = employeeIds.length === 0 ? [] : await tx.user.findMany({
            where: { tenantId, id: { in: employeeIds } },
            orderBy: { id: 'asc' },
            take: employeeIds.length,
            select: { id: true, name: true },
        });
        const names = new Map(users.map((user) => [user.id, user.name]));
        return rows.map((row) => ({
            id: row.id,
            serialized: serializePayrollLockedEntry(row, names.get(row.employeeId) ?? null),
        }));
    }

    private async amendments(
        tx: TenantPrismaTransaction,
        tenantId: string,
        period: { id: string; status: string },
        lockedEntryIds: string[],
    ) {
        const rows = await tx.payrollAmendment.findMany({
            where: period.status === 'LOCKED'
                ? {
                    tenantId,
                    OR: [
                        { adjustmentPeriodId: period.id },
                        ...(lockedEntryIds.length > 0 ? [{ lockedEntryId: { in: lockedEntryIds } }] : []),
                    ],
                }
                : { tenantId, adjustmentPeriodId: period.id },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: MAX_PAYROLL_LOCK_ENTRIES + 1,
        });
        if (rows.length > MAX_PAYROLL_LOCK_ENTRIES) {
            throw new ConflictException('Stored payroll amendment count exceeds the supported limit.');
        }
        const decisions = rows.length === 0 ? [] : await tx.payrollAmendmentDecision.findMany({
            where: { tenantId, amendmentId: { in: rows.map((row) => row.id) } },
            orderBy: { amendmentId: 'asc' },
            take: rows.length,
        });
        const byAmendment = new Map(decisions.map((decision) => [decision.amendmentId, decision]));
        const sourceIds = [...new Set(rows.map((row) => row.lockedEntryId))];
        const sources = sourceIds.length === 0 ? [] : await tx.payrollLockedEntry.findMany({
            where: { tenantId, id: { in: sourceIds } },
            orderBy: { id: 'asc' },
            take: sourceIds.length,
            select: { id: true, employeeId: true },
        });
        const sourceEmployeeByEntry = new Map(sources.map((source) => [source.id, source.employeeId]));
        return rows.map((row) => ({
            ...serializePayrollAmendment(row),
            sourceEmployeeId: sourceEmployeeByEntry.get(row.lockedEntryId) ?? null,
            decision: serializePayrollAmendmentDecision(byAmendment.get(row.id)),
        }));
    }

    private async exportForPeriod(
        tx: TenantPrismaTransaction,
        tenantId: string,
        periodId: string,
        lineLimit: number,
        lineCursor: string | null,
    ) {
        const batch = await tx.payrollExportBatch.findFirst({ where: { tenantId, periodId } });
        return batch ? this.serializeExportPage(tx, tenantId, batch, lineLimit, lineCursor) : null;
    }

    private async serializeExportPage(
        tx: TenantPrismaTransaction,
        tenantId: string,
        batch: any,
        lineLimit: number,
        lineCursor: string | null,
    ) {
        let afterLineNumber: number | null = null;
        if (lineCursor) {
            const cursor = await tx.payrollExportLine.findFirst({
                where: { id: lineCursor, tenantId, batchId: batch.id },
                select: { lineNumber: true },
            });
            if (!cursor) throw new BadRequestException('lineCursor is invalid for this payroll export.');
            afterLineNumber = cursor.lineNumber;
        }
        const rows = await tx.payrollExportLine.findMany({
            where: {
                tenantId,
                batchId: batch.id,
                ...(afterLineNumber === null ? {} : { lineNumber: { gt: afterLineNumber } }),
            },
            orderBy: [{ lineNumber: 'asc' }, { id: 'asc' }],
            take: lineLimit + 1,
        });
        const page = rows.slice(0, lineLimit);
        const states = page.length === 0 ? [] : await tx.payrollReconciliationLineState.findMany({
            where: { tenantId, batchId: batch.id, lineId: { in: page.map((line) => line.id) } },
            orderBy: { lineId: 'asc' },
            take: page.length,
        });
        const stateByLine = new Map(states.map((state) => [state.lineId, state]));
        const stateCounts = await tx.payrollReconciliationLineState.groupBy({
            by: ['status'],
            where: { tenantId, batchId: batch.id },
            _count: { _all: true },
        });
        const countByStatus = new Map(stateCounts.map((row) => [row.status, row._count._all]));
        const acceptedCount = countByStatus.get('ACCEPTED') ?? 0;
        const rejectedCount = countByStatus.get('REJECTED') ?? 0;
        const pendingCount = batch.rowCount - acceptedCount - rejectedCount;
        if (pendingCount < 0) throw new ConflictException('Stored payroll reconciliation counts are invalid.');
        const latestReceipt = await tx.payrollReconciliationReceipt.findFirst({
            where: { tenantId, batchId: batch.id },
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        });
        return {
            ...serializePayrollExport(batch),
            lines: page.map((line) => serializePayrollExportLine(line, stateByLine.get(line.id))),
            nextLineCursor: rows.length > lineLimit && page.length > 0 ? page[page.length - 1].id : null,
            reconciliation: {
                acceptedCount,
                rejectedCount,
                pendingCount,
                providerTotalMinutes: latestReceipt?.providerTotalMinutes ?? null,
                latestProvider: latestReceipt?.provider ?? null,
                latestProviderEventId: latestReceipt?.providerEventId ?? null,
                latestPayloadSha256: latestReceipt?.payloadSha256 ?? null,
            },
        };
    }

    private lineLimit(value: unknown): number {
        return parseBoundedLimit(value, {
            field: 'lineLimit',
            defaultValue: MAX_PAYROLL_EXPORT_LINE_PAGE_SIZE,
            maximum: MAX_PAYROLL_EXPORT_LINE_PAGE_SIZE,
        });
    }

    private cardPayableMinutes(clockInAt: Date, clockOutAt: Date | null, breakMinutes: number): number | null {
        if (!clockOutAt) return null;
        try {
            return payrollWorkedMinutes({ clockInAt, clockOutAt, breakMinutes });
        } catch {
            return null;
        }
    }

    private serializeApproval(value: any) {
        if (!value) return null;
        return {
            id: value.id,
            timeCardId: value.timeCardId,
            timeCardRevision: value.timeCardRevision,
            decision: value.decision,
            reason: value.reason ?? null,
            decidedAt: value.decidedAt.toISOString(),
            decidedByUserId: value.decidedByUserId,
        };
    }
}
