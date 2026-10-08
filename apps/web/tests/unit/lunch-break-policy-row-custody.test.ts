import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithSession, apiPath, withIdempotencyKey } from '@/lib/client-api';
import { fetchAllBoundedPages } from '@/lib/bounded-pagination';
import { getWorkspaceCapabilities } from '@/lib/permissions';
import { safeTimeZone } from '@/lib/location-timezone';
import { breakTimingIssue } from '../../app/dashboard/lunch-breaks/break-timing-validation';
import * as scopes from '../../app/dashboard/lunch-breaks/lunch-break-scope';
import { claimLunchBreakDayLoadRequest } from '../../app/dashboard/lunch-breaks/lunch-break-load-ownership';
import { lunchBreakDayWindow, lunchBreakTimeValue, resolveLunchBreakInstant } from '../../app/dashboard/lunch-breaks/lunch-break-time';
import {
    createShiftBreakUpdateSubmissionState, submitShiftBreakUpdate,
    readShiftBreakUpdateResponse, ShiftBreakUpdateRequestError, readShiftBreakUpdateRecovery,
} from '../../app/dashboard/lunch-breaks/shift-break-update-recovery';

vi.mock('@/lib/client-api', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/client-api')>(), fetchWithSession: vi.fn(),
}));

// Actual-source composition only: complete callbacks, state initializers,
// row JSX and selected dirty-row effect. Memo/effect identity and cleanup are
// modeled at explicit commit checkpoints; there is no React mount/browser/DB.
const source = readFileSync(resolve(process.cwd(), 'app/dashboard/lunch-breaks/page.tsx'), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const owner = ast.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'LunchBreaksPage');
if (owner.length !== 1 || !owner[0].body) throw new Error('Expected exact LunchBreaksPage');
const declarations = owner[0].body.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations]);
function declaration(name: string) {
    const found = declarations.filter(node => node.name.getText(ast) === name);
    if (found.length !== 1) throw new Error('Expected exact declaration ' + name);
    return found[0];
}
function constant(name: string) {
    const found = ast.statements.filter(ts.isVariableStatement)
        .flatMap(statement => [...statement.declarationList.declarations])
        .filter(node => node.name.getText(ast) === name);
    if (found.length !== 1) throw new Error('Expected exact constant ' + name);
    return 'const ' + found[0].getText(ast) + ';';
}
function helper(name: string) {
    const found = ast.statements.filter((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (found.length !== 1) throw new Error('Expected exact helper ' + name);
    return found[0].getText(ast);
}
const stateDeclarations = declarations.filter(node => node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(ast) === 'useState');
const stateNames = stateDeclarations.map(node => {
    if (!ts.isArrayBindingPattern(node.name) || !ts.isBindingElement(node.name.elements[0])) throw new Error('Expected state slot');
    return node.name.elements[0].name.getText(ast);
});
const selectedNames = new Set([
    'desiredDayScopeRef', 'dayLoadRequestRef', 'shiftBreakUpdateSubmissionRef', 'shiftBreakSaveButtonRef',
    'recoveryFocusIntentRef', 'recoveryFocusAttemptRef',
    'capabilities', 'canWriteLunchBreaks', 'activeLocation', 'activeTimeZone', 'desiredDayScope',
    'isLoadedDayScopeCurrent', 'canWriteLoadedDay', 'lunchBreakFeature', 'hasPendingDayRowChanges', 'dirtyCount',
    'commitActiveDayScope', 'clearDayRows', 'clearScopedDisplayState', 'loadDayRows', 'selectDayScope',
    'updateBreak', 'resetRow', 'handleSavePolicy', 'saveRow', 'saveAllDirtyRows', 'selectedRow', 'hasSharedRows',
    'effectivePlannerMode', 'isAutoMode',
]);
const selectedDeclarations = declarations.filter(node => selectedNames.has(node.name.getText(ast)));
if (selectedDeclarations.length !== selectedNames.size) throw new Error('Missing selected owner declaration');
function hookNames(hook: string) {
    return selectedDeclarations.filter(node => node.initializer && ts.isCallExpression(node.initializer)
        && node.initializer.expression.getText(ast) === hook).map(node => node.name.getText(ast));
}
const refNames = hookNames('useRef'), callbackNames = hookNames('useCallback'), memoNames = hookNames('useMemo');
const rowMaps: ts.CallExpression[] = [], policyButtons: ts.JsxElement[] = [], rowSelections: ts.ArrowFunction[] = [];
const pauseStatuses: ts.JsxElement[] = [];
const rowButtons = new Map<string, ts.JsxElement[]>();
const effects: ts.ExpressionStatement[] = [];
function visit(node: ts.Node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'div'
        && node.openingElement.attributes.properties.some(prop => ts.isJsxAttribute(prop)
            && prop.name.getText(ast) === 'role' && prop.initializer && ts.isStringLiteral(prop.initializer)
            && prop.initializer.text === 'status') && node.getText(ast).includes('Autosave paused.')) pauseStatuses.push(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(ast) === 'BREAK_KEYS' && node.expression.name.text === 'map'
        && node.getText(ast).includes('aria-label={`${info.label} duration')) rowMaps.push(node);
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Button'
        && node.openingElement.attributes.properties.some(prop => ts.isJsxAttribute(prop)
            && prop.name.getText(ast) === 'onClick' && prop.initializer && ts.isJsxExpression(prop.initializer)
            && prop.initializer.expression?.getText(ast) === 'handleSavePolicy')) policyButtons.push(node);
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'Button') {
        for (const property of node.openingElement.attributes.properties) {
            if (!ts.isJsxAttribute(property) || property.name.getText(ast) !== 'onClick'
                || !property.initializer || !ts.isJsxExpression(property.initializer)) continue;
            const text = property.initializer.expression?.getText(ast);
            for (const [name, callback] of [['save', '() => void saveRow(selectedRow.shiftId)'],
                ['reset', '() => resetRow(selectedRow.shiftId)'], ['all', '() => void saveAllDirtyRows()']]) {
                if (text === callback) rowButtons.set(name, [...(rowButtons.get(name) ?? []), node]);
            }
        }
    }
    if (ts.isArrowFunction(node) && node.getText(ast) === '() => setSelectedShiftId(row.id)') rowSelections.push(node);
    ts.forEachChild(node, visit);
}
visit(owner[0]);
for (const statement of owner[0].body.statements) {
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
        && statement.expression.expression.getText(ast) === 'useEffect'
        && statement.getText(ast).includes('void saveRow(selectedRow.shiftId)')) effects.push(statement);
}
if (rowMaps.length !== 1 || policyButtons.length !== 1 || rowSelections.length !== 1 || effects.length !== 1 || pauseStatuses.length !== 1)
    throw new Error('Expected exact row JSX, row selection, policy button and autosave effect');
