import { randomBytes } from 'node:crypto';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
const CLOUDFLARE_ANALYTICS_CONNECT_ORIGIN = 'https://cloudflareinsights.com';

function configuredBrowserApiOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (!configured || configured.startsWith('/')) return null;
  try {
    const url = new URL(configured);
    const allowedProtocols = process.env.NODE_ENV === 'production' ? ['https:'] : ['http:', 'https:'];
    if (!allowedProtocols.includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(nonce: string): string {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(nonce)) throw new Error('invalid_csp_nonce');
  const connectSources = [
    "'self'",
    TURNSTILE_ORIGIN,
    CLOUDFLARE_ANALYTICS_CONNECT_ORIGIN,
    configuredBrowserApiOrigin(),
    ...(process.env.NODE_ENV === 'production' ? [] : ['http://localhost:*', 'http://127.0.0.1:*']),
  ].filter((value): value is string => Boolean(value));
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `frame-src 'self' ${TURNSTILE_ORIGIN}`,
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TURNSTILE_ORIGIN} ${CLOUDFLARE_ANALYTICS_SCRIPT_ORIGIN}${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
    "script-src-attr 'none'",
    `connect-src ${[...new Set(connectSources)].join(' ')}`,
    ...(process.env.NODE_ENV === 'production' ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function createContentSecurityPolicy(): { nonce: string; policy: string } {
  const nonce = randomBytes(16).toString('base64');
  return { nonce, policy: buildContentSecurityPolicy(nonce) };
}
