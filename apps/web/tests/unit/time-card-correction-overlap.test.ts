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
return { tree: (${originalReturn.expression!.getText(workspace.ast)}), clockOut, loadCards, loadEarlierCards, loadMoreLocations };
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
function fixture(outcome: Outcome, options: { view?: 'mine' | 'team'; active?: boolean;
    history?: { first: TimeCard[]; refreshed: TimeCard[]; earlier: TimeCard[] }; refreshFailure?: boolean;
    readbackHold?: Promise<void>; readbackEntered?: () => void } = {}) {
    const active = options.active !== false;
    const original: TimeCard = active ? selected : { ...selected, status: 'CLOSED', clockOutAt: '2026-10-04T10:00:00.000Z' };
    const locationId = selected.location!.id;
    const state = new Map<string, any>(), refs = new Map<string, { current: any }>();
    const effects: Array<{ name: string; value: unknown }> = [];
    const callbackSettlements: Array<Promise<unknown>> = [];
    let stateOrdinal = 0, refOrdinal = 0, effectOrdinal = 0, replied = false, historyReads = 0;
    let ownerCleanup: (() => void) | undefined;
    const entered = deferred<void>(), release = deferred<void>();
    const calls: Array<{ path: string; method: string }> = [], writes: unknown[] = [], unexpected: string[] = [];
    const saved: TimeCard = { ...structuredClone(original), status: 'CLOSED', clockOutAt: '2026-10-04T11:00:00.000Z',
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
            return new Response(JSON.stringify({ data: replied || !active ? null : original }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && path === `/time-cards?limit=100&userId=${userId}`) {
            historyReads += 1;
            if (historyReads > 1) { options.readbackEntered?.(); await options.readbackHold; }
            if (options.refreshFailure && historyReads > 1) return new Response('{}', { status: 503 });
            const data = options.history ? historyReads === 1 ? options.history.first : options.history.refreshed
                : [replied ? saved : original];
            const nextCursor = options.history ? historyReads === 1 ? 'cursor-B9' : 'cursor-C8'
                : replied ? null : 'history-next';
            return new Response(JSON.stringify({ data, pagination: { nextCursor } }),
                { headers: { 'Content-Type': 'application/json' } });
        }
        if (options.history && method === 'GET' && path === `/time-cards?limit=100&cursor=cursor-C8&userId=${userId}`) {
            return new Response(JSON.stringify({ data: options.history.earlier, pagination: { nextCursor: null } }),
                { headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && path === `/time-cards?limit=100&cursor=history-next&userId=${userId}`) {
            return new Response(JSON.stringify({ data: [], pagination: { nextCursor: null } }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && path === '/locations?limit=200&cursor=location-next') {
            return new Response(JSON.stringify({ data: [{ id: 'location-second', name: 'Annex' }], pagination: { hasMore: false, nextCursor: null } }),
                { headers: { 'Content-Type': 'application/json' } });
        }
        unexpected.push(method + ' ' + path); throw new Error('Unexpected actual Time API handoff');
    });
    const bindings = { React, ...timeApi, ...timeRequest, ...timeFormat, createLatestRequestGate,
        isTimeCardValidationRejection, TimeCardCorrectionPanel: Panel, TimeCardHistory: History,
        // Only the first, actual pure unmount-generation effect is installed.
        // Reference/loading effects remain outside this finite composition.
        useEffect: (effect: () => void | (() => void)) => {
            if (effectOrdinal++ === 0) { const cleanup = effect(); if (typeof cleanup === 'function') ownerCleanup = cleanup; }
        },
        useMemo: (compute: () => unknown) => compute(),
        // Preserve the actual callback and arguments; record only its returned
        // promise so a rendered void event can be drained without polling.
        useCallback: (callback: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
            const result = callback(...args);
            if (result instanceof Promise) callbackSettlements.push(result);
            return result;
        },
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
        (props: unknown) => { tree: Element; clockOut: () => Promise<void>; loadCards: (id: string, view: string) => Promise<unknown>; loadEarlierCards: () => Promise<void>; loadMoreLocations: () => Promise<void> };
    const renderHistory = new Function('React', 'formatTimeCardDuration', 'formatTimeCardTimestamp', historyExecutable)(
        React, timeFormat.formatTimeCardDuration, timeFormat.formatTimeCardTimestamp) as (props: unknown) => Element;
    function render() {
        stateOrdinal = 0; refOrdinal = 0; effectOrdinal = 0;
        const result = renderOwner({ currentUserId: userId, canManageTeam: true, canReadLocations: true, canWriteTimeCards: true });
        expect(stateOrdinal).toBe(stateNames.length); expect(refOrdinal).toBe(refNames.length); return result;
    }
    let pending: Promise<void> | undefined;
    async function prepare() {
        const initial = render(); await initial.loadCards(userId, 'mine');
        // Reference catalog loading is not this proof; seed the completed finite
        // reference readiness only. Card state is installed by actual loadCards.
        state.set('isReferenceLoading', false);
        state.set('staff', [{ id: userId, name: 'Time actor', role: 'MANAGER' }]);
        state.set('locations', [{ id: locationId, name: 'Kitchen' }]);
        state.set('nextLocationCursor', 'location-next');
        // Reference rows are explicit setup standins, not catalog/RBAC proof.
        // Selection/reset logic itself is the actual rendered callback.
        if (options.view === 'team') {
            only(render().tree, node => node.type === 'button' && node.children.includes('Team Time')).props.onClick();
            only(render().tree, node => node.type === 'select' && node.props.value === '' && !node.props.disabled).props.onChange({ target: { value: userId } });
            await render().loadCards(userId, 'team');
        }
        only(render().tree, node => node.type === 'select' && node.props.value === '' && !node.props.disabled).props.onChange({ target: { value: locationId } });
        const input = only(render().tree, node => node.type === 'input' && node.props.type === 'number');
        expect(input.props.disabled).toBe(!active);
        if (active) input.props.onChange({ target: { value: '15' } });
    }
    function mainButton() {
        return only(render().tree, node => node.type === 'button' && node.children.some(child => typeof child === 'string'
            && (child.startsWith('Clock out ') || child.startsWith('Clock in '))));
    }
    function assertOpenAvailability() {
        const tree = render().tree;
        expect(mainButton().props.disabled).toBe(true);
        for (const title of ['Refresh', 'My Time', 'Team Time']) {
            expect(only(tree, node => node.type === 'button' && node.children.includes(title)).props.disabled).toBe(true);
        }
        const selectors = elements(tree).filter(node => node.type === 'select');
        expect(selectors).toHaveLength(options.view === 'team' ? 2 : 1);
        for (const select of selectors) expect(select.props.disabled).toBe(true);
        expect(correctButton().props.disabled).toBe(true);
        expect(elements(tree).some(node => node.props.role === 'note' && node.children.some(child => typeof child === 'string'
            && child.startsWith('Save or cancel the correction')))).toBe(true);
        expect(reason).toBe('New unsaved verified correction.');
        expect(elements(tree).filter(node => node.type === Panel)).toHaveLength(1);
    }
    async function parentSaved(ack: TimeCard = structuredClone(original), canClose: () => boolean = () => true) {
        const node = only(render().tree, item => item.type === Panel);
        // Only the actual parent callback is exercised. No child PATCH/commit
        // outcome is fabricated or qualified by this composition.
        await node.props.onSaved(ack, canClose);
    }
    async function startMain() {
        const main = mainButton();
        expect(main.props.disabled, 'Only an actually enabled settled main action is invoked').toBe(false);
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
        expect(historyNode.props.isCorrectionOpen).toBe(Boolean(state.get('correctingCard')));
        const row = only(renderHistory(historyNode.props), node => node.type === 'tr' && node.props.key === cardId);
        return only(row, node => node.type === 'button' && node.children.includes('Correct'));
    }
    function cancelCorrection() {
        const node = only(render().tree, item => item.type === Panel);
        node.props.onCancel();
        expect(elements(render().tree).filter(item => item.type === Panel)).toHaveLength(0);
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
        const change = new Function('updateReason', reasonChange)((value: string) => { reason = value; }) as (event: unknown) => void;
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
    return { state, effects, calls, writes, unexpected, settleCallbacks: () => Promise.all(callbackSettlements), unmount: () => ownerCleanup?.(), prepare, startMain, mainButton, assertOpenAvailability, parentSaved, cancelCorrection, openCorrection, drain, assertNoAdditionalTransport, cleanup, render, reason: () => reason };
}
// The immutable original3-case baseline is retained privately. Final cases
// prove a different, explicit availability contract: resolve the correction
// before discarding/replacing actions. Disabled callbacks are never invoked.
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('actual open correction Save or Cancel availability contract', () => {
    it('blocks main clock-out and discarding My Time controls while retaining the open draft without another handoff', async () => {
        const f = fixture('acknowledged');
        try { await f.prepare(); f.openCorrection(); const calls = structuredClone(f.calls);
            f.assertOpenAvailability(); f.assertOpenAvailability();
            expect(f.calls).toEqual(calls); expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
        } finally { await f.cleanup(); }
    });
    it('blocks team employee and location replacement along with main and History actions while a correction is open', async () => {
        const f = fixture('acknowledged', { view: 'team' });
        try { await f.prepare(); f.openCorrection(); const calls = structuredClone(f.calls);
            f.assertOpenAvailability(); expect(f.calls).toEqual(calls); expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
        } finally { await f.cleanup(); }
    });
    it('blocks main clock-in for an earlier-open historical correction without claiming an issued request', async () => {
        const f = fixture('acknowledged', { active: false });
        try { await f.prepare(); expect(f.mainButton().props.disabled).toBe(false); f.openCorrection();
            const calls = structuredClone(f.calls); f.assertOpenAvailability();
            expect(f.calls).toEqual(calls); expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
        } finally { await f.cleanup(); }
    });
    it('keeps unrelated main Break and Notes edits available without discarding the correction or making requests', async () => {
        const f = fixture('acknowledged');
        try { await f.prepare(); f.openCorrection(); const calls = structuredClone(f.calls);
            const tree = f.render().tree;
            const input = only(tree, node => node.type === 'input' && node.props.type === 'number');
            const notes = only(tree, node => node.type === 'input' && node.props.placeholder === 'Optional');
            expect(input.props.disabled).toBe(false); expect(notes.props.disabled).toBe(false);
            input.props.onChange({ target: { value: '20' } }); notes.props.onChange({ target: { value: 'Separate main draft' } });
            expect(f.state.get('breakMinutes')).toBe('20'); expect(f.state.get('notes')).toBe('Separate main draft');
            f.assertOpenAvailability(); expect(f.calls).toEqual(calls); expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
        } finally { await f.cleanup(); }
    });
    it('keeps load-more and earlier-history reads available while preserving the same correction draft', async () => {
        const f = fixture('acknowledged');
        try { await f.prepare(); f.openCorrection();
            expect(only(f.render().tree, node => node.type === 'button' && node.children.includes('Load more locations')).props.disabled).toBe(false);
            await f.render().loadMoreLocations();
            const historyNode = only(f.render().tree, node => node.type === History);
            expect(only(new Function('React', 'formatTimeCardDuration', 'formatTimeCardTimestamp', historyExecutable)(
                React, timeFormat.formatTimeCardDuration, timeFormat.formatTimeCardTimestamp)(historyNode.props),
                node => node.type === 'button' && node.children.includes('Load earlier records')).props.disabled).toBe(false);
            await f.render().loadEarlierCards();
            f.assertOpenAvailability(); expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
            expect(f.calls).toEqual([
                { path: `/time-cards/active?userId=${userId}`, method: 'GET' },
                { path: `/time-cards?limit=100&userId=${userId}`, method: 'GET' },
                { path: '/locations?limit=200&cursor=location-next', method: 'GET' },
                { path: `/time-cards?limit=100&cursor=history-next&userId=${userId}`, method: 'GET' },
            ]);
        } finally { await f.cleanup(); }
    });
    it('restores enabled main clock-out after explicit Cancel and preserves its normal acknowledgment and readback', async () => {
        const f = fixture('acknowledged');
        try { await f.prepare(); f.openCorrection(); f.assertOpenAvailability(); f.cancelCorrection();
            expect(f.mainButton().props.disabled).toBe(false); await f.startMain(); await f.drain();
            expect(elements(f.render().tree).filter(node => node.type === Panel)).toHaveLength(0);
            expect(f.state.get('breakMinutes')).toBe('30'); expect(f.state.get('cards')[0]).toMatchObject({ id: cardId, status: 'CLOSED', breakMinutes: 15 });
        } finally { await f.cleanup(); }
    });
    it('restores eligible main actions after the actual parent saved callback clears the panel and completes scoped reload', async () => {
        const f = fixture('acknowledged');
        try { await f.prepare(); f.openCorrection(); f.assertOpenAvailability(); await f.parentSaved();
            expect(f.mainButton().props.disabled).toBe(false); expect(f.state.get('notice')).toBe('Time card corrected.');
            expect(elements(f.render().tree).filter(node => node.type === Panel)).toHaveLength(0);
            expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]);
            expect(f.calls).toEqual([
                { path: `/time-cards/active?userId=${userId}`, method: 'GET' },
                { path: `/time-cards?limit=100&userId=${userId}`, method: 'GET' },
                { path: `/time-cards/active?userId=${userId}`, method: 'GET' },
                { path: `/time-cards?limit=100&userId=${userId}`, method: 'GET' },
            ]);
        } finally { await f.cleanup(); }
    });
    it('keeps structured main rejection and its draft intact after explicit correction cancellation', async () => {
        const f = fixture('rejected');
        try { await f.prepare(); f.openCorrection(); f.assertOpenAvailability(); f.cancelCorrection();
            await f.startMain(); await f.drain();
            expect(f.state.get('error')).toBe('Break input rejected.'); expect(f.state.get('breakMinutes')).toBe('15');
            expect(elements(f.render().tree).filter(node => node.type === Panel)).toHaveLength(0);
        } finally { await f.cleanup(); }
    });
});


// Real complete workspace loadCards and loadEarlierCards are exercised through
// the closed transport ledger. The response roster stands in for an authoritative
// backend page; this does not qualify database ordering, React, or browser I/O.
describe('correction readback retains draft and refreshes moving history cursors', () => {
    it('refreshes A10 B9 cursor after B moves to7 so load earlier still includes previously unloaded C8', async () => {
        const row = (id: string, hour: number): TimeCard => ({ ...selected, id, status: 'CLOSED',
            clockInAt: `2026-10-04T${String(hour).padStart(2, '0')}:00:00.000Z`,
            clockOutAt: `2026-10-04T${String(hour + 1).padStart(2, '0')}:00:00.000Z` });
        const a = row('card-A10', 10), b = row(cardId, 9), c = row('card-C8', 8);
        const acknowledged = { ...b, clockInAt: '2026-10-04T07:00:00.000Z', clockOutAt: '2026-10-04T08:00:00.000Z',
            updatedAt: '2026-10-04T12:00:00.000Z' };
        const f = fixture('acknowledged', { active: false, history: { first: [a, b], refreshed: [a, c], earlier: [acknowledged] } });
        try {
            await f.prepare(); f.openCorrection();
            const before = only(f.render().tree, node => node.type === Panel);
            expect(f.state.get('nextCardsCursor')).toBe('cursor-B9');
            await f.parentSaved(acknowledged, () => false);
            const after = only(f.render().tree, node => node.type === Panel);
            expect(after.props.key).toBe(before.props.key); expect(after.props.card).toEqual(before.props.card);
            expect(f.reason()).toBe('New unsaved verified correction.');
            expect(f.state.get('cards')).toEqual([a, c]); expect(f.state.get('nextCardsCursor')).toBe('cursor-C8');
            const ownerHistory = only(f.render().tree, node => node.type === History);
            const renderedHistory = new Function('React', 'formatTimeCardDuration', 'formatTimeCardTimestamp', historyExecutable)(
                React, timeFormat.formatTimeCardDuration, timeFormat.formatTimeCardTimestamp)(ownerHistory.props);
            const earlier = only(renderedHistory, node => node.type === 'button' && node.children.includes('Load earlier records'));
            expect(earlier.props.disabled).toBe(false); earlier.props.onClick(); await f.settleCallbacks();
            expect(f.state.get('cards')).toEqual([a, c, acknowledged]); expect(f.state.get('nextCardsCursor')).toBeNull();
            expect(f.calls.filter(call => call.path.includes('cursor='))).toEqual([
                { path: `/time-cards?limit=100&cursor=cursor-C8&userId=${userId}`, method: 'GET' }]);
            expect(f.unexpected).toEqual([]); expect(f.writes).toEqual([]);
        } finally { await f.cleanup(); }
    });

    it('retains editor identity after an acknowledged save whose history readback fails without turning it into a write refusal', async () => {
        const f = fixture('acknowledged', { refreshFailure: true });
        try {
            await f.prepare(); f.openCorrection(); const before = only(f.render().tree, node => node.type === Panel);
            await f.parentSaved({ ...selected, updatedAt: '2026-10-04T12:00:00.000Z' });
            const after = only(f.render().tree, node => node.type === Panel);
            expect(after.props.key).toBe(before.props.key); expect(after.props.card).toEqual(before.props.card);
            expect(f.reason()).toBe('New unsaved verified correction.'); expect(f.state.get('notice')).toBe('Time card corrected.');
            expect(f.state.get('error')).toContain('history and new clock-ins are unavailable');
            expect(f.state.get('canStartNewTimeCard')).toBe(false); expect(f.state.get('cards')).toEqual([]);
            expect(f.state.get('nextCardsCursor')).toBeNull(); expect(f.state.get('isCardsLoading')).toBe(false);
            expect(f.unexpected).toEqual([]); expect(f.writes).toEqual([]);
        } finally { await f.cleanup(); }
    });
});


describe('actual correction history readback ownership', () => {
    it('does not publish late history rows or close the editor after the actual owner cleanup invalidates its generation', async () => {
        const gate = deferred<void>(), entered = deferred<void>();
        const f = fixture('acknowledged', { readbackHold: gate.promise, readbackEntered: () => entered.resolve() });
        let pending: Promise<void> | undefined;
        try {
            await f.prepare(); f.openCorrection(); pending = f.parentSaved({ ...selected, updatedAt: '2026-10-04T12:00:00.000Z' });
            await entered.promise;
            const before = structuredClone([...f.state]), effectCount = f.effects.length;
            f.unmount(); gate.resolve(); await pending;
            expect([...f.state]).toEqual(before); expect(f.effects).toHaveLength(effectCount);
            expect(f.state.get('correctingCard')).not.toBeNull(); expect(f.unexpected).toEqual([]); expect(f.writes).toEqual([]);
        } finally { gate.resolve(); await pending; await f.cleanup(); }
    });
});
