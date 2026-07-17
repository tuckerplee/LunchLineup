'use client';

import Link from 'next/link';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';
import {
    EMPTY_ADMIN_LIST_PAGINATION,
    buildAdminListPath,
    mergeAdminListPage,
    parseAdminListPagination,
} from '../admin-list-pagination';
import {
    buildBulkTenantDeleteConfirmation,
    buildTenantLifecycleConfirmation,
    lifecycleConfirmationMatches,
    type TenantLifecycleAction,
} from './tenant-lifecycle-confirmation';
import {
    buildTenantCreatePayload,
    buildTenantEditPayload,
    TENANT_CREATE_CREDIT_GUIDANCE,
    TENANT_CREDIT_EDIT_GUIDANCE,
    TENANT_PLAN_EDIT_GUIDANCE,
    TENANT_STATUS_EDIT_GUIDANCE,
} from './tenant-edit-contract';
import { startingStatusForPlan, tenantProvisioningDescription } from './tenant-provisioning-contract';

type PlanTier = 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';
type TenantStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED' | 'PURGED';

type TenantRecord = {
    id: string;
    name: string;
    slug: string;
    planTier: PlanTier;
    status: TenantStatus;
    usageCredits: number;
    createdAt: string;
    trialEndsAt: string | null;
    gracePeriodEndsAt: string | null;
    deletedAt: string | null;
    usersCount: number;
    locationsCount: number;
};

type TenantListResponse = {
    data?: TenantRecord[];
    pagination?: unknown;
};

type TenantFormState = {
    name: string;
    slug: string;
};

type TenantCreateFormState = TenantFormState & {
    planTier: PlanTier;
    status: TenantStatus;
    ownerName: string;
    ownerEmail: string;
};

const OWNER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PLAN_OPTIONS: Array<{ value: PlanTier; label: string }> = [
    { value: 'FREE', label: 'FREE' },
    { value: 'STARTER', label: 'STARTER' },
    { value: 'GROWTH', label: 'GROWTH' },
    { value: 'ENTERPRISE', label: 'ENTERPRISE' },
];

const PLAN_COLORS: Record<string, { color: string; bg: string; border: string }> = {
    FREE: { color: '#4c5f85', bg: '#eef2f9', border: '#d3ddeb' },
    STARTER: { color: '#1d4ed8', bg: '#edf3ff', border: '#c9d9ff' },
    GROWTH: { color: '#166534', bg: '#e9fbf1', border: '#bdeed4' },
    ENTERPRISE: { color: '#7c4a03', bg: '#fff4e2', border: '#ffe1a6' },
};

const STATUS_COLORS: Record<string, { color: string; bg: string; border: string }> = {
    TRIAL: { color: '#7c4a03', bg: '#fff4e2', border: '#ffe1a6' },
    ACTIVE: { color: '#166534', bg: '#e9fbf1', border: '#bdeed4' },
    SUSPENDED: { color: '#b4233f', bg: '#ffeef2', border: '#ffd0da' },
    PAST_DUE: { color: '#b4233f', bg: '#ffeef2', border: '#ffd0da' },
    CANCELLED: { color: '#475569', bg: '#eef2f9', border: '#d3ddeb' },
    PURGED: { color: '#475569', bg: '#eef2f9', border: '#d3ddeb' },
};

const SUMMARY_COLORS = [
    { color: '#1d4ed8', bg: '#edf3ff', border: '#c9d9ff', title: 'Total tenants' },
    { color: '#166534', bg: '#e9fbf1', border: '#bdeed4', title: 'Active tenants' },
    { color: '#b4233f', bg: '#ffeef2', border: '#ffd0da', title: 'Suspended or archived' },
    { color: '#7c4a03', bg: '#fff4e2', border: '#ffe1a6', title: 'Usage credits' },
];

function formatDate(value: string | null | undefined) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatDateTime(value: string | null | undefined) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function normalizeForm(tenant?: TenantRecord | null): TenantFormState {
    return {
        name: tenant?.name ?? '',
        slug: tenant?.slug ?? '',
    };
}

function badgeStyle(color: string, bg: string, border: string) {
    return {
        fontSize: '0.62rem',
        textTransform: 'uppercase' as const,
        letterSpacing: '0.06em',
        color,
        background: bg,
        borderColor: border,
    };
}

