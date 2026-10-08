import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { buildAdminListPath, parseAdminListPagination, mergeAdminListPage } from '../../app/admin/admin-list-pagination';
import { tenantLifecycleOutcome, type TenantStatusAction } from '../../app/admin/tenants/tenant-lifecycle-outcome';

const target = 'tenant:opaque-B';
const responses = {
  suspend: { id: target, status: 'SUSPENDED' },
  activate: { id: target, status: 'ACTIVE' },
  archive: { id: target, archived: true },
  restore: { id: target, restored: true },
} as const;
const actions: TenantStatusAction[] = ['suspend', 'activate', 'archive', 'restore'];

for (const action of actions) {
  describe(`${action} acknowledgement ownership`, () => {
    it('accepts the exact opaque target and native result with additive fields', () => {
      expect(tenantLifecycleOutcome(action, target, 201, { ...responses[action], futureField: 'compatible' })).toBe('completed');
    });
    it('accepts a UUID target without requiring that identifier format for other tenants', () => {
      const id = '85000000-0000-4000-8000-000000000002';
      expect(tenantLifecycleOutcome(action, id, 201, { ...responses[action], id })).toBe('completed');
    });
    it.each([
      ['null', null], ['missing body', undefined], ['boolean', true], ['number', 1],
      ['serialized JSON string', JSON.stringify(responses[action])], ['malformed JSON string', '{"id":'],
      ['array', [responses[action]]], ['empty object', {}],
      ['missing target', Object.fromEntries(Object.entries(responses[action]).filter(([name]) => name !== 'id'))],
      ['wrong target', { ...responses[action], id: 'tenant:opaque-A' }],
      ['numeric target', { ...responses[action], id: 7 }], ['null target', { ...responses[action], id: null }],
      ['padded target', { ...responses[action], id: ` ${target} ` }],
      ['case-changed target', { ...responses[action], id: target.toUpperCase() }],
    ])('does not confirm %s', (_name, value) => {
      expect(tenantLifecycleOutcome(action, target, 201, value)).toBe('unconfirmed');
    });
    it.each([200, 202, 204, 403, 503])('does not confirm noncontract HTTP status %i even with a success-shaped body', status => {
      expect(tenantLifecycleOutcome(action, target, status, responses[action])).toBe('unconfirmed');
    });
    for (const other of actions.filter(candidate => candidate !== action)) {
      it(`rejects the ${other} result for this action`, () => {
        expect(tenantLifecycleOutcome(action, target, 201, responses[other])).toBe('unconfirmed');
      });
    }
    it('rejects an absent owning target even if the body also has an empty ID', () => {
      expect(tenantLifecycleOutcome(action, '', 201, { ...responses[action], id: '' })).toBe('unconfirmed');
    });
  });
}

for (const action of ['suspend', 'activate'] as const) {
  describe(`${action} exact status discriminant`, () => {
    it.each([undefined, null, true, 1, action === 'suspend' ? 'suspended' : 'active', ['ACTIVE']].map(value => [value] as const))(
      'rejects an incorrectly typed or cased status (%j)', value => {
        expect(tenantLifecycleOutcome(action, target, 201, { id: target, status: value })).toBe('unconfirmed');
      },
    );
  });
}
for (const action of ['archive', 'restore'] as const) {
  describe(`${action} exact boolean discriminant`, () => {
    it.each([undefined, null, 'true', 'false', 1, 0, [], {}].map(value => [value] as const))('rejects a nonboolean flag (%j)', value => {
      expect(tenantLifecycleOutcome(action, target, 201, { id: target, [action === 'archive' ? 'archived' : 'restored']: value })).toBe('unconfirmed');
    });
  });
}
describe('supported incomplete outcome', () => {
  it('classifies exact-target archived false as incomplete rather than successful or malformed', () => {
    expect(tenantLifecycleOutcome('archive', target, 201, { id: target, archived: false })).toBe('incomplete');
  });
  it('does not attribute another tenant archived false to this operation', () => {
    expect(tenantLifecycleOutcome('archive', target, 201, { id: 'tenant:opaque-A', archived: false })).toBe('unconfirmed');
  });
  it('does not invent a legitimate restored false outcome', () => {
    expect(tenantLifecycleOutcome('restore', target, 201, { id: target, restored: false })).toBe('unconfirmed');
  });
});

