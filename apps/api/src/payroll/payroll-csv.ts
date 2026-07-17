import { createHash } from 'crypto';

import { canonicalSha256 } from './payroll-idempotency';

export const PAYROLL_CSV_HEADER = [
    'payroll_line_id',
    'source_type',
    'source_id',
    'employee_id',
    'location_id',
    'work_time_zone',
    'clock_in_utc',
    'clock_out_utc',
    'break_minutes',
    'payable_minutes',
] as const;

export type PayrollCsvLine = {
    id: string;
    lineNumber: number;
    sourceType: 'TIME_CARD' | 'AMENDMENT';
    sourceId: string;
    employeeId: string;
    locationId: string | null;
    workTimeZone: string;
    clockInAt: Date | string;
    clockOutAt: Date | string;
    breakMinutes: number;
    payableMinutes: number;
};

export function payrollWorkedMinutes(entry: {
    clockInAt: Date | string;
    clockOutAt: Date | string;
    breakMinutes: number;
}): number {
    const clockInAt = requiredDate(entry.clockInAt);
    const clockOutAt = requiredDate(entry.clockOutAt);
    if (!Number.isSafeInteger(entry.breakMinutes) || entry.breakMinutes < 0) {
        throw new Error('Stored payroll break minutes are invalid.');
    }
    const elapsedMilliseconds = clockOutAt.getTime() - clockInAt.getTime();
    const grossMinutes = Math.floor(elapsedMilliseconds / 60_000);
    const workedMinutes = grossMinutes - entry.breakMinutes;
    if (elapsedMilliseconds <= 0 || !Number.isSafeInteger(grossMinutes) || workedMinutes < 0) {
        throw new Error('Stored payroll time-card duration is invalid.');
    }
    return workedMinutes;
}

export function buildPayrollCsv(lines: PayrollCsvLine[]): Buffer {
    const ordered = [...lines].sort((left, right) => left.lineNumber - right.lineNumber || compareText(left.id, right.id));
    ordered.forEach((line, index) => {
        if (line.lineNumber !== index + 1) throw new Error('Stored payroll line sequence is invalid.');
    });
    const rows = ordered.map((line) => [
        line.id,
        line.sourceType,
        line.sourceId,
        line.employeeId,
        line.locationId ?? '',
        line.workTimeZone,
        requiredDate(line.clockInAt).toISOString(),
        requiredDate(line.clockOutAt).toISOString(),
        unsignedIntegerCell(line.breakMinutes),
        signedIntegerCell(line.payableMinutes),
    ].map(csvCell).join(','));
    return Buffer.from(`${PAYROLL_CSV_HEADER.join(',')}\n${rows.length > 0 ? `${rows.join('\n')}\n` : ''}`, 'utf8');
}

export function payrollContentSha256(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex');
}

export function payrollExportLineSha256(args: {
    tenantId: string;
    batchId: string;
    lockedEntryId: string;
    line: PayrollCsvLine;
}): string {
    return canonicalSha256({
        body: {
            batchId: args.batchId,
            lockedEntryId: args.lockedEntryId,
            ...args.line,
            clockInAt: requiredDate(args.line.clockInAt).toISOString(),
            clockOutAt: requiredDate(args.line.clockOutAt).toISOString(),
        },
        operation: 'EXPORT_LINE',
        tenantId: args.tenantId,
    });
}

function csvCell(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function unsignedIntegerCell(value: number): string {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Stored payroll CSV integer is invalid.');
    return String(value);
}

function signedIntegerCell(value: number): string {
    if (!Number.isSafeInteger(value)) throw new Error('Stored payroll CSV integer is invalid.');
    return String(value);
}

function requiredDate(value: Date | string): Date {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('Stored payroll instant is invalid.');
    return date;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
