import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientComponentHarness, deferred, nodes, text } from './client-component-harness';

const m = vi.hoisted(() => ({ hooks: null as any, board: vi.fn(), print: vi.fn(), params: new URLSearchParams() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => m.hooks.useState(...args),
  useRef: (...args: any[]) => m.hooks.useRef(...args),
  useEffect: (...args: any[]) => m.hooks.useEffect(...args),
  useMemo: (...args: any[]) => m.hooks.useMemo(...args),
  useCallback: (...args: any[]) => m.hooks.useCallback(...args),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => m.params }));
vi.mock('@/components/ui/button', () => ({ Button: 'button' }));
vi.mock('@/lib/api-v2', () => ({ apiV2: { getScheduleBoard: m.board } }));
import PrintSchedulePage from '../../app/dashboard/scheduling/print/page';

// Actual page effect/timer cleanup with explicit hook ledger and controlled board.
// Not a browser print dialog/layout or React lifecycle qualification.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const board = (date: string, locationId = A) => ({ data: { selectedLocationId: locationId,
  locations: [{ id: locationId, timezone: 'UTC' }], shifts: [{ id: 'shift-' + date, userId: 'staff',
    user: { id: 'staff', name: 'Selected ' + date, role: 'STAFF' }, role: '1',
    startTime: date + 'T09:00:00.000Z', endTime: date + 'T17:00:00.000Z', breaks: [] }],
} });
let h: ReturnType<typeof clientComponentHarness>;
function effects() { h.render(); h.flushEffects(); }
async function loaded(date = '2026-10-04') {
  await h.until(tree => text(tree).includes('Selected ' + date)); effects();
}
beforeEach(async () => {
  vi.useFakeTimers(); m.board.mockReset(); m.print.mockReset();
  m.params = new URLSearchParams('date=2026-10-04&locationId=' + A + '&autoprint=1');
  vi.stubGlobal('window', { setTimeout, clearTimeout, print: m.print });
  m.board.mockResolvedValueOnce(board('2026-10-04'));
  h = clientComponentHarness(PrintSchedulePage); m.hooks = h.hooks;
  effects(); await loaded();
});
afterEach(() => { h?.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('print page auto-print scope timer', () => {
  it('prints an ordinary stable loaded scope once after 250ms', () => {
    vi.advanceTimersByTime(249); expect(m.print).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(m.print).toHaveBeenCalledTimes(1);
    effects(); vi.advanceTimersByTime(1000); expect(m.print).toHaveBeenCalledTimes(1);
  });
  it('cancels the pending timer on unmount', () => {
    vi.advanceTimersByTime(100); h.unmount();
    vi.advanceTimersByTime(1000); expect(m.print).not.toHaveBeenCalled();
  });
  it.each(['date', 'location'] as const)('cancels stale %s print and allows the newly loaded scope to print once', async scope => {
    vi.advanceTimersByTime(100);
    const pending = deferred<ReturnType<typeof board>>(); m.board.mockReturnValueOnce(pending.promise);
    const date = scope === 'date' ? '2026-10-05' : '2026-10-04';
    if (scope === 'date') {
      nodes(h.render()).find(n => n.type === 'input' && n.props.type === 'date')!.props.onChange({ target: { value: date } });
    } else {
      m.params = new URLSearchParams('date=' + date + '&locationId=' + B + '&autoprint=1');
    }
    effects(); effects();
    vi.advanceTimersByTime(1000); expect(m.print).not.toHaveBeenCalled();
    expect(m.board).toHaveBeenLastCalledWith({ date, view: 'day', locationId: scope === 'date' ? A : B });
    pending.resolve(board(date, scope === 'date' ? A : B)); await loaded(date);
    vi.advanceTimersByTime(249); expect(m.print).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(m.print).toHaveBeenCalledTimes(1);
    effects(); vi.advanceTimersByTime(1000); expect(m.print).toHaveBeenCalledTimes(1);
  });
});