function actionButtonStyle(kind: 'neutral' | 'positive' | 'warn' | 'danger') {
    if (kind === 'positive') {
        return { background: '#e9fbf1', color: '#166534', borderColor: '#bdeed4' };
    }
    if (kind === 'warn') {
        return { background: '#fff4e2', color: '#7c4a03', borderColor: '#ffe1a6' };
    }
    if (kind === 'danger') {
        return { background: '#ffeef2', color: '#b4233f', borderColor: '#ffd0da' };
    }
    return { background: '#edf3ff', color: '#1d4ed8', borderColor: '#c9d9ff' };
}

function getCsrfHeaders(): Record<string, string> {
    if (typeof document === 'undefined') return {};
    const pair = document.cookie
        .split('; ')
        .find((entry) => entry.startsWith('csrf_token='));
    const csrfToken = pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
    return csrfToken ? { 'x-csrf-token': csrfToken } : {};
}

function normalizeCreateForm(): TenantCreateFormState {
    return {
        ...normalizeForm(null),
        planTier: 'FREE',
        status: startingStatusForPlan('FREE'),
        ownerName: '',
        ownerEmail: '',
    };
}

function confirmLifecycleAction(action: TenantLifecycleAction, tenant: TenantRecord): boolean {
    if (typeof window === 'undefined') return true;
    const confirmation = buildTenantLifecycleConfirmation(action, tenant);
    const entered = window.prompt(confirmation.prompt);
    return lifecycleConfirmationMatches(entered, confirmation.expectedInput);
}

function confirmBulkArchivedTenantDelete(count: number): boolean {
    if (typeof window === 'undefined') return true;
    const confirmation = buildBulkTenantDeleteConfirmation(count);
    const entered = window.prompt(confirmation.prompt);
    return lifecycleConfirmationMatches(entered, confirmation.expectedInput);
}

