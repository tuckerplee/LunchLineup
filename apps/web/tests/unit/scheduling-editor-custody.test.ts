import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, changeEvent, clientComponentHarness, deferred, form, nodes, submitEvent, text } from './client-component-harness';

const mocks = vi.hoisted(() => ({ hooks: null as any, board: vi.fn(), create: vi.fn(), apply: vi.fn(), refs: [] as any[], queueStateUpdates: false, queuedStateUpdates: [] as Array<() => void> }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => {
    const [value, setValue] = mocks.hooks.useState(...args);
    return [value, (next: unknown) => {
      if (mocks.queueStateUpdates) mocks.queuedStateUpdates.push(() => setValue(next));
      else setValue(next);
    }];
  },
  useRef: (...args: any[]) => { const ref = mocks.hooks.useRef(...args); if (!mocks.refs.includes(ref)) mocks.refs.push(ref); return ref; },
  useEffect: (...args: any[]) => mocks.hooks.useEffect(...args),
  useMemo: (...args: any[]) => mocks.hooks.useMemo(...args),
  useCallback: (...args: any[]) => mocks.hooks.useCallback(...args),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-10-04&location=11111111-1111-4111-8111-111111111111') }));
vi.mock('next/dynamic', () => ({ default: () => 'controlled-schedule-board' }));
vi.mock('@/components/ui/button', () => ({ Button: 'button' }));
vi.mock('@/lib/api-v2', () => ({ apiV2: { getScheduleBoard: mocks.board, createSchedule: mocks.create, applyScheduleChangeSet: mocks.apply } }));
vi.mock('../../app/dashboard/scheduling/use-schedule-commands', () => ({ useScheduleCommands: () => ({ commandState: { byShiftId: {} }, updateShift: vi.fn(), copyShift: vi.fn(), deleteShift: vi.fn(), undoShift: vi.fn(), dismissFeedback: vi.fn() }) }));
import SchedulingPage from '../../app/dashboard/scheduling/page';
import { ApiV2ClientError } from '@lunchlineup/api-contract';

// Invoke actual page JSX handlers against controlled transport and hook state.
// This does not model DOM/React scheduling, HTTP/database commits or browser acceptance.
const locationId = '11111111-1111-4111-8111-111111111111';
const locationB = '22222222-2222-4222-8222-222222222222';
const schedule = { id: 'schedule-a', locationId, status: 'DRAFT', revision: 1, etag: 'etag-1', version: 1, startDate: '2026-10-04T00:00:00.000Z', endDate: '2026-10-07T00:00:00.000Z' };
const savedShift = { id: 'shift-a', scheduleId: schedule.id, locationId, userId: 'staff-a', user: { id: 'staff-a', name: 'Alice', role: 'STAFF' }, role: 'STAFF', startTime: '2026-10-04T09:00:00.000Z', endTime: '2026-10-04T17:00:00.000Z', breaks: [] };
const existingShift = { ...savedShift, id: 'shift-existing', userId: 'staff-b', user: { id: 'staff-b', name: 'Bob', role: 'MANAGER' }, role: 'MANAGER' };
const saved = () => ({ data: { revision: 2, etag: 'etag-2', shifts: [structuredClone(existingShift), structuredClone(savedShift)] } });
let h: ReturnType<typeof clientComponentHarness>;
let responses: Array<ReturnType<typeof deferred<unknown>>>;
let submissions: Promise<void>[];
function controlledResponse<T>() {
  const response = deferred<T>();
  responses.push(response as ReturnType<typeof deferred<unknown>>);
  return response;
}
function dialog() { return nodes(h.render()).find(node => node.props.role === 'dialog'); }
function field(label: string) {
  const group = nodes(form(h.render())).find(node => node.type === 'label'
    && nodes(node.props.children).some(child => child.type === 'span' && text(child.props.children).trim() === label));
  const result = group && nodes(group.props.children).find(node => node.type === 'input' || node.type === 'select');
  if (!result) throw new Error(`Missing actual editor field ${label}`);
  return result;
}
function board() {
  const result = nodes(h.render()).find(node => node.type === 'controlled-schedule-board');
  if (!result) throw new Error('Missing actual scheduling board props');
  return result;
}
function draft() { return Object.fromEntries(['Staff', 'Location', 'Shift role', 'Date', 'Start', 'End'].map(label => [label, field(label).props.value])); }
function open() { button(h.render(), 'Add shift').props.onClick(); expect(dialog()).toBeDefined(); }
function edit(label: string, value: string) { field(label).props.onChange(changeEvent(value)); }
function submit() { const pending = form(h.render()).props.onSubmit(submitEvent()) as Promise<void>; submissions.push(pending); return pending; }
function expectSavedBoard() { expect(board().props.events.find((event: any) => event.id === savedShift.id)).toMatchObject({ resourceId: savedShift.userId }); }
async function reloadBoard() {
  for (let pass = 0; pass < 2; pass++) {
    h.render(); h.flushEffects();
    await h.until(tree => nodes(tree).some(node => node.type === 'controlled-schedule-board' && typeof node.props.onSlotSelect === 'function')
      && !button(tree, 'Add shift').props.disabled);
  }
}
beforeEach(async () => {
  responses = []; submissions = [];
  mocks.refs = [];
  mocks.queueStateUpdates = false; mocks.queuedStateUpdates = [];
  mocks.board.mockReset(); mocks.create.mockReset(); mocks.apply.mockReset();
  vi.stubGlobal('window', { sessionStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, setTimeout });
  vi.stubGlobal('document', { body: { style: { overflow: '' } } });
  mocks.board.mockImplementation(async (request: any) => {
    const selectedLocationId = request.locationId ?? locationId;
    const selectedSchedule = { ...schedule, id: selectedLocationId === locationId ? schedule.id : 'schedule-b', locationId: selectedLocationId,
      startDate: `${request.date}T00:00:00.000Z`, endDate: new Date(Date.parse(`${request.date}T00:00:00.000Z`) + 3 * 86400000).toISOString() };
    return { data: {
    permissions: ['schedules:read', 'shifts:read', 'locations:read', 'shifts:write'], selectedLocationId,
    locations: [{ id: locationId, name: 'A', timezone: 'UTC' }, { id: locationB, name: 'B', timezone: 'UTC' }],
    staff: [{ id: 'staff-a', name: 'Alice', role: 'STAFF' }, { id: 'staff-b', name: 'Bob', role: 'MANAGER' }],
    schedules: [selectedSchedule], shifts: [{ ...structuredClone(existingShift), id: selectedLocationId === locationId ? existingShift.id : 'shift-b',
      scheduleId: selectedSchedule.id, locationId: selectedLocationId, startTime: `${request.date}T09:00:00.000Z`, endTime: `${request.date}T17:00:00.000Z` }],
  } }; });
  h = clientComponentHarness(SchedulingPage); mocks.hooks = h.hooks;
  await reloadBoard(); open();
  expect(board().props.events.some((event: any) => event.id === savedShift.id)).toBe(false);
});
afterEach(async () => {
  for (const response of responses) response.resolve(saved());
  await Promise.allSettled(submissions);
  mocks.queueStateUpdates = false;
  for (const update of mocks.queuedStateUpdates.splice(0)) update();
  h?.unmount(); vi.unstubAllGlobals();
});

describe('actual scheduling editor completion custody', () => {
  it('closes the unchanged submitted create draft and applies the saved board', async () => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise);
    const issued = draft(); const pending = submit();
    expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(schedule.id, { operations: [{ op: 'shift.create', clientId: expect.any(String), userId: issued.Staff, role: issued['Shift role'], startTime: savedShift.startTime, endTime: savedShift.endTime }] }, schedule.etag, expect.any(String));
    response.resolve(saved()); await pending;
    expect(dialog()).toBeUndefined(); expectSavedBoard();
    expect(text(h.render())).toContain('Shift created and saved');
  });

  it.each([
    ['Staff', 'staff-b'], ['Shift role', 'MANAGER'], ['Date', '2026-10-05'], ['Start', '10:00'], ['End', '18:00'],
  ])('keeps a newer %s draft after the original create succeeds', async (label, value) => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise);
    const pending = submit(); const issued = structuredClone(mocks.apply.mock.calls[0]);
    edit(label, value); const newer = draft();
    response.resolve(saved()); await pending;
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(newer); expectSavedBoard();
    expect(mocks.apply.mock.calls[0]).toEqual(issued); expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it('preserves a newer editor after close/reopen with identical field values', async () => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise);
    const issued = draft(); const pending = submit();
    button(h.render(), 'Cancel').props.onClick(); open(); expect(draft()).toEqual(issued);
    response.resolve(saved()); await pending;
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(issued); expectSavedBoard();
  });

  it('preserves a newer edit intent even when changed fields are restored to submitted values', async () => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise);
    const issued = draft(); const pending = submit();
    edit('Staff', 'staff-b'); edit('Staff', 'staff-a'); expect(draft()).toEqual(issued);
    response.resolve(saved()); await pending;
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(issued); expectSavedBoard();
  });

  it('keeps the existing saved-shift editor opened during a pending create', async () => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise);
    const pending = submit();
    board().props.onEventSelect({ id: existingShift.id }); const newer = draft();
    response.resolve(saved()); await pending;
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(newer); expect(text(dialog())).toContain('Edit shift');
  });

  it('retains a failed request key for an unchanged retry', async () => {
    mocks.apply.mockRejectedValueOnce(new Error('controlled lost create response'));
    const before = draft(); await submit(); const issued = structuredClone(mocks.apply.mock.calls[0]);
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(before);
    mocks.apply.mockResolvedValueOnce(saved()); await submit();
    expect(mocks.apply.mock.calls[1]).toEqual(issued); expect(dialog()).toBeUndefined(); expectSavedBoard();
  });

  it('does not clear a newer request key when an older create succeeds', async () => {
    const first = controlledResponse<unknown>(), second = controlledResponse<unknown>();
    mocks.apply.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = submit(); edit('Staff', 'staff-b'); const newerDraft = draft(); const newer = submit();
    const newerRequest = structuredClone(mocks.apply.mock.calls[1]);
    const key = newerRequest[1].operations[0].clientId;
    const attempt = mocks.refs.find(ref => ref.current?.key === key); expect(attempt).toBeDefined();
    expect(key).not.toBe(mocks.apply.mock.calls[0][1].operations[0].clientId);
    first.resolve(saved()); await older;
    expect(attempt.current?.key).toBe(key);
    second.reject(new Error('controlled lost newer create response')); await newer;
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(newerDraft);
    mocks.apply.mockResolvedValueOnce(saved()); await submit();
    expect(mocks.apply.mock.calls[2]).toEqual([newerRequest[0], newerRequest[1], 'etag-2', newerRequest[3]]);
  });

  it('does not rotate a newer request key or reload its editor when an older create is unreplayable', async () => {
    const first = controlledResponse<unknown>(), second = controlledResponse<unknown>();
    mocks.apply.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = submit(); edit('Staff', 'staff-b'); const newerDraft = draft(); const newer = submit();
    const newerRequest = structuredClone(mocks.apply.mock.calls[1]); const boardReads = mocks.board.mock.calls.length;
    const key = newerRequest[1].operations[0].clientId;
    const attempt = mocks.refs.find(ref => ref.current?.key === key); expect(attempt).toBeDefined();
    first.reject(new ApiV2ClientError(409, { type: 'about:blank', title: 'Old attempt unavailable', detail: 'Old attempt unavailable', status: 409, code: 'idempotency_result_unavailable' })); await older;
    expect(attempt.current?.key).toBe(key);
    second.reject(new Error('controlled lost newer response')); await newer;
    expect(mocks.board).toHaveBeenCalledTimes(boardReads);
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(newerDraft);
    mocks.apply.mockResolvedValueOnce(saved()); await submit();
    expect(mocks.apply.mock.calls[2]).toEqual(newerRequest);
  });

  it('does not replace a newer editor status with an older create failure', async () => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise);
    const pending = submit(); board().props.onEventSelect({ id: existingShift.id });
    const newer = draft(); const status = text(h.render());
    expect(status).toContain('Shift details opened.');
    response.reject(new Error('old controlled create failure')); await pending;
    expect(draft()).toEqual(newer); expect(text(h.render())).toContain('Shift details opened.');
    expect(text(h.render())).not.toContain('old controlled create failure');
  });

  it('continues the issued create payload through a pending fallback schedule creation', async () => {
    mocks.board.mockResolvedValueOnce({ data: { ...(await mocks.board({ locationId, date: '2026-10-04', view: 'threeDay' })).data, schedules: [] } });
    field('Location').props.onChange(changeEvent(locationId)); await reloadBoard(); open();
    const response = controlledResponse<unknown>(); mocks.create.mockReturnValueOnce(response.promise); mocks.apply.mockResolvedValueOnce(saved());
    const pending = submit(); edit('Staff', 'staff-b'); const newer = draft();
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.apply).not.toHaveBeenCalled();
    response.resolve({ data: structuredClone(schedule) }); await pending;
    expect(mocks.apply.mock.calls[0][1].operations[0].userId).toBe('staff-a');
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(newer); expectSavedBoard();
  });

  it('leaves a different location draft and board untouched by an old successful response', async () => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise);
    const pending = submit(); edit('Location', locationB); await reloadBoard();
    const newer = draft(); response.resolve(saved()); await pending;
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(newer);
    expect(board().props.events.some((event: any) => event.id === savedShift.id)).toBe(false);
  });

  it.each(['date', 'view', 'location ABA'])('does not publish an old save into a newer %s visit', async change => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise); const pending = submit();
    if (change === 'date') nodes(h.render()).find(node => node.props['aria-label'] === 'Schedule date')!.props.onChange(changeEvent('2026-10-05'));
    else if (change === 'view') button(h.render(), 'Day').props.onClick();
    else { edit('Location', locationB); await reloadBoard(); edit('Location', locationId); }
    await reloadBoard(); const newer = draft(); response.resolve(saved()); await pending;
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(newer);
    expect(board().props.events.some((event: any) => event.id === savedShift.id)).toBe(false);
  });

  it('does not reload an old calendar scope after its save fails', async () => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise); const pending = submit();
    edit('Location', locationB); await reloadBoard(); const boardReads = mocks.board.mock.calls.length;
    const newer = draft(); response.reject(new ApiV2ClientError(412, { type: 'about:blank', title: 'Old etag conflict', detail: 'Old etag conflict', code: 'etag_mismatch', status: 412 })); await pending;
    expect(mocks.board).toHaveBeenCalledTimes(boardReads); expect(draft()).toEqual(newer);
    expect(text(h.render())).not.toContain('Old etag conflict');
  });

  it('closes an unchanged update editor after its saved result', async () => {
    board().props.onEventSelect({ id: existingShift.id }); edit('Start', '10:00');
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise); const pending = submit();
    expect(mocks.apply.mock.calls[0][1].operations[0]).toMatchObject({ op: 'shift.update', shiftId: existingShift.id, startTime: '2026-10-04T10:00:00.000Z' });
    response.resolve(saved()); await pending;
    expect(dialog()).toBeUndefined(); expect(text(h.render())).toContain('Shift changes saved');
  });

  it('preserves a newer same-scope draft through the shared update success tail', async () => {
    board().props.onEventSelect({ id: existingShift.id }); edit('Start', '10:00');
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise); const pending = submit();
    edit('End', '18:00'); const newer = draft(); response.resolve(saved()); await pending;
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(newer); expect(text(dialog())).toContain('Edit shift');
  });

  it.each(['combined fields', 'board slot', 'duplicate'])('preserves a replacement %s draft while a create is pending', async replacement => {
    const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise); const pending = submit();
    if (replacement === 'combined fields') { edit('Staff', 'staff-b'); edit('Start', '10:00'); edit('End', '18:00'); }
    else if (replacement === 'board slot') board().props.onSlotSelect({ resourceId: 'staff-b', start: '2026-10-04T10:00:00.000Z', end: '2026-10-04T18:00:00.000Z' });
    else { board().props.onEventSelect({ id: existingShift.id }); button(h.render(), 'Duplicate shift').props.onClick(); }
    const newer = draft(); expect(newer).not.toMatchObject({ Staff: 'staff-a', Start: '09:00', End: '17:00' });
    response.resolve(saved()); await pending;
    expect(dialog()).toBeDefined(); expect(draft()).toEqual(newer); expectSavedBoard();
  });

  it('closes the unchanged fallback create and keeps linked schedule/shift idempotency keys', async () => {
    mocks.board.mockResolvedValueOnce({ data: { ...(await mocks.board({ locationId, date: '2026-10-04', view: 'threeDay' })).data, schedules: [] } });
    edit('Location', locationId); await reloadBoard(); open();
    mocks.create.mockResolvedValueOnce({ data: structuredClone(schedule) }); mocks.apply.mockResolvedValueOnce(saved()); await submit();
    expect(dialog()).toBeUndefined(); expectSavedBoard();
    const key = mocks.apply.mock.calls[0][1].operations[0].clientId;
    expect(mocks.create.mock.calls[0][2]).toBe(`${key}:schedule`);
    expect(mocks.apply.mock.calls[0][3]).toBe(`${key}:shift`);
  });

  it.each(['create', 'update'])('keeps a later time edit when %s cleanup was queued before its state commits', async kind => {
    if (kind === 'update') { board().props.onEventSelect({ id: existingShift.id }); edit('Start', '10:00'); }
    const before = draft(); const response = controlledResponse<unknown>(); mocks.apply.mockReturnValueOnce(response.promise);
    const pending = submit(); mocks.queueStateUpdates = true;
    response.resolve(saved()); await pending;
    // Invoke the actual still-visible field handler after completion enqueues its
    // cleanup but before the hook ledger applies any queued state updates.
    edit('Start', '11:00');
    mocks.queueStateUpdates = false;
    for (const update of mocks.queuedStateUpdates.splice(0)) update();
    expect(dialog()).toBeDefined(); expect(draft()).toEqual({ ...before, Start: '11:00' });
    expect(text(dialog())).toContain(kind === 'update' ? 'Edit shift' : 'Create shift'); expectSavedBoard();
  });
});
