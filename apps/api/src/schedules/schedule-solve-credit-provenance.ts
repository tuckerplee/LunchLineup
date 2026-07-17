import type { Prisma } from '@prisma/client';

const MAX_WALLET_CREDITS = 2_147_483_647;
const ACTIVE_STATUSES = new Set(['QUEUED', 'RUNNING', 'RETRYING']);
const REFUNDED_STATUSES = new Set(['FAILED', 'DEAD_LETTERED']);

export type ScheduleSolveCreditRow = {
    id: string;
    tenantId: string;
    amount: number | bigint;
    reason: string;
};

export type ScheduleSolveCreditRowSummary = {
    count: number | bigint;
    tenantId: string | null;
    amount: number | bigint | null;
    reason: string | null;
};

export type ScheduleSolveCreditProvenance = {
    consumedCredits: number;
    newBalance: number;
    debit: ScheduleSolveCreditRowSummary;
    refund: ScheduleSolveCreditRowSummary;
};

export class ScheduleSolveCreditProvenanceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ScheduleSolveCreditProvenanceError';
    }
}

export function summarizeScheduleSolveCreditRows(
    jobId: string,
    rows: ScheduleSolveCreditRow[],
): { debit: ScheduleSolveCreditRowSummary; refund: ScheduleSolveCreditRowSummary } {
    return {
        debit: summarize(rows.filter((row) => row.id === `schedule-credit-${jobId}`)),
        refund: summarize(rows.filter((row) => row.id === `schedule-credit-refund-${jobId}`)),
    };
}

export function assertScheduleSolveCreditProvenance(args: {
    jobId: string;
    tenantId: string;
    status: string;
    creditConsumption: Prisma.JsonValue | null;
    debit: ScheduleSolveCreditRowSummary;
    refund: ScheduleSolveCreditRowSummary;
}): ScheduleSolveCreditProvenance {
    const metadata = parseCreditConsumption(args.creditConsumption);
    const debitAmount = integer(args.debit.amount);
    const debitIsExact = count(args.debit.count) === 1
        && args.debit.tenantId === args.tenantId
        && debitAmount === -metadata.consumedCredits
        && args.debit.reason === `Schedule generation (${args.jobId})`;
    if (!debitIsExact) {
        throw new ScheduleSolveCreditProvenanceError('Schedule solve debit provenance is invalid.');
    }

    const refundCount = count(args.refund.count);
    const refundIsExact = refundCount === 1
        && args.refund.tenantId === args.tenantId
        && integer(args.refund.amount) === metadata.consumedCredits
        && args.refund.reason === `Schedule generation refund (${args.jobId})`;

    if (REFUNDED_STATUSES.has(args.status)) {
        if (!refundIsExact) {
            throw new ScheduleSolveCreditProvenanceError('Schedule solve refund provenance is invalid.');
        }
    } else if (ACTIVE_STATUSES.has(args.status) || args.status === 'SUCCEEDED') {
        if (refundCount !== 0) {
            throw new ScheduleSolveCreditProvenanceError(
                'Schedule solve debit and deterministic refund cannot coexist for this status.',
            );
        }
    } else {
        throw new ScheduleSolveCreditProvenanceError('Schedule solve status provenance is invalid.');
    }

    return {
        ...metadata,
        debit: args.debit,
        refund: args.refund,
    };
}

function parseCreditConsumption(value: Prisma.JsonValue | null): {
    consumedCredits: number;
    newBalance: number;
} {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ScheduleSolveCreditProvenanceError('Schedule solve credit metadata is invalid.');
    }
    const keys = Object.keys(value).sort();
    const consumedCredits = value.consumedCredits;
    const newBalance = value.newBalance;
    if (
        keys.join(',') !== 'consumedCredits,newBalance,source'
        || value.source !== 'credits'
        || typeof consumedCredits !== 'number'
        || !Number.isSafeInteger(consumedCredits)
        || consumedCredits <= 0
        || consumedCredits > MAX_WALLET_CREDITS
        || typeof newBalance !== 'number'
        || !Number.isSafeInteger(newBalance)
        || newBalance < 0
        || newBalance > MAX_WALLET_CREDITS
        || consumedCredits > MAX_WALLET_CREDITS - newBalance
    ) {
        throw new ScheduleSolveCreditProvenanceError('Schedule solve credit metadata is invalid.');
    }
    return { consumedCredits, newBalance };
}

function summarize(rows: ScheduleSolveCreditRow[]): ScheduleSolveCreditRowSummary {
    return {
        count: rows.length,
        tenantId: rows.length === 1 ? rows[0].tenantId : null,
        amount: rows.length === 1 ? rows[0].amount : null,
        reason: rows.length === 1 ? rows[0].reason : null,
    };
}

function count(value: number | bigint): number | null {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function integer(value: number | bigint | null): number | null {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}
