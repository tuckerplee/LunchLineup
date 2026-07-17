import { describe, expect, it, vi } from 'vitest';

import {
    MAX_AVAILABILITY_PDF_BYTES,
    assertAvailabilityImportAcceptedCost,
    availabilityImportRequestFields,
    availabilityImportStatusView,
    createAvailabilityPdfImportAttempt,
    isAvailabilityImportTerminal,
    parseAvailabilityImportJob,
    parseSchedulingCreditCost,
    updateAvailabilityPdfImportAttemptIdentity,
    validateAvailabilityImportStaffIdentity,
    validateAvailabilityPdfFile,
} from '../../app/dashboard/staff/availability-pdf-import';

const pdf = {
    name: 'availability.pdf',
    size: 1_024,
    type: 'application/pdf',
};

const jobPayload = (status: string, chargedCredits: number, refundedCredits = 0) => ({
    id: 'import-1',
    userId: 'user-1',
    status,
    parsedAvailability: status === 'SUCCEEDED' ? [{
        locationId: null,
        dayOfWeek: 1,
        startTimeMinutes: 540,
        endTimeMinutes: 1_020,
    }] : null,
    settlement: {
        chargedCredits,
        refundedCredits,
        pending: status !== 'SUCCEEDED' && refundedCredits !== chargedCredits,
    },
});

describe('availability PDF import contract', () => {
    it('accepts only non-empty PDFs at or below the 5 MiB boundary', () => {
        expect(validateAvailabilityPdfFile(pdf)).toBeNull();
        expect(validateAvailabilityPdfFile({ ...pdf, size: MAX_AVAILABILITY_PDF_BYTES })).toBeNull();
        expect(validateAvailabilityPdfFile({ ...pdf, name: 'availability.txt' })).toContain('PDF file only');
        expect(validateAvailabilityPdfFile({ ...pdf, size: 0 })).toContain('empty or invalid');
    });

    it('creates one stable idempotency key for a retryable selected-file attempt', () => {
        const keyFactory = vi.fn(() => 'attempt-key-1');
        const attempt = createAvailabilityPdfImportAttempt(pdf, 'EMP-10492', keyFactory);
        expect(attempt.idempotencyKey).toBe('attempt-key-1');
        expect(attempt.staffIdentity).toBe('emp-10492');
        expect(availabilityImportRequestFields(attempt)).toEqual({ staffIdentity: 'emp-10492' });
        expect(keyFactory).toHaveBeenCalledOnce();
    });

    it('requires a visible identifier and rotates idempotency when it changes', () => {
        expect(validateAvailabilityImportStaffIdentity('')).toBe('Employee or staff ID is required.');
        const first = createAvailabilityPdfImportAttempt(pdf, 'invitee@example.com', () => 'attempt-key-1');
        const unchanged = updateAvailabilityPdfImportAttemptIdentity(first, ' INVITEE@example.com ');
        const changed = updateAvailabilityPdfImportAttemptIdentity(first, 'EMP-10492', () => 'attempt-key-2');

        expect(unchanged).toBe(first);
        expect(changed).toMatchObject({
            idempotencyKey: 'attempt-key-2',
            staffIdentity: 'emp-10492',
        });
    });

    it.each([1, 3])('strictly parses the authoritative scheduling cost %i', (creditCost) => {
        expect(parseSchedulingCreditCost({
            features: { scheduling: { creditCost } },
        })).toBe(creditCost);
    });

    it.each([
        undefined,
        null,
        {},
        { features: {} },
        { features: { scheduling: {} } },
        { features: { scheduling: { creditCost: 0 } } },
        { features: { scheduling: { creditCost: -1 } } },
        { features: { scheduling: { creditCost: 1.5 } } },
        { features: { scheduling: { creditCost: '3' } } },
    ])('fails closed for malformed scheduling cost %#', (payload) => {
        expect(() => parseSchedulingCreditCost(payload)).toThrow('credit cost is unavailable');
    });

    it('rejects an accepted API response whose authoritative charge mismatches preflight cost', () => {
        const job = parseAvailabilityImportJob(jobPayload('PENDING', 3));
        expect(() => assertAvailabilityImportAcceptedCost(job, 1)).toThrow('did not match');
        expect(() => assertAvailabilityImportAcceptedCost(job, 3)).not.toThrow();
    });

    it('normalizes valid parsed availability and server-derived settlement', () => {
        expect(parseAvailabilityImportJob(jobPayload('SUCCEEDED', 3))).toMatchObject({
            id: 'import-1',
            status: 'SUCCEEDED',
            settlement: { chargedCredits: 3, refundedCredits: 0, pending: false },
        });
    });

    it('says refunded only for an exact positive terminal settlement', () => {
        const exact = parseAvailabilityImportJob(jobPayload('FAILED', 3, 3));
        expect(availabilityImportStatusView(exact.status, exact.settlement).creditDetail)
            .toBe('3 paid credits were refunded for this import.');

        const singular = parseAvailabilityImportJob(jobPayload('FAILED', 1, 1));
        expect(availabilityImportStatusView(singular.status, singular.settlement).creditDetail)
            .toBe('1 paid credit was refunded for this import.');
    });

    it('keeps failed terminal imports pending/unverified without a matching refund', () => {
        for (const payload of [jobPayload('FAILED', 3, 0), jobPayload('FAILED', 3, 1)]) {
            const job = parseAvailabilityImportJob(payload);
            expect(availabilityImportStatusView(job.status, job.settlement).creditDetail)
                .toBe('Refund settlement is pending or could not be verified.');
        }
    });

    it('rejects an impossible over-refund response', () => {
        expect(() => parseAvailabilityImportJob(jobPayload('FAILED', 3, 4)))
            .toThrow('invalid response');
    });

    it('uses exact singular/plural charge copy without promising a refund', () => {
        const one = parseAvailabilityImportJob(jobPayload('RUNNING', 1));
        const three = parseAvailabilityImportJob(jobPayload('RUNNING', 3));
        expect(availabilityImportStatusView(one.status, one.settlement).creditDetail)
            .toBe('1 paid credit was charged. Final settlement is pending.');
        expect(availabilityImportStatusView(three.status, three.settlement).creditDetail)
            .toBe('3 paid credits were charged. Final settlement is pending.');
    });

    it('defines active and terminal lifecycle states', () => {
        expect(isAvailabilityImportTerminal('RUNNING')).toBe(false);
        for (const status of ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED'] as const) {
            expect(isAvailabilityImportTerminal(status)).toBe(true);
        }
    });
});
