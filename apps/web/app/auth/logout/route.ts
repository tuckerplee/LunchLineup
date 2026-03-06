import { NextRequest, NextResponse } from 'next/server';

function apiBase(request: NextRequest): string {
  const internal = process.env.INTERNAL_API_URL;
  if (internal && internal.startsWith('http')) return internal.replace(/\/$/, '');

  const publicApi = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
  if (publicApi.startsWith('http')) return publicApi.replace(/\/$/, '');
  const relativeApi = publicApi.startsWith('/') ? publicApi : `/${publicApi}`;
  return `${request.nextUrl.origin}${relativeApi}`;
}

function redirectOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || request.headers.get('host') || request.nextUrl.host;
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const isLocalHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const isIpHost = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host);
  const proto = (!isLocalHost && !isIpHost) ? 'https' : (forwardedProto || request.nextUrl.protocol.replace(':', ''));
  return `${proto}://${host}`;
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

  const cookie = request.headers.get('cookie') ?? '';
  try {
    await fetch(`${apiBase(request)}/auth/logout`, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
    });
  } catch {
    // Best effort; always clear browser cookies locally below.
  }

  const response = NextResponse.redirect(`${redirectOrigin(request)}/auth/login`);
  response.cookies.set('access_token', '', { path: '/', maxAge: 0 });
  response.cookies.set('refresh_token', '', { path: '/', maxAge: 0 });
  response.cookies.set('csrf_token', '', { path: '/', maxAge: 0 });
  return response;
}
