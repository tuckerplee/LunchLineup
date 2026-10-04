import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientComponentHarness, deferred, nodes } from './client-component-harness';

const mocks = vi.hoisted(() => ({ hooks: null as any, json: vi.fn(), read: vi.fn(), intervals: [] as Array<() => void>, unexpected: [] as string[] }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => mocks.hooks.useState(...args),
  useRef: (...args: any[]) => mocks.hooks.useRef(...args),
  useEffect: (...args: any[]) => mocks.hooks.useEffect(...args),
  useMemo: (...args: any[]) => mocks.hooks.useMemo(...args),
  useCallback: (...args: any[]) => mocks.hooks.useCallback(...args),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('@/lib/client-api', () => ({ fetchJsonWithSession: mocks.json, fetchWithSession: mocks.read }));
vi.mock('@/lib/logout-navigation', () => ({ handleLogoutNavigation: vi.fn() }));
import DashboardLayout from '../../app/dashboard/layout';
import { NotificationsMenu } from '../../app/dashboard/NotificationsMenu';

// Actual layout JSX props/event closures, actual NotificationsMenu identity; controlled transport.
// This hook ledger is not a DOM/React scheduler or native session/database readback.
const me = { user: { publicUserId: '11111111-1111-4111-8111-111111111111', role: 'ADMIN', roleLabel: 'Administrator', workspaceName: 'Controlled workspace', mfaVerified: true, mfaRequired: false, permissions: ['notifications:read', 'notifications:write'], workspaceScope: 'A'.repeat(43), sessionScope: 'B'.repeat(43) } };
const firstId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
const savedAt = '2026-10-04T19:00:00.000Z';
const initialRows = [firstId, secondId].map(id => ({ id, type: 'INFO', title: `Title ${id}`, body: 'Controlled body', readAt: null, createdAt: '2026-10-04T18:00:00.000Z' }));
const feed = (unreadCount = 3, readIds: string[] = []) => ({ data: initialRows.map(row => ({ ...row, readAt: readIds.includes(row.id) ? savedAt : null })), unreadCount });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let h: ReturnType<typeof clientComponentHarness>;
function menu() {
  const found = nodes(h.render()).find(node => node.type === NotificationsMenu);
  if (!found) throw new Error('Missing actual NotificationsMenu props');
  return found.props as any;
}
function poll() { expect(mocks.intervals).toHaveLength(1); mocks.intervals[0](); }
beforeEach(async () => {
  mocks.json.mockReset(); mocks.read.mockReset(); mocks.intervals = []; mocks.unexpected = [];
  vi.stubGlobal('window', { setInterval: (callback: () => void) => { mocks.intervals.push(callback); return 1; }, clearInterval: vi.fn() });
  vi.stubGlobal('document', { cookie: 'csrf_token=controlled-csrf' });
  mocks.json.mockImplementation(async (path: string) => {
    if (path === '/auth/me') return structuredClone(me);
    if (path === '/notifications?status=all&limit=20') return feed();
    mocks.unexpected.push(`GET ${path}`); throw new Error('Unexpected controlled GET');
  });
  mocks.read.mockImplementation(async (path: string, init: RequestInit) => {
    if (init.method !== 'POST' || !['/notifications/read', '/notifications/read-all'].includes(path)) {
      mocks.unexpected.push(`${init.method} ${path}`); throw new Error('Unexpected controlled mutation');
    }
    return response(path.endsWith('read-all') ? { success: true, updated: 2, unreadCount: 0 } : { updated: 1, unreadCount: 2 });
  });
  h = clientComponentHarness(() => DashboardLayout({ children: null })); mocks.hooks = h.hooks;
  h.render(); h.flushEffects(); await h.until(() => menu().unreadCount === 3);
});
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); expect(mocks.unexpected).toEqual([]); });

