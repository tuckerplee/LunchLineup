import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, changeEvent, clientComponentHarness, deferred, form, input, nodes, submitEvent, text } from './client-component-harness';

const mocks = vi.hoisted(() => ({ hooks: null as any, fetch: vi.fn(), push: vi.fn(), query: new URLSearchParams() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
    useState: (...args: any[]) => mocks.hooks.useState(...args), useRef: (...args: any[]) => mocks.hooks.useRef(...args),
    useEffect: (...args: any[]) => mocks.hooks.useEffect(...args),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => mocks.query }));
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/lib/client-api', () => ({ fetchPublicApi: mocks.fetch, apiPath: (path: string) => `/api/v2${path}` }));
vi.mock('@/components/branding/LunchLineupMark', () => ({ LunchLineupMark: () => null }));
vi.mock('../../app/onboarding/challenge', () => ({ isSelfServiceSignupAvailable: () => false }));
import LoginPage from '../../app/auth/login/page';

let h: ReturnType<typeof clientComponentHarness>;
function mount(step: 'otp' | 'pin' | 'password' | 'identifier' = 'pin') {
    mocks.query = new URLSearchParams({ tenantSlug: 'demo', identifier: step === 'otp' ? 'a@example.com' : 'worker', next: '/dashboard/staff', step });
    h = clientComponentHarness(LoginPage); mocks.hooks = h.hooks;
    h.render(); h.flushEffects(); return h.render();
}
function fillProof(step: 'otp' | 'pin' | 'password') {
    const tree = h.render();
    if (step === 'otp') nodes(tree).find(node => node.props['aria-label'] === 'Digit 1')!.props.onChange(changeEvent('123456'));
    else input(tree, step === 'pin' ? 'PIN' : 'Password').props.onChange(changeEvent(step === 'pin' ? '1234' : 'correct-password'));
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
    mocks.fetch.mockReset(); mocks.push.mockReset();
    vi.stubGlobal('window', { location: { hostname: 'private.example.invalid', href: '', protocol: 'https:' }, localStorage: { getItem: () => null, setItem() {} } });
});
afterEach(() => { h?.unmount(); vi.unstubAllGlobals(); });

