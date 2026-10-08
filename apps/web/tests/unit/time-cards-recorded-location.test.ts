import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, changeEvent, clientComponentHarness, deferred, nodes, text } from './client-component-harness';
const mocks = vi.hoisted(() => ({ hooks: null as any, snapshot: vi.fn(), locations: vi.fn(), staff: vi.fn(), clockOut: vi.fn(), clockIn: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => mocks.hooks.useState(...args), useRef: (...args: any[]) => mocks.hooks.useRef(...args),
  useEffect: (...args: any[]) => mocks.hooks.useEffect(...args), useMemo: (...args: any[]) => mocks.hooks.useMemo(...args),
  useCallback: (...args: any[]) => mocks.hooks.useCallback(...args),
}));
vi.mock('../../app/dashboard/time-cards/time-card-api', async original => ({
  ...await original<typeof import('../../app/dashboard/time-cards/time-card-api')>(),
  fetchStaffRoster: mocks.staff, fetchLocationPage: mocks.locations, fetchTimeCardSnapshot: mocks.snapshot,
  clockOutTimeCard: mocks.clockOut, clockInTimeCard: mocks.clockIn,
}));
import { TimeCardsWorkspace } from '../../app/dashboard/time-cards/TimeCardsWorkspace';

// Real component handlers with controlled transport and an explicit hook ledger;
// no native HTTP/database, DOM, React scheduling or browser acceptance claimed.
const live = { id: 'live', name: 'Live location' };
const recorded = { id: 'historical', name: 'Recorded location', timezone: 'UTC' };
const active = { id: 'card-A', userId: 'A', locationId: recorded.id, location: recorded,
  status: 'OPEN', clockInAt: '2026-10-08T09:00:00.000Z', clockOutAt: null,
  breakMinutes: 0, grossMinutes: 0, workedMinutes: 0, updatedAt: '2026-10-08T09:00:00.000Z', displayTimeZone: 'UTC' };
let h: ReturnType<typeof clientComponentHarness>;
let closed: boolean;
function snapshot(userId: string) { return { activeCard: userId === 'A' && !closed ? active : null,
  historyResponse: { ok: true, json: async () => ({ data: [], pagination: { nextCursor: null } }) } }; }
function render() { mocks.hooks = h.hooks; return h.render(); }
function select(label: string) {
  const group = nodes(render()).find(node => node.type === 'label' && text(node.props.children).trim().startsWith(label));
  const found = group && nodes(group.props.children).find(node => node.type === 'select');
  if (!found) throw new Error(`Missing actual select: ${label}`);
  return found;
}
function options() { return nodes(select('Team location')).filter(node => node.type === 'option').map(node => node.props.value); }
function clockButton(kind: 'in' | 'out') {
  const found = nodes(render()).find(node => node.type === 'button' && (text(node).trim().startsWith(`Clock ${kind}`) || (kind === 'in' && text(node).trim().startsWith('Select a location for '))));
  if (!found) throw new Error(`Missing clock ${kind} button`);
  return found;
}
async function mountTeam() {
  h = clientComponentHarness(() => createElement(TimeCardsWorkspace, {
    canManageTeam: true, canReadLocations: true, canWriteTimeCards: true, currentUserId: 'manager',
  }));
  render(); h.flushEffects();
  await h.until(tree => text(tree).includes('Not clocked in') && nodes(tree).some(node => node.type === 'option' && node.props.value === 'live'));
  button(render(), 'Team Time').props.onClick(); render(); h.flushEffects();
  select('Team member').props.onChange(changeEvent('A')); render(); h.flushEffects();
  await h.until(tree => text(tree).includes('Clocked in at'));
}
beforeEach(() => {
  closed = false; mocks.clockIn.mockReset(); mocks.clockOut.mockReset();
  mocks.locations.mockReset().mockResolvedValue({ data: [live], pagination: { hasMore: false, nextCursor: null } });
  mocks.staff.mockReset().mockResolvedValue([{ id: 'A', name: 'Alice', role: 'STAFF' }, { id: 'B', name: 'Bob', role: 'STAFF' }]);
  mocks.snapshot.mockReset().mockImplementation(async (id: string) => snapshot(id));
  mocks.clockOut.mockImplementation(async () => { closed = true; return { ...active, status: 'CLOSED' }; });
});
afterEach(() => h?.unmount());

describe('actual time-card recorded-location recovery selection', () => {
  it.each(['removed', 'not-yet-loaded'] as const)('offers the %s recorded location for explicit clock-out, never automatic selection', async mode => {
    if (mode === 'not-yet-loaded') mocks.locations.mockResolvedValue({ data: [live], pagination: { hasMore: true, nextCursor: 'next-page' } });
    await mountTeam();
    expect(options()).toEqual(['', 'live', 'historical']);
    expect(select('Team location').props.value).toBe(''); expect(clockButton('out').props.disabled).toBe(true);
    select('Team location').props.onChange(changeEvent('historical'));
    expect(clockButton('out').props.disabled).toBe(false);
    clockButton('out').props.onClick();
    await h.until(tree => text(tree).includes('Not clocked in') && !text(tree).includes('Clocking '));
    expect(mocks.clockOut).toHaveBeenCalledExactlyOnceWith('card-A', { breakMinutes: 30, notes: undefined });
    expect(mocks.clockIn).not.toHaveBeenCalled();
  });
  it('deduplicates the recorded location when it is already available in the live list', async () => {
    mocks.locations.mockResolvedValue({ data: [live, recorded], pagination: { hasMore: false } });
    await mountTeam(); expect(options().filter(id => id === 'historical')).toHaveLength(1);
    expect(select('Team location').props.value).toBe('');
  });
  it('removes Alice fallback immediately when switching employee, including while Bob readback waits', async () => {
    await mountTeam(); select('Team location').props.onChange(changeEvent('historical'));
    const gate = deferred<ReturnType<typeof snapshot>>();
    mocks.snapshot.mockImplementation((id: string) => id === 'B' ? gate.promise : Promise.resolve(snapshot(id)));
    select('Team member').props.onChange(changeEvent('B')); render(); h.flushEffects();
    expect(options()).not.toContain('historical'); expect(select('Team location').props.value).toBe('');
    gate.resolve(snapshot('B')); await h.until(tree => text(tree).includes('Not clocked in'));
    expect(options()).not.toContain('historical'); expect(mocks.clockOut).not.toHaveBeenCalled();
  });
  it('after recovery closure refuses a new clock-in at the stale historical selection even if its handler is invoked', async () => {
    await mountTeam(); select('Team location').props.onChange(changeEvent('historical'));
    clockButton('out').props.onClick();
    await h.until(tree => text(tree).includes('Not clocked in') && !text(tree).includes('Clocking '));
    expect(options()).not.toContain('historical'); expect(select('Team location').props.value).toBe('historical');
    expect(clockButton('in').props.disabled).toBe(true);
    clockButton('in').props.onClick();
    expect(mocks.clockIn).not.toHaveBeenCalled(); expect(mocks.clockOut).toHaveBeenCalledTimes(1);
    select('Team location').props.onChange(changeEvent('live'));
    expect(clockButton('in').props.disabled).toBe(false);
  });
});
