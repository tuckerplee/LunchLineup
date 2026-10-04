import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithSession } from '@/lib/client-api';
import { createLatestRequestGate } from '@/lib/latest-request';
import * as timeApi from '../../app/dashboard/time-cards/time-card-api';
import * as timeRequest from '../../app/dashboard/time-cards/time-card-request';
import * as timeFormat from '../../app/dashboard/time-cards/time-card-format';
import { isTimeCardValidationRejection } from '../../app/dashboard/time-cards/time-card-mutation-result';
import type { TimeCard } from '../../app/dashboard/time-cards/time-card-types';

vi.mock('@/lib/client-api', () => ({ fetchWithSession: vi.fn() }));

// A source composition, not a React mount. Execute the actual complete workspace
// body/JSX with a finite state ledger; effects are not run. Actual handlers and
// JSX control expressions are never replaced with payload/reset implementations.
type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element {
    return { type, props: props ?? {}, children };
} };
const History = Symbol('actual History boundary'), Panel = Symbol('actual Panel boundary');
const dir = resolve(process.cwd(), 'app/dashboard/time-cards');
function owner(file: string, name: string) {
    const source = readFileSync(resolve(dir, file), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const matches = ast.statements.filter((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (matches.length !== 1 || !matches[0].body) throw new Error('Expected exact owner ' + name);
    return { source, ast, fn: matches[0] };
}
const workspace = owner('TimeCardsWorkspace.tsx', 'TimeCardsWorkspace');
const history = owner('TimeCardHistory.tsx', 'TimeCardHistory');
const panel = owner('TimeCardCorrectionPanel.tsx', 'TimeCardCorrectionPanel');
function declarations(selected: typeof workspace) {
    return selected.fn.body!.statements.filter(ts.isVariableStatement)
        .flatMap(statement => [...statement.declarationList.declarations]);
}
const hookNames = (hook: string) => declarations(workspace).filter(node => node.initializer
    && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(workspace.ast) === hook)
    .map(node => {
        if (!ts.isArrayBindingPattern(node.name)) return node.name.getText(workspace.ast);
        const first = node.name.elements[0];
        if (!first || !ts.isBindingElement(first)) throw new Error('Expected named first state slot');
        return first.name.getText(workspace.ast);
    });
const stateNames = hookNames('useState'), refNames = hookNames('useRef');
function javascript(source: string) {
    return ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React,
    } }).outputText;
}
const returnStatements = workspace.fn.body!.statements.filter(ts.isReturnStatement);
if (returnStatements.length !== 1 || !returnStatements[0].expression) throw new Error('Expected exact workspace JSX return');
const originalReturn = returnStatements[0];
// Expose existing owner handlers for finite setup/drain, while retaining the
// entire actual prefix and JSX return expression. No business code is rewritten.
const workspaceExecutable = javascript(`function render(${workspace.fn.parameters.map(node => node.getText(workspace.ast)).join(',')}) {
${workspace.source.slice(workspace.fn.body!.getStart(workspace.ast) + 1, originalReturn.getStart(workspace.ast))}
return { tree: (${originalReturn.expression!.getText(workspace.ast)}), clockOut, loadCards };
} return render;`);
const historyExecutable = javascript(history.fn.getText(history.ast).replace(/^export\s+/, '') + '\nreturn TimeCardHistory;');
function attributeForValue(selected: typeof workspace, tag: string, value: string, attribute: string) {
    const matches: ts.JsxOpeningLikeElement[] = [];
    const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(selected.ast) === tag
            && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(selected.ast) === 'value'
                && prop.initializer && ts.isJsxExpression(prop.initializer) && prop.initializer.expression?.getText(selected.ast) === value)) matches.push(node);
        ts.forEachChild(node, visit);
    };
    visit(selected.fn);
    if (matches.length !== 1) throw new Error('Expected exact ' + tag + ' value=' + value);
    const props = matches[0].attributes.properties.filter((prop): prop is ts.JsxAttribute =>
        ts.isJsxAttribute(prop) && prop.name.getText(selected.ast) === attribute);
    if (props.length !== 1 || !props[0].initializer || !ts.isJsxExpression(props[0].initializer)
        || !props[0].initializer.expression) throw new Error('Expected exact actual attribute ' + attribute);
    return props[0].initializer.expression.getText(selected.ast);
}
const reasonDeclarations = declarations(panel).filter(node => ts.isArrayBindingPattern(node.name)
    && ts.isBindingElement(node.name.elements[0]) && node.name.elements[0].name.getText(panel.ast) === 'reason');