// Execute the real status/read callbacks, not copies of their branch logic.
// Controlled setters/network seams are not a React/DOM or native API test.
const file = resolve(process.cwd(), 'app/admin/tenants/TenantsClient.tsx');
const source = readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'TenantsClient');
if (!component?.body) throw new Error('Missing actual TenantsClient');
function componentFunction(name: string) {
  const declarations = component!.body!.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (declarations.length !== 1) throw new Error(`Expected one actual ${name}`);
  return declarations[0].getText(ast);
}
const load = component.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  .find(node => node.name.getText(ast) === 'loadTenants');
if (!load?.initializer || !ts.isCallExpression(load.initializer) || !load.initializer.arguments[0]) throw new Error('Missing actual loadTenants callback');
const writeInit = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'jsonWriteInit');
if (!writeInit) throw new Error('Missing actual jsonWriteInit');
const executable = ts.transpileModule(`${writeInit.getText(ast)}
const loadTenants = ${load.initializer.arguments[0].getText(ast)};
${componentFunction('refresh')}
${componentFunction('runStatusAction')}
return { runStatusAction, refresh };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function callbackFixture(response: () => Promise<Response>, confirmation = true) {
  const tenant = { id: target, name: 'Boreal', slug: 'boreal-fixture' };
  const state: Record<string, any> = { error: 'Old list error', notice: null, saving: null, lifecycleFeedback: null,
    loading: false, tenants: [tenant], selectedTenantId: target };
  const write = vi.fn(async (_path: string, _init: RequestInit) => response());
  const read = vi.fn(async (_path: string) => ({ data: [tenant], pagination: { hasMore: false, nextCursor: null } }));
  const confirm = vi.fn(() => confirmation);
  const setter = (name: string) => (value: any) => { state[name] = typeof value === 'function' ? value(state[name]) : value; };
  const bindings = { tenantLifecycleOutcome, fetchWithSession: write, fetchJsonWithSession: read,
    getCsrfHeaders: () => ({ 'x-csrf-token': 'controlled-csrf' }), confirmLifecycleAction: confirm,
    buildAdminListPath, parseAdminListPagination, mergeAdminListPage, appliedQuery: '',
    ...Object.fromEntries(['error', 'notice', 'saving', 'lifecycleFeedback', 'loading', 'pagination', 'tenants', 'selectedTenantId']
      .map(name => [`set${name[0].toUpperCase()}${name.slice(1)}`, setter(name)])) };
  const callbacks = new Function(...Object.keys(bindings), executable)(...Object.values(bindings)) as {
    runStatusAction: (subject: typeof tenant, action: TenantStatusAction) => Promise<void>;
    refresh: (preferred?: string) => Promise<void>;
  };
  return { ...callbacks, tenant, state, write, read, confirm };
}
const json = (value: unknown, status = 201) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('actual lifecycle callback outcome publication', () => {
  it('retains supported incomplete guidance through automatic and explicit list refresh without a second POST', async () => {
    const f = callbackFixture(async () => json({ id: target, archived: false }));
    await f.runStatusAction(f.tenant, 'archive');
    expect(f.state.notice).toBeNull(); expect(f.state.error).toBeNull();
    expect(f.state.lifecycleFeedback.message).toMatch(/not completed/);
    const feedback = f.state.lifecycleFeedback;
    expect(f.read).toHaveBeenCalledOnce();
    await f.refresh(target);
    expect(f.state.lifecycleFeedback).toEqual(feedback); expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.write).toHaveBeenCalledOnce();
  });
  it('keeps malformed successful restore unconfirmed while preserving explicit read recovery', async () => {
    const f = callbackFixture(async () => new Response('{"id":', { status: 201 }));
    await f.runStatusAction(f.tenant, 'restore');
    expect(f.state.notice).toBeNull(); expect(f.state.lifecycleFeedback.message).toContain('Restore for Boreal is unconfirmed');
    await f.refresh(target); expect(f.state.lifecycleFeedback.message).toContain('unconfirmed');
    expect(f.write).toHaveBeenCalledOnce();
  });
  it.each([
    ['activate', { id: 'other-tenant', status: 'ACTIVE' }],
    ['suspend', { id: target, status: 'ACTIVE' }],
  ] as const)('rejects the actual %s callback mismatched acknowledgement', async (action, payload) => {
    const f = callbackFixture(async () => json(payload));
    await f.runStatusAction(f.tenant, action);
    expect(f.state.notice).toBeNull(); expect(f.state.lifecycleFeedback.message).toContain('unconfirmed');
    expect(f.write).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce();
  });
  it.each(['refusal', 'transport'] as const)('retains %s detail and guidance after a list error reset', async mode => {
    const f = callbackFixture(async () => {
      if (mode === 'transport') throw new Error('Unable to reach the service. Please try again.');
      return json({ message: 'Forbidden' }, 403);
    });
    await f.runStatusAction(f.tenant, 'archive');
    const detail = mode === 'refusal' ? 'Forbidden' : 'Unable to reach the service. Please try again.';
    expect(f.state.lifecycleFeedback.detail).toBe(detail); expect(f.state.notice).toBeNull();
    expect(f.read).not.toHaveBeenCalled();
    f.state.error = 'Transient list failure'; await f.refresh(target);
    expect(f.state.error).toBeNull(); expect(f.state.lifecycleFeedback.detail).toBe(detail);
    expect(f.state.lifecycleFeedback.message).toContain('Refresh'); expect(f.write).toHaveBeenCalledOnce();
  });
  it.each(actions)('keeps the actual %s successful target, request and notice', async action => {
    const f = callbackFixture(async () => json(responses[action]));
    await f.runStatusAction(f.tenant, action);
    const past = { suspend: 'suspended', activate: 'activated', archive: 'archived', restore: 'restored' };
    expect(f.state.notice).toBe(`Boreal ${past[action]}.`); expect(f.state.lifecycleFeedback).toBeNull();
    expect(f.write).toHaveBeenCalledExactlyOnceWith(`/admin/tenants/${target}/${action}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'controlled-csrf' },
    });
    expect(f.read).toHaveBeenCalledExactlyOnceWith('/admin/tenants?limit=50');
    expect(f.confirm).toHaveBeenCalledTimes(action === 'suspend' || action === 'archive' ? 1 : 0);
  });
  it.each(['suspend', 'archive'] as const)('preserves the actual %s cancellation without a read or mutation', async action => {
    const f = callbackFixture(async () => json(responses[action]), false);
    f.state.lifecycleFeedback = { message: 'Previous unresolved operation' };
    await f.runStatusAction(f.tenant, action);
    expect(f.write).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    expect(f.state.lifecycleFeedback).toEqual({ message: 'Previous unresolved operation' });
  });
});
