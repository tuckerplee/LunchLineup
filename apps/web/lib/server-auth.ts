/**
 * Server-only auth utilities.
 * IMPORTANT: This file uses next/headers — it can ONLY be imported in Server Components
 * and Server Actions. Never import in 'use client' files.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
const AUTH_DEBUG_ENABLED = ['1', 'true', 'yes', 'on'].includes((process.env.AUTH_DEBUG ?? '').toLowerCase());

function authDebug(event: string, details: Record<string, unknown> = {}) {
    if (!AUTH_DEBUG_ENABLED) return;
    console.info(`[auth-debug] ${JSON.stringify({ scope: 'web.server-auth', event, ...details })}`);
}

export interface ServerUser {
    id: string;
    role: string;
    tenantId: string;
    permissions: string[];
    roles: Array<{ id: string; name: string }>;
}

/**
 * Read the current user from middleware-injected request headers.
 * Returns null if the headers aren't set (e.g., unauthenticated paths).
 */
export function getServerUser(): ServerUser | null {
    const headerStore = headers();
    const id = headerStore.get('x-user-id');
    const role = headerStore.get('x-user-role') as UserRole | null;
    const tenantId = headerStore.get('x-tenant-id');
    const permissionsHeader = headerStore.get('x-user-permissions') ?? '';
    const rolesHeader = headerStore.get('x-user-roles') ?? '';
    const matchedPath = headerStore.get('x-matched-path') ?? headerStore.get('x-invoke-path') ?? '';

    if (!id || !role) {
        authDebug('get_server_user_missing_headers', {
            hasUserId: Boolean(id),
            hasUserRole: Boolean(role),
            matchedPath,
        });
        return null;
    }

    authDebug('get_server_user_ok', { role, tenantId: tenantId ?? '', matchedPath });
    return {
        id,
        role,
        tenantId: tenantId ?? '',
        permissions: permissionsHeader ? permissionsHeader.split(',').filter(Boolean) : [],
        roles: rolesHeader ? rolesHeader.split(',').filter(Boolean).map((entry) => ({ id: entry, name: entry })) : [],
    };
}

/**
 * Get current user or redirect to login if not authenticated.
 */
export function requireAuth(): ServerUser {
    const user = getServerUser();
    if (!user) {
        authDebug('require_auth_redirect_login');
        redirect('/auth/login');
    }
    return user;
}

/**
 * Require one of the specified roles or redirect to /dashboard.
 */
export function requireRole(allowed: UserRole[]): ServerUser {
    const user = requireAuth();
    if (!allowed.includes(user.role as UserRole)) {
        authDebug('require_role_redirect_dashboard', { role: user.role, allowed });
        redirect('/dashboard');
    }
    authDebug('require_role_ok', { role: user.role, allowed });
    return user;
}

export function requirePermission(permission: string): ServerUser {
    const user = requireAuth();
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
