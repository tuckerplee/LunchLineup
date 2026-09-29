import { createServer, request as httpRequest, type IncomingHttpHeaders, type ClientRequest } from 'node:http';
import { connect as tcpConnect, type AddressInfo, type Socket } from 'node:net';
import type { LaunchOptions } from '@playwright/test';
import { QA_ORIGIN, requireQaContextOptions, requireQaUrl } from './qa-isolation-policy';

export function requireQaConnectAuthority(authority: string | undefined): void {
    if (authority !== '127.0.0.1:8080') throw new Error('Proxy denied CONNECT outside the fixed local application transport.');
}

export async function startQaLoopbackProxy() {
    const evidence = { version: 1, pid: process.pid, startedAt: new Date().toISOString(), stoppedAt: '',
        approvedOrigin: QA_ORIGIN, upstream: { hostname: '127.0.0.1', port: 8080 }, listenOrigin: '',
        approvedConnects: 0, openUpstreamSockets: 0, socketsClosed: false, denials: [] as string[] };
    const sockets = new Set<Socket>();
    const upstreamSockets = new Set<Socket>();
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
        upstream.on('socket', socket => {
            upstreamSockets.add(socket);
            evidence.openUpstreamSockets = upstreamSockets.size;
            socket.once('close', () => {
                upstreamSockets.delete(socket);
                evidence.openUpstreamSockets = upstreamSockets.size;
            });
        });
        upstream.on('close', () => upstreamRequests.delete(upstream));
        upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end('QA endpoint unavailable.'); });
        incoming.on('aborted', () => upstream.destroy());
        outgoing.on('close', () => upstream.destroy());
        incoming.pipe(upstream);
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('connect', (incoming, socket, head) => {
        try { requireQaConnectAuthority(incoming.url); }
        catch (failure) {
            evidence.denials.push((failure as Error).message);
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        // Playwright's API/Route.fetch transport uses CONNECT even for HTTP.
        // Never parse, resolve or forward its authority: connect to this literal
        // endpoint only. This cannot provide an arbitrary-host/port tunnel.
        const upstream = tcpConnect({ host: '127.0.0.1', port: 8080 });
        upstreamSockets.add(upstream);
        evidence.openUpstreamSockets = upstreamSockets.size;
        const deadline = setTimeout(() => { upstream.destroy(); socket.destroy(); }, 5000);
        upstream.once('connect', () => {
            clearTimeout(deadline);
            evidence.approvedConnects += 1;
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => {
            clearTimeout(deadline);
            upstreamSockets.delete(upstream);
            evidence.openUpstreamSockets = upstreamSockets.size;
            socket.destroy();
        });
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
                const upstreamClosed = Promise.all([...upstreamSockets].map(upstream => new Promise<void>(done => upstream.once('close', () => done()))));
                upstreamRequests.forEach(upstream => upstream.destroy());
                upstreamSockets.forEach(upstream => upstream.destroy());
                sockets.forEach(socket => socket.destroy());
                server.close(() => { void upstreamClosed.then(() => { clearTimeout(timeout); resolve(); }); });
                server.closeAllConnections();
            });
            evidence.stoppedAt = new Date().toISOString();
            evidence.socketsClosed = sockets.size === 0 && upstreamSockets.size === 0;
            if (!evidence.socketsClosed) throw new Error('QA proxy teardown retained an owned socket.');
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
