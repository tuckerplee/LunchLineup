import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/ui/button', () => ({ Button: () => null }));
vi.mock('@/components/scheduling/StaffScheduler', () => ({ StaffScheduler: () => null }));
vi.mock('@/lib/client-api', () => ({
  fetchJsonWithSession: vi.fn(),
  fetchWithSession: vi.fn(),
  idempotentRequestAttempt: (
    payload: unknown,
    current: { key: string; payloadFingerprint: string } | null,
    keyFactory: () => string,
  ) => {
    const payloadFingerprint = JSON.stringify(payload);
    if (current?.payloadFingerprint === payloadFingerprint) return current;
    return { key: keyFactory(), payloadFingerprint };
  },
  withIdempotencyKey: vi.fn(),
}));
vi.mock('@/lib/permissions', () => ({
  getWorkspaceCapabilities: vi.fn(),
  hasSchedulingReadAccess: vi.fn(),
}));
vi.mock('@/lib/location-timezone', () => ({
  addLocalDays: vi.fn(),
  dateValueInTimeZone: vi.fn(),
  formatDateInTimeZone: vi.fn(),
  localDateRange: vi.fn(),
  safeTimeZone: vi.fn(),
  timeValueInTimeZone: vi.fn(),
}));

import {
  executeBreakGenerationWithRecovery,
  type BreakGenerationAttempt,
} from '../../app/dashboard/scheduling/break-generation-recovery';
import {
  assertBreakGenerationResponseScope,
  buildLocationScheduleQuery,
  buildLocationShiftQuery,
  locationShiftScopeMatches,
  locationShiftVisitIsCurrent,
  resolveTenantVisibleLocation,
  shiftIdsForLocation,
  shiftsForLocation,
} from '../../app/dashboard/scheduling/location-shift-scope';

const shifts = [
  { id: 'shift-downtown', locationId: 'loc-downtown' },
  { id: 'shift-uptown', locationId: 'loc-uptown' },
];

describe('scheduling location shift scope', () => {
  it('always bounds schedule and shift refreshes to the active location and range', () => {
    const range = {
      start: '2026-07-09T07:00:00.000Z',
      end: '2026-07-10T07:00:00.000Z',
    };
    const shiftUrl = new URL(buildLocationShiftQuery(range, 'loc-uptown'), 'https://lunchlineup.test');
    const scheduleUrl = new URL(buildLocationScheduleQuery(range, 'loc-uptown'), 'https://lunchlineup.test');

    for (const url of [shiftUrl, scheduleUrl]) {
      expect(url.searchParams.get('locationId')).toBe('loc-uptown');
      expect(url.searchParams.get('startDate')).toBe('2026-07-09T07:00:00.000Z');
      expect(url.searchParams.get('endDate')).toBe('2026-07-10T07:00:00.000Z');
      expect(url.searchParams.get('limit')).toBe('200');
    }
  });

  it('refuses unscoped shift loads', () => {
    expect(() => buildLocationShiftQuery({ start: 'start', end: 'end' }, '  '))
      .toThrow(/locationId is required/i);
  });

  it('honors a linked location only when it is tenant-visible', () => {
    const locations = [
      { id: 'loc-downtown', name: 'Downtown' },
      { id: 'loc-uptown', name: 'Uptown' },
    ];

    expect(resolveTenantVisibleLocation(locations, 'loc-uptown')).toEqual(locations[1]);
    expect(resolveTenantVisibleLocation(locations, 'loc-other-tenant')).toEqual(locations[0]);
  });

  it('never sends or retains another location shift', () => {
    expect(shiftIdsForLocation(shifts, 'loc-uptown')).toEqual(['shift-uptown']);
    expect(shiftsForLocation(shifts, 'loc-uptown')).toEqual([
      { id: 'shift-uptown', locationId: 'loc-uptown' },
    ]);
  });

  it('invalidates Uptown data as soon as Downtown becomes the desired scope', () => {
    const loadedUptown = { locationId: 'loc-uptown', dateValue: '2026-07-09', viewMode: 'threeDay' as const };
    const desiredDowntown = { ...loadedUptown, locationId: 'loc-downtown' };

    expect(locationShiftScopeMatches(loadedUptown, desiredDowntown)).toBe(false);
    expect(locationShiftScopeMatches(desiredDowntown, desiredDowntown)).toBe(true);
  });


  it('rejects a delayed response from the previous visit after location A-to-B-to-A', () => {
    const visitA = { locationId: 'loc-downtown', dateValue: '2026-07-09', viewMode: 'threeDay' as const, visitGeneration: 1 };
    const desiredB = { ...visitA, locationId: 'loc-uptown' };
    expect(locationShiftVisitIsCurrent(visitA, desiredB, 2)).toBe(false);
    const returnedToA = { ...visitA, visitGeneration: 3 };
    expect(locationShiftScopeMatches(visitA, returnedToA)).toBe(true);
    expect(locationShiftVisitIsCurrent(visitA, returnedToA, 3)).toBe(false);
    expect(locationShiftVisitIsCurrent(returnedToA, returnedToA, 3)).toBe(true);
  });

  it('rejects a delayed response after date or view is changed and restored', () => {
    const captured = { locationId: 'loc-downtown', dateValue: '2026-07-09', viewMode: 'threeDay' as const, visitGeneration: 7 };
    expect(locationShiftVisitIsCurrent(captured, { ...captured, dateValue: '2026-07-10' }, 8)).toBe(false);
    expect(locationShiftVisitIsCurrent(captured, captured, 9)).toBe(false);
    expect(locationShiftVisitIsCurrent(captured, { ...captured, viewMode: 'week' }, 10)).toBe(false);
    expect(locationShiftVisitIsCurrent(captured, captured, 11)).toBe(false);
  });

  it('preserves completion after an owner reload in the same visit', () => {
    const captured = { locationId: 'loc-downtown', dateValue: '2026-07-09', viewMode: 'threeDay' as const, visitGeneration: 12 };
    const reloaded = { ...captured };
    expect(locationShiftVisitIsCurrent(captured, reloaded, 12)).toBe(true);
  });

  it('rejects generation responses that identify another location or shift set', () => {
    expect(() => assertBreakGenerationResponseScope(
      { locationId: 'loc-uptown', data: [{ shiftId: 'shift-uptown' }] },
      'loc-downtown',
      ['shift-downtown'],
    )).toThrow(/different location/i);
    expect(() => assertBreakGenerationResponseScope(
      { data: [{ shiftId: 'shift-uptown' }] },
      'loc-downtown',
      ['shift-downtown'],
    )).toThrow(/outside the selected location/i);
  });
});