for (const name of ['save', 'reset', 'all']) if (rowButtons.get(name)?.length !== 1) throw new Error('Expected exact row button ' + name);
let policyConditional: ts.Node = policyButtons[0];
while (!ts.isConditionalExpression(policyConditional)) {
    if (!policyConditional.parent) throw new Error('Missing Save policy permission condition');
    policyConditional = policyConditional.parent;
}
let pauseConditional: ts.Node = pauseStatuses[0];
while (!ts.isConditionalExpression(pauseConditional)) {
    if (!pauseConditional.parent) throw new Error('Missing actual paused-status condition');
    pauseConditional = pauseConditional.parent;
}
function javascript(text: string) {
    return ts.transpileModule(text, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React,
    } }).outputText;
}
const executable = javascript(`
${['DEFAULT_POLICY', 'BREAK_KEYS', 'BREAK_META', 'DATE_BOOTSTRAP_PLACEHOLDER'].map(constant).join('\n')}
${['defaultManualShifts', 'cloneRow', 'buildEditableBreak', 'toDayShiftRow', 'toSavedDayShiftRow', 'breakStatusLabel', 'getCsrfTokenFromCookie', 'jsonWriteInit', 'fetchLunchBreakMutation'].map(helper).join('\n')}
function render() {
${stateDeclarations.map(node => 'const ' + node.getText(ast) + ';').join('\n')}
${selectedDeclarations.map(node => 'const ' + node.getText(ast) + ';').join('\n')}
${effects[0].getText(ast)}
return { handleSavePolicy, selectDayScope, loadDayRows, saveRow, saveAllDirtyRows, updateBreak, resetRow, selectedRow,
    canWriteLoadedDay, isAutoMode, hasSharedRows,
    inputs: selectedRow && isAutoMode && hasSharedRows ? (${rowMaps[0].getText(ast)}) : [],
    policySave: (${policyConditional.getText(ast)}),
    pauseStatus: selectedRow && isAutoMode && hasSharedRows ? (${pauseConditional.getText(ast)}) : null,
    rowSave: selectedRow ? (${rowButtons.get('save')![0].getText(ast)}) : null,
    rowReset: selectedRow ? (${rowButtons.get('reset')![0].getText(ast)}) : null,
    saveAll: (${rowButtons.get('all')![0].getText(ast)}),
    select: (id) => { const row = { id }; return (${rowSelections[0].getText(ast)})(); } };
}
return { render, defaults: DEFAULT_POLICY };`);
type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element {
    return { type, props: props ?? {}, children };
} };
const Button = Symbol('actual policy button');
function elements(tree: unknown): Element[] {
    if (Array.isArray(tree)) return tree.flatMap(elements);
    if (!tree || typeof tree !== 'object' || !('type' in tree)) return [];
    const node = tree as Element; return [node, ...node.children.flatMap(elements)];
}
function visibleText(tree: unknown): string {
    if (Array.isArray(tree)) return tree.map(visibleText).join('');
    if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
    if (!tree || typeof tree !== 'object' || !('children' in tree)) return '';
    return (tree as Element).children.map(visibleText).join('');
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
const sameDependencies = (a: readonly unknown[], b: readonly unknown[]) =>
    a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
type Memo = { dependencies: readonly unknown[]; value: any };
type Mode = 'ack' | 'reject';
type RowOutcome = 'ack45' | 'ack50' | 'reject' | 'forbidden' | 'conflict' | 'uncertain'
    | 'null2xx' | 'nonjson2xx' | 'missingfields2xx' | 'foreignshift2xx' | 'reordered2xx' | 'skipped2xx'
    | 'badmetadata2xx' | 'badbreak2xx' | 'invalidinstant2xx' | 'duplicatetype2xx' | 'overnightoffset2xx';
async function fixture(mode: Mode, options: { deferReadback?: boolean; deferRow?: boolean; rejectRow?: boolean; extraRow?: boolean; rowOutcome?: RowOutcome; rowOutcomes?: RowOutcome[] } = {}) {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T08:00:00.000Z'));
    const state = new Map<string, any>(), refs = new Map<string, { current: any }>();
    const callbacks = new Map<string, Memo>(), memos = new Map<string, Memo>();
    const calls: Array<{ path: string; method: string; body?: unknown }> = [], unexpected: string[] = [];
    const rowMetadata: Array<{ key: string | null; credentials: unknown; redirect: unknown; signal: unknown }> = [];
    const saves: Promise<boolean>[] = [], loads: Promise<unknown>[] = [];
    const entered = deferred<void>(), release = deferred<void>();
    const readbackEntered = deferred<void>(), readbackRelease = deferred<void>(), rowEntered = deferred<void>(), rowRelease = deferred<void>();
    let policyAck = false;
    let stateIndex = 0, refIndex = 0, callbackIndex = 0, memoIndex = 0;
    let effectDependencies: readonly unknown[] | undefined, effectCleanup: (() => void) | undefined;
    let queuedEffect: (() => void | (() => void)) | undefined;
    let scheduleCount = 0, cleanupCount = 0, firedCount = 0;
    const scopeA = { locationId: 'location-a', dateValue: '2026-10-04', epoch: 1 };
    const scopeB = { locationId: 'location-b', dateValue: '2026-10-05', epoch: 2 };
    const wire = (scope: typeof scopeA, extra = false) => ({
        shiftId: extra ? 'shift-extra' : scope.locationId === 'location-a' ? 'shift-a' : 'shift-b',
        userId: extra ? 'employee-b' : 'employee-a', employeeName: extra ? 'Bea' : 'Ada',
        startTime: scope.dateValue + 'T09:00:00.000Z', endTime: scope.dateValue + 'T17:00:00.000Z',
        breaks: [{ type: 'lunch', startTime: scope.dateValue + 'T12:00:00.000Z',
            endTime: scope.dateValue + 'T12:30:00.000Z', durationMinutes: 30, paid: false }],
    });
    const dayPath = (scope: typeof scopeA) => '/lunch-breaks?' + new URLSearchParams({
        startDate: scope.dateValue + 'T00:00:00.000Z',
        endDate: scope.locationId === 'location-a' ? '2026-10-05T00:00:00.000Z' : '2026-10-06T00:00:00.000Z',
        locationId: scope.locationId, limit: '200',
    }).toString();
    expect(lunchBreakDayWindow(scopeA.dateValue, 'UTC')).toEqual({ startIso: '2026-10-04T00:00:00.000Z', endIso: '2026-10-05T00:00:00.000Z' });
    const storageMap = new Map<string, string>();
    const localStorage = { getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, value: string) => { storageMap.set(key, value); }, removeItem: (key: string) => { storageMap.delete(key); } };
    const windowLike = { localStorage, requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
        setTimeout: (fn: () => void, ms: number) => { expect(ms).toBe(650); scheduleCount++; return globalThis.setTimeout(() => { firedCount++; fn(); }, ms); },
        clearTimeout: (id: ReturnType<typeof setTimeout>) => { cleanupCount++; globalThis.clearTimeout(id); } };
    vi.stubGlobal('window', windowLike);
    // Actual saveRow reads browser focus before its first await. This ledger
    // supplies a stable committed button and non-button default focus; the real
    // postcommit focus effect remains covered by the browser recovery case.
    const documentLike = { cookie: '', body: {}, activeElement: null as unknown };
    documentLike.activeElement = documentLike.body;
    const saveFocusNode = { isConnected: false, focus() { documentLike.activeElement = this; } };
    vi.stubGlobal('document', documentLike);
    const bindings = { React, Button, ...scopes, claimLunchBreakDayLoadRequest,
        lunchBreakDayWindow, lunchBreakTimeValue, resolveLunchBreakInstant, breakTimingIssue,
        getWorkspaceCapabilities, safeTimeZone, fetchAllBoundedPages, fetchWithSession,
        apiPath, withIdempotencyKey, createShiftBreakUpdateSubmissionState, submitShiftBreakUpdate,
        readShiftBreakUpdateResponse, ShiftBreakUpdateRequestError,
        useState: (initial: unknown) => {
            const name = stateNames[stateIndex++]; if (!name) throw new Error('Unexpected state hook');
            if (!state.has(name)) state.set(name, typeof initial === 'function' ? (initial as () => unknown)() : initial);
            return [state.get(name), (next: unknown) => state.set(name,
                typeof next === 'function' ? (next as (previous: unknown) => unknown)(state.get(name)) : next)];
        },
        useRef: (initial: unknown) => {
            const name = refNames[refIndex++]; if (!name) throw new Error('Unexpected ref hook');
            if (!refs.has(name)) refs.set(name, { current: initial }); return refs.get(name);
        },
        useMemo: (compute: () => unknown, dependencies: readonly unknown[]) => {
            const name = memoNames[memoIndex++]; if (!name) throw new Error('Unexpected memo hook');
            const prior = memos.get(name);
            if (!prior || !sameDependencies(prior.dependencies, dependencies)) memos.set(name, { dependencies, value: compute() });
            return memos.get(name)!.value;
        },
        useCallback: (callback: (...args: any[]) => any, dependencies: readonly unknown[]) => {
            const name = callbackNames[callbackIndex++]; if (!name) throw new Error('Unexpected callback hook');
            const prior = callbacks.get(name);
            if (!prior || !sameDependencies(prior.dependencies, dependencies)) {
                // Only observe returned promises from the actual closure; no owner logic is replaced.
                const value = name === 'saveRow' ? (...args: any[]) => { const pending = callback(...args); saves.push(pending); return pending; }
                    : name === 'loadDayRows' ? (...args: any[]) => { const pending = callback(...args); loads.push(pending); return pending; }
                    : callback;
                callbacks.set(name, { dependencies, value });
            }
            return callbacks.get(name)!.value;
        },
        useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => {
            if (!effectDependencies || !sameDependencies(effectDependencies, dependencies)) {
                effectDependencies = dependencies; queuedEffect = effect;
            }
        },
    };
    const selected = new Function(...Object.keys(bindings), executable)(...Object.values(bindings)) as {
        defaults: Record<string, number>; render: () => {
            handleSavePolicy: () => Promise<void>; saveRow: (id: string) => Promise<boolean>; saveAllDirtyRows: () => Promise<void>;
            updateBreak: (id: string, key: string, next: unknown) => void; resetRow: (id: string) => void; selectDayScope: (date: string, location: string) => void;
            loadDayRows: (scope: typeof scopeA, policy: Record<string, number>, zone: string) => Promise<unknown>;
            select: (id: string) => void; selectedRow: any; inputs: Element[]; policySave: Element | null; pauseStatus: Element | null;
            rowSave: Element | null; rowReset: Element | null; saveAll: Element;
            isAutoMode: boolean; hasSharedRows: boolean; canWriteLoadedDay: boolean;
        };
    };
    const requested = structuredClone(selected.defaults);
    vi.mocked(fetchWithSession).mockImplementation(async (path, init) => {
        const method = init?.method ?? 'GET';
        if (path === '/lunch-breaks/policy' && method === 'PUT' && typeof init?.body === 'string') {
            const body = JSON.parse(init.body); calls.push({ path, method, body });
            entered.resolve(); await release.promise; policyAck = mode === 'ack';
            return new Response(JSON.stringify(mode === 'ack' ? requested : { message: 'Controlled refusal' }),
                { status: mode === 'ack' ? 200 : 422, headers: { 'Content-Type': 'application/json' } });
        }
        if (method === 'GET' && [dayPath(scopeA), dayPath(scopeB)].includes(path)) {
            calls.push({ path, method }); const scope = path === dayPath(scopeA) ? scopeA : scopeB;
            if (policyAck && options.deferReadback && path === dayPath(scopeA)) { readbackEntered.resolve(); await readbackRelease.promise; }
            return new Response(JSON.stringify({ data: [wire(scope), ...(options.extraRow ? [wire(scope, true)] : [])], pagination: { hasMore: false, nextCursor: null } }),
                { headers: { 'Content-Type': 'application/json' } });
        }
        unexpected.push(method + ' ' + path); throw new Error('Unexpected policy/day call');
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input), method = init?.method ?? 'GET';
        if (!['/api/v2/lunch-breaks/shift/shift-a', '/api/v2/lunch-breaks/shift/shift-b'].includes(path) || method !== 'PUT' || typeof init?.body !== 'string') {
            unexpected.push(method + ' ' + path); throw new Error('Unexpected shift transport');
        }
        const body = JSON.parse(init.body); calls.push({ path, method, body });
        rowMetadata.push({ key: new Headers(init.headers).get('idempotency-key'),
            credentials: init.credentials, redirect: init.redirect, signal: init.signal });
        // Select this handoff's outcome before an external wait; another
        // concurrent scoped transport must not change its ordinal/response.
        const rowOrdinal = rowMetadata.length - 1;
        const outcome = options.rowOutcomes ? options.rowOutcomes[rowOrdinal]
            : options.rowOutcome ?? (options.rejectRow ? 'reject' : 'ack45');
        rowEntered.resolve(); if (options.deferRow) await rowRelease.promise;
        const scope = path.endsWith('shift-a') ? scopeA : scopeB;
        if (!outcome) { unexpected.push('Unplanned shift outcome'); throw new Error('Unplanned shift outcome'); }
        if (outcome === 'uncertain') throw new TypeError('Controlled transport uncertainty');
        if (outcome === 'badmetadata2xx') return new Response(JSON.stringify({
            shiftId: 'shift-a', userId: null, employeeName: 23,
            startTime: '2026-10-04T09:00:00.000Z', endTime: '2026-10-04T17:00:00.000Z',
            breaks: [{ type: 'lunch', startTime: '2026-10-04T12:00:00.000Z', endTime: '2026-10-04T12:45:00.000Z', durationMinutes: 45, paid: false }],
        }), { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'badbreak2xx') return new Response(JSON.stringify({
            shiftId: 'shift-a', userId: 'employee-a', employeeName: 'Ada',
            startTime: '2026-10-04T09:00:00.000Z', endTime: '2026-10-04T17:00:00.000Z',
            breaks: [{ type: 'lunch', startTime: '2026-10-04T12:00:00.000Z', endTime: '2026-10-04T12:45:00.000Z', durationMinutes: 45, paid: 'false' }],
        }), { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'invalidinstant2xx') return new Response(JSON.stringify({
            shiftId: 'shift-a', userId: 'employee-a', employeeName: 'Ada',
            startTime: '2026-10-04T09:00:00.000Z', endTime: '2026-10-04T17:00:00.000Z',
            breaks: [{ type: 'lunch', startTime: '2026-10-04T12:61:00.000Z', endTime: '2026-10-04T13:45:00.000Z', durationMinutes: 45, paid: false }],
        }), { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'duplicatetype2xx') return new Response(JSON.stringify({
            shiftId: 'shift-a', userId: 'employee-a', employeeName: 'Ada',
            startTime: '2026-10-04T09:00:00.000Z', endTime: '2026-10-04T17:00:00.000Z',
            breaks: [
                { type: 'lunch', startTime: '2026-10-04T12:00:00.000Z', endTime: '2026-10-04T12:45:00.000Z', durationMinutes: 45, paid: false },
                { type: 'lunch', startTime: '2026-10-04T13:00:00.000Z', endTime: '2026-10-04T13:30:00.000Z', durationMinutes: 30, paid: false },
            ],
        }), { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'overnightoffset2xx') return new Response(JSON.stringify({
            shiftId: 'shift-a', userId: 'historical-user', employeeName: 'Historical employee',
            startTime: '2026-10-03T16:00:00-07:00', endTime: '2026-10-04T10:00:00-07:00',
            breaks: [{ type: 'lunch', startTime: '2026-10-04T05:00:00-07:00', endTime: '2026-10-04T05:50:00-07:00', durationMinutes: 50, paid: false }],
        }), { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'null2xx') return new Response('null',
            { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'nonjson2xx') return new Response('<html>Controlled incomplete acknowledgment</html>',
            { headers: { 'Content-Type': 'text/html' } });
        if (outcome === 'missingfields2xx') return new Response(JSON.stringify({ shiftId: 'shift-a' }),
            { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'foreignshift2xx') return new Response(JSON.stringify({
            shiftId: 'foreign-shift', userId: 'other-employee', employeeName: 'Other employee',
            startTime: '2026-10-04T09:00:00.000Z', endTime: '2026-10-04T17:00:00.000Z',
            breaks: [{ type: 'lunch', startTime: '2026-10-04T12:00:00.000Z',
                endTime: '2026-10-04T12:45:00.000Z', durationMinutes: 45, paid: false }],
        }), { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'reordered2xx') return new Response(JSON.stringify({
            shiftId: 'shift-a', userId: 'employee-a', employeeName: 'Ada',
            startTime: '2026-10-04T09:00:00.000Z', endTime: '2026-10-04T17:00:00.000Z',
            breaks: [
                { type: 'break2', startTime: '2026-10-04T15:00:00.000Z', endTime: '2026-10-04T15:10:00.000Z', durationMinutes: 10, paid: true },
                { type: 'lunch', startTime: '2026-10-04T12:00:00.000Z', endTime: '2026-10-04T12:45:00.000Z', durationMinutes: 45, paid: false },
                { type: 'break1', startTime: '2026-10-04T10:00:00.000Z', endTime: '2026-10-04T10:10:00.000Z', durationMinutes: 10, paid: true },
            ],
        }), { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'skipped2xx') return new Response(JSON.stringify({
            shiftId: 'shift-a', userId: null, employeeName: null,
            startTime: '2026-10-04T09:00:00.000Z', endTime: '2026-10-04T17:00:00.000Z', breaks: [],
        }), { headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'reject') return new Response(JSON.stringify({ message: 'Controlled row refusal' }),
            { status: 422, headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'forbidden') return new Response(JSON.stringify({ message: 'Controlled entitlement refusal',
            code: 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED', remediation: 'Review the paid-plan entitlement.' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } });
        if (outcome === 'conflict') return new Response(JSON.stringify({ message: 'Controlled conflict refusal',
            code: 'SHIFT_BREAKS_CONFLICT', remediation: 'Retry unchanged values or edit the draft.' }),
            { status: 409, headers: { 'Content-Type': 'application/json' } });
        const durationMinutes = outcome === 'ack50' ? 50 : 45;
        return new Response(JSON.stringify({ ...wire(scope), breaks: [{ ...wire(scope).breaks[0],
            endTime: scope.dateValue + (outcome === 'ack50' ? 'T12:50:00.000Z' : 'T12:45:00.000Z'), durationMinutes }] }),
            { headers: { 'Content-Type': 'application/json' } });
    }));
    function render() {
        stateIndex = refIndex = callbackIndex = memoIndex = 0;
        const result = selected.render();
        // Model the JSX ref's commit/unmount, without replacing its handler.
        saveFocusNode.isConnected = Boolean(result.rowSave);
        refs.get('shiftBreakSaveButtonRef')!.current = result.rowSave ? saveFocusNode : null;
        expect([stateIndex, refIndex, callbackIndex, memoIndex]).toEqual([stateNames.length, refNames.length, callbackNames.length, memoNames.length]);
        if (queuedEffect) {
            const next = queuedEffect; queuedEffect = undefined; effectCleanup?.();
            const cleanup = next(); effectCleanup = typeof cleanup === 'function' ? cleanup : undefined;
        }
        return result;
    }
    render();
    state.set('permissions', ['lunch_breaks:read', 'lunch_breaks:write', 'locations:read']);
    state.set('features', { features: { lunch_breaks: { enabled: true }, scheduling: { enabled: true } } });
    state.set('locations', [{ id: 'location-a', name: 'A', timezone: 'UTC' }, { id: 'location-b', name: 'B', timezone: 'UTC' }]);
    state.set('selectedDate', scopeA.dateValue); state.set('selectedLocationId', scopeA.locationId);
    state.set('sessionIdentity', { tenantId: 'workspace-scope', userId: 'public-user', sessionId: 'session-scope' });
    state.set('plannerMode', 'auto'); state.set('autoGuideStep', 5); state.set('isLoading', false);
    refs.get('desiredDayScopeRef')!.current = scopeA;
    // Populate from actual loader+independent nonempty GET, never fabricated editable rows.
    await render().loadDayRows(scopeA, requested, 'UTC'); render().select('shift-a'); render();
    expect(state.get('dayRows')).toHaveLength(options.extraRow ? 2 : 1); expect(render().selectedRow.lunch.durationMinutes).toBe(30);
    calls.length = 0; loads.length = 0;
    let pending: Promise<void> | undefined;
    function duration() {
        const nodes = elements(render().inputs).filter(node => node.type === 'input' && node.props['aria-label'] === `Meal duration for ${render().selectedRow.employeeName}`);
        expect(nodes).toHaveLength(1); return nodes[0];
    }
    function edit45() {
        const input = duration(); expect(input.props.disabled, 'Only supported enabled event is dispatched').toBe(false);
        input.props.onChange({ target: { value: '45' } }); render();
        expect(render().selectedRow.lunch.durationMinutes).toBe(45); expect(render().selectedRow.dirty).toBe(true);
    }
    function editValue(value: string, expectedMinutes: number) {
        const input = duration(); expect(input.props.disabled, 'Only supported enabled event is dispatched').toBe(false);
        input.props.onChange({ target: { value } }); render();
        expect(render().selectedRow.lunch.durationMinutes).toBe(expectedMinutes); expect(render().selectedRow.dirty).toBe(true);
    }
    const edit50 = () => editValue('50', 50);
    const editInvalid = () => editValue('500', 500);
    const repeat45 = () => editValue('45', 45);
    async function manualSave() {
        const button = render().rowSave; expect(button?.props.disabled).toBe(false);
        saveFocusNode.focus(); // The supported manual click starts on this control.
        button!.props.onClick(); render(); await finishAutosaves();
    }
    function rowKeys() { return rowMetadata.map(row => row.key); }
    function readRecovery(scope = scopeA) {
        return readShiftBreakUpdateRecovery(localStorage, {
            shiftId: scope.locationId === 'location-a' ? 'shift-a' : 'shift-b',
            dateValue: scope.dateValue, locationId: scope.locationId,
            tenantId: 'workspace-scope', userId: 'public-user', sessionId: 'session-scope',
        });
    }
    function changeCheckbox(index: number, checked: boolean) {
        const inputs = elements(render().inputs).filter(node => node.type === 'input' && node.props.type === 'checkbox');
        expect(inputs).toHaveLength(3); expect(inputs[index].props.disabled).toBe(false);
        inputs[index].props.onChange({ target: { checked } }); render();
    }
    function changeTime(label: string, value: string) {
        const inputs = elements(render().inputs).filter(node => node.type === 'input' && node.props['aria-label'] === label);
        expect(inputs).toHaveLength(1); expect(inputs[0].props.disabled).toBe(false);
        inputs[0].props.onChange({ target: { value } }); render();
    }
    function editAllThree() {
        changeCheckbox(0, false); changeTime('Break 1 time for Ada', '10:00');
        changeCheckbox(2, false); changeTime('Break 2 time for Ada', '15:00'); edit45();
    }
    function skipLunch() { changeCheckbox(1, true); }
    async function beginPolicy() {
        const button = render().policySave; expect(button?.type).toBe(Button); expect(button?.props.disabled).toBe(false);
        pending = button!.props.onClick();
        expect(await Promise.race([entered.promise.then(() => 'entered'), pending!.then(() => 'settled')])).toBe('entered');
        render(); expect(state.get('isSavingPolicy')).toBe(true);
    }
    async function finishPolicy() { release.resolve(); readbackRelease.resolve(); await pending; render(); }
    async function acknowledgeToPendingReadback() { release.resolve(); await readbackEntered.promise; render(); }
    async function completeReadback() { readbackRelease.resolve(); await pending; render(); }
    async function waitForRow() { await rowEntered.promise; render(); }
    async function completeRow() { rowRelease.resolve(); await finishAutosaves(); }
    async function finishAutosaves() { await Promise.all(saves); render(); }
    async function switchScope() {
        render().selectDayScope(scopeB.dateValue, scopeB.locationId); await Promise.all(loads); render();
        expect(refs.get('desiredDayScopeRef')!.current).toEqual(scopeB);
        expect(state.get('loadedDayScope')).toEqual(scopeB); expect(state.get('dayRows')[0].shiftId).toBe('shift-b');
    }
    function assertLedger(expected: Array<{ path: string; method: string; body?: unknown }>) {
        expect(unexpected, 'Owner catches cannot hide unexpected transport').toEqual([]); expect(calls).toEqual(expected);
        expect(rowMetadata).toHaveLength(expected.filter(call => call.path.startsWith('/api/v2/lunch-breaks/shift/')).length);
        for (const row of rowMetadata) {
            expect(row.key).toMatch(/^[\x20-\x7e]+$/); expect(row.credentials).toBe('include');
            expect(row.redirect).toBe('error'); expect(row.signal).toBeInstanceOf(AbortSignal);
        }
    }
    function assertObservedRowAttempts(expected: { path: string; method: string; body: unknown }, expectedKey?: string | null) {
        // Validate EVERY reached handoff independently of the expected count,
        // before a primary no-repeat assertion can stop the test.
        expect(unexpected, 'Owner catches cannot hide unexpected transport').toEqual([]);
        const rows = calls.filter(call => call.path.startsWith('/api/v2/lunch-breaks/shift/'));
        expect(rowMetadata).toHaveLength(rows.length);
        for (const row of rows) expect(row).toEqual(expected);
        for (const metadata of rowMetadata) {
            expect(metadata.key).toMatch(/^[\x20-\x7e]+$/);
            expect(metadata.credentials).toBe('include'); expect(metadata.redirect).toBe('error');
            expect(metadata.signal).toBeInstanceOf(AbortSignal);
        }
        // Key identity is a separate optional oracle AFTER all reached wire
        // metadata has been validated, so key rotation cannot hide it.
        if (expectedKey !== undefined) for (const metadata of rowMetadata) expect(metadata.key).toBe(expectedKey);
    }
    const policyCall = { path: '/lunch-breaks/policy', method: 'PUT', body: requested };
    const dayCall = (scope = scopeA) => ({ path: dayPath(scope), method: 'GET' });
    const rowCall = (scope = scopeA, durationMinutes = 45) => ({ path: '/api/v2/lunch-breaks/shift/' + (scope.locationId === 'location-a' ? 'shift-a' : 'shift-b'), method: 'PUT', body: {
        locationId: scope.locationId, breaks: [{ type: 'break1', skip: true },
            { type: 'lunch', startTime: scope.dateValue + 'T12:00:00.000Z', durationMinutes, skip: false }, { type: 'break2', skip: true }],
    } });
    const allThreeCall = { path: '/api/v2/lunch-breaks/shift/shift-a', method: 'PUT', body: {
        locationId: 'location-a', breaks: [
            { type: 'break1', startTime: '2026-10-04T10:00:00.000Z', durationMinutes: 10, skip: false },
            { type: 'lunch', startTime: '2026-10-04T12:00:00.000Z', durationMinutes: 45, skip: false },
            { type: 'break2', startTime: '2026-10-04T15:00:00.000Z', durationMinutes: 10, skip: false },
        ],
    } };
    const skippedCall = { path: '/api/v2/lunch-breaks/shift/shift-a', method: 'PUT', body: {
        locationId: 'location-a', breaks: [{ type: 'break1', skip: true }, { type: 'lunch', skip: true }, { type: 'break2', skip: true }],
    } };
    function rowAvailability(disabled: boolean) {
        const row = render(); expect(row.selectedRow).not.toBeNull();
        const fields = elements(row.inputs).filter(node => node.type === 'input'); expect(fields).toHaveLength(9);
        for (const input of fields) {
            if (input.props.type === 'checkbox' || !row.selectedRow.break1.skipped && input.props['aria-label']?.startsWith('Break 1')
                || input.props['aria-label']?.startsWith('Meal')) expect(input.props.disabled).toBe(disabled);
            else expect(input.props.disabled).toBe(true); // Already-skipped breaks have no enabled time/duration event.
        }
    }
    function policyAvailability(disabled: boolean) { expect(render().policySave?.props.disabled).toBe(disabled); }
    function reset() {
        const button = render().rowReset; expect(button?.props.disabled).toBe(false);
        button!.props.onClick(); render();
    }
    function select(id: string) { render().select(id); render(); }
    function resumeLoadedAutoReview() {
        // Current loaded B mode/step is a composition standin for completing
        // its existing guide, not proof of that guide's rendered interactions.
        state.set('plannerMode', 'auto'); state.set('autoGuideStep', 5); render().select('shift-b'); render();
    }
    async function guardedRowOwners() {
        const row = render();
        // Direct owner-admission checks, not invocation of disabled JSX events.
        const beforeUpdate = structuredClone(state.get('dayRows'));
        row.updateBreak('shift-a', 'lunch', { durationMinutes: 45 }); render();
        expect(state.get('dayRows')).toEqual(beforeUpdate);
        const beforeReset = structuredClone(state.get('dayRows'));
        row.resetRow('shift-a'); render();
        expect(state.get('dayRows')).toEqual(beforeReset);
        // This clean Reset is a no-op control, not independent proof of its
        // admission guard; clean save-all likewise has no dirty-row handoff.
        const beforeSave = structuredClone(state.get('dayRows'));
        expect(await row.saveRow('shift-a')).toBe(false); render();
        expect(state.get('dayRows')).toEqual(beforeSave);
        const beforeSaveAll = structuredClone(state.get('dayRows'));
        await row.saveAllDirtyRows(); render();
        expect(state.get('dayRows')).toEqual(beforeSaveAll);
    }
    async function guardedPolicyOwner() {
        // Explicit direct callback-admission check; never click the disabled button.
        await render().handleSavePolicy(); render();
        expect(state.get('error')).toBe('Save or reset your shift edits before saving planning settings.');
    }
    function timerLedger() { return { scheduleCount, cleanupCount, firedCount }; }
    async function cleanup() { release.resolve(); readbackRelease.resolve(); rowRelease.resolve();
        await pending?.catch(() => undefined); effectCleanup?.(); await Promise.allSettled(saves); }
    return { render, state, duration, edit45, beginPolicy, finishPolicy, finishAutosaves, switchScope,
        assertLedger, policyCall, dayCall, rowCall, timerLedger, cleanup, scopeA, scopeB, rowAvailability, policyAvailability,
        acknowledgeToPendingReadback, completeReadback, waitForRow, completeRow, reset, select,
        resumeLoadedAutoReview, guardedRowOwners, guardedPolicyOwner, edit50, editInvalid, repeat45, manualSave, rowKeys, assertObservedRowAttempts, saveInvocationCount: () => saves.length, editAllThree, skipLunch, allThreeCall, skippedCall, readRecovery };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); });

// The immutable baseline preserves the enabled-edit45 loss oracle. Candidate
// tests prove prevention instead; they never dispatch a disabled JSX event.
describe('actual populated Lunch Break row and policy reciprocal availability', () => {
    it('prevents row edits and owner handoffs during policy saving and restores them after complete acknowledged readback', async () => {
        const f = await fixture('ack');
        try {
            f.rowAvailability(false); await f.beginPolicy(); f.rowAvailability(true); f.policyAvailability(true);
            expect(f.render().rowSave?.props.disabled).toBe(true); expect(f.render().rowReset?.props.disabled).toBe(true);
            expect(f.render().saveAll.props.disabled).toBe(true); await f.guardedRowOwners();
            await vi.advanceTimersByTimeAsync(649); f.assertLedger([f.policyCall]);
            await f.finishPolicy(); await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves();
            f.assertLedger([f.policyCall, f.dayCall()]); f.policyAvailability(false);
            expect(f.state.get('dayRows')[0].lunch.durationMinutes).toBe(30); expect(f.state.get('dayRows')[0].dirty).toBe(false);
            expect(f.timerLedger()).toEqual({ scheduleCount: 0, cleanupCount: 0, firedCount: 0 });
            f.select('shift-a'); f.rowAvailability(false); f.edit45();
            expect(f.render().selectedRow.dirty).toBe(true);
            expect(f.timerLedger()).toEqual({ scheduleCount: 1, cleanupCount: 0, firedCount: 0 });
            await vi.advanceTimersByTimeAsync(649); f.assertLedger([f.policyCall, f.dayCall()]);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(45);
            await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves();
            f.assertLedger([f.policyCall, f.dayCall(), f.rowCall()]);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(45);
            expect(f.render().selectedRow.dirty).toBe(false);
            expect(f.timerLedger().firedCount).toBe(1);
        } finally { await f.cleanup(); }
    });
    it('holds policy availability through the independently deferred populated day GET after acknowledgment', async () => {
        const f = await fixture('ack', { deferReadback: true });
        try {
            await f.beginPolicy(); f.rowAvailability(true); await f.acknowledgeToPendingReadback();
            expect(f.state.get('isSavingPolicy')).toBe(true); expect(f.state.get('isDayLoading')).toBe(true);
            f.policyAvailability(true); expect(f.state.get('dayRows')).toEqual([]); f.assertLedger([f.policyCall, f.dayCall()]);
            await vi.advanceTimersByTimeAsync(650); await f.completeReadback(); await f.finishAutosaves();
            f.policyAvailability(false); f.select('shift-a'); f.rowAvailability(false);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(30); f.assertLedger([f.policyCall, f.dayCall()]);
        } finally { await f.cleanup(); }
    });
    it('keeps the unchanged populated row and completes one acknowledged scoped policy readback', async () => {
        const f = await fixture('ack');
        try {
            await f.beginPolicy(); await f.finishPolicy(); await vi.advanceTimersByTimeAsync(650); await f.finishAutosaves();
            f.assertLedger([f.policyCall, f.dayCall()]); expect(f.state.get('dayRows')).toHaveLength(1);
            expect(f.state.get('dayRows')[0].lunch.durationMinutes).toBe(30); expect(f.state.get('dayRows')[0].dirty).toBe(false);
            expect(f.timerLedger()).toEqual({ scheduleCount: 0, cleanupCount: 0, firedCount: 0 });
            expect(f.state.get('error')).toBeNull();
        } finally { await f.cleanup(); }
    });
    it('restores actual row editing after policy rejection without a day GET and preserves ordinary650ms autosave', async () => {
        const f = await fixture('reject');
        try {
            await f.beginPolicy(); f.rowAvailability(true); await vi.advanceTimersByTimeAsync(649); await f.finishPolicy();
            f.assertLedger([f.policyCall]); expect(f.state.get('error')).toBe('Failed to save lunch/break policy.');
            f.rowAvailability(false); f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.finishAutosaves();
            f.assertLedger([f.policyCall, f.rowCall()]); expect(f.render().selectedRow.lunch.durationMinutes).toBe(45);
            expect(f.render().selectedRow.dirty).toBe(false); expect(f.timerLedger().firedCount).toBe(1);
        } finally { await f.cleanup(); }
    });
    it('uses the actual ordinary650ms row autosave with scoped immutable body and a nonempty saved response', async () => {
        const f = await fixture('ack');
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(649); f.assertLedger([]);
            await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves(); f.assertLedger([f.rowCall()]);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(45); expect(f.render().selectedRow.dirty).toBe(false);
            expect(f.state.get('baselines')['shift-a'].lunch.durationMinutes).toBe(45); expect(f.timerLedger().firedCount).toBe(1);
        } finally { await f.cleanup(); }
    });
    it('blocks policy saving for an existing dirty row and restores admission after the actual enabled Reset', async () => {
        const f = await fixture('ack');
        try {
            f.edit45(); f.policyAvailability(true); await f.guardedPolicyOwner(); f.assertLedger([]);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(45); expect(f.render().selectedRow.dirty).toBe(true);
            f.reset(); f.policyAvailability(false); expect(f.render().selectedRow.lunch.durationMinutes).toBe(30);
            await vi.advanceTimersByTimeAsync(650); await f.finishAutosaves(); f.assertLedger([]);
            expect(f.timerLedger()).toEqual({ scheduleCount: 1, cleanupCount: 1, firedCount: 0 });
        } finally { await f.cleanup(); }
    });
    it('blocks policy saving for an unselected dirty row while the selected row is clean', async () => {
        const f = await fixture('ack', { extraRow: true });
        try {
            f.select('shift-extra'); f.edit45(); f.select('shift-a');
            expect(f.render().selectedRow.dirty).toBe(false); f.policyAvailability(true); await f.guardedPolicyOwner();
            expect(f.state.get('dayRows').find((row: any) => row.shiftId === 'shift-extra').lunch.durationMinutes).toBe(45);
            await vi.advanceTimersByTimeAsync(650); await f.finishAutosaves(); f.assertLedger([]);
            f.select('shift-extra'); f.reset(); f.policyAvailability(false); f.assertLedger([]);
        } finally { await f.cleanup(); }
    });
    it('blocks policy while the actual row autosave response is pending and restores admission on its saved completion', async () => {
        const f = await fixture('ack', { deferRow: true });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
            expect(f.render().selectedRow.saving).toBe(true); f.policyAvailability(true); f.rowAvailability(true);
            await f.guardedPolicyOwner(); f.assertLedger([f.rowCall()]);
            await f.completeRow(); f.policyAvailability(false); f.rowAvailability(false);
            expect(f.render().selectedRow.dirty).toBe(false); expect(f.render().selectedRow.lunch.durationMinutes).toBe(45);
            f.assertLedger([f.rowCall()]);
        } finally { await f.cleanup(); }
    });
    it('retains a rejected row draft and keeps policy blocked until the actual enabled Reset restores its baseline', async () => {
        const f = await fixture('ack', { deferRow: true, rejectRow: true });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow(); f.policyAvailability(true);
            await f.completeRow(); expect(f.render().selectedRow.saving).toBe(false);
            expect(f.render().selectedRow.dirty).toBe(true); expect(f.render().selectedRow.lunch.durationMinutes).toBe(45);
            expect(f.state.get('error')).toBe('Controlled row refusal'); f.policyAvailability(true);
            f.reset(); f.policyAvailability(false); expect(f.render().selectedRow.lunch.durationMinutes).toBe(30);
            f.assertLedger([f.rowCall()]);
        } finally { await f.cleanup(); }
    });
    it('refuses old policy acknowledgment without clearing the newer scoped row draft or its actual autosave', async () => {
        const f = await fixture('ack');
        try {
            await f.beginPolicy(); await f.switchScope(); f.resumeLoadedAutoReview(); f.rowAvailability(false); f.edit45();
            await vi.advanceTimersByTimeAsync(649); const before = structuredClone(f.state.get('dayRows'));
            await f.finishPolicy(); expect(f.state.get('dayRows')).toEqual(before); expect(f.render().selectedRow.dirty).toBe(true);
            expect(f.state.get('loadedDayScope')).toEqual(f.scopeB); f.assertLedger([f.policyCall, f.dayCall(f.scopeB)]);
            await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves();
            f.assertLedger([f.policyCall, f.dayCall(f.scopeB), f.rowCall(f.scopeB)]);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(45); expect(f.render().selectedRow.dirty).toBe(false);
            expect(f.timerLedger().firedCount).toBe(1);
        } finally { await f.cleanup(); }
    });
});

// Original-source baseline: no provider/DB acceptance is modeled. A controlled
// uncertain fetch can represent a lost acknowledgment, but does not establish
// whether a real owner committed. Explicit retries exercise real recovery keys.
async function noAutomaticResend(outcome: RowOutcome, expectedError: string) {
    const f = await fixture('ack', { deferRow: true, rowOutcome: outcome });
    try {
        f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
        expect(f.render().selectedRow.saving).toBe(true); f.rowAvailability(true);
        f.assertLedger([f.rowCall()]);
        expect(f.timerLedger().firedCount).toBe(1);
        // An actual in-flight commit followed by neutral render checkpoints
        // must not schedule another save while the first transport is held.
        f.render(); f.render(); await vi.advanceTimersByTimeAsync(650);
        f.assertLedger([f.rowCall()]); expect(f.saveInvocationCount()).toBe(1);
        expect(f.render().selectedRow.saving).toBe(true);
        await f.completeRow();
        expect(f.render().selectedRow.saving).toBe(false);
        expect(f.render().selectedRow.dirty).toBe(true);
        expect(f.render().selectedRow.lunch.durationMinutes).toBe(45);
        expect(f.state.get('error')).toBe(expectedError); f.rowAvailability(false);
        f.assertLedger([f.rowCall()]);
        const originalKey = f.rowKeys()[0]; expect(originalKey).toMatch(/^[\x20-\x7e]+$/);
        await vi.advanceTimersByTimeAsync(649); await f.finishAutosaves(); f.assertLedger([f.rowCall()]);
        await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves();
        // Full second timer/transport/catch/effect drain occurs BEFORE refusal
        // assertion; an owner catch cannot hide the new automatic handoff.
        f.assertObservedRowAttempts(f.rowCall(), originalKey);
        f.assertLedger([f.rowCall()]);
        expect(f.rowKeys()).toEqual([originalKey]);
        expect(f.render().selectedRow.dirty).toBe(true);
    } finally { await f.cleanup(); }
}
describe('actual Lunch Break autosave failure and explicit recovery baseline', () => {
    it('does not automatically resend a permanently rejected422 row without new user action', async () => {
        await noAutomaticResend('reject', 'Controlled row refusal');
    });
    it('does not automatically resend a stable403 entitlement refusal without new user action', async () => {
        await noAutomaticResend('forbidden', 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED: Controlled entitlement refusal Review the paid-plan entitlement.');
    });
    it('does not automatically resend a stable409 conflict refusal without new user action', async () => {
        await noAutomaticResend('conflict', 'SHIFT_BREAKS_CONFLICT: Controlled conflict refusal Retry unchanged values or edit the draft.');
    });
    it('does not automatically resend an uncertain transport result without new user action', async () => {
        await noAutomaticResend('uncertain', 'Controlled transport uncertainty');
    });
    it('recovers an uncertain original attempt through actual enabled Save with the same exact key and body', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcomes: ['uncertain', 'ack45'] });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
            expect(f.render().selectedRow.saving).toBe(true); f.assertLedger([f.rowCall()]);
            await f.completeRow(); expect(f.state.get('error')).toBe('Controlled transport uncertainty');
            const originalKey = f.rowKeys()[0]; f.assertLedger([f.rowCall()]);
            await f.manualSave(); f.assertLedger([f.rowCall(), f.rowCall()]);
            expect(f.rowKeys()).toEqual([originalKey, originalKey]);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(45);
            expect(f.render().selectedRow.dirty).toBe(false); expect(f.state.get('error')).toBeNull();
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves();
            f.assertLedger([f.rowCall(), f.rowCall()]);
        } finally { await f.cleanup(); }
    });
    it('admits an actual changed enabled edit as a new autosave intent with a different key and independently returned50 row', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcomes: ['reject', 'ack50'] });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow(); await f.completeRow();
            expect(f.state.get('error')).toBe('Controlled row refusal'); f.assertLedger([f.rowCall()]);
            const originalKey = f.rowKeys()[0]; f.edit50();
            await vi.advanceTimersByTimeAsync(649); await f.finishAutosaves(); f.assertLedger([f.rowCall()]);
            await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves();
            f.assertLedger([f.rowCall(), f.rowCall(f.scopeA, 50)]);
            expect(f.rowKeys()[1]).not.toBe(originalKey);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(50); expect(f.render().selectedRow.dirty).toBe(false);
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves();
            f.assertLedger([f.rowCall(), f.rowCall(f.scopeA, 50)]);
        } finally { await f.cleanup(); }
    });
    it('cancels the rejected draft autosave through actual enabled Reset and restores the unchanged baseline without another PUT', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcome: 'reject' });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow(); await f.completeRow();
            expect(f.render().selectedRow.dirty).toBe(true); f.assertLedger([f.rowCall()]);
            f.reset(); expect(f.render().selectedRow.lunch.durationMinutes).toBe(30);
            expect(f.render().selectedRow.dirty).toBe(false); f.policyAvailability(false);
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves(); f.assertLedger([f.rowCall()]);
            expect(f.timerLedger().firedCount).toBe(1);
        } finally { await f.cleanup(); }
    });
});

