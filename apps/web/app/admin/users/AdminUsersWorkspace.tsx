'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';
import {
    EMPTY_ADMIN_LIST_PAGINATION,
    buildAdminListPath,
    mergeAdminListPage,
    parseAdminListPagination,
    retainAdminListSelection,
    type AdminListPagination,
} from '../admin-list-pagination';
import { canMutateAdminUserLifecycle, resolveAdminUserStatus, type AdminUserStatus } from './admin-user-lifecycle';

type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type StatusFilter = 'ALL' | AdminUserStatus;

type AdminTenant = {
    id: string;
    name: string;
    slug: string;
    planTier?: string;
    status?: string;
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
    suspendedAt: string | null;
    deletedAt: string | null;
    mfaEnabled: boolean;
    status: AdminUserStatus;
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

type PaginatedAdminList<T> = {
    data?: T[];
    pagination?: unknown;
};

type LoadPageOptions = {
    cursor?: string | null;
    append?: boolean;
};

const USER_PAGE_LIMIT = 100;
const TENANT_PAGE_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;

const ROLE_META: Record<UserRole, { label: string; color: string; bg: string; border: string }> = {
    SUPER_ADMIN: { label: 'SUPER_ADMIN', color: '#b4233f', bg: '#ffeef2', border: '#ffd0da' },
    ADMIN: { label: 'ADMIN', color: '#1d4ed8', bg: '#edf3ff', border: '#c9d9ff' },
    MANAGER: { label: 'MANAGER', color: '#166534', bg: '#e9fbf1', border: '#bdeed4' },
    STAFF: { label: 'STAFF', color: '#4c5f85', bg: '#eef2f9', border: '#d3ddeb' },
};

const STATUS_META: Record<AdminUserStatus, { label: string; color: string; bg: string; border: string; dot: string }> = {
    ACTIVE: { label: 'Active', color: '#166534', bg: '#e9fbf1', border: '#bdeed4', dot: '#166534' },
    LOCKED: { label: 'Locked', color: '#7c4a03', bg: '#fff4e2', border: '#ffe1a6', dot: '#7c4a03' },
    SUSPENDED: { label: 'Suspended', color: '#b4233f', bg: '#ffeef2', border: '#ffd0da', dot: '#e74867' },
    DELETED: { label: 'Deleted', color: '#4b5563', bg: '#f3f4f6', border: '#d1d5db', dot: '#6b7280' },
};

const FILTER_META: Record<StatusFilter, { label: string; color: string; bg: string; border: string }> = {
    ALL: { label: 'All', color: '#4c5f85', bg: '#eef2f9', border: '#d3ddeb' },
    ACTIVE: { label: 'Active', color: '#166534', bg: '#e9fbf1', border: '#bdeed4' },
    LOCKED: { label: 'Locked', color: '#7c4a03', bg: '#fff4e2', border: '#ffe1a6' },
    SUSPENDED: { label: 'Suspended', color: '#b4233f', bg: '#ffeef2', border: '#ffd0da' },
    DELETED: { label: 'Deleted', color: '#4b5563', bg: '#f3f4f6', border: '#d1d5db' },
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
    const [userPagination, setUserPagination] = useState<AdminListPagination>(EMPTY_ADMIN_LIST_PAGINATION);
    const [tenantPagination, setTenantPagination] = useState<AdminListPagination>(EMPTY_ADMIN_LIST_PAGINATION);
    const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
    const [assignedTenantOption, setAssignedTenantOption] = useState<AdminTenant | null>(null);
    const [form, setForm] = useState<UserForm>(() => emptyForm([]));
    const [lockMinutes, setLockMinutes] = useState('60');
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [tenantSearch, setTenantSearch] = useState('');
    const [debouncedTenantSearch, setDebouncedTenantSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
    const [loading, setLoading] = useState(true);
    const [loadingMoreUsers, setLoadingMoreUsers] = useState(false);
    const [tenantLoading, setTenantLoading] = useState(true);
    const [tenantLoadingMore, setTenantLoadingMore] = useState(false);
    const [savingKey, setSavingKey] = useState<string | null>(null);
    const [message, setMessage] = useState<Banner>(null);
    const [temporaryPin, setTemporaryPin] = useState<string | null>(null);
    const userRequestId = useRef(0);
    const tenantRequestId = useRef(0);

    const selectedUser = useMemo(
        () => users.find((user) => user.id === selectedUserId) ?? null,
        [selectedUserId, users],
    );
    const tenantOptions = useMemo(
        () => retainAdminListSelection(tenants, assignedTenantOption),
        [assignedTenantOption, tenants],
    );

    const isSelf = Boolean(currentUserId && selectedUser?.id === currentUserId);
    const selectedIsDeleted = selectedUser?.status === 'DELETED';
    const selectedStatusMeta = selectedUser ? STATUS_META[selectedUser.status] : null;
    const selectedRoleMeta = selectedUser ? ROLE_META[selectedUser.role] : ROLE_META.STAFF;

    const loadUsers = useCallback(async ({ cursor, append = false }: LoadPageOptions = {}) => {
        const requestId = ++userRequestId.current;
        if (append) setLoadingMoreUsers(true);
        else setLoading(true);
        try {
            const payload = await fetchJsonWithSession<PaginatedAdminList<AdminUser>>(buildAdminListPath('/admin/users', {
                limit: USER_PAGE_LIMIT,
                cursor,
                q: debouncedSearch || undefined,
                status: statusFilter,
            }));
            if (requestId !== userRequestId.current) return;
            const nextUsers = Array.isArray(payload.data)
                ? payload.data.map((user) => ({ ...user, status: resolveAdminUserStatus(user) }))
                : [];
            setUsers((current) => mergeAdminListPage(current, nextUsers, append));
            setUserPagination(parseAdminListPagination(payload.pagination));
            setSelectedUserId((current) => {
                if (append) return current ?? nextUsers[0]?.id ?? null;
                if (current && nextUsers.some((user) => user.id === current)) return current;
                return nextUsers[0]?.id ?? null;
            });
        } catch (error) {
            if (requestId === userRequestId.current) {
                setMessage({ tone: 'error', text: (error as Error).message });
            }
        } finally {
            if (requestId === userRequestId.current) {
                if (append) setLoadingMoreUsers(false);
                else setLoading(false);
            }
        }
    }, [debouncedSearch, statusFilter]);

    const loadTenants = useCallback(async ({ cursor, append = false }: LoadPageOptions = {}) => {
        const requestId = ++tenantRequestId.current;
        if (append) setTenantLoadingMore(true);
        else setTenantLoading(true);
        try {
            const payload = await fetchJsonWithSession<PaginatedAdminList<AdminTenant>>(buildAdminListPath('/admin/tenants', {
                limit: TENANT_PAGE_LIMIT,
                cursor,
                q: debouncedTenantSearch || undefined,
            }));
            if (requestId !== tenantRequestId.current) return;
            const nextTenants = Array.isArray(payload.data) ? payload.data : [];
            setTenants((current) => mergeAdminListPage(current, nextTenants, append));
            setTenantPagination(parseAdminListPagination(payload.pagination));
        } catch (error) {
            if (requestId === tenantRequestId.current) {
                setMessage({ tone: 'error', text: (error as Error).message });
            }
        } finally {
            if (requestId === tenantRequestId.current) {
                if (append) setTenantLoadingMore(false);
                else setTenantLoading(false);
            }
        }
    }, [debouncedTenantSearch]);

    const refreshUsers = useCallback(() => loadUsers(), [loadUsers]);

    useEffect(() => {
        const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timeout);
    }, [search]);

    useEffect(() => {
        const timeout = window.setTimeout(
            () => setDebouncedTenantSearch(tenantSearch.trim()),
            SEARCH_DEBOUNCE_MS,
        );
        return () => window.clearTimeout(timeout);
    }, [tenantSearch]);

    useEffect(() => {
        void loadUsers();
        return () => {
            userRequestId.current += 1;
        };
    }, [loadUsers]);

    useEffect(() => {
        void loadTenants();
        return () => {
            tenantRequestId.current += 1;
        };
    }, [loadTenants]);

    useEffect(() => {
        if (!selectedUser) {
            setForm(emptyForm([]));
            setAssignedTenantOption(null);
            return;
        }
        setForm(emptyForm([], selectedUser));
        setAssignedTenantOption(selectedUser.tenant);
    }, [selectedUser]);

    useEffect(() => {
        setTemporaryPin(null);
    }, [selectedUserId]);

    const saveUser = useCallback(async () => {
        if (!selectedUser || selectedUser.status === 'DELETED') return;
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
        setSavingKey(`save:${selectedUser.id}`);
        setMessage(null);
        try {
            await writeJson(`/admin/users/${selectedUser.id}`, 'PUT', {
                name,
                email: email || null,
                username: username || null,
                role: form.role,
            });
            setMessage({ tone: 'success', text: `${name} was updated.` });
            await refreshUsers();
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setSavingKey(null);
        }
    }, [form, refreshUsers, selectedUser]);

    const resetPin = useCallback(async () => {
        if (!selectedUser || selectedUser.status === 'DELETED') return;
        setSavingKey(`pin:${selectedUser.id}`);
        setMessage(null);
        try {
            const payload = await writeJson<{ temporaryPin?: string; username?: string; pinResetRequired?: boolean }>(
                `/users/${selectedUser.id}/pin/reset`,
                'POST',
            );
            setTemporaryPin(payload.temporaryPin ?? null);
            setMessage({ tone: 'success', text: `PIN reset for ${selectedUser.name}.` });
            await refreshUsers();
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setSavingKey(null);
        }
    }, [refreshUsers, selectedUser]);

    const resetMfa = useCallback(async () => {
        if (!selectedUser || isSelf || !selectedUser.mfaEnabled || !canMutateAdminUserLifecycle(selectedUser.status) || selectedUser.status === 'SUSPENDED') return;
        const expected = `reset-mfa:${selectedUser.id}`;
        const confirmation = typeof window === 'undefined'
            ? null
            : window.prompt(`Type ${expected} to clear MFA factors and revoke all sessions.`);
        if (confirmation === null) return;
        if (confirmation !== expected) {
            setMessage({ tone: 'error', text: `Confirmation must exactly equal ${expected}.` });
            return;
        }
        const reason = typeof window === 'undefined' ? null : window.prompt('Enter the support reason for this MFA recovery.');
        if (reason === null) return;
        if (reason.trim().length < 10) {
            setMessage({ tone: 'error', text: 'Recovery reason must contain at least 10 characters.' });
            return;
        }

        setSavingKey(`mfa:${selectedUser.id}`);
        setMessage(null);
        try {
            await writeJson(`/admin/users/${selectedUser.id}/mfa/reset`, 'POST', { confirmation, reason: reason.trim() });
            setMessage({ tone: 'success', text: `MFA factors cleared for ${selectedUser.name}; all sessions were revoked.` });
            await refreshUsers();
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setSavingKey(null);
        }
    }, [isSelf, refreshUsers, selectedUser]);

    const toggleLock = useCallback(async (targetUser?: AdminUser) => {
        const user = targetUser ?? selectedUser;
        if (!user || user.status === 'SUSPENDED' || user.status === 'DELETED') return;
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
            await refreshUsers();
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setSavingKey(null);
        }
    }, [lockMinutes, refreshUsers, selectedUser]);

    const toggleSuspension = useCallback(async (targetUser?: AdminUser) => {
        const user = targetUser ?? selectedUser;
        if (!user || user.status === 'DELETED') return;
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
                    : window.confirm(`Suspend ${user.name}? This revokes current sessions while preserving identity and credentials. Reactivation restores sign-in.`);
                if (!confirmed) return;
                await writeJson(`/admin/users/${user.id}/suspend`, 'POST');
                setMessage({ tone: 'success', text: `${user.name} was suspended.` });
            }
            await refreshUsers();
        } catch (error) {
            setMessage({ tone: 'error', text: (error as Error).message });
        } finally {
            setSavingKey(null);
        }
    }, [currentUserId, refreshUsers, selectedUser]);

    const selectUser = useCallback((userId: string) => {
        setSelectedUserId(userId);
        setMessage(null);
    }, []);

    const actionDisabled = loading || !selectedUser;
    const saveDisabled = actionDisabled || selectedIsDeleted || savingKey === `save:${selectedUser?.id ?? ''}`;
    const pinDisabled = actionDisabled || selectedIsDeleted || savingKey === `pin:${selectedUser?.id ?? ''}`;
    const mfaDisabled = actionDisabled || isSelf || !selectedUser?.mfaEnabled || selectedUser?.status === 'SUSPENDED' || selectedIsDeleted || savingKey === `mfa:${selectedUser?.id ?? ''}`;
    const lockDisabled = actionDisabled || isSelf || selectedUser?.status === 'SUSPENDED' || selectedIsDeleted || savingKey === `lock:${selectedUser?.id ?? ''}`;
    const suspendDisabled = actionDisabled || selectedIsDeleted || (isSelf && selectedUser?.status !== 'SUSPENDED') || savingKey === `suspend:${selectedUser?.id ?? ''}`;

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
                        <div className="workspace-kicker" style={{ color: '#b4233f' }}>
                            Identity and access
                        </div>
                        <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
                            Users
                        </h1>
                        <p className="workspace-subtitle">
                            Cross-tenant user management with server-bound search and status filters.
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
                        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{users.length}</span>
                        <span>matching users loaded</span>
                        {userPagination.hasMore ? <span>- more available</span> : null}
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
                        color: message.tone === 'success' ? '#166534' : '#b4233f',
                        fontWeight: 600,
                        fontSize: '0.86rem',
                    }}
                >
                    {message.text}
                </div>
            ) : null}

            <section
                className="surface-card"
                style={{ padding: '0.85rem 1rem', display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}
            >
                <Users size={18} aria-hidden="true" />
                <strong>{users.length} matching users loaded</strong>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                    {loading ? 'Refreshing the first page...' : userPagination.hasMore ? 'Use Load more to continue.' : 'End of matching results.'}
                </span>
            </section>

            <section className="admin-users-grid">
                <article className="surface-card admin-users-list" style={{ overflowX: 'auto' }}>
                    <div style={{ padding: '1rem 1rem 0.6rem', display: 'grid', gap: '0.75rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                            <div>
                                <h2 style={{ fontSize: '1rem', fontWeight: 760, color: 'var(--text-primary)' }}>Directory</h2>
                                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{users.length} matching users loaded in bounded pages.</div>
                            </div>
                            <button
                                className="btn btn-sm btn-secondary"
                                type="button"
                                onClick={() => {
                                    setMessage(null);
                                    void refreshUsers();
                                }}
                                disabled={loading || loadingMoreUsers}
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
                                {(['ALL', 'ACTIVE', 'LOCKED', 'SUSPENDED', 'DELETED'] as StatusFilter[]).map((filter) => (
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
                            {users.map((user, index) => {
                                const isSelected = user.id === selectedUserId;
                                const rowIsSelf = Boolean(currentUserId && user.id === currentUserId);
                                const rowBusy = Boolean(savingKey && savingKey.endsWith(`:${user.id}`));
                                const isLocked = user.status === 'LOCKED';
                                const isSuspended = user.status === 'SUSPENDED';
                                const isDeleted = user.status === 'DELETED';
                                const status = STATUS_META[user.status];
                                const role = ROLE_META[user.role];

                                return (
                                    <tr
                                        key={user.id}
                                        style={{
                                            borderBottom: index < users.length - 1 ? '1px solid var(--border)' : 'none',
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
                                                        color: '#1d4ed8',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    {initials(user.name)}
                                                </div>
                                                <div style={{ minWidth: 0 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                        <span style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)' }}>{user.name}</span>
                                                        {rowIsSelf ? (
                                                            <span className="badge" style={{ background: '#edf3ff', borderColor: '#c9d9ff', color: '#1d4ed8', fontSize: '0.58rem' }}>
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
                                                    {isDeleted ? 'View' : 'Edit'}
                                                </button>
                                                <button
                                                    className="btn btn-sm"
                                                    type="button"
                                                    disabled={loading || rowBusy || isSuspended || isDeleted || (rowIsSelf && user.status !== 'SUSPENDED')}
                                                    onClick={() => {
                                                        selectUser(user.id);
                                                        void toggleLock(user);
                                                    }}
                                                    style={{
                                                        background: isLocked ? '#e9fbf1' : '#ffeef2',
                                                        color: isLocked ? '#166534' : '#b4233f',
                                                        borderColor: isLocked ? '#bdeed4' : '#ffd0da',
                                                        opacity: isSuspended || isDeleted || (rowIsSelf && user.status !== 'SUSPENDED') ? 0.55 : 1,
                                                    }}
                                                >
                                                    {isLocked ? 'Unlock' : 'Lock'}
                                                </button>
                                                <button
                                                    className="btn btn-sm"
                                                    type="button"
                                                    disabled={loading || rowBusy || isDeleted || (rowIsSelf && user.status !== 'SUSPENDED')}
                                                    onClick={() => {
                                                        selectUser(user.id);
                                                        void toggleSuspension(user);
                                                    }}
                                                    style={{
                                                        background: isSuspended ? '#e9fbf1' : '#fff4e2',
                                                        color: isSuspended ? '#166534' : '#7c4a03',
                                                        borderColor: isSuspended ? '#bdeed4' : '#ffe1a6',
                                                        opacity: isDeleted || (rowIsSelf && user.status !== 'SUSPENDED') ? 0.55 : 1,
                                                    }}
                                                >
                                                    {isSuspended ? 'Activate' : 'Suspend'}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}

                            {!loading && users.length === 0 ? (
                                <tr>
                                    <td colSpan={7} style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.84rem' }}>
                                        No users matched the current filters.
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                    {userPagination.hasMore && userPagination.nextCursor ? (
                        <div style={{ padding: '0.8rem 1rem', borderTop: '1px solid var(--border)' }}>
                            <button
                                className="btn btn-sm btn-secondary"
                                type="button"
                                onClick={() => void loadUsers({ cursor: userPagination.nextCursor, append: true })}
                                disabled={loading || loadingMoreUsers}
                            >
                                {loadingMoreUsers ? 'Loading more users...' : 'Load more users'}
                            </button>
                        </div>
                    ) : null}
                </article>

                <article className="surface-card admin-users-panel" style={{ padding: '1rem', height: 'fit-content' }}>
                    {selectedUser ? (
                        <div style={{ display: 'grid', gap: '0.9rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
                                <div>
                                    <div className="workspace-kicker" style={{ color: '#b4233f' }}>
                                        Selected user
                                    </div>
                                    <h2 style={{ fontSize: '1rem', fontWeight: 760, color: 'var(--text-primary)', marginBottom: 2 }}>
                                        {selectedUser.name}
                                    </h2>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {selectedUser.tenant ? `${selectedUser.tenant.name} - ${selectedUser.tenant.slug}` : 'No tenant assigned'}
                                    </div>
                                </div>

                                <button
                                    className="btn btn-sm btn-secondary"
                                    type="button"
                                    onClick={() => {
                                        setMessage(null);
                                        void refreshUsers();
                                    }}
                                    disabled={loading}
                                >
                                    {loading ? 'Refreshing...' : 'Refresh'}
                                </button>
                            </div>

                            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                <Badge label={selectedStatusMeta?.label ?? 'Unknown'} color={selectedStatusMeta?.color ?? '#4c5f85'} bg={selectedStatusMeta?.bg ?? '#eef2f9'} border={selectedStatusMeta?.border ?? '#d3ddeb'} />
                                <Badge label={selectedRoleMeta.label} color={selectedRoleMeta.color} bg={selectedRoleMeta.bg} border={selectedRoleMeta.border} />
                                {isSelf ? <Badge label="Signed in" color="#1d4ed8" bg="#edf3ff" border="#c9d9ff" /> : null}
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
                                            Role changes are locked for your own account. Tenant reassignment is unavailable for every account.
                                        </div>
                                    ) : null}
                                </div>
                            </div>


                            <div style={{ display: 'grid', gap: '0.75rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Full name</span>
                                    <input
                                        className="form-input"
                                        value={form.name}
                                        onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                                        placeholder="Full name"
                                        disabled={selectedIsDeleted}
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
                                            disabled={selectedIsDeleted}
                                        />
                                    </label>

                                    <label className="form-group">
                                        <span className="form-label">Username</span>
                                        <input
                                            className="form-input"
                                            value={form.username}
                                            onChange={(event) => setForm((current) => ({ ...current, username: event.target.value.toLowerCase() }))}
                                            placeholder="lowercase username"
                                            disabled={selectedIsDeleted}
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
                                            disabled={isSelf || selectedIsDeleted}
                                        >
                                            {(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF'] as UserRole[]).map((role) => (
                                                <option key={role} value={role}>
                                                    {role}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <div className="form-group">
                                        <label className="form-label" htmlFor="admin-user-tenant-search">Tenant assignment (read-only)</label>
                                        <input
                                            id="admin-user-tenant-search"
                                            className="form-input"
                                            value={tenantSearch}
                                            onChange={(event) => setTenantSearch(event.target.value)}
                                            placeholder="Search tenant name or slug"
                                            disabled
                                        />
                                        <select
                                            id="admin-user-tenant-assignment"
                                            aria-label="Assigned tenant"
                                            className="form-input"
                                            value={form.tenantId}
                                            onChange={(event) => {
                                                const tenantId = event.target.value;
                                                setForm((current) => ({ ...current, tenantId }));
                                                setAssignedTenantOption(tenantOptions.find((tenant) => tenant.id === tenantId) ?? null);
                                            }}
                                            disabled
                                        >
                                            {tenantOptions.length === 0 ? (
                                                <option value="">{tenantLoading ? 'Loading tenants...' : 'No matching tenants'}</option>
                                            ) : null}
                                            {tenantOptions.map((tenant) => (
                                                <option key={tenant.id} value={tenant.id}>
                                                    {tenant.name} - {tenant.slug}{tenant.planTier ? ' - ' + tenant.planTier : ''}
                                                </option>
                                            ))}
                                        </select>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                            <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                                                {tenants.length} matching tenants loaded
                                            </span>
                                            {tenantPagination.hasMore && tenantPagination.nextCursor ? (
                                                <button
                                                    className="btn btn-sm btn-secondary"
                                                    type="button"
                                                    onClick={() => void loadTenants({ cursor: tenantPagination.nextCursor, append: true })}
                                                    disabled
                                                >
                                                    {tenantLoadingMore ? 'Loading more tenants...' : 'Load more tenants'}
                                                </button>
                                            ) : null}
                                        </div>
                                        <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                                            Cross-tenant reassignment is blocked because access assignments and tenant-owned records are not migrated here.
                                        </div>
                                    </div>
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
                                        disabled={selectedIsDeleted}
                                    />
                                </label>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                    Locking revokes active sessions. Suspension is reversible and preserves identity and credentials. Deletion is irreversible.
                                </div>
                            </div>

                            <div className="admin-users-action-row" style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                <button className="btn" type="button" onClick={() => void saveUser()} disabled={saveDisabled}>
                                    {savingKey === `save:${selectedUser.id}` ? 'Saving...' : 'Save changes'}
                                </button>
                                <button className="btn btn-secondary" type="button" onClick={() => void resetPin()} disabled={pinDisabled}>
                                    {savingKey === `pin:${selectedUser.id}` ? 'Resetting PIN...' : 'Reset PIN'}
                                </button>
                                <button
                                    className="btn btn-secondary"
                                    type="button"
                                    onClick={() => void resetMfa()}
                                    disabled={mfaDisabled}
                                >
                                    {savingKey === `mfa:${selectedUser.id}` ? 'Resetting MFA...' : 'Reset MFA'}
                                </button>
                                {selectedUser.status === 'SUSPENDED' ? (
                                    <button
                                        className="btn btn-sm"
                                        type="button"
                                        onClick={() => void toggleSuspension()}
                                        disabled={suspendDisabled}
                                        style={{ background: '#e9fbf1', color: '#166534', borderColor: '#bdeed4' }}
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
                                            color: selectedUser.status === 'LOCKED' ? '#166534' : '#b4233f',
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
                                        style={{ background: '#fff4e2', color: '#7c4a03', borderColor: '#ffe1a6' }}
                                    >
                                        {savingKey === `suspend:${selectedUser.id}` ? 'Suspending...' : 'Suspend'}
                                    </button>
                                )}
                            </div>

                            {temporaryPin ? (
                                <div className="surface-muted" style={{ padding: '0.8rem', borderColor: '#ffe1a6', background: '#fff7e7' }}>
                                    <div style={{ fontSize: '0.78rem', color: '#7a2e14', marginBottom: 2 }}>Temporary PIN</div>
                                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#7c4a03', letterSpacing: '0.04em', fontFamily: 'var(--font-mono)' }}>
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


                .admin-users-table {
                    min-width: 1120px;
                }

                @media (max-width: 1180px) {
                    .admin-users-grid {
                        grid-template-columns: 1fr;
                    }


                }

                @media (max-width: 720px) {

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