describe('break generation recovery', () => {
  it('reuses one key after an ambiguous POST and skips the charged POST after refresh failure', async () => {
    const requestBody = {
      locationId: 'loc-downtown',
      shiftIds: ['shift-downtown'],
      persist: true,
    };
    let retainedAttempt: BreakGenerationAttempt | null = null;
    const keyFactory = vi.fn(() => 'generation-attempt-1');
    const postGeneration = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        locationId: 'loc-downtown',
        data: [{ shiftId: 'shift-downtown' }],
      });
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(['shift-downtown']);
    const runAttempt = () => executeBreakGenerationWithRecovery({
      requestBody,
      currentAttempt: retainedAttempt,
      retainAttempt: (attempt) => {
        retainedAttempt = attempt;
      },
      postGeneration,
      reconcile,
      keyFactory,
    });

    await expect(runAttempt()).rejects.toThrow('response lost');
    expect(retainedAttempt).toMatchObject({
      key: 'generation-attempt-1',
      postConfirmed: false,
    });

    await expect(runAttempt()).rejects.toThrow('refresh failed');
    expect(retainedAttempt).toMatchObject({
      key: 'generation-attempt-1',
      postConfirmed: true,
    });

    await expect(runAttempt()).resolves.toEqual(['shift-downtown']);

    expect(keyFactory).toHaveBeenCalledTimes(1);
    expect(postGeneration).toHaveBeenCalledTimes(2);
    expect(postGeneration.mock.calls.map(([key]) => key)).toEqual([
      'generation-attempt-1',
      'generation-attempt-1',
    ]);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(retainedAttempt).toBeNull();
  });
});


// These tests evaluate the actual page handlers and board-load effect, not a
// copied selector implementation. React setters queue until flush(), so all
// handler calls in a sequence retain the same render's stale state bindings.
function schedulingSelectionSource() {
  const source = readFileSync(resolve(import.meta.dirname, '../../app/dashboard/scheduling/page.tsx'), 'utf8');
  const file = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ['invalidateLocationData', 'selectScheduleLocation', 'selectScheduleDate', 'selectScheduleViewMode'];
  const declarations = new Map<string, ts.VariableDeclaration[]>();
  const effects: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) {
      const found = declarations.get(node.name.text) ?? [];
      found.push(node);
      declarations.set(node.name.text, found);
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect'
      && node.arguments[0]?.getText(file).includes('void loadSchedule(selectedDate, viewMode, shiftDraft.locationId')) {
      effects.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  const handlerSource = names.map((name) => {
    const found = declarations.get(name) ?? [];
    expect(found).toHaveLength(1);
    return `const ${found[0].getText(file)};`;
  }).join('\n');
  expect(effects).toHaveLength(1);
  const dependencies = effects[0].arguments[1];
  expect(dependencies && ts.isArrayLiteralExpression(dependencies)).toBe(true);
  const effectDependencies = (dependencies as ts.ArrayLiteralExpression).elements.map((item) => item.getText(file));
  function evaluate<T>(text: string, bindings: Record<string, unknown>): T {
    const javascript = ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    return new Function(...Object.keys(bindings), javascript)(...Object.values(bindings)) as T;
  }
  return {
    handlers: (bindings: Record<string, unknown>) => evaluate<{
      selectScheduleLocation: (locationId: string) => void;
      selectScheduleDate: (dateValue: string) => void;
      selectScheduleViewMode: (mode: 'day' | 'threeDay' | 'week') => void;
    }>(`${handlerSource}
return { selectScheduleLocation, selectScheduleDate, selectScheduleViewMode };`, bindings),
    effect: (bindings: Record<string, unknown>) => evaluate<() => void>(
      `return ${effects[0].arguments[0].getText(file)};`, bindings,
    ),
    effectDependencies,
  };
}