function jsonWriteInit(method: 'POST' | 'PUT' | 'DELETE', payload?: unknown): RequestInit {
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

async function writeJson<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', payload?: unknown): Promise<T> {
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

export function TenantsClient() {
    const [tenants, setTenants] = useState<TenantRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [appliedQuery, setAppliedQuery] = useState('');
    const [pagination, setPagination] = useState(EMPTY_ADMIN_LIST_PAGINATION);
    const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
    const [createForm, setCreateForm] = useState<TenantCreateFormState>(normalizeCreateForm);
    const [editForm, setEditForm] = useState<TenantFormState>(() => normalizeForm(null));

    const selectedTenant = useMemo(
        () => tenants.find((tenant) => tenant.id === selectedTenantId) ?? null,
        [selectedTenantId, tenants],
    );

    const loadTenants = useCallback(
        async (options: {
            preferredSelectedId?: string;
            cursor?: string | null;
            append?: boolean;
            search?: string;
        } = {}) => {
            const operation = options.append ? 'load-more' : 'load';
            setError(null);
            setSaving(operation);
            if (!options.append) setLoading(true);
            try {
                const path = buildAdminListPath('/admin/tenants', {
                    limit: 50,
                    cursor: options.cursor,
                    q: options.search,
                });
                const payload = await fetchJsonWithSession<TenantListResponse>(path);
                const nextTenants = Array.isArray(payload.data) ? payload.data : [];
                setPagination(parseAdminListPagination(payload.pagination));
                if (options.append) {
                    setTenants((current) => mergeAdminListPage(current, nextTenants, true));
                } else {
                    setTenants(nextTenants);
                    setSelectedTenantId((current) => {
                        if (options.preferredSelectedId && nextTenants.some((tenant) => tenant.id === options.preferredSelectedId)) {
                            return options.preferredSelectedId;
                        }
                        if (current && nextTenants.some((tenant) => tenant.id === current)) {
                            return current;
                        }
                        return nextTenants[0]?.id ?? null;
                    });
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load tenants');
            } finally {
                if (!options.append) setLoading(false);
                setSaving((current) => (current === operation ? null : current));
            }
        },
        [],
    );

    useEffect(() => {
        void loadTenants({ search: appliedQuery });
    }, [appliedQuery, loadTenants]);

    useEffect(() => {
        setEditForm(normalizeForm(selectedTenant));
    }, [selectedTenant]);


    const summary = useMemo(() => {
        const archivedCount = tenants.filter((tenant) => Boolean(tenant.deletedAt) || tenant.status === 'CANCELLED' || tenant.status === 'PURGED').length;
        const suspendedCount = tenants.filter((tenant) => tenant.status === 'SUSPENDED').length;
        const activeCount = tenants.filter((tenant) => tenant.status === 'ACTIVE' && !tenant.deletedAt).length;
        const totalCredits = tenants.reduce((sum, tenant) => sum + tenant.usageCredits, 0);

        return [
            { value: tenants.length, subtitle: 'organizations loaded' },
            { value: activeCount, subtitle: 'active in loaded rows' },
            { value: suspendedCount + archivedCount, subtitle: 'attention in loaded rows' },
            { value: totalCredits.toLocaleString(), subtitle: 'credits in loaded rows' },
        ];
    }, [tenants]);

    const archivedTenants = useMemo(
        () => tenants.filter((tenant) => Boolean(tenant.deletedAt) || tenant.status === 'CANCELLED' || tenant.status === 'PURGED'),
        [tenants],
    );

    async function refresh(preferredSelectedId?: string) {
        await loadTenants({ preferredSelectedId, search: appliedQuery });
    }

    function applySearch(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const nextQuery = query.trim();
        if (nextQuery === appliedQuery) {
            void loadTenants({ search: nextQuery });
        } else {
            setAppliedQuery(nextQuery);
        }
    }

    async function createTenant(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        setNotice(null);

        const name = createForm.name.trim();
        if (!name) {
            setError('Tenant name is required.');
            return;
        }
        const ownerName = createForm.ownerName.trim();
        if (!ownerName) {
            setError('Owner name is required.');
            return;
        }
        const ownerEmail = createForm.ownerEmail.trim().toLowerCase();
        if (!OWNER_EMAIL_PATTERN.test(ownerEmail)) {
            setError('A valid owner email is required.');
            return;
        }

        const payload = buildTenantCreatePayload({
            name,
            slug: createForm.slug.trim() || undefined,
            planTier: createForm.planTier,
            status: createForm.status,
            ownerName,
            ownerEmail,
        });

        setSaving('create');
        try {
            const result = await writeJson<{
                id: string;
                planTier: PlanTier;
                status: TenantStatus;
                trialEndsAt: string | null;
            }>('/admin/tenants', 'POST', payload);
            setCreateForm(normalizeCreateForm());
            setNotice(
                result.status === 'TRIAL' && result.trialEndsAt
                    ? `Tenant and owner created. Paid trial ends ${formatDateTime(result.trialEndsAt)}.`
                    : 'Tenant and owner created with FREE entitlements.',
            );
            await refresh(result.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create tenant');
        } finally {
            setSaving((current) => (current === 'create' ? null : current));
        }
    }

    async function updateTenant(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selectedTenant) return;
        setError(null);
        setNotice(null);

        const name = editForm.name.trim();
        if (!name) {
            setError('Tenant name is required.');
            return;
        }

        setSaving(`update:${selectedTenant.id}`);
        try {
            await writeJson<{ id: string; updated: boolean }>(
                `/admin/tenants/${selectedTenant.id}`,
                'PUT',
                buildTenantEditPayload({
                    name,
                    slug: editForm.slug.trim(),
                }),
            );
            setNotice(`${selectedTenant.name} updated.`);
            await refresh(selectedTenant.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update tenant');
        } finally {
            setSaving((current) => (current === `update:${selectedTenant.id}` ? null : current));
        }
    }

    async function runStatusAction(tenant: TenantRecord, action: 'suspend' | 'activate' | 'archive' | 'restore') {
        const labelMap = {
            suspend: 'Suspend',
            activate: 'Activate',
            archive: 'Archive',
            restore: 'Restore',
        } as const;
        const pastTenseMap = {
            suspend: 'suspended',
            activate: 'activated',
            archive: 'archived',
            restore: 'restored',
        } as const;

        const confirmNeeded = action === 'suspend' || action === 'archive';
        if (confirmNeeded && !confirmLifecycleAction(action, tenant)) {
            setNotice(`${labelMap[action]} canceled.`);
            return;
        }

        setError(null);
        setNotice(null);
        setSaving(`${action}:${tenant.id}`);
        try {
            await writeJson(`/admin/tenants/${tenant.id}/${action}`, 'POST');
            setNotice(`${tenant.name} ${pastTenseMap[action]}.`);
            await refresh(tenant.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : `Failed to ${action} tenant`);
        } finally {
            setSaving((current) => (current === `${action}:${tenant.id}` ? null : current));
        }
    }

    async function deleteTenant(tenant: TenantRecord) {
        if (!tenant.deletedAt) {
            setError('Tenant must be archived before permanent deletion.');
            return;
        }
        if (!confirmLifecycleAction('delete', tenant)) {
            setNotice('Permanent delete canceled.');
            return;
        }

        setError(null);
        setNotice(null);
        setSaving(`delete:${tenant.id}`);
        try {
            await writeJson<{ id: string; deleted: boolean }>(`/admin/tenants/${tenant.id}`, 'DELETE');
            setNotice(`${tenant.name} permanently deleted.`);
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete tenant');
        } finally {
            setSaving((current) => (current === `delete:${tenant.id}` ? null : current));
        }
    }

    async function deleteArchivedTenantsBulk() {
        if (archivedTenants.length === 0) {
            setNotice('No archived tenants to remove.');
            return;
        }

        if (!confirmBulkArchivedTenantDelete(archivedTenants.length)) {
            setNotice('Bulk delete canceled.');
            return;
        }

        setError(null);
        setNotice(null);
        setSaving('bulk-delete');

        let successCount = 0;
        const failedNames: string[] = [];

        for (const tenant of archivedTenants) {
            try {
                await writeJson<{ id: string; deleted: boolean }>(`/admin/tenants/${tenant.id}`, 'DELETE');
                successCount += 1;
            } catch {
                failedNames.push(tenant.name);
            }
        }

        if (failedNames.length > 0) {
            setError(`Deleted ${successCount}/${archivedTenants.length}. Failed: ${failedNames.join(', ')}`);
        } else {
            setNotice(`Deleted ${successCount} archived tenant${successCount === 1 ? '' : 's'}.`);
        }

        await refresh();
        setSaving((current) => (current === 'bulk-delete' ? null : current));
    }

    const tenantToEdit = selectedTenant;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1440 }}>
            <section className="surface-card" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.85rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div>
                        <div className="workspace-kicker" style={{ color: '#b4233f' }}>
                            Organization control
                        </div>
                        <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
                            Tenants
                        </h1>
                        <p className="workspace-subtitle">
                            Live tenant management through the admin API - {loading ? 'Loading...' : tenants.length + ' organizations loaded' + (pagination.hasMore ? ' - more available' : '')}
                        </p>
                    </div>

                    <form onSubmit={applySearch} style={{ minWidth: 280, flex: '1 1 360px', display: 'flex', gap: '0.45rem', alignItems: 'flex-end' }}>
                        <label className="form-group" style={{ flex: 1 }}>
                            <span className="form-label">Search</span>
                            <input
                                className="form-input"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Search by tenant name or slug"
                                maxLength={100}
                            />
                        </label>
                        <button className="btn btn-sm btn-secondary" type="submit" disabled={saving === 'load'}>
                            Search
                        </button>
                    </form>
                </div>
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                {summary.map((item, index) => {
                    const palette = SUMMARY_COLORS[index];
                    return (
                        <article key={palette.title} className="surface-card" style={{ padding: '0.95rem', background: palette.bg }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.55rem' }}>
                                <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 650 }}>{palette.title}</span>
                                <span
                                    style={{
                                        width: 33,
                                        height: 33,
                                        borderRadius: 10,
                                        display: 'grid',
                                        placeItems: 'center',
                                        background: '#ffffff',
                                        border: '1px solid rgba(0,0,0,0.06)',
                                        fontSize: '0.9rem',
                                    }}
                                >
                                    {index === 0 ? '🏢' : index === 1 ? '✅' : index === 2 ? '⚠️' : '💳'}
                                </span>
                            </div>
                            <div style={{ fontSize: '1.9rem', fontWeight: 800, letterSpacing: 0, color: 'var(--text-primary)' }}>{item.value}</div>
                            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: palette.color }}>{item.subtitle}</div>
                        </article>
                    );
                })}
            </section>

            {error ? (
                <div
                    style={{
                        padding: '0.8rem 0.95rem',
                        borderRadius: 12,
                        border: '1px solid #ffd0da',
                        background: '#fff1f4',
                        color: '#b4233f',
                        fontWeight: 600,
                        fontSize: '0.86rem',
                    }}
                >
                    {error}
                </div>
            ) : null}

            {notice ? (
                <div
                    style={{
                        padding: '0.8rem 0.95rem',
                        borderRadius: 12,
                        border: '1px solid #c9d9ff',
                        background: '#edf3ff',
                        color: '#1d4ed8',
                        fontWeight: 600,
                        fontSize: '0.86rem',
                    }}
                >
                    {notice}
                </div>
            ) : null}

            <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(320px, 0.7fr)', gap: '0.85rem', alignItems: 'start' }}>
                <article
                    className="surface-card"
                    aria-label="Tenant directory table"
                    tabIndex={0}
                    style={{ overflowX: 'auto' }}
                >
                    <div style={{ padding: '0.95rem 1rem 0.55rem', display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div>
                            <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Tenant Directory</h2>
                            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>Click Edit to load a tenant into the management panel.</div>
                        </div>

                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                            <button
                                className="btn btn-sm btn-secondary"
                                onClick={() => void refresh(selectedTenantId ?? undefined)}
                                disabled={saving === 'load' || saving === 'bulk-delete'}
                                type="button"
                            >
                                {saving === 'load' ? 'Refreshing...' : 'Refresh'}
                            </button>
                            <button
                                className="btn btn-sm"
                                style={actionButtonStyle('danger')}
                                onClick={() => void deleteArchivedTenantsBulk()}
                                disabled={saving === 'bulk-delete' || archivedTenants.length === 0}
                                type="button"
                            >
                                {saving === 'bulk-delete' ? 'Removing...' : `Remove Archived (${archivedTenants.length})`}
                            </button>
                        </div>
                    </div>

                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1060 }}>
                        <thead>
                            <tr style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: '#f8faff' }}>
                                {['Organization', 'Plan', 'Status', 'Usage', 'Credits', 'Created', 'Actions'].map((h) => (
                                    <th
                                        key={h}
                                        style={{
                                            textAlign: 'left',
                                            padding: '0.75rem 1rem',
                                            fontSize: '0.66rem',
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
                            {tenants.map((tenant, index) => {
                                const isSelected = tenant.id === selectedTenantId;
                                const isArchived = Boolean(tenant.deletedAt) || tenant.status === 'CANCELLED' || tenant.status === 'PURGED';
                                const statusLabel = isArchived ? 'ARCHIVED' : tenant.status;
                                const statusStyle = STATUS_COLORS[statusLabel] ?? STATUS_COLORS[tenant.status] ?? STATUS_COLORS.ACTIVE;
                                const planStyle = PLAN_COLORS[tenant.planTier] ?? PLAN_COLORS.FREE;

                                return (
                                    <tr
                                        key={tenant.id}
                                        style={{
                                            borderBottom: index < tenants.length - 1 ? '1px solid var(--border)' : 'none',
                                            background: isSelected ? '#f8faff' : 'transparent',
                                        }}
                                    >
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)', marginBottom: 2 }}>{tenant.name}</div>
                                            <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{tenant.slug}</div>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <span className="badge" style={badgeStyle(planStyle.color, planStyle.bg, planStyle.border)}>
                                                {tenant.planTier}
                                            </span>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <span className="badge" style={badgeStyle(statusStyle.color, statusStyle.bg, statusStyle.border)}>
                                                {statusLabel}
                                            </span>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flexWrap: 'wrap' }}>
                                                <div>
                                                    <div style={{ fontSize: '0.92rem', fontWeight: 800, color: 'var(--text-primary)' }}>{tenant.usersCount}</div>
                                                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>users</div>
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '0.92rem', fontWeight: 800, color: 'var(--text-primary)' }}>{tenant.locationsCount}</div>
                                                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>locations</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.35rem' }}>
                                                <span style={{ fontSize: '0.88rem', color: '#7c4a03', fontWeight: 800 }}>{tenant.usageCredits.toLocaleString()}</span>
                                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>credits</span>
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                            <div>{formatDate(tenant.createdAt)}</div>
                                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 2 }}>{isArchived ? 'Archived' : 'Active record'}</div>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                                <button className="btn btn-sm btn-secondary" type="button" onClick={() => setSelectedTenantId(tenant.id)}>
                                                    Edit
                                                </button>
                                                {isArchived ? (
                                                    <>
                                                        <button
                                                            className="btn btn-sm"
                                                            style={actionButtonStyle('neutral')}
                                                            type="button"
                                                            disabled={saving === `restore:${tenant.id}`}
                                                            onClick={() => void runStatusAction(tenant, 'restore')}
                                                        >
                                                            {saving === `restore:${tenant.id}` ? 'Restoring...' : 'Restore'}
                                                        </button>
                                                        <button
                                                            className="btn btn-sm"
                                                            style={actionButtonStyle('danger')}
                                                            type="button"
                                                            disabled={saving === `delete:${tenant.id}`}
                                                            onClick={() => void deleteTenant(tenant)}
                                                        >
                                                            {saving === `delete:${tenant.id}` ? 'Deleting...' : 'Remove'}
                                                        </button>
                                                    </>
                                                ) : tenant.status === 'SUSPENDED' ? (
                                                    <button
                                                        className="btn btn-sm"
                                                        style={actionButtonStyle('positive')}
                                                        type="button"
                                                        disabled={saving === `activate:${tenant.id}`}
                                                        onClick={() => void runStatusAction(tenant, 'activate')}
                                                    >
                                                        {saving === `activate:${tenant.id}` ? 'Activating...' : 'Activate'}
                                                    </button>
                                                ) : (
                                                    <button
                                                        className="btn btn-sm"
                                                        style={actionButtonStyle('danger')}
                                                        type="button"
                                                        disabled={saving === `suspend:${tenant.id}`}
                                                        onClick={() => void runStatusAction(tenant, 'suspend')}
                                                    >
                                                        {saving === `suspend:${tenant.id}` ? 'Suspending...' : 'Suspend'}
                                                    </button>
                                                )}

                                                {!isArchived ? (
                                                    <button
                                                        className="btn btn-sm"
                                                        style={actionButtonStyle('warn')}
                                                        type="button"
                                                        disabled={saving === `archive:${tenant.id}`}
                                                        onClick={() => void runStatusAction(tenant, 'archive')}
                                                    >
                                                        {saving === `archive:${tenant.id}` ? 'Archiving...' : 'Archive'}
                                                    </button>
                                                ) : null}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}

                            {!loading && tenants.length === 0 ? (
                                <tr>
                                    <td colSpan={7} style={{ padding: '1rem', fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                                        No tenants match the current filter.
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                    {pagination.hasMore ? (
                        <div style={{ padding: '0.8rem 1rem', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'center' }}>
                            <button
                                className="btn btn-sm btn-secondary"
                                type="button"
                                disabled={saving === 'load-more' || !pagination.nextCursor}
                                onClick={() => void loadTenants({
                                    cursor: pagination.nextCursor,
                                    append: true,
                                    search: appliedQuery,
                                })}
                            >
                                {saving === 'load-more' ? 'Loading...' : 'Load more tenants'}
                            </button>
                        </div>
                    ) : null}
                </article>

                <div style={{ display: 'grid', gap: '0.85rem' }}>
                    <article className="surface-card" style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '0.8rem' }}>
                            <div>
                                <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Create tenant</h2>
                                <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>Provision a new organization directly from the admin API.</div>
                            </div>
                            <span className="badge" style={badgeStyle('#1d4ed8', '#edf3ff', '#c9d9ff')}>
                                POST /admin/tenants
                            </span>
                        </div>

                        <form onSubmit={(event) => void createTenant(event)} style={{ display: 'grid', gap: '0.78rem' }}>
                            <label className="form-group">
                                <span className="form-label">Name</span>
                                <input
                                    className="form-input"
                                    value={createForm.name}
                                    onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                                    placeholder="Downtown Bistro"
                                />
                            </label>

                            <label className="form-group">
                                <span className="form-label">Slug</span>
                                <input
                                    className="form-input"
                                    value={createForm.slug}
                                    onChange={(event) => setCreateForm((current) => ({ ...current, slug: event.target.value }))}
                                    placeholder="downtown-bistro"
                                />
                            </label>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))', gap: '0.75rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Owner name</span>
                                    <input
                                        className="form-input"
                                        value={createForm.ownerName}
                                        onChange={(event) => setCreateForm((current) => ({ ...current, ownerName: event.target.value }))}
                                        placeholder="Alex Owner"
                                        required
                                    />
                                </label>

                                <label className="form-group">
                                    <span className="form-label">Owner email</span>
                                    <input
                                        className="form-input"
                                        type="email"
                                        value={createForm.ownerEmail}
                                        onChange={(event) => setCreateForm((current) => ({ ...current, ownerEmail: event.target.value }))}
                                        placeholder="owner@example.com"
                                        required
                                    />
                                </label>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Plan</span>
                                    <select
                                        className="form-input"
                                        value={createForm.planTier}
                                        onChange={(event) => {
                                            const planTier = event.target.value as PlanTier;
                                            setCreateForm((current) => ({
                                                ...current,
                                                planTier,
                                                status: startingStatusForPlan(planTier),
                                            }));
                                        }}
                                    >
                                        {PLAN_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>

                                    <label className="form-group">
                                        <span className="form-label">Status</span>
                                        <input
                                            className="form-input"
                                            value={createForm.status}
                                            readOnly
                                            aria-describedby="tenant-create-entitlement-note"
                                        />
                                    </label>
                            </div>

                            <div
                                id="tenant-create-entitlement-note"
                                className="surface-muted"
                                style={{ padding: '0.55rem 0.65rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}
                            >
                                {tenantProvisioningDescription(createForm.planTier)}
                            </div>

                            <div
                                id="tenant-create-credit-note"
                                className="surface-muted"
                                style={{ padding: '0.55rem 0.65rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}
                            >
                                {TENANT_CREATE_CREDIT_GUIDANCE}
                            </div>

                            <button className="btn" type="submit" disabled={saving === 'create'}>
                                {saving === 'create' ? 'Creating...' : 'Create Tenant'}
                            </button>
                        </form>
                    </article>

                    <article className="surface-card" style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '0.8rem' }}>
                            <div style={{ minWidth: 0 }}>
                                <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Selected tenant</h2>
                                <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                    {tenantToEdit ? `${tenantToEdit.name} · ${tenantToEdit.slug}` : 'Pick a row in the table to edit it.'}
                                </div>
                            </div>
                            {tenantToEdit ? (
                                <span className="badge" style={badgeStyle('#b4233f', '#ffeef2', '#ffd0da')}>
                                    {tenantToEdit.deletedAt ? 'Archived' : tenantToEdit.status}
                                </span>
                            ) : null}
                        </div>

                        {tenantToEdit ? (
                            <form onSubmit={(event) => void updateTenant(event)} style={{ display: 'grid', gap: '0.78rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Name</span>
                                    <input
                                        className="form-input"
                                        value={editForm.name}
                                        onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))}
                                    />
                                </label>

                                <label className="form-group">
                                    <span className="form-label">Slug</span>
                                    <input
                                        className="form-input"
                                        value={editForm.slug}
                                        onChange={(event) => setEditForm((current) => ({ ...current, slug: event.target.value }))}
                                    />
                                </label>

                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' }}>
                                    <label className="form-group">
                                        <span className="form-label">Plan</span>
                                        <input
                                            className="form-input"
                                            value={tenantToEdit.planTier}
                                            readOnly
                                            aria-describedby="tenant-plan-billing-note"
                                        />
                                    </label>

                                    <label className="form-group">
                                        <span className="form-label">Status</span>
                                        <input
                                            className="form-input"
                                            value={tenantToEdit.status}
                                            readOnly
                                            aria-describedby="tenant-status-lifecycle-note"
                                        />
                                    </label>
                                </div>

                                <div className="surface-muted" style={{ padding: '0.55rem 0.65rem', fontSize: '0.75rem', color: 'var(--text-muted)', display: 'grid', gap: '0.35rem' }}>
                                    <div id="tenant-plan-billing-note">{TENANT_PLAN_EDIT_GUIDANCE}</div>
                                    <div id="tenant-status-lifecycle-note">{TENANT_STATUS_EDIT_GUIDANCE}</div>
                                </div>

                                <div
                                    className="surface-muted"
                                    style={{ padding: '0.7rem 0.75rem', display: 'grid', gap: '0.55rem' }}
                                >
                                    <div style={{ display: 'flex', gap: '0.65rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                        <div className="form-group" style={{ flex: '1 1 12rem' }}>
                                            <span className="form-label">Wallet balance</span>
                                            <output
                                                className="form-input"
                                                aria-describedby="tenant-credit-management-note"
                                            >
                                                {tenantToEdit.usageCredits.toLocaleString()} credits
                                            </output>
                                        </div>
                                        <Link
                                            className="btn btn-sm btn-secondary"
                                            href="/admin/credits"
                                            style={{ alignSelf: 'flex-end' }}
                                        >
                                            Open Admin Credits
                                        </Link>
                                    </div>
                                    <div id="tenant-credit-management-note">{TENANT_CREDIT_EDIT_GUIDANCE}</div>
                                </div>

                                <div
                                    className="surface-muted"
                                    style={{
                                        padding: '0.7rem 0.75rem',
                                        display: 'grid',
                                        gap: '0.45rem',
                                        fontSize: '0.76rem',
                                        color: 'var(--text-muted)',
                                    }}
                                >
                                    <div>
                                        Created: <strong style={{ color: 'var(--text-primary)' }}>{formatDate(tenantToEdit.createdAt)}</strong>
                                    </div>
                                    <div>
                                        Trial ends: <strong style={{ color: 'var(--text-primary)' }}>{formatDate(tenantToEdit.trialEndsAt)}</strong>
                                    </div>
                                    <div>
                                        Grace period ends: <strong style={{ color: 'var(--text-primary)' }}>{formatDate(tenantToEdit.gracePeriodEndsAt)}</strong>
                                    </div>
                                    <div>
                                        Deleted at: <strong style={{ color: 'var(--text-primary)' }}>{formatDateTime(tenantToEdit.deletedAt)}</strong>
                                    </div>
                                    <div>
                                        Usage: <strong style={{ color: 'var(--text-primary)' }}>{tenantToEdit.usersCount} users</strong> ·{' '}
                                        <strong style={{ color: 'var(--text-primary)' }}>{tenantToEdit.locationsCount} locations</strong>
                                    </div>
                                </div>

                                <button className="btn" type="submit" disabled={saving === `update:${tenantToEdit.id}`}>
                                    {saving === `update:${tenantToEdit.id}` ? 'Saving...' : 'Save changes'}
                                </button>

                                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                    {tenantToEdit.deletedAt ? (
                                        <>
                                            <button
                                                className="btn btn-sm"
                                                style={actionButtonStyle('neutral')}
                                                type="button"
                                                disabled={saving === `restore:${tenantToEdit.id}`}
                                                onClick={() => void runStatusAction(tenantToEdit, 'restore')}
                                            >
                                                {saving === `restore:${tenantToEdit.id}` ? 'Restoring...' : 'Restore'}
                                            </button>
                                            <button
                                                className="btn btn-sm"
                                                style={actionButtonStyle('danger')}
                                                type="button"
                                                disabled={saving === `delete:${tenantToEdit.id}`}
                                                onClick={() => void deleteTenant(tenantToEdit)}
                                            >
                                                {saving === `delete:${tenantToEdit.id}` ? 'Deleting...' : 'Remove'}
                                            </button>
                                        </>
                                    ) : tenantToEdit.status === 'SUSPENDED' ? (
                                        <button
                                            className="btn btn-sm"
                                            style={actionButtonStyle('positive')}
                                            type="button"
                                            disabled={saving === `activate:${tenantToEdit.id}`}
                                            onClick={() => void runStatusAction(tenantToEdit, 'activate')}
                                        >
                                            {saving === `activate:${tenantToEdit.id}` ? 'Activating...' : 'Activate'}
                                        </button>
                                    ) : (
                                        <button
                                            className="btn btn-sm"
                                            style={actionButtonStyle('danger')}
                                            type="button"
                                            disabled={saving === `suspend:${tenantToEdit.id}`}
                                            onClick={() => void runStatusAction(tenantToEdit, 'suspend')}
                                        >
                                            {saving === `suspend:${tenantToEdit.id}` ? 'Suspending...' : 'Suspend'}
                                        </button>
                                    )}

                                    {!tenantToEdit.deletedAt ? (
                                        <button
                                            className="btn btn-sm"
                                            style={actionButtonStyle('warn')}
                                            type="button"
                                            disabled={saving === `archive:${tenantToEdit.id}`}
                                            onClick={() => void runStatusAction(tenantToEdit, 'archive')}
                                        >
                                            {saving === `archive:${tenantToEdit.id}` ? 'Archiving...' : 'Archive'}
                                        </button>
                                    ) : null}
                                </div>
                            </form>
                        ) : (
                            <div
                                className="surface-muted"
                                style={{
                                    padding: '0.9rem',
                                    fontSize: '0.82rem',
                                    color: 'var(--text-muted)',
                                    lineHeight: 1.45,
                                }}
                            >
                                No tenant selected. Use Edit from the directory to load a record into the management form.
                            </div>
                        )}
                    </article>
                </div>
            </section>
        </div>
    );
}
