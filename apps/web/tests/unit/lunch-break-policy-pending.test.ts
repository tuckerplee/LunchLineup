import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithSession } from '@/lib/client-api';
import { fetchAllBoundedPages } from '@/lib/bounded-pagination';
import { getWorkspaceCapabilities } from '@/lib/permissions';
import { safeTimeZone } from '@/lib/location-timezone';
import * as scopes from '../../app/dashboard/lunch-breaks/lunch-break-scope';
import { claimLunchBreakDayLoadRequest } from '../../app/dashboard/lunch-breaks/lunch-break-load-ownership';
import { lunchBreakDayWindow, lunchBreakTimeValue } from '../../app/dashboard/lunch-breaks/lunch-break-time';

vi.mock('@/lib/client-api', () => ({ fetchWithSession: vi.fn() }));

// Bounded source composition, not a mounted page: retain complete relevant
// callbacks and actual planning JSX. No save/reset/payload logic is duplicated.
// The original enabled-edit loss oracle is preserved in phase81 baseline custody;
// this candidate verifies prevention and settled restoration without invoking a disabled input.
const source = readFileSync(resolve(process.cwd(), 'app/dashboard/lunch-breaks/page.tsx'), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owners = ast.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'LunchBreaksPage');
if (owners.length !== 1 || !owners[0].body) throw new Error('Expected exact LunchBreaksPage owner');
const declarations = owners[0].body.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations]);
function declaration(name: string) {
    const matches = declarations.filter(node => node.name.getText(ast) === name);
    if (matches.length !== 1) throw new Error('Expected exact declaration ' + name);
    return matches[0];
}
function topConstant(name: string) {
    const matches = ast.statements.filter(ts.isVariableStatement)
        .flatMap(statement => [...statement.declarationList.declarations])
        .filter(node => node.name.getText(ast) === name);
    if (matches.length !== 1) throw new Error('Expected exact constant ' + name);
    return 'const ' + matches[0].getText(ast) + ';';
}
function helper(name: string) {
    const matches = ast.statements.filter((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (matches.length !== 1) throw new Error('Expected exact helper ' + name);
    return matches[0].getText(ast);
}
const stateDeclarations = declarations.filter(node => node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(ast) === 'useState');
const stateNames = stateDeclarations.map(node => {
    if (!ts.isArrayBindingPattern(node.name) || !ts.isBindingElement(node.name.elements[0])) throw new Error('Expected named state slot');
    return node.name.elements[0].name.getText(ast);
});
const selectedRefs = ['desiredDayScopeRef', 'dayLoadRequestRef'];
const derived = ['capabilities', 'canWriteLunchBreaks', 'activeLocation', 'activeTimeZone', 'lunchBreakFeature'];
const callbacks = ['commitActiveDayScope', 'clearDayRows', 'clearScopedDisplayState', 'loadDayRows', 'selectDayScope', 'handleSavePolicy'];
const policyMaps: ts.CallExpression[] = [];
const saveButtons: ts.JsxElement[] = [];
function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(ast) === 'POLICY_FIELDS' && node.expression.name.text === 'map') policyMaps.push(node);
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Button'
        && node.openingElement.attributes.properties.some(prop => ts.isJsxAttribute(prop)
            && prop.name.getText(ast) === 'onClick' && prop.initializer && ts.isJsxExpression(prop.initializer)
            && prop.initializer.expression?.getText(ast) === 'handleSavePolicy')) saveButtons.push(node);
    ts.forEachChild(node, visit);
}
visit(owners[0]);
if (policyMaps.length !== 1 || saveButtons.length !== 1) throw new Error('Expected exact policy map and Save button');
let saveConditional: ts.Node = saveButtons[0];
while (!ts.isConditionalExpression(saveConditional)) {
    if (!saveConditional.parent) throw new Error('Expected actual Save permission conditional');
    saveConditional = saveConditional.parent;
}
function javascript(text: string) {
    return ts.transpileModule(text, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React,
    } }).outputText;
}
const executable = javascript(`
${['DEFAULT_POLICY', 'POLICY_FIELDS', 'DATE_BOOTSTRAP_PLACEHOLDER'].map(topConstant).join('\n')}
${['defaultManualShifts', 'cloneRow', 'buildEditableBreak', 'toDayShiftRow', 'getCsrfTokenFromCookie', 'jsonWriteInit'].map(helper).join('\n')}
function render() {
${stateDeclarations.map(node => 'const ' + node.getText(ast) + ';').join('\n')}
${[...selectedRefs, ...derived, ...callbacks].map(name => 'const ' + declaration(name).getText(ast) + ';').join('\n')}
return { handleSavePolicy, selectDayScope, clearScopedDisplayState,
    inputs: (${policyMaps[0].getText(ast)}), save: (${saveConditional.getText(ast)}) };
}
return { render, defaults: DEFAULT_POLICY };`);
type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element {
    return { type, props: props ?? {}, children };
} };
const Button = Symbol('actual Save button boundary');
function elements(tree: unknown): Element[] {
    if (Array.isArray(tree)) return tree.flatMap(elements);
    if (!tree || typeof tree !== 'object' || !('type' in tree)) return [];
    const node = tree as Element; return [node, ...node.children.flatMap(elements)];
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
type Outcome = 'acknowledged' | 'rejected';
function fixture(outcome: Outcome) {
    const state = new Map<string, any>(), refs = new Map<string, { current: any }>();
    const effects: Array<{ name: string; value: unknown }> = [];
    let stateOrdinal = 0, refOrdinal = 0;
    const entered = deferred<void>(), release = deferred<void>(), dayFinished = deferred<void>();
    const calls: Array<{ path: string; method: string }> = [], writes: unknown[] = [], unexpected: string[] = [];
    const scopeA = { locationId: 'location-a', dateValue: '2026-10-04', epoch: 1 };
    const scopeB = { locationId: 'location-b', dateValue: '2026-10-05', epoch: 2 };
    const dayPath = (scope: typeof scopeA) => '/lunch-breaks?' + new URLSearchParams({
        startDate: scope.dateValue + 'T00:00:00.000Z',
        endDate: scope.locationId === 'location-a' ? '2026-10-05T00:00:00.000Z' : '2026-10-06T00:00:00.000Z',
        locationId: scope.locationId, limit: '200',
    }).toString();
    // Literal independently selected UTC window, compared to actual helper below.
    const actualA = lunchBreakDayWindow(scopeA.dateValue, 'UTC');
    const actualB = lunchBreakDayWindow(scopeB.dateValue, 'UTC');
    expect(actualA).toEqual({ startIso: '2026-10-04T00:00:00.000Z', endIso: '2026-10-05T00:00:00.000Z' });
    expect(actualB).toEqual({ startIso: '2026-10-05T00:00:00.000Z', endIso: '2026-10-06T00:00:00.000Z' });
    const bindings = { React, Button, ...scopes, claimLunchBreakDayLoadRequest, lunchBreakDayWindow,
        lunchBreakTimeValue, getWorkspaceCapabilities, safeTimeZone, fetchAllBoundedPages, fetchWithSession,
        useCallback: (callback: unknown) => callback,
        useMemo: (compute: () => unknown) => compute(),
        useRef: (initial: unknown) => {
            const name = selectedRefs[refOrdinal++]; if (!name) throw new Error('Unexpected selected ref');
            if (!refs.has(name)) refs.set(name, { current: initial }); return refs.get(name);
        },
        useState: (initial: unknown) => {
            const name = stateNames[stateOrdinal++]; if (!name) throw new Error('Unexpected state');
            if (!state.has(name)) state.set(name, typeof initial === 'function' ? (initial as () => unknown)() : initial);
            return [state.get(name), (value: unknown) => {
                const next = typeof value === 'function' ? (value as (current: unknown) => unknown)(state.get(name)) : value;
                state.set(name, next); effects.push({ name, value: structuredClone(next) });
                if (name === 'isDayLoading' && next === false) dayFinished.resolve();
            }];
        },
    };
    const selected = new Function(...Object.keys(bindings), executable)(...Object.values(bindings)) as {
        defaults: Record<string, number>; render: () => {
            handleSavePolicy: () => Promise<void>; selectDayScope: (date: string, location: string) => void;
            clearScopedDisplayState: () => void; inputs: Element[]; save: Element | null;
        };
    };
    const requested = structuredClone(selected.defaults);
    vi.mocked(fetchWithSession).mockImplementation(async (path, init) => {
        const method = init?.method ?? 'GET'; calls.push({ path, method });
        if (path === '/lunch-breaks/policy' && method === 'PUT' && typeof init?.body === 'string') {
            writes.push(JSON.parse(init.body)); entered.resolve(); await release.promise;
            return new Response(JSON.stringify(outcome === 'acknowledged' ? requested : { message: 'Controlled policy rejection' }),
                { status: outcome === 'acknowledged' ? 200 : 422, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && [dayPath(scopeA), dayPath(scopeB)].includes(path)) {
            return new Response(JSON.stringify({ data: [], pagination: { hasMore: false, nextCursor: null } }),
                { headers: { 'Content-Type': 'application/json' } });
        }
        unexpected.push(method + ' ' + path); throw new Error('Unexpected policy/day transport');
    });
    function render() {
        stateOrdinal = 0; refOrdinal = 0; const result = selected.render();
        expect(stateOrdinal).toBe(stateNames.length); expect(refOrdinal).toBe(selectedRefs.length); return result;
    }
    render();
    // Exact loaded policy/day/permission standins; no bootstrap/auth/network
    // qualification. Actual capabilities and save admission still execute.
    state.set('permissions', ['lunch_breaks:read', 'lunch_breaks:write', 'locations:read']);
    state.set('features', { usageCredits: 0, features: { lunch_breaks: { enabled: true }, scheduling: { enabled: false } } });
    state.set('locations', [{ id: scopeA.locationId, name: 'A', timezone: 'UTC' }, { id: scopeB.locationId, name: 'B', timezone: 'UTC' }]);
    state.set('selectedDate', scopeA.dateValue); state.set('selectedLocationId', scopeA.locationId);
    state.set('loadedDayScope', scopeA); state.set('isLoading', false);
    refs.get('desiredDayScopeRef')!.current = scopeA;
    function input() {
        const labels = render().inputs.filter(node => node.props.key === 'lunchDurationMinutes'); expect(labels).toHaveLength(1);
        const inputs = elements(labels[0]).filter(node => node.type === 'input'); expect(inputs).toHaveLength(1); return inputs[0];
    }
    let pending: Promise<void> | undefined;
    async function begin() {
        const button = render().save; expect(button?.type).toBe(Button); expect(button?.props.disabled).toBe(false);
        Object.assign(requested, state.get('policy'));
        pending = button!.props.onClick();
        const arrival = await Promise.race([entered.promise.then(() => 'entered'), pending!.then(() => 'settled')]);
        expect(arrival).toBe('entered'); expect(state.get('isSavingPolicy')).toBe(true);
        expect(writes).toEqual([requested]);
    }
    function edit(value: number) {
        const field = input(); expect(field.props.disabled, 'Event must be supported by actual policy control').toBe(false);
        field.props.onChange({ target: { value: String(value) } }); expect(state.get('policy').lunchDurationMinutes).toBe(value);
    }
    function planningAvailability(disabled: boolean) {
        const inputs = elements(render().inputs).filter(node => node.type === 'input'); expect(inputs).toHaveLength(7);
        for (const field of inputs) expect(field.props.disabled).toBe(disabled);
        expect(render().save?.props.disabled).toBe(disabled);
    }
    function noAdditionalTransport(expectedRead: 'A' | 'B' | 'none') {
        expect(unexpected, 'Unexpected calls cannot disappear inside owner catches').toEqual([]);
        expect(writes).toEqual([requested]);
        expect(calls).toEqual([{ path: '/lunch-breaks/policy', method: 'PUT' },
            ...(expectedRead === 'none' ? [] : [{ path: dayPath(expectedRead === 'A' ? scopeA : scopeB), method: 'GET' }])]);
    }
    async function switchScope() {
        render().selectDayScope(scopeB.dateValue, scopeB.locationId); await dayFinished.promise;
        expect(refs.get('desiredDayScopeRef')!.current).toEqual(scopeB);
        expect(state.get('loadedDayScope')).toEqual(scopeB); expect(state.get('isDayLoading')).toBe(false);
    }
    async function drain(expectedRead: 'A' | 'B' | 'none') {
        release.resolve(); await pending;
        noAdditionalTransport(expectedRead);
        expect(state.get('isSavingPolicy')).toBe(false); expect(state.get('isDayLoading')).toBe(false);
    }
    async function cleanup() { release.resolve(); await pending?.catch(() => undefined); }
    return { state, effects, input, begin, edit, planningAvailability, noAdditionalTransport,
        switchScope, drain, cleanup, requested, loadedDefaults: selected.defaults };
}
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('actual Lunch Break policy pending availability', () => {
    it('makes every planning field unavailable during the same-scope save and restores editing after acknowledgment and complete day readback', async () => {
        const f = fixture('acknowledged');
        try { f.planningAvailability(false); await f.begin(); f.planningAvailability(true);
            // Disabled controls are asserted without manually dispatching their callback.
            expect(f.input().props.value).toBe(30); await f.drain('A'); f.planningAvailability(false);
            f.edit(45); expect(f.input().props.value).toBe(45); f.noAdditionalTransport('A');
        } finally { await f.cleanup(); }
    });
    it('keeps unchanged acknowledged policy values and completes the actual scoped day refresh', async () => {
        const f = fixture('acknowledged');
        try { await f.begin(); await f.drain('A'); expect(f.input().props.value).toBe(30);
            expect(f.state.get('policyLoaded')).toEqual(f.requested); expect(f.state.get('error')).toBeNull();
            f.planningAvailability(false);
        } finally { await f.cleanup(); }
    });
    it('retains the submitted preexisting draft on rejection and allows a subsequent edit without a day refresh', async () => {
        const f = fixture('rejected');
        try { f.edit(45); await f.begin(); f.planningAvailability(true);
            expect(f.requested.lunchDurationMinutes).toBe(45); await f.drain('none'); expect(f.input().props.value).toBe(45);
            expect(f.state.get('policyLoaded')).toEqual(f.loadedDefaults); expect(f.state.get('error')).toBe('Failed to save lunch/break policy.');
            f.planningAvailability(false); f.edit(60); expect(f.input().props.value).toBe(60); f.noAdditionalTransport('none');
        } finally { await f.cleanup(); }
    });
    it('rejects the old policy completion after the actual day-scope owner loads another location and date', async () => {
        const f = fixture('acknowledged');
        try { f.edit(45); await f.begin(); f.planningAvailability(true); await f.switchScope();
            // Actual scope change clears its display busy flag. The stale completion
            // must still fail the original scope guard; no new scope restriction is added.
            f.planningAvailability(false); f.edit(60); await f.drain('B');
            expect(f.input().props.value).toBe(60); expect(f.state.get('policyLoaded')).toEqual(f.loadedDefaults);
            expect(f.state.get('error')).toBeNull();
        } finally { await f.cleanup(); }
    });
});
