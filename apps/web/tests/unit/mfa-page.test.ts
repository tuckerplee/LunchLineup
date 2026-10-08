import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, changeEvent, clientComponentHarness, deferred, form, input, nodes, submitEvent, text } from './client-component-harness';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readOneTimeRecoveryCodes, recoveryCodesAsText } from '../../app/mfa/recovery-codes';

const pageSource = readFileSync(resolve(__dirname, '../../app/mfa/page.tsx'), 'utf8');

describe('MFA verification page', () => {
  it('submits MFA verification with the double-submit CSRF header', () => {
    expect(pageSource).toContain('csrf_token=');
    expect(pageSource).toContain("'x-csrf-token': csrfToken");
    expect(pageSource).toContain("credentials: 'include'");
    expect(pageSource).toContain('/auth/mfa/verify');
  });

  it('normalizes one-time recovery codes without persisting them', () => {
    const codes = readOneTimeRecoveryCodes({ data: { backupCodes: ['LL-4F8K-92HD', '', 123, 'LL-73QW-1PZM'] } });

    expect(codes).toEqual(['LL-4F8K-92HD', 'LL-73QW-1PZM']);
    expect(recoveryCodesAsText(codes)).toBe('LL-4F8K-92HD\nLL-73QW-1PZM');
    expect(pageSource).not.toContain('localStorage');
    expect(pageSource).not.toContain('sessionStorage');
  });

  it('requires acknowledgment after enrollment before redirecting', () => {
    expect(pageSource).toContain("setMode('recovery-codes')");
    expect(pageSource).toContain('disabled={!recoveryCodesAcknowledged}');
    expect(pageSource).toContain('I saved these recovery codes in a secure place.');
    expect(pageSource).toContain('navigator.clipboard.writeText');
    expect(pageSource).toContain('window.print()');
    expect(pageSource).toContain('setRecoveryCodes([])');
  });

  it('announces dynamic errors and offers privileged users support-backed factor recovery', () => {
    expect(pageSource).toContain('role="alert"');
    expect(pageSource).toContain('aria-live="assertive"');
    expect(pageSource).toContain('aria-atomic="true"');
    expect(pageSource).toContain('legalContacts.support');
    expect(pageSource).toContain('Lost every MFA factor?');
    expect(pageSource).toContain('Contact LunchLineup support');
  });});


const mocks = vi.hoisted(() => ({ hooks: null as any, fetch: vi.fn(), assign: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (...args: any[]) => mocks.hooks.useState(...args), useRef: (...args: any[]) => mocks.hooks.useRef(...args),
  useEffect: (...args: any[]) => mocks.hooks.useEffect(...args), useCallback: (...args: any[]) => mocks.hooks.useCallback(...args),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('next=/dashboard') }));
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/lib/client-api', () => ({ fetchPublicApi: mocks.fetch }));
vi.mock('@/components/branding/LunchLineupMark', () => ({ LunchLineupMark: () => null }));
import MfaPage from '../../app/mfa/page';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const setup = { secret: 'SYNTHETICSETUPKEY', otpauthUrl: 'otpauth://totp/Synthetic?secret=SYNTHETICSETUPKEY', expiresInSeconds: 600 };
const confirmation = { success: true, mfaVerified: true, backupCodes: ['synthetic-recovery-1', 'synthetic-recovery-2'] };
let h: ReturnType<typeof clientComponentHarness>;
function render() { mocks.hooks = h.hooks; return h.render(); }
async function mount(enabled = false, state: unknown = { enabled, recoveryCodesRemaining: enabled ? 2 : 0 }, setupResponse = json(setup)) {
  mocks.fetch.mockResolvedValueOnce(json(state));
  if (!enabled && state && typeof state === 'object' && 'enabled' in state && 'recoveryCodesRemaining' in state) mocks.fetch.mockResolvedValueOnce(setupResponse);
  h = clientComponentHarness(MfaPage); render(); h.flushEffects();
  await h.until(tree => !text(tree).includes('Checking your sign-in') && !text(tree).includes('Loading secure verification'));
  // State publication precedes finally; await the resolved bootstrap microtasks.
  await Promise.resolve(); render();
}
beforeEach(() => {
  mocks.fetch.mockReset(); mocks.assign.mockReset();
  vi.stubGlobal('document', { cookie: 'csrf_token=synthetic-csrf' });
  vi.stubGlobal('window', { location: { assign: mocks.assign } });
});
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); });