describe('actual Lunch Break failed draft no-intent and scope baseline', () => {
    it('does not restart a failed draft automatically for a same-value enabled duration event', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcome: 'reject' });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow(); await f.completeRow();
            f.assertLedger([f.rowCall()]); const originalKey = f.rowKeys()[0];
            f.repeat45(); expect(f.render().selectedRow.dirty).toBe(true);
            await vi.advanceTimersByTimeAsync(649); await f.finishAutosaves(); f.assertLedger([f.rowCall()]);
            await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves();
            f.assertObservedRowAttempts(f.rowCall(), originalKey);
            f.assertLedger([f.rowCall()]);
        } finally { await f.cleanup(); }
    });
    it('does not automatically repeat local timing validation after its first actual no-wire autosave failure', async () => {
        const f = await fixture('ack');
        try {
            f.editInvalid(); await vi.advanceTimersByTimeAsync(650); await f.finishAutosaves();
            expect(f.saveInvocationCount()).toBe(1); f.assertLedger([]);
            expect(f.state.get('error')).toBe('Ada: A planned break ends outside the shift.');
            expect(f.render().selectedRow.dirty).toBe(true); expect(f.render().selectedRow.saving).toBe(false);
            await vi.advanceTimersByTimeAsync(649); await f.finishAutosaves(); expect(f.saveInvocationCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves(); f.assertLedger([]);
            expect(f.state.get('error')).toBe('Ada: A planned break ends outside the shift.');
            expect(f.saveInvocationCount()).toBe(1);
        } finally { await f.cleanup(); }
    });
    it('refuses a stale A failure without clearing or retrying the new B draft and allows its independent50 autosave', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcomes: ['uncertain', 'ack50'] });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
            expect(f.render().selectedRow.saving).toBe(true); f.assertLedger([f.rowCall()]);
            await f.switchScope(); f.resumeLoadedAutoReview(); f.edit50();
            await vi.advanceTimersByTimeAsync(649); const before = structuredClone(f.state.get('dayRows'));
            await f.completeRow(); expect(f.state.get('dayRows')).toEqual(before);
            expect(f.state.get('error')).toBeNull(); expect(f.state.get('loadedDayScope')).toEqual(f.scopeB);
            f.assertLedger([f.rowCall(), f.dayCall(f.scopeB)]);
            await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves();
            f.assertLedger([f.rowCall(), f.dayCall(f.scopeB), f.rowCall(f.scopeB, 50)]);
            expect(f.rowKeys()[1]).not.toBe(f.rowKeys()[0]);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(50); expect(f.render().selectedRow.dirty).toBe(false);
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves();
            f.assertLedger([f.rowCall(), f.dayCall(f.scopeB), f.rowCall(f.scopeB, 50)]);
        } finally { await f.cleanup(); }
    });
});

