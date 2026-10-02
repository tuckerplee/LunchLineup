import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';

// Unit-fixture transport only. Callers own app.close() in finally/afterEach.
// No external URL, configured port, redirect, retry, provider or data service.
const listeners = new WeakMap<FastifyInstance, Promise<number>>();
const DEADLINE_MS = 2_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
type Input = string | { url: string; method?: 'GET' | 'HEAD'; headers?: Record<string, string> };
type Response = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
  json(): Record<string, unknown>;
};
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function ownedPort(app: FastifyInstance): Promise<number> {
  let pending = listeners.get(app);
  if (!pending) {
    if (app.server.listening) throw new Error('Unit fixture must own its new loopback listener');
    pending = (async () => {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error('Unit loopback listen deadline exceeded'));
        }, DEADLINE_MS);
      });
      try {
        await Promise.race([app.listen({ host: '127.0.0.1', port: 0, signal: abort.signal }), deadline]);
        const address = app.server.address();
        if (!address || typeof address === 'string' || address.address !== '127.0.0.1'
          || !Number.isInteger(address.port) || address.port < 1 || address.port > 65_535) {
          abort.abort();
          throw new Error('Unit fixture did not obtain its own loopback TCP port');
        }
        return address.port;
      } finally { clearTimeout(timer); }
    })();
    listeners.set(app, pending);
  }
  const port = await pending;
  if (!app.server.listening) throw new Error('Unit loopback listener is closed');
  return port;
}

export async function requestLoopback(app: FastifyInstance, input: Input): Promise<Response> {
  const options = typeof input === 'string' ? { url: input } : input;
  if (!options.url.startsWith('/') || options.url.startsWith('//')
    || /[\x00-\x20\x7f]/.test(options.url) || Buffer.byteLength(options.url) > 4096) {
    throw new Error('Unit loopback request requires a bounded relative path');
  }
  const port = await ownedPort(app);
  return new Promise<Response>((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const client = request({
      hostname: '127.0.0.1', port, path: options.url, method: options.method ?? 'GET',
      headers: { ...options.headers, connection: 'close' }, agent: false,
    });
    function fail(error: Error): void {
      if (settled) return;
      settled = true; clearTimeout(timer);
      response?.destroy(); client.destroy(); reject(error);
    }
    timer = setTimeout(() => fail(new Error('Unit loopback request deadline exceeded')), DEADLINE_MS);
    client.on('error', fail);
    client.on('response', incoming => {
      response = incoming;
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on('error', fail);
      incoming.on('aborted', () => fail(new Error('Unit loopback response aborted')));
      incoming.on('close', () => {
        if (!settled) fail(new Error('Unit loopback response closed before completion'));
      });
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          fail(new Error('Unit loopback response body limit exceeded'));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('end', () => {
        if (settled) return;
        if (!incoming.complete || incoming.statusCode === undefined) {
          fail(new Error('Unit loopback response incomplete'));
          return;
        }
        const body = Buffer.concat(chunks, bytes).toString('utf8');
        settled = true; clearTimeout(timer); client.destroy();
        resolve({ statusCode: incoming.statusCode, headers: incoming.headers, body,
          json() {
            const value: unknown = JSON.parse(body);
            if (!isObject(value)) throw new Error('Unit response must be a JSON object');
            return value;
          },
        });
      });
    });
    client.end();
  });
}
