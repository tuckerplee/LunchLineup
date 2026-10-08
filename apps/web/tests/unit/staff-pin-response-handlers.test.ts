import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, clientComponentHarness, deferred, nodes, text } from './client-component-harness';

const m = vi.hoisted(() => ({ hooks: null as any, fetch: vi.fn(), refresh: vi.fn(), noop: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => m.hooks.useState(...args),
  useRef: (...args: any[]) => m.hooks.useRef(...args),
  useEffect: (...args: any[]) => m.hooks.useEffect(...args),
  useMemo: (...args: any[]) => m.hooks.useMemo(...args),
  useCallback: (...args: any[]) => m.hooks.useCallback(...args),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'button' }));
vi.mock('@/lib/client-api', async original => ({ ...await original<typeof import('../../lib/client-api')>(), fetchWithSession: m.fetch }));
vi.mock('../../app/dashboard/staff/use-invitation-delivery', () => ({ useInvitationDelivery: () => ({
  states: {}, retryingUserIds: new Set<string>(), recordResponse: m.noop, refreshStatus: m.noop, refreshStatuses: m.refresh, retry: m.noop,
}) }));
import { StaffWorkspace } from '../../app/dashboard/staff/StaffWorkspace';

// Actual parent handlers and rendered child props, with controlled HTTP and hook ledger.
// Does not qualify credential validity, real React scheduling, database or browser flows.
const staff = ['Alpha', 'Beta'].map((name, i) => ({ id: `employee-${i}`, name, email: '', username: name.toLowerCase(),
  role: 'STAFF', assignedRoles: [], pinEnabled: false, pinResetRequired: false }));
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
let h: ReturnType<typeof clientComponentHarness>;
const render = () => h.render();
const drawer = () => nodes(render()).find(n => n.props.role === 'dialog');
const row = (id: string) => nodes(render()).find(n => n.type === 'tr' && n.key === id)!;
const close = () => nodes(drawer()).find(n => n.props['aria-label'] === 'Close staff management')!.props.onClick();
const open = (id: string) => button(row(id), 'Edit schedule profile').props.onClick({ currentTarget: { isConnected: false } });
async function beginReset() {
  button(row(staff[0].id), 'Reset PIN').props.onClick();
  const confirmation = nodes(render()).find(n => n.props.role === 'alertdialog')!;
  const pending = deferred<Response>(); m.fetch.mockReturnValueOnce(pending.promise);
  button(confirmation, 'Reset PIN').props.onClick();
  expect(drawer()?.props['aria-label']).toBe('Manage Alpha');
  expect(m.fetch.mock.calls[1][0]).toBe('/users/employee-0/pin/reset');
  expect(m.fetch.mock.calls[1][1].method).toBe('POST');
  return pending;
}
async function settle(pending: ReturnType<typeof deferred<Response>>) {
  pending.resolve(response({ temporaryPin: '765432', username: 'alpha-reset' }));
  await h.until(tree => !text(tree).includes('Resetting...'));
  expect(m.fetch).toHaveBeenCalledTimes(2);
  expect(text(row(staff[0].id))).toContain('PIN reset required');
  expect(text(row(staff[1].id))).toContain('PIN not set');
}
beforeEach(async () => {
  m.fetch.mockReset(); m.refresh.mockReset();
  vi.stubGlobal('document', { cookie: '', body: { style: { overflow: '' } } });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  m.fetch.mockResolvedValueOnce(response({ data: staff, summary: { totalUsers: 2, staffCount: 2, managerCount: 0, privilegedUsers: 0, pinAccounts: 0 }, pagination: { hasMore: false, nextCursor: null } }));
  h = clientComponentHarness(() => StaffWorkspace({ currentUserPublicId: 'manager', creationRecoveryScope: 'qa-staff',
    canInvite: false, canAdminister: true, canReadRoles: false, canAssignRoles: false, canManageRoles: false,
    canManageSchedulingProfiles: true, emailInvitationAvailable: false }));
  m.hooks = h.hooks; render(); h.flushEffects();
  await h.until(tree => nodes(tree).some(n => n.type === 'tr' && n.key === staff[1].id));
});
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); });

describe('staff PIN response selection custody', () => {
  it('selects the confirmed recipient immediately and displays its PIN without extra navigation', async () => {
    const pending = await beginReset(); await settle(pending);
    expect(drawer()?.props['aria-label']).toBe('Manage Alpha');
    expect(text(nodes(drawer()).find(n => n.props.role === 'status'))).toContain('765432');
    expect(text(drawer())).toContain('alpha-reset');
  });
  it('does not reopen a closed drawer on late completion, but retains PIN for the original employee', async () => {
    const pending = await beginReset(); close(); expect(drawer()).toBeUndefined();
    await settle(pending); expect(drawer()).toBeUndefined(); expect(text(render())).not.toContain('765432');
    open(staff[0].id); expect(text(drawer())).toContain('765432'); expect(text(drawer())).toContain('alpha-reset');
  });
  it('keeps a different selected employee and never displays the original PIN there', async () => {
    const pending = await beginReset(); close(); open(staff[1].id);
    await settle(pending);
    expect(drawer()?.props['aria-label']).toBe('Manage Beta');
    expect(text(drawer())).not.toContain('765432'); expect(text(drawer())).not.toContain('alpha-reset');
    expect(text(row(staff[1].id))).not.toContain('alpha-reset');
    close(); open(staff[0].id);
    expect(text(drawer())).toContain('765432'); expect(text(drawer())).toContain('alpha-reset');
  });
});