if (reasonDeclarations.length !== 1 || !reasonDeclarations[0].initializer) throw new Error('Expected actual reason initializer');
const reasonInitializer = javascript('return ' + reasonDeclarations[0].initializer.getText(panel.ast) + ';');
const reasonChange = javascript('return ' + attributeForValue(panel, 'textarea', 'reason', 'onChange') + ';');
function elements(tree: unknown): Element[] {
    if (Array.isArray(tree)) return tree.flatMap(elements);
    if (!tree || typeof tree !== 'object' || !('type' in tree)) return [];
    const node = tree as Element; return [node, ...node.children.flatMap(elements)];
}
function only(tree: unknown, predicate: (node: Element) => boolean): Element {
    const matches = elements(tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0];
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
const cardId = '79000000-0000-4000-8000-000000000101';
const userId = '79000000-0000-4000-8000-000000000102';
const selected: TimeCard = { id: cardId, userId, locationId: '79000000-0000-4000-8000-000000000103',
    clockInAt: '2026-10-04T09:00:00.000Z', clockOutAt: null, breakMinutes: 0, status: 'OPEN',
    grossMinutes: 120, workedMinutes: 120, notes: null, updatedAt: '2026-10-04T09:00:00.000Z',
    displayTimeZone: 'UTC', breaks: [], location: { id: '79000000-0000-4000-8000-000000000103', name: 'Kitchen', timezone: 'UTC' } };
type Outcome = 'acknowledged' | 'matching-recovery' | 'rejected';
function fixture(outcome: Outcome) {
    const state = new Map<string, any>(), refs = new Map<string, { current: any }>();
    const effects: Array<{ name: string; value: unknown }> = [];
    let stateOrdinal = 0, refOrdinal = 0, replied = false;
    const entered = deferred<void>(), release = deferred<void>();
    const calls: Array<{ path: string; method: string }> = [], writes: unknown[] = [], unexpected: string[] = [];
    const saved: TimeCard = { ...structuredClone(selected), status: 'CLOSED', clockOutAt: '2026-10-04T11:00:00.000Z',
        breakMinutes: 15, workedMinutes: 105, updatedAt: '2026-10-04T11:00:00.000Z' };
    vi.mocked(fetchWithSession).mockImplementation(async (path, init) => {
        const method = init?.method ?? 'GET'; calls.push({ path, method });
        if (path === `/time-cards/${cardId}/clock-out` && method === 'POST' && typeof init?.body === 'string') {
            writes.push(JSON.parse(init.body)); entered.resolve(); await release.promise; replied = true;
            if (outcome === 'matching-recovery') throw new Error('Controlled acknowledgment loss; readback predetermined, no DB claim');
            return new Response(JSON.stringify(outcome === 'rejected' ? { message: 'Break input rejected.' } : saved),
                { status: outcome === 'rejected' ? 422 : 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && path === `/time-cards/active?userId=${userId}`) {
            return new Response(JSON.stringify({ data: replied ? null : selected }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && path === `/time-cards?limit=100&userId=${userId}`) {
            return new Response(JSON.stringify({ data: [replied ? saved : selected], pagination: { nextCursor: null } }),
                { headers: { 'Content-Type': 'application/json' } });
        }
        unexpected.push(method + ' ' + path); throw new Error('Unexpected actual Time API handoff');
    });
    const bindings = { React, ...timeApi, ...timeRequest, ...timeFormat, createLatestRequestGate,
        isTimeCardValidationRejection, TimeCardCorrectionPanel: Panel, TimeCardHistory: History,
        useEffect: () => undefined,
        useMemo: (compute: () => unknown) => compute(),
        useCallback: (callback: unknown) => callback,
        useRef: (initial: unknown) => {
            const name = refNames[refOrdinal++]; if (!name) throw new Error('Unmodeled ref');
            if (!refs.has(name)) refs.set(name, { current: initial }); return refs.get(name);
        },
        useState: (initial: unknown) => {
            const name = stateNames[stateOrdinal++]; if (!name) throw new Error('Unmodeled state');
            if (!state.has(name)) state.set(name, typeof initial === 'function' ? (initial as () => unknown)() : initial);
            return [state.get(name), (value: unknown) => {
                const next = typeof value === 'function' ? (value as (current: unknown) => unknown)(state.get(name)) : value;
                state.set(name, next); effects.push({ name, value: structuredClone(next) });
            }];
        },
    };
    const renderOwner = new Function(...Object.keys(bindings), workspaceExecutable)(...Object.values(bindings)) as
        (props: unknown) => { tree: Element; clockOut: () => Promise<void>; loadCards: (id: string, view: string) => Promise<unknown> };
    const renderHistory = new Function('React', 'formatTimeCardDuration', 'formatTimeCardTimestamp', historyExecutable)(
        React, timeFormat.formatTimeCardDuration, timeFormat.formatTimeCardTimestamp) as (props: unknown) => Element;
    function render() {
        stateOrdinal = 0; refOrdinal = 0;
        const result = renderOwner({ currentUserId: userId, canManageTeam: true, canReadLocations: true, canWriteTimeCards: true });
        expect(stateOrdinal).toBe(stateNames.length); expect(refOrdinal).toBe(refNames.length); return result;
    }
    let pending: Promise<void> | undefined;
    async function start() {
        const initial = render(); await initial.loadCards(userId, 'mine');
        // Reference catalog loading is not this proof; seed the completed finite
        // reference readiness only. Card state is installed by actual loadCards.
        state.set('isReferenceLoading', false);
        const ready = render();
        const breakInput = only(ready.tree, node => node.type === 'input' && node.props.type === 'number');
        expect(breakInput.props.disabled).toBe(false);
        breakInput.props.onChange({ target: { value: '15' } });
        pending = render().clockOut();
        const arrival = await Promise.race([entered.promise.then(() => 'entered'), pending.then(() => 'settled')]);
        expect(arrival).toBe('entered'); expect(state.get('isSaving')).toBe(true);
        expect(writes).toEqual([{ breakMinutes: 15 }]);
    }
    function breakInput() {
        return only(render().tree, node => node.type === 'input' && node.props.type === 'number');
    }
    function correctButton() {
        const historyNode = only(render().tree, node => node.type === History);
        expect(historyNode.props.isSaving).toBe(state.get('isSaving'));
        return only(renderHistory(historyNode.props), node => node.type === 'button' && node.children.includes('Correct'));
    }
    function assertBusyControls() {
        expect(state.get('isSaving')).toBe(true);
        expect(breakInput().props.disabled).toBe(true);
        expect(correctButton().props.disabled).toBe(true);
        // Disabled callbacks are deliberately never invoked. This oracle is the
        // actual JSX availability contract, not simulated DOM enforcement.
        expect(state.get('breakMinutes')).toBe('15');
        expect(elements(render().tree).filter(node => node.type === Panel)).toHaveLength(0);
    }
    function editBreak() {
        const input = breakInput();
        expect(input.props.disabled, 'Only an enabled settled Break input is invoked').toBe(false);
        input.props.onChange({ target: { value: '20' } }); expect(state.get('breakMinutes')).toBe('20');
    }
    let reason = '';
    function openCorrection() {
        const correct = correctButton();
        expect(correct.props.disabled, 'Only an enabled settled Correct button is invoked').toBe(false);
        correct.props.onClick();
        const panelNode = only(render().tree, node => node.type === Panel);
        expect(panelNode.props.card).toMatchObject({ id: cardId, updatedAt: state.get('cards')[0].updatedAt });
        reason = new Function('useState', reasonInitializer)((initial: string) => [initial, () => undefined])[0];
        expect(reason).toBe('');
        const change = new Function('setReason', reasonChange)((value: string) => { reason = value; }) as (event: unknown) => void;
        change({ target: { value: 'New unsaved verified correction.' } }); expect(reason).toBe('New unsaved verified correction.');
    }
    let settledCalls: Array<{ path: string; method: string }> | undefined;
    async function drain() {
        release.resolve(); await pending;
        expect(unexpected, 'Unexpected transport cannot disappear into catch/recovery').toEqual([]);
        expect(writes).toEqual([{ breakMinutes: 15 }]); expect(state.get('isSaving')).toBe(false);
        expect(calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: `/time-cards/${cardId}/clock-out` }]);
        expect(calls.filter(call => call.method === 'GET')).toHaveLength(outcome === 'rejected' ? 2 : 4);
        settledCalls = structuredClone(calls);
    }
    function assertNoAdditionalTransport() {
        expect(settledCalls).toBeDefined();
        expect(calls).toEqual(settledCalls);
        expect(unexpected).toEqual([]);
        expect(writes).toEqual([{ breakMinutes: 15 }]);
    }
    async function cleanup() {
        release.resolve(); await pending?.catch(() => undefined);
    }
    return { state, effects, start, assertBusyControls, breakInput, correctButton, editBreak, openCorrection, drain, assertNoAdditionalTransport, cleanup, render, reason: () => reason };
}
async function busyAvailability(outcome: Outcome) {
    const f = fixture(outcome);
    try {
        await f.start(); f.assertBusyControls(); await f.drain();
        expect(f.correctButton().props.disabled).toBe(false);
        // Successful clock-out removes the active card, so its Break input
        // remains unavailable for that independent reason after isSaving clears.
        expect(f.breakInput().props.disabled).toBe(outcome !== 'rejected');
        expect(f.state.get('breakMinutes')).toBe(outcome === 'rejected' ? '15' : '30');
        expect(elements(f.render().tree).filter(node => node.type === Panel)).toHaveLength(0);
    } finally { await f.cleanup(); }
}
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('actual pending clock-out draft controls and settled availability', () => {
    it('disables break edits and Correct during acknowledged clock-out and re-enables eligible settled controls', async () => {
        await busyAvailability('acknowledged');
    });
    it('disables break edits and Correct during matching state recovery and re-enables eligible settled controls', async () => {
        await busyAvailability('matching-recovery');
    });
    it('disables break edits and Correct during rejected clock-out and re-enables both after rejection', async () => {
        await busyAvailability('rejected');
    });
    it('keeps normal acknowledged clock-out reset and exact readback when no newer draft exists', async () => {
        const f = fixture('acknowledged');
        try { await f.start(); await f.drain(); expect(f.state.get('breakMinutes')).toBe('30');
            expect(elements(f.render().tree).filter(node => node.type === Panel)).toHaveLength(0);
            expect(f.state.get('cards')[0]).toMatchObject({ id: cardId, status: 'CLOSED', breakMinutes: 15 });
        } finally { await f.cleanup(); }
    });
    it('keeps matching recovery state fidelity and exact readback when no newer draft exists', async () => {
        const f = fixture('matching-recovery');
        try { await f.start(); await f.drain(); expect(f.state.get('breakMinutes')).toBe('30');
            expect(f.state.get('notice')).toBe('Saved time card matches your clock-out entries after refreshing.');
            expect(f.state.get('cards')[0]).toMatchObject({ id: cardId, status: 'CLOSED', breakMinutes: 15 });
        } finally { await f.cleanup(); }
    });
    it('retains a new enabled break edit made after settled rejection without another handoff or readback', async () => {
        const f = fixture('rejected');
        try { await f.start(); f.assertBusyControls(); await f.drain(); f.editBreak(); f.assertNoAdditionalTransport();
            expect(f.state.get('breakMinutes')).toBe('20');
            expect(f.state.get('error')).toBe('Break input rejected.');
        } finally { await f.cleanup(); }
    });
    it('retains a newly opened unsaved correction after settled rejection without another handoff or readback', async () => {
        const f = fixture('rejected');
        try { await f.start(); f.assertBusyControls(); await f.drain(); f.openCorrection(); f.assertNoAdditionalTransport();
            expect(f.reason()).toBe('New unsaved verified correction.');
            expect(elements(f.render().tree).filter(node => node.type === Panel)).toHaveLength(1);
        } finally { await f.cleanup(); }
    });
    it('allows a new unsaved correction on the saved card after acknowledged clock-out has fully settled', async () => {
        const f = fixture('acknowledged');
        try { await f.start(); f.assertBusyControls(); await f.drain(); f.openCorrection(); f.assertNoAdditionalTransport();
            expect(f.reason()).toBe('New unsaved verified correction.');
            expect(elements(f.render().tree).filter(node => node.type === Panel)).toHaveLength(1);
            expect(f.state.get('correctingCard')).toMatchObject({ id: cardId, status: 'CLOSED', breakMinutes: 15 });
        } finally { await f.cleanup(); }
    });
});
