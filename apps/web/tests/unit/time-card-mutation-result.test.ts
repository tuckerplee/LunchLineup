import { describe, expect, it } from 'vitest';
import { isTimeCardValidationRejection, requireTimeCardMutationSuccess } from '../../app/dashboard/time-cards/time-card-mutation-result';

async function rejected(status: number, body = JSON.stringify({ message: 'Break minutes must be less than worked minutes.' })) {
    try {
        await requireTimeCardMutationSuccess(new Response(body, { status }), 'Unable to clock out.');
        throw new Error('Expected rejection');
    } catch (error) {
        return error;
    }
}

describe('clock-out result classification', () => {
    it.each([400, 422])('retains the actionable validation rejection for HTTP %i', async status => {
        const error = await rejected(status);
        expect(isTimeCardValidationRejection(error)).toBe(true);
        expect(error).toMatchObject({ message: 'Break minutes must be less than worked minutes.' });
    });
    it('keeps server failures, conflicts, and lost responses on the reconciliation path', async () => {
        expect(isTimeCardValidationRejection(await rejected(503))).toBe(false);
        expect(isTimeCardValidationRejection(await rejected(409))).toBe(false);
        expect(isTimeCardValidationRejection(new TypeError('Failed to fetch'))).toBe(false);
    });
    it('uses a fallback for malformed rejection bodies', async () => {
        expect(await rejected(400, 'invalid json')).toMatchObject({ status: 400, message: 'Unable to clock out.' });
    });
    it('accepts a successful response without requiring a JSON body', async () => {
        await expect(requireTimeCardMutationSuccess(new Response(null, { status: 204 }), 'Unable to clock out.')).resolves.toBeUndefined();
    });
});
