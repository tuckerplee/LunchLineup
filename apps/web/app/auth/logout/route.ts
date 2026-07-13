import { NextRequest, NextResponse } from 'next/server';

function apiBase(request: NextRequest): string {
  const internal = process.env.INTERNAL_API_URL;
  if (internal && internal.startsWith('http')) return internal.replace(/\/$/, '');

  const publicApi = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
  if (publicApi.startsWith('http')) return publicApi.replace(/\/$/, '');
  const relativeApi = publicApi.startsWith('/') ? publicApi : `/${publicApi}`;
  return `${request.nextUrl.origin}${relativeApi}`;
}

function appOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_ORIGIN;
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return parsed.origin;
      }
    } catch {
      // Fall back to the request origin below.
    }
  }
  return request.nextUrl.origin;
}

function csrfHeaders(request: NextRequest): Record<string, string> {
  const csrfToken = request.cookies.get('csrf_token')?.value;
  return csrfToken ? { 'x-csrf-token': csrfToken } : {};
}

function isSameOriginNavigation(request: NextRequest): boolean {
  if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') return false;

  const expectedOrigin = appOrigin(request);
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

async function hasAuthoritativeRevocation(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  const payload = await response.json().catch(() => null) as {
    success?: unknown;
    session?: unknown;
  } | null;
  return payload?.success === true
    && (payload.session === 'revoked' || payload.session === 'already_invalid');
}

function isPrefetch(request: NextRequest): boolean {
  const purpose = request.headers.get('purpose')?.toLowerCase() ?? '';
  const secPurpose = request.headers.get('sec-purpose')?.toLowerCase() ?? '';
  const nextPrefetch = request.headers.get('next-router-prefetch');
  return Boolean(nextPrefetch) || purpose.includes('prefetch') || secPurpose.includes('prefetch');
}

export async function GET(request: NextRequest) {
  if (isPrefetch(request)) {
    return new NextResponse(null, { status: 204 });
  }

  if (!isSameOriginNavigation(request)) {
    return new NextResponse('Unable to sign out.', { status: 403 });
  }

  const cookie = request.headers.get('cookie') ?? '';
  let revoked = false;
  try {
    const origin = appOrigin(request);
    const logoutResponse = await fetch(`${apiBase(request)}/auth/logout`, {
      method: 'POST',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...csrfHeaders(request),
        Origin: origin,
        Referer: new URL(request.nextUrl.pathname, origin).toString(),
      },
      cache: 'no-store',
    });
    revoked = await hasAuthoritativeRevocation(logoutResponse);
  } catch {
    // Preserve browser credentials when server-side revocation is uncertain.
  }

  if (!revoked) {
    return new NextResponse('Unable to sign out. Please try again.', { status: 503 });
  }

  const response = NextResponse.redirect(new URL('/auth/login', appOrigin(request)));
  response.cookies.set('access_token', '', { path: '/', maxAge: 0 });
  response.cookies.set('refresh_token', '', { path: '/', maxAge: 0 });
  response.cookies.set('csrf_token', '', { path: '/', maxAge: 0 });
  return response;
}
