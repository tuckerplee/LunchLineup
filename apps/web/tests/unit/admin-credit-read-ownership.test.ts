import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCreditReadOwner } from '../../app/admin/credits/credit-read-owner';
import { createCreditGrantSubmissionState, submitCreditGrant } from '../../app/admin/credits/credit-grant-submission';
import { parseCreditGrantAcknowledgement } from '../../app/admin/credits/credit-grant-acknowledgement';
import { withIdempotencyKey } from '../../lib/client-api';
import * as lists from '../../app/admin/admin-list-pagination';

describe('admin credit read owner', () => {
    it('admits appends only against a completed current base and its exact cursor', () => {
        const owner = createCreditReadOwner();
        expect(owner.beginReplacement('boreal')).toBeNull();
        owner.activate(); const base = owner.beginReplacement('  boreal  ')!;
        expect(base.query).toBe('boreal'); expect(owner.currentQuery()).toBe('boreal');
        expect(owner.beginAppend('tenants', 'T1')).toBeNull();
        owner.accept(base, { tenants: 'T1', history: 'H1' });
        expect(owner.beginAppend('tenants', 'T1')).toBeNull();
        owner.finish(base);
        expect(owner.beginAppend('tenants', 'obsolete')).toBeNull();
        const tenant = owner.beginAppend('tenants', 'T1')!;
        expect(tenant.query).toBe('boreal'); expect(owner.beginAppend('tenants', 'T1')).toBeNull();
        const history = owner.beginAppend('history', 'H1')!;
        expect(owner.owns(tenant)).toBe(true); expect(owner.owns(history)).toBe(true);
    });

    it('invalidates both read lanes synchronously when replacement intent changes', () => {
        const owner = createCreditReadOwner(); owner.activate();
        const base = owner.beginReplacement('')!; owner.accept(base, { tenants: 'T1', history: 'H1' }); owner.finish(base);
        const tenant = owner.beginAppend('tenants', 'T1')!, history = owner.beginAppend('history', 'H1')!;
        const replacement = owner.beginReplacement('aurora')!;
        for (const old of [base, tenant, history]) {
            expect(owner.owns(old)).toBe(false); expect(owner.canPublish(old)).toBe(false); expect(owner.finish(old)).toBe(false);
            expect(owner.accept(old, { tenants: 'old', history: 'old' })).toBe(false);
        }
        expect(owner.snapshot()).toEqual({ replacement: true, tenants: false, history: false, ready: false });
        expect(owner.owns(replacement)).toBe(true);
    });

    it('retains accepted same-epoch page publication when a later page starts', () => {
        const owner = createCreditReadOwner(); owner.activate();
        const base = owner.beginReplacement()!; owner.accept(base, { tenants: 'T1', history: null }); owner.finish(base);
        const first = owner.beginAppend('tenants', 'T1')!; owner.accept(first, { tenants: 'T2', history: null }); owner.finish(first);
        const second = owner.beginAppend('tenants', 'T2')!;
        expect(owner.owns(first)).toBe(false); expect(owner.canPublish(first)).toBe(true);
        expect(owner.owns(second)).toBe(true); expect(owner.canPublish(second)).toBe(false);
    });

    it('rejects old publication after unmount and a fresh effect lifetime', () => {
        const owner = createCreditReadOwner(); owner.activate(); const visit = owner.visit();
        const first = owner.beginReplacement('boreal')!; owner.accept(first, { tenants: 'T', history: 'H' });
        owner.deactivate(); expect(owner.isActiveVisit(visit)).toBe(false); expect(owner.canPublish(first)).toBe(false);
        owner.activate(); const next = owner.beginReplacement()!;
        expect(next.query).toBe('boreal'); expect(owner.owns(first)).toBe(false); expect(owner.finish(first)).toBe(false);
        expect(owner.snapshot().replacement).toBe(true);
    });
});

// Execute the actual full CreditsClient prefix, functions and JSX with finite
// hook state and controlled network promises. This is not a React/DOM mount.
// Real JSX callbacks and disabled expressions are used; no business handler is
// copied into the harness or replaced by a mock publication implementation.
type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const React = { createElement(type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element {
    return { type, props: props ?? {}, children };
} };
const file = resolve(process.cwd(), 'app/admin/credits/CreditsClient.tsx');
const source = readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const components = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'CreditsClient');
if (components.length !== 1 || !components[0].body) throw new Error('Expected one actual CreditsClient owner');
const component = components[0];
const declarations = component.body!.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]);
function hookNames(hook: string) {
    return declarations.filter(node => node.initializer && ts.isCallExpression(node.initializer)
        && node.initializer.expression.getText(ast) === hook).map(node => {
        if (!ts.isArrayBindingPattern(node.name)) return node.name.getText(ast);
        const first = node.name.elements[0];
        if (!first || !ts.isBindingElement(first)) throw new Error('Expected named state slot');
        return first.name.getText(ast);
    });
}
const stateNames = hookNames('useState'), refNames = hookNames('useRef');
const returns = component.body!.statements.filter(ts.isReturnStatement);
if (returns.length !== 1 || !returns[0].expression) throw new Error('Expected actual top-level JSX return');
const topLevel = ast.statements.filter(node => ts.isVariableStatement(node)
    || (ts.isFunctionDeclaration(node) && node !== component)).map(node => node.getText(ast)).join('\n');
