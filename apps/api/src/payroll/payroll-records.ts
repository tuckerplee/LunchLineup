import { serializeDateOnly } from './payroll-policy';

export type PayrollPeriodSummary = {
    cardCount: number;
    closedCardCount: number;
    approvedCardCount: number;
    rejectedCardCount: number;
    pendingCardCount: number;
    amendmentCount: number;
    pendingAmendmentCount: number;
    approvedAmendmentCount: number;
    lockedEntryCount: number;
};

export function serializePayrollPolicy(row: any) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        version: row.version,
        timeZone: row.timeZone,
        cadence: row.cadence,
        anchorDate: serializeDateOnly(row.anchorDate),
        effectiveFrom: serializeDateOnly(row.effectiveFrom),
        createdByUserId: row.createdByUserId,
        createdAt: requiredDate(row.createdAt).toISOString(),
    };
}

export function serializePayrollPeriod(row: any) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        policyVersionId: row.policyVersionId,
        localStartDate: serializeDateOnly(row.localStartDate),
        localEndDateExclusive: serializeDateOnly(row.localEndDateExclusive),
        startsAt: requiredDate(row.startsAt).toISOString(),
        endsAt: requiredDate(row.endsAt).toISOString(),
        timeZone: row.timeZone,
        cadence: row.cadence,
        status: row.status,
        revision: row.revision,
        reviewStartedAt: optionalDate(row.reviewStartedAt),
        reviewStartedByUserId: row.reviewStartedByUserId ?? null,
        lockedAt: optionalDate(row.lockedAt),
        lockedByUserId: row.lockedByUserId ?? null,
        lockedEntrySha256: row.lockedEntrySha256 ?? null,
        lockedEntryCount: row.lockedEntryCount ?? null,
        totalPayableMinutes: row.totalPayableMinutes ?? null,
        createdAt: requiredDate(row.createdAt).toISOString(),
        updatedAt: requiredDate(row.updatedAt).toISOString(),
    };
}

export function serializePayrollExport(row: any) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        periodId: row.periodId,
        formatVersion: row.formatVersion,
        status: row.status,
        contentSha256: row.contentSha256,
        rowCount: row.rowCount,
        totalPayableMinutes: row.totalPayableMinutes,
        settlement: {
            consumedCredits: row.consumedCredits,
            newBalance: row.newBalance,
        },
        createdAt: requiredDate(row.createdAt).toISOString(),
        downloadedAt: optionalDate(row.downloadedAt),
        reconciledAt: optionalDate(row.reconciledAt),
        updatedAt: requiredDate(row.updatedAt).toISOString(),
    };
}

export function serializePayrollLockedEntry(row: any, employeeName: string | null = null) {
    return {
        id: row.id,
        sequence: row.sequence,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        sourceRevision: row.sourceRevision,
        employeeId: row.employeeId,
        employeeName,
        locationId: row.locationId ?? null,
        workTimeZone: row.workTimeZone,
        clockInAt: requiredDate(row.clockInAt).toISOString(),
        clockOutAt: requiredDate(row.clockOutAt).toISOString(),
        breakMinutes: row.breakMinutes,
        payableMinutes: row.payableMinutes,
        approvedAt: requiredDate(row.approvedAt).toISOString(),
        approvedByUserId: row.approvedByUserId,
        canonicalSha256: row.canonicalSha256,
    };
}

export function serializePayrollExportLine(row: any, state?: any) {
    return {
        id: row.id,
        lineNumber: row.lineNumber,
        lockedEntryId: row.lockedEntryId,
        employeeId: row.employeeId,
        payableMinutes: row.payableMinutes,
        canonicalSha256: row.canonicalSha256,
        reconciliationStatus: state?.status ?? 'PENDING',
        reconciliationReason: state?.reason ?? null,
    };
}

export function serializePayrollAmendmentDecision(row: any) {
    if (!row) return null;
    return {
        decision: row.decision,
        reason: row.reason ?? null,
        decidedByUserId: row.decidedByUserId,
        decidedAt: requiredDate(row.decidedAt).toISOString(),
    };
}

export function serializePayrollAmendment(row: any) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        lockedEntryId: row.lockedEntryId,
        adjustmentPeriodId: row.adjustmentPeriodId,
        requestedByUserId: row.requestedByUserId,
        reason: row.reason,
        replacementClockInAt: requiredDate(row.replacementClockInAt).toISOString(),
        replacementClockOutAt: requiredDate(row.replacementClockOutAt).toISOString(),
        replacementBreakMinutes: row.replacementBreakMinutes,
        replacementPayableMinutes: row.replacementPayableMinutes,
        minuteDelta: row.minuteDelta,
        createdAt: requiredDate(row.createdAt).toISOString(),
    };
}

export function serializePayrollReceipt(row: any) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        batchId: row.batchId,
        provider: row.provider,
        providerEventId: row.providerEventId,
        payloadSha256: row.payloadSha256,
        providerTotalMinutes: row.providerTotalMinutes,
        acceptedCount: row.acceptedCount,
        rejectedCount: row.rejectedCount,
        pendingCount: row.pendingCount,
        receivedByUserId: row.receivedByUserId,
        receivedAt: requiredDate(row.receivedAt).toISOString(),
    };
}

function optionalDate(value: unknown): string | null {
    return value ? requiredDate(value).toISOString() : null;
}

function requiredDate(value: unknown): Date {
    const date = value instanceof Date ? value : new Date(String(value));
    if (!Number.isFinite(date.getTime())) throw new Error('Stored payroll date/time is invalid.');
    return date;
}
