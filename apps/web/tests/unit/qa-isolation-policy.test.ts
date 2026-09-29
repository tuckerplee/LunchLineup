import { describe, expect, it, vi } from 'vitest';
import { QA_ORIGIN, requireQaBaseUrl, requireQaContextOptions, requireQaResponse, requireQaUrl } from '../e2e/qa-isolation-policy';
import { QaIsolationGuard } from '../e2e/qa-isolation-controls';
import { qaBrowserLaunchOptions } from '../e2e/qa-loopback-proxy';

describe('disposable development QA network boundary', () => {
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
