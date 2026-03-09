import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/auth', '/onboarding', '/_next', '/favicon.ico', '/vendor', '/sw.js'];
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const ACCESS_TOKEN_COOKIE_MAX_AGE_SEC = 30 * 60;

function readCookie(request: NextRequest, name: string): string | undefined {
    const parsed = request.cookies.get(name)?.value;
    if (parsed) return parsed;

    const raw = request.headers.get('cookie') ?? '';
    if (!raw) return undefined;
    const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match?.[1];
}

function apiEndpoint(request: NextRequest, path: string): string {
    // Prefer internal service-to-service URL in production containers.
    if (INTERNAL_API_URL && INTERNAL_API_URL.startsWith('http')) {
        return `${INTERNAL_API_URL.replace(/\/$/, '')}${path}`;
    }

    // NEXT_PUBLIC_API_URL may be relative (e.g. "/api/v1").
    const relativeBase = API_URL.startsWith('/') ? API_URL : `/${API_URL}`;
    const base = API_URL.startsWith('http')
        ? API_URL.replace(/\/$/, '')
        : process.env.NODE_ENV === 'production'
            ? `http://api:3000${relativeBase}`
            : `${request.nextUrl.origin}${relativeBase}`;
    return `${base}${path}`;
}

export async function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;
    let refreshedAccessToken: string | null = null;
    const applyRefreshedCookie = (response: NextResponse): NextResponse => {
        if (refreshedAccessToken) {
            response.cookies.set('access_token', refreshedAccessToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                path: '/',
                maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE_SEC,
            });
        }
        return response;
    };

    // Always allow public paths through
    if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
        return NextResponse.next();
    }

    // Allow the root marketing page
    if (pathname === '/') {
        return NextResponse.next();
    }

    const accessToken = readCookie(request, 'access_token');

    // No token -> redirect to login
    if (!accessToken) {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = '/auth/login';
        loginUrl.searchParams.set('next', pathname);
        return NextResponse.redirect(loginUrl);
    }

    // Validate token server-side via the API
    let user: { sub: string; role: string; tenantId: string; sessionId: string } | null = null;
    try {
        const fetchUserByAccessToken = async (token: string) => {
            const response = await fetch(apiEndpoint(request, '/auth/me'), {
                headers: {
                    Cookie: `access_token=${token}`,
                    'Content-Type': 'application/json',
                },
                cache: 'no-store',
            });
            if (!response.ok) return { status: response.status, user: null as typeof user };
            const data = await response.json();
            return { status: response.status, user: data.user as typeof user };
        };

        const meResponse = await fetchUserByAccessToken(accessToken);
        if (meResponse.user) {
            user = meResponse.user;
        } else if (meResponse.status === 401) {
            // Try to refresh using refresh_token cookie
            const refreshToken = readCookie(request, 'refresh_token');
            if (refreshToken) {
                const refreshResponse = await fetch(apiEndpoint(request, '/auth/refresh'), {
                    method: 'POST',
                    headers: { Cookie: `refresh_token=${refreshToken}` },
                    cache: 'no-store',
                });

                if (refreshResponse.ok) {
                    const payload = await refreshResponse.json().catch(() => ({}));
                    const newToken = typeof (payload as any)?.accessToken === 'string'
                        ? (payload as any).accessToken
                        : '';

                    if (newToken) {
                        refreshedAccessToken = newToken;
                        const retriedMe = await fetchUserByAccessToken(newToken);
                        if (retriedMe.user) {
                            user = retriedMe.user;
                        }
                    }

                    // Backward-compatible fallback if token is not in JSON payload.
                    if (!user) {
                        const setCookieHeader = refreshResponse.headers.get('set-cookie');
                        if (setCookieHeader) {
                            const nextResponse = NextResponse.redirect(request.url);
                            nextResponse.headers.set('set-cookie', setCookieHeader);
                            return nextResponse;
                        }
                    }
                }
            }

            if (!user) {
                // Can't refresh -> boot to login
                const loginUrl = request.nextUrl.clone();
                loginUrl.pathname = '/auth/login';
                loginUrl.searchParams.set('next', pathname);
                const response = NextResponse.redirect(loginUrl);
                response.cookies.delete('access_token');
                response.cookies.delete('refresh_token');
                return response;
            }
        }
    } catch {
        // API unreachable -> allow through in dev, redirect to login in prod
        if (process.env.NODE_ENV === 'production') {
            const errorUrl = request.nextUrl.clone();
            errorUrl.pathname = '/auth/login';
            return NextResponse.redirect(errorUrl);
        }
        return NextResponse.next();
    }

    if (!user) {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = '/auth/login';
        return applyRefreshedCookie(NextResponse.redirect(loginUrl));
    }

    const isSuperAdmin = user.role === 'SUPER_ADMIN';

    if (isSuperAdmin && pathname.startsWith('/dashboard')) {
        const adminUrl = request.nextUrl.clone();
        adminUrl.pathname = '/admin';
        return applyRefreshedCookie(NextResponse.redirect(adminUrl));
    }

    if (!isSuperAdmin && pathname.startsWith('/admin')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        return applyRefreshedCookie(NextResponse.redirect(dashboardUrl));
    }

    if (pathname.startsWith('/dashboard/settings') && !['SUPER_ADMIN', 'ADMIN'].includes(user.role)) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        return applyRefreshedCookie(NextResponse.redirect(dashboardUrl));
    }

    if ((pathname.startsWith('/dashboard/staff') || pathname.startsWith('/dashboard/locations')) && user.role === 'STAFF') {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        return applyRefreshedCookie(NextResponse.redirect(dashboardUrl));
    }

    const response = NextResponse.next();
    response.headers.set('x-user-id', user.sub);
    response.headers.set('x-user-role', user.role);
    response.headers.set('x-tenant-id', user.tenantId ?? '');
    return applyRefreshedCookie(response);
}

export const config = {
    matcher: [
        '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|js\\.map)$).*)',
    ],
};
