import { NextRequest, NextResponse } from 'next/server';
import { hasLunchBreakReadAccess, hasSchedulingReadAccess } from './lib/permissions';

const PUBLIC_PATHS = ['/auth', '/mfa', '/onboarding', '/privacy', '/security', '/status', '/subprocessors', '/terms', '/_next', '/favicon.ico', '/vendor', '/sw.js'];
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
const INTERNAL_API_URL = process.env.INTERNAL_API_URL;
const AUTH_DEBUG_ENABLED = ['1', 'true', 'yes', 'on'].includes((process.env.AUTH_DEBUG ?? '').toLowerCase());
const SENSITIVE_QUERY_KEYS = /(?:code|csrf|key|password|secret|session|signature|token)/i;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const SECRET_QUERY_RE = /([?&][^=&#\s]*(?:code|csrf|key|password|secret|session|signature|token)[^=&#\s]*=)[^&#\s]+/gi;

type RefreshResult =
    | { outcome: 'refreshed'; response: NextResponse }
    | { outcome: 'invalid' }
    | { outcome: 'unavailable' };

function isPublicPath(pathname: string): boolean {
    return PUBLIC_PATHS.some((publicPath) => pathname === publicPath || pathname.startsWith(`${publicPath}/`));
}

function pathWithSearch(request: NextRequest): string {
    return `${request.nextUrl.pathname}${request.nextUrl.search}`;
}

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

function getSetCookieHeaders(headers: Headers): string[] {
    const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    if (values.length > 0) return values;

    const combined = headers.get('set-cookie');
    return combined ? [combined] : [];
}

function hasCookie(setCookieHeaders: string[], name: string): boolean {
    return setCookieHeaders.some((cookie) => new RegExp(`(?:^|,\\s*)${name}=`).test(cookie));
}

function redactDebugString(value: string): string {
    const bearerRedacted = value.replace(BEARER_RE, '$1[REDACTED]');
    if (!bearerRedacted.includes('?') && !bearerRedacted.includes('&')) {
        return bearerRedacted;
    }

    try {
        const isSearchOnly = bearerRedacted.startsWith('?');
        const isRelative = bearerRedacted.startsWith('/');
        const parsed = new URL(bearerRedacted, 'http://redaction.local');
        for (const key of Array.from(parsed.searchParams.keys())) {
            if (SENSITIVE_QUERY_KEYS.test(key)) {
                parsed.searchParams.set(key, '[REDACTED]');
            }
        }
        if (isSearchOnly) return parsed.search;
        return isRelative
            ? `${parsed.pathname}${parsed.search}${parsed.hash}`
            : parsed.toString();
    } catch {
        return bearerRedacted.replace(SECRET_QUERY_RE, '$1[REDACTED]');
    }
}

function redactDebugDetails(details: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(details).map(([key, value]) => [
            key,
            typeof value === 'string' ? redactDebugString(value) : value,
        ]),
    );
}

function shouldDebugAuth(request: NextRequest): boolean {
    if (AUTH_DEBUG_ENABLED) return true;
    if (process.env.NODE_ENV === 'production') return false;
    return request.nextUrl.searchParams.get('__auth_debug') === '1' || request.headers.get('x-auth-debug') === '1';
}

export async function proxy(request: NextRequest) {
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
            search: redactDebugString(request.nextUrl.search || ''),
            host: request.headers.get('host') ?? '',
            durationMs: Date.now() - startedAt,
            ...redactDebugDetails(details),
        };
        console.info(`[auth-debug] ${JSON.stringify(payload)}`);
    };
    const redirectToLogin = (event: string) => {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = '/auth/login';
        loginUrl.search = '';
        loginUrl.searchParams.set('next', pathWithSearch(request));
        const response = NextResponse.redirect(loginUrl);
        response.cookies.delete('access_token');
        response.cookies.delete('refresh_token');
        response.cookies.delete('csrf_token');
        authDebug(event, { next: pathWithSearch(request) });
        return response;
    };
    const serviceUnavailable = (event: string, details: Record<string, unknown> = {}) => {
        authDebug(event, details);
        return new NextResponse('Authentication service temporarily unavailable. Please retry.', {
            status: 503,
            headers: {
                'Cache-Control': 'no-store',
                'Retry-After': '5',
            },
        });
    };
    const refreshSession = async (): Promise<RefreshResult> => {
        const refreshToken = readCookie(request, 'refresh_token');
        const csrfToken = readCookie(request, 'csrf_token');
        authDebug('auth_refresh_start', {
            hasRefreshToken: Boolean(refreshToken),
            hasCsrfToken: Boolean(csrfToken),
        });
        if (!refreshToken || !csrfToken) return { outcome: 'invalid' };

        let refreshResponse: Response;
        try {
            refreshResponse = await fetch(apiEndpoint(request, '/auth/refresh'), {
                method: 'POST',
                headers: {
                    Cookie: `refresh_token=${refreshToken}; csrf_token=${csrfToken}`,
                    Origin: request.nextUrl.origin,
                    Referer: request.url,
                    'x-csrf-token': csrfToken,
                },
                cache: 'no-store',
            });
        } catch (error) {
            authDebug('auth_refresh_exception', { error: getErrorMessage(error) });
            return { outcome: 'unavailable' };
        }
        authDebug('auth_refresh_response', { status: refreshResponse.status, ok: refreshResponse.ok });
        if (!refreshResponse.ok) {
            return refreshResponse.status >= 400 && refreshResponse.status < 500 && refreshResponse.status !== 429
                ? { outcome: 'invalid' }
                : { outcome: 'unavailable' };
        }

        const rotatedCookies = getSetCookieHeaders(refreshResponse.headers);
        if (!hasCookie(rotatedCookies, 'access_token')
            || !hasCookie(rotatedCookies, 'refresh_token')
            || !hasCookie(rotatedCookies, 'csrf_token')) {
            authDebug('auth_refresh_incomplete_cookie_rotation');
            return { outcome: 'invalid' };
        }

        const response = NextResponse.redirect(request.url);
        for (const cookie of rotatedCookies) {
            response.headers.append('set-cookie', cookie);
        }
        authDebug('auth_refresh_rotated', { to: request.url });
        return { outcome: 'refreshed', response };
    };

    // Always allow public paths through
    if (isPublicPath(pathname)) {
        authDebug('allow_public_path');
        return NextResponse.next();
    }

    // Allow the root marketing page
    if (pathname === '/') {
        authDebug('allow_root');
        return NextResponse.next();
    }

    const accessToken = readCookie(request, 'access_token');

    // Hard navigations can arrive after only the short-lived access cookie expires.
    if (!accessToken) {
        const refresh = await refreshSession();
        if (refresh.outcome === 'refreshed') return refresh.response;
        if (refresh.outcome === 'unavailable') return serviceUnavailable('auth_refresh_unavailable');
        return redirectToLogin('redirect_login_missing_access_token');
    }

    // Validate token server-side via the API
    let user: {
        sub: string;
        role: string;
        tenantId: string;
        sessionId: string;
        permissions?: string[];
        roles?: Array<{ id: string; name: string }>;
        mfaRequired?: boolean;
        requiresMfa?: boolean;
        mfaVerified?: boolean;
    } | null = null;
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
            authDebug('auth_me_unauthorized');
            const refresh = await refreshSession();
            if (refresh.outcome === 'refreshed') return refresh.response;
            if (refresh.outcome === 'unavailable') return serviceUnavailable('auth_refresh_unavailable');
            return redirectToLogin('redirect_login_refresh_failed');
        } else {
            return serviceUnavailable('auth_me_failed_non_401', { status: meResponse.status });
        }
    } catch (error) {
        return serviceUnavailable('auth_me_exception', { error: getErrorMessage(error) });
    }

    if (!user) {
        return redirectToLogin('redirect_login_missing_user_after_auth');
    }

    const mfaRequired = user.mfaRequired === true || user.requiresMfa === true;
    const mfaVerified = user.mfaVerified === true;
    if (mfaRequired && !mfaVerified) {
        const mfaUrl = request.nextUrl.clone();
        mfaUrl.pathname = '/mfa';
        mfaUrl.search = '';
        mfaUrl.searchParams.set('next', pathWithSearch(request));
        authDebug('redirect_mfa_required', { role: user.role, next: pathWithSearch(request) });
        return NextResponse.redirect(mfaUrl);
    }

    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    const hasPermission = (permission: string) => permissions.includes(permission);
    const isSuperAdmin = hasPermission('admin_portal:access');
    const canReadScheduling = hasSchedulingReadAccess(permissions);
    const canReadLunchBreaks = hasLunchBreakReadAccess(permissions);

    if (!isSuperAdmin && pathname.startsWith('/admin')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_non_super_admin_to_dashboard', { role: user.role });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/scheduling') && !canReadScheduling) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_scheduling_forbidden', { role: user.role, path: pathname });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/lunch-breaks') && !canReadLunchBreaks) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_lunch_breaks_forbidden', { role: user.role, path: pathname });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/settings') && !hasPermission('settings:read')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_settings_forbidden', { role: user.role });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/staff') && !hasPermission('users:read')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_staff_restricted_area', { role: user.role, path: pathname });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/time-cards') && !hasPermission('time_cards:read')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_time_cards_forbidden', { role: user.role, path: pathname });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/locations') && !hasPermission('locations:read')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        authDebug('redirect_locations_forbidden', { role: user.role, path: pathname });
        return NextResponse.redirect(dashboardUrl);
    }

    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.set('x-user-id', user.sub);
    forwardedHeaders.set('x-user-role', user.role);
    forwardedHeaders.set('x-tenant-id', user.tenantId ?? '');
    forwardedHeaders.set('x-user-permissions', permissions.join(','));
    forwardedHeaders.set('x-user-roles', Array.isArray(user.roles) ? user.roles.map((role) => role.name).join(',') : '');
    const response = NextResponse.next({
        request: {
            headers: forwardedHeaders,
        },
    });
    authDebug('allow_authenticated', { role: user.role });
    return response;
}

export const config = {
    matcher: [
        '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|js\\.map)$).*)',
    ],
};
