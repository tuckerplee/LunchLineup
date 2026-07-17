import { Prisma } from '@prisma/client';

import type { TenantPrismaTransaction } from '../database/tenant-prisma.service';
import type { PayrollPeriodSummary } from './payroll-records';

export async function loadPayrollPeriodSummary(
    tx: TenantPrismaTransaction,
    tenantId: string,
    periodId: string,
): Promise<PayrollPeriodSummary> {
    const summaries = await loadPayrollPeriodSummaries(tx, tenantId, [periodId]);
    return summaries.get(periodId) ?? emptyPayrollPeriodSummary();
}

export async function loadPayrollPeriodSummaries(
    tx: TenantPrismaTransaction,
    tenantId: string,
    periodIds: string[],
): Promise<Map<string, PayrollPeriodSummary>> {
    if (periodIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<Array<Record<string, string | number | bigint>>>`
        SELECT
            period."id" AS "periodId",
            count(card.*)::integer AS "cardCount",
            count(card.*) FILTER (WHERE card."status" = 'CLOSED')::integer AS "closedCardCount",
            count(approval.*) FILTER (WHERE approval."decision" = 'APPROVED')::integer AS "approvedCardCount",
            count(approval.*) FILTER (WHERE approval."decision" = 'REJECTED')::integer AS "rejectedCardCount",
            (SELECT count(*)::integer FROM "PayrollAmendment" amendment
                WHERE amendment."tenantId" = ${tenantId}
                  AND amendment."adjustmentPeriodId" = period."id") AS "amendmentCount",
            (SELECT count(*)::integer FROM "PayrollAmendment" amendment
                LEFT JOIN "PayrollAmendmentDecision" decision
                  ON decision."tenantId" = amendment."tenantId" AND decision."amendmentId" = amendment."id"
                WHERE amendment."tenantId" = ${tenantId}
                  AND amendment."adjustmentPeriodId" = period."id"
                  AND decision."id" IS NULL) AS "pendingAmendmentCount",
            (SELECT count(*)::integer FROM "PayrollAmendment" amendment
                JOIN "PayrollAmendmentDecision" decision
                  ON decision."tenantId" = amendment."tenantId" AND decision."amendmentId" = amendment."id"
                WHERE amendment."tenantId" = ${tenantId}
                  AND amendment."adjustmentPeriodId" = period."id"
                  AND decision."decision" = 'APPROVED') AS "approvedAmendmentCount",
            (SELECT count(*)::integer FROM "PayrollLockedEntry" entry
                WHERE entry."tenantId" = ${tenantId}
                  AND entry."periodId" = period."id") AS "lockedEntryCount"
        FROM "PayrollPeriod" period
        LEFT JOIN "TimeCard" card
          ON card."tenantId" = period."tenantId"
         AND card."payrollPeriodId" = period."id"
         AND card."deletedAt" IS NULL
        LEFT JOIN "PayrollTimeCardApproval" approval
          ON approval."tenantId" = card."tenantId"
         AND approval."periodId" = period."id"
         AND approval."timeCardId" = card."id"
         AND approval."timeCardRevision" = card."revision"
        WHERE period."tenantId" = ${tenantId}
          AND period."id" IN (${Prisma.join(periodIds)})
        GROUP BY period."id"
    `;
    return new Map(rows.map((row) => {
        const closedCardCount = countValue(row.closedCardCount as number | bigint | undefined);
        const approvedCardCount = countValue(row.approvedCardCount as number | bigint | undefined);
        const rejectedCardCount = countValue(row.rejectedCardCount as number | bigint | undefined);
        return [String(row.periodId), {
            cardCount: countValue(row.cardCount as number | bigint | undefined),
            closedCardCount,
            approvedCardCount,
            rejectedCardCount,
            pendingCardCount: Math.max(0, closedCardCount - approvedCardCount - rejectedCardCount),
            amendmentCount: countValue(row.amendmentCount as number | bigint | undefined),
            pendingAmendmentCount: countValue(row.pendingAmendmentCount as number | bigint | undefined),
            approvedAmendmentCount: countValue(row.approvedAmendmentCount as number | bigint | undefined),
            lockedEntryCount: countValue(row.lockedEntryCount as number | bigint | undefined),
        }];
    }));
}

function emptyPayrollPeriodSummary(): PayrollPeriodSummary {
    return {
        cardCount: 0, closedCardCount: 0, approvedCardCount: 0, rejectedCardCount: 0,
        pendingCardCount: 0, amendmentCount: 0, pendingAmendmentCount: 0,
        approvedAmendmentCount: 0, lockedEntryCount: 0,
    };
}

function countValue(value: number | bigint | undefined): number {
    const count = Number(value ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Stored payroll count is invalid.');
    return count;
}
