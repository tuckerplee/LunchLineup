import { describe, expect, it, vi } from 'vitest';
import { QA_ORIGIN, requireQaBaseUrl, requireQaContextOptions, requireQaResponse, requireQaUrl } from '../e2e/qa-isolation-policy';
import { QaIsolationGuard } from '../e2e/qa-isolation-controls';
import { qaBrowserLaunchOptions, requireQaConnectAuthority } from '../e2e/qa-loopback-proxy';

describe('disposable development QA network boundary', () => {
    it('allows only the exact fixed local CONNECT transport authority', () => {
        expect(() => requireQaConnectAuthority('127.0.0.1:8080')).not.toThrow();
        for (const authority of [undefined, 'localhost:8080', '127.0.0.1:4000', '127.0.0.1:18443',
            '127.0.0.1:08080', 'http://127.0.0.1:8080', '127.0.0.1:8080/', 'user@127.0.0.1:8080', '[::1]:8080']) {
            expect(() => requireQaConnectAuthority(authority)).toThrow(/CONNECT/);
        }
    });
    it('requires the exact loopback origin and fixed approved port', () => {
        expect(requireQaBaseUrl(QA_ORIGIN)).toBe(QA_ORIGIN);
        for (const value of [undefined, 'http://localhost:8080', 'http://127.0.0.1:4000', 'https://127.0.0.1:18443', 'https://beta.lunchlineup.com']) {
            expect(() => requireQaBaseUrl(value)).toThrow(/BASE_URL/);
        }
    });
    it('permits relative requests and local absolute requests only', () => {
        expect(requireQaUrl('/api/v2/users').origin).toBe(QA_ORIGIN);
        expect(requireQaUrl(`${QA_ORIGIN}/dashboard`).origin).toBe(QA_ORIGIN);
        for (const value of ['//beta.lunchlineup.com/api/v2/users', 'https://api.resend.com/emails', 'http://192.168.1.14:8080',
            'http://127.0.0.1:4000/v1/users', 'http://user:secret@127.0.0.1:8080/api/v2/users', 'file:///etc/passwd', 'ws://127.0.0.1:8080/socket']) {
            expect(() => requireQaUrl(value)).toThrow();
        }
    });
    it('allows returning local redirects without following them and rejects external redirect Locations', () => {
        expect(() => requireQaResponse(`${QA_ORIGIN}/admin`, 307, '/auth/login')).not.toThrow();
        expect(() => requireQaResponse(`${QA_ORIGIN}/auth/logout`, 302, 'https://beta.lunchlineup.com/auth/login')).toThrow(/denied/);
        expect(() => requireQaResponse(`${QA_ORIGIN}/api/v2/users`, 307, '//api.stripe.com/v1/customers')).toThrow(/denied/);
        expect(() => requireQaResponse('https://beta.lunchlineup.com', 200, undefined)).toThrow(/denied/);
    });
    it('does not retain credentials or query values in denial evidence', () => {
        try { requireQaUrl('https://user:password@beta.lunchlineup.com/api/v2/users?token=secret'); }
        catch (failure) {
            expect(String(failure)).toContain('beta.lunchlineup.com/api/v2/users');
            expect(String(failure)).not.toMatch(/password|token|secret/);
        }
    });
    it('rejects caller proxy overrides even when the advertised application origin is approved', () => {
        expect(() => requireQaContextOptions({})).not.toThrow();
        expect(() => requireQaContextOptions({ proxy: undefined })).not.toThrow();
        for (const server of ['http://127.0.0.1:18443', QA_ORIGIN]) {
            expect(() => requireQaContextOptions({ proxy: { server } })).toThrow(/proxy overrides/);
        }
    });
    it('rejects context, page, and API proxy overrides before invoking their real factories', async () => {
        const violations: string[] = [];
        const guard = new QaIsolationGuard(violations);
        const factory = vi.fn(async () => { throw new Error('Factory must never be reached'); });
        const options = { baseURL: QA_ORIGIN, proxy: { server: 'http://127.0.0.1:18443' } };
        await expect(guard.createBrowserContext(factory, options)).rejects.toThrow(/proxy overrides/);
        await expect(guard.createBrowserPage(factory, options)).rejects.toThrow(/proxy overrides/);
        await expect(guard.createApiContext(factory, options)).rejects.toThrow(/proxy overrides/);
        expect(factory).not.toHaveBeenCalled();
        expect(violations).toHaveLength(3);
    });
    it('fixes launch proxy and containment flags and rejects all caller arguments or default removal', () => {
        const proxy = 'http://127.0.0.1:45678';
        const options = qaBrowserLaunchOptions({ headless: true }, proxy);
        expect(options.proxy).toEqual({ server: proxy });
        expect(options.args).toContain('--proxy-bypass-list=<-loopback>');
        expect(options.args).toContain('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
        for (const arg of ['--no-proxy-server', '--proxy-server=http://127.0.0.1:18443', '--host-resolver-rules=MAP * 127.0.0.1', '--enable-quic', '--anything-else']) {
            expect(() => qaBrowserLaunchOptions({ args: [arg] }, proxy)).toThrow(/caller browser arguments/);
        }
        expect(() => qaBrowserLaunchOptions({ proxy: { server: 'http://127.0.0.1:18443' } }, proxy)).toThrow(/proxy overrides/);
        expect(() => qaBrowserLaunchOptions({ ignoreDefaultArgs: true }, proxy)).toThrow(/default/);
        expect(() => qaBrowserLaunchOptions({ ignoreDefaultArgs: ['--disable-background-networking'] }, proxy)).toThrow(/default/);
    });
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function guardedOwners() {
    const handlers: ((route: any, request?: unknown) => Promise<unknown>)[] = [];
    const request = Object.fromEntries(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head'].map(verb => [verb, vi.fn()]));
    const context: any = { request, route: vi.fn(async (_pattern, handler) => { handlers.push(handler); }), unroute: vi.fn(),
        routeWebSocket: vi.fn(), on: vi.fn(), pages: () => [page], close: vi.fn(async () => undefined) };
    const page: any = { request, context: () => context, route: vi.fn(), unroute: vi.fn(), close: vi.fn(async () => undefined) };
    const contextClose = context.close, pageClose = page.close, contextUnroute = context.unroute;
    const guard = new QaIsolationGuard([]);
    function route(fetch = vi.fn(async () => ({ url: () => QA_ORIGIN, status: () => 200, headers: () => ({}) })), url = `${QA_ORIGIN}/api/v2/users`) {
        return { request: () => ({ url: () => url, frame: () => ({ page: () => page }) }), fetch,
            fulfill: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    }
    return { context, page, contextClose, pageClose, contextUnroute, guard, handlers, route };
}

describe('guarded route lifecycle teardown', () => {
    it.each(['context', 'page'] as const)('drains an actual pending checked route before %s close without removing guards', async owner => {
        const fixture = guardedOwners();
        await fixture.guard.guardContext(fixture.context);
        const waiting = deferred<any>();
        const routed = fixture.route(vi.fn(() => waiting.promise));
        const task = fixture.handlers[0](routed);
        const closing = fixture[owner].close();
        await Promise.resolve();
        expect(fixture[owner === 'context' ? 'contextClose' : 'pageClose']).not.toHaveBeenCalled();
        waiting.resolve({ url: () => QA_ORIGIN, status: () => 200, headers: () => ({}) });
        await task; await closing;
        expect(routed.fulfill).toHaveBeenCalledOnce();
        expect(fixture[owner === 'context' ? 'contextClose' : 'pageClose']).toHaveBeenCalledOnce();
        expect(fixture.contextUnroute).not.toHaveBeenCalled();
        expect(fixture.guard.violations).toEqual([]);
    });
    it('blocks new local fetches during drain while still retaining denied external requests', async () => {
        const fixture = guardedOwners(); await fixture.guard.guardContext(fixture.context);
        const waiting = deferred<any>(); const initial = fixture.handlers[0](fixture.route(vi.fn(() => waiting.promise)));
        const closing = fixture.context.close();
        const late = fixture.route(); await fixture.handlers[0](late);
        expect(late.fetch).not.toHaveBeenCalled(); expect(late.abort).toHaveBeenCalledWith('blockedbyclient');
        const denied = fixture.route(undefined, 'https://api.stripe.com/unsafe'); await fixture.handlers[0](denied);
        expect(denied.fetch).not.toHaveBeenCalled(); expect(fixture.guard.violations).toHaveLength(1);
        waiting.resolve({ url: () => QA_ORIGIN, status: () => 200, headers: () => ({}) }); await initial; await closing;
    });
    it('retains a real fetch failure after the handler has already settled and closes ownership', async () => {
        const fixture = guardedOwners(); await fixture.guard.guardContext(fixture.context);
        const failure = new Error('real local network failure');
        await expect(fixture.handlers[0](fixture.route(vi.fn(async () => { throw failure; })))).rejects.toBe(failure);
        await expect(fixture.context.close()).rejects.toThrow(/drain and close/);
        expect(fixture.contextClose).toHaveBeenCalledOnce();
        expect(fixture.guard.violations).toEqual([]);
    });
    it('retains handler assertion and native ownership-close failures together', async () => {
        const fixture = guardedOwners(); await fixture.guard.guardContext(fixture.context);
        const assertion = new Error('genuine assertion failure');
        await fixture.context.route('**/assert', async () => { throw assertion; });
        await expect(fixture.handlers[1](fixture.route())).rejects.toBe(assertion);
        const closeFailure = new Error('native context close failed'); fixture.contextClose.mockRejectedValue(closeFailure);
        try { await fixture.context.close(); throw new Error('close must fail'); }
        catch (failure) {
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors).toContain(closeFailure);
            expect(((failure as AggregateError).errors[0] as AggregateError).errors).toContain(assertion);
        }
    });
    it('keeps redirect checks active while draining an in-flight fetch', async () => {
        const fixture = guardedOwners(); await fixture.guard.guardContext(fixture.context);
        const waiting = deferred<any>(); const routed = fixture.route(vi.fn(() => waiting.promise));
        const task = fixture.handlers[0](routed); const closing = fixture.context.close();
        waiting.resolve({ url: () => QA_ORIGIN, status: () => 307, headers: () => ({ location: 'https://api.stripe.com/unsafe' }) });
        await task; await closing;
        expect(routed.fetch).toHaveBeenCalledWith(expect.objectContaining({ maxRedirects: 0 }));
        expect(routed.fulfill).not.toHaveBeenCalled(); expect(fixture.guard.violations).toHaveLength(1);
    });
    it('bounds an unresolved route drain, fails cleanup and still attempts owned closure', async () => {
        vi.useFakeTimers();
        try {
            const fixture = guardedOwners(); await fixture.guard.guardContext(fixture.context);
            const waiting = deferred<any>(); const task = fixture.handlers[0](fixture.route(vi.fn(() => waiting.promise)));
            const closing = fixture.context.close(); const rejected = expect(closing).rejects.toThrow(/drain and close/);
            await vi.advanceTimersByTimeAsync(5_000); await rejected;
            expect(fixture.contextClose).toHaveBeenCalledOnce();
            expect(fixture.guard.violations).toEqual([]);
            waiting.resolve({ url: () => QA_ORIGIN, status: () => 200, headers: () => ({}) }); await task;
        } finally { vi.useRealTimers(); }
    });
});

it('does not mask a genuine pending network failure when another route records an isolation denial', async () => {
    const fixture = guardedOwners(); await fixture.guard.guardContext(fixture.context);
    const waiting = deferred<any>(); const genuine = fixture.handlers[0](fixture.route(vi.fn(() => waiting.promise)));
    await fixture.handlers[0](fixture.route(undefined, 'https://api.stripe.com/unsafe'));
    const failure = new Error('real network failure while another request was denied');
    const rejected = expect(genuine).rejects.toBe(failure); waiting.reject(failure); await rejected;
    await expect(fixture.context.close()).rejects.toThrow(/drain and close/);
    expect(fixture.guard.violations).toHaveLength(1);
});

it('drains late abort work before native close and retains its failure', async () => {
    const fixture = guardedOwners(); await fixture.guard.guardContext(fixture.context);
    const waiting = deferred<any>(); const first = fixture.handlers[0](fixture.route(vi.fn(() => waiting.promise)));
    const closing = fixture.context.close(); const rejected = expect(closing).rejects.toThrow(/drain and close/);
    const aborting = deferred<void>(); const late = fixture.route(); late.abort = vi.fn(() => aborting.promise);
    const lateTask = fixture.handlers[0](late); const abortFailure = new Error('real route abort failure');
    const lateRejected = expect(lateTask).rejects.toBe(abortFailure);
    waiting.resolve({ url: () => QA_ORIGIN, status: () => 200, headers: () => ({}) }); await first;
    expect(fixture.contextClose).not.toHaveBeenCalled();
    aborting.reject(abortFailure); await lateRejected; await rejected;
    expect(fixture.contextClose).toHaveBeenCalledOnce(); expect(fixture.guard.violations).toEqual([]);
});

it('closing one page does not reject guarded requests from a surviving page in the same context', async () => {
    const fixture = guardedOwners(); await fixture.guard.guardContext(fixture.context); await fixture.page.close();
    const otherPage = { context: () => fixture.context };
    const routed = fixture.route(); routed.request = () => ({ url: () => `${QA_ORIGIN}/api/v2/users`, frame: () => ({ page: () => otherPage }) });
    await fixture.handlers[0](routed);
    expect(routed.fetch).toHaveBeenCalledOnce(); expect(routed.fulfill).toHaveBeenCalledOnce();
    expect(fixture.guard.violations).toEqual([]);
});
