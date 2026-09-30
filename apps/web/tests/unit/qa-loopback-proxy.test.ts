import { once } from 'node:events';
import type { Server, RequestOptions, IncomingMessage } from 'node:http';
import type { AddressInfo, Socket, TcpNetConnectOpts } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({
    targetPort: 0, accepted: [] as Socket[], upstream: [] as Socket[], server: undefined as Server | undefined,
    connections: 0, serverClosedBeforeSocket: false, downstreamClosed: new Set<Socket>(),
}));
vi.mock('node:http', async importOriginal => {
    const actual = await importOriginal<typeof import('node:http')>();
    return { ...actual,
        createServer: (...args: Parameters<typeof actual.createServer>) => {
            const server = actual.createServer(...args);
            observed.server = server;
            server.on('connection', socket => {
                observed.accepted.push(socket); socket.once('close', () => observed.downstreamClosed.add(socket));
            });
            server.on('close', () => { observed.serverClosedBeforeSocket = observed.accepted.some(socket => !observed.downstreamClosed.has(socket)); });
            return server;
        },
        request: (options: RequestOptions, callback?: (response: IncomingMessage) => void) => {
            // Intercept the fixed application transport BEFORE any connection.
            // Every actual upstream connection goes to our own ephemeral target.
            expect(options.hostname).toBe('127.0.0.1'); expect(options.port).toBe(8080);
            expect(observed.targetPort).toBeGreaterThan(0);
            observed.connections++;
            const request = actual.request({ ...options, port: observed.targetPort }, callback);
            request.on('socket', socket => { observed.upstream.push(socket); });
            return request;
        },
    };
});
vi.mock('node:net', async importOriginal => {
    const actual = await importOriginal<typeof import('node:net')>();
    return { ...actual, connect: (options: TcpNetConnectOpts) => {
        expect(options.host).toBe('127.0.0.1'); expect(options.port).toBe(8080);
        expect(observed.targetPort).toBeGreaterThan(0);
        observed.connections++;
        const socket = actual.connect({ ...options, port: observed.targetPort });
        observed.upstream.push(socket);
        return socket;
    } };
});
import { startQaLoopbackProxy } from '../e2e/qa-loopback-proxy';

const actualNet = await vi.importActual<typeof import('node:net')>('node:net');
const actualHttp = await vi.importActual<typeof import('node:http')>('node:http');
const ownedSockets = new Set<Socket>();
const ownedServers = new Set<Server>();
const proxies: Awaited<ReturnType<typeof startQaLoopbackProxy>>[] = [];
async function proxy() { const value = await startQaLoopbackProxy(); proxies.push(value); return value; }
async function downstream(origin: string) {
    const url = new URL(origin);
    const socket = actualNet.connect({ host: '127.0.0.1', port: Number(url.port) });
    ownedSockets.add(socket); socket.on('error', () => undefined);
    const accepted = once(observed.server!, 'connection');
    await Promise.all([once(socket, 'connect'), accepted]);
    return socket;
}
async function target() {
    // Withhold HTTP response; an actual upstream remains open until teardown.
    const server = actualHttp.createServer(); ownedServers.add(server);
    server.on('connection', socket => { ownedSockets.add(socket); socket.on('error', () => undefined); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    observed.targetPort = (server.address() as AddressInfo).port;
    return server;
}
afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    const failures: unknown[] = [];
    for (const p of proxies.splice(0)) { try { await p.close(); } catch (error) { failures.push(error); } }
    const closed = [...ownedSockets].filter(socket => !socket.closed).map(socket => once(socket, 'close'));
    ownedSockets.forEach(socket => socket.destroy());
    await Promise.all(closed);
    await Promise.all([...ownedServers].map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    })));
    ownedSockets.clear(); ownedServers.clear();
    observed.accepted = []; observed.upstream = []; observed.server = undefined;
    observed.targetPort = 0; observed.connections = 0; observed.serverClosedBeforeSocket = false;
    observed.downstreamClosed.clear();
    // Individual failure-path cases consume their expected rejection first.
    if (failures.length) throw new AggregateError(failures, 'Test proxy cleanup failed');
});