// Actual page handlers + explicit hook ledger with fake HTTP responses. These
// do not prove native TOTP, recovery-code consumption, browser or persistence.
describe('actual MFA page strict response and request custody', () => {
  it.each([{}, { mfaEnabled: false }, { enabled: false }, { enabled: 'false', recoveryCodesRemaining: 0 }])('malformed GET %j never starts enrollment or exposes a setup key', async state => {
    // No second queued response: malformed GET must not dispatch POST.
    mocks.fetch.mockResolvedValueOnce(json(state));
    h = clientComponentHarness(MfaPage); render(); h.flushEffects();
    await h.until(tree => text(tree).includes('Verify your sign-in'));
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.assign).not.toHaveBeenCalled();
    expect(text(render())).not.toContain('Manual setup key');
  });
  it.each([{}, { manualEntryKey: 'UNTRUSTEDKEY', otpauthUrl: setup.otpauthUrl, expiresInSeconds: 600 }, { ...setup, expiresInSeconds: 0 }])('rejects malformed setup %j and allows explicit retry', async payload => {
    await mount(false, { enabled: false, recoveryCodesRemaining: 0 }, json(payload));
    expect(text(render())).toContain('MFA setup needs help'); expect(text(render())).not.toContain('Manual setup key');
    mocks.fetch.mockResolvedValueOnce(json(setup)); button(render(), 'Retry MFA setup').props.onClick();
    await h.until(tree => text(tree).includes('Manual setup key'));
    expect(input(render(), 'Manual setup key').props.value).toBe(setup.secret);
    expect(mocks.fetch).toHaveBeenCalledTimes(3); expect(mocks.assign).not.toHaveBeenCalled();
  });
  it.each([{ success: false, mfaVerified: true, backupCodes: confirmation.backupCodes }, { success: true, backupCodes: confirmation.backupCodes }, { success: true, mfaVerified: true, recoveryCodes: confirmation.backupCodes }])('rejects malformed confirmation %j without losing input or displaying codes', async payload => {
    await mount(); input(render(), 'Authenticator code').props.onChange(changeEvent('123456'));
    mocks.fetch.mockResolvedValueOnce(json(payload)); await form(render()).props.onSubmit(submitEvent());
    expect(input(render(), 'Authenticator code').props.value).toBe('123456');
    expect(text(render())).toContain('invalid MFA response'); expect(text(render())).not.toContain('synthetic-recovery-1');
    expect(mocks.assign).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(button(render(), 'Enable MFA and continue').props.disabled).toBe(false);
  });
  it.each([{}, { success: true }, { success: false, mfaVerified: true }, { success: true, mfaVerified: 'true' }])('never navigates on malformed challenge acknowledgement %j', async payload => {
    await mount(true); input(render(), 'Authentication code').props.onChange(changeEvent('123456'));
    mocks.fetch.mockResolvedValueOnce(json(payload)); await form(render()).props.onSubmit(submitEvent());
    expect(mocks.assign).not.toHaveBeenCalled(); expect(input(render(), 'Authentication code').props.value).toBe('123456');
    expect(button(render(), 'Verify and continue').props.disabled).toBe(false);
  });
  it('valid flat confirmation requires explicit saved-code acknowledgment before navigation', async () => {
    await mount(); expect(input(render(), 'Manual setup key').props.value).toBe(setup.secret);
    input(render(), 'Authenticator code').props.onChange(changeEvent('123456'));
    mocks.fetch.mockResolvedValueOnce(json(confirmation)); await form(render()).props.onSubmit(submitEvent());
    expect(text(render())).toContain('synthetic-recovery-1'); expect(mocks.assign).not.toHaveBeenCalled();
    expect(button(render(), 'Continue to LunchLineup').props.disabled).toBe(true);
    button(render(), 'Continue to LunchLineup').props.onClick(); expect(mocks.assign).not.toHaveBeenCalled();
    nodes(render()).find(node => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } });
    button(render(), 'Continue to LunchLineup').props.onClick(); expect(mocks.assign).toHaveBeenCalledExactlyOnceWith('/dashboard');
    expect(text(render())).not.toContain('synthetic-recovery-1');
    expect(mocks.fetch.mock.calls[2]).toEqual(['/auth/mfa/enrollment', expect.objectContaining({ method: 'PUT', credentials: 'include', headers: expect.objectContaining({ 'x-csrf-token': 'synthetic-csrf' }), body: JSON.stringify({ code: '123456' }) })]);
  });
  it('only verified successful challenge navigates with the exact submitted code', async () => {
    await mount(true); input(render(), 'Authentication code').props.onChange(changeEvent('123 456'));
    mocks.fetch.mockResolvedValueOnce(json({ success: true, mfaVerified: true }));
    await form(render()).props.onSubmit(submitEvent());
    expect(mocks.assign).toHaveBeenCalledExactlyOnceWith('/dashboard');
    expect(mocks.fetch.mock.calls[1]).toEqual(['/auth/mfa/verify', expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: '123456' }), credentials: 'include' })]);
  });
  it.each(['double-restart', 'restart-then-confirm', 'confirm-then-restart'] as const)('%s dispatches only one in-flight request and permits retry after failure', async race => {
    await mount(); input(render(), 'Authenticator code').props.onChange(changeEvent('123456'));
    const restart = button(render(), 'Restart MFA setup').props.onClick;
    const confirm = form(render()).props.onSubmit;
    const gate = deferred<Response>(); mocks.fetch.mockReturnValueOnce(gate.promise);
    let pending: Promise<void> | undefined;
    if (race === 'confirm-then-restart') { pending = confirm(submitEvent()); restart(); }
    else { restart(); if (race === 'double-restart') restart(); else pending = confirm(submitEvent()); }
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.fetch.mock.calls[2][1].method).toBe(race === 'confirm-then-restart' ? 'PUT' : 'POST');
    gate.resolve(json({ message: 'controlled temporary failure' }, 503)); await pending;
    await h.until(tree => nodes(tree).some(node => node.type === 'button' && ['Retry MFA setup', 'Restart MFA setup'].includes(text(node).trim()) && node.props.disabled === false));
    mocks.fetch.mockResolvedValueOnce(json({ ...setup, secret: 'SECONDSETUPKEY' }));
    button(render(), race === 'confirm-then-restart' ? 'Restart MFA setup' : 'Retry MFA setup').props.onClick();
    await h.until(tree => nodes(tree).some(node => node.type === 'input' && node.props.value === 'SECONDSETUPKEY'));
    expect(mocks.fetch).toHaveBeenCalledTimes(4); expect(mocks.assign).not.toHaveBeenCalled();
  });
});