// Candidate-only visible-status and selection controls. The immutable original
// baseline20 remains separate; these nodes use the actual parent condition/JSX.
describe('actual Lunch Break paused autosave visible recovery and row selection', () => {
    it('exposes actual paused-status guidance after failure and clears it after actual enabled unchanged Save recovery', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcomes: ['reject', 'ack45'] });
        try {
            expect(f.render().pauseStatus).toBeNull(); expect(f.render().selectedRow.autosavePaused).toBe(false);
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
            expect(f.render().selectedRow.saving).toBe(true); expect(f.render().pauseStatus).toBeNull();
            await f.completeRow(); f.assertLedger([f.rowCall()]);
            expect(f.render().selectedRow.autosavePaused).toBe(true);
            const status = f.render().pauseStatus; expect(status?.props.role).toBe('status');
            expect(visibleText(status)).toContain('Autosave paused.');
            expect(visibleText(status)).toContain('Save shift to retry these values');
            expect(visibleText(status)).toContain('edit to start a new attempt');
            expect(visibleText(status)).toContain('Reset to discard the draft');
            const originalKey = f.rowKeys()[0]; await f.manualSave();
            f.assertLedger([f.rowCall(), f.rowCall()]); expect(f.rowKeys()).toEqual([originalKey, originalKey]);
            expect(f.render().selectedRow.dirty).toBe(false); expect(f.render().selectedRow.autosavePaused).toBe(false);
            expect(f.render().pauseStatus).toBeNull();
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves();
            f.assertLedger([f.rowCall(), f.rowCall()]);
        } finally { await f.cleanup(); }
    });
    it('keeps a failed row paused across actual row re-selection while another clean row stays independently unpaused', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcome: 'reject', extraRow: true });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow(); await f.completeRow();
            f.assertLedger([f.rowCall()]); const originalKey = f.rowKeys()[0];
            expect(f.render().selectedRow.autosavePaused).toBe(true);
            f.select('shift-extra'); expect(f.render().selectedRow.dirty).toBe(false);
            expect(f.render().selectedRow.autosavePaused).toBe(false); expect(f.render().pauseStatus).toBeNull();
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves(); f.assertLedger([f.rowCall()]);
            f.select('shift-a'); expect(f.render().selectedRow.dirty).toBe(true);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(45);
            expect(f.render().selectedRow.autosavePaused).toBe(true);
            expect(f.render().pauseStatus?.props.role).toBe('status');
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves();
            f.assertObservedRowAttempts(f.rowCall(), originalKey); f.assertLedger([f.rowCall()]);
            expect(f.rowKeys()).toEqual([originalKey]); expect(f.timerLedger().firedCount).toBe(1);
        } finally { await f.cleanup(); }
    });
});

