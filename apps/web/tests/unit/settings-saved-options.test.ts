import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, changeEvent, clientComponentHarness, nodes, text } from './client-component-harness';
const mocks = vi.hoisted(() => ({ hooks: null as any, read: vi.fn(), write: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => mocks.hooks.useState(...args), useRef: (...args: any[]) => mocks.hooks.useRef(...args),
  useMemo: (...args: any[]) => mocks.hooks.useMemo(...args), useEffect: (...args: any[]) => mocks.hooks.useEffect(...args),
  useCallback: (...args: any[]) => mocks.hooks.useCallback(...args),
}));
vi.mock('@/lib/client-api', async original => ({ ...await original<typeof import('@/lib/client-api')>(), fetchJsonWithSession: mocks.read, fetchWithSession: mocks.write }));
vi.mock('../../app/dashboard/settings/use-billing-settings', () => ({ useBillingSettings: () => ({ loadBilling: () => {}, billingReturnDetected: false }) }));
import { SettingsWorkspace } from '../../app/dashboard/settings/SettingsWorkspace';
let h: ReturnType<typeof clientComponentHarness>;
let saved: any;
function render() { mocks.hooks = h.hooks; return h.render(); }
function select(label: string) {
  const group = nodes(render()).find(node => node.type === 'label' && text(node.props.children).trim().startsWith(label));
  const found = group && nodes(group).find(node => node.type === 'select');
  if (!found) throw new Error(`Missing actual settings select: ${label}`); return found;
}
function matchingOptions(label: string, value: string) {
  return nodes(select(label)).filter(node => node.type === 'option' && String(node.props.value) === value);
}
async function mount(timeout = 480, writable = true) {
  saved.security.sessionTimeoutMinutes = timeout;
  h = clientComponentHarness(() => createElement(SettingsWorkspace, { canWriteSettings: writable,
    canReadBilling: false, canManageBilling: false, canExportAccount: false, canManageAccountLifecycle: false }));
  render(); h.flushEffects();
  await h.until(tree => text(tree).includes('Example workspace') && !text(tree).includes('Loading live settings'));
}
beforeEach(() => {
  saved = { general: { organizationName: 'Example workspace', slug: 'example', timezone: 'Europe/London' },
    security: { requireMfaForAll: false, sessionTimeoutMinutes: 480, ssoOidcOnly: false },
    team: { defaultRole: 'STAFF', shiftApprovalPolicy: 'MANAGER_APPROVAL' } };
  mocks.read.mockReset().mockImplementation(async () => structuredClone(saved));
  mocks.write.mockReset().mockImplementation(async (path: string, init: RequestInit) => {
    const section = path.split('/').at(-1)!; saved[section] = JSON.parse(String(init.body));
    return new Response(JSON.stringify(saved), { status: 200 });
  });
  vi.stubGlobal('document', { cookie: 'csrf_token=synthetic-settings' });
});
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); });
// Actual component and save reconciliation; fake HTTP, no DOM/native readback.
describe('settings saved option fidelity and failure custody', () => {
  it.each([5, 37, 480, 1440])('represents saved Europe/London and %i-minute timeout with exactly matching options', async timeout => {
    await mount(timeout);
    expect(select('Timezone').props.value).toBe('Europe/London'); expect(matchingOptions('Timezone', 'Europe/London')).toHaveLength(1);
    button(render(), 'Security').props.onClick();
    expect(select('Session timeout').props.value).toBe(String(timeout)); expect(matchingOptions('Session timeout', String(timeout))).toHaveLength(1);
    button(render(), 'Save Changes').props.onClick();
    await h.until(tree => text(tree).includes('Security settings saved.'));
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('/settings/security', expect.objectContaining({ body: JSON.stringify({ requireMfaForAll: false, sessionTimeoutMinutes: timeout, ssoOidcOnly: false }) }));
  });
  it('preserves nonpreset timezone on unchanged save and selects a changed preset without duplicate fallback', async () => {
    await mount(); button(render(), 'Save Changes').props.onClick();
    await h.until(tree => text(tree).includes('General settings saved.'));
    expect(JSON.parse(mocks.write.mock.calls[0][1].body).timezone).toBe('Europe/London');
    select('Timezone').props.onChange(changeEvent('America/Chicago'));
    expect(select('Timezone').props.value).toBe('America/Chicago'); expect(matchingOptions('Timezone', 'America/Chicago')).toHaveLength(1);
    button(render(), 'Save Changes').props.onClick();
    await h.until(tree => text(tree).includes('General settings saved.') && !text(tree).includes('Saving...'));
    expect(JSON.parse(mocks.write.mock.calls[1][1].body).timezone).toBe('America/Chicago');
  });
  it('retains the selected nonpreset timeout on explicit rejection without claiming saved state', async () => {
    await mount(37); button(render(), 'Security').props.onClick();
    mocks.write.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'controlled policy rejection' }), { status: 403 }));
    button(render(), 'Save Changes').props.onClick(); await h.until(tree => text(tree).includes('controlled policy rejection'));
    expect(select('Session timeout').props.value).toBe('37'); expect(matchingOptions('Session timeout', '37')).toHaveLength(1);
    expect(text(render())).not.toContain('Security settings saved.'); expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it('read-only settings still show exact saved options and never offer a save dispatch', async () => {
    await mount(37, false);
    expect(select('Timezone').props.value).toBe('Europe/London'); expect(matchingOptions('Timezone', 'Europe/London')).toHaveLength(1);
    expect(select('Timezone').props.disabled).toBe(true); button(render(), 'Security').props.onClick();
    expect(select('Session timeout').props.value).toBe('37'); expect(select('Session timeout').props.disabled).toBe(true);
    expect(nodes(render()).some(node => node.type === 'button' && text(node).trim() === 'Save Changes')).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
