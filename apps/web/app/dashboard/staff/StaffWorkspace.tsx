'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchWithSession } from '@/lib/client-api';

type StaffWorkspaceProps = {
    canManage: boolean;
};

type ApiUser = {
    id: string;
    name: string;
    email: string;
    username?: string;
    role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
    pinEnabled?: boolean;
    pinResetRequired?: boolean;
};

type StaffUser = ApiUser & { status: 'active' | 'inactive' };

function getCsrfTokenFromCookie(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie
        .split('; ')
        .find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}

function jsonWriteInit(method: 'POST' | 'PUT' | 'DELETE', payload?: unknown): RequestInit {
    const csrfToken = getCsrfTokenFromCookie();
    return {
        method,
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
    };
}

function initials(name: string): string {
    return name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0]?.toUpperCase() ?? '')
        .join('') || 'SM';
}

export function StaffWorkspace({ canManage }: StaffWorkspaceProps) {
    const [users, setUsers] = useState<StaffUser[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [inviteName, setInviteName] = useState('');
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteUsername, setInviteUsername] = useState('');
    const [invitePin, setInvitePin] = useState('');
    const [inviteRole, setInviteRole] = useState<'MANAGER' | 'STAFF'>('STAFF');
    const [inviteLoginType, setInviteLoginType] = useState<'email' | 'username'>('username');
    const [isInviting, setIsInviting] = useState(false);
    const [lastTemporaryPin, setLastTemporaryPin] = useState<string | null>(null);

    const loadUsers = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await fetchWithSession('/users');
            if (!res.ok) throw new Error('Unable to load staff.');
            const payload = (await res.json()) as { data?: ApiUser[] };
            const staff = (payload.data ?? [])
                .filter((u) => u.role !== 'ADMIN' && u.role !== 'SUPER_ADMIN')
                .map((u) => ({ ...u, status: 'active' as const }));
            setUsers(staff);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadUsers();
    }, [loadUsers]);

    const stats = useMemo(() => {
        const total = users.length;
        const managers = users.filter((u) => u.role === 'MANAGER').length;
        const staff = users.filter((u) => u.role === 'STAFF').length;
        return { total, managers, staff };
    }, [users]);

    const inviteUser = useCallback(async () => {
        if (!inviteName.trim()) {
            setError('Name is required.');
            return;
        }
        if (inviteLoginType === 'email' && !inviteEmail.trim()) {
            setError('Email is required for email login.');
            return;
        }
        if (inviteLoginType === 'username' && !inviteUsername.trim()) {
            setError('Username is required for PIN login.');
            return;
        }
        setIsInviting(true);
        setError(null);
        try {
            const res = await fetchWithSession('/users/invite', jsonWriteInit('POST', {
                name: inviteName.trim(),
                email: inviteLoginType === 'email' ? inviteEmail.trim() || undefined : undefined,
                username: inviteLoginType === 'username' ? inviteUsername.trim() || undefined : undefined,
                pin: inviteLoginType === 'username' ? invitePin.trim() || undefined : undefined,
                role: inviteRole,
            }));
            if (!res.ok) throw new Error('Failed to create staff member.');
            const payload = (await res.json().catch(() => ({}))) as { temporaryPin?: string };
            setInviteName('');
            setInviteEmail('');
            setInviteUsername('');
            setInvitePin('');
            setInviteRole('STAFF');
            setInviteLoginType('username');
            setLastTemporaryPin(payload.temporaryPin ?? null);
            await loadUsers();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsInviting(false);
        }
    }, [inviteEmail, inviteName, inviteRole, inviteUsername, invitePin, inviteLoginType, loadUsers]);

    const updateRole = useCallback(async (id: string, role: 'MANAGER' | 'STAFF') => {
        setIsSaving(id);
        setError(null);
        try {
            const res = await fetchWithSession(`/users/${id}/role`, jsonWriteInit('PUT', { role }));
            if (!res.ok) throw new Error('Failed to update role.');
            setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, role } : u)));
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsSaving(null);
        }
    }, []);

    const resetPin = useCallback(async (id: string) => {
        setIsSaving(id);
        setError(null);
        try {
            const res = await fetchWithSession(`/users/${id}/pin/reset`, jsonWriteInit('POST'));
            if (!res.ok) throw new Error('Failed to reset PIN.');
            const payload = (await res.json().catch(() => ({}))) as { temporaryPin?: string };
            setUsers((prev) => prev.map((u) => (
                u.id === id ? { ...u, pinEnabled: true, pinResetRequired: true } : u
            )));
            setLastTemporaryPin(payload.temporaryPin ?? null);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsSaving(null);
        }
    }, []);

    const deactivate = useCallback(async (id: string) => {
        setIsSaving(id);
        setError(null);
        try {
            const res = await fetchWithSession(`/users/${id}`, jsonWriteInit('DELETE'));
            if (!res.ok && res.status !== 204) throw new Error('Failed to remove staff member.');
            setUsers((prev) => prev.filter((u) => u.id !== id));
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsSaving(null);
        }
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1280 }}>
            <section className="surface-card" style={{ padding: '1rem', display: 'grid', gap: '0.9rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.8rem' }}>
                    <div>
                        <div className="workspace-kicker">People workspace</div>
                        <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>Staff</h1>
                        <p className="workspace-subtitle">
                            {isLoading ? 'Loading staff...' : `${stats.total} staff members`}
                        </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void loadUsers()} disabled={isLoading}>
                        Refresh
                    </Button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.6rem' }}>
                    <div className="surface-muted" style={{ padding: '0.7rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Total staff</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)' }}>{stats.total}</div>
                    </div>
                    <div className="surface-muted" style={{ padding: '0.7rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Managers</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#0f8c52' }}>{stats.managers}</div>
                    </div>
                    <div className="surface-muted" style={{ padding: '0.7rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Staff</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#4c5f85' }}>{stats.staff}</div>
                    </div>
                </div>

                {canManage ? (
                        <div className="surface-muted" style={{ padding: '0.8rem', display: 'grid', gap: '0.6rem' }}>
                            <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>Create staff member</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr) minmax(0, 1fr) 120px auto', gap: '0.5rem' }}>
                            <select
                                value={inviteLoginType}
                                onChange={(e) => setInviteLoginType(e.target.value as 'email' | 'username')}
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            >
                                <option value="username">Username + PIN</option>
                                <option value="email">Email + OTP</option>
                            </select>
                            <input
                                type="text"
                                value={inviteName}
                                onChange={(e) => setInviteName(e.target.value)}
                                placeholder="Full name"
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            />
                            {inviteLoginType === 'email' ? (
                                <input
                                    type="email"
                                    value={inviteEmail}
                                    onChange={(e) => setInviteEmail(e.target.value)}
                                    placeholder="name@company.com"
                                    style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                                />
                            ) : (
                                <input
                                    type="text"
                                    value={inviteUsername}
                                    onChange={(e) => setInviteUsername(e.target.value)}
                                    placeholder="username (lowercase)"
                                    style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                                />
                            )}
                            {inviteLoginType === 'username' ? (
                                <input
                                    type="text"
                                    value={invitePin}
                                    onChange={(e) => setInvitePin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                                    placeholder="PIN (optional)"
                                    style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                                />
                            ) : (
                                <div />
                            )}
                            <select
                                value={inviteRole}
                                onChange={(e) => setInviteRole(e.target.value as 'MANAGER' | 'STAFF')}
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            >
                                <option value="STAFF">Staff</option>
                                <option value="MANAGER">Manager</option>
                            </select>
                            <Button size="sm" onClick={() => void inviteUser()} disabled={isInviting}>
                                {isInviting ? 'Creating...' : 'Create'}
                            </Button>
                        </div>
                        {lastTemporaryPin ? (
                            <div style={{ fontSize: '0.78rem', color: '#7a2e14' }}>
                                Temporary PIN: <strong>{lastTemporaryPin}</strong> (share securely; user should reset after first login)
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </section>

            <section className="surface-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
                    <thead>
                        <tr style={{ background: '#f8faff', borderBottom: '1px solid var(--border)' }}>
                            {['Member', 'Login', 'Role', ...(canManage ? ['Actions'] : [])].map((h) => (
                                <th
                                    key={h}
                                    style={{
                                        textAlign: 'left',
                                        padding: '0.8rem 1rem',
                                        fontSize: '0.67rem',
                                        fontWeight: 700,
                                        color: 'var(--text-muted)',
                                        letterSpacing: '0.08em',
                                        textTransform: 'uppercase',
                                    }}
                                >
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((u, i) => (
                            <tr key={u.id} style={{ borderBottom: i < users.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                <td style={{ padding: '0.86rem 1rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                                        <div
                                            style={{
                                                width: 34,
                                                height: 34,
                                                borderRadius: '50%',
                                                border: '1px solid #c9d6ef',
                                                background: '#edf3ff',
                                                display: 'grid',
                                                placeItems: 'center',
                                                fontSize: '0.66rem',
                                                fontWeight: 800,
                                                color: '#244aa8',
                                            }}
                                        >
                                            {initials(u.name)}
                                        </div>
                                        <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)' }}>{u.name}</div>
                                    </div>
                                </td>
                                <td style={{ padding: '0.86rem 1rem', color: 'var(--text-secondary)', fontSize: '0.83rem' }}>
                                    {u.email ? (
                                        <span>{u.email}</span>
                                    ) : (
                                        <div style={{ display: 'grid', gap: '0.15rem' }}>
                                            <span style={{ fontFamily: 'var(--font-mono)' }}>{u.username || '—'}</span>
                                            <span style={{ fontSize: '0.72rem', color: u.pinResetRequired ? '#cb3653' : 'var(--text-muted)' }}>
                                                {u.pinEnabled ? (u.pinResetRequired ? 'PIN reset required' : 'PIN active') : 'PIN not set'}
                                            </span>
                                        </div>
                                    )}
                                </td>
                                <td style={{ padding: '0.86rem 1rem' }}>
                                    {canManage ? (
                                        <select
                                            value={u.role}
                                            disabled={isSaving === u.id}
                                            onChange={(e) => void updateRole(u.id, e.target.value as 'MANAGER' | 'STAFF')}
                                            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.34rem 0.45rem', background: '#fff', color: 'var(--text-primary)' }}
                                        >
                                            <option value="STAFF">STAFF</option>
                                            <option value="MANAGER">MANAGER</option>
                                        </select>
                                    ) : (
                                        <span style={{ fontSize: '0.72rem', fontWeight: 700 }}>{u.role}</span>
                                    )}
                                </td>
                                {canManage ? (
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                            {!u.email ? (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => void resetPin(u.id)}
                                                    disabled={isSaving === u.id}
                                                >
                                                    {isSaving === u.id ? 'Resetting...' : 'Reset PIN'}
                                                </Button>
                                            ) : null}
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => void deactivate(u.id)}
                                                disabled={isSaving === u.id}
                                            >
                                                {isSaving === u.id ? 'Removing...' : 'Remove'}
                                            </Button>
                                        </div>
                                    </td>
                                ) : null}
                            </tr>
                        ))}
                        {!isLoading && users.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={canManage ? 4 : 3}
                                    style={{ padding: '1rem', fontSize: '0.84rem', color: 'var(--text-muted)' }}
                                >
                                    No staff members found.
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </section>

            {error ? (
                <div
                    style={{
                        padding: '0.7rem 0.8rem',
                        borderRadius: 10,
                        border: '1px solid rgba(244,63,94,0.35)',
                        color: '#fda4af',
                        background: 'rgba(244,63,94,0.06)',
                    }}
                >
                    {error}
                </div>
            ) : null}
        </div>
    );
}
