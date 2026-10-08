import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, changeEvent, clientComponentHarness, form, input, submitEvent, text } from './client-component-harness';

const pageSource = readFileSync(resolve(__dirname, '../../app/auth/reset-pin/page.tsx'), 'utf8');

describe('temporary PIN reset page', () => {
    it('clears the revoked session through logout after rotating the PIN', () => {
        const rotateIndex = pageSource.indexOf('/users/me/pin');
        const logoutIndex = pageSource.indexOf("window.location.assign('/auth/logout')");

        expect(rotateIndex).toBeGreaterThan(-1);
        expect(logoutIndex).toBeGreaterThan(rotateIndex);
        expect(pageSource).toContain("'x-csrf-token': csrfToken");
        expect(pageSource).not.toContain('/auth/refresh');
        expect(pageSource).not.toContain('/mfa?');
    });
});

const mocks = vi.hoisted(() => ({ hooks: null as any, fetch: vi.fn(), logout: vi.fn(), assign: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (...args: any[]) => mocks.hooks.useState(...args) }));
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/lib/client-api', () => ({ fetchPublicApi: mocks.fetch, prepareForLogout: mocks.logout }));
vi.mock('@/components/branding/LunchLineupMark', () => ({ LunchLineupMark: () => null }));
vi.mock('@/components/auth/LogoutLink', () => ({ LogoutLink: 'a' }));
import ResetPinPage from '../../app/auth/reset-pin/page';
let h: ReturnType<typeof clientComponentHarness>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  mocks.fetch.mockReset(); mocks.logout.mockReset(); mocks.assign.mockReset();
  vi.stubGlobal('document', { cookie: 'csrf_token=synthetic-csrf' }); vi.stubGlobal('window', { location: { assign: mocks.assign } });
  h = clientComponentHarness(ResetPinPage); mocks.hooks = h.hooks; h.render();
  for (const [label, value] of [['Temporary PIN', '1111'], ['New PIN', '2222'], ['Confirm new PIN', '2222']]) input(h.render(), label).props.onChange(changeEvent(value));
});
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); });
// Fake transport, actual forced-PIN handler: no native revocation/login proof.
describe('actual forced PIN strict confirmation', () => {
  it.each([{}, null, { success: false }, { success: 'true' }, { data: { success: true } }])('preserves inputs/session for malformed 200 %j then allows an explicit confirmed retry', async payload => {
    mocks.fetch.mockResolvedValueOnce(json(payload)); await form(h.render()).props.onSubmit(submitEvent());
    expect(mocks.logout).not.toHaveBeenCalled(); expect(mocks.assign).not.toHaveBeenCalled();
    expect(input(h.render(), 'Temporary PIN').props.value).toBe('1111'); expect(input(h.render(), 'New PIN').props.value).toBe('2222');
    expect(input(h.render(), 'Confirm new PIN').props.value).toBe('2222'); expect(button(h.render(), 'Update PIN').props.disabled).toBe(false);
    expect(text(h.render())).toContain('Unable to update PIN');
    mocks.fetch.mockResolvedValueOnce(json({ success: true })); await form(h.render()).props.onSubmit(submitEvent());
    expect(mocks.logout).toHaveBeenCalledTimes(1); expect(mocks.assign).toHaveBeenCalledExactlyOnceWith('/auth/logout');
    expect(mocks.fetch.mock.calls[1]).toEqual(mocks.fetch.mock.calls[0]);
    expect(mocks.fetch.mock.calls[0]).toEqual(['/users/me/pin', expect.objectContaining({ method: 'PUT', credentials: 'include', headers: expect.objectContaining({ 'x-csrf-token': 'synthetic-csrf' }), body: JSON.stringify({ currentPin: '1111', newPin: '2222' }) })]);
  });
  it.each(['network', '503'] as const)('preserves PIN inputs and session after %s failure', async mode => {
    if (mode === 'network') mocks.fetch.mockRejectedValueOnce(new Error('controlled network failure'));
    else mocks.fetch.mockResolvedValueOnce(json({ success: true }, 503));
    await form(h.render()).props.onSubmit(submitEvent());
    expect(mocks.logout).not.toHaveBeenCalled(); expect(mocks.assign).not.toHaveBeenCalled();
    expect(input(h.render(), 'Temporary PIN').props.value).toBe('1111'); expect(input(h.render(), 'New PIN').props.value).toBe('2222');
    expect(button(h.render(), 'Update PIN').props.disabled).toBe(false); expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
