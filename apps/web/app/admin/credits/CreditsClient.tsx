'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';

type CreditTenant = {
    id: string;
    name: string;
    slug: string;
    planTier: string;
    usageCredits: number;
};

type CreditHistoryRow = {
    id: string;
    amount: number;
    reason: string;
    createdAt: string;
    tenant: CreditTenant | null;
};

type CreditsPayload = {
    tenants?: CreditTenant[];
    history?: CreditHistoryRow[];
};

type CreditGrantForm = {
    tenantId: string;
    amount: string;
    reason: string;
};

const PLAN_COLORS: Record<string, { color: string; bg: string; border: string }> = {
    FREE: { color: '#4c5f85', bg: '#eef2f9', border: '#d3ddeb' },
    STARTER: { color: '#2f63ff', bg: '#edf3ff', border: '#c9d9ff' },
    GROWTH: { color: '#0f8c52', bg: '#e9fbf1', border: '#bdeed4' },
    ENTERPRISE: { color: '#cc7f06', bg: '#fff4e2', border: '#ffe1a6' },
};

const HISTORY_META = {
    positive: { label: 'Grant', color: '#0f8c52', bg: '#e9fbf1', border: '#bdeed4' },
    negative: { label: 'Debit', color: '#cb3653', bg: '#ffeef2', border: '#ffd0da' },
};

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

function getCsrfHeaders(): Record<string, string> {
    if (typeof document === 'undefined') return {};
    const pair = document.cookie
        .split('; ')
        .find((entry) => entry.startsWith('csrf_token='));
    const csrfToken = pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
    return csrfToken ? { 'x-csrf-token': csrfToken } : {};
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

function formatDateTime(value: string | null | undefined) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(date);
}

function formatCredits(value: number) {
    return NUMBER_FORMAT.format(value);
}

function parseCreditsPayload(payload: unknown): { tenants: CreditTenant[]; history: CreditHistoryRow[] } {
    if (!payload || typeof payload !== 'object') {
        return { tenants: [], history: [] };
    }

    const typed = payload as CreditsPayload;
    return {
        tenants: Array.isArray(typed.tenants) ? typed.tenants : [],
        history: Array.isArray(typed.history) ? typed.history : [],
    };
}

function parseAmount(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
}

