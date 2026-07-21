/**
 * Server-only auth utilities.
 * IMPORTANT: This file uses next/headers — it can ONLY be imported in Server Components
 * and Server Actions. Never import in 'use client' files.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
const USER_ROLES = new Set<UserRole>(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']);
const SAFE_HEADER_TOKEN = /^[A-Za-z0-9:_-]{1,128}$/;
const SAFE_PUBLIC_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_BROWSER_SCOPE = /^[A-Za-z0-9_-]{43}$/;
const MAX_PERMISSION_COUNT = 200;
const AUTH_DEBUG_ENABLED = ['1', 'true', 'yes', 'on'].includes((process.env.AUTH_DEBUG ?? '').toLowerCase());

function authDebug(event: string, details: Record<string, unknown> = {}) {
    if (!AUTH_DEBUG_ENABLED) return;
    console.info(`[auth-debug] ${JSON.stringify({ scope: 'web.server-auth', event, ...details })}`);
}

export interface ServerUser {
    publicUserId: string;
    role: UserRole;
    workspaceScope: string;
    sessionScope: string;
    permissions: string[];
}

function parseTokenList(value: string, limit: number): string[] | null {
    if (!value) return [];
    if (value.length > limit * 129) return null;
    const entries = value.split(',');
    if (entries.length > limit || !entries.every((entry) => SAFE_HEADER_TOKEN.test(entry))) {
        return null;
    }
    return entries;
}

/**
 * Read the current user from middleware-injected request headers.
 * Returns null if the headers aren't set (e.g., unauthenticated paths).
 */
export async function getServerUser(): Promise<ServerUser | null> {
    const headerStore = await headers();
    const publicUserId = headerStore.get('x-lunchlineup-user-public-id');
    const role = headerStore.get('x-lunchlineup-user-role');
    const workspaceScope = headerStore.get('x-lunchlineup-workspace-scope');
    const sessionScope = headerStore.get('x-lunchlineup-session-scope');
    const permissions = parseTokenList(
        headerStore.get('x-lunchlineup-user-permissions') ?? '',
        MAX_PERMISSION_COUNT,
    );

    if (
        !publicUserId
        || !SAFE_PUBLIC_USER_ID.test(publicUserId)
        || !role
        || !USER_ROLES.has(role as UserRole)
        || !workspaceScope
        || !SAFE_BROWSER_SCOPE.test(workspaceScope)
        || !sessionScope
        || !SAFE_BROWSER_SCOPE.test(sessionScope)
        || !permissions
    ) {
        authDebug('get_server_user_invalid_headers', {
            hasPublicUserId: Boolean(publicUserId),
            hasUserRole: Boolean(role),
            hasWorkspaceScope: Boolean(workspaceScope),
            hasSessionScope: Boolean(sessionScope),
        });
        return null;
    }

    authDebug('get_server_user_ok', { role });
    return {
        publicUserId,
        role: role as UserRole,
        workspaceScope,
        sessionScope,
        permissions,
    };
}

/**
 * Get current user or redirect to login if not authenticated.
 */
export async function requireAuth(): Promise<ServerUser> {
    const user = await getServerUser();
    if (!user) {
        authDebug('require_auth_redirect_login');
        redirect('/auth/login');
    }
    return user;
}

/**
 * Require one of the specified roles or redirect to /dashboard.
 */
export async function requireRole(allowed: UserRole[]): Promise<ServerUser> {
    const user = await requireAuth();
    if (!allowed.includes(user.role)) {
        authDebug('require_role_redirect_dashboard', { role: user.role, allowed });
        redirect('/dashboard');
    }
    authDebug('require_role_ok', { role: user.role, allowed });
    return user;
}

export async function requirePermission(permission: string): Promise<ServerUser> {
    const user = await requireAuth();
    if (!user.permissions.includes(permission)) {
        authDebug('require_permission_redirect_dashboard', { permission, role: user.role });
        redirect('/dashboard');
    }
    return user;
}

/**
 * Check if a role can perform a given action.
 * This is a UX helper — real enforcement is always server-side in the API.
 */
export function can(role: UserRole, action: string): boolean {
    const permissions: Record<string, UserRole[]> = {
        'manage_users': ['SUPER_ADMIN', 'ADMIN'],
        'invite_staff': ['SUPER_ADMIN', 'ADMIN', 'MANAGER'],
        'publish_schedule': ['SUPER_ADMIN', 'ADMIN', 'MANAGER'],
        'manage_locations': ['SUPER_ADMIN', 'ADMIN'],
        'view_settings': ['SUPER_ADMIN', 'ADMIN'],
        'manage_tenants': ['SUPER_ADMIN'],
        'grant_credits': ['SUPER_ADMIN'],
        'impersonate': ['SUPER_ADMIN'],
    };
    return permissions[action]?.includes(role) ?? false;
}

export function canPermission(user: Pick<ServerUser, 'permissions'>, permission: string): boolean {
    return user.permissions.includes(permission);
}

/**
 * Role display metadata for UI rendering.
 */
export const ROLE_META: Record<UserRole, { label: string; color: string; bg: string }> = {
    SUPER_ADMIN: { label: 'System Admin', color: '#fb7185', bg: 'rgba(244,63,94,0.15)' },
    ADMIN: { label: 'Admin', color: '#748ffc', bg: 'rgba(92,124,250,0.15)' },
    MANAGER: { label: 'Manager', color: '#34d399', bg: 'rgba(16,185,129,0.15)' },
    STAFF: { label: 'Staff', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' },
};
