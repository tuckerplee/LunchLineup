import { NextRequest, NextResponse } from 'next/server';

const API = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/v1';

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
    await fetch(`${API}/auth/logout`, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
    });
  } catch {
    // Best effort; always clear browser cookies locally below.
  }

  const response = NextResponse.redirect(new URL('/auth/login', request.url));
  response.cookies.set('access_token', '', { path: '/', maxAge: 0 });
  response.cookies.set('refresh_token', '', { path: '/', maxAge: 0 });
  response.cookies.set('csrf_token', '', { path: '/', maxAge: 0 });
  return response;
}

