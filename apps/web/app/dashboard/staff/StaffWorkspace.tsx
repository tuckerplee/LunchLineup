'use client';

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { CalendarClock, RotateCcw, Trash2, UserMinus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchWithSession } from '@/lib/client-api';
import {
    continuationCursor,
    type UserDirectoryPageMetadata,
    userDirectoryPagePath,
} from '@/lib/user-directory-pagination';
import { buildStaffActionConfirmation, type StaffAction } from './staff-action-confirmation';
import { buildRoleDeletionConfirmation, canConfirmRoleDeletion } from './role-deletion-confirmation';
import { InvitationDeliveryStatus } from './InvitationDeliveryStatus';
import { StaffSchedulingProfileEditor } from './StaffSchedulingProfileEditor';
import { useInvitationDelivery } from './use-invitation-delivery';

type StaffWorkspaceProps = {
    currentUserPublicId: string;
    canInvite: boolean;
    canAdminister: boolean;
    canReadRoles: boolean;
    canAssignRoles: boolean;
    canManageRoles: boolean;
    canManageSchedulingProfiles: boolean;
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
    canDelegate: boolean;
};

type StaffUser = ApiUser & { status: 'active' | 'inactive' };

type UserDirectorySummary = {
    totalUsers: number;
    staffCount: number;
    managerCount: number;
    privilegedUsers: number;
    pinAccounts: number;
};

type UserDirectoryPage = {
    data?: ApiUser[];
    summary?: UserDirectorySummary;
    pagination?: UserDirectoryPageMetadata;
};

type PendingStaffAction = {
    action: StaffAction;
    user: StaffUser;
};

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

