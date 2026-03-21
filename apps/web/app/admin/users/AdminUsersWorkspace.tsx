'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';

type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type UserStatus = 'ACTIVE' | 'LOCKED' | 'SUSPENDED';
type StatusFilter = 'ALL' | UserStatus;

type AdminTenant = {
    id: string;
    name: string;
    slug: string;
    planTier: string;
    status: string;
};

type AdminUser = {
    id: string;
    name: string;
    email: string | null;
    username: string | null;
    role: UserRole;
    createdAt: string;
    lastLoginAt: string | null;
    lockedUntil: string | null;
    pinLockedUntil: string | null;
    deletedAt: string | null;
    status: UserStatus;
    tenant: AdminTenant | null;
};

type UserForm = {
    name: string;
    email: string;
    username: string;
    role: UserRole;
    tenantId: string;
};

type Banner = {
    tone: 'success' | 'error';
    text: string;
} | null;

type WorkspaceProps = {
    currentUserId: string | null;
};

const ROLE_META: Record<UserRole, { label: string; color: string; bg: string; border: string }> = {
    SUPER_ADMIN: { label: 'SUPER_ADMIN', color: '#cb3653', bg: '#ffeef2', border: '#ffd0da' },
    ADMIN: { label: 'ADMIN', color: '#2f63ff', bg: '#edf3ff', border: '#c9d9ff' },
    MANAGER: { label: 'MANAGER', color: '#0f8c52', bg: '#e9fbf1', border: '#bdeed4' },
    STAFF: { label: 'STAFF', color: '#4c5f85', bg: '#eef2f9', border: '#d3ddeb' },
};

const STATUS_META: Record<UserStatus, { label: string; color: string; bg: string; border: string; dot: string }> = {
    ACTIVE: { label: 'Active', color: '#0f8c52', bg: '#e9fbf1', border: '#bdeed4', dot: '#17b26a' },
    LOCKED: { label: 'Locked', color: '#cc7f06', bg: '#fff4e2', border: '#ffe1a6', dot: '#f59e0b' },
    SUSPENDED: { label: 'Suspended', color: '#cb3653', bg: '#ffeef2', border: '#ffd0da', dot: '#e74867' },
};

const FILTER_META: Record<StatusFilter, { label: string; color: string; bg: string; border: string }> = {
    ALL: { label: 'All', color: '#4c5f85', bg: '#eef2f9', border: '#d3ddeb' },
    ACTIVE: { label: 'Active', color: '#0f8c52', bg: '#e9fbf1', border: '#bdeed4' },
    LOCKED: { label: 'Locked', color: '#cc7f06', bg: '#fff4e2', border: '#ffe1a6' },
    SUSPENDED: { label: 'Suspended', color: '#cb3653', bg: '#ffeef2', border: '#ffd0da' },
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;

function getCsrfHeaders(): Record<string, string> {
    if (typeof document === 'undefined') return {};
    const pair = document.cookie
        .split('; ')
        .find((entry) => entry.startsWith('csrf_token='));
    const csrfToken = pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
    return csrfToken ? { 'x-csrf-token': csrfToken } : {};
}

function jsonWriteInit(method: 'POST' | 'PUT', payload?: unknown): RequestInit {
    return {
        method,
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...getCsrfHeaders(),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    };
}

async function writeJson<T>(path: string, method: 'POST' | 'PUT', payload?: unknown): Promise<T> {
    const response = await fetchWithSession(path, jsonWriteInit(method, payload));
    const responsePayload = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) {
        const message = typeof (responsePayload as { message?: unknown }).message === 'string'
            ? String((responsePayload as { message: string }).message)
            : `Request failed (${response.status})`;
        throw new Error(message);
    }
    return responsePayload as T;
}

function initials(name: string): string {
    return name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('') || 'U';
}

function formatRelativeTime(value: string | null): string {
    if (!value) return 'Never';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }).format(date);
}

function formatDateTime(value: string | null): string {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(date);
}

