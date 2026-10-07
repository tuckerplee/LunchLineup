import { idempotentRequestAttempt } from '../../lib/client-api';
import { creditGrantConfirmation, estimateCreditGrant } from '../../app/admin/credits/credit-grant-estimate';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { withIdempotencyKey } from '../../lib/client-api';
import { parseCreditGrantAcknowledgement } from '../../app/admin/credits/credit-grant-acknowledgement';

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


// Execute the actual client write boundary and its real pure parser with a
// closed Response supplier. Only the three uniquely named writer declarations
// are loaded; no React render, DOM/session lifecycle or network is performed.
function actualCreditWriter(fetchWithSession: (path: string, init: RequestInit) => Promise<Response>) {
    const path = resolve(process.cwd(), 'app/admin/credits/CreditsClient.tsx');
    const source = readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const names = ['getCsrfHeaders', 'jsonWriteInit', 'writeJson'];
    const declarations = names.map(name => {
        const selected = ast.statements.filter((node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === name);
        expect(selected).toHaveLength(1); return selected[0].getText(ast);
    }).join('\n');
    const javascript = ts.transpileModule(declarations + '\nreturn writeJson;', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return new Function('fetchWithSession', 'withIdempotencyKey', 'parseCreditGrantAcknowledgement', 'document', javascript)(
        fetchWithSession, withIdempotencyKey, parseCreditGrantAcknowledgement, undefined) as
        (path: string, method: 'POST', payload: CreditGrantPayload, key: string) => Promise<{ success: true; newBalance: number }>;
}

const unverifiedMessage = 'The credit grant response could not be verified. Retry the unchanged grant.';
const invalidAcknowledgements = [
    { label: 'malformed-json', status: 201, body: '{' },
    { label: 'partial', status: 201, body: JSON.stringify({ success: true }) },
    { label: 'false-success', status: 201, body: JSON.stringify({ success: false, newBalance: 17 }) },
    { label: 'unsafe-balance', status: 201, body: JSON.stringify({ success: true, newBalance: Number.MAX_SAFE_INTEGER + 1 }) },
    { label: 'negative-balance', status: 201, body: JSON.stringify({ success: true, newBalance: -1 }) },
    { label: 'fractional-balance', status: 201, body: JSON.stringify({ success: true, newBalance: 1.5 }) },
    { label: 'string-balance', status: 201, body: JSON.stringify({ success: true, newBalance: '17' }) },
    { label: 'null-body', status: 201, body: 'null' },
    { label: 'empty204', status: 204, body: null },
    { label: 'unexpected200', status: 200, body: JSON.stringify({ success: true, newBalance: 17 }) },
] as const;

describe('actual admin credit grant acknowledgement boundary', () => {
    it.each(invalidAcknowledgements)('retains the original attempt after $label and reuses it for a deliberate valid retry', async item => {
        const state = createCreditGrantSubmissionState(), keyFactory = vi.fn(() => 'grant-verification-attempt');
        const fetchWithSession = vi.fn(async (_path: string, _init: RequestInit) => new Response(item.body, { status: item.status,
            headers: { 'Content-Type': 'application/json' } }));
        const write = actualCreditWriter(fetchWithSession);
        const send = (payload: CreditGrantPayload, key: string) => write('/admin/credits/grant', 'POST', payload, key);
        await expect(submitCreditGrant(state, PAYLOAD, send, keyFactory)).rejects.toThrow(unverifiedMessage);
        expect(state.inFlight).toBe(false); expect(state.attempt?.key).toBe('grant-verification-attempt');
        expect(fetchWithSession).toHaveBeenCalledOnce();
        fetchWithSession.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, newBalance: 17 }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }));
        await expect(submitCreditGrant(state, { ...PAYLOAD }, send, keyFactory)).resolves.toEqual({
            submitted: true, value: { success: true, newBalance: 17 },
        });
        expect(state).toEqual({ attempt: null, inFlight: false }); expect(keyFactory).toHaveBeenCalledOnce();
        expect(fetchWithSession).toHaveBeenCalledTimes(2);
        // No amount/wallet projection can supply the returned replay balance.
        for (const call of fetchWithSession.mock.calls) {
            const [path, init] = call;
            expect(path).toBe('/admin/credits/grant'); expect(init.method).toBe('POST'); expect(init.credentials).toBe('include');
            expect(new Headers(init.headers).get('Idempotency-Key')).toBe('grant-verification-attempt');
            expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
            expect(JSON.parse(String(init.body))).toEqual(PAYLOAD);
        }
    });

    it.each([0, Number.MAX_SAFE_INTEGER])('accepts a complete201 acknowledgement with nonnegative safe balance %s', balance => {
        expect(parseCreditGrantAcknowledgement(201, { success: true, newBalance: balance })).toEqual({ success: true, newBalance: balance });
    });

    it.each([422, 503])('preserves the existing non2xx error and attempt for HTTP %s', async status => {
        const state = createCreditGrantSubmissionState();
        const fetchWithSession = vi.fn(async () => new Response(JSON.stringify({ message: 'Grant could not be completed.' }),
            { status, headers: { 'Content-Type': 'application/json' } }));
        const write = actualCreditWriter(fetchWithSession);
        await expect(submitCreditGrant(state, PAYLOAD,
            (payload, key) => write('/admin/credits/grant', 'POST', payload, key), () => 'retained-refusal-attempt'))
            .rejects.toThrow('Grant could not be completed.');
        expect(state).toMatchObject({ inFlight: false, attempt: { key: 'retained-refusal-attempt' } });
        expect(fetchWithSession).toHaveBeenCalledOnce();
    });

    it('confirms an immutable stored replay balance after malformed committed delivery without issuing a second modeled grant', async () => {
        const state = createCreditGrantSubmissionState(), keys: string[] = [], settlements = new Map<string, number>();
        let effects = 0;
        const fetchWithSession = vi.fn(async (path: string, init: RequestInit) => {
            expect(path).toBe('/admin/credits/grant'); expect(JSON.parse(String(init.body))).toEqual(PAYLOAD);
            const key = new Headers(init.headers).get('Idempotency-Key'); expect(key).not.toBeNull(); keys.push(key!);
            if (!settlements.has(key!)) { effects += 1; settlements.set(key!, 17); }
            // Closed model only: first delivery is incomplete after its modeled
            // commit; replay returns the stored17 even if today's wallet differs.
            return new Response(JSON.stringify(keys.length === 1 ? { success: true }
                : { success: true, newBalance: settlements.get(key!) }), { status: 201,
                headers: { 'Content-Type': 'application/json' } });
        });
        const write = actualCreditWriter(fetchWithSession), keyFactory = vi.fn(() => 'modeled-committed-attempt');
        const send = (payload: CreditGrantPayload, key: string) => write('/admin/credits/grant', 'POST', payload, key);
        await expect(submitCreditGrant(state, PAYLOAD, send, keyFactory)).rejects.toThrow(unverifiedMessage);
        expect(effects).toBe(1); expect(state.attempt?.key).toBe('modeled-committed-attempt');
        await expect(submitCreditGrant(state, PAYLOAD, send, keyFactory)).resolves.toEqual({
            submitted: true, value: { success: true, newBalance: 17 },
        });
        expect(keys).toEqual(['modeled-committed-attempt', 'modeled-committed-attempt']);
        expect(effects).toBe(1); expect(settlements.size).toBe(1); expect(keyFactory).toHaveBeenCalledOnce();
        expect(state).toEqual({ attempt: null, inFlight: false });
    });
});


