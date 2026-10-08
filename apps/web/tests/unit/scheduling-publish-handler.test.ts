import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, clientComponentHarness, deferred, nodes, text } from './client-component-harness';

const mocks = vi.hoisted(() => ({ hooks: null as any, board: vi.fn(), preflight: vi.fn(), publish: vi.fn(), refs: [] as any[] }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => mocks.hooks.useState(...args),
  useRef: (...args: any[]) => { const ref = mocks.hooks.useRef(...args); if (!mocks.refs.includes(ref)) mocks.refs.push(ref); return ref; },
  useEffect: (...args: any[]) => mocks.hooks.useEffect(...args),
  useMemo: (...args: any[]) => mocks.hooks.useMemo(...args),
  useCallback: (...args: any[]) => mocks.hooks.useCallback(...args),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('date=2026-10-04&location=11111111-1111-4111-8111-111111111111') }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/ui/button', () => ({ Button: 'button' }));
vi.mock('@/lib/api-v2', () => ({ apiV2: { getScheduleBoard: mocks.board, getSchedulePublishPlan: mocks.preflight, publishSchedule: mocks.publish } }));
vi.mock('../../app/dashboard/scheduling/use-schedule-commands', () => ({ useScheduleCommands: () => ({ commandState: { byShiftId: {} }, updateShift: vi.fn(), copyShift: vi.fn(), deleteShift: vi.fn(), undoShift: vi.fn(), dismissFeedback: vi.fn() }) }));
import SchedulingPage from '../../app/dashboard/scheduling/page';

// Actual page handlers and actual publish-attempt/parsers; controlled transport only.
// The hook ledger does not model browser/React scheduling, server commits or debit effects.
const locationId = '11111111-1111-4111-8111-111111111111';
const contractA = { version: 3, totalConfiguredCost: 2, scheduleCost: 2, matchingWebhookDeliveryCount: 0, matchingWebhookDeliveryUnitCost: 0, matchingWebhookDeliveryCost: 0 };
const contractB = { ...contractA, version: 4, totalConfiguredCost: 5, scheduleCost: 5 };
const preflight = (id: string, contract = id === 'schedule-a' ? contractA : contractB) => ({ scheduleId: id, ...contract, acceptedContract: { ...contract }, availableCredits: 20, sufficientCredits: true });
const published = (id: string, contract = id === 'schedule-a' ? contractA : contractB) => ({ id, status: 'PUBLISHED', publishedAt: '2026-10-04T18:00:00.000Z', settlement: { ...contract, acceptedContract: { ...contract }, creditsConsumed: contract.totalConfiguredCost, newBalance: 20 - contract.totalConfiguredCost, ledgerIdentities: { schedule: `ledger-${id}`, webhookDeliveries: [] } }, notifications: { status: 'NOT_REQUIRED', delivered: 0, pending: 0, failed: 0 } });
const schedules = ['schedule-a', 'schedule-b'].map((id, i) => ({ id, locationId, status: 'DRAFT', version: i + 3, startDate: `2026-10-0${i + 4}T00:00:00.000Z`, endDate: `2026-10-0${i + 5}T00:00:00.000Z` }));
let h: ReturnType<typeof clientComponentHarness>;
function row(id: string, tree = h.render()) {
  const found = nodes(tree).find(node => node.key === id && String(node.props.className).startsWith('scheduler-publish-row '));
  if (!found) throw new Error(`Missing actual schedule row ${id}`);
  return found;
}
function publishButton(id: string, label: string) { return button(row(id), label); }
function idle(tree: unknown) { return !nodes(tree).some(node => node.type === 'button' && text(node.props.children).trim() === 'Checking...'); }
async function click(id: string, label: string) { publishButton(id, label).props.onClick(); await h.until(idle); }
async function review(id: string) { await click(id, 'Publish'); expect(text(row(id))).toContain(`Confirm - ${id === 'schedule-a' ? 2 : 5} credits`); }
async function uncertainA() {
  await review('schedule-a'); mocks.publish.mockRejectedValueOnce(new Error('controlled lost response'));
  await click('schedule-a', 'Confirm - 2 credits');
  expect(mocks.publish).toHaveBeenCalledTimes(1);
  expect(text(row('schedule-a'))).toContain('Retry publish');
  return structuredClone(mocks.publish.mock.calls[0]);
}
beforeEach(async () => {
  mocks.board.mockReset(); mocks.preflight.mockReset(); mocks.publish.mockReset(); mocks.refs = [];
  vi.stubGlobal('window', { sessionStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, setTimeout });
  mocks.board.mockResolvedValue({ data: { permissions: ['schedules:read', 'shifts:read', 'locations:read', 'schedules:publish'], selectedLocationId: locationId, locations: [{ id: locationId, name: 'Controlled location', timezone: 'UTC' }], staff: [], schedules: structuredClone(schedules), shifts: schedules.map(schedule => ({ id: `shift-${schedule.id}`, scheduleId: schedule.id, locationId, userId: null, role: 'STAFF', startTime: schedule.startDate, endTime: schedule.startDate.replace('T00:', 'T04:'), breaks: [] })) } });
  mocks.preflight.mockImplementation(async (id: string) => preflight(id));
  h = clientComponentHarness(SchedulingPage); mocks.hooks = h.hooks;
  h.render(); h.flushEffects();
  await h.until(tree => nodes(tree).some(node => node.key === 'schedule-b'));
  h.render(); h.flushEffects(); await h.until(tree => text(tree).includes('loaded from saved schedules'));
});
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); });