// Original response-custody baseline. Synthetic target aliases are inherited
// from this source harness; this does not execute native UUID/schema validation.
// A2xx can have committed server effects even when its acknowledgment is unusable.
async function malformedAcknowledgmentRetry(outcome: RowOutcome) {
    const f = await fixture('ack', { deferRow: true, rowOutcomes: [outcome, 'ack45'] });
    try {
        f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
        expect(f.render().selectedRow.saving).toBe(true); f.assertLedger([f.rowCall()]);
        const originalKey = f.rowKeys()[0]; await f.completeRow();
        f.assertObservedRowAttempts(f.rowCall()); f.assertLedger([f.rowCall()]);
        expect(f.render().selectedRow.shiftId).toBe('shift-a');
        expect(f.render().selectedRow.lunch.durationMinutes).toBe(45);
        expect(f.render().selectedRow.dirty).toBe(true); expect(f.render().selectedRow.autosavePaused).toBe(true);
        expect(typeof f.state.get('error')).toBe('string'); expect(f.state.get('error').trim().length).toBeGreaterThan(0);
        await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves(); f.assertLedger([f.rowCall()]);
        await f.manualSave();
        // Validate both full wire attempts and the completed canonical recovery
        // BEFORE the primary retained-key assertion. No owner catch hides errors.
        f.assertObservedRowAttempts(f.rowCall()); f.assertLedger([f.rowCall(), f.rowCall()]);
        expect(f.state.get('error')).toBeNull(); expect(f.render().selectedRow.shiftId).toBe('shift-a');
        expect(f.render().selectedRow.lunch.durationMinutes).toBe(45); expect(f.render().selectedRow.dirty).toBe(false);
        expect(f.rowKeys()).toEqual([originalKey, originalKey]);
    } finally { await f.cleanup(); }
}
describe('actual Lunch Break2xx acknowledgment custody original baseline', () => {
    it('retains the original request key for actual enabled unchanged Save after a null2xx acknowledgment', async () => {
        await malformedAcknowledgmentRetry('null2xx');
    });
    it('retains the original request key for actual enabled unchanged Save after a nonJSON2xx acknowledgment', async () => {
        await malformedAcknowledgmentRetry('nonjson2xx');
    });
    it('retains the original request key for actual enabled unchanged Save after a2xx row missing required fields', async () => {
        await malformedAcknowledgmentRetry('missingfields2xx');
    });
    it('preserves the selected target draft instead of installing and marking clean a foreign-shift2xx acknowledgment', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcome: 'foreignshift2xx' });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
            f.assertLedger([f.rowCall()]); const originalKey = f.rowKeys()[0]; await f.completeRow();
            f.assertObservedRowAttempts(f.rowCall(), originalKey); f.assertLedger([f.rowCall()]);
            expect(f.state.get('selectedShiftId')).toBe('shift-a');
            const error = f.state.get('error'); expect(error === null || typeof error === 'string').toBe(true);
            if (typeof error === 'string') expect(error.trim().length).toBeGreaterThan(0);
            const row = f.state.get('dayRows')[0], selected = f.render().selectedRow;
            // Primary target assertion precedes dependent selected-row checks;
            // original source replaces the row under the old selected ID.
            expect(row.shiftId).toBe('shift-a');
            expect(selected).not.toBeNull(); expect(selected.lunch.durationMinutes).toBe(45);
            expect(selected.dirty).toBe(true); expect(selected.autosavePaused).toBe(true);
            expect(typeof f.state.get('error')).toBe('string');
        } finally { await f.cleanup(); }
    });
    it('accepts a complete nonempty DTO with reordered typed breaks through actual enabled editor fields and canonical saved response', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcome: 'reordered2xx' });
        try {
            f.editAllThree(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
            f.assertLedger([f.allThreeCall]); await f.completeRow();
            f.assertObservedRowAttempts(f.allThreeCall); f.assertLedger([f.allThreeCall]);
            const row = f.render().selectedRow; expect(row.shiftId).toBe('shift-a');
            expect(row.break1).toEqual({ time: '10:00', durationMinutes: 10, skipped: false });
            expect(row.lunch).toEqual({ time: '12:00', durationMinutes: 45, skipped: false });
            expect(row.break2).toEqual({ time: '15:00', durationMinutes: 10, skipped: false });
            expect(row.dirty).toBe(false); expect(row.autosavePaused).toBe(false); expect(f.state.get('error')).toBeNull();
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves(); f.assertLedger([f.allThreeCall]);
        } finally { await f.cleanup(); }
    });
    it('accepts an independently returned all-skipped DTO with nullable user metadata after the actual enabled Skip meal event', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcome: 'skipped2xx' });
        try {
            f.skipLunch(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
            f.assertLedger([f.skippedCall]); await f.completeRow();
            f.assertObservedRowAttempts(f.skippedCall); f.assertLedger([f.skippedCall]);
            const row = f.render().selectedRow; expect(row.shiftId).toBe('shift-a'); expect(row.userId).toBeNull();
            expect(row.employeeName).toBe('Unassigned'); expect(row.break1.skipped).toBe(true);
            expect(row.lunch.skipped).toBe(true); expect(row.break2.skipped).toBe(true);
            expect(row.dirty).toBe(false); expect(row.autosavePaused).toBe(false); expect(f.state.get('error')).toBeNull();
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves(); f.assertLedger([f.skippedCall]);
        } finally { await f.cleanup(); }
    });
});

