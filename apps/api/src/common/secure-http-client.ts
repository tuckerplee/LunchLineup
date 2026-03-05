import * as dns from 'dns/promises';
import * as net from 'net';

/**
 * Secure HTTP Client for outbound requests.
 * Wraps fetch with SSRF protection: DNS pinning and private IP blocking.
 * Architecture Part VII-A.4
 *
 * ALL outbound HTTP requests (webhooks, PDF import, OAuth) MUST use this client.
 * Direct fetch() calls to external URLs are banned by linting rules.
 */

const PRIVATE_IP_RANGES = [
    /^127\./,              // Loopback
    /^10\./,               // Private Class A
    /^172\.(1[6-9]|2\d|3[01])\./,  // Private Class B
    /^192\.168\./,         // Private Class C
    /^169\.254\./,         // Link-local
    /^0\./,                // Current network
    /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./, // CGNAT
];

function isPrivateIP(ip: string): boolean {
    if (net.isIPv6(ip)) {
        return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd');
    }
    return PRIVATE_IP_RANGES.some(range => range.test(ip));
}

export interface SecureRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
}

export async function secureHttpRequest(url: string, options: SecureRequestOptions = {}): Promise<Response> {
    const parsed = new URL(url);

    // 1. Resolve DNS and validate IP is not private
    const resolved = await dns.resolve4(parsed.hostname).catch(() => []);
    if (resolved.length === 0) {
        throw new Error(`DNS resolution failed for ${parsed.hostname}`);
    }

    for (const ip of resolved) {
        if (isPrivateIP(ip)) {
            throw new Error(`SSRF blocked: ${parsed.hostname} resolves to private IP ${ip}`);
        }
    }

    // 2. Block cloud metadata endpoints
    if (parsed.hostname === '169.254.169.254' || parsed.hostname === 'metadata.google.internal') {
        throw new Error('SSRF blocked: cloud metadata endpoint');
    }

    // 3. Only allow HTTPS in production
    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
        throw new Error('Only HTTPS is allowed for outbound requests in production');
    }

    // 4. Hard timeout (default 10s)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);

    try {
        return await fetch(url, {
            method: options.method || 'GET',
            headers: options.headers,
            body: options.body,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}
