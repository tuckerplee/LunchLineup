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

// Controlled actual handlers and effect listener; this is not browser focus/DOM proof.
function deletion() {
  const finish = vi.fn(); const deactivated = vi.fn(); const error = vi.fn();
  const begin = vi.fn(() => finish);
  h = clientComponentHarness(() => LocationLifecycleActions({ location: A, canWrite: true, canDelete: true,
    onMutationStart: begin, onUpdated: vi.fn(), onDeactivated: deactivated, onError: error, onNotice: vi.fn() }));
  render(); h.flushEffects();
  button(render(), 'Deactivate').props.onClick();
  const dialog = nodes(render()).find(n => n.props.role === 'alertdialog')!;
  (dialog as unknown as { ref: { current: unknown } }).ref.current = { querySelectorAll: () => [], focus: vi.fn() };
  h.flushEffects();
  const keydown = vi.mocked(document.addEventListener).mock.calls.find(([name]) => name === 'keydown')![1] as (event: unknown) => void;
  nodes(dialog).find(n => n.type === 'input')!.props.onChange(changeEvent(A.name));
  return { begin, finish, deactivated, error, keydown };
}
const escape = () => ({ key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() });
describe('actual Location deactivation single-flight and Escape', () => {
  it('retains the pending modal and sends exactly one DELETE despite repeated queued confirmation and Escape', async () => {
    const c = deletion(); const pending = deferred<Response>(); m.fetch.mockReturnValueOnce(pending.promise);
    const confirm = button(render(), 'Deactivate location');
    confirm.props.onClick(); confirm.props.onClick(); c.keydown(escape());
    expect(nodes(render()).some(n => n.props.role === 'alertdialog')).toBe(true);
    expect(button(render(), 'Deactivating...').props.disabled).toBe(true);
    expect(button(render(), 'Cancel').props.disabled).toBe(true);
    // A queued cancel callback must also respect pending custody.
    button(render(), 'Cancel').props.onClick();
    expect(nodes(render()).some(n => n.props.role === 'alertdialog')).toBe(true);
    expect(m.fetch).toHaveBeenCalledExactlyOnceWith('/locations/' + A.id, expect.objectContaining({ method: 'DELETE' }));
    expect(c.begin).toHaveBeenCalledTimes(1); expect(c.deactivated).not.toHaveBeenCalled();
    pending.resolve(new Response(null, { status: 204 }));
    await h.until(tree => !nodes(tree).some(n => n.props.role === 'alertdialog'));
    expect(c.deactivated).toHaveBeenCalledExactlyOnceWith(A.id); expect(c.finish).toHaveBeenCalledTimes(1);
  });

  it('preserves the target and confirmation after failure and allows one intentional retry', async () => {
    const c = deletion(); const pending = deferred<Response>(); m.fetch.mockReturnValueOnce(pending.promise);
    button(render(), 'Deactivate location').props.onClick(); c.keydown(escape());
    pending.resolve(response({ detail: 'Location still has active work.' }, 409));
    await h.until(tree => nodes(tree).some(n => n.type === 'button' && text(n.props.children).trim() === 'Deactivate location' && !n.props.disabled));
    expect(c.deactivated).not.toHaveBeenCalled(); expect(c.error).toHaveBeenLastCalledWith('Location still has active work.');
    expect(nodes(render()).find(n => n.type === 'input')!.props.value).toBe(A.name);
    m.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    button(render(), 'Deactivate location').props.onClick();
    await h.until(tree => !nodes(tree).some(n => n.props.role === 'alertdialog'));
    expect(m.fetch).toHaveBeenCalledTimes(2); expect(c.begin).toHaveBeenCalledTimes(2); expect(c.finish).toHaveBeenCalledTimes(2);
    expect(c.deactivated).toHaveBeenCalledExactlyOnceWith(A.id);
  });

  it('allows idle Escape to cancel without beginning a mutation', () => {
    const c = deletion(); c.keydown(escape());
    expect(nodes(render()).some(n => n.props.role === 'alertdialog')).toBe(false);
    expect(m.fetch).not.toHaveBeenCalled(); expect(c.begin).not.toHaveBeenCalled();
  });

  it('guards two synchronous edit submissions before a rerender', async () => {
    const c = lifecycle(); const pending = deferred<Response>(); m.fetch.mockReturnValueOnce(pending.promise);
    const submit = form(render()).props.onSubmit;
    const first = submit(submitEvent()); await submit(submitEvent());
    expect(m.fetch).toHaveBeenCalledTimes(1); expect(c.begin).toHaveBeenCalledTimes(1);
    pending.resolve(response(saved)); await first;
    expect(c.updated).toHaveBeenCalledExactlyOnceWith(saved); expect(c.finish).toHaveBeenCalledTimes(1);
  });
});