function selectionBatch(isLoading = false, initialLocationId = '') {
  const extracted = schedulingSelectionSource();
  const initial = { locationId: initialLocationId || 'loc-downtown', dateValue: '2026-07-09', viewMode: 'threeDay' as const };
  const state = {
    selectedDate: initial.dateValue,
    viewMode: initial.viewMode as 'day' | 'threeDay' | 'week',
    shiftDraft: { locationId: initialLocationId ? '' : initial.locationId },
    revision: 0,
    loadedScope: (initialLocationId ? null : { ...initial, visitGeneration: 9 }) as typeof initial & { visitGeneration: number } | null,
    shifts: ['initial-shift'],
    isLoading,
    solvingScheduleId: 'initial-solve' as string | null,
  };
  const refs = {
    selectedLocationRef: { current: initialLocationId || initial.locationId },
    selectedDateRef: { current: initial.dateValue },
    viewModeRef: { current: initial.viewMode as 'day' | 'threeDay' | 'week' },
    calendarVisitGenerationRef: { current: 9 },
    latestLoadRequestRef: { current: 41 },
    solveGenerationRef: { current: 4 },
  };
  const queued: Array<() => void> = [];
  const setLoadedShiftScope = vi.fn((value: typeof state.loadedScope) => { queued.push(() => { state.loadedScope = value; }); });
  const handlers = extracted.handlers({
    ...refs, useCallback: (callback: unknown) => callback,
    // Frozen render values deliberately differ from later synchronous refs.
    selectedDate: initial.dateValue, viewMode: initial.viewMode,
    shiftDraft: { ...state.shiftDraft }, locations: [{ id: 'loc-downtown' }, { id: 'loc-uptown' }],
    setLoadedShiftScope,
    setShifts: (value: string[]) => { queued.push(() => { state.shifts = value; }); },
    setIsLoading: (value: boolean) => { queued.push(() => { state.isLoading = value; }); },
    setSolvingScheduleId: (value: string | null) => { queued.push(() => { state.solvingScheduleId = value; }); },
    setScopeLoadRevision: (update: (current: number) => number) => { queued.push(() => { state.revision = update(state.revision); }); },
    setShiftDraft: (update: (current: typeof state.shiftDraft) => typeof state.shiftDraft) => { queued.push(() => { state.shiftDraft = update(state.shiftDraft); }); },
    setSelectedDate: (value: string) => { queued.push(() => { state.selectedDate = value; }); },
    setViewMode: (value: typeof state.viewMode) => { queued.push(() => { state.viewMode = value; }); },
    setEditingShiftId: vi.fn(), setConfirmDeleteShiftId: vi.fn(),
  });
  const loadSchedule = vi.fn();
  return {
    ...handlers, state, refs, initial, loadSchedule, setLoadedShiftScope,
    tuple: () => ({
      locationId: refs.selectedLocationRef.current,
      dateValue: refs.selectedDateRef.current,
      viewMode: refs.viewModeRef.current,
    }),
    flush: () => {
      const previousRevision = state.revision;
      queued.splice(0).forEach((commit) => commit());
      // Model the revision dependency's eligibility, not React's scheduler.
      expect(extracted.effectDependencies).toContain('scopeLoadRevision');
      if (state.revision !== previousRevision) extracted.effect({
        isHydrated: true, loadSchedule, selectedDate: state.selectedDate,
        viewMode: state.viewMode, shiftDraft: state.shiftDraft, initialLocationId,
      })();
    },
  };
}

