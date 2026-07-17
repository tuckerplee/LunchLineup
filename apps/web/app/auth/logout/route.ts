import { NextRequest, NextResponse } from 'next/server';

import { readBoundedJson, withRequestTimeout } from '../../../lib/http-safety';
import { parseApprovedAppOrigin } from '../../../lib/safe-navigation';

const AUTH_FETCH_TIMEOUT_MS = 5_000;
const AUTH_RESPONSE_LIMIT_BYTES = 8 * 1024;

function parseServiceBase(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function approvedAppOrigin(request: NextRequest): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim()
    || process.env.APP_ORIGIN?.trim();
  if (configured) {
    return parseApprovedAppOrigin(configured, process.env.NODE_ENV === 'production');
  }
  if (process.env.NODE_ENV === 'production') return null;

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || request.headers.get('host');
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProtocol || request.nextUrl.protocol.replace(':', '');
  if (host && (protocol === 'https' || protocol === 'http')) {
    return parseApprovedAppOrigin(`${protocol}://${host}`, false);
  }
  return parseApprovedAppOrigin(request.nextUrl.origin, false);
}

function apiBase(appOrigin: string): string | null {
  const internal = process.env.INTERNAL_API_URL?.trim();
  if (internal) return parseServiceBase(internal);

  const publicApi = (process.env.NEXT_PUBLIC_API_URL ?? '/api/v1').trim();
  if (/^https?:/i.test(publicApi)) {
    const parsed = parseServiceBase(publicApi);
    return parsed && new URL(parsed).origin === appOrigin ? parsed : null;
  }

  const relativeApi = publicApi.startsWith('/') ? publicApi : `/${publicApi}`;
  return process.env.NODE_ENV === 'production'
    ? `http://api:3000${relativeApi}`
    : `${appOrigin}${relativeApi}`;
}

function safeCookieValue(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~+\/=:-]{1,4096}$/.test(value);
}

function authCookieHeader(request: NextRequest): string {
  return ['access_token', 'refresh_token', 'csrf_token']
    .map((name) => {
      const value = request.cookies.get(name)?.value;
      return safeCookieValue(value) ? `${name}=${value}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .join('; ');
}

function csrfHeaders(request: NextRequest): Record<string, string> {
  const csrfToken = request.cookies.get('csrf_token')?.value;
  return safeCookieValue(csrfToken) ? { 'x-csrf-token': csrfToken } : {};
}

function isSameOriginNavigation(request: NextRequest, expectedOrigin: string): boolean {
  if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') return false;

  for (const header of ['origin', 'referer']) {
    const value = request.headers.get(header);
    if (!value) continue;
    try {
      if (new URL(value).origin !== expectedOrigin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function hasAuthoritativeRevocation(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const result = payload as { success?: unknown; session?: unknown };
  return result.success === true
    && (result.session === 'revoked' || result.session === 'already_invalid');
}

function clearBrowserAuthCookies(response: NextResponse): NextResponse {
  response.cookies.set('access_token', '', { path: '/', maxAge: 0 });
  response.cookies.set('refresh_token', '', { path: '/', maxAge: 0 });
  response.cookies.set('csrf_token', '', { path: '/', maxAge: 0 });
  return response;
}

function isPrefetch(request: NextRequest): boolean {
  const purpose = request.headers.get('purpose')?.toLowerCase() ?? '';
  const secPurpose = request.headers.get('sec-purpose')?.toLowerCase() ?? '';
  const nextPrefetch = request.headers.get('next-router-prefetch');
  return Boolean(nextPrefetch) || purpose.includes('prefetch') || secPurpose.includes('prefetch');
}

function unavailable(message: string): NextResponse {
  return new NextResponse(message, {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
      'Retry-After': '5',
    },
  });
}

export async function GET(request: NextRequest) {
  if (isPrefetch(request)) return new NextResponse(null, { status: 204 });

  const origin = approvedAppOrigin(request);
  if (!origin) return unavailable('Unable to sign out. Please try again.');
  if (!isSameOriginNavigation(request, origin)) {
    return new NextResponse('Unable to sign out.', { status: 403 });
  }

  const base = apiBase(origin);
  if (!base) return unavailable('Unable to sign out. Please try again.');
  const cookie = authCookieHeader(request);
  let revoked = false;
  try {
    revoked = await withRequestTimeout(async (signal) => {
      const logoutResponse = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: {
          ...(cookie ? { cookie } : {}),
          ...csrfHeaders(request),
          Origin: origin,
          Referer: new URL(request.nextUrl.pathname, origin).toString(),
        },
        cache: 'no-store',
        redirect: 'error',
        signal,
      });
      if (!logoutResponse.ok) {
        await logoutResponse.body?.cancel().catch(() => undefined);
        return false;
      }
      const contentType = logoutResponse.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        await logoutResponse.body?.cancel().catch(() => undefined);
        return false;
      }
      return hasAuthoritativeRevocation(
        await readBoundedJson(logoutResponse, AUTH_RESPONSE_LIMIT_BYTES),
      );
    }, AUTH_FETCH_TIMEOUT_MS);
  } catch {
    // Preserve browser credentials when server-side revocation is uncertain.
  }

  if (!revoked) return unavailable('Unable to sign out. Please try again.');

  return clearBrowserAuthCookies(
    NextResponse.redirect(new URL('/auth/login', origin)),
  );
}

export async function POST(request: NextRequest) {
  const origin = approvedAppOrigin(request);
  if (!origin) return unavailable('Unable to clear this browser session.');
  if (!isSameOriginNavigation(request, origin)) {
    return new NextResponse('Unable to clear this browser session.', { status: 403 });
  }
  if (request.headers.get('x-account-deletion-complete') !== '1') {
    return new NextResponse('Missing account deletion confirmation.', { status: 400 });
  }

  return clearBrowserAuthCookies(new NextResponse(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  }));
}