export function CreditsClient() {
    const [tenants, setTenants] = useState<CreditTenant[]>([]);
    const [history, setHistory] = useState<CreditHistoryRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [form, setForm] = useState<CreditGrantForm>({ tenantId: '', amount: '500', reason: 'Admin grant' });

    const loadCredits = useCallback(async () => {
        setLoading(true);
        setSaving('load');
        setError(null);
        try {
            const payload = await fetchJsonWithSession<unknown>('/admin/credits');
            const next = parseCreditsPayload(payload);
            setTenants(next.tenants);
            setHistory(next.history);
            setForm((current) => ({
                ...current,
                tenantId: next.tenants.some((tenant) => tenant.id === current.tenantId)
                    ? current.tenantId
                    : next.tenants[0]?.id ?? '',
            }));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load credit balances');
        } finally {
            setLoading(false);
            setSaving((current) => (current === 'load' ? null : current));
        }
    }, []);

    useEffect(() => {
        void loadCredits();
    }, [loadCredits]);

    useEffect(() => {
        if (form.tenantId) return;
        setForm((current) => ({
            ...current,
            tenantId: tenants[0]?.id ?? '',
        }));
    }, [form.tenantId, tenants]);

    const filteredTenants = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        const sorted = [...tenants].sort((a, b) => b.usageCredits - a.usageCredits);
        if (!normalized) return sorted;
        return sorted.filter((tenant) => {
            return [
                tenant.name,
                tenant.slug,
                tenant.planTier,
                String(tenant.usageCredits),
            ]
                .join(' ')
                .toLowerCase()
                .includes(normalized);
        });
    }, [query, tenants]);

    const sortedHistory = useMemo(() => {
        return [...history].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [history]);

    const summary = useMemo(() => {
        const totalCredits = tenants.reduce((sum, tenant) => sum + tenant.usageCredits, 0);
        const historyCount = history.length;
        const positiveCount = history.filter((row) => row.amount > 0).length;
        const maxBalance = tenants.length > 0 ? Math.max(...tenants.map((tenant) => tenant.usageCredits)) : 0;

        return [
            { value: tenants.length, subtitle: 'tenant balances', icon: '🏢', color: '#2f63ff', bg: '#edf3ff' },
            { value: formatCredits(totalCredits), subtitle: 'total credits', icon: '💳', color: '#0f8c52', bg: '#e9fbf1' },
            { value: historyCount, subtitle: 'ledger entries', icon: '🧾', color: '#cb3653', bg: '#ffeef2' },
            { value: formatCredits(maxBalance), subtitle: 'largest balance', icon: '📈', color: '#cc7f06', bg: '#fff4e2' },
            { value: positiveCount, subtitle: 'grant rows', icon: '➕', color: '#0f8c52', bg: '#e9fbf1' },
        ];
    }, [history, tenants]);

    const selectedTenant = useMemo(
        () => tenants.find((tenant) => tenant.id === form.tenantId) ?? null,
        [form.tenantId, tenants],
    );

    async function grantCredits(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        setNotice(null);

        if (!form.tenantId) {
            setError('Select a tenant before granting credits.');
            return;
        }

        const amount = parseAmount(form.amount);
        if (!Number.isInteger(amount) || amount <= 0) {
            setError('Amount must be a positive integer.');
            return;
        }

        const reason = form.reason.trim();
        if (!reason) {
            setError('Reason is required.');
            return;
        }

        setSaving('grant');
        try {
            await writeJson<{ success?: boolean; newBalance?: number }>('/admin/credits/grant', 'POST', {
                tenantId: form.tenantId,
                amount,
                reason,
            });
            setNotice('Credits granted.');
            await loadCredits();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to grant credits');
        } finally {
            setSaving((current) => (current === 'grant' ? null : current));
        }
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1440 }}>
            <section
                className="surface-card"
                style={{
                    padding: '1rem',
                    background:
                        'radial-gradient(36rem 16rem at 0% 0%, rgba(47,99,255,0.12), transparent 60%), radial-gradient(34rem 17rem at 100% 100%, rgba(15,140,82,0.12), transparent 60%), #ffffff',
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.85rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div>
                        <div className="workspace-kicker" style={{ color: '#cb3653' }}>
                            Billing controls
                        </div>
                        <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
                            Credits
                        </h1>
                        <p className="workspace-subtitle">
                            Live tenant balances and credit ledger data from the admin API · {loading ? 'Loading...' : `${tenants.length} tenant${tenants.length === 1 ? '' : 's'} synced`}
                        </p>
                    </div>

                    <label className="form-group" style={{ minWidth: 280, flex: '1 1 320px' }}>
                        <span className="form-label">Search</span>
                        <input
                            className="form-input"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Filter by tenant, plan, or balance"
                        />
                    </label>
                </div>
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                {summary.map((item) => (
                    <article key={item.subtitle} className="surface-card" style={{ padding: '0.95rem', background: item.bg }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.55rem' }}>
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', fontWeight: 650 }}>{item.subtitle}</span>
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
                                {item.icon}
                            </span>
                        </div>
                        <div style={{ fontSize: '1.9rem', fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>{item.value}</div>
                        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: item.color }}>Real-time credit control</div>
                    </article>
                ))}
            </section>

            {error ? (
                <div
                    style={{
                        padding: '0.8rem 0.95rem',
                        borderRadius: 12,
                        border: '1px solid #ffd0da',
                        background: '#fff1f4',
                        color: '#cb3653',
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
                        color: '#2f63ff',
                        fontWeight: 600,
                        fontSize: '0.86rem',
                    }}
                >
                    {notice}
                </div>
            ) : null}

            <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.25fr) minmax(320px, 0.75fr)', gap: '0.85rem', alignItems: 'start' }}>
                <article className="surface-card" style={{ overflowX: 'auto' }}>
                    <div style={{ padding: '0.95rem 1rem 0.55rem', display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div>
                            <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Tenant Balances</h2>
                            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                Balances are loaded from the admin credits API.
                            </div>
                        </div>

                        <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => void loadCredits()}
                            disabled={saving === 'load'}
                            type="button"
                        >
                            {saving === 'load' ? 'Refreshing...' : 'Refresh'}
                        </button>
                    </div>

                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
                        <thead>
                            <tr style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: '#f8faff' }}>
                                {['Tenant', 'Plan', 'Balance', 'Actions'].map((header) => (
                                    <th
                                        key={header}
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
                                        {header}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {filteredTenants.map((tenant, index) => {
                                const planStyle = PLAN_COLORS[tenant.planTier] ?? PLAN_COLORS.FREE;
                                return (
                                    <tr
                                        key={tenant.id}
                                        style={{
                                            borderBottom: index < filteredTenants.length - 1 ? '1px solid var(--border)' : 'none',
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
                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}>
                                                <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#cc7f06', letterSpacing: '-0.02em' }}>
                                                    {formatCredits(tenant.usageCredits)}
                                                </span>
                                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>credits</span>
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <button
                                                className="btn btn-sm btn-secondary"
                                                type="button"
                                                onClick={() => setForm((current) => ({ ...current, tenantId: tenant.id }))}
                                            >
                                                Grant to this tenant
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}

                            {!loading && filteredTenants.length === 0 ? (
                                <tr>
                                    <td colSpan={4} style={{ padding: '1rem', fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                                        No tenant balances match the current filter.
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                </article>

                <article className="surface-card" style={{ padding: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '0.8rem' }}>
                        <div>
                            <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Grant Credits</h2>
                            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                Writes a ledger entry and updates the tenant balance immediately.
                            </div>
                        </div>
                        <span className="badge" style={badgeStyle('#2f63ff', '#edf3ff', '#c9d9ff')}>
                            POST /billing/credits/grant
                        </span>
                    </div>

                    <form onSubmit={(event) => void grantCredits(event)} style={{ display: 'grid', gap: '0.78rem' }}>
                        <label className="form-group">
                            <span className="form-label">Tenant</span>
                            <select
                                className="form-input"
                                value={form.tenantId}
                                onChange={(event) => setForm((current) => ({ ...current, tenantId: event.target.value }))}
                                disabled={tenants.length === 0}
                            >
                                {tenants.map((tenant) => (
                                    <option key={tenant.id} value={tenant.id}>
                                        {tenant.name} · {tenant.slug}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="form-group">
                            <span className="form-label">Amount</span>
                            <input
                                className="form-input"
                                type="number"
                                min="1"
                                step="1"
                                value={form.amount}
                                onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))}
                                placeholder="500"
                            />
                        </label>

                        <label className="form-group">
                            <span className="form-label">Reason</span>
                            <input
                                className="form-input"
                                value={form.reason}
                                onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))}
                                placeholder="Customer success grant"
                            />
                        </label>

                        <div
                            className="surface-muted"
                            style={{
                                padding: '0.85rem',
                                display: 'grid',
                                gap: '0.4rem',
                                fontSize: '0.76rem',
                                color: 'var(--text-muted)',
                                lineHeight: 1.45,
                            }}
                        >
                            <div>
                                Selected tenant: <strong style={{ color: 'var(--text-primary)' }}>{selectedTenant?.name ?? 'None'}</strong>
                            </div>
                            <div>
                                Current balance: <strong style={{ color: 'var(--text-primary)' }}>{selectedTenant ? formatCredits(selectedTenant.usageCredits) : '—'}</strong>
                            </div>
                        </div>

                        <button className="btn" type="submit" disabled={saving === 'grant' || tenants.length === 0}>
                            {saving === 'grant' ? 'Granting...' : 'Grant Credits'}
                        </button>
                    </form>

                    <div style={{ marginTop: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
                            <h3 style={{ fontSize: '0.92rem', fontWeight: 750, color: 'var(--text-primary)' }}>Usage note</h3>
                        </div>
                        <div
                            className="surface-muted"
                            style={{
                                padding: '0.85rem',
                                fontSize: '0.78rem',
                                color: 'var(--text-muted)',
                                lineHeight: 1.5,
                            }}
                        >
                            Credits are tracked on the tenant ledger even when balances are increased manually. That keeps reporting and reconciliation aligned with the live balance.
                        </div>
                    </div>
                </article>
            </section>

            <article className="surface-card" style={{ overflowX: 'auto' }}>
                <div style={{ padding: '0.95rem 1rem 0.55rem' }}>
                    <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Transaction History</h2>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        Recent credit ledger entries from the admin API.
                    </div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                    <thead>
                        <tr style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: '#f8faff' }}>
                            {['Time', 'Tenant', 'Amount', 'Reason'].map((header) => (
                                <th
                                    key={header}
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
                                    {header}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {sortedHistory.map((row, index) => {
                            const isPositive = row.amount >= 0;
                            const meta = isPositive ? HISTORY_META.positive : HISTORY_META.negative;
                            return (
                                <tr
                                    key={row.id}
                                    style={{
                                        borderBottom: index < sortedHistory.length - 1 ? '1px solid var(--border)' : 'none',
                                    }}
                                >
                                    <td style={{ padding: '0.76rem 1rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                        {formatDateTime(row.createdAt)}
                                    </td>
                                    <td style={{ padding: '0.76rem 1rem' }}>
                                        <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                                            {row.tenant?.name ?? 'Unknown tenant'}
                                        </div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                                            {row.tenant?.slug ?? 'deleted-or-system'}
                                        </div>
                                    </td>
                                    <td style={{ padding: '0.76rem 1rem' }}>
                                        <span className="badge" style={badgeStyle(meta.color, meta.bg, meta.border)}>
                                            {isPositive ? '+' : ''}
                                            {formatCredits(row.amount)}
                                        </span>
                                    </td>
                                    <td style={{ padding: '0.76rem 1rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{row.reason}</td>
                                </tr>
                            );
                        })}

                        {!loading && sortedHistory.length === 0 ? (
                            <tr>
                                <td colSpan={4} style={{ padding: '1rem', fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                                    No credit transactions are available yet.
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </article>
        </div>
    );
}
