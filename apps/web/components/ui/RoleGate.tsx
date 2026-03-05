import { type UserRole, ROLE_META } from '@/lib/server-auth';

interface RoleGateProps {
    userRole: UserRole;
    allow: UserRole[];
    children: React.ReactNode;
    fallback?: React.ReactNode;
}

/**
 * Server Component role gate — renders children only if userRole is in allow list.
 * Must be used in Server Components only (no 'use client').
 * Pass userRole from the parent server component that called getServerUser().
 */
export function RoleGate({ userRole, allow, children, fallback = null }: RoleGateProps) {
    if (!allow.includes(userRole)) {
        return <>{fallback}</>;
    }
    return <>{children}</>;
}

/**
 * Inline role badge for headers and nav.
 */
export function RoleBadge({ role }: { role: UserRole }) {
    const meta = ROLE_META[role];
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '2px 8px', borderRadius: 999,
            fontSize: '0.625rem', fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: meta.color, background: meta.bg,
            border: `1px solid ${meta.color}40`,
        }}>
            {meta.label}
        </span>
    );
}
