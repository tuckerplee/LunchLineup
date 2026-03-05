import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/auth', '/onboarding', '/_next', '/favicon.ico', '/vendor', '/sw.js'];
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // Always allow public paths through
    if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
        return NextResponse.next();
    }

    // Allow the root marketing page
    if (pathname === '/') {
        return NextResponse.next();
    }

    const accessToken = request.cookies.get('access_token')?.value;

    // No token → redirect to login
    if (!accessToken) {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = '/auth/login';
        loginUrl.searchParams.set('next', pathname);
        return NextResponse.redirect(loginUrl);
    }

    // Validate token server-side via the API
    let user: { sub: string; role: string; tenantId: string; sessionId: string } | null = null;
    try {
        const meResponse = await fetch(`${API_URL}/api/v1/auth/me`, {
            headers: {
                Cookie: `access_token=${accessToken}`,
                'Content-Type': 'application/json',
            },
            cache: 'no-store',
        });

        if (meResponse.ok) {
            const data = await meResponse.json();
            user = data.user;
        } else if (meResponse.status === 401) {
            // Try to refresh using refresh_token cookie
            const refreshToken = request.cookies.get('refresh_token')?.value;
            if (refreshToken) {
                const refreshResponse = await fetch(`${API_URL}/api/v1/auth/refresh`, {
                    method: 'POST',
                    headers: { Cookie: `refresh_token=${refreshToken}` },
                    cache: 'no-store',
                });

                if (refreshResponse.ok) {
                    // Set the new access_token cookie and retry
                    const setCookieHeader = refreshResponse.headers.get('set-cookie');
                    const nextResponse = NextResponse.redirect(request.url);
                    if (setCookieHeader) {
                        nextResponse.headers.set('set-cookie', setCookieHeader);
                    }
                    return nextResponse;
                }
            }

            // Can't refresh — boot to login
            const loginUrl = request.nextUrl.clone();
            loginUrl.pathname = '/auth/login';
            loginUrl.searchParams.set('next', pathname);
            const response = NextResponse.redirect(loginUrl);
            response.cookies.delete('access_token');
            response.cookies.delete('refresh_token');
            return response;
        }
    } catch {
        // API unreachable — allow through in dev, redirect to error in prod
        if (process.env.NODE_ENV === 'production') {
            const errorUrl = request.nextUrl.clone();
            errorUrl.pathname = '/auth/login';
            return NextResponse.redirect(errorUrl);
        }
        // Dev: pass through so UI is still usable without API running
        return NextResponse.next();
    }

    if (!user) {
        const loginUrl = request.nextUrl.clone();
        loginUrl.pathname = '/auth/login';
        return NextResponse.redirect(loginUrl);
    }

    // ── Route guards based on role ─────────────────────────────────────────────

    const isSuperAdmin = user.role === 'SUPER_ADMIN';

    // SUPER_ADMIN trying to access tenant dashboard → send to admin panel
    if (isSuperAdmin && pathname.startsWith('/dashboard')) {
        const adminUrl = request.nextUrl.clone();
        adminUrl.pathname = '/admin';
        return NextResponse.redirect(adminUrl);
    }

    // Non-SUPER_ADMIN trying to access admin panel → send to dashboard
    if (!isSuperAdmin && pathname.startsWith('/admin')) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        return NextResponse.redirect(dashboardUrl);
    }

    // MANAGER/STAFF trying to access settings → redirect to dashboard
    if (pathname.startsWith('/dashboard/settings') &&
        !['SUPER_ADMIN', 'ADMIN'].includes(user.role)) {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        return NextResponse.redirect(dashboardUrl);
    }

    // STAFF trying to access staff/locations management → redirect
    if ((pathname.startsWith('/dashboard/staff') || pathname.startsWith('/dashboard/locations')) &&
        user.role === 'STAFF') {
        const dashboardUrl = request.nextUrl.clone();
        dashboardUrl.pathname = '/dashboard';
        return NextResponse.redirect(dashboardUrl);
    }

    // ── Pass user context to Server Components via request headers ─────────────
    const response = NextResponse.next();
    response.headers.set('x-user-id', user.sub);
    response.headers.set('x-user-role', user.role);
    response.headers.set('x-tenant-id', user.tenantId ?? '');
    return response;
}

export const config = {
    matcher: [
        /*
         * Match all request paths except:
         * - api (API proxy routes)
         * - _next/static, _next/image (Next.js internals)
         * - favicon.ico, images, vendor scripts
         */
        '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|js\\.map)$).*)',
    ],
};