describe('admin credit debt-aware loaded-snapshot estimate', () => {
    it.each([
        {"label": "partial repayment", "wallet": 10, "debt": 30, "amount": 20, "expected": {"repaidDebt": 20, "spendableAmount": 0, "newBalance": 10, "debtAfter": 10}},
        {"label": "exact repayment", "wallet": 10, "debt": 30, "amount": 30, "expected": {"repaidDebt": 30, "spendableAmount": 0, "newBalance": 10, "debtAfter": 0}},
        {"label": "repayment with excess", "wallet": 10, "debt": 30, "amount": 50, "expected": {"repaidDebt": 30, "spendableAmount": 20, "newBalance": 30, "debtAfter": 0}},
        {"label": "zero debt", "wallet": 10, "debt": 0, "amount": 20, "expected": {"repaidDebt": 0, "spendableAmount": 20, "newBalance": 30, "debtAfter": 0}},
        {"label": "safe upper wallet", "wallet": 9007199254740990, "debt": 0, "amount": 1, "expected": {"repaidDebt": 0, "spendableAmount": 1, "newBalance": 9007199254740991, "debtAfter": 0}},
        {"label": "safe upper wallet with debt-only grant", "wallet": 9007199254740991, "debt": 1, "amount": 1, "expected": {"repaidDebt": 1, "spendableAmount": 0, "newBalance": 9007199254740991, "debtAfter": 0}},
    ])('estimates $label without treating grant value as wallet increase', ({ wallet, debt, amount, expected }) => {
        expect(estimateCreditGrant(wallet, debt, amount)).toEqual(expected);
    });

    it.each([
        { label: "missing debt", wallet: 10, debt: undefined, amount: 20 },
        { label: "null debt", wallet: 10, debt: null, amount: 20 },
        { label: "string debt", wallet: 10, debt: '30', amount: 20 },
        { label: "negative debt", wallet: 10, debt: -1, amount: 20 },
        { label: "fractional debt", wallet: 10, debt: 1.5, amount: 20 },
        { label: "unsafe debt", wallet: 10, debt: Number.MAX_SAFE_INTEGER + 1, amount: 20 },
        { label: "NaN debt", wallet: 10, debt: NaN, amount: 20 },
        { label: "infinite debt", wallet: 10, debt: Infinity, amount: 20 },
        { label: "negative wallet", wallet: -1, debt: 30, amount: 20 },
        { label: "zero grant", wallet: 10, debt: 30, amount: 0 },
        { label: "unsafe grant", wallet: 10, debt: 0, amount: Number.MAX_SAFE_INTEGER + 1 },
        { label: "wallet sum overflow", wallet: Number.MAX_SAFE_INTEGER, debt: 0, amount: 1 },
    ])('does not invent an estimate for $label', ({ wallet, debt, amount }) => {
        expect(estimateCreditGrant(wallet, debt, amount)).toBeNull();
    });

    it('confirms debt repayment and clearly separates loaded estimates from current settlement', () => {
        const estimate = estimateCreditGrant(10, 30, 20);
        expect(creditGrantConfirmation('Boreal Kitchen', 20, estimate)).toBe(
            'Grant 20 credits to Boreal Kitchen? Estimated debt repayment: 20 credits. '
            + 'Estimated spendable balance: 10 credits. Estimated remaining debt: 10 credits. '
            + 'Estimates use loaded balances; the server settles against current balances.',
        );
    });

    it('keeps a grant confirmation available with actionable missing-debt guidance', () => {
        expect(creditGrantConfirmation('Boreal Kitchen', 20, estimateCreditGrant(10, undefined, 20))).toBe(
            'Grant 20 credits to Boreal Kitchen? A balance estimate is unavailable; refresh balances for debt details. '
            + 'Outstanding debt is repaid first, and the server determines the final balances.',
        );
    });

    it('accepts an immutable settlement acknowledgement that differs from the loaded projection', async () => {
        // Another legitimate grant moved the wallet after this attempt committed.
        // An unchanged same-key retry returns its original settlement balance10,
        // while a new-request preview against today's wallet50 would show70.
        expect(estimateCreditGrant(50, 0, 20)?.newBalance).toBe(70);
        const state = createCreditGrantSubmissionState();
        const payload = { tenantId: 'tenant-1', amount: 20, reason: 'Debt recovery' };
        state.attempt = idempotentRequestAttempt(payload, null, () => 'stored-grant-key');
        const result = await submitCreditGrant(state, payload, async (_payload, key) => {
            expect(key).toBe('stored-grant-key');
            return parseCreditGrantAcknowledgement(201, { success: true, newBalance: 10 });
        });
        expect(result).toEqual({ submitted: true, value: { success: true, newBalance: 10 } });
        expect(state.attempt).toBeNull();
    });
});
