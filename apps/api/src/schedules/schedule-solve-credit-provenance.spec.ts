import { describe, expect, it } from 'vitest';
import {
    assertScheduleSolveCreditProvenance,
    summarizeScheduleSolveCreditRows,
} from './schedule-solve-credit-provenance';

const debit = {
    id: 'schedule-credit-job-1',
    tenantId: 'tenant-1',
    amount: -1,
    reason: 'Schedule generation (job-1)',
};
const refund = {
    id: 'schedule-credit-refund-job-1',
    tenantId: 'tenant-1',
    amount: 1,
    reason: 'Schedule generation refund (job-1)',
};

function validate(status: string, rows = [debit], creditConsumption: any = {
    source: 'credits', consumedCredits: 1, newBalance: 4,
}) {
    return assertScheduleSolveCreditProvenance({
        jobId: 'job-1',
        tenantId: 'tenant-1',
        status,
        creditConsumption,
        ...summarizeScheduleSolveCreditRows('job-1', rows),
    });
}

describe('schedule solve credit provenance', () => {
    it('accepts active, successful, and exact refunded terminal replays', () => {
        expect(validate('RUNNING').consumedCredits).toBe(1);
        expect(validate('SUCCEEDED').newBalance).toBe(4);
        expect(validate('FAILED', [debit, refund]).refund.count).toBe(1);
        expect(validate('DEAD_LETTERED', [debit, refund]).refund.count).toBe(1);
    });

    it.each([
        ['wrong debit reason', [{ ...debit, reason: 'Schedule generation' }]],
        ['missing debit', []],
        ['duplicate debit', [debit, debit]],
        ['debit plus refund while active', [debit, refund]],
    ])('rejects %s', (_label, rows) => {
        expect(() => validate('QUEUED', rows)).toThrow(/provenance|cannot coexist/i);
    });

    it.each([
        ['missing metadata', null],
        ['wrong source', { source: 'plan', consumedCredits: 1, newBalance: 4 }],
        ['fractional balance', { source: 'credits', consumedCredits: 1, newBalance: 4.5 }],
        ['negative balance', { source: 'credits', consumedCredits: 1, newBalance: -1 }],
        ['overflowing prior balance', { source: 'credits', consumedCredits: 1, newBalance: 2_147_483_647 }],
        ['unexpected metadata', { source: 'credits', consumedCredits: 1, newBalance: 4, legacy: true }],
    ])('rejects %s', (_label, metadata) => {
        expect(() => validate('RUNNING', [debit], metadata)).toThrow(/metadata/i);
    });

    it('rejects terminal replay with missing or mismatched refund provenance', () => {
        expect(() => validate('FAILED')).toThrow(/refund provenance/i);
        expect(() => validate('FAILED', [debit, { ...refund, amount: 2 }])).toThrow(/refund provenance/i);
        expect(() => validate('SUCCEEDED', [debit, refund])).toThrow(/cannot coexist/i);
    });
});