const executable = ts.transpileModule(`${topLevel}\nfunction render() {
${source.slice(component.body!.getStart(ast) + 1, returns[0].getStart(ast))}
return { tree: (${returns[0].expression!.getText(ast)}) };
} return render;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
function elements(tree: unknown): Element[] {
    if (Array.isArray(tree)) return tree.flatMap(elements);
    if (!tree || typeof tree !== 'object' || !('type' in tree)) return [];
    const element = tree as Element; return [element, ...element.children.flatMap(elements)];
}
function text(tree: unknown): string {
    if (Array.isArray(tree)) return tree.map(text).join('');
    if (tree && typeof tree === 'object' && 'children' in tree) return text((tree as Element).children);
    return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
}
function one(tree: unknown, predicate: (element: Element) => boolean) {
    const matches = elements(tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0];
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
const A = { id: 'A', name: 'Aurora', slug: 'aurora', planTier: 'STARTER', usageCredits: 120 };
const B = { id: 'B', name: 'Boreal', slug: 'boreal', planTier: 'STARTER', usageCredits: 40 };
const C = { id: 'C', name: 'Cedar', slug: 'cedar', planTier: 'STARTER', usageCredits: 5 };
const H1 = { id: 'H1', amount: 1, reason: 'First history', createdAt: '2026-10-05T12:00:00Z', tenant: A };
const H2 = { ...H1, id: 'H2', reason: 'Second history', createdAt: '2026-10-04T12:00:00Z' };
const pageData = (tenants = [A, B], tenantCursor: string | null = 'T1', history = [H1], historyCursor: string | null = 'H1') => ({
    tenants, history, tenantPagination: { hasMore: tenantCursor !== null, nextCursor: tenantCursor },
    historyPagination: { hasMore: historyCursor !== null, nextCursor: historyCursor },
});
function fixture() {
    const state = new Map<string, any>(), refs = new Map<string, { current: any }>();
    const updates: Array<{ name: string; value: any }> = [], setterCalls: string[] = [];
    const reads: Array<{ path: string; response: ReturnType<typeof deferred<unknown>> }> = [];
    const writes: Array<{ path: string; init: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
    let stateIndex = 0, refIndex = 0, holding = false, cleanup: (() => void) | undefined;
    let effects: Array<() => void | (() => void)> = [], current: { tree: Element };
    const apply = (name: string, value: any) => state.set(name, typeof value === 'function' ? value(state.get(name)) : value);
    const bindings = {
        React, styles: {}, ...lists, createCreditReadOwner, createCreditGrantSubmissionState, submitCreditGrant,
        parseCreditGrantAcknowledgement, withIdempotencyKey, document: undefined, window: { confirm: vi.fn(() => true) },
        useState(initial: any) {
            const name = stateNames[stateIndex++]; if (!name) throw new Error('Unexpected state slot');
            if (!state.has(name)) state.set(name, typeof initial === 'function' ? initial() : initial);
            return [state.get(name), (value: any) => {
                setterCalls.push(name);
                if (holding && name !== 'query') updates.push({ name, value }); else apply(name, value);
            }];
        },
        useRef(initial: any) {
            const name = refNames[refIndex++]; if (!name) throw new Error('Unexpected ref slot');
            if (!refs.has(name)) refs.set(name, { current: initial }); return refs.get(name);
        },
        useMemo: (calculate: () => unknown) => calculate(), useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
        fetchJsonWithSession(path: string) { const response = deferred<unknown>(); reads.push({ path, response }); return response.promise; },
        fetchWithSession(path: string, init: RequestInit) { const response = deferred<Response>(); writes.push({ path, init, response }); return response.promise; },
    };
    const renderOwner = new Function(...Object.keys(bindings), executable)(...Object.values(bindings));
    function render() { stateIndex = 0; refIndex = 0; effects = []; current = renderOwner(); return current.tree; }
    function button(label: string) { return one(render(), node => node.type === 'button' && text(node.children) === label); }
    function submitForm(label: string) {
        const form = one(render(), node => node.type === 'form' && elements(node.children).some(child => child.type === 'button' && text(child.children) === label));
        const submit = one(form, node => node.type === 'button' && node.props.type === 'submit');
        expect(submit.props.disabled).not.toBe(true); return form.props.onSubmit({ preventDefault() {} });
    }
    async function flush() { for (let index = 0; index < 10; index += 1) await Promise.resolve(); render(); }
    render(); expect(effects).toHaveLength(1); cleanup = effects[0]() || undefined;
    return { state, refs, reads, writes, setterCalls, render, button, flush,
        click(label: string) { const node = button(label); expect(node.props.disabled).not.toBe(true); node.props.onClick(); },
        search(query: string) {
            one(render(), node => node.type === 'input' && node.props.placeholder === 'Search by tenant name or slug').props.onChange({ target: { value: query } });
            return submitForm('Search');
        },
        draft(id = 'B', amount = '25', reason = 'Retain this draft') {
            one(render(), node => node.type === 'select').props.onChange({ target: { value: id } });
            one(render(), node => node.type === 'input' && node.props.type === 'number').props.onChange({ target: { value: amount } });
            one(render(), node => node.type === 'input' && node.props.placeholder === 'Customer success grant').props.onChange({ target: { value: reason } });
        },
        grant: () => { submitForm('Grant Credits'); },
        async complete(index: number, response: unknown) { reads[index].response.resolve(response); await flush(); },
        async fail(index: number, message: string) { reads[index].response.reject(new Error(message)); await flush(); },
        hold() { holding = true; },
        drain() { holding = false; for (const update of updates.splice(0)) apply(update.name, update.value); render(); },
        unmount() { cleanup?.(); },
    };
}
afterEach(() => vi.unstubAllGlobals());

describe('actual CreditsClient read ownership wiring', () => {
    it('ignores an obsolete tenant append after an enabled newer search and keeps its draft/cursor', async () => {
        const f = fixture(); await f.complete(0, pageData()); f.draft();
        f.click('Load more tenant balances'); expect(f.reads[1].path).toContain('tenantCursor=T1');
        f.search('boreal'); expect(f.reads[2].path).toContain('q=boreal');
        await f.complete(2, pageData([B], 'TB'));
        await f.complete(1, pageData([C], 'T2'));
        expect(f.state.get('tenants')).toEqual([B]); expect(f.state.get('tenantPagination').nextCursor).toBe('TB');
        expect(f.state.get('form')).toEqual({ tenantId: 'B', amount: '25', reason: 'Retain this draft' });
        f.click('Load more tenant balances'); expect(f.reads[3].path).toContain('tenantCursor=TB'); expect(f.reads[3].path).toContain('q=boreal');
        await f.complete(3, pageData([], null));
    });

    it.each(['tenants', 'history'] as const)('publishes both valid append lanes with %s completing first', async first => {
        const f = fixture(); await f.complete(0, pageData()); f.draft();
        f.click('Load more tenant balances'); f.click('Load more ledger history');
        const tenantIndex = 1, historyIndex = 2;
        await f.complete(first === 'tenants' ? tenantIndex : historyIndex,
            first === 'tenants' ? pageData([C], 'T2') : pageData([A, B], 'T1', [H2], 'H2'));
        expect(f.state.get('readPending')[first === 'tenants' ? 'history' : 'tenants']).toBe(true);
        await f.complete(first === 'tenants' ? historyIndex : tenantIndex,
            first === 'tenants' ? pageData([A, B], 'T1', [H2], 'H2') : pageData([C], 'T2'));
        expect(f.state.get('tenants')).toEqual([A, B, C]); expect(f.state.get('history')).toEqual([H1, H2]);
        expect(f.state.get('tenantPagination').nextCursor).toBe('T2'); expect(f.state.get('historyPagination').nextCursor).toBe('H2');
        expect(f.state.get('readPending')).toEqual({ replacement: false, tenants: false, history: false, ready: true });
        expect(f.state.get('form')).toEqual({ tenantId: 'B', amount: '25', reason: 'Retain this draft' });
    });

    it('rechecks queued replacement data and selection updaters after a newer search intent', async () => {
        const f = fixture(); await f.complete(0, pageData()); f.draft();
        f.click('Refresh'); f.hold(); await f.complete(1, pageData([C], 'TC'));
        f.search('aurora'); f.drain();
        expect(f.state.get('tenants')).toEqual([A, B]); expect(f.state.get('form').tenantId).toBe('B');
        expect(f.state.get('readPending')).toEqual({ replacement: true, tenants: false, history: false, ready: false });
        expect(f.button('Load more tenant balances').props.disabled).toBe(true);
        expect(f.button('Load more ledger history').props.disabled).toBe(true);
        expect(f.button('Search').props.disabled).not.toBe(true);
        await f.complete(2, pageData([A], 'TA'));
        expect(f.state.get('tenants')).toEqual([A]); expect(f.state.get('tenantPagination').nextCursor).toBe('TA');
        expect(f.state.get('form')).toEqual({ tenantId: 'A', amount: '25', reason: 'Retain this draft' });
    });

    it.each(['pending', 'failed'] as const)('does not publish an old replacement error/finalizer over a newer %s read', async outcome => {
        const f = fixture(); await f.complete(0, pageData());
        f.click('Refresh'); f.search('boreal');
        if (outcome === 'failed') await f.fail(2, 'Current query failed');
        await f.fail(1, 'Obsolete refresh failed');
        expect(f.state.get('readErrors').replacement).toBe(outcome === 'failed' ? 'Current query failed' : null);
        expect(f.state.get('readPending').replacement).toBe(outcome === 'pending');
        if (outcome === 'pending') await f.complete(2, pageData([B], 'TB'));
    });

    it('rechecks an already-queued error updater after a newer search starts', async () => {
        const f = fixture(); await f.complete(0, pageData());
        f.click('Refresh'); f.hold(); await f.fail(1, 'Queued old failure');
        f.search('aurora'); f.drain();
        expect(f.state.get('readErrors').replacement).toBeNull(); expect(f.state.get('readPending').replacement).toBe(true);
        await f.complete(2, pageData([A], null)); expect(f.state.get('readErrors').replacement).toBeNull();
    });

    it('keeps a current lane error while the other independent lane succeeds', async () => {
        const f = fixture(); await f.complete(0, pageData());
        f.click('Load more tenant balances'); f.click('Load more ledger history');
        await f.fail(1, 'Tenant continuation refused'); await f.complete(2, pageData([A, B], 'T1', [H2], null));
        expect(f.state.get('readErrors').tenants).toBe('Tenant continuation refused');
        expect(f.state.get('readErrors').history).toBeNull(); expect(f.state.get('history')).toEqual([H1, H2]);
    });

    it('keeps grant ownership independent and reads current search after the earlier ACK', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'credit-read-owner-grant-key' });
        const f = fixture(); await f.complete(0, pageData()); f.draft();
        f.grant(); expect(f.writes).toHaveLength(1);
        expect(JSON.parse(String(f.writes[0].init.body))).toEqual({ tenantId: 'B', amount: 25, reason: 'Retain this draft' });
        expect(new Headers(f.writes[0].init.headers).get('idempotency-key')).toBe('credit-read-owner-grant-key');
        f.search('aurora'); await f.complete(1, pageData([A], null)); f.draft('A', '7', 'New Aurora draft');
        expect(f.state.get('grantSaving')).toBe(true); expect(f.refs.get('grantSubmission')!.current.inFlight).toBe(true);
        expect(f.button('Granting...').props.disabled).toBe(true);
        f.writes[0].response.resolve(new Response(JSON.stringify({ success: true, newBalance: 65 }), { status: 201 }));
        await vi.waitFor(() => expect(f.reads).toHaveLength(3)); expect(f.reads[2].path).toContain('q=aurora');
        await f.complete(2, pageData([A], null));
        await vi.waitFor(() => expect(f.state.get('grantSaving')).toBe(false));
        expect(f.state.get('form')).toEqual({ tenantId: 'A', amount: '7', reason: 'New Aurora draft' });
        expect(f.state.get('tenants')).toEqual([A]); expect(f.state.get('grantSaving')).toBe(false);
        expect(f.refs.get('grantSubmission')!.current).toEqual({ attempt: null, inFlight: false }); expect(f.writes).toHaveLength(1);
    });

    it('finishes an acknowledged mutation after unmount without restarting reads or publishing UI state', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'unmounted-credit-grant-key' });
        const f = fixture(); await f.complete(0, pageData()); f.draft(); f.grant();
        f.unmount(); const count = f.setterCalls.length;
        f.writes[0].response.resolve(new Response(JSON.stringify({ success: true, newBalance: 65 }), { status: 201 }));
        await vi.waitFor(() => expect(f.refs.get('grantSubmission')!.current.inFlight).toBe(false));
        await f.flush();
        expect(f.setterCalls).toHaveLength(count); expect(f.reads).toHaveLength(1); expect(f.state.get('notice')).toBeNull();
        expect(f.refs.get('grantSubmission')!.current.attempt).toBeNull();
    });

    it('does not queue data, error or busy updates after unmount', async () => {
        const f = fixture(); await f.complete(0, pageData());
        f.click('Load more tenant balances'); f.click('Load more ledger history');
        f.unmount(); const count = f.setterCalls.length;
        await f.complete(1, pageData([C], null)); await f.fail(2, 'Late unmounted failure');
        expect(f.setterCalls).toHaveLength(count); expect(f.state.get('tenants')).toEqual([A, B]); expect(f.state.get('history')).toEqual([H1]);
    });
});
