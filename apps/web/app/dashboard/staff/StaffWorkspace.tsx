'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { fetchWithSession } from '@/lib/client-api';

type StaffWorkspaceProps = {
    canManage: boolean;
    canManageRoles: boolean;
};

type AssignedRole = {
    id: string;
    name: string;
    description?: string | null;
    isSystem: boolean;
    legacyRole?: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF' | null;
    permissions: string[];
};

type ApiUser = {
    id: string;
    name: string;
    email: string;
    username?: string;
    role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
    pinEnabled?: boolean;
    pinResetRequired?: boolean;
    assignedRoles: AssignedRole[];
};

type PermissionCatalogItem = {
    key: string;
    label: string;
    description?: string | null;
    category: string;
};

type RoleCatalogItem = {
    id: string;
    name: string;
    slug: string;
    description?: string | null;
    isSystem: boolean;
    isDefault: boolean;
    legacyRole?: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF' | null;
    userCount: number;
    permissions: string[];
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

function byCategory(items: PermissionCatalogItem[]): Record<string, PermissionCatalogItem[]> {
    return items.reduce<Record<string, PermissionCatalogItem[]>>((acc, item) => {
        acc[item.category] ??= [];
        acc[item.category].push(item);
        return acc;
    }, {});
}

export function StaffWorkspace({ canManage, canManageRoles }: StaffWorkspaceProps) {
    const [users, setUsers] = useState<StaffUser[]>([]);
    const [roles, setRoles] = useState<RoleCatalogItem[]>([]);
    const [permissions, setPermissions] = useState<PermissionCatalogItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [inviteName, setInviteName] = useState('');
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteUsername, setInviteUsername] = useState('');
    const [invitePin, setInvitePin] = useState('');
    const [inviteRoleId, setInviteRoleId] = useState('');
    const [inviteLoginType, setInviteLoginType] = useState<'email' | 'username'>('username');
    const [isInviting, setIsInviting] = useState(false);
    const [lastTemporaryPin, setLastTemporaryPin] = useState<string | null>(null);

    const [editorRoleId, setEditorRoleId] = useState<string | null>(null);
    const [editorName, setEditorName] = useState('');
    const [editorDescription, setEditorDescription] = useState('');
    const [editorPermissionKeys, setEditorPermissionKeys] = useState<string[]>([]);

    const loadWorkspace = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const [usersRes, accessRes] = await Promise.all([
                fetchWithSession('/users'),
                fetchWithSession('/users/access/catalog'),
            ]);

            if (!usersRes.ok) throw new Error('Unable to load staff.');
            if (!accessRes.ok) throw new Error('Unable to load roles and permissions.');

            const usersPayload = (await usersRes.json()) as { data?: ApiUser[] };
            const accessPayload = (await accessRes.json()) as { roles?: RoleCatalogItem[]; permissions?: PermissionCatalogItem[] };

            setUsers((usersPayload.data ?? []).map((user) => ({ ...user, status: 'active' as const })));
            setRoles(accessPayload.roles ?? []);
            setPermissions(accessPayload.permissions ?? []);

            const defaultInviteRole = (accessPayload.roles ?? []).find((role) => role.isDefault) ?? accessPayload.roles?.[0];
            if (defaultInviteRole) {
                setInviteRoleId((current) => current || defaultInviteRole.id);
            }
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadWorkspace();
    }, [loadWorkspace]);

    const permissionGroups = useMemo(() => byCategory(permissions), [permissions]);

    const stats = useMemo(() => {
        const total = users.length;
        const privileged = users.filter((user) => user.assignedRoles.some((role) => role.permissions.includes('roles:assign') || role.permissions.includes('users:admin'))).length;
        const pinUsers = users.filter((user) => user.username).length;
        return { total, privileged, pinUsers };
    }, [users]);

    const resetRoleEditor = useCallback(() => {
        setEditorRoleId(null);
        setEditorName('');
        setEditorDescription('');
        setEditorPermissionKeys([]);
    }, []);

    const inviteUser = useCallback(async () => {
        if (!inviteName.trim()) {
            setError('Name is required.');
            return;
        }
        if (!inviteRoleId) {
            setError('Choose a role.');
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
                roleId: inviteRoleId,
            }));
            const payload = (await res.json().catch(() => ({}))) as { temporaryPin?: string; message?: string };
            if (!res.ok) throw new Error(payload.message ?? 'Failed to create staff member.');

            setInviteName('');
            setInviteEmail('');
            setInviteUsername('');
            setInvitePin('');
            setInviteLoginType('username');
            setLastTemporaryPin(payload.temporaryPin ?? null);
            await loadWorkspace();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsInviting(false);
        }
    }, [inviteEmail, inviteLoginType, inviteName, invitePin, inviteRoleId, inviteUsername, loadWorkspace]);

    const updateUserRoles = useCallback(async (userId: string, roleIds: string[]) => {
        setIsSaving(userId);
        setError(null);
        try {
            const res = await fetchWithSession(`/users/${userId}/access`, jsonWriteInit('PUT', { roleIds }));
            const payload = (await res.json().catch(() => ({}))) as { assignedRoles?: AssignedRole[]; message?: string };
            if (!res.ok) throw new Error(payload.message ?? 'Failed to update user access.');
            setUsers((prev) => prev.map((user) => (
                user.id === userId ? { ...user, assignedRoles: payload.assignedRoles ?? user.assignedRoles } : user
            )));
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
            const payload = (await res.json().catch(() => ({}))) as { temporaryPin?: string; username?: string; message?: string };
            if (!res.ok) throw new Error(payload.message ?? 'Failed to reset PIN.');
            setUsers((prev) => prev.map((u) => (
                u.id === id ? { ...u, username: payload.username ?? u.username, pinEnabled: true, pinResetRequired: true } : u
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

    const saveRole = useCallback(async () => {
        if (!editorName.trim()) {
            setError('Role name is required.');
            return;
        }

        setIsSaving(editorRoleId ?? 'new-role');
        setError(null);
        try {
            const target = editorRoleId ? `/users/roles/${editorRoleId}` : '/users/roles';
            const method = editorRoleId ? 'PUT' : 'POST';
            const res = await fetchWithSession(target, jsonWriteInit(method, {
                name: editorName.trim(),
                description: editorDescription.trim() || undefined,
                permissionKeys: editorPermissionKeys,
            }));
            const payload = (await res.json().catch(() => ({}))) as { message?: string };
            if (!res.ok) throw new Error(payload.message ?? 'Failed to save role.');
            resetRoleEditor();
            await loadWorkspace();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsSaving(null);
        }
    }, [editorDescription, editorName, editorPermissionKeys, editorRoleId, loadWorkspace, resetRoleEditor]);

    const deleteRole = useCallback(async (roleId: string) => {
        setIsSaving(roleId);
        setError(null);
        try {
            const res = await fetchWithSession(`/users/roles/${roleId}`, jsonWriteInit('DELETE'));
            if (!res.ok && res.status !== 204) throw new Error('Failed to delete role.');
            if (editorRoleId === roleId) {
                resetRoleEditor();
            }
            await loadWorkspace();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsSaving(null);
        }
    }, [editorRoleId, loadWorkspace, resetRoleEditor]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1320 }}>
            <section className="surface-card" style={{ padding: '1rem', display: 'grid', gap: '0.9rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.8rem' }}>
                    <div>
                        <div className="workspace-kicker">People workspace</div>
                        <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>Staff & Access</h1>
                        <p className="workspace-subtitle">
                            {isLoading ? 'Loading team access...' : `${stats.total} people, ${roles.length} roles`}
                        </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void loadWorkspace()} disabled={isLoading}>
                        Refresh
                    </Button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.6rem' }}>
                    <div className="surface-muted" style={{ padding: '0.7rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Total staff</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)' }}>{stats.total}</div>
                    </div>
                    <div className="surface-muted" style={{ padding: '0.7rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Privileged users</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#0f8c52' }}>{stats.privileged}</div>
                    </div>
                    <div className="surface-muted" style={{ padding: '0.7rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>PIN accounts</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#4c5f85' }}>{stats.pinUsers}</div>
                    </div>
                </div>

                {canManage ? (
                    <div className="surface-muted" style={{ padding: '0.8rem', display: 'grid', gap: '0.6rem' }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>Invite team member</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr) minmax(0, 1fr) 140px 160px auto', gap: '0.5rem' }}>
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
                            <input
                                type="text"
                                value={invitePin}
                                onChange={(e) => setInvitePin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                                placeholder="PIN (optional)"
                                disabled={inviteLoginType !== 'username'}
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            />
                            <select
                                value={inviteRoleId}
                                onChange={(e) => setInviteRoleId(e.target.value)}
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            >
                                {roles.map((role) => (
                                    <option key={role.id} value={role.id}>{role.name}</option>
                                ))}
                            </select>
                            <Button size="sm" onClick={() => void inviteUser()} disabled={isInviting}>
                                {isInviting ? 'Creating...' : 'Invite'}
                            </Button>
                        </div>
                        {lastTemporaryPin ? (
                            <div style={{ fontSize: '0.78rem', color: '#7a2e14' }}>
                                Temporary PIN: <strong>{lastTemporaryPin}</strong> (share securely; require reset after first sign-in)
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </section>

            <section className="surface-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                    <thead>
                        <tr style={{ background: '#f8faff', borderBottom: '1px solid var(--border)' }}>
                            {['Member', 'Login', 'Assigned roles', ...(canManage ? ['Actions'] : [])].map((h) => (
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
                        {users.map((user, index) => (
                            <tr key={user.id} style={{ borderBottom: index < users.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                <td style={{ padding: '0.86rem 1rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                                        <div style={{ width: 34, height: 34, borderRadius: '50%', border: '1px solid #c9d6ef', background: '#edf3ff', display: 'grid', placeItems: 'center', fontSize: '0.66rem', fontWeight: 800, color: '#244aa8' }}>
                                            {initials(user.name)}
                                        </div>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)' }}>{user.name}</div>
                                            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{user.role}</div>
                                        </div>
                                    </div>
                                </td>
                                <td style={{ padding: '0.86rem 1rem', color: 'var(--text-secondary)', fontSize: '0.83rem' }}>
                                    {user.email ? (
                                        <span>{user.email}</span>
                                    ) : (
                                        <div style={{ display: 'grid', gap: '0.15rem' }}>
                                            <span style={{ fontFamily: 'var(--font-mono)' }}>{user.username || 'No username yet'}</span>
                                            <span style={{ fontSize: '0.72rem', color: user.pinResetRequired ? '#cb3653' : 'var(--text-muted)' }}>
                                                {user.pinEnabled ? (user.pinResetRequired ? 'PIN reset required' : 'PIN active') : 'PIN not set'}
                                            </span>
                                        </div>
                                    )}
                                </td>
                                <td style={{ padding: '0.86rem 1rem' }}>
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                            {user.assignedRoles.map((role) => (
                                                <span key={role.id} className="surface-muted" style={{ padding: '0.3rem 0.5rem', fontSize: '0.72rem', fontWeight: 700 }}>
                                                    {role.name}
                                                </span>
                                            ))}
                                        </div>
                                        {canManageRoles ? (
                                            <select
                                                multiple
                                                value={user.assignedRoles.map((role) => role.id)}
                                                onChange={(event) => {
                                                    const nextRoleIds = Array.from(event.currentTarget.selectedOptions).map((option) => option.value);
                                                    void updateUserRoles(user.id, nextRoleIds);
                                                }}
                                                disabled={isSaving === user.id}
                                                style={{ minHeight: 86, border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem', background: '#fff', color: 'var(--text-primary)' }}
                                            >
                                                {roles.map((role) => (
                                                    <option key={role.id} value={role.id}>{role.name}</option>
                                                ))}
                                            </select>
                                        ) : null}
                                    </div>
                                </td>
                                {canManage ? (
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                            {!user.email ? (
                                                <Button size="sm" variant="outline" onClick={() => void resetPin(user.id)} disabled={isSaving === user.id}>
                                                    {isSaving === user.id ? 'Resetting...' : 'Reset PIN'}
                                                </Button>
                                            ) : null}
                                            <Button size="sm" variant="outline" onClick={() => void deactivate(user.id)} disabled={isSaving === user.id}>
                                                {isSaving === user.id ? 'Removing...' : 'Remove'}
                                            </Button>
                                        </div>
                                    </td>
                                ) : null}
                            </tr>
                        ))}
                        {!isLoading && users.length === 0 ? (
                            <tr>
                                <td colSpan={canManage ? 4 : 3} style={{ padding: '1rem', fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                                    No staff members found.
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </section>

            {canManageRoles ? (
                <section className="surface-card" style={{ padding: '1rem', display: 'grid', gap: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
                        <div>
                            <div className="workspace-kicker">Access control</div>
                            <h2 className="workspace-title" style={{ fontSize: '1.2rem', marginBottom: 2 }}>Roles & Permissions</h2>
                            <p className="workspace-subtitle">Each role is a named bundle of explicit permissions.</p>
                        </div>
                        <Button variant="outline" size="sm" onClick={resetRoleEditor}>
                            New Role
                        </Button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1.4fr)', gap: '1rem' }}>
                        <div style={{ display: 'grid', gap: '0.6rem' }}>
                            {roles.map((role) => (
                                <div key={role.id} className="surface-muted" style={{ padding: '0.8rem', display: 'grid', gap: '0.45rem' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', alignItems: 'center' }}>
                                        <div>
                                            <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{role.name}</div>
                                            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                                                {role.userCount} assigned · {role.isSystem ? 'System role' : 'Custom role'}
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => {
                                                    setEditorRoleId(role.id);
                                                    setEditorName(role.name);
                                                    setEditorDescription(role.description ?? '');
                                                    setEditorPermissionKeys(role.permissions);
                                                }}
                                            >
                                                Edit
                                            </Button>
                                            {!role.isSystem ? (
                                                <Button size="sm" variant="outline" onClick={() => void deleteRole(role.id)} disabled={isSaving === role.id}>
                                                    Delete
                                                </Button>
                                            ) : null}
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                        {role.permissions.map((permissionKey) => (
                                            <span key={permissionKey} style={{ fontSize: '0.7rem', borderRadius: 999, padding: '0.18rem 0.45rem', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                                                {permissionKey}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="surface-muted" style={{ padding: '0.9rem', display: 'grid', gap: '0.8rem' }}>
                            <div>
                                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                                    {editorRoleId ? 'Edit role' : 'Create role'}
                                </div>
                                <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                                    Use client-facing names, keep the permission keys explicit.
                                </div>
                            </div>
                            <input
                                type="text"
                                value={editorName}
                                onChange={(e) => setEditorName(e.target.value)}
                                placeholder="Role name"
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.6rem', background: '#fff', color: 'var(--text-primary)' }}
                            />
                            <textarea
                                value={editorDescription}
                                onChange={(e) => setEditorDescription(e.target.value)}
                                placeholder="Short description"
                                rows={3}
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.6rem', background: '#fff', color: 'var(--text-primary)', resize: 'vertical' }}
                            />
                            <div style={{ display: 'grid', gap: '0.75rem', maxHeight: 460, overflowY: 'auto', paddingRight: '0.25rem' }}>
                                {Object.entries(permissionGroups).map(([category, entries]) => (
                                    <div key={category} style={{ display: 'grid', gap: '0.45rem' }}>
                                        <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                            {category.replace(/_/g, ' ')}
                                        </div>
                                        {entries.map((permission) => (
                                            <label key={permission.key} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={editorPermissionKeys.includes(permission.key)}
                                                    onChange={(event) => {
                                                        setEditorPermissionKeys((current) => (
                                                            event.target.checked
                                                                ? [...current, permission.key].sort()
                                                                : current.filter((item) => item !== permission.key)
                                                        ));
                                                    }}
                                                />
                                                <span>
                                                    <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{permission.label}</div>
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{permission.key}</div>
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                ))}
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <Button size="sm" onClick={() => void saveRole()} disabled={isSaving === (editorRoleId ?? 'new-role')}>
                                    {isSaving === (editorRoleId ?? 'new-role') ? 'Saving...' : (editorRoleId ? 'Save role' : 'Create role')}
                                </Button>
                                <Button size="sm" variant="outline" onClick={resetRoleEditor}>
                                    Clear
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>
            ) : null}

            {error ? (
                <div style={{ padding: '0.7rem 0.8rem', borderRadius: 10, border: '1px solid rgba(244,63,94,0.35)', color: '#fda4af', background: 'rgba(244,63,94,0.06)' }}>
                    {error}
                </div>
            ) : null}
        </div>
    );
}
