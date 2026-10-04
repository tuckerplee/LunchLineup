import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithSession } from '@/lib/client-api';
import { createLatestRequestGate } from '@/lib/latest-request';
import { clockOutTimeCard, fetchTimeCardSnapshot } from '../../app/dashboard/time-cards/time-card-api';
import { isTimeCardValidationRejection } from '../../app/dashboard/time-cards/time-card-mutation-result';
import { isTimeCardForEmployee, type TimeCardView } from '../../app/dashboard/time-cards/time-card-request';
import type { TimeCard } from '../../app/dashboard/time-cards/time-card-types';
import { normalizeClockOutBreakMinutes } from '../../../api-v2/src/time/validation';

vi.mock('@/lib/client-api', () => ({ fetchWithSession: vi.fn() }));

// Evaluate only the two complete actual useCallback closures. There is no
// duplicate payload/confirmation builder, mounted React, DOM, network or DB.
// API query/body/error handling and the owner break validator remain actual.
const path = resolve(process.cwd(), 'app/dashboard/time-cards/TimeCardsWorkspace.tsx');
const source = readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owners = ast.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'TimeCardsWorkspace');
if (owners.length !== 1 || !owners[0].body) throw new Error('Expected one actual Time workspace');
function closure(name: string): string {
    const declarations = owners[0].body!.statements.filter(ts.isVariableStatement)
        .flatMap(node => [...node.declarationList.declarations])
        .filter(node => ts.isIdentifier(node.name) && node.name.text === name);
    if (declarations.length !== 1) throw new Error(`Expected one actual ${name} declaration`);
    const initializer = declarations[0].initializer;
    if (!initializer || !ts.isCallExpression(initializer) || initializer.expression.getText(ast) !== 'useCallback'
        || initializer.arguments.length !== 2 || !ts.isArrowFunction(initializer.arguments[0])
        || !initializer.arguments[0].modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword)) {
        throw new Error(`Expected complete async useCallback for ${name}`);
    }
    return initializer.arguments[0].getText(ast);
}
const executable = ts.transpileModule(`const loadCards = (${closure('loadCards')});
const clockOut = (${closure('clockOut')}); return { clockOut, loadCards };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

const cardId = '79000000-0000-4000-8000-000000000001';
const employeeId = '79000000-0000-4000-8000-000000000002';
const locationId = '79000000-0000-4000-8000-000000000003';
function card(overrides: Partial<TimeCard> = {}): TimeCard {
    return { id: cardId, userId: employeeId, locationId,
        clockInAt: '2026-10-04T09:00:00.000Z', clockOutAt: null, breakMinutes: 0,
        status: 'OPEN', grossMinutes: 120, workedMinutes: 120, notes: null,
        updatedAt: '2026-10-04T09:00:00.000Z', displayTimeZone: 'UTC', breaks: [],
        location: { id: locationId, name: 'Selected kitchen', timezone: 'UTC' }, ...overrides };
}
function closed(overrides: Partial<TimeCard> = {}): TimeCard {
    return card({ clockOutAt: '2026-10-04T11:00:00.000Z', status: 'CLOSED', breakMinutes: 15,
        workedMinutes: 105, notes: 'Reviewed break', updatedAt: '2026-10-04T11:00:00.000Z', ...overrides });
}
type Options = {
    input?: string; notes?: string; writeStatus?: number; lostResponse?: boolean;
    history?: TimeCard[]; readUnavailable?: boolean; readOnly?: boolean; noActive?: boolean;
    staleCards?: boolean; wrongLocation?: boolean; view?: TimeCardView;
    savedNotes?: string | null; beforeWriteResponse?: (selected: TimeCard) => void;
};
function fixture(options: Options = {}) {
    const selected = card({ notes: options.savedNotes ?? null }), view = options.view ?? 'team';
    const originalTarget = structuredClone(selected);
    const state: Record<string, unknown> = {
        breakMinutes: options.input ?? '15', notes: options.notes ?? ' Reviewed break ',
        isSaving: false, error: null, notice: null, cards: [selected], activeCard: selected,
        isCardsLoading: false, loadedTargetKey: `${view}:${employeeId}`, canStartNewTimeCard: true,
        nextCardsCursor: null, isMoreCardsLoading: false, correctingCard: null,
    };
    const setters: { name: string; value: unknown }[] = [];
    const calls: { path: string; method: string }[] = [], unexpected: string[] = [];
    const writes: { cardId: string; body: { breakMinutes: number; notes?: string }; init: RequestInit }[] = [];
    const fetched = vi.mocked(fetchWithSession);
    const history = options.history ?? [closed()];
    const expectedActive = '/time-cards/active?' + (view === 'team' ? `userId=${employeeId}` : '');
    const expectedHistory = '/time-cards?limit=100' + (view === 'team' ? `&userId=${employeeId}` : '');
    fetched.mockImplementation(async (target: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'; calls.push({ path: target, method });
        if (target === `/time-cards/${cardId}/clock-out` && method === 'POST' && typeof init?.body === 'string') {
            writes.push({ cardId, body: JSON.parse(init.body), init });
            options.beforeWriteResponse?.(selected);
            if (options.lostResponse) throw new Error('Controlled response unavailable; commit status unknown');
            const status = options.writeStatus ?? 200;
            return new Response(JSON.stringify(status === 200 ? closed()
                : { message: status === 409 ? 'This time card was already closed by another request.' : 'Break input was rejected.' }),
            { status, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && target === expectedActive) {
            return new Response(JSON.stringify({ data: null }), { status: options.readUnavailable ? 503 : 200 });
        }
        if (method === 'GET' && target === expectedHistory) {
            return new Response(JSON.stringify({ data: history, pagination: { nextCursor: null } }),
                { status: options.readUnavailable ? 503 : 200 });
        }
        unexpected.push(`${method} ${target}`);
        throw new Error('Unexpected Time handoff');
    });
    const settersByName = Object.fromEntries(Object.keys(state).map(name => [
        'set' + name[0].toUpperCase() + name.slice(1), (value: unknown) => {
            setters.push({ name, value: structuredClone(value) }); state[name] = value;
        },
    ]));
    const bindings = { ...settersByName, clockOutTimeCard, fetchTimeCardSnapshot,
        isTimeCardValidationRejection, isTimeCardForEmployee, canManageTeam: view === 'team',
        isTeamTime: view === 'team', view, selectedUserId: employeeId, selectedStaffName: 'Selected employee',
        selectedLocationName: 'Selected kitchen', activeCardForSelectedUser: options.noActive ? null : selected,
        hasCurrentCards: !options.staleCards, canWriteTimeCards: !options.readOnly,
        teamClockOutTargetIsExplicit: !options.wrongLocation,
        breakMinutes: state.breakMinutes, notes: state.notes,
        correctionGeneration: { current: 0 }, cardsRequestGate: { current: createLatestRequestGate<string>() } };
    const handlers = new Function(...Object.keys(bindings), executable)(...Object.values(bindings)) as {
        clockOut(): Promise<void>; loadCards(userId: string, view: TimeCardView): Promise<TimeCard[] | undefined>;
    };
    const invoke = async () => {
        await handlers.clockOut();
        // Handoff errors cannot disappear into the owner's catch/recovery.
        expect(unexpected).toEqual([]); expect(fetched.mock.calls).toHaveLength(calls.length);
        expect(state.isSaving).toBe(false);
        for (const write of writes) {
            expect(write.cardId).toBe(originalTarget.id);
            expect(write.init.credentials).toBe('include');
            expect(new Headers(write.init.headers).get('content-type')).toBe('application/json');
            expect(normalizeClockOutBreakMinutes(write.body.breakMinutes, 120)).toBe(write.body.breakMinutes);
        }
    };
    const retainedDraft = () => {
        expect(state.breakMinutes).toBe(options.input ?? '15');
        expect(state.notes).toBe(options.notes ?? ' Reviewed break ');
    };
    return { state, calls, writes, setters, invoke, retainedDraft, expectedActive, expectedHistory };
}
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('actual Time workspace clock-out callback and state readback baseline', () => {
    it('records an explicit valid team integer on the exact card and refreshes the scoped target', async () => {
        const f = fixture(); await f.invoke();
        expect(f.writes[0].body).toEqual({ breakMinutes: 15, notes: 'Reviewed break' });
        expect(f.calls).toEqual([{ path: `/time-cards/${cardId}/clock-out`, method: 'POST' },
            { path: f.expectedActive, method: 'GET' }, { path: f.expectedHistory, method: 'GET' }]);
        expect(f.state.cards).toEqual([closed()]); expect(f.state.notes).toBe('');
        expect(f.state.notice).toContain('Selected employee was clocked out from Selected kitchen');
    });
    it('preserves an explicit zero for self-service and uses actual self query paths', async () => {
        const f = fixture({ input: '0', view: 'mine', history: [closed({ breakMinutes: 0 })] }); await f.invoke();
        expect(f.writes[0].body.breakMinutes).toBe(0);
        expect(f.calls.slice(1)).toEqual([{ path: '/time-cards/active?', method: 'GET' },
            { path: '/time-cards?limit=100', method: 'GET' }]);
        expect(f.state.notice).toContain('Your clock-out was recorded');
    });
    it('accepts surrounding whitespace on an explicitly valid whole integer', async () => {
        const f = fixture({ input: ' 15 ' }); await f.invoke(); expect(f.writes[0].body.breakMinutes).toBe(15);
    });
    it('refuses read-only handoff and retains the exact draft', async () => {
        const f = fixture({ readOnly: true }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
        expect(f.state.error).toBe('You have read-only time card access.');
    });
    it('does not hand off when no active card is present', async () => {
        const f = fixture({ noActive: true }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('does not hand off when selected cards are not current', async () => {
        const f = fixture({ staleCards: true }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('refuses a team location mismatch before either write or refresh', async () => {
        const f = fixture({ wrongLocation: true }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
        expect(f.state.error).toContain('Choose Selected kitchen');
    });
    it('retains draft after actual structured 422 rejection without confirmation readback', async () => {
        const f = fixture({ writeStatus: 422 }); await f.invoke(); expect(f.calls).toHaveLength(1); f.retainedDraft();
        expect(f.state.notice).toBeNull(); expect(f.state.error).toBe('Break input was rejected.');
    });
    it('retains draft after actual structured 400 rejection without confirmation readback', async () => {
        const f = fixture({ writeStatus: 400 }); await f.invoke(); expect(f.calls).toHaveLength(1); f.retainedDraft();
        expect(f.state.notice).toBeNull(); expect(f.state.error).toBe('Break input was rejected.');
    });
    it('does not confirm a different closed card after conflict', async () => {
        const f = fixture({ writeStatus: 409, history: [closed({ id: '79000000-0000-4000-8000-000000000004' })] });
        await f.invoke(); f.retainedDraft(); expect(f.state.notice).toBeNull();
        expect(f.state.error).toContain('could not be confirmed');
    });
    it('does not confirm the same still-open card after response loss', async () => {
        const f = fixture({ lostResponse: true, history: [card()] }); await f.invoke(); f.retainedDraft();
        expect(f.state.notice).toBeNull(); expect(f.state.error).toContain('could not be confirmed');
    });
    it('recognizes matching saved values after lost response as state fidelity only', async () => {
        // This readback cannot identify the actor who committed. It only has
        // the same card and normalized requested values, not attribution proof.
        const f = fixture({ lostResponse: true }); await f.invoke();
        expect(f.state.cards).toEqual([closed()]); expect(f.state.notes).toBe('');
        expect(f.state.notice).toBe('Saved time card matches your clock-out entries after refreshing.');
        expect(f.writes).toHaveLength(1);
    });
    it('retains draft when response loss cannot be followed by a readable snapshot', async () => {
        const f = fixture({ lostResponse: true, readUnavailable: true }); await f.invoke(); f.retainedDraft();
        expect(f.state.notice).toBeNull(); expect(f.state.error).toContain('could not be confirmed');
    });
    it('acknowledges a successful mutation separately from a failed refresh', async () => {
        const f = fixture({ readUnavailable: true }); await f.invoke();
        expect(f.writes).toHaveLength(1); expect(f.state.notice).toContain('was clocked out');
        expect(f.state.error).toBe('Unable to load active time card.');
    });
    it('refuses a fractional typed break without silently truncating its transmitted value', async () => {
        const f = fixture({ input: '1.5' }); await f.invoke();
        expect(f.writes, JSON.stringify(f.writes.map(write => write.body))).toEqual([]);
        f.retainedDraft(); expect(f.state.notice).toBeNull(); expect(f.state.error).toEqual(expect.any(String));
    });
    it('refuses a blank typed break without silently substituting zero', async () => {
        const f = fixture({ input: '' }); await f.invoke();
        expect(f.writes, JSON.stringify(f.writes.map(write => write.body))).toEqual([]);
        f.retainedDraft(); expect(f.state.notice).toBeNull(); expect(f.state.error).toEqual(expect.any(String));
    });
    it('refuses a nonnumeric typed break without silently substituting zero', async () => {
        const f = fixture({ input: 'unavailable' }); await f.invoke();
        expect(f.writes, JSON.stringify(f.writes.map(write => write.body))).toEqual([]);
        f.retainedDraft(); expect(f.state.notice).toBeNull(); expect(f.state.error).toEqual(expect.any(String));
    });
    it('retains draft when a conflict readback closes the same card with competing values', async () => {
        const f = fixture({ writeStatus: 409, history: [closed({ breakMinutes: 20, notes: 'Other review' })] });
        await f.invoke(); f.retainedDraft(); expect(f.state.notice).toBeNull();
        expect(f.state.error).toEqual(expect.any(String));
    });
    it('retains draft when a lost-response readback has competing notes on the same closed card', async () => {
        const f = fixture({ lostResponse: true, history: [closed({ notes: 'Other review' })] });
        await f.invoke(); f.retainedDraft(); expect(f.state.notice).toBeNull();
        expect(f.state.error).toEqual(expect.any(String));
    });
    it('retains draft when a lost-response readback has a competing break on the same closed card', async () => {
        const f = fixture({ lostResponse: true, history: [closed({ breakMinutes: 20 })] });
        await f.invoke(); f.retainedDraft(); expect(f.state.notice).toBeNull();
        expect(f.state.error).toEqual(expect.any(String));
    });
    it('refuses a negative typed break without a write', async () => {
        const f = fixture({ input: '-1' }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('refuses a numeric prefix followed by text without a write', async () => {
        const f = fixture({ input: '15minutes' }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('refuses exponent syntax instead of parsing a numeric prefix', async () => {
        const f = fixture({ input: '1e2' }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('refuses decimal syntax even when its numeric value is whole', async () => {
        const f = fixture({ input: '15.0' }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('refuses nonfinite typed break syntax without a write', async () => {
        const f = fixture({ input: 'Infinity' }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('refuses hexadecimal syntax instead of substituting a decimal prefix', async () => {
        const f = fixture({ input: '0x10' }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('refuses an unsafe decimal integer without a write', async () => {
        const f = fixture({ input: '9007199254740992' }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('refuses whitespace-only break intent without substituting zero', async () => {
        const f = fixture({ input: ' \t ' }); await f.invoke(); expect(f.calls).toEqual([]); f.retainedDraft();
    });
    it('accepts leading zeros in explicitly decimal whole-number intent', async () => {
        const f = fixture({ input: '0015' }); await f.invoke(); expect(f.writes[0].body.breakMinutes).toBe(15);
    });
    it('preserves original saved notes when the transmitted note is omitted', async () => {
        const f = fixture({ notes: '   ', savedNotes: 'Previously saved', lostResponse: true,
            history: [closed({ notes: 'Previously saved' })] }); await f.invoke();
        expect(f.writes[0].body).toEqual({ breakMinutes: 15 });
        expect(f.state.notice).toBe('Saved time card matches your clock-out entries after refreshing.');
        expect(f.state.notes).toBe('');
    });
    it('matches omitted notes against a null saved value', async () => {
        const f = fixture({ notes: '', savedNotes: null, lostResponse: true, history: [closed({ notes: null })] });
        await f.invoke(); expect(f.writes[0].body).not.toHaveProperty('notes');
        expect(f.state.notice).toBe('Saved time card matches your clock-out entries after refreshing.');
    });
    it('matches an absent saved note to the original null note without invented clearing', async () => {
        const f = fixture({ notes: '', lostResponse: true, history: [closed({ notes: undefined })] });
        await f.invoke(); expect(f.writes[0].body).not.toHaveProperty('notes');
        expect(f.state.notice).toBe('Saved time card matches your clock-out entries after refreshing.');
    });
    it('retains an omitted-note draft when readback changes the original saved note', async () => {
        const f = fixture({ notes: ' ', savedNotes: 'Previously saved', lostResponse: true,
            history: [closed({ notes: null })] }); await f.invoke(); f.retainedDraft();
        expect(f.state.notice).toBeNull(); expect(f.state.error).toContain('against your entries');
    });
    it('rejects the same closed card identifier bound to a different employee', async () => {
        const f = fixture({ lostResponse: true,
            history: [closed({ userId: '79000000-0000-4000-8000-000000000005' })] });
        await f.invoke(); f.retainedDraft(); expect(f.state.cards).toEqual([]); expect(f.state.notice).toBeNull();
    });
    it('rejects a VOID card even when its identifier and saved fields match', async () => {
        const f = fixture({ lostResponse: true, history: [closed({ status: 'VOID' })] });
        await f.invoke(); f.retainedDraft(); expect(f.state.notice).toBeNull();
    });
    it('rejects an OPEN card with a nonnull clock-out field as unconfirmed state', async () => {
        const f = fixture({ lostResponse: true, history: [closed({ status: 'OPEN' })] });
        await f.invoke(); f.retainedDraft(); expect(f.state.notice).toBeNull();
    });
    it('rejects a CLOSED card without a clock-out instant', async () => {
        const f = fixture({ lostResponse: true, history: [closed({ clockOutAt: null })] });
        await f.invoke(); f.retainedDraft(); expect(f.state.notice).toBeNull();
    });
    it('rejects a CLOSED card with an invalid clock-out instant', async () => {
        const f = fixture({ lostResponse: true, history: [closed({ clockOutAt: 'not-an-instant' })] });
        await f.invoke(); f.retainedDraft(); expect(f.state.notice).toBeNull();
    });
    it('keeps the frozen target and omitted-note intent across an awaited handoff', async () => {
        const f = fixture({ notes: '', savedNotes: 'Previously saved', lostResponse: true,
            history: [closed({ notes: 'Previously saved' })], beforeWriteResponse: selected => {
                selected.id = '79000000-0000-4000-8000-000000000006';
                selected.userId = '79000000-0000-4000-8000-000000000007';
                selected.notes = 'Later object contents';
            } });
        await f.invoke(); expect(f.writes[0].body).toEqual({ breakMinutes: 15 });
        expect(f.state.notice).toBe('Saved time card matches your clock-out entries after refreshing.');
        // Synthetic reference mutation tests captured intent only. This is
        // neither an account/workspace switch nor a competing DB writer.
    });
});
