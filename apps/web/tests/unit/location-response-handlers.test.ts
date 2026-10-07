import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, clientComponentHarness, deferred, form, nodes, text, changeEvent, submitEvent } from './client-component-harness';

const m = vi.hoisted(() => ({ hooks: null as any, fetch: vi.fn() }));
vi.mock('react', async () => ({ ...(await vi.importActual<typeof import('react')>('react')),
  useState: (...args: unknown[]) => m.hooks.useState(...args),
  useRef: (...args: unknown[]) => m.hooks.useRef(...args),
  useCallback: (...args: unknown[]) => m.hooks.useCallback(...args),
  useMemo: (...args: unknown[]) => m.hooks.useMemo(...args),
  useEffect: (...args: unknown[]) => m.hooks.useEffect(...args),
}));
vi.mock('../../lib/client-api', async () => ({ ...(await vi.importActual<typeof import('../../lib/client-api')>('../../lib/client-api')), fetchWithSession: m.fetch }));
import { LocationsWorkspace } from '../../app/dashboard/locations/LocationsWorkspace';
import { LocationLifecycleActions } from '../../app/dashboard/locations/LocationLifecycleActions';
import { LocationTimeZoneInput } from '../../app/dashboard/locations/LocationTimeZoneInput';

const A = { id: '91000000-0000-4000-8000-000000000001', name: 'Alpha', address: 'Original', timezone: 'America/Chicago', updatedAt: '2026-07-20T10:00:00.000Z' };
const B = { ...A, id: '91000000-0000-4000-8000-000000000002', name: 'Beta' };
const saved = { ...A, name: 'Saved Alpha', address: 'Saved address', timezone: 'America/Denver', updatedAt: '2026-07-20T11:00:00.000Z' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const page = (rows: unknown[], nextCursor: string | null = null) => response({ data: rows, pagination: { hasMore: nextCursor !== null, nextCursor } });
let h: ReturnType<typeof clientComponentHarness>;
const render = () => { m.hooks = h.hooks; return h.render(); };
const rows = () => nodes(render()).filter(node => node.type === LocationLifecycleActions).map(node => node.props.location);
const actions = (id = A.id) => nodes(render()).find(node => node.type === LocationLifecycleActions && node.props.location.id === id)!.props;
const alert = () => nodes(render()).find(node => node.props.role === 'alert');
const loaded = () => h.until(tree => button(tree, 'Refresh').props.disabled === false);
async function workspace(nextCursor: string | null = null) {
  m.fetch.mockResolvedValueOnce(page([A, B], nextCursor));
  h = clientComponentHarness(() => LocationsWorkspace({ canWrite: true, canDelete: true }));
  render(); h.flushEffects(); await loaded();
}
beforeEach(() => { m.fetch.mockReset(); vi.stubGlobal('document', { cookie: '', addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); });

describe('actual Locations workspace read and mutation ordering', () => {
  it('keeps an acknowledged update when a pre-write refresh finishes later', async () => {
    await workspace('old-cursor'); const old = deferred<Response>(); m.fetch.mockReturnValueOnce(old.promise);
    button(render(), 'Refresh').props.onClick();
    const owner = actions(); const finish = owner.onMutationStart(); owner.onUpdated(saved); finish();
    old.resolve(page([A, B], 'obsolete-cursor')); await loaded();
    expect(rows()).toEqual([saved, B]);
    m.fetch.mockResolvedValueOnce(page([])); button(render(), 'Load more locations').props.onClick(); await loaded();
    expect(m.fetch.mock.calls[2][0]).toBe('/locations?limit=100&cursor=old-cursor');
  });

  it('does not resurrect a deactivated row through an old continuation page', async () => {
    await workspace('page-two'); const old = deferred<Response>(); m.fetch.mockReturnValueOnce(old.promise);
    button(render(), 'Load more locations').props.onClick();
    const owner = actions(); const finish = owner.onMutationStart(); owner.onDeactivated(A.id); finish();
    old.resolve(page([A], 'obsolete')); await loaded(); expect(rows()).toEqual([B]);
    expect(m.fetch.mock.calls[1][0]).toBe('/locations?limit=100&cursor=page-two');
  });

  it('keeps a newly created row when an earlier refresh completes', async () => {
    await workspace(); const old = deferred<Response>(); m.fetch.mockReturnValueOnce(old.promise);
    button(render(), 'Refresh').props.onClick(); button(render(), '+ Add Location').props.onClick();
    nodes(render()).find(n => n.props['aria-label'] === 'Location name')!.props.onChange(changeEvent('Gamma'));
    nodes(render()).find(n => n.type === LocationTimeZoneInput)!.props.onChange('America/Chicago');
    const created = { ...A, id: '91000000-0000-4000-8000-000000000003', name: 'Gamma' };
    const write = deferred<Response>(); m.fetch.mockReturnValueOnce(write.promise); form(render()).props.onSubmit(submitEvent());
    expect(m.fetch.mock.calls[2][1].method).toBe('POST');
    expect(JSON.parse(m.fetch.mock.calls[2][1].body)).toMatchObject({ name: 'Gamma', timezone: 'America/Chicago' });
    write.resolve(response(created)); await h.until(tree => text(tree).includes('Location added.'));
    old.resolve(page([A, B])); await loaded(); expect(rows()).toEqual([A, B, created]);
  });

  it('accepts an explicit post-mutation refresh and its current continuation', async () => {
    await workspace(); const owner = actions(); const finish = owner.onMutationStart(); owner.onUpdated(saved); finish();
    m.fetch.mockResolvedValueOnce(page([saved], 'current-page-two')); button(render(), 'Refresh').props.onClick(); await loaded();
    expect(rows()).toEqual([saved]); m.fetch.mockResolvedValueOnce(page([B])); button(render(), 'Load more locations').props.onClick(); await loaded();
    expect(m.fetch.mock.calls[2][0]).toBe('/locations?limit=100&cursor=current-page-two');
    expect(rows()).toEqual([B, saved]);
  });

  it('fences reads started between overlapping writes and waits for both settlements', async () => {
    await workspace(); const first = actions().onMutationStart(); const second = actions(B.id).onMutationStart();
    const mid = deferred<Response>(); m.fetch.mockReturnValueOnce(mid.promise);
    // Invoke the actual callback to model a queued click; the visible control is disabled.
    expect(button(render(), 'Refresh').props.disabled).toBe(true); button(render(), 'Refresh').props.onClick();
    first(); expect(button(render(), 'Refresh').props.disabled).toBe(true); second();
    mid.resolve(page([{ ...A, name: 'Mid-write stale' }, B])); await loaded(); expect(rows()).toEqual([A, B]);
  });

  it('shows a current permission error even if a mutation overlaps the list request', async () => {
    await workspace(); const read = deferred<Response>(); m.fetch.mockReturnValueOnce(read.promise); button(render(), 'Refresh').props.onClick();
    const owner = actions(); const finish = owner.onMutationStart(); owner.onUpdated(saved); finish();
    read.resolve(response({ message: 'Permission revoked.' }, 403)); await loaded();
    expect(text(alert())).toContain('Permission revoked.'); expect(rows()).toEqual([saved, B]);
  });

  it('does not let an older request replace newer rows, cursor, error or loading state', async () => {
    await workspace(); const old = deferred<Response>(); const current = deferred<Response>();
    m.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    button(render(), 'Refresh').props.onClick(); button(render(), 'Refresh').props.onClick();
    old.resolve(response({ message: 'Obsolete read failure' }, 500));
    current.resolve(page([saved], 'latest')); await loaded();
    expect(rows()).toEqual([saved]); expect(alert()).toBeUndefined(); expect(button(render(), 'Load more locations').props.disabled).toBe(false);
  });
});

function lifecycle() {
  const finish = vi.fn(); const updated = vi.fn(); const error = vi.fn(); const notice = vi.fn();
  const begin = vi.fn(() => finish);
  h = clientComponentHarness(() => LocationLifecycleActions({ location: A, canWrite: true, canDelete: true,
    onMutationStart: begin, onUpdated: updated, onDeactivated: vi.fn(), onError: error, onNotice: notice }));
  button(render(), 'Edit').props.onClick();
  const edit = form(render()); const inputs = nodes(edit).filter(n => n.type === 'input');
  inputs[0].props.onChange(changeEvent(saved.name)); inputs[1].props.onChange(changeEvent(saved.address));
  nodes(render()).find(n => n.type === LocationTimeZoneInput)!.props.onChange(saved.timezone);
  return { finish, updated, error, notice, begin };
}
function expectDraft() {
  const edit = form(render()); expect(nodes(edit).filter(n => n.type === 'input').map(n => n.props.value)).toEqual([saved.name, saved.address]);
  expect(nodes(edit).find(n => n.type === LocationTimeZoneInput)!.props.value).toBe(saved.timezone);
  expect(button(render(), 'Save changes').props.disabled).toBe(false);
}
describe('actual Location edit acknowledgement handling', () => {
  it.each([
    ['foreign target', { ...saved, id: B.id }], ['missing identity', {}], ['malformed fields', { ...saved, name: 42 }],
    ['blank name', { ...saved, name: '' }], ['whitespace name', { ...saved, name: ' \t ' }],
    ['overlong name', { ...saved, name: 'x'.repeat(201) }],
    ['invalid timestamp', { ...saved, updatedAt: 'not-a-date' }],
    ['noncanonical timestamp', { ...saved, updatedAt: '2026-07-20T11:00:00Z' }],
    ['offset timestamp', { ...saved, updatedAt: '2026-07-20T07:00:00.000-04:00' }],
    ['normalized impossible date', { ...saved, updatedAt: '2026-02-30T00:00:00.000Z' }],
    ['null version', { ...saved, updatedAt: null }],
    ['invalid timezone', { ...saved, timezone: 'Not/A_Real_Zone' }],
    ['blank timezone', { ...saved, timezone: '' }], ['whitespace timezone', { ...saved, timezone: '   ' }],
  ])('keeps the typed draft and reports uncertainty for a %s acknowledgement', async (_label, ack) => {
    const callbacks = lifecycle(); const gate = deferred<Response>(); m.fetch.mockReturnValueOnce(gate.promise);
    const pending = form(render()).props.onSubmit(submitEvent());
    expect(button(render(), 'Saving...').props.disabled).toBe(true);
    expect(m.fetch.mock.calls[0][0]).toBe('/locations/' + A.id);
    expect(JSON.parse(m.fetch.mock.calls[0][1].body)).toEqual({ name: saved.name, address: saved.address, timezone: saved.timezone, expectedUpdatedAt: A.updatedAt });
    gate.resolve(response(ack)); await pending;
    expectDraft(); expect(callbacks.updated).not.toHaveBeenCalled(); expect(callbacks.notice).not.toHaveBeenCalled();
    expect(callbacks.error).toHaveBeenLastCalledWith(expect.stringContaining('Your draft has been kept'));
    expect(callbacks.finish).toHaveBeenCalledExactlyOnceWith(); expect(m.fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts the exact target and closes the form only after the acknowledged update', async () => {
    const callbacks = lifecycle(); m.fetch.mockResolvedValueOnce(response(saved)); await form(render()).props.onSubmit(submitEvent());
    expect(callbacks.updated).toHaveBeenCalledExactlyOnceWith(saved); expect(callbacks.notice).toHaveBeenCalledExactlyOnceWith('Location updated.');
    expect(callbacks.finish).toHaveBeenCalledExactlyOnceWith(); expect(nodes(render()).filter(n => n.type === 'form')).toHaveLength(0);
  });

  it.each([
    ['omitted optional fields', { id: A.id, name: saved.name }],
    ['nullable legacy fields', { ...saved, address: null, timezone: null }],
    ['omitted version with a valid timezone', { id: A.id, name: saved.name, address: '', timezone: 'UTC' }],
    ['maximum native name length', { ...saved, name: 'x'.repeat(200) }],
  ])('accepts a same-target acknowledgement with %s', async (_label, ack) => {
    const callbacks = lifecycle(); m.fetch.mockResolvedValueOnce(response(ack));
    await form(render()).props.onSubmit(submitEvent());
    expect(callbacks.updated).toHaveBeenCalledExactlyOnceWith(ack);
    expect(callbacks.notice).toHaveBeenCalledExactlyOnceWith('Location updated.');
    expect(callbacks.error).toHaveBeenCalledExactlyOnceWith('');
    expect(callbacks.finish).toHaveBeenCalledExactlyOnceWith();
    expect(nodes(render()).filter(n => n.type === 'form')).toHaveLength(0);
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([403, 409])('preserves a refused draft and the real %s response message', async status => {
    const callbacks = lifecycle(); m.fetch.mockResolvedValueOnce(response({ detail: `Exact ${status} refusal` }, status));
    await form(render()).props.onSubmit(submitEvent()); expectDraft();
    expect(callbacks.error).toHaveBeenLastCalledWith(`Exact ${status} refusal`); expect(callbacks.updated).not.toHaveBeenCalled();
    expect(callbacks.notice).not.toHaveBeenCalled(); expect(callbacks.finish).toHaveBeenCalledExactlyOnceWith();
  });
});