// Candidate-only response contract controls: shape/target custody, not native
// schema execution, strict request echo, historical receipt or commit proof.
describe('actual saved row verification candidate contract controls', () => {
    it('preserves same-target bad metadata uncertainty and its original key through actual unchanged Save recovery', async () => {
        await malformedAcknowledgmentRetry('badmetadata2xx');
    });
    it('preserves same-target malformed break shape uncertainty and its original key through actual unchanged Save recovery', async () => {
        await malformedAcknowledgmentRetry('badbreak2xx');
    });
    it('preserves same-target invalid instant uncertainty and its original key through actual unchanged Save recovery', async () => {
        await malformedAcknowledgmentRetry('invalidinstant2xx');
    });
    it('preserves same-target duplicate break-type uncertainty and its original key through actual unchanged Save recovery', async () => {
        await malformedAcknowledgmentRetry('duplicatetype2xx');
    });
    it('accepts offset overnight and historical metadata DTO compatibility with an independently returned duration without request echo', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcome: 'overnightoffset2xx' });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
            f.assertLedger([f.rowCall()]); await f.completeRow();
            f.assertObservedRowAttempts(f.rowCall()); f.assertLedger([f.rowCall()]);
            const row = f.render().selectedRow; expect(row.shiftId).toBe('shift-a');
            expect(row.userId).toBe('historical-user'); expect(row.employeeName).toBe('Historical employee');
            expect(row.startTime).toBe('2026-10-03T16:00:00-07:00'); expect(row.endTime).toBe('2026-10-04T10:00:00-07:00');
            expect(Date.parse(row.startTime)).toBe(Date.parse('2026-10-03T23:00:00.000Z'));
            expect(Date.parse(row.endTime)).toBe(Date.parse('2026-10-04T17:00:00.000Z'));
            expect(row.lunch).toEqual({ time: '12:00', durationMinutes: 50, skipped: false });
            expect(row.dirty).toBe(false); expect(row.autosavePaused).toBe(false); expect(f.state.get('error')).toBeNull();
            expect(f.readRecovery()).toBeNull();
            // This consumes an independent compatible DTO; it does not prove a
            // real owner transforms this fixture's45-minute request into50.
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves(); f.assertLedger([f.rowCall()]);
        } finally { await f.cleanup(); }
    });
    it('retains malformed A recovery custody without mutating the new B draft or its independent autosave', async () => {
        const f = await fixture('ack', { deferRow: true, rowOutcomes: ['null2xx', 'ack50'] });
        try {
            f.edit45(); await vi.advanceTimersByTimeAsync(650); await f.waitForRow();
            f.assertLedger([f.rowCall()]); const originalAKey = f.rowKeys()[0];
            await f.switchScope(); f.resumeLoadedAutoReview(); f.edit50();
            await vi.advanceTimersByTimeAsync(649); const before = structuredClone(f.state.get('dayRows'));
            await f.completeRow(); f.assertObservedRowAttempts(f.rowCall(), originalAKey);
            f.assertLedger([f.rowCall(), f.dayCall(f.scopeB)]);
            expect(f.state.get('dayRows')).toEqual(before); expect(f.state.get('error')).toBeNull();
            expect(f.state.get('loadedDayScope')).toEqual(f.scopeB);
            const retainedA = f.readRecovery(); expect(retainedA?.attempt.key).toBe(originalAKey);
            expect(retainedA?.requestBody).toEqual(f.rowCall().body);
            expect(retainedA?.identity).toEqual({ shiftId: 'shift-a', dateValue: '2026-10-04', locationId: 'location-a',
                tenantId: 'workspace-scope', userId: 'public-user', sessionId: 'session-scope' });
            await vi.advanceTimersByTimeAsync(1); await f.finishAutosaves();
            f.assertLedger([f.rowCall(), f.dayCall(f.scopeB), f.rowCall(f.scopeB, 50)]);
            expect(f.rowKeys()[1]).not.toBe(originalAKey);
            expect(f.render().selectedRow.lunch.durationMinutes).toBe(50); expect(f.render().selectedRow.dirty).toBe(false);
            expect(f.readRecovery(f.scopeB)).toBeNull();
            expect(f.readRecovery()?.attempt.key).toBe(originalAKey); expect(f.readRecovery()?.requestBody).toEqual(f.rowCall().body);
            await vi.advanceTimersByTimeAsync(1300); await f.finishAutosaves();
            f.assertLedger([f.rowCall(), f.dayCall(f.scopeB), f.rowCall(f.scopeB, 50)]);
        } finally { await f.cleanup(); }
    });
});
