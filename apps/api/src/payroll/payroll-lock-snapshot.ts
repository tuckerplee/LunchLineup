import { canonicalSha256 } from './payroll-idempotency';

export type LockedEntrySource = {
    sourceType: 'TIME_CARD' | 'AMENDMENT';
    sourceId: string;
    sourceRevision: number;
    employeeId: string;
    locationId: string | null;
    workTimeZone: string;
    clockInAt: Date | string;
    clockOutAt: Date | string;
    breakMinutes: number;
    payableMinutes: number;
    approvedAt: Date | string;
    approvedByUserId: string;
    breakIntervals?: Array<{ startAt: Date | string; endAt: Date | string }>;
};

export type LockedEntrySnapshot = LockedEntrySource & {
    sequence: number;
    canonicalSha256: string;
};

export function materializeLockedSnapshots(args: {
    tenantId: string;
    periodId: string;
    sources: LockedEntrySource[];
}): { entries: LockedEntrySnapshot[]; aggregateSha256: string; totalPayableMinutes: number } {
    const ordered = [...args.sources].sort(compareLockedSources);
    const entries = ordered.map((source, sequence) => {
        const normalized = normalizeSource(source);
        return {
            ...source,
            sequence,
            canonicalSha256: canonicalSha256({
                body: normalized,
                operation: 'LOCK_ENTRY',
                periodId: args.periodId,
                tenantId: args.tenantId,
            }),
        };
    });
    const totalPayableMinutes = entries.reduce((total, entry) => safeAdd(total, entry.payableMinutes), 0);
    return {
        entries,
        totalPayableMinutes,
        aggregateSha256: payrollLockAggregateSha256({
            tenantId: args.tenantId,
            periodId: args.periodId,
            entryHashes: entries.map((entry) => entry.canonicalSha256),
            totalPayableMinutes,
        }),
    };
}

export function payrollLockAggregateSha256(args: {
    tenantId: string;
    periodId: string;
    entryHashes: string[];
    totalPayableMinutes: number;
}): string {
    if (!Number.isSafeInteger(args.totalPayableMinutes)) {
        throw new Error('Payroll payable total is invalid.');
    }
    if (args.entryHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
        throw new Error('Payroll entry hash is invalid.');
    }
    return canonicalSha256({
        body: {
            count: args.entryHashes.length,
            entryHashes: args.entryHashes,
            totalPayableMinutes: args.totalPayableMinutes,
        },
        operation: 'LOCK_AGGREGATE',
        periodId: args.periodId,
        tenantId: args.tenantId,
    });
}

function normalizeSource(source: LockedEntrySource) {
    return {
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        employeeId: source.employeeId,
        locationId: source.locationId,
        workTimeZone: source.workTimeZone,
        clockInAt: requiredDate(source.clockInAt).toISOString(),
        clockOutAt: requiredDate(source.clockOutAt).toISOString(),
        breakMinutes: source.breakMinutes,
        payableMinutes: source.payableMinutes,
        approvedAt: requiredDate(source.approvedAt).toISOString(),
        approvedByUserId: source.approvedByUserId,
        breakIntervals: [...(source.breakIntervals ?? [])]
            .map((entry) => ({
                startAt: requiredDate(entry.startAt).toISOString(),
                endAt: requiredDate(entry.endAt).toISOString(),
            }))
            .sort((left, right) => compareText(left.startAt, right.startAt) || compareText(left.endAt, right.endAt)),
    };
}

function compareLockedSources(left: LockedEntrySource, right: LockedEntrySource): number {
    return compareText(left.employeeId, right.employeeId)
        || requiredDate(left.clockInAt).getTime() - requiredDate(right.clockInAt).getTime()
        || compareText(left.sourceType, right.sourceType)
        || compareText(left.sourceId, right.sourceId);
}

function safeAdd(left: number, right: number): number {
    const value = left + right;
    if (!Number.isSafeInteger(value)) throw new Error('Payroll payable total is invalid.');
    return value;
}

function requiredDate(value: Date | string): Date {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Payroll snapshot instant is invalid.');
    return date;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