function Badge({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
    return (
        <span
            className="badge"
            style={{
                fontSize: '0.62rem',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color,
                background: bg,
                borderColor: border,
            }}
        >
            {label}
        </span>
    );
}

function emptyForm(tenants: AdminTenant[], user?: AdminUser): UserForm {
    return {
        name: user?.name ?? '',
        email: user?.email ?? '',
        username: user?.username ?? '',
        role: user?.role ?? 'STAFF',
        tenantId: user?.tenant?.id ?? tenants[0]?.id ?? '',
    };
}

export function AdminUsersWorkspace({ currentUserId }: WorkspaceProps) {
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [tenants, setTenants] = useState<AdminTenant[]>([]);
    const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
    const [form, setForm] = useState<UserForm>(() => emptyForm([]));
    const [lockMinutes, setLockMinutes] = useState('60');
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
    const [loading, setLoading] = useState(true);
    const [savingKey, setSavingKey] = useState<string | null>(null);
    const [message, setMessage] = useState<Banner>(null);
    const [temporaryPin, setTemporaryPin] = useState<string | null>(null);

    const selectedUser = useMemo(
        () => users.find((user) => user.id === selectedUserId) ?? null,
        [selectedUserId, users],
    );

    const filteredUsers = useMemo(() => {
        const query = search.trim().toLowerCase();
        return users.filter((user) => {
            if (statusFilter !== 'ALL' && user.status !== statusFilter) return false;
            if (!query) return true;
            const haystack = [
                user.name,
                user.email ?? '',
                user.username ?? '',
                user.role,
                user.status,
                user.tenant?.name ?? '',
                user.tenant?.slug ?? '',
            ]
                .join(' ')
                .toLowerCase();
            return haystack.includes(query);
        });
    }, [search, statusFilter, users]);

    const stats = useMemo(() => {
        const total = users.length;
        const active = users.filter((user) => user.status === 'ACTIVE').length;
        const locked = users.filter((user) => user.status === 'LOCKED').length;
        const suspended = users.filter((user) => user.status === 'SUSPENDED').length;
        return { total, active, locked, suspended };
    }, [users]);

    const isSelf = Boolean(currentUserId && selectedUser?.id === currentUserId);
    const selectedStatusMeta = selectedUser ? STATUS_META[selectedUser.status] : null;
    const selectedRoleMeta = selectedUser ? ROLE_META[selectedUser.role] : ROLE_META.STAFF;
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [usersPayload, tenantsPayload] = await Promise.all([
                fetchJsonWithSession<{ data?: AdminUser[] }>('/admin/users'),
                fetchJsonWithSession<{ data?: AdminTenant[] }>('/admin/tenants'),
            ]);
            const nextUsers = Array.isArray(usersPayload.data) ? usersPayload.data : [];
            const nextTenants = Array.isArray(tenantsPayload.data) ? tenantsPayload.data : [];
            setUsers(nextUsers);
            setTenants(nextTenants);
            setSelectedUserId((current) => {
                if (current && nextUsers.some((user) => user.id === current)) return current;
                return nextUsers[0]?.id ?? null;
            });
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadData();
    }, [loadData]);

    useEffect(() => {
        if (!selectedUser) {
            setForm(emptyForm(tenants));
            return;
        }
        setForm(emptyForm(tenants, selectedUser));
    }, [selectedUser, tenants]);

    useEffect(() => {
        setTemporaryPin(null);
    }, [selectedUserId]);

    const saveUser = useCallback(async () => {
        if (!selectedUser) return;
        const name = form.name.trim();
        if (!name) {
            setMessage({ tone: 'error', text: 'Name is required.' });
            return;
        }

        const email = form.email.trim().toLowerCase();
        const username = form.username.trim().toLowerCase();
        if (email && !EMAIL_REGEX.test(email)) {
            setMessage({ tone: 'error', text: 'Email format is invalid.' });
            return;
        }
        if (username && !USERNAME_REGEX.test(username)) {
            setMessage({ tone: 'error', text: 'Username must be 3 to 32 characters and use lowercase letters, numbers, dot, dash, or underscore.' });
            return;
        }
        if (!form.tenantId) {
            setMessage({ tone: 'error', text: 'Tenant assignment is required.' });
            return;
        }

        setSavingKey(`save:${selectedUser.id}`);
        setMessage(null);
        try {
            await writeJson(`/admin/users/${selectedUser.id}`, 'PUT', {
                name,
                email: email || null,
                username: username || null,
                role: form.role,
                tenantId: form.tenantId,
            });
            setMessage({ tone: 'success', text: `${name} was updated.` });
            await loadData();
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setSavingKey(null);
        }
    }, [form, loadData, selectedUser]);

    const resetPin = useCallback(async () => {
        if (!selectedUser) return;
        setSavingKey(`pin:${selectedUser.id}`);
        setMessage(null);
        try {
            const payload = await writeJson<{ temporaryPin?: string; username?: string; pinResetRequired?: boolean }>(
                `/users/${selectedUser.id}/pin/reset`,
                'POST',
            );
            setTemporaryPin(payload.temporaryPin ?? null);
            setMessage({ tone: 'success', text: `PIN reset for ${selectedUser.name}.` });
            await loadData();
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setSavingKey(null);
        }
    }, [loadData, selectedUser]);

    const toggleLock = useCallback(async (targetUser?: AdminUser) => {
        const user = targetUser ?? selectedUser;
        if (!user || user.status === 'SUSPENDED') return;
        setSavingKey(`lock:${user.id}`);
        setMessage(null);
        try {
            if (user.status === 'LOCKED') {
                await writeJson(`/admin/users/${user.id}/unlock`, 'POST');
                setMessage({ tone: 'success', text: `${user.name} was unlocked.` });
            } else {
                const parsedMinutes = Number(lockMinutes);
                const minutes = Number.isFinite(parsedMinutes) ? Math.min(Math.max(Math.trunc(parsedMinutes), 1), 60 * 24 * 30) : 60;
                await writeJson(`/admin/users/${user.id}/lock`, 'POST', { minutes });
                setMessage({ tone: 'success', text: `${user.name} was locked for ${minutes} minute${minutes === 1 ? '' : 's'}.` });
            }
            await loadData();
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setSavingKey(null);
        }
    }, [lockMinutes, loadData, selectedUser]);

    const toggleSuspension = useCallback(async (targetUser?: AdminUser) => {
        const user = targetUser ?? selectedUser;
        if (!user) return;
        const userIsSelf = Boolean(currentUserId && user.id === currentUserId);
        if (userIsSelf && user.status !== 'SUSPENDED') {
            setMessage({ tone: 'error', text: 'Your own account cannot be suspended from this screen.' });
            return;
        }

        setSavingKey(`suspend:${user.id}`);
        setMessage(null);
        try {
            if (user.status === 'SUSPENDED') {
                await writeJson(`/admin/users/${user.id}/activate`, 'POST');
                setMessage({ tone: 'success', text: `${user.name} was reactivated.` });
            } else {
                const confirmed = typeof window === 'undefined'
                    ? true
                    : window.confirm(`Suspend ${user.name}? This revokes current sessions.`);
                if (!confirmed) return;
                await writeJson(`/admin/users/${user.id}/suspend`, 'POST');
                setMessage({ tone: 'success', text: `${user.name} was suspended.` });
            }
            await loadData();
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setSavingKey(null);
        }
    }, [currentUserId, loadData, selectedUser]);

    const selectUser = useCallback((userId: string) => {
        setSelectedUserId(userId);
        setMessage(null);
    }, []);

    const actionDisabled = loading || !selectedUser;
    const saveDisabled = actionDisabled || savingKey === `save:${selectedUser?.id ?? ''}`;
    const pinDisabled = actionDisabled || savingKey === `pin:${selectedUser?.id ?? ''}`;
    const lockDisabled = actionDisabled || isSelf || selectedUser?.status === 'SUSPENDED' || savingKey === `lock:${selectedUser?.id ?? ''}`;
    const suspendDisabled = actionDisabled || (isSelf && selectedUser?.status !== 'SUSPENDED') || savingKey === `suspend:${selectedUser?.id ?? ''}`;
    const visibleSelection = selectedUser ? filteredUsers.some((user) => user.id === selectedUser.id) : false;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1440 }}>
            <section
                className="surface-card"
                style={{
                    padding: '1rem',
                    background:
                        'radial-gradient(34rem 16rem at 0% 0%, rgba(47,99,255,0.10), transparent 58%), radial-gradient(32rem 16rem at 100% 100%, rgba(231,72,103,0.12), transparent 60%), #ffffff',
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div>
                        <div className="workspace-kicker" style={{ color: '#cb3653' }}>
                            Identity and access
                        </div>
                        <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
                            Users
                        </h1>
                        <p className="workspace-subtitle">
                            Cross-tenant user management · {stats.total} accounts{loading ? ' · refreshing...' : ' · loaded from admin APIs'}
                        </p>
                    </div>

                    <div
                        className="surface-muted"
                        style={{
                            padding: '0.55rem 0.7rem',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.45rem',
                            color: 'var(--text-muted)',
                            fontSize: '0.84rem',
                            flexWrap: 'wrap',
                        }}
                    >
                        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{filteredUsers.length}</span>
                        <span>shown</span>
                        <span style={{ color: 'var(--text-muted)' }}>of</span>
                        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{stats.total}</span>
                        <span>users</span>
                    </div>
                </div>
            </section>

            {message ? (
                <div
                    style={{
                        padding: '0.8rem 0.95rem',
                        borderRadius: 12,
                        border: message.tone === 'success' ? '1px solid #bdeed4' : '1px solid #ffd0da',
                        background: message.tone === 'success' ? '#e9fbf1' : '#fff1f4',
                        color: message.tone === 'success' ? '#0f8c52' : '#cb3653',
                        fontWeight: 600,
                        fontSize: '0.86rem',
                    }}
                >
                    {message.text}
                </div>
            ) : null}

            <section className="admin-users-stats">
                {[
                    { label: 'Total users', value: stats.total, tone: '#2f63ff', bg: '#edf3ff' },
                    { label: 'Active', value: stats.active, tone: '#0f8c52', bg: '#e9fbf1' },
                    { label: 'Locked', value: stats.locked, tone: '#cc7f06', bg: '#fff4e2' },
                    { label: 'Suspended', value: stats.suspended, tone: '#cb3653', bg: '#ffeef2' },
                ].map((card) => (
                    <article key={card.label} className="surface-card" style={{ padding: '0.95rem', background: card.bg }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.45rem' }}>
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 650 }}>{card.label}</span>
                            <span
                                style={{
                                    width: 33,
                                    height: 33,
                                    borderRadius: 10,
                                    display: 'grid',
                                    placeItems: 'center',
                                    background: '#ffffff',
                                    border: '1px solid rgba(0,0,0,0.06)',
                                    fontSize: '0.95rem',
                                }}
                            >
                                {card.label === 'Suspended' ? '⏸' : '◉'}
                            </span>
                        </div>
                        <div style={{ fontSize: '1.9rem', fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>{card.value}</div>
                        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: card.tone }}>{card.label.toLowerCase()}</div>
                    </article>
                ))}
            </section>

            <section className="admin-users-grid">
                <article className="surface-card admin-users-list" style={{ overflowX: 'auto' }}>
                    <div style={{ padding: '1rem 1rem 0.6rem', display: 'grid', gap: '0.75rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                            <div>
                                <h2 style={{ fontSize: '1rem', fontWeight: 760, color: 'var(--text-primary)' }}>Directory</h2>
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Showing up to 200 users from the admin API.</div>
                            </div>
                            <button
                                className="btn btn-sm btn-secondary"
                                type="button"
                                onClick={() => {
                                    setMessage(null);
                                    void loadData();
                                }}
                                disabled={loading}
                            >
                                {loading ? 'Refreshing...' : 'Refresh'}
                            </button>
                        </div>

                        <div style={{ display: 'grid', gap: '0.55rem' }}>
                            <label className="form-group" style={{ gap: '0.35rem' }}>
                                <span className="form-label">Search users</span>
                                <input
                                    className="form-input"
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder="Name, email, username, tenant, role..."
                                />
                            </label>

                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                {(['ALL', 'ACTIVE', 'LOCKED', 'SUSPENDED'] as StatusFilter[]).map((filter) => (
                                    <button
                                        key={filter}
                                        type="button"
                                        onClick={() => setStatusFilter(filter)}
                                        className="badge"
                                        style={{
                                            fontSize: '0.62rem',
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.06em',
                                            color: FILTER_META[filter].color,
                                            background: statusFilter === filter ? FILTER_META[filter].bg : '#f8faff',
                                            borderColor: statusFilter === filter ? FILTER_META[filter].border : '#dbe4f0',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {FILTER_META[filter].label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    <table className="admin-users-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ background: '#f8faff', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                                {['User', 'Tenant', 'Identity', 'Role', 'Status', 'Last Login', 'Actions'].map((header) => (
                                    <th
                                        key={header}
                                        style={{
                                            textAlign: 'left',
                                            padding: '0.8rem 1rem',
                                            fontSize: '0.66rem',
                                            fontWeight: 700,
                                            color: 'var(--text-muted)',
                                            letterSpacing: '0.08em',
                                            textTransform: 'uppercase',
                                        }}
                                    >
                                        {header}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {filteredUsers.map((user, index) => {
                                const isSelected = user.id === selectedUserId;
                                const rowIsSelf = Boolean(currentUserId && user.id === currentUserId);
                                const rowBusy = Boolean(savingKey && savingKey.endsWith(`:${user.id}`));
                                const isLocked = user.status === 'LOCKED';
                                const isSuspended = user.status === 'SUSPENDED';
                                const status = STATUS_META[user.status];
                                const role = ROLE_META[user.role];

                                return (
                                    <tr
                                        key={user.id}
                                        style={{
                                            borderBottom: index < filteredUsers.length - 1 ? '1px solid var(--border)' : 'none',
                                            background: isSelected ? '#f8faff' : 'transparent',
                                        }}
                                    >
                                        <td style={{ padding: '0.86rem 1rem' }}>
                                            <button
                                                type="button"
                                                onClick={() => selectUser(user.id)}
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '0.7rem',
                                                    width: '100%',
                                                    padding: 0,
                                                    border: 0,
                                                    background: 'transparent',
                                                    textAlign: 'left',
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        width: 34,
                                                        height: 34,
                                                        borderRadius: '50%',
                                                        border: '1px solid #c9d9ff',
                                                        background: '#edf3ff',
                                                        display: 'grid',
                                                        placeItems: 'center',
                                                        fontSize: '0.66rem',
                                                        fontWeight: 800,
                                                        color: '#2f63ff',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    {initials(user.name)}
                                                </div>
                                                <div style={{ minWidth: 0 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                        <span style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)' }}>{user.name}</span>
                                                        {rowIsSelf ? (
                                                            <span className="badge" style={{ background: '#edf3ff', borderColor: '#c9d9ff', color: '#2f63ff', fontSize: '0.58rem' }}>
                                                                You
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                        {user.email || 'No email'}
                                                    </div>
                                                </div>
                                            </button>
                                        </td>
                                        <td style={{ padding: '0.86rem 1rem', fontSize: '0.83rem', color: 'var(--text-secondary)' }}>
                                            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{user.tenant?.name ?? 'Unassigned'}</div>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                                {user.tenant?.slug ?? 'no-tenant'}
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.86rem 1rem' }}>
                                            <div style={{ display: 'grid', gap: '0.2rem' }}>
                                                <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                                                    {user.email || 'No email'}
                                                </div>
                                                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                                    {user.username || 'No username'}
                                                </div>
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.86rem 1rem' }}>
                                            <Badge label={role.label} color={role.color} bg={role.bg} border={role.border} />
                                        </td>
                                        <td style={{ padding: '0.86rem 1rem' }}>
                                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.42rem' }}>
                                                <span className="status-dot" style={{ background: status.dot }} />
                                                <span style={{ fontSize: '0.82rem', color: status.color, fontWeight: 600 }}>{status.label}</span>
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.86rem 1rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                                            {formatRelativeTime(user.lastLoginAt)}
                                        </td>
                                        <td style={{ padding: '0.86rem 1rem' }}>
                                            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                                <button className="btn btn-sm btn-secondary" type="button" onClick={() => selectUser(user.id)}>
                                                    Edit
                                                </button>
                                                <button
                                                    className="btn btn-sm"
                                                    type="button"
                                                    disabled={loading || rowBusy || isSuspended || (rowIsSelf && user.status !== 'SUSPENDED')}
                                                    onClick={() => {
                                                        selectUser(user.id);
                                                        void toggleLock(user);
                                                    }}
                                                    style={{
                                                        background: isLocked ? '#e9fbf1' : '#ffeef2',
                                                        color: isLocked ? '#0f8c52' : '#cb3653',
                                                        borderColor: isLocked ? '#bdeed4' : '#ffd0da',
                                                        opacity: isSuspended || (rowIsSelf && user.status !== 'SUSPENDED') ? 0.55 : 1,
                                                    }}
                                                >
                                                    {isLocked ? 'Unlock' : 'Lock'}
                                                </button>
                                                <button
                                                    className="btn btn-sm"
                                                    type="button"
                                                    disabled={loading || rowBusy || (rowIsSelf && user.status !== 'SUSPENDED')}
                                                    onClick={() => {
                                                        selectUser(user.id);
                                                        void toggleSuspension(user);
                                                    }}
                                                    style={{
                                                        background: isSuspended ? '#e9fbf1' : '#fff4e2',
                                                        color: isSuspended ? '#0f8c52' : '#cc7f06',
                                                        borderColor: isSuspended ? '#bdeed4' : '#ffe1a6',
                                                        opacity: rowIsSelf && user.status !== 'SUSPENDED' ? 0.55 : 1,
                                                    }}
                                                >
                                                    {isSuspended ? 'Activate' : 'Suspend'}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}

                            {!loading && filteredUsers.length === 0 ? (
                                <tr>
                                    <td colSpan={7} style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.84rem' }}>
                                        No users matched the current filters.
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                </article>

                <article className="surface-card admin-users-panel" style={{ padding: '1rem', height: 'fit-content' }}>
                    {selectedUser ? (
                        <div style={{ display: 'grid', gap: '0.9rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
                                <div>
                                    <div className="workspace-kicker" style={{ color: '#cb3653' }}>
                                        Selected user
                                    </div>
                                    <h2 style={{ fontSize: '1rem', fontWeight: 760, color: 'var(--text-primary)', marginBottom: 2 }}>
                                        {selectedUser.name}
                                    </h2>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {selectedUser.tenant ? `${selectedUser.tenant.name} · ${selectedUser.tenant.slug}` : 'No tenant assigned'}
                                    </div>
                                </div>

                                <button
                                    className="btn btn-sm btn-secondary"
                                    type="button"
                                    onClick={() => {
                                        setMessage(null);
                                        void loadData();
                                    }}
                                    disabled={loading}
                                >
                                    {loading ? 'Refreshing...' : 'Refresh'}
                                </button>
                            </div>

                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                <Badge label={selectedStatusMeta?.label ?? 'Unknown'} color={selectedStatusMeta?.color ?? '#4c5f85'} bg={selectedStatusMeta?.bg ?? '#eef2f9'} border={selectedStatusMeta?.border ?? '#d3ddeb'} />
                                <Badge label={selectedRoleMeta.label} color={selectedRoleMeta.color} bg={selectedRoleMeta.bg} border={selectedRoleMeta.border} />
                                {isSelf ? <Badge label="Signed in" color="#2f63ff" bg="#edf3ff" border="#c9d9ff" /> : null}
                            </div>

                            <div className="surface-muted" style={{ padding: '0.8rem' }}>
                                <div style={{ display: 'grid', gap: '0.45rem' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                            Access summary
                                        </span>
                                        <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)' }}>
                                            Created {formatDateTime(selectedUser.createdAt)}
                                        </span>
                                    </div>
                                    <div style={{ display: 'grid', gap: '0.3rem' }}>
                                        <div style={{ fontSize: '0.84rem', color: 'var(--text-primary)', fontWeight: 650 }}>
                                            Last login: {formatRelativeTime(selectedUser.lastLoginAt)}
                                        </div>
                                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                            {selectedUser.lockedUntil ? `Locked until ${formatDateTime(selectedUser.lockedUntil)}` : 'No active lock timer'}
                                        </div>
                                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                            {selectedUser.pinLockedUntil ? `PIN lock until ${formatDateTime(selectedUser.pinLockedUntil)}` : 'PIN access not currently locked'}
                                        </div>
                                    </div>
                                    {isSelf ? (
                                        <div style={{ fontSize: '0.74rem', color: '#234ed9' }}>
                                            Role and tenant assignment are locked for your own account.
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            {!visibleSelection ? (
                                <div
                                    style={{
                                        padding: '0.75rem 0.8rem',
                                        borderRadius: 12,
                                        border: '1px solid #dbe4f0',
                                        background: '#f8faff',
                                        color: 'var(--text-secondary)',
                                        fontSize: '0.82rem',
                                    }}
                                >
                                    This user is outside the current table filters.
                                </div>
                            ) : null}

                            <div style={{ display: 'grid', gap: '0.75rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Full name</span>
                                    <input
                                        className="form-input"
                                        value={form.name}
                                        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                                        placeholder="Full name"
                                    />
                                </label>

                                <div className="admin-users-inline-two" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                                    <label className="form-group">
                                        <span className="form-label">Email</span>
                                        <input
                                            className="form-input"
                                            value={form.email}
                                            onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                                            placeholder="name@company.com"
                                        />
                                    </label>

                                    <label className="form-group">
                                        <span className="form-label">Username</span>
                                        <input
                                            className="form-input"
                                            value={form.username}
                                            onChange={(event) => setForm((current) => ({ ...current, username: event.target.value.toLowerCase() }))}
                                            placeholder="lowercase username"
                                        />
                                    </label>
                                </div>

                                <div className="admin-users-inline-two" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                                    <label className="form-group">
                                        <span className="form-label">Role</span>
                                        <select
                                            className="form-input"
                                            value={form.role}
                                            onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as UserRole }))}
                                            disabled={isSelf}
                                        >
                                            {(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'] as UserRole[]).map((role) => (
                                                <option key={role} value={role}>
                                                    {role}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <label className="form-group">
                                        <span className="form-label">Tenant assignment</span>
                                        <select
                                            className="form-input"
                                            value={form.tenantId}
                                            onChange={(event) => setForm((current) => ({ ...current, tenantId: event.target.value }))}
                                            disabled={tenants.length === 0 || isSelf}
                                        >
                                            {tenants.length === 0 ? (
                                                <option value="">Loading tenants...</option>
                                            ) : null}
                                            {tenants.map((tenant) => (
                                                <option key={tenant.id} value={tenant.id}>
                                                    {tenant.name} · {tenant.slug} · {tenant.planTier}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </div>
                            </div>

                            <div className="surface-muted" style={{ padding: '0.8rem', display: 'grid', gap: '0.55rem' }}>
                                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>Access operations</div>
                                <label className="form-group">
                                    <span className="form-label">Lock duration</span>
                                    <input
                                        className="form-input"
                                        type="number"
                                        min={1}
                                        max={60 * 24 * 30}
                                        value={lockMinutes}
                                        onChange={(event) => setLockMinutes(event.target.value.replace(/[^\d]/g, ''))}
                                        placeholder="60"
                                    />
                                </label>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    Locking revokes active sessions. Suspension blocks the account until reactivated.
                                </div>
                            </div>

                            <div className="admin-users-action-row" style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                <button className="btn" type="button" onClick={() => void saveUser()} disabled={saveDisabled}>
                                    {savingKey === `save:${selectedUser.id}` ? 'Saving...' : 'Save changes'}
                                </button>
                                <button className="btn btn-secondary" type="button" onClick={() => void resetPin()} disabled={pinDisabled}>
                                    {savingKey === `pin:${selectedUser.id}` ? 'Resetting PIN...' : 'Reset PIN'}
                                </button>
                                {selectedUser.status === 'SUSPENDED' ? (
                                    <button
                                        className="btn btn-sm"
                                        type="button"
                                        onClick={() => void toggleSuspension()}
                                        disabled={suspendDisabled}
                                        style={{ background: '#e9fbf1', color: '#0f8c52', borderColor: '#bdeed4' }}
                                    >
                                        {savingKey === `suspend:${selectedUser.id}` ? 'Activating...' : 'Activate'}
                                    </button>
                                ) : (
                                    <button
                                        className="btn btn-sm"
                                        type="button"
                                        onClick={() => void toggleLock()}
                                        disabled={lockDisabled}
                                        style={{
                                            background: selectedUser.status === 'LOCKED' ? '#e9fbf1' : '#ffeef2',
                                            color: selectedUser.status === 'LOCKED' ? '#0f8c52' : '#cb3653',
                                            borderColor: selectedUser.status === 'LOCKED' ? '#bdeed4' : '#ffd0da',
                                        }}
                                    >
                                        {savingKey === `lock:${selectedUser.id}`
                                            ? selectedUser.status === 'LOCKED'
                                                ? 'Unlocking...'
                                                : 'Locking...'
                                            : selectedUser.status === 'LOCKED'
                                                ? 'Unlock'
                                                : 'Lock'}
                                    </button>
                                )}
                                {selectedUser.status === 'SUSPENDED' ? null : (
                                    <button
                                        className="btn btn-sm"
                                        type="button"
                                        onClick={() => void toggleSuspension()}
                                        disabled={suspendDisabled}
                                        style={{ background: '#fff4e2', color: '#cc7f06', borderColor: '#ffe1a6' }}
                                    >
                                        {savingKey === `suspend:${selectedUser.id}` ? 'Suspending...' : 'Suspend'}
                                    </button>
                                )}
                            </div>

                            {temporaryPin ? (
                                <div className="surface-muted" style={{ padding: '0.8rem', borderColor: '#ffe1a6', background: '#fff7e7' }}>
                                    <div style={{ fontSize: '0.78rem', color: '#7a2e14', marginBottom: 2 }}>Temporary PIN</div>
                                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#cc7f06', letterSpacing: '0.04em', fontFamily: 'var(--font-mono)' }}>
                                        {temporaryPin}
                                    </div>
                                    <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 4 }}>
                                        Share this securely. The user should reset it after first login.
                                    </div>
                                </div>
                            ) : null}

                            {isSelf ? (
                                <div
                                    style={{
                                        padding: '0.75rem 0.8rem',
                                        borderRadius: 12,
                                        border: '1px solid #c9d9ff',
                                        background: '#edf3ff',
                                        color: '#234ed9',
                                        fontSize: '0.82rem',
                                    }}
                                >
                                    Status actions are disabled for the currently signed-in account.
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <div
                            style={{
                                padding: '1rem',
                                borderRadius: 14,
                                border: '1px dashed #d5ddea',
                                background: '#fbfcff',
                                color: 'var(--text-muted)',
                                fontSize: '0.86rem',
                            }}
                        >
                            No user selected.
                        </div>
                    )}
                </article>
            </section>

            <style jsx>{`
                .admin-users-grid {
                    display: grid;
                    grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.75fr);
                    gap: 0.85rem;
                    align-items: start;
                }

                .admin-users-stats {
                    display: grid;
                    grid-template-columns: repeat(4, minmax(0, 1fr));
                    gap: 0.75rem;
                }

                .admin-users-table {
                    min-width: 1120px;
                }

                @media (max-width: 1180px) {
                    .admin-users-grid {
                        grid-template-columns: 1fr;
                    }

                    .admin-users-stats {
                        grid-template-columns: repeat(2, minmax(0, 1fr));
                    }
                }

                @media (max-width: 720px) {
                    .admin-users-stats {
                        grid-template-columns: 1fr;
                    }

                    .admin-users-inline-two {
                        grid-template-columns: 1fr !important;
                    }

                    .admin-users-action-row {
                        flex-direction: column;
                        align-items: stretch;
                    }
                }
            `}</style>
        </div>
    );
}
