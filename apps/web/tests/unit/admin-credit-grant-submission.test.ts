import { describe, expect, it, vi } from 'vitest';

import {
    createCreditGrantSubmissionState,
    submitCreditGrant,
    type CreditGrantPayload,
} from '../../app/admin/credits/credit-grant-submission';

const PAYLOAD: CreditGrantPayload = {
    tenantId: 'tenant-1',
    amount: 250,
    reason: 'Private customer correction reason',
};

describe('admin credit-grant submission', () => {
    it('reuses one opaque key after an ambiguous failure and deliberate same-payload retry', async () => {
        const state = createCreditGrantSubmissionState();
        const keyFactory = vi.fn(() => 'grant-attempt-1');
        const send = vi.fn()
            .mockRejectedValueOnce(new Error('Lost response'))
            .mockResolvedValueOnce({ success: true });

        await expect(submitCreditGrant(state, PAYLOAD, send, keyFactory)).rejects.toThrow('Lost response');
        await expect(submitCreditGrant(state, { ...PAYLOAD }, send, keyFactory)).resolves.toEqual({
            submitted: true,
            value: { success: true },
        });

        expect(send.mock.calls.map((call) => call[1])).toEqual(['grant-attempt-1', 'grant-attempt-1']);
        expect(keyFactory).toHaveBeenCalledOnce();
        expect('grant-attempt-1').not.toContain(PAYLOAD.reason);
    });

    it.each([
        ['tenant', { ...PAYLOAD, tenantId: 'tenant-2' }],
        ['amount', { ...PAYLOAD, amount: 500 }],
        ['reason', { ...PAYLOAD, reason: 'A different private correction reason' }],
    ] as const)('rotates the retained key when the %s changes', async (_field, changedPayload) => {
        const state = createCreditGrantSubmissionState();
        const keyFactory = vi.fn()
            .mockReturnValueOnce('grant-attempt-1')
            .mockReturnValueOnce('grant-attempt-2');
        const send = vi.fn().mockRejectedValue(new Error('Network unavailable'));

        await expect(submitCreditGrant(state, PAYLOAD, send, keyFactory)).rejects.toThrow();
        await expect(submitCreditGrant(state, changedPayload, send, keyFactory)).rejects.toThrow();

        expect(send.mock.calls.map((call) => call[1])).toEqual(['grant-attempt-1', 'grant-attempt-2']);
        expect(keyFactory).toHaveBeenCalledTimes(2);
    });

    it('clears a confirmed attempt so the same payload starts with a new key', async () => {
        const state = createCreditGrantSubmissionState();
        const keyFactory = vi.fn()
            .mockReturnValueOnce('grant-attempt-1')
            .mockReturnValueOnce('grant-attempt-2');
        const send = vi.fn().mockResolvedValue({ success: true });

        await submitCreditGrant(state, PAYLOAD, send, keyFactory);
        expect(state.attempt).toBeNull();
        await submitCreditGrant(state, PAYLOAD, send, keyFactory);

        expect(send.mock.calls.map((call) => call[1])).toEqual(['grant-attempt-1', 'grant-attempt-2']);
        expect(keyFactory).toHaveBeenCalledTimes(2);
    });

    it('rejects a concurrent duplicate while the first request is unresolved', async () => {
        const state = createCreditGrantSubmissionState();
        let resolveSend: ((value: { success: true }) => void) | undefined;
        const send = vi.fn(() => new Promise<{ success: true }>((resolve) => {
            resolveSend = resolve;
        }));
        const keyFactory = vi.fn(() => 'grant-attempt-1');

        const first = submitCreditGrant(state, PAYLOAD, send, keyFactory);
        await expect(submitCreditGrant(state, PAYLOAD, send, keyFactory)).resolves.toEqual({ submitted: false });

        expect(state.inFlight).toBe(true);
        expect(send).toHaveBeenCalledOnce();
        expect(keyFactory).toHaveBeenCalledOnce();

        resolveSend?.({ success: true });
        await expect(first).resolves.toEqual({ submitted: true, value: { success: true } });
        expect(state).toEqual({ attempt: null, inFlight: false });
    });
});
