import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as dns from 'dns/promises';
import * as https from 'https';
import { secureHttpRequest } from './secure-http-client';

vi.mock('dns/promises', () => ({
    lookup: vi.fn(),
}));

vi.mock('https', () => ({
    request: vi.fn(),
}));

vi.mock('http', () => ({
    request: vi.fn(),
}));

const lookupMock = dns.lookup as unknown as Mock;
const httpsRequestMock = https.request as unknown as Mock;
const originalNodeEnv = process.env.NODE_ENV;

describe('secureHttpRequest', () => {
    beforeEach(() => {
        process.env.NODE_ENV = 'test';
        lookupMock.mockReset();
        httpsRequestMock.mockReset();
    });

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
        vi.useRealTimers();
    });

    it('rejects unsupported protocols before outbound requests', async () => {
        await expect(secureHttpRequest('file:///etc/passwd')).rejects.toThrow('Unsupported outbound protocol');

        expect(httpsRequestMock).not.toHaveBeenCalled();
        expect(lookupMock).not.toHaveBeenCalled();
    });

    it('blocks private IPv4 DNS results', async () => {
        lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);

        await expect(secureHttpRequest('https://hooks.example.com/webhook')).rejects.toThrow('private IP');

        expect(httpsRequestMock).not.toHaveBeenCalled();
    });

    it('blocks cloud metadata endpoints before DNS resolution', async () => {
        await expect(secureHttpRequest('http://169.254.169.254/latest/meta-data')).rejects.toThrow('cloud metadata endpoint');

        expect(lookupMock).not.toHaveBeenCalled();
        expect(httpsRequestMock).not.toHaveBeenCalled();
    });

    it('blocks IPv6 DNS results', async () => {
        lookupMock.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }]);

        await expect(secureHttpRequest('https://hooks.example.com/webhook')).rejects.toThrow('IPv6 destination');

        expect(httpsRequestMock).not.toHaveBeenCalled();
    });

    it('includes DNS resolution in the total deadline so shutdown-facing handlers settle', async () => {
        vi.useFakeTimers();
        lookupMock.mockImplementation(() => new Promise(() => undefined));

        const request = secureHttpRequest('https://hooks.example.com/webhook', {
            timeoutMs: 25,
        });
        const rejection = expect(request).rejects.toThrow('Outbound request timed out');

        await vi.advanceTimersByTimeAsync(25);
        await rejection;
        expect(httpsRequestMock).not.toHaveBeenCalled();
    });

    it('uses the validated DNS address for the outbound socket', async () => {
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        mockHttpsResponse(204);

        await secureHttpRequest('https://hooks.example.com/webhook?event=test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"ok":true}',
            timeoutMs: 5000,
        });

        expect(httpsRequestMock).toHaveBeenCalledWith(expect.objectContaining({
            hostname: '93.184.216.34',
            servername: 'hooks.example.com',
            method: 'POST',
            path: '/webhook?event=test',
            signal: expect.any(AbortSignal),
            headers: expect.objectContaining({
                Host: 'hooks.example.com',
                'Content-Type': 'application/json',
                'Content-Length': '11',
            }),
        }), expect.any(Function));
    });

    it('rejects redirects by default', async () => {
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        mockHttpsResponse(302, { location: 'https://example.com/next' });

        await expect(secureHttpRequest('https://hooks.example.com/webhook')).rejects.toThrow('Outbound redirects are disabled');
    });

    it('rejects oversized outbound responses', async () => {
        lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        mockHttpsResponse(200, {}, 'x'.repeat(16));

        await expect(secureHttpRequest('https://hooks.example.com/webhook', { maxResponseBytes: 4 }))
            .rejects
            .toThrow('Outbound response exceeded size limit');
    });
});

function mockHttpsResponse(statusCode: number, headers: Record<string, string> = {}, body = '') {
    httpsRequestMock.mockImplementation((_options: unknown, callback: (res: any) => void) => {
        const request = new EventEmitter() as any;
        request.write = vi.fn();
        request.destroy = vi.fn((error?: Error) => request.emit('error', error ?? new Error('request destroyed')));
        request.end = vi.fn(() => {
            const response = new EventEmitter() as any;
            response.statusCode = statusCode;
            response.statusMessage = statusCode === 204 ? 'No Content' : 'Found';
            response.headers = headers;
            response.resume = vi.fn(() => response.emit('end'));
            callback(response);
            if (body) {
                response.emit('data', Buffer.from(body));
            }
            response.emit('end');
        });
        return request;
    });
}
