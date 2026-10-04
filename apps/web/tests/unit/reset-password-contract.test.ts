import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, changeEvent, clientComponentHarness, deferred, form, input, submitEvent, text } from './client-component-harness';
import { passwordValidationMessage, resetConfirmationErrorMessage } from '../../app/auth/reset-password/reset-password-contract';

const mocks = vi.hoisted(() => ({ hooks: null as any, fetch: vi.fn(), query: new URLSearchParams() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (...args: any[]) => mocks.hooks.useState(...args), useRef: (...args: any[]) => mocks.hooks.useRef(...args),
    useEffect: (...args: any[]) => mocks.hooks.useEffect(...args),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.query }));
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/lib/client-api', () => ({ fetchPublicApi: mocks.fetch }));
vi.mock('@/components/branding/LunchLineupMark', () => ({ LunchLineupMark: () => null }));
import ResetPasswordPage from '../../app/auth/reset-password/page';

let h: ReturnType<typeof clientComponentHarness>;
const token = 'synthetic-reset-token-12345678901234567890';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function mount(password = 'valid-password') {
    h = clientComponentHarness(ResetPasswordPage); mocks.hooks = h.hooks;
    h.render(); h.flushEffects();
    input(h.render(), 'New password').props.onChange(changeEvent(password));
    input(h.render(), 'Confirm password').props.onChange(changeEvent(password));
}
beforeEach(() => {
    mocks.fetch.mockReset(); mocks.query = new URLSearchParams({ token });
    vi.stubGlobal('document', { cookie: '' });
    vi.stubGlobal('window', { location: { href: `https://private.example.invalid/auth/reset-password?token=${token}`, protocol: 'https:' }, history: { state: null, replaceState: vi.fn() } });
});
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); });

describe('actual password reset confirmation handler', () => {
    it.each(['a'.repeat(73), '界'.repeat(25)])('refuses an oversized UTF-8 password locally without blaming the token', async password => {
        mount(password); await form(h.render()).props.onSubmit(submitEvent());
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(text(h.render())).toContain('at most 72 UTF-8 bytes');
        expect(text(h.render())).not.toContain('invalid or expired');
        expect(input(h.render(), 'New password').props.value).toBe(password);
    });

    it.each([{}, null, undefined, [], { success: false }, { success: 'true' }].map(payload => [payload]))('does not claim password completion for malformed 200 %j', async payload => {
        mocks.fetch.mockResolvedValueOnce(json(payload)); mount();
        await form(h.render()).props.onSubmit(submitEvent());
        expect(text(h.render())).not.toContain('Password updated.');
        expect(text(h.render())).toContain('did not confirm');
        expect(input(h.render(), 'New password').props.value).toBe('valid-password');
        expect(button(h.render(), 'Update password').props.disabled).toBe(false);
    });

    it('only clears inputs after the current controller confirmation actually arrives', async () => {
        const pendingResponse = deferred<Response>(); mocks.fetch.mockReturnValueOnce(pendingResponse.promise);
        mount('界'.repeat(24)); const pending = form(h.render()).props.onSubmit(submitEvent());
        try {
            expect(button(h.render(), 'Updating...').props.disabled).toBe(true);
            expect(text(h.render())).not.toContain('Password updated.');
            pendingResponse.resolve(json({ success: true })); await pending;
            expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('/auth/password/reset/confirm', expect.objectContaining({
                method: 'POST', credentials: 'include', body: JSON.stringify({ token, password: '界'.repeat(24) }),
            }));
            expect(text(h.render())).toContain('Password updated. Sign in with your new password.');
            expect(input(h.render(), 'New password').props.value).toBe('');
        } finally { pendingResponse.resolve(json({ success: false })); await pending; }
    });

    it.each([[400, 'password requirements'], [422, 'password requirements'], [401, 'invalid or expired'], [429, 'Too many reset attempts'], [503, 'temporarily unavailable']] as const)(
        'classifies %i without losing retryable input', async (status, expected) => {
            mocks.fetch.mockResolvedValueOnce(json({ message: 'Owner refusal' }, status)); mount();
            await form(h.render()).props.onSubmit(submitEvent());
            expect(text(h.render())).toContain(expected);
            expect(input(h.render(), 'New password').props.value).toBe('valid-password');
            expect(text(h.render())).not.toContain('Password updated.');
        });

    it('keeps the byte ceiling aligned with the owner while retaining the existing eight-character minimum', () => {
        expect(passwordValidationMessage('a'.repeat(72))).toBeNull();
        expect(passwordValidationMessage('界'.repeat(24))).toBeNull();
        expect(passwordValidationMessage('abcdefg')).toContain('8 characters');
        expect(resetConfirmationErrorMessage(403)).not.toContain('invalid or expired');
    });
});
