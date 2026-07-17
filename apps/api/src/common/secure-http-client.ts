import * as dns from 'dns/promises';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

/**
 * Secure HTTP Client for outbound requests.
 * Uses a validated DNS result for the socket connection, then blocks private,
 * link-local, metadata, IPv6, unsupported-protocol, timeout, and redirect risks.
 * Architecture Part VII-A.4
 *
 * ALL outbound HTTP requests (webhooks, PDF import, OAuth) MUST use this client.
 * Direct fetch() calls to external URLs are banned by linting rules.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const METADATA_HOSTNAMES = new Set([
    '169.254.169.254',
    'metadata.google.internal',
]);

type AllowedProtocol = 'http:' | 'https:';
type RedirectMode = 'error' | 'manual';

type ResolvedAddress = {
    address: string;
    family: number;
};

function isPrivateIP(ip: string): boolean {
    if (net.isIPv6(ip)) {
        return true;
    }

    const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }

    const [a, b, c] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
    );
}

export interface SecureRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
    allowedProtocols?: AllowedProtocol[];
    redirect?: RedirectMode;
}

export async function secureHttpRequest(url: string, options: SecureRequestOptions = {}): Promise<Response> {
    const deadlineAtMs = Date.now() + normalizeTimeout(options.timeoutMs);
    const parsed = new URL(url);
    const allowedProtocols = options.allowedProtocols ?? defaultAllowedProtocols();
    if (!allowedProtocols.includes(parsed.protocol as AllowedProtocol)) {
        throw new Error(`Unsupported outbound protocol: ${parsed.protocol}`);
    }

    if (parsed.username || parsed.password) {
        throw new Error('Outbound URLs with embedded credentials are not allowed');
    }

    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) {
        throw new Error('Outbound URL must include a hostname');
    }

    if (METADATA_HOSTNAMES.has(hostname)) {
        throw new Error('SSRF blocked: cloud metadata endpoint');
    }

    const resolved = await beforeDeadline(resolveHostname(hostname), deadlineAtMs);
    if (resolved.length === 0) {
        throw new Error(`DNS resolution failed for ${parsed.hostname}`);
    }

    for (const entry of resolved) {
        if (entry.family === 6 || net.isIPv6(entry.address)) {
            throw new Error(`SSRF blocked: IPv6 destination ${entry.address}`);
        }
        if (isPrivateIP(entry.address)) {
            throw new Error(`SSRF blocked: ${parsed.hostname} resolves to private IP ${entry.address}`);
        }
    }

    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
        throw new Error('Only HTTPS is allowed for outbound requests in production');
    }

    return requestPinnedAddress(parsed, hostname, resolved[0].address, options, deadlineAtMs);
}

function defaultAllowedProtocols(): AllowedProtocol[] {
    return process.env.NODE_ENV === 'production' ? ['https:'] : ['http:', 'https:'];
}

function normalizeHostname(hostname: string): string {
    return hostname
        .trim()
        .toLowerCase()
        .replace(/^\[(.*)]$/, '$1')
        .replace(/\.$/, '');
}

async function resolveHostname(hostname: string): Promise<ResolvedAddress[]> {
    const literalFamily = net.isIP(hostname);
    if (literalFamily) {
        return [{ address: hostname, family: literalFamily }];
    }

    try {
        const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
    } catch {
        return [];
    }
}

async function beforeDeadline<T>(operation: Promise<T>, deadlineAtMs: number): Promise<T> {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
        throw new Error('Outbound request timed out');
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new Error('Outbound request timed out')),
                    remainingMs,
                );
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function requestPinnedAddress(
    parsed: URL,
    normalizedHostname: string,
    address: string,
    options: SecureRequestOptions,
    deadlineAtMs: number,
): Promise<Response> {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
        return Promise.reject(new Error('Outbound request timed out'));
    }
    const maxResponseBytes = normalizeMaxResponseBytes(options.maxResponseBytes);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    const transport = parsed.protocol === 'https:' ? https : http;
    const requestOptions: http.RequestOptions & https.RequestOptions = {
        protocol: parsed.protocol,
        hostname: address,
        port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers: requestHeaders(options.headers, parsed, options.body),
        signal: controller.signal,
    };

    if (parsed.protocol === 'https:' && !net.isIP(normalizedHostname)) {
        requestOptions.servername = normalizedHostname;
    }

    return new Promise<Response>((resolve, reject) => {
        const req = transport.request(requestOptions, (res) => {
            const status = res.statusCode ?? 0;
            const redirectMode = options.redirect ?? 'error';
            if (redirectMode === 'error' && status >= 300 && status < 400) {
                res.resume();
                reject(new Error('Outbound redirects are disabled'));
                return;
            }

            let declaredResponseBytes: number | null;
            try {
                declaredResponseBytes = parseContentLength(res.headers['content-length']);
            } catch (error) {
                res.resume();
                reject(error);
                return;
            }
            if (declaredResponseBytes !== null && declaredResponseBytes > maxResponseBytes) {
                res.resume();
                reject(new Error('Outbound response exceeded size limit'));
                return;
            }

            const chunks: Buffer[] = [];
            let receivedBytes = 0;
            res.on('data', (chunk) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                receivedBytes += buffer.length;
                if (receivedBytes > maxResponseBytes) {
                    req.destroy(new Error('Outbound response exceeded size limit'));
                    return;
                }
                chunks.push(buffer);
            });
            res.on('end', () => {
                clearTimeout(timeout);
                const body = Buffer.concat(chunks);
                resolve(new Response(canHaveResponseBody(status) && body.length > 0 ? body : null, {
                    status,
                    statusText: res.statusMessage,
                    headers: responseHeaders(res.headers),
                }));
            });
            res.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        });

        req.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    }).finally(() => clearTimeout(timeout));
}

function requestHeaders(headers: Record<string, string> | undefined, parsed: URL, body: string | undefined): Record<string, string> {
    const requestHeaderMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (key.toLowerCase() !== 'host') {
            requestHeaderMap[key] = value;
        }
    }

    requestHeaderMap.Host = parsed.host;
    if (body && !hasHeader(requestHeaderMap, 'content-length')) {
        requestHeaderMap['Content-Length'] = Buffer.byteLength(body).toString();
    }

    return requestHeaderMap;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
    return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function responseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
    const responseHeaderMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
            responseHeaderMap[key] = value.join(', ');
        } else if (value !== undefined) {
            responseHeaderMap[key] = String(value);
        }
    }

    return responseHeaderMap;
}

function parseContentLength(value: string | string[] | undefined): number | null {
    if (value === undefined) {
        return null;
    }

    const normalized = Array.isArray(value) ? value.join(',') : value.trim();
    if (!/^\d+$/.test(normalized)) {
        throw new Error('Outbound response content length is invalid');
    }

    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error('Outbound response content length is invalid');
    }

    return parsed;
}

function canHaveResponseBody(status: number): boolean {
    return status !== 204 && status !== 304;
}

function normalizeTimeout(timeoutMs?: number): number {
    if (!Number.isFinite(timeoutMs) || !timeoutMs || timeoutMs <= 0) {
        return DEFAULT_TIMEOUT_MS;
    }

    return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

function normalizeMaxResponseBytes(maxResponseBytes?: number): number {
    if (!Number.isFinite(maxResponseBytes) || !maxResponseBytes || maxResponseBytes <= 0) {
        return DEFAULT_MAX_RESPONSE_BYTES;
    }

    return Math.min(Math.floor(maxResponseBytes), MAX_RESPONSE_BYTES);
}
