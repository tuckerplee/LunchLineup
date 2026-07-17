import { NextRequest, NextResponse } from 'next/server';
import { hasLunchBreakReadAccess, hasSchedulingReadAccess } from './lib/permissions';
import { readBoundedJson, withRequestTimeout } from './lib/http-safety';
import { parseApprovedAppOrigin, safeSameOriginReturnPath } from './lib/safe-navigation';

const PROTECTED_PATH_ROOTS = ['/admin', '/dashboard'];
const PASSWORD_RESET_PATH = '/auth/reset-password';
const PASSWORD_RESET_TOKEN_COOKIE = 'll_password_reset_token';
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';
const AUTH_DEBUG_ENABLED = ['1', 'true', 'yes', 'on'].includes((process.env.AUTH_DEBUG ?? '').toLowerCase());
const UNSAFE_DEBUG_VALUE = /(?:\b(?:bearer|authorization|cookie|set-cookie|password|secret|stack|token)\b|https?:\/\/|file:\/\/|\\\\|[\r\n\0<>]|localhost|127\.0\.0\.1|\.internal\b|\b(?:10|192\.168)\.\d{1,3}\.\d{1,3}|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/i;
const AUTH_FETCH_TIMEOUT_MS = 5_000;
const AUTH_RESPONSE_LIMIT_BYTES = 64 * 1024;
const MAX_IDENTITY_ROLES = 100;
const MAX_ROLE_DISPLAY_NAME_LENGTH = 80;

type AuthUser = {
    sub: string;
    role: string;
    legacyRole: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
    tenantId: string;
    sessionId: string;
    permissions: string[];
    roles: Array<{ id: string; name: string }>;
    mfaRequired?: boolean;
    requiresMfa?: boolean;
    mfaVerified?: boolean;
};

const LEGACY_USER_ROLES = new Set<AuthUser['legacyRole']>(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']);
const SAFE_ROLE_ID = /^[A-Za-z0-9:_-]{1,64}$/;
const ROLE_NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

type RefreshResult =
    | { outcome: 'refreshed'; response: NextResponse }
    | { outcome: 'invalid' }
    | { outcome: 'unavailable' };

function isProtectedPath(pathname: string): boolean {
    return PROTECTED_PATH_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

function safePasswordResetToken(value: string | null): string | null {
    return value && /^[A-Za-z0-9_-]{1,512}$/.test(value) ? value : null;
}

function approvedAppOrigin(request: NextRequest): string | null {
    const configured = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim()
        || process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (configured) {
        return parseApprovedAppOrigin(configured, process.env.NODE_ENV === 'production');
    }
    if (process.env.NODE_ENV === 'production') return null;
    return parseApprovedAppOrigin(request.nextUrl.origin, false);
}

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

function readCookie(request: NextRequest, name: string): string | undefined {
    const parsed = request.cookies.get(name)?.value;
    if (parsed) return parsed;

    const raw = request.headers.get('cookie') ?? '';
    if (!raw) return undefined;
    const match = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match?.[1];
}

function apiEndpoint(appOrigin: string, path: string): string {
    const internalApiUrl = process.env.INTERNAL_API_URL?.trim();
    if (internalApiUrl) {
        const internalBase = parseServiceBase(internalApiUrl);
        if (!internalBase) throw new Error('invalid_api_configuration');
        return `${internalBase}${path}`;
    }

    if (/^https?:/i.test(API_URL)) {
        const publicBase = parseServiceBase(API_URL);
        if (!publicBase || new URL(publicBase).origin !== appOrigin) {
            throw new Error('invalid_api_configuration');
        }
        return `${publicBase}${path}`;
    }

    const relativeBase = API_URL.startsWith('/') ? API_URL : `/${API_URL}`;
    const base = process.env.NODE_ENV === 'production'
        ? `http://api:3000${relativeBase}`
        : `${appOrigin}${relativeBase}`;
    return `${base}${path}`;
}

function classifyProxyFailure(error: unknown): 'aborted' | 'invalid_response' | 'network' | 'timeout' {
    const name = error instanceof Error ? error.name : '';
    if (name === 'AbortError') return 'aborted';
    if (name === 'TimeoutError') return 'timeout';
    if (name === 'SyntaxError' || name === 'ResponseBodyLimitError') return 'invalid_response';
    return 'network';
}

function safeHeaderToken(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function migrationSafeRoleName(value: string): string {
    const normalized = value
        .replace(ROLE_NAME_CONTROL_CHARACTERS, ' ')
        .replace(/ {2,}/g, ' ')
        .trim()
        .slice(0, MAX_ROLE_DISPLAY_NAME_LENGTH);
    return normalized || 'Unknown role';
}

function parseAuthUser(payload: unknown): AuthUser | null {
    if (!payload || typeof payload !== 'object') return null;
    const candidate = (payload as { user?: unknown }).user;
    if (!candidate || typeof candidate !== 'object') return null;
    const user = candidate as Record<string, unknown>;
    if (
        !safeHeaderToken(user.sub)
        || typeof user.role !== 'string'
        || typeof user.legacyRole !== 'string'
        || !LEGACY_USER_ROLES.has(user.legacyRole as AuthUser['legacyRole'])
        || !safeHeaderToken(user.tenantId)
        || !safeHeaderToken(user.sessionId)
    ) {
        return null;
    }

    const permissions = user.permissions ?? [];
    if (!Array.isArray(permissions) || permissions.length > 200 || !permissions.every(safeHeaderToken)) {
        return null;
    }
    const roles = user.roles ?? [];
    if (!Array.isArray(roles) || roles.length > MAX_IDENTITY_ROLES) return null;
    const normalizedRoles: Array<{ id: string; name: string }> = [];
    for (const role of roles) {
        if (!role || typeof role !== 'object') return null;
        const { id, name } = role as { id?: unknown; name?: unknown };
        if (typeof id !== 'string' || !SAFE_ROLE_ID.test(id) || typeof name !== 'string') {
            return null;
        }
        normalizedRoles.push({ id, name: migrationSafeRoleName(name) });
    }
    for (const key of ['mfaRequired', 'requiresMfa', 'mfaVerified'] as const) {
        if (user[key] !== undefined && typeof user[key] !== 'boolean') return null;
    }

    return {
        sub: user.sub,
        role: migrationSafeRoleName(user.role),
        legacyRole: user.legacyRole as AuthUser['legacyRole'],
        tenantId: user.tenantId,
        sessionId: user.sessionId,
        permissions: [...permissions],
        roles: normalizedRoles,
        mfaRequired: user.mfaRequired as boolean | undefined,
        requiresMfa: user.requiresMfa as boolean | undefined,
        mfaVerified: user.mfaVerified as boolean | undefined,
    };
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
    if (value.length > 200 || UNSAFE_DEBUG_VALUE.test(value)) return '[REDACTED]';
    return value;
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
    const requestId = `${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const debugEnabled = shouldDebugAuth(request);
    const authDebug = (event: string, details: Record<string, unknown> = {}) => {
        if (!debugEnabled) return;
        const payload = {
            scope: 'web.middleware',
            event,
            requestId,
            method: request.method,
            durationMs: Date.now() - startedAt,
            ...redactDebugDetails(details),
        };
        console.info(`[auth-debug] ${JSON.stringify(payload)}`);
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

    if (pathname === PASSWORD_RESET_PATH) {
        const token = safePasswordResetToken(request.nextUrl.searchParams.get('token'));
        if (request.nextUrl.searchParams.has('token')) {
            const resetOrigin = approvedAppOrigin(request);
            if (!resetOrigin) return serviceUnavailable('invalid_public_app_origin');
            const cleanPath = safeSameOriginReturnPath(pathname, request.nextUrl.search);
            const response = NextResponse.redirect(new URL(cleanPath, resetOrigin), 303);
            response.headers.set('Cache-Control', 'no-store');
            response.headers.set('Referrer-Policy', 'no-referrer');
            response.cookies.set(PASSWORD_RESET_TOKEN_COOKIE, token ?? '', {
                httpOnly: false,
                sameSite: 'strict',
                secure: new URL(resetOrigin).protocol === 'https:',
                path: PASSWORD_RESET_PATH,
                maxAge: token ? 15 * 60 : 0,
            });
            authDebug('scrub_password_reset_token', { accepted: Boolean(token) });
            return response;
        }

        const response = NextResponse.next();
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
    }

    if (!isProtectedPath(pathname)) {
        authDebug('allow_unprotected_path');
        return NextResponse.next();
    }

    const appOrigin = approvedAppOrigin(request);
    if (!appOrigin) return serviceUnavailable('invalid_public_app_origin');
    const returnPath = safeSameOriginReturnPath(pathname, request.nextUrl.search);
    const redirectToLogin = (event: string) => {
        const loginUrl = new URL('/auth/login', appOrigin);
        loginUrl.searchParams.set('next', returnPath);
        const response = NextResponse.redirect(loginUrl);
        response.cookies.delete('access_token');
        response.cookies.delete('refresh_token');
        response.cookies.delete('csrf_token');
        authDebug(event, { next: returnPath });
        return response;
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
            refreshResponse = await withRequestTimeout(
                (signal) => fetch(apiEndpoint(appOrigin, '/auth/refresh'), {
                    method: 'POST',
                    headers: {
                        Cookie: `refresh_token=${refreshToken}; csrf_token=${csrfToken}`,
                        Origin: appOrigin,
                        Referer: new URL(returnPath, appOrigin).toString(),
                        'x-csrf-token': csrfToken,
                    },
                    cache: 'no-store',
                    redirect: 'error',
                    signal,
                }),
                AUTH_FETCH_TIMEOUT_MS,
            );
        } catch (error) {
            authDebug('auth_refresh_exception', { failureCategory: classifyProxyFailure(error) });
            return { outcome: 'unavailable' };
        }
        authDebug('auth_refresh_response', { status: refreshResponse.status, ok: refreshResponse.ok });
        await refreshResponse.body?.cancel().catch(() => undefined);
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

        const response = NextResponse.redirect(new URL(returnPath, appOrigin));
        for (const cookie of rotatedCookies) {
            response.headers.append('set-cookie', cookie);
        }
        authDebug('auth_refresh_rotated', { to: returnPath });
        return { outcome: 'refreshed', response };
    };
    const accessToken = readCookie(request, 'access_token');

    // Hard navigations can arrive after only the short-lived access cookie expires.
    if (!accessToken) {
        const refresh = await refreshSession();
        if (refresh.outcome === 'refreshed') return refresh.response;
        if (refresh.outcome === 'unavailable') return serviceUnavailable('auth_refresh_unavailable');
        return redirectToLogin('redirect_login_missing_access_token');
    }

    // Validate token server-side via the API
    let user: AuthUser | null = null;
    try {
        const fetchUserByAccessToken = async (token: string) => withRequestTimeout(
            async (signal) => {
                const response = await fetch(apiEndpoint(appOrigin, '/auth/me'), {
                    headers: {
                        Cookie: `access_token=${token}`,
                        'Content-Type': 'application/json',
                    },
                    cache: 'no-store',
                    redirect: 'error',
                    signal,
                });
                if (!response.ok) {
                    await response.body?.cancel().catch(() => undefined);
                    return { status: response.status, user: null as AuthUser | null };
                }
                const data = await readBoundedJson(response, AUTH_RESPONSE_LIMIT_BYTES);
                return { status: response.status, user: parseAuthUser(data) };
            },
            AUTH_FETCH_TIMEOUT_MS,
        );

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
        return serviceUnavailable('auth_me_exception', { failureCategory: classifyProxyFailure(error) });
    }

    if (!user) {
        return redirectToLogin('redirect_login_missing_user_after_auth');
    }

    const mfaRequired = user.mfaRequired === true || user.requiresMfa === true;
    const mfaVerified = user.mfaVerified === true;
    if (mfaRequired && !mfaVerified) {
        const mfaUrl = new URL('/mfa', appOrigin);
        mfaUrl.searchParams.set('next', returnPath);
        authDebug('redirect_mfa_required', { role: user.role, next: returnPath });
        return NextResponse.redirect(mfaUrl);
    }

    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    const hasPermission = (permission: string) => permissions.includes(permission);
    const isSuperAdmin = hasPermission('admin_portal:access');
    const canReadScheduling = hasSchedulingReadAccess(permissions);
    const canReadLunchBreaks = hasLunchBreakReadAccess(permissions);

    if (!isSuperAdmin && pathname.startsWith('/admin')) {
        const dashboardUrl = new URL('/dashboard', appOrigin);
        authDebug('redirect_non_super_admin_to_dashboard', { role: user.role });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/scheduling') && !canReadScheduling) {
        const dashboardUrl = new URL('/dashboard', appOrigin);
        authDebug('redirect_scheduling_forbidden', { role: user.role });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/lunch-breaks') && !canReadLunchBreaks) {
        const dashboardUrl = new URL('/dashboard', appOrigin);
        authDebug('redirect_lunch_breaks_forbidden', { role: user.role });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/settings') && !hasPermission('settings:read')) {
        const dashboardUrl = new URL('/dashboard', appOrigin);
        authDebug('redirect_settings_forbidden', { role: user.role });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/staff') && !hasPermission('users:read')) {
        const dashboardUrl = new URL('/dashboard', appOrigin);
        authDebug('redirect_staff_restricted_area', { role: user.role });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/time-cards') && !hasPermission('time_cards:read')) {
        const dashboardUrl = new URL('/dashboard', appOrigin);
        authDebug('redirect_time_cards_forbidden', { role: user.role });
        return NextResponse.redirect(dashboardUrl);
    }

    if (pathname.startsWith('/dashboard/locations') && !hasPermission('locations:read')) {
        const dashboardUrl = new URL('/dashboard', appOrigin);
        authDebug('redirect_locations_forbidden', { role: user.role });
        return NextResponse.redirect(dashboardUrl);
    }

    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.set('x-user-id', user.sub);
    forwardedHeaders.set('x-user-role', user.legacyRole);
    forwardedHeaders.set('x-tenant-id', user.tenantId ?? '');
    forwardedHeaders.set('x-user-permissions', permissions.join(','));
    forwardedHeaders.set('x-user-roles', user.roles.map((role) => role.id).join(','));
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
        '/admin/:path*',
        '/dashboard/:path*',
        '/auth/reset-password',
    ],
};
