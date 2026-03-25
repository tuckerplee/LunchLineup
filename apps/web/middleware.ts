import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/auth', '/onboarding', '/_next', '/favicon.ico', '/vendor', '/sw.js'];
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const ACCESS_TOKEN_COOKIE_MAX_AGE_SEC = 30 * 60;
const AUTH_DEBUG_ENABLED = ['1', 'true', 'yes', 'on'].includes((process.env.AUTH_DEBUG ?? '').toLowerCase());

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

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return 'unknown_error';
    }
}

function shouldDebugAuth(request: NextRequest): boolean {
    if (AUTH_DEBUG_ENABLED) return true;
    return request.nextUrl.searchParams.get('__auth_debug') === '1' || request.headers.get('x-auth-debug') === '1';
}

export async function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;
    const startedAt = Date.now();
    const requestId = request.headers.get('x-request-id')
        ?? request.headers.get('cf-ray')
        ?? `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const debugEnabled = shouldDebugAuth(request);
    const authDebug = (event: string, details: Record<string, unknown> = {}) => {
        if (!debugEnabled) return;
        const payload = {
            scope: 'web.middleware',
            event,
            requestId,
            method: request.method,
            path: request.nextUrl.pathname,
            search: request.nextUrl.search || '',
            host: request.headers.get('host') ?? '',
            durationMs: Date.now() - startedAt,
            ...details,
        };
        console.info(`[auth-debug] ${JSON.stringify(payload)}`);
    };

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
        authDebug('allow_public_path');
        return NextResponse.next();
    }

    // Allow the root marketing page
    if (pathname === '/') {
        authDebug('allow_root');
        return NextResponse.next();
    }

    const accessToken = readCookie(request, 'access_token');

    // No token -> redirect to login
    if (!accessToken) {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = '/auth/login';
        loginUrl.searchParams.set('next', pathname);
        authDebug('redirect_login_missing_access_token', {
            next: pathname,
            hasRefreshToken: Boolean(readCookie(request, 'refresh_token')),
        });
        return NextResponse.redirect(loginUrl);
    }

    // Validate token server-side via the API
    let user: { sub: string; role: string; tenantId: string; sessionId: string; permissions?: string[]; roles?: Array<{ id: string; name: string }> } | null = null;
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
            authDebug('auth_me_ok', { role: meResponse.user.role });
        } else if (meResponse.status === 401) {
            // Try to refresh using refresh_token cookie
            const refreshToken = readCookie(request, 'refresh_token');
            authDebug('auth_me_unauthorized', { hasRefreshToken: Boolean(refreshToken) });
            if (refreshToken) {
                const refreshResponse = await fetch(apiEndpoint(request, '/auth/refresh'), {
                    method: 'POST',
                    headers: { Cookie: `refresh_token=${refreshToken}` },
                    cache: 'no-store',
                });
                authDebug('auth_refresh_response', { status: refreshResponse.status, ok: refreshResponse.ok });

                if (refreshResponse.ok) {
                    const payload = await refreshResponse.json().catch(() => ({}));
                    const newToken = typeof (payload as any)?.accessToken === 'string'
                        ? (payload as any).accessToken
                        : '';
                    authDebug('auth_refresh_payload', { hasAccessToken: Boolean(newToken) });

                    if (newToken) {
                        refreshedAccessToken = newToken;
                        const retriedMe = await fetchUserByAccessToken(newToken);
                        if (retriedMe.user) {
                            user = retriedMe.user;
                            authDebug('auth_refresh_retry_me_ok', { role: retriedMe.user.role });
                        } else {
                            authDebug('auth_refresh_retry_me_failed', { status: retriedMe.status });
                        }
                    }

                    // Backward-compatible fallback if token is not in JSON payload.
                    if (!user) {
                        const setCookieHeader = refreshResponse.headers.get('set-cookie');
                        if (setCookieHeader) {
                            const nextResponse = NextResponse.redirect(request.url);
                            nextResponse.headers.set('set-cookie', setCookieHeader);
                            authDebug('auth_refresh_set_cookie_fallback_redirect', { to: request.url });
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
                authDebug('redirect_login_refresh_failed', { next: pathname });
                return response;
            }
        } else {
            authDebug('auth_me_failed_non_401', { status: meResponse.status });
        }
    } catch (error) {
        // API unreachable -> allow through in dev, redirect to login in prod
        authDebug('auth_me_exception', { error: getErrorMessage(error), nodeEnv: process.env.NODE_ENV ?? '' });
        if (process.env.NODE_ENV === 'production') {
            const errorUrl = request.nextUrl.clone();
            errorUrl.pathname = '/auth/login';
            authDebug('redirect_login_auth_exception');
            return NextResponse.redirect(errorUrl);
        }
        authDebug('allow_dev_auth_exception');
        return NextResponse.next();
    }

    if (!user) {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = '/auth/login';
        authDebug('redirect_login_missing_user_after_auth');
        return applyRefreshedCookie(NextResponse.redirect(loginUrl));
    }

    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    const hasPermission = (permission: string) => permissions.includes(permission);
    const isSuperAdmin = hasPermission('admin_portal:access');

    if (isSuperAdmin && pathname.startsWith('/dashboard')) {
        const adminUrl = request.nextUrl.clone();
        adminUrl.pathname = '/admin';
        authDebug('redirect_super_admin_to_admin', { to: adminUrl.pathname });
        return applyRefreshedCookie(NextResponse.redirect(adminUrl));
    }

    if (!isSuperAdmin && pathname.startsWith('/admin')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_non_super_admin_to_dashboard', { role: user.role });
        return applyRefreshedCookie(NextResponse.redirect(dashboardUrl));
    }

    if (pathname.startsWith('/dashboard/settings') && !hasPermission('settings:read')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_settings_forbidden', { role: user.role });
        return applyRefreshedCookie(NextResponse.redirect(dashboardUrl));
    }

    if (pathname.startsWith('/dashboard/staff') && !hasPermission('users:read')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_staff_restricted_area', { role: user.role, path: pathname });
        return applyRefreshedCookie(NextResponse.redirect(dashboardUrl));
    }

    if (pathname.startsWith('/dashboard/locations') && !hasPermission('locations:read')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_locations_forbidden', { role: user.role, path: pathname });
        return applyRefreshedCookie(NextResponse.redirect(dashboardUrl));
    }

    const response = NextResponse.next();
    response.headers.set('x-user-id', user.sub);
    response.headers.set('x-user-role', user.role);
    response.headers.set('x-tenant-id', user.tenantId ?? '');
    response.headers.set('x-user-permissions', permissions.join(','));
    response.headers.set('x-user-roles', Array.isArray(user.roles) ? user.roles.map((role) => role.name).join(',') : '');
    authDebug('allow_authenticated', { role: user.role, refreshedToken: Boolean(refreshedAccessToken) });
    return applyRefreshedCookie(response);
}

export const config = {
    matcher: [
        '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|js\\.map)$).*)',
    ],
};