describe('actual scheduling page publication replay', () => {
  it('announces loading politely and exposes exactly one pressed calendar view', async () => {
    const savedBoard = await mocks.board.mock.results.at(-1)!.value;
    const pending = deferred<typeof savedBoard>();
    const callsBefore = mocks.board.mock.calls.length;
    mocks.board.mockReturnValue(pending.promise);
    const views = () => nodes(h.render()).find(node => node.props['aria-label'] === 'Scheduler view')!;
    expect(nodes(views()).filter(node => node.type === 'button' && node.props['aria-pressed']).map(node => text(node.props.children).trim())).toEqual(['3-Day']);
    button(views(), 'Day').props.onClick();
    expect(nodes(views()).filter(node => node.type === 'button' && node.props['aria-pressed']).map(node => text(node.props.children).trim())).toEqual(['Day']);
    // The existing hook ledger runs effects explicitly. Hold the actual board
    // request open rather than asserting loading against the previous ready state.
    h.render(); h.flushEffects();
    try {
      expect(mocks.board.mock.calls.length).toBeGreaterThan(callsBefore);
      const status = nodes(h.render()).find(node => String(node.props.className).startsWith('scheduler-status-pill '))!;
      expect(status.props.role).toBe('status'); expect(status.props['aria-live']).toBe('polite');
      expect(text(status)).toContain('Loading saved schedule data');
    } finally {
      pending.resolve(savedBoard);
      await h.until(tree => text(tree).includes('loaded from saved schedules'));
    }
    const settled = nodes(h.render()).find(node => String(node.props.className).startsWith('scheduler-status-pill '))!;
    expect(settled.props.role).toBe('status'); expect(settled.props['aria-live']).toBe('polite');
    expect(text(settled)).not.toContain('Loading saved schedule data');
  });
  it('announces a failed board reload with the actual error alert', async () => {
    mocks.board.mockRejectedValueOnce(new Error('Controlled board unavailable'));
    button(h.render(), 'Reload').props.onClick();
    await h.until(tree => nodes(tree).some(node => node.props.role === 'alert' && text(node).includes('Controlled board unavailable')));
    expect(nodes(h.render()).find(node => node.props.role === 'alert')?.props.className).toBe('scheduler-error');
  });

  it.each([
    ['wrong version', { ...contractA, version: contractA.version + 1 }],
    ['changed configured cost', { ...contractA, totalConfiguredCost: 7, scheduleCost: 7 }],
  ])('retains original custody after an internally valid %s success response', async (_label, wrongContract) => {
    await review('schedule-a');
    mocks.publish.mockResolvedValueOnce(published('schedule-a', wrongContract));
    await click('schedule-a', 'Confirm - 2 credits');
    const original = structuredClone(mocks.publish.mock.calls[0]);
    expect(text(row('schedule-a'))).toContain('DRAFT');
    expect(text(row('schedule-a'))).toContain('Retry publish');
    expect(text(row('schedule-a'))).not.toContain('credits were debited exactly once');
    const custody = mocks.refs.find(ref => ref.current?.['schedule-a']?.key === original[2]);
    expect(custody).toBeDefined();
    expect(custody.current['schedule-a'].payload.body).toEqual({ acceptedContract: contractA });
    await review('schedule-b');
    mocks.publish.mockResolvedValueOnce(published('schedule-b'));
    await click('schedule-b', 'Confirm - 5 credits');
    expect(text(row('schedule-b'))).toContain('PUBLISHED');
    mocks.publish.mockResolvedValueOnce(published('schedule-a'));
    await click('schedule-a', 'Retry publish');
    expect(mocks.publish.mock.calls[2]).toEqual(original);
    expect(mocks.publish).toHaveBeenCalledTimes(3);
    expect(text(row('schedule-a'))).toContain('PUBLISHED');
    expect(text(row('schedule-a'))).not.toContain('Retry publish');
    expect(custody.current['schedule-a']).toBeUndefined();
  });

  it('replays A exact original body and key after reviewing a different B contract', async () => {
    const original = await uncertainA(); await review('schedule-b');
    mocks.publish.mockResolvedValueOnce(published('schedule-a'));
    await click('schedule-a', 'Retry publish');
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.publish.mock.calls[1]).toEqual(original);
    expect(mocks.preflight.mock.calls.filter(([id]) => id === 'schedule-a')).toHaveLength(2);
    expect(text(row('schedule-a'))).toContain('PUBLISHED');
  });
  it('replays A exact original body and key after successful B clears the shared review', async () => {
    const original = await uncertainA(); await review('schedule-b');
    mocks.publish.mockResolvedValueOnce(published('schedule-b'));
    await click('schedule-b', 'Confirm - 5 credits');
    expect(text(row('schedule-b'))).toContain('PUBLISHED');
    mocks.publish.mockResolvedValueOnce(published('schedule-a'));
    await click('schedule-a', 'Retry publish');
    expect(mocks.publish).toHaveBeenCalledTimes(3);
    expect(mocks.publish.mock.calls[2]).toEqual(original);
    expect(text(row('schedule-a'))).toContain('PUBLISHED');
    expect(text(h.render())).not.toContain('No publish request was sent or settled');
  });
  it('replays the original request without a new preflight when no other schedule is reviewed', async () => {
    const original = await uncertainA(); mocks.publish.mockResolvedValueOnce(published('schedule-a'));
    await click('schedule-a', 'Retry publish');
    expect(mocks.publish.mock.calls[1]).toEqual(original);
    expect(mocks.preflight).toHaveBeenCalledTimes(2);
  });
  it('requires review and fresh confirmation before sending the first request', async () => {
    await review('schedule-a'); expect(mocks.publish).not.toHaveBeenCalled();
    const response = deferred<unknown>(); mocks.publish.mockReturnValueOnce(response.promise);
    publishButton('schedule-a', 'Confirm - 2 credits').props.onClick();
    await h.until(tree => text(tree).includes('Checking...'));
    expect(text(row('schedule-a'))).toContain('DRAFT');
    response.resolve(published('schedule-a')); await h.until(idle);
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith('schedule-a', { acceptedContract: contractA }, expect.any(String));
    expect(text(row('schedule-a'))).toContain('PUBLISHED');
  });
  it.each(['missing', 'foreign schedule', 'mutable record', 'invalid contract', 'mismatched fingerprint'])(
    'refuses a %s saved request without a new POST or a settled-outcome claim', async damage => {
      const original = await uncertainA(); await review('schedule-b');
      // Fault injection selects the actual per-schedule ref by the issued key, never by hook ordinal.
      const ref = mocks.refs.find(ref => ref.current?.['schedule-a']?.key === original[2]);
      expect(ref).toBeDefined();
      const saved = ref.current['schedule-a'];
      if (damage === 'missing') delete ref.current['schedule-a'];
      else if (damage === 'foreign schedule') ref.current['schedule-a'] = Object.freeze({ ...saved, payload: Object.freeze({ ...saved.payload, scheduleId: 'schedule-b' }) });
      else if (damage === 'mutable record') ref.current['schedule-a'] = { ...saved };
      else if (damage === 'invalid contract') ref.current['schedule-a'] = Object.freeze({ ...saved, payload: Object.freeze({ ...saved.payload, body: Object.freeze({ acceptedContract: Object.freeze({ ...contractA, version: -1 }) }) }) });
      else ref.current['schedule-a'] = Object.freeze({ ...saved, payloadFingerprint: 'corrupt' });
      await click('schedule-a', 'Retry publish');
      expect(mocks.publish).toHaveBeenCalledTimes(1);
      expect(mocks.preflight.mock.calls.filter(([id]) => id === 'schedule-a')).toHaveLength(2);
      expect(text(row('schedule-a'))).toContain('Retry publish');
      expect(text(row('schedule-a'))).toContain('DRAFT');
      expect(text(h.render())).toContain('original publish outcome remains unconfirmed');
      expect(text(h.render())).not.toContain('No publish request was sent or settled');
    });
  it('requires reconfirmation when fresh preflight costs change before the first POST', async () => {
    await review('schedule-a');
    mocks.preflight.mockResolvedValueOnce(preflight('schedule-a', contractB));
    await click('schedule-a', 'Confirm - 2 credits');
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(text(row('schedule-a'))).toContain('Confirm - 5 credits');
    mocks.preflight.mockResolvedValueOnce(preflight('schedule-a', contractB));
    mocks.publish.mockResolvedValueOnce(published('schedule-a', contractB));
    await click('schedule-a', 'Confirm - 5 credits');
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith('schedule-a', { acceptedContract: contractB }, expect.any(String));
  });
  it('preserves the pending original request through repeated lost responses', async () => {
    const original = await uncertainA(); await review('schedule-b');
    mocks.publish.mockRejectedValueOnce(new Error('second controlled lost response'));
    await click('schedule-a', 'Retry publish');
    expect(text(row('schedule-a'))).toContain('Retry publish');
    mocks.publish.mockResolvedValueOnce(published('schedule-a'));
    await click('schedule-a', 'Retry publish');
    expect(mocks.publish.mock.calls[1]).toEqual(original);
    expect(mocks.publish.mock.calls[2]).toEqual(original);
  });
  it('keeps single-flight protection while a confirmed publish response is unresolved', async () => {
    await review('schedule-a'); const response = deferred<unknown>(); const entered = deferred<void>();
    mocks.publish.mockImplementationOnce(() => { entered.resolve(); return response.promise; });
    const confirm = publishButton('schedule-a', 'Confirm - 2 credits');
    confirm.props.onClick(); await entered.promise;
    try {
      confirm.props.onClick();
      expect(mocks.publish).toHaveBeenCalledTimes(1);
    } finally {
      response.resolve(published('schedule-a')); await h.until(idle);
    }
    expect(text(row('schedule-a'))).toContain('PUBLISHED');
  });

});