function keepFocusInsideDialog(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function byCategory(items: PermissionCatalogItem[]): Record<string, PermissionCatalogItem[]> {
    return items.reduce<Record<string, PermissionCatalogItem[]>>((acc, item) => {
        acc[item.category] ??= [];
        acc[item.category].push(item);
        return acc;
    }, {});
}

function toStaffUsers(users: ApiUser[]): StaffUser[] {
    return users.map((user) => ({
        ...user,
        assignedRoles: user.assignedRoles ?? [],
        status: 'active' as const,
    }));
}

function parseDirectorySummary(value: unknown): UserDirectorySummary {
    if (!value || typeof value !== 'object') throw new Error('Unable to load staff totals.');
    const payload = value as Record<string, unknown>;
    const fields = ['totalUsers', 'staffCount', 'managerCount', 'privilegedUsers', 'pinAccounts'] as const;
    for (const field of fields) {
        if (!Number.isSafeInteger(payload[field]) || Number(payload[field]) < 0) {
            throw new Error('Unable to load staff totals.');
        }
    }
    return payload as UserDirectorySummary;
}

export function StaffWorkspace({ currentUserPublicId, canInvite, canAdminister, canReadRoles, canAssignRoles, canManageRoles, canManageSchedulingProfiles }: StaffWorkspaceProps) {
    const [users, setUsers] = useState<StaffUser[]>([]);
    const [directorySummary, setDirectorySummary] = useState<UserDirectorySummary | null>(null);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [hasMoreUsers, setHasMoreUsers] = useState(false);
    const [isChangingUserPage, setIsChangingUserPage] = useState(false);
    const [userPageIndex, setUserPageIndex] = useState(0);
    const [userPageCursors, setUserPageCursors] = useState<Array<string | null>>([null]);
    const [roles, setRoles] = useState<RoleCatalogItem[]>([]);
    const [permissions, setPermissions] = useState<PermissionCatalogItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pendingAction, setPendingAction] = useState<PendingStaffAction | null>(null);
    const [pendingRoleDeletion, setPendingRoleDeletion] = useState<RoleCatalogItem | null>(null);
    const [roleDeletionName, setRoleDeletionName] = useState('');
    const [schedulingProfileUser, setSchedulingProfileUser] = useState<StaffUser | null>(null);
    const canOpenStaffDrawer = canManageSchedulingProfiles || canAdminister || (canAssignRoles && canReadRoles);

    const [inviteName, setInviteName] = useState('');
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteUsername, setInviteUsername] = useState('');
    const [invitePin, setInvitePin] = useState('');
    const [inviteRoleId, setInviteRoleId] = useState('');
    const [inviteLoginType, setInviteLoginType] = useState<'email' | 'username'>('username');
    const [isInviting, setIsInviting] = useState(false);
    const [lastTemporaryPin, setLastTemporaryPin] = useState<string | null>(null);
    const [lastTemporaryPinUserId, setLastTemporaryPinUserId] = useState<string | null>(null);
    const [lastInvitationUserId, setLastInvitationUserId] = useState<string | null>(null);

    const [editorRoleId, setEditorRoleId] = useState<string | null>(null);
    const [editorName, setEditorName] = useState('');
    const [editorDescription, setEditorDescription] = useState('');
    const [editorPermissionKeys, setEditorPermissionKeys] = useState<string[]>([]);
    const {
        states: invitationDeliveries,
        retryingUserIds: retryingInvitationIds,
        recordResponse: recordInvitationResponse,
        refreshStatus: refreshInvitationStatus,
        refreshStatuses: refreshInvitationStatuses,
        retry: retryInvitation,
    } = useInvitationDelivery({ canAdminister, users });

    useEffect(() => {
        if (!schedulingProfileUser) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, [schedulingProfileUser]);

    const loadWorkspace = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const [usersRes, accessRes] = await Promise.all([
                fetchWithSession(userDirectoryPagePath()),
                canReadRoles ? fetchWithSession('/users/access/catalog') : Promise.resolve(null),
            ]);

            if (!usersRes.ok) throw new Error('Unable to load staff.');
            if (accessRes && !accessRes.ok) throw new Error('Unable to load roles and permissions.');

            const usersPayload = (await usersRes.json()) as UserDirectoryPage;
            const summaryPayload = parseDirectorySummary(usersPayload.summary);
            const accessPayload = accessRes
                ? (await accessRes.json()) as { roles?: RoleCatalogItem[]; permissions?: PermissionCatalogItem[]; defaultInviteRoleId?: string | null }
                : { roles: [], permissions: [] };
            const cursor = continuationCursor(usersPayload.pagination);

            const staffUsers = toStaffUsers(usersPayload.data ?? []);
            setUsers(staffUsers);
            setDirectorySummary(summaryPayload);
            setNextCursor(cursor);
            setHasMoreUsers(Boolean(cursor));
            setUserPageIndex(0);
            setUserPageCursors([null]);
            setRoles(accessPayload.roles ?? []);
            setPermissions(accessPayload.permissions ?? []);

            const delegableRoles = (accessPayload.roles ?? []).filter((role) => role.canDelegate);
            const defaultInviteRole = delegableRoles.find((role) => role.id === accessPayload.defaultInviteRoleId)
                ?? delegableRoles.find((role) => role.legacyRole === 'STAFF')
                ?? delegableRoles[0];
            if (defaultInviteRole) {
                setInviteRoleId((current) => current || defaultInviteRole.id);
            }
            void refreshInvitationStatuses(staffUsers);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsLoading(false);
        }
    }, [canReadRoles, refreshInvitationStatuses]);

    useEffect(() => {
        void loadWorkspace();
    }, [loadWorkspace]);

    const loadDirectoryPage = useCallback(async (cursor: string | null, targetPageIndex: number) => {
        setIsChangingUserPage(true);
        setError(null);
        try {
            const response = await fetchWithSession(userDirectoryPagePath(cursor));
            if (!response.ok) throw new Error('Unable to load staff page.');
            const payload = (await response.json()) as UserDirectoryPage;
            const followingCursor = continuationCursor(payload.pagination);

            setUsers(toStaffUsers(payload.data ?? []));
            setNextCursor(followingCursor);
            setHasMoreUsers(Boolean(followingCursor));
            setUserPageIndex(targetPageIndex);
            setUserPageCursors((current) => {
                const next = current.slice(0, targetPageIndex);
                next[targetPageIndex] = cursor;
                return next;
            });
            void refreshInvitationStatuses(toStaffUsers(payload.data ?? []));
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsChangingUserPage(false);
        }
    }, [refreshInvitationStatuses]);
    const permissionGroups = useMemo(() => byCategory(permissions), [permissions]);
    const delegableRoles = useMemo(() => roles.filter((role) => role.canDelegate), [roles]);

    const stats = directorySummary ?? {
        totalUsers: 0,
        staffCount: 0,
        managerCount: 0,
        privilegedUsers: 0,
        pinAccounts: 0,
    };

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
        if (canReadRoles && !inviteRoleId) {
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
        setLastTemporaryPin(null);
        setLastTemporaryPinUserId(null);
        setLastInvitationUserId(null);
        try {
            const res = await fetchWithSession('/users/invite', jsonWriteInit('POST', {
                name: inviteName.trim(),
                email: inviteLoginType === 'email' ? inviteEmail.trim() || undefined : undefined,
                username: inviteLoginType === 'username' ? inviteUsername.trim() || undefined : undefined,
                pin: inviteLoginType === 'username' ? invitePin.trim() || undefined : undefined,
                ...(inviteRoleId ? { roleId: inviteRoleId } : {}),
            }));
            const payload = (await res.json().catch(() => ({}))) as {
                id?: unknown;
                temporaryPin?: string;
                message?: string;
                invitationDelivery?: unknown;
            };
            if (!res.ok) throw new Error(payload.message ?? 'Failed to create staff member.');

            const invitedUserId = typeof payload.id === 'string' && payload.id ? payload.id : null;
            if (invitedUserId) {
                setLastInvitationUserId(invitedUserId);
                recordInvitationResponse(invitedUserId, payload);
            }

            setInviteName('');
            setInviteEmail('');
            setInviteUsername('');
            setInvitePin('');
            setInviteLoginType('username');
            setLastTemporaryPin(payload.temporaryPin ?? null);
            setLastTemporaryPinUserId(invitedUserId);
            await loadWorkspace();
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsInviting(false);
        }
    }, [canReadRoles, inviteEmail, inviteLoginType, inviteName, invitePin, inviteRoleId, inviteUsername, loadWorkspace, recordInvitationResponse]);

    const updateUserRoles = useCallback(async (userId: string, roleIds: string[]) => {
        setIsSaving(userId);
        setError(null);
        try {
            const res = await fetchWithSession(`/users/${userId}/access`, jsonWriteInit('PUT', { roleIds }));
            const payload = (await res.json().catch(() => ({}))) as { assignedRoles?: AssignedRole[]; message?: string };
            if (!res.ok) throw new Error(payload.message ?? 'Failed to update user access.');
            const assignedRoles = payload.assignedRoles;
            setUsers((prev) => prev.map((user) => (
                user.id === userId ? { ...user, assignedRoles: assignedRoles ?? user.assignedRoles } : user
            )));
            setSchedulingProfileUser((current) => current?.id === userId
                ? { ...current, assignedRoles: assignedRoles ?? current.assignedRoles }
                : current);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsSaving(null);
        }
    }, []);

    const resetPin = useCallback(async (id: string) => {
        setIsSaving(id);
        setError(null);
        setLastTemporaryPin(null);
        setLastTemporaryPinUserId(null);
        try {
            const res = await fetchWithSession(`/users/${id}/pin/reset`, jsonWriteInit('POST'));
            const payload = (await res.json().catch(() => ({}))) as { temporaryPin?: string; username?: string; message?: string };
            if (!res.ok) throw new Error(payload.message ?? 'Failed to reset PIN.');
            setUsers((prev) => prev.map((u) => (
                u.id === id ? { ...u, username: payload.username ?? u.username, pinEnabled: true, pinResetRequired: true } : u
            )));
            setSchedulingProfileUser((current) => current?.id === id
                ? { ...current, username: payload.username ?? current.username, pinEnabled: true, pinResetRequired: true }
                : current);
            setLastTemporaryPin(payload.temporaryPin ?? null);
            setLastTemporaryPinUserId(id);
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
            setSchedulingProfileUser((current) => current?.id === id ? null : current);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setIsSaving(null);
        }
    }, []);

    const confirmPendingAction = useCallback(() => {
        if (!pendingAction) return;

        const { action, user } = pendingAction;
        setPendingAction(null);
        if (action === 'reset-pin') {
            void resetPin(user.id);
            return;
        }
        void deactivate(user.id);
    }, [deactivate, pendingAction, resetPin]);

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
            const payload = (await res.json().catch(() => ({}))) as { message?: string };
            if (!res.ok && res.status !== 204) throw new Error(payload.message ?? 'Failed to delete role.');
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
        <div className="staff-workspace" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1320 }}>
            <section className="surface-card" style={{ padding: '1rem', display: 'grid', gap: '0.9rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.8rem' }}>
                    <div>
                        <div className="workspace-kicker">People workspace</div>
                        <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>Staff & Access</h1>
                        <p className="workspace-subtitle">
                            {isLoading ? 'Loading team access...' : `${stats.totalUsers} people, ${roles.length} roles`}
                        </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void loadWorkspace()} disabled={isLoading}>
                        Refresh
                    </Button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.6rem' }}>
                    <div className="surface-muted" style={{ padding: '0.7rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Total staff</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)' }}>{stats.totalUsers}</div>
                    </div>
                    <div className="surface-muted" style={{ padding: '0.7rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>Privileged users</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#0f8c52' }}>{stats.privilegedUsers}</div>
                    </div>
                    <div className="surface-muted" style={{ padding: '0.7rem' }}>
                        <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>PIN accounts</div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#4c5f85' }}>{stats.pinAccounts}</div>
                    </div>
                </div>

                {canInvite ? (
                    <div className="surface-muted" style={{ padding: '0.8rem', display: 'grid', gap: '0.6rem' }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)' }}>Invite team member</div>
                        <form
                            className="staff-invite-form"
                            aria-label="Invite team member"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void inviteUser();
                            }}
                            style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr) minmax(0, 1fr) 140px 160px auto', gap: '0.5rem' }}
                        >
                            <select
                                aria-label="Login method"
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
                                aria-label="Full name"
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            />
                            {inviteLoginType === 'email' ? (
                                <input
                                    type="email"
                                    value={inviteEmail}
                                    onChange={(e) => setInviteEmail(e.target.value)}
                                    aria-label="Work email"
                                    style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                                />
                            ) : (
                                <input
                                    type="text"
                                    value={inviteUsername}
                                    onChange={(e) => setInviteUsername(e.target.value)}
                                    aria-label="Username"
                                    style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                                />
                            )}
                            <input
                                type="text"
                                value={invitePin}
                                onChange={(e) => setInvitePin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                                aria-label="Temporary PIN"
                                disabled={inviteLoginType !== 'username'}
                                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                            />
                            {canReadRoles ? (
                                <select
                                    aria-label="Role"
                                    value={inviteRoleId}
                                    onChange={(e) => setInviteRoleId(e.target.value)}
                                    style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.42rem 0.5rem', background: '#fff', color: 'var(--text-primary)' }}
                                >
                                    {delegableRoles.map((role) => (
                                        <option key={role.id} value={role.id}>{role.name}</option>
                                    ))}
                                </select>
                            ) : null}
                            <Button type="submit" size="sm" disabled={isInviting || isLoading}>
                                {isInviting ? 'Creating...' : 'Invite'}
                            </Button>
                        </form>
                        {lastTemporaryPin ? (
                            <div style={{ fontSize: '0.78rem', color: '#7a2e14' }} role="status">
                                Temporary PIN: <strong>{lastTemporaryPin}</strong> (share securely; require reset after first sign-in)
                            </div>
                        ) : null}
                        {lastInvitationUserId && invitationDeliveries[lastInvitationUserId] ? (
                            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.65rem', display: 'grid', gap: '0.35rem' }}>
                                <div style={{ fontSize: '0.76rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                                    Invitation delivery
                                </div>
                                <InvitationDeliveryStatus
                                    state={invitationDeliveries[lastInvitationUserId]}
                                    isRetrying={retryingInvitationIds.has(lastInvitationUserId)}
                                    onRefresh={canAdminister ? () => void refreshInvitationStatus(lastInvitationUserId) : undefined}
                                    onRetry={canAdminister ? () => void retryInvitation(lastInvitationUserId) : undefined}
                                />
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </section>

            <section
                className="surface-card staff-table-scroll"
                aria-label="Staff directory table"
                tabIndex={0}
                style={{ overflowX: 'auto' }}
            >
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                    <thead>
                        <tr style={{ background: '#f8faff', borderBottom: '1px solid var(--border)' }}>
                            {[
                                'Member',
                                'Login',
                                ...(canAdminister ? ['Invitation'] : []),
                                'Assigned roles',
                                ...(canAdminister || canManageSchedulingProfiles ? ['Actions'] : []),
                            ].map((h) => (
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
                            <tr
                                key={user.id}
                                className={canOpenStaffDrawer ? 'staff-directory-row staff-directory-row--interactive' : 'staff-directory-row'}
                                tabIndex={canOpenStaffDrawer ? 0 : undefined}
                                aria-label={canOpenStaffDrawer ? `Manage ${user.name}` : undefined}
                                title={canOpenStaffDrawer ? `Manage ${user.name}` : undefined}
                                onClick={(event) => {
                                    if (!canOpenStaffDrawer) return;
                                    const target = event.target as HTMLElement;
                                    if (target.closest('button, a, input, select, textarea, label')) return;
                                    setSchedulingProfileUser(user);
                                }}
                                onKeyDown={(event) => {
                                    if (!canOpenStaffDrawer || event.target !== event.currentTarget) return;
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        setSchedulingProfileUser(user);
                                    }
                                }}
                                style={{ borderBottom: index < users.length - 1 ? '1px solid var(--border)' : 'none' }}
                            >
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
                                {canAdminister ? (
                                    <td style={{ padding: '0.86rem 1rem', verticalAlign: 'top' }}>
                                        <InvitationDeliveryStatus
                                            state={invitationDeliveries[user.id] ?? {
                                                delivery: null,
                                                isLoading: true,
                                                error: null,
                                            }}
                                            isRetrying={retryingInvitationIds.has(user.id)}
                                            onRefresh={() => void refreshInvitationStatus(user.id)}
                                            onRetry={() => void retryInvitation(user.id)}
                                        />
                                    </td>
                                ) : null}
                                <td style={{ padding: '0.86rem 1rem' }}>
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                            {user.assignedRoles.map((role) => (
                                                <span key={role.id} className="surface-muted" style={{ padding: '0.3rem 0.5rem', fontSize: '0.72rem', fontWeight: 700 }}>
                                                    {role.name}
                                                </span>
                                            ))}
                                        </div>
                                        {canAssignRoles && canReadRoles && user.id !== currentUserPublicId ? (
                                            <select
                                                multiple
                                                aria-label={`Assigned roles for ${user.name}`}
                                                value={user.assignedRoles.map((role) => role.id)}
                                                onChange={(event) => {
                                                    const nextRoleIds = Array.from(event.currentTarget.selectedOptions).map((option) => option.value);
                                                    void updateUserRoles(user.id, nextRoleIds);
                                                }}
                                                disabled={isSaving === user.id}
                                                style={{ minHeight: 86, border: '1px solid var(--border)', borderRadius: 8, padding: '0.45rem', background: '#fff', color: 'var(--text-primary)' }}
                                            >
                                                {delegableRoles.map((role) => (
                                                    <option key={role.id} value={role.id}>{role.name}</option>
                                                ))}
                                            </select>
                                        ) : null}
                                    </div>
                                </td>
                                {canAdminister || canManageSchedulingProfiles ? (
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                                            {canManageSchedulingProfiles ? (
                                                <Button size="sm" variant="outline" onClick={() => setSchedulingProfileUser(user)}>
                                                    <CalendarClock aria-hidden="true" size={14} />
                                                    Edit schedule profile
                                                </Button>
                                            ) : null}
                                            {canAdminister && user.id !== currentUserPublicId && !user.email ? (
                                                <Button size="sm" variant="outline" onClick={() => setPendingAction({ action: 'reset-pin', user })} disabled={isSaving === user.id}>
                                                    <RotateCcw aria-hidden="true" size={14} />
                                                    {isSaving === user.id ? 'Resetting...' : 'Reset PIN'}
                                                </Button>
                                            ) : null}
                                            {canAdminister && user.id !== currentUserPublicId ? (
                                                <Button size="sm" variant="outline" onClick={() => setPendingAction({ action: 'remove', user })} disabled={isSaving === user.id}>
                                                    <UserMinus aria-hidden="true" size={14} />
                                                    {isSaving === user.id ? 'Removing...' : 'Remove'}
                                                </Button>
                                            ) : null}
                                        </div>
                                    </td>
                                ) : null}
                            </tr>
                        ))}
                        {!isLoading && users.length === 0 ? (
                            <tr>
                                <td colSpan={3 + (canAdminister ? 1 : 0) + (canAdminister || canManageSchedulingProfiles ? 1 : 0)} style={{ padding: '1rem', fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                                    No staff members found.
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
                <div style={{ borderTop: '1px solid var(--border)', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                        Page {userPageIndex + 1} · {users.length} shown · {stats.totalUsers} total
                    </span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void loadDirectoryPage(userPageCursors[userPageIndex - 1] ?? null, userPageIndex - 1)}
                            disabled={userPageIndex === 0 || isChangingUserPage}
                        >
                            Previous
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void loadDirectoryPage(nextCursor, userPageIndex + 1)}
                            disabled={!hasMoreUsers || !nextCursor || isChangingUserPage}
                        >
                            {isChangingUserPage ? 'Loading...' : 'Next'}
                        </Button>
                    </div>
                </div>            </section>

            {schedulingProfileUser ? (
                <div className="staff-profile-drawer-backdrop" role="presentation" onMouseDown={() => setSchedulingProfileUser(null)}>
                    <aside
                        className="staff-profile-drawer"
                        role="dialog"
                        aria-modal="true"
                        aria-label={`Manage ${schedulingProfileUser.name}`}
                        onMouseDown={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') setSchedulingProfileUser(null);
                            keepFocusInsideDialog(event);
                        }}
                    >
                        <header className="staff-profile-drawer__header">
                            <div>
                                <div className="workspace-kicker">Staff member</div>
                                <h2>{schedulingProfileUser.name}</h2>
                                <span>{schedulingProfileUser.role}</span>
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => setSchedulingProfileUser(null)}
                                title="Close staff management"
                                aria-label="Close staff management"
                                autoFocus
                            >
                                <X aria-hidden="true" size={18} />
                            </Button>
                        </header>

                        <section className="staff-profile-drawer__account" aria-label={`Account and access for ${schedulingProfileUser.name}`}>
                            <div className="staff-profile-drawer__section-heading">
                                <h3>Account & access</h3>
                                <span>{schedulingProfileUser.email || schedulingProfileUser.username || 'No login configured'}</span>
                            </div>

                            {canReadRoles ? (
                                <div className="staff-profile-drawer__roles">
                                    <strong>Assigned roles</strong>
                                    <div className="staff-profile-drawer__role-badges">
                                        {schedulingProfileUser.assignedRoles.map((role) => (
                                            <span key={role.id}>{role.name}</span>
                                        ))}
                                        {schedulingProfileUser.assignedRoles.length === 0 ? <span>No roles assigned</span> : null}
                                    </div>
                                    {canAssignRoles && schedulingProfileUser.id !== currentUserPublicId ? (
                                        <>
                                            <strong>Change roles</strong>
                                            {delegableRoles.length > 0 ? (
                                                <div role="group" aria-label={`Manage roles for ${schedulingProfileUser.name}`}>
                                                    {delegableRoles.map((role) => {
                                                        const checked = schedulingProfileUser.assignedRoles.some((assignedRole) => assignedRole.id === role.id);
                                                        return (
                                                            <label key={role.id}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={checked}
                                                                    disabled={isSaving === schedulingProfileUser.id}
                                                                    onChange={(event) => {
                                                                        const currentRoleIds = schedulingProfileUser.assignedRoles.map((assignedRole) => assignedRole.id);
                                                                        const nextRoleIds = event.target.checked
                                                                            ? Array.from(new Set([...currentRoleIds, role.id]))
                                                                            : currentRoleIds.filter((roleId) => roleId !== role.id);
                                                                        void updateUserRoles(schedulingProfileUser.id, nextRoleIds);
                                                                    }}
                                                                />
                                                                <span>{role.name}</span>
                                                            </label>
                                                        );
                                                    })}
                                                </div>
                                            ) : <span className="staff-profile-drawer__empty">No delegable roles available.</span>}
                                        </>
                                    ) : null}
                                </div>
                            ) : null}

                            {lastTemporaryPin && lastTemporaryPinUserId === schedulingProfileUser.id ? (
                                <div className="staff-profile-drawer__temporary-pin" role="status">
                                    Temporary PIN: <strong>{lastTemporaryPin}</strong>
                                </div>
                            ) : null}

                            {canAdminister && schedulingProfileUser.id !== currentUserPublicId ? (
                                <div className="staff-profile-drawer__account-actions">
                                    {!schedulingProfileUser.email ? (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => setPendingAction({ action: 'reset-pin', user: schedulingProfileUser })}
                                            disabled={isSaving === schedulingProfileUser.id}
                                        >
                                            <RotateCcw aria-hidden="true" size={14} />
                                            Reset PIN
                                        </Button>
                                    ) : null}
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setPendingAction({ action: 'remove', user: schedulingProfileUser })}
                                        disabled={isSaving === schedulingProfileUser.id}
                                    >
                                        <UserMinus aria-hidden="true" size={14} />
                                        Remove
                                    </Button>
                                </div>
                            ) : null}
                        </section>

                        {canManageSchedulingProfiles ? (
                            <section className="staff-profile-drawer__scheduling" aria-label={`Scheduling settings for ${schedulingProfileUser.name}`}>
                                <div className="staff-profile-drawer__section-heading">
                                    <h3>Scheduling profile</h3>
                                    <span>Skills and weekly availability</span>
                                </div>
                                <StaffSchedulingProfileEditor
                                    key={schedulingProfileUser.id}
                                    user={schedulingProfileUser}
                                    onClose={() => setSchedulingProfileUser(null)}
                                    showHeader={false}
                                />
                            </section>
                        ) : null}
                    </aside>
                </div>
            ) : null}

            {canManageRoles && canReadRoles ? (
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

                    <div className="staff-role-layout">
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
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => {
                                                        setPendingRoleDeletion(role);
                                                        setRoleDeletionName('');
                                                    }}
                                                    disabled={isSaving === role.id}
                                                >
                                                    <Trash2 aria-hidden="true" size={14} />
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

            {pendingAction ? (() => {
                const confirmation = buildStaffActionConfirmation(pendingAction.action, pendingAction.user);
                return (
                    <div className="staff-confirmation-backdrop" role="presentation">
                        <div
                            className="staff-confirmation-dialog"
                            role="alertdialog"
                            aria-modal="true"
                            aria-labelledby="staff-confirmation-title"
                            aria-describedby="staff-confirmation-description"
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') setPendingAction(null);
                            }}
                        >
                            <div>
                                <h2 id="staff-confirmation-title">{confirmation.title}</h2>
                                <p id="staff-confirmation-description">{confirmation.description}</p>
                            </div>
                            <div className="staff-confirmation-actions">
                                <Button variant="outline" onClick={() => setPendingAction(null)} autoFocus>
                                    Cancel
                                </Button>
                                <Button
                                    variant={pendingAction.action === 'remove' ? 'destructive' : 'default'}
                                    onClick={confirmPendingAction}
                                >
                                    {pendingAction.action === 'reset-pin' ? (
                                        <RotateCcw aria-hidden="true" size={16} />
                                    ) : (
                                        <UserMinus aria-hidden="true" size={16} />
                                    )}
                                    {confirmation.confirmLabel}
                                </Button>
                            </div>
                        </div>
                    </div>
                );
            })() : null}

            {pendingRoleDeletion ? (() => {
                const confirmation = buildRoleDeletionConfirmation(pendingRoleDeletion);
                const canDelete = canConfirmRoleDeletion(confirmation, roleDeletionName);
                return (
                    <div className="staff-confirmation-backdrop" role="presentation">
                        <div
                            className="staff-confirmation-dialog"
                            role="alertdialog"
                            aria-modal="true"
                            aria-labelledby="role-deletion-title"
                            aria-describedby="role-deletion-description"
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') setPendingRoleDeletion(null);
                            }}
                        >
                            <div>
                                <h2 id="role-deletion-title">{confirmation.title}</h2>
                                <p id="role-deletion-description">{confirmation.description}</p>
                            </div>
                            <label style={{ display: 'grid', gap: '0.35rem', fontSize: '0.8rem', fontWeight: 700 }}>
                                Role name
                                <input
                                    type="text"
                                    value={roleDeletionName}
                                    onChange={(event) => setRoleDeletionName(event.target.value)}
                                    placeholder={confirmation.expectedName}
                                    disabled={confirmation.blocked}
                                    autoFocus={!confirmation.blocked}
                                    style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.6rem', background: '#fff', color: 'var(--text-primary)' }}
                                />
                            </label>
                            <div className="staff-confirmation-actions">
                                <Button variant="outline" onClick={() => setPendingRoleDeletion(null)} autoFocus={confirmation.blocked}>
                                    Cancel
                                </Button>
                                <Button
                                    variant="destructive"
                                    disabled={!canDelete || isSaving === pendingRoleDeletion.id}
                                    onClick={() => {
                                        const roleId = pendingRoleDeletion.id;
                                        setPendingRoleDeletion(null);
                                        setRoleDeletionName('');
                                        void deleteRole(roleId);
                                    }}
                                >
                                    <Trash2 aria-hidden="true" size={16} />
                                    {confirmation.confirmLabel}
                                </Button>
                            </div>
                        </div>
                    </div>
                );
            })() : null}

            {error ? (
                <div style={{ padding: '0.7rem 0.8rem', borderRadius: 10, border: '1px solid rgba(244,63,94,0.35)', color: '#fda4af', background: 'rgba(244,63,94,0.06)' }} role="alert">
                    {error}
                </div>
            ) : null}
        </div>
    );
}