describe('actual login handlers and intent ownership', () => {
    it.each(['otp', 'pin', 'password'] as const)('ignores a late %s success after switching login without blocking the switch', async step => {
        const old = deferred<Response>(); mocks.fetch.mockReturnValueOnce(old.promise);
        mount(step); fillProof(step);
        const pending = form(h.render()).props.onSubmit(submitEvent());
        try {
            expect(mocks.fetch).toHaveBeenCalledOnce();
            const switchLogin = button(h.render(), 'Use different login'); expect(switchLogin.props.disabled).not.toBe(true);
            switchLogin.props.onClick(); expect(text(h.render())).toContain('Sign in to LunchLineup');
            old.resolve(json({ success: true, redirectTo: '/dashboard/staff' }));
            await pending;
            expect(mocks.push).not.toHaveBeenCalled();
            expect(text(h.render())).toContain('Sign in to LunchLineup');
            expect(button(h.render(), 'Continue').props.disabled).toBe(false);
        } finally { old.resolve(json({ success: false })); await pending; }
    });

    it('does not let an old OTP completion unlock a newer verification owner', async () => {
        const old = deferred<Response>(); const fresh = deferred<Response>();
        mocks.fetch.mockReturnValueOnce(old.promise);
        mount('otp'); fillProof('otp'); const first = form(h.render()).props.onSubmit(submitEvent());
        let second: Promise<void> | undefined;
        try {
            button(h.render(), 'Use different login').props.onClick();
            mocks.fetch.mockResolvedValueOnce(json({ success: true, flow: 'USERNAME_PASSWORD', identifier: 'worker' }));
            input(h.render(), 'Work email or username').props.onChange(changeEvent('worker'));
            await form(h.render()).props.onSubmit(submitEvent());
            fillProof('password'); mocks.fetch.mockReturnValueOnce(fresh.promise);
            second = form(h.render()).props.onSubmit(submitEvent());
            old.resolve(json({ success: true, redirectTo: '/dashboard/old' })); await first;
            expect(nodes(h.render()).find(node => node.type === 'button' && node.props.type === 'submit')!.props.disabled).toBe(true);
            await form(h.render()).props.onSubmit(submitEvent()); expect(mocks.fetch).toHaveBeenCalledTimes(3);
            expect(mocks.push).not.toHaveBeenCalled();
            fresh.resolve(json({ success: true, redirectTo: '/dashboard/new' })); await second;
            expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/dashboard/new');
        } finally { old.resolve(json({ success: false })); fresh.resolve(json({ success: false })); await first; await second; }
    });

    it.each([401, 503])('ignores an old %i refusal and its finally after new input', async status => {
        const old = deferred<Response>(); mocks.fetch.mockReturnValueOnce(old.promise);
        mount('password'); fillProof('password'); const pending = form(h.render()).props.onSubmit(submitEvent());
        try {
            button(h.render(), 'Use different login').props.onClick();
            input(h.render(), 'Work email or username').props.onChange(changeEvent('new-worker'));
            old.resolve(json({ message: 'Old refusal' }, status)); await pending;
            expect(text(h.render())).not.toContain('Old refusal'); expect(mocks.push).not.toHaveBeenCalled();
            expect(input(h.render(), 'Work email or username').props.value).toBe('new-worker');
        } finally { old.resolve(json({ success: false })); await pending; }
    });

    it.each(['otp', 'pin', 'password'] as const)('allows the current %s owner and forwards its exact request', async step => {
        mocks.fetch.mockResolvedValueOnce(json({ success: true, redirectTo: '/mfa?next=%2Fdashboard%2Fstaff' }));
        mount(step); fillProof(step); await form(h.render()).props.onSubmit(submitEvent());
        expect(mocks.fetch).toHaveBeenCalledOnce();
        const [path, init] = mocks.fetch.mock.calls[0];
        expect(path).toBe(`/auth/${step === 'otp' ? 'email/verify-otp' : step === 'pin' ? 'pin/verify' : 'password/verify'}?next=%2Fdashboard%2Fstaff`);
        expect(init.method).toBe('POST'); expect(init.credentials).toBe('include');
        expect(JSON.parse(init.body)).toEqual(step === 'otp' ? { email: 'a@example.com', tenantSlug: 'demo', code: '123456' }
            : step === 'pin' ? { identifier: 'worker', tenantSlug: 'demo', pin: '1234' }
                : { identifier: 'worker', tenantSlug: 'demo', password: 'correct-password' });
        expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/mfa?next=%2Fdashboard%2Fstaff');
    });

    it.each([{}, null, { success: true, flow: 'UNKNOWN' }, { success: true, flow: 'USERNAME_PASSWORD' }])('refuses malformed resolver payload %j without advancing or throwing', async payload => {
        mocks.fetch.mockResolvedValueOnce(json(payload)); mount('identifier');
        await form(h.render()).props.onSubmit(submitEvent());
        expect(text(h.render())).toContain('Sign in to LunchLineup'); expect(text(h.render())).not.toContain('Cannot read');
        expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(button(h.render(), 'Continue').props.disabled).toBe(false);
    });

    it('renders a malformed resolver refusal as a safe string through the actual error component', async () => {
        mocks.fetch.mockResolvedValueOnce(json({ success: false, message: { detail: 'private-object-detail' } }));
        mount('identifier'); await form(h.render()).props.onSubmit(submitEvent());
        const errorNode = nodes(h.render()).find(node => typeof node.type === 'function' && node.type.name === 'LoginError');
        expect(errorNode).toBeDefined();
        expect(() => renderToStaticMarkup(errorNode!)).not.toThrow();
        expect(typeof errorNode!.props.message).toBe('string');
        expect(renderToStaticMarkup(errorNode!)).toContain('Unable to continue login.');
        expect(renderToStaticMarkup(errorNode!)).not.toContain('private-object-detail');
        expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.fetch).toHaveBeenCalledOnce();
    });

    it('discards late resolver state when the actual identifier input changes', async () => {
        const old = deferred<Response>(); mocks.fetch.mockReturnValueOnce(old.promise); mount('identifier');
        const pending = form(h.render()).props.onSubmit(submitEvent());
        try {
            input(h.render(), 'Work email or username').props.onChange(changeEvent('different-worker'));
            old.resolve(json({ success: true, flow: 'USERNAME_PASSWORD', identifier: 'worker' })); await pending;
            expect(text(h.render())).toContain('Sign in to LunchLineup');
            expect(input(h.render(), 'Work email or username').props.value).toBe('different-worker');
            expect(mocks.fetch).toHaveBeenCalledOnce(); expect(mocks.push).not.toHaveBeenCalled();
        } finally { old.resolve(json({ success: false })); await pending; }
    });
});