describe('owned QA proxy socket teardown', () => {
    it('waits for actual downstream close events even when server close completes first', async () => {
        const p = await proxy(); await downstream(p.evidence.listenOrigin);
        const accepted = observed.accepted[0]; let closed = false;
        accepted.once('close', () => { closed = true; });
        await expect(p.close()).resolves.toBeUndefined();
        expect(observed.serverClosedBeforeSocket).toBe(true);
        expect(closed).toBe(true); expect(accepted.closed).toBe(true);
        expect(p.evidence.socketsClosed).toBe(true); expect(p.evidence.stoppedAt).not.toBe('');
        expect(observed.connections).toBe(0);
    });
    it.each(['CONNECT', 'HTTP'] as const)('closes real downstream and %s upstream sockets before publishing success', async transport => {
        const upstreamTarget = await target(); const p = await proxy();
        const reached = once(upstreamTarget, 'connection');
        const client = await downstream(p.evidence.listenOrigin);
        if (transport === 'CONNECT') {
            const response = once(client, 'data');
            client.write('CONNECT 127.0.0.1:8080 HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n');
            expect(String((await response)[0])).toContain('200 Connection Established');
        } else {
            const request = once(upstreamTarget, 'request');
            client.write('GET http://127.0.0.1:8080/pending HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n');
            await request;
        }
        await reached;
        expect(p.evidence.openUpstreamSockets).toBe(1);
        const all = [...observed.accepted, ...observed.upstream];
        const closed = new Set<Socket>(); all.forEach(socket => socket.once('close', () => closed.add(socket)));
        const first = p.close(), second = p.close();
        expect(first).toBe(second); await first;
        expect(closed.size).toBe(all.length); expect(all.every(socket => socket.closed)).toBe(true);
        expect(p.evidence.socketsClosed).toBe(true); expect(p.evidence.openUpstreamSockets).toBe(0);
        expect(observed.connections).toBe(1); expect(p.evidence.denials).toEqual([]);
        await expect(p.close()).resolves.toBeUndefined();
    });
    it('denies HTTP and CONNECT destinations before any real or mapped upstream connection', async () => {
        const p = await proxy();
        for (const request of ['CONNECT denied.invalid:443 HTTP/1.1\r\nHost: denied.invalid\r\n\r\n',
            'GET http://denied.invalid/path HTTP/1.1\r\nHost: denied.invalid\r\n\r\n']) {
            const client = await downstream(p.evidence.listenOrigin); const response = once(client, 'data');
            client.write(request); expect(String((await response)[0])).toContain('403');
        }
        await p.close(); expect(observed.connections).toBe(0);
        expect(p.evidence.denials).toHaveLength(2); expect(p.evidence.socketsClosed).toBe(true);
    });
    it('includes a real accepted socket whose ownership callback arrives after close began', async () => {
        const p = await proxy(); await downstream(p.evidence.listenOrigin);
        const server = observed.server!;
        const track = server.listeners('connection').at(-1)! as (socket: Socket) => void;
        // Delay only the proxy's ownership callback for an actual accepted TCP
        // socket; Node's native connection ownership remains in effect.
        server.removeListener('connection', track);
        await downstream(p.evidence.listenOrigin);
        const late = observed.accepted[1]; let lateClosed = false;
        late.once('close', () => { lateClosed = true; });
        const closing = p.close();
        expect(late.destroyed).toBe(true); // Native closeAllConnections destroys it first.
        expect(lateClosed).toBe(false); // Destruction has not delivered the close event.
        track(late);
        expect(late.destroyed).toBe(true);
        await closing;
        expect(lateClosed).toBe(true); expect(p.evidence.socketsClosed).toBe(true);
        expect(observed.connections).toBe(0);
    });
    it('rejects at one five-second deadline when a destroyed owned socket has not delivered close', async () => {
        const p = await proxy(); await downstream(p.evidence.listenOrigin);
        const socket = observed.accepted[0];
        const emit = socket.emit.bind(socket);
        let release!: () => void, reached!: () => void;
        const withheld = new Promise<void>(resolve => { reached = resolve; });
        const intercepted = vi.spyOn(socket, 'emit').mockImplementation((event: string | symbol, ...args: unknown[]) => {
            if (event === 'close') { release = () => { emit(event, ...args); }; reached(); return false; }
            return emit(event, ...args);
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const closing = p.close(); let settled = false;
        const outcome = closing.then(() => { settled = true; return undefined; }, failure => { settled = true; return failure; });
        try {
            await withheld; // Actual kernel socket closes; its event is deliberately withheld.
            expect(socket.destroyed).toBe(true); expect(socket.closed).toBe(true);
            await vi.advanceTimersByTimeAsync(4999); expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            const failure = await outcome;
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors.map(String)).toContain('Error: QA proxy close deadline exceeded.');
            expect(p.evidence.socketsClosed).toBe(false); expect(p.evidence.stoppedAt).toBe('');
            expect(p.close()).toBe(closing); await expect(p.close()).rejects.toBe(failure);
        } finally {
            intercepted.mockRestore(); release(); vi.useRealTimers();
            proxies.splice(proxies.indexOf(p), 1); // Expected rejection remains sealed; actual sockets released.
        }
        expect(observed.downstreamClosed.has(socket)).toBe(true);
        expect(p.evidence.socketsClosed).toBe(false); // Later events cannot promote a rejected receipt.
    });
    it('preserves native server-close and socket-destroy failures while still closing all owned sockets', async () => {
        const p = await proxy(); await downstream(p.evidence.listenOrigin);
        const server = observed.server!, socket = observed.accepted[0];
        const close = server.close.bind(server), destroy = socket.destroy.bind(socket);
        const closeFailure = new Error('native server close failed'), destroyFailure = new Error('owned socket destroy failed');
        vi.spyOn(server, 'close').mockImplementation(callback => close(failure => callback?.(failure ?? closeFailure)));
        vi.spyOn(socket, 'destroy').mockImplementation(error => { destroy(error); throw destroyFailure; });
        const closing = p.close();
        try {
            const failure = await closing.catch(error => error);
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors).toContain(closeFailure);
            expect((failure as AggregateError).errors).toContain(destroyFailure);
            expect(observed.downstreamClosed.has(socket)).toBe(true);
            expect(p.evidence.socketsClosed).toBe(false); expect(p.evidence.stoppedAt).toBe('');
            await expect(p.close()).rejects.toBe(failure);
        } finally { vi.restoreAllMocks(); proxies.splice(proxies.indexOf(p), 1); }
    });
});
