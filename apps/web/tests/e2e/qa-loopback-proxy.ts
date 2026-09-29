import { createServer, request as httpRequest, type IncomingHttpHeaders, type ClientRequest } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { LaunchOptions } from '@playwright/test';
import { QA_ORIGIN, requireQaContextOptions, requireQaUrl } from './qa-isolation-policy';

export async function startQaLoopbackProxy() {
    const evidence = { version: 1, pid: process.pid, startedAt: new Date().toISOString(), stoppedAt: '',
        approvedOrigin: QA_ORIGIN, upstream: { hostname: '127.0.0.1', port: 8080 }, listenOrigin: '', denials: [] as string[] };
    const sockets = new Set<Socket>();
    const upstreamRequests = new Set<ClientRequest>();
    const server = createServer((incoming, outgoing) => {
        let url: URL;
        try { url = requireQaUrl(incoming.url?.startsWith('http') ? incoming.url : `http://${incoming.headers.host}${incoming.url}`); }
        catch (failure) {
            evidence.denials.push(failure instanceof Error ? failure.message : 'Proxy denied an invalid destination.');
            outgoing.writeHead(403, { 'content-type': 'text/plain', 'connection': 'close' });
            outgoing.end('Disposable QA proxy denied this destination.');
            return;
        }
        // Never resolve or connect to the requested host. Every permitted request
        // is sent to this one fixed application endpoint, including redirect hops.
        const headers: IncomingHttpHeaders = { ...incoming.headers, host: '127.0.0.1:8080' };
        delete headers['proxy-connection'];
        delete headers['proxy-authorization'];
        const upstream = httpRequest({ hostname: '127.0.0.1', port: 8080,
            path: `${url.pathname}${url.search}`, method: incoming.method, headers }, response => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
        });
        upstreamRequests.add(upstream);
        upstream.on('close', () => upstreamRequests.delete(upstream));
        upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end('QA endpoint unavailable.'); });
        incoming.on('aborted', () => upstream.destroy());
        outgoing.on('close', () => upstream.destroy());
        incoming.pipe(upstream);
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('connect', (_incoming, socket) => {
        evidence.denials.push('Proxy denied CONNECT; disposable development QA is HTTP only.');
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
    server.on('upgrade', (_incoming, socket) => {
        evidence.denials.push('Proxy denied an unexpected protocol upgrade.');
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { server.close(); reject(new Error('QA proxy listen deadline exceeded.')); }, 5000);
        const failed = (failure: Error) => { clearTimeout(timeout); reject(failure); };
        server.once('error', failed);
        server.listen(0, '127.0.0.1', () => { clearTimeout(timeout); server.off('error', failed); resolve(); });
    });
    evidence.listenOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        evidence,
        async close() {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('QA proxy close deadline exceeded.')), 5000);
                upstreamRequests.forEach(upstream => upstream.destroy());
                sockets.forEach(socket => socket.destroy());
                server.close(() => { clearTimeout(timeout); resolve(); });
                server.closeAllConnections();
            });
            evidence.stoppedAt = new Date().toISOString();
        },
    };
}

export function qaBrowserLaunchOptions(options: LaunchOptions, proxyOrigin: string): LaunchOptions {
    requireQaContextOptions(options);
    if (options.ignoreDefaultArgs) throw new Error('QA isolation denied removal of default browser containment arguments.');
    if (options.args?.length) throw new Error('QA isolation denied caller browser arguments; containment arguments are fixed by this harness.');
    return {
        ...options,
        proxy: { server: proxyOrigin },
        args: [...(options.args ?? []), '--proxy-bypass-list=<-loopback>', '--disable-quic',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking',
            '--disable-component-update', '--disable-domain-reliability'],
    };
}