describe('same-render scheduling selection composition', () => {
  it.each([
    ['view', 'date', 'location'], ['view', 'location', 'date'],
    ['date', 'view', 'location'], ['date', 'location', 'view'],
    ['location', 'view', 'date'], ['location', 'date', 'view'],
  ] as const)('preserves all changed coordinates in %s → %s → %s', (...order) => {
    const batch = selectionBatch();
    const change = {
      view: () => batch.selectScheduleViewMode('week'),
      date: () => batch.selectScheduleDate('2026-07-10'),
      location: () => batch.selectScheduleLocation('loc-uptown'),
    };
    order.forEach((coordinate) => change[coordinate]());
    const final = { locationId: 'loc-uptown', dateValue: '2026-07-10', viewMode: 'week' };
    expect(batch.tuple()).toEqual(final);
    expect(batch.state.revision).toBe(0); // No render has committed yet.
    expect(batch.state.viewMode).toBe('threeDay');
    expect(batch.refs.calendarVisitGenerationRef.current).toBe(12);
    expect(batch.refs.latestLoadRequestRef.current).toBe(44);
    expect(batch.refs.solveGenerationRef.current).toBe(7);
    batch.selectScheduleViewMode('week'); // Active latest ref, even in stale render.
    expect(batch.refs.calendarVisitGenerationRef.current).toBe(12);
    expect(batch.setLoadedShiftScope).toHaveBeenCalledTimes(3);
    batch.flush();
    expect(batch.state.revision).toBe(3);
    expect({ locationId: batch.state.shiftDraft.locationId, dateValue: batch.state.selectedDate, viewMode: batch.state.viewMode }).toEqual(final);
    expect(batch.loadSchedule).toHaveBeenCalledExactlyOnceWith(final.dateValue, final.viewMode, final.locationId);
    expect(batch.state.loadedScope).toBeNull();
    expect(batch.state.shifts).toEqual([]);
    expect(batch.state.isLoading).toBe(true);
    expect(batch.state.solvingScheduleId).toBeNull();
    expect(locationShiftVisitIsCurrent({ ...batch.initial, visitGeneration: 9 }, final as typeof batch.initial, 12)).toBe(false);
  });

  it('retains a fresh load revision and rejects the previous visit after mixed-coordinate ABA', () => {
    const batch = selectionBatch();
    batch.selectScheduleViewMode('week');
    batch.selectScheduleDate('2026-07-10');
    batch.selectScheduleLocation('loc-uptown');
    batch.selectScheduleViewMode('threeDay');
    batch.selectScheduleDate('2026-07-09');
    batch.selectScheduleLocation('loc-downtown');
    expect(batch.tuple()).toEqual(batch.initial);
    expect(batch.refs.calendarVisitGenerationRef.current).toBe(15);
    expect(batch.refs.latestLoadRequestRef.current).toBe(47);
    expect(batch.refs.solveGenerationRef.current).toBe(10);
    batch.flush();
    expect(batch.state.revision).toBe(6);
    expect({ locationId: batch.state.shiftDraft.locationId, dateValue: batch.state.selectedDate, viewMode: batch.state.viewMode }).toEqual(batch.initial);
    expect(batch.loadSchedule).toHaveBeenCalledExactlyOnceWith('2026-07-09', 'threeDay', 'loc-downtown');
    expect(locationShiftVisitIsCurrent({ ...batch.initial, visitGeneration: 9 }, batch.initial, 15)).toBe(false);
    expect(locationShiftVisitIsCurrent({ ...batch.initial, visitGeneration: 15 }, batch.initial, 15)).toBe(true);
  });

  it.each([false, true])('leaves an active view unchanged while isLoading=%s', (isLoading) => {
    const batch = selectionBatch(isLoading);
    const loaded = batch.state.loadedScope;
    batch.selectScheduleViewMode('threeDay');
    batch.selectScheduleViewMode('threeDay');
    batch.flush();
    expect(batch.tuple()).toEqual(batch.initial);
    expect(batch.state.loadedScope).toBe(loaded);
    expect(batch.state.shifts).toEqual(['initial-shift']);
    expect(batch.state.isLoading).toBe(isLoading);
    expect(batch.state.solvingScheduleId).toBe('initial-solve');
    expect(batch.state.revision).toBe(0);
    expect(batch.refs.calendarVisitGenerationRef.current).toBe(9);
    expect(batch.refs.latestLoadRequestRef.current).toBe(41);
    expect(batch.refs.solveGenerationRef.current).toBe(4);
    expect(batch.setLoadedShiftScope).not.toHaveBeenCalled();
    expect(batch.loadSchedule).not.toHaveBeenCalled();
  });

  it('preserves the initial linked location ref before its draft location has populated', () => {
    const batch = selectionBatch(true, 'loc-uptown');
    batch.selectScheduleViewMode('week');
    batch.selectScheduleDate('2026-07-10');
    expect(batch.tuple()).toEqual({ locationId: 'loc-uptown', dateValue: '2026-07-10', viewMode: 'week' });
    batch.flush();
    expect(batch.state.shiftDraft.locationId).toBe('');
    expect(batch.state.revision).toBe(2);
    expect(batch.loadSchedule).toHaveBeenCalledExactlyOnceWith('2026-07-10', 'week', 'loc-uptown');
  });
});