describe('actual dashboard notification header handlers', () => {
  it('uses the authoritative updated0 count and refreshes saved feed instead of decrementing', async () => {
    mocks.read.mockResolvedValueOnce(response({ updated: 0, unreadCount: 7 }));
    mocks.json.mockResolvedValueOnce(feed(7, [firstId]));
    await menu().onMarkOneAsRead(firstId);
    expect(menu().unreadCount).toBe(7);
    expect(menu().notifications[0].readAt).toBe(savedAt);
  });
  it('keeps confirmed read state when an older poll finishes after the mutation', async () => {
    const old = deferred<unknown>(); mocks.json.mockReturnValueOnce(old.promise); poll();
    mocks.read.mockResolvedValueOnce(response({ updated: 1, unreadCount: 2 }));
    mocks.json.mockResolvedValueOnce(feed(2, [firstId]));
    await menu().onMarkOneAsRead(firstId);
    old.resolve(feed()); await old.promise; await Promise.resolve();
    expect(menu().unreadCount).toBe(2);
    expect(menu().notifications[0].readAt).not.toBeNull();
  });
  it('keeps a newer manual refresh when an older poll finishes afterward', async () => {
    const old = deferred<unknown>(); mocks.json.mockReturnValueOnce(old.promise); poll();
    mocks.json.mockResolvedValueOnce(feed(0, [firstId, secondId]));
    await menu().onRetry();
    old.resolve(feed()); await old.promise; await Promise.resolve();
    expect(menu().unreadCount).toBe(0);
    expect(menu().notifications.every((row: any) => row.readAt !== null)).toBe(true);
  });
  it('confirms an active updated1 mutation and sends the selected ID with CSRF', async () => {
    mocks.json.mockResolvedValueOnce(feed(2, [firstId]));
    await menu().onMarkOneAsRead(firstId);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith('/notifications/read', expect.objectContaining({ method: 'POST', body: JSON.stringify({ ids: [firstId] }) }));
    expect(new Headers(mocks.read.mock.calls[0][1].headers).get('x-csrf-token')).toBe('controlled-csrf');
    expect(menu().unreadCount).toBe(2);
    expect(menu().notifications[0].readAt).not.toBeNull();
    expect(menu().notifications[1].readAt).toBeNull();
    expect(menu().error).toBeNull();
  });
  it('confirms all-read without modifying unrelated header state', async () => {
    mocks.json.mockResolvedValueOnce(feed(0, [firstId, secondId]));
    await menu().onMarkAllAsRead();
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.read.mock.calls[0][0]).toBe('/notifications/read-all');
    expect(menu().unreadCount).toBe(0);
    expect(menu().notifications.every((row: any) => row.readAt !== null)).toBe(true);
    expect(menu().error).toBeNull();
  });
  it('preserves unread state on a failed read response and offers refresh', async () => {
    mocks.read.mockResolvedValueOnce(response({ message: 'controlled refusal' }, 403));
    await menu().onMarkOneAsRead(firstId);
    expect(menu().unreadCount).toBe(3);
    expect(menu().notifications.every((row: any) => row.readAt === null)).toBe(true);
    expect(menu().error).toContain('could not be confirmed');
    expect(menu().busy).toBe(false);
  });
  it('keeps saved timestamps and new arrivals from authoritative readback', async () => {
    mocks.read.mockResolvedValueOnce(response({ success: true, updated: 2, unreadCount: 0 }));
    const arrived = { ...initialRows[0], id: '44444444-4444-4444-8444-444444444444', title: 'Later arrival' };
    mocks.json.mockResolvedValueOnce({ data: [...feed(0, [firstId, secondId]).data, arrived], unreadCount: 1 });
    await menu().onMarkAllAsRead();
    expect(menu().unreadCount).toBe(1);
    expect(menu().notifications.slice(0, 2).every((row: any) => row.readAt === savedAt)).toBe(true);
    expect(menu().notifications[2].readAt).toBeNull();
  });
  it('keeps confirmed mutation counts when saved-feed readback fails, then repairs through retry', async () => {
    mocks.json.mockRejectedValueOnce(new Error('controlled readback outage'));
    await menu().onMarkOneAsRead(firstId);
    expect(menu().unreadCount).toBe(2);
    expect(menu().notifications[0].readAt).toBeNull();
    expect(menu().error).toContain('was saved');
    expect(menu().error).not.toContain('update could not be confirmed');
    expect(menu().busy).toBe(false);
    mocks.json.mockResolvedValueOnce(feed(2, [firstId])); await menu().onRetry();
    expect(menu().notifications[0].readAt).toBe(savedAt);
    expect(menu().error).toBeNull();
    expect(mocks.read).toHaveBeenCalledOnce();
  });
  it('acknowledges updated0 confirmation without claiming a new write when readback fails', async () => {
    mocks.read.mockResolvedValueOnce(response({ updated: 0, unreadCount: 7 }));
    mocks.json.mockRejectedValueOnce(new Error('controlled readback outage'));
    await menu().onMarkOneAsRead(firstId);
    expect(menu().unreadCount).toBe(7); expect(menu().notifications[0].readAt).toBeNull();
    expect(menu().error).toContain('was confirmed'); expect(menu().error).not.toContain('was saved');
    expect(menu().busy).toBe(false);
  });
  it('keeps manual readback when a delayed initial feed finishes afterward', async () => {
    h.unmount();
    const initial = deferred<unknown>(); const entered = deferred<void>();
    mocks.json.mockResolvedValueOnce(structuredClone(me));
    mocks.json.mockImplementationOnce(() => { entered.resolve(); return initial.promise; });
    h = clientComponentHarness(() => DashboardLayout({ children: null })); mocks.hooks = h.hooks;
    h.render(); h.flushEffects(); await entered.promise;
    mocks.json.mockResolvedValueOnce(feed(5, [firstId])); await menu().onRetry();
    initial.resolve(feed()); await initial.promise; await Promise.resolve();
    expect(menu().unreadCount).toBe(5); expect(menu().notifications[0].readAt).toBe(savedAt);
    expect(menu().error).toBeNull();
  });
  it('blocks duplicate stale-handler clicks and refreshes during mutation and readback', async () => {
    const posted = deferred<Response>(); const readback = deferred<unknown>(); const entered = deferred<void>();
    mocks.read.mockReturnValueOnce(posted.promise);
    const callbacks = menu(); const beforeReads = mocks.json.mock.calls.length;
    const first = callbacks.onMarkOneAsRead(firstId);
    await callbacks.onMarkOneAsRead(firstId); await callbacks.onMarkAllAsRead(); await callbacks.onRetry(); poll();
    expect(mocks.read).toHaveBeenCalledOnce(); expect(mocks.json).toHaveBeenCalledTimes(beforeReads);
    mocks.json.mockImplementationOnce(() => { entered.resolve(); return readback.promise; });
    posted.resolve(response({ updated: 1, unreadCount: 2 })); await entered.promise;
    try {
      await menu().onRetry(); poll(); await menu().onMarkAllAsRead();
      expect(mocks.json).toHaveBeenCalledTimes(beforeReads + 1);
      expect(menu().busy).toBe(true);
    } finally { readback.resolve(feed(2, [firstId])); await first; }
    expect(menu().busy).toBe(false); expect(menu().notifications[0].readAt).toBe(savedAt);
  });
  it('allows one active poll and supersedes it with a manual retry independently of abort', async () => {
    const old = deferred<unknown>(); mocks.json.mockReturnValueOnce(old.promise);
    const beforeReads = mocks.json.mock.calls.length; poll(); poll();
    expect(mocks.json).toHaveBeenCalledTimes(beforeReads + 1);
    const signal = mocks.json.mock.calls.at(-1)![1]?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    mocks.json.mockResolvedValueOnce(feed(1, [firstId])); await menu().onRetry();
    expect(signal.aborted).toBe(true);
    old.resolve(feed(9)); await old.promise; await Promise.resolve();
    expect(menu().unreadCount).toBe(1);
  });
  it('ignores an old poll rejection after a newer successful manual retry', async () => {
    const old = deferred<unknown>(); mocks.json.mockReturnValueOnce(old.promise); poll();
    mocks.json.mockResolvedValueOnce(feed(1, [firstId])); await menu().onRetry();
    old.reject(new Error('controlled stale failure')); await old.promise.catch(() => undefined); await Promise.resolve();
    expect(menu().unreadCount).toBe(1); expect(menu().error).toBeNull();
  });
  it('refuses completed mutation installation and stale handler writes after unmount', async () => {
    const posted = deferred<Response>(); mocks.read.mockReturnValueOnce(posted.promise);
    const callbacks = menu(); const pending = callbacks.onMarkOneAsRead(firstId);
    const beforeReads = mocks.json.mock.calls.length;
    h.unmount();
    const signal = mocks.read.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    posted.resolve(response({ updated: 1, unreadCount: 2 })); await pending;
    await callbacks.onMarkAllAsRead(); await callbacks.onRetry();
    expect(mocks.read).toHaveBeenCalledOnce(); expect(mocks.json).toHaveBeenCalledTimes(beforeReads);
    expect(menu().unreadCount).toBe(3); expect(menu().notifications[0].readAt).toBeNull();
  });
  it('refuses an old scope completion after remounting a different session header', async () => {
    const old = deferred<unknown>(); mocks.json.mockReturnValueOnce(old.promise); poll();
    const callbacks = menu(); h.unmount();
    const otherMe = { user: { ...me.user, publicUserId: '55555555-5555-4555-8555-555555555555', workspaceScope: 'C'.repeat(43), sessionScope: 'D'.repeat(43) } };
    mocks.json.mockImplementation(async (path: string) => path === '/auth/me' ? otherMe : feed(8));
    h = clientComponentHarness(() => DashboardLayout({ children: null })); mocks.hooks = h.hooks;
    h.render(); h.flushEffects(); await h.until(() => menu().unreadCount === 8);
    old.resolve(feed(99)); await old.promise; await Promise.resolve();
    await callbacks.onMarkOneAsRead(firstId); await callbacks.onRetry();
    expect(menu().unreadCount).toBe(8); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([null, [], 'wrong', { updated: -1, unreadCount: 2 }, { updated: 2, unreadCount: 2 }, { updated: 1, unreadCount: -1 }, { updated: 1, unreadCount: 1.5 }, { updated: '1', unreadCount: 2 }])(
    'refuses malformed successful single-read response %# without inventing read markers', async payload => {
      mocks.read.mockResolvedValueOnce(response(payload)); await menu().onMarkOneAsRead(firstId);
      expect(menu().unreadCount).toBe(3); expect(menu().notifications[0].readAt).toBeNull();
      expect(menu().error).toContain('could not be confirmed'); expect(menu().busy).toBe(false);
    });
  it.each([{ updated: 2, unreadCount: 0 }, { success: false, updated: 2, unreadCount: 0 }, { success: true, updated: 2, unreadCount: 1 }])(
    'refuses a malformed all-read response %# without claiming all saved', async payload => {
      mocks.read.mockResolvedValueOnce(response(payload)); await menu().onMarkAllAsRead();
      expect(menu().unreadCount).toBe(3); expect(menu().notifications.every((row: any) => row.readAt === null)).toBe(true);
      expect(menu().error).toContain('could not be confirmed');
    });
  it.each([null, { data: [], unreadCount: -1 }, { data: [{ ...initialRows[0], readAt: 'not-an-instant' }], unreadCount: 1 }, { data: [initialRows[0], initialRows[0]], unreadCount: 1 }])(
    'keeps prior feed on malformed refreshed data %# rather than displaying empty success', async payload => {
      mocks.json.mockResolvedValueOnce(payload); await menu().onRetry();
      expect(menu().unreadCount).toBe(3); expect(menu().notifications).toEqual(initialRows);
      expect(menu().error).toContain('could not be refreshed'); expect(menu().busy).toBe(false);
    });
});
