'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';

type PlanStatus = 'ACTIVE' | 'INACTIVE';

type PlanRecord = {
    id: string;
    code: string;
    name: string;
    status: PlanStatus;
    maxLocations: number | null;
    maxUsers: number | null;
    creditsLimit: number | null;
    priceMonthly: number | null;
};

type PlanListResponse = {
    data?: PlanRecord[];
    plans?: PlanRecord[];
};

type PlanFormState = {
    code: string;
    name: string;
    status: PlanStatus;
    maxLocations: string;
    maxUsers: string;
    unlimitedCredits: boolean;
    creditsLimit: string;
    priceMonthly: string;
};

type Banner = {
    tone: 'success' | 'error';
    text: string;
} | null;

const STATUS_META: Record<PlanStatus, { label: string; color: string; bg: string; border: string }> = {
    ACTIVE: { label: 'Active', color: '#0f8c52', bg: '#e9fbf1', border: '#bdeed4' },
    INACTIVE: { label: 'Inactive', color: '#6f80a4', bg: '#eef2f9', border: '#d3ddeb' },
};

const SUMMARY_META = [
    { title: 'Live plans', icon: '📦', color: '#2f63ff', bg: '#edf3ff' },
    { title: 'Active catalog', icon: '✅', color: '#0f8c52', bg: '#e9fbf1' },
    { title: 'Unlimited credits', icon: '∞', color: '#cb3653', bg: '#ffeef2' },
    { title: 'Price coverage', icon: '💳', color: '#cc7f06', bg: '#fff4e2' },
];

const CODE_REGEX = /^[a-z0-9][a-z0-9._-]{1,47}$/;
const NUMBER_FORMAT = new Intl.NumberFormat('en-US');
const CURRENCY_FORMAT = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
});

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

function normalizeCode(value: string): string {
    return value.trim().toLowerCase();
}

function toInteger(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function toOptionalPrice(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function formatCurrency(value: number | null): string {
    if (value === null) return '—';
    return CURRENCY_FORMAT.format(value);
}

function formatLimit(value: number | null): string {
    if (value === null) return 'Unlimited';
    return NUMBER_FORMAT.format(value);
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

function actionButtonStyle(kind: 'neutral' | 'danger') {
    if (kind === 'danger') {
        return { background: '#ffeef2', color: '#cb3653', borderColor: '#ffd0da' };
    }
    return { background: '#edf3ff', color: '#2f63ff', borderColor: '#c9d9ff' };
}

function parsePlanRecord(value: unknown): PlanRecord | null {
    if (!value || typeof value !== 'object') return null;
    const plan = value as Record<string, unknown>;

    const id = typeof plan.id === 'string' ? plan.id : '';
    const code = typeof plan.code === 'string' ? plan.code : typeof plan.key === 'string' ? plan.key : '';
    const name = typeof plan.name === 'string' ? plan.name : '';
    if (!id || !code || !name) return null;

    const status = plan.status === 'INACTIVE' || plan.active === false ? 'INACTIVE' : 'ACTIVE';
    const maxLocations = typeof plan.maxLocations === 'number'
        ? plan.maxLocations
        : typeof plan.locationLimit === 'number'
            ? plan.locationLimit
            : typeof plan.storeLimit === 'number'
                ? plan.storeLimit
                : null;
    const maxUsers = typeof plan.maxUsers === 'number'
        ? plan.maxUsers
        : typeof plan.userLimit === 'number'
            ? plan.userLimit
            : null;
    const creditsLimit = typeof plan.creditsLimit === 'number'
        ? plan.creditsLimit
        : typeof plan.creditQuotaLimit === 'number'
            ? plan.creditQuotaLimit
            : null;
    const priceMonthly = typeof plan.priceMonthly === 'number'
        ? plan.priceMonthly
        : typeof plan.monthlyPriceCents === 'number'
            ? plan.monthlyPriceCents / 100
            : null;

    return {
        id,
        code,
        name,
        status,
        maxLocations,
        maxUsers,
        creditsLimit,
        priceMonthly,
    };
}

function parsePlansResponse(payload: unknown): PlanRecord[] {
    const source = Array.isArray(payload)
        ? payload
        : payload && typeof payload === 'object'
            ? (Array.isArray((payload as PlanListResponse).data)
                ? (payload as PlanListResponse).data
                : Array.isArray((payload as PlanListResponse).plans)
                    ? (payload as PlanListResponse).plans
                    : [])
            : [];
    return source
        .map((entry) => parsePlanRecord(entry))
        .filter((entry): entry is PlanRecord => entry !== null);
}

function normalizeForm(plan?: PlanRecord | null): PlanFormState {
    return {
        code: plan?.code ?? '',
        name: plan?.name ?? '',
        status: plan?.status ?? 'ACTIVE',
        maxLocations: plan ? String(plan.maxLocations ?? '') : '1',
        maxUsers: plan ? String(plan.maxUsers ?? '') : '10',
        unlimitedCredits: plan ? plan.creditsLimit === null : true,
        creditsLimit: plan?.creditsLimit === null ? '' : String(plan?.creditsLimit ?? 0),
        priceMonthly: plan?.priceMonthly === null || plan?.priceMonthly === undefined ? '' : String(plan.priceMonthly),
    };
}

function emptyForm(): PlanFormState {
    return {
        code: '',
        name: '',
        status: 'ACTIVE',
        maxLocations: '1',
        maxUsers: '10',
        unlimitedCredits: true,
        creditsLimit: '',
        priceMonthly: '',
    };
}

export function AdminPlansWorkspace() {
    const [plans, setPlans] = useState<PlanRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<Banner>(null);
    const [query, setQuery] = useState('');
    const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
    const [createForm, setCreateForm] = useState<PlanFormState>(() => emptyForm());
    const [editForm, setEditForm] = useState<PlanFormState>(() => emptyForm());

    const selectedPlan = useMemo(
        () => plans.find((plan) => plan.id === selectedPlanId) ?? null,
        [plans, selectedPlanId],
    );

    const loadPlans = useCallback(async (preferredSelectedId?: string) => {
        setLoading(true);
        setError(null);
        setSaving('load');
        try {
            const payload = await fetchJsonWithSession<unknown>('/admin/plans');
            const nextPlans = parsePlansResponse(payload);
            setPlans(nextPlans);
            setSelectedPlanId((current) => {
                if (preferredSelectedId && nextPlans.some((plan) => plan.id === preferredSelectedId)) {
                    return preferredSelectedId;
                }
                if (current && nextPlans.some((plan) => plan.id === current)) {
                    return current;
                }
                return nextPlans[0]?.id ?? null;
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load plans');
        } finally {
            setLoading(false);
            setSaving((current) => (current === 'load' ? null : current));
        }
    }, []);

    useEffect(() => {
        void loadPlans();
    }, [loadPlans]);

    useEffect(() => {
        setEditForm(normalizeForm(selectedPlan));
    }, [selectedPlan]);

    const filteredPlans = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        const sortedPlans = [...plans].sort((a, b) => {
            if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1;
            return a.code.localeCompare(b.code);
        });

        if (!normalized) return sortedPlans;
        return sortedPlans.filter((plan) => {
            const haystack = [
                plan.code,
                plan.name,
                plan.status,
                String(plan.maxLocations),
                String(plan.maxUsers),
                plan.creditsLimit === null ? 'unlimited' : String(plan.creditsLimit),
                plan.priceMonthly === null ? '' : String(plan.priceMonthly),
            ]
                .join(' ')
                .toLowerCase();
            return haystack.includes(normalized);
        });
    }, [plans, query]);

    const summary = useMemo(() => {
        const activeCount = plans.filter((plan) => plan.status === 'ACTIVE').length;
        const unlimitedCount = plans.filter((plan) => plan.creditsLimit === null).length;
        const pricedPlans = plans.filter((plan) => plan.priceMonthly !== null);
        const highestPrice = pricedPlans.length > 0 ? Math.max(...pricedPlans.map((plan) => plan.priceMonthly ?? 0)) : null;

        return [
            { value: plans.length, subtitle: 'pricing records', icon: SUMMARY_META[0].icon, color: SUMMARY_META[0].color, bg: SUMMARY_META[0].bg },
            { value: activeCount, subtitle: 'eligible for checkout', icon: SUMMARY_META[1].icon, color: SUMMARY_META[1].color, bg: SUMMARY_META[1].bg },
            { value: unlimitedCount, subtitle: 'credits unlimited', icon: SUMMARY_META[2].icon, color: SUMMARY_META[2].color, bg: SUMMARY_META[2].bg },
            {
                value: highestPrice === null ? '—' : CURRENCY_FORMAT.format(highestPrice),
                subtitle: 'highest monthly rate',
                icon: SUMMARY_META[3].icon,
                color: SUMMARY_META[3].color,
                bg: SUMMARY_META[3].bg,
            },
        ];
    }, [plans]);

    async function refresh(preferredSelectedId?: string) {
        await loadPlans(preferredSelectedId);
    }

    async function createPlan(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        setNotice(null);

        const code = normalizeCode(createForm.code);
        const name = createForm.name.trim();
        if (!code) {
            setError('Plan code is required.');
            return;
        }
        if (!CODE_REGEX.test(code)) {
            setError('Plan code must be 2-48 characters and use lowercase letters, numbers, dots, underscores, or hyphens.');
            return;
        }
        if (!name) {
            setError('Plan name is required.');
            return;
        }

        const maxLocations = toInteger(createForm.maxLocations);
        const maxUsers = toInteger(createForm.maxUsers);
        if (!Number.isInteger(maxLocations) || maxLocations < 1) {
            setError('Store/location limit must be at least 1.');
            return;
        }
        if (!Number.isInteger(maxUsers) || maxUsers < 1) {
            setError('User limit must be at least 1.');
            return;
        }

        let creditsLimit: number | null = null;
        if (!createForm.unlimitedCredits) {
            const parsedCredits = toInteger(createForm.creditsLimit);
            if (!Number.isInteger(parsedCredits) || parsedCredits < 0) {
                setError('Credits limit must be a non-negative integer.');
                return;
            }
            creditsLimit = parsedCredits;
        }

        const priceMonthly = toOptionalPrice(createForm.priceMonthly);
        if (Number.isNaN(priceMonthly)) {
            setError('Monthly price must be a valid number.');
            return;
        }

        setSaving('create');
        try {
            const result = await writeJson<{ id?: string }>('/admin/plans', 'POST', {
                code,
                name,
                status: createForm.status,
                locationLimit: maxLocations,
                userLimit: maxUsers,
                creditQuotaLimit: creditsLimit,
                priceMonthly,
            });
            setCreateForm(emptyForm());
            setNotice({ tone: 'success', text: 'Plan created.' });
            await refresh(result.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create plan');
        } finally {
            setSaving((current) => (current === 'create' ? null : current));
        }
    }

    async function updatePlan(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selectedPlan) return;

        setError(null);
        setNotice(null);

        const code = normalizeCode(editForm.code);
        const name = editForm.name.trim();
        if (!code) {
            setError('Plan code is required.');
            return;
        }
        if (!CODE_REGEX.test(code)) {
            setError('Plan code must be 2-48 characters and use lowercase letters, numbers, dots, underscores, or hyphens.');
            return;
        }
        if (!name) {
            setError('Plan name is required.');
            return;
        }

        const maxLocationsRaw = editForm.maxLocations.trim();
        const maxUsersRaw = editForm.maxUsers.trim();
        let maxLocations: number | undefined;
        let maxUsers: number | undefined;
        if (maxLocationsRaw) {
            const parsed = toInteger(maxLocationsRaw);
            if (!Number.isInteger(parsed) || parsed < 1) {
                setError('Store/location limit must be at least 1.');
                return;
            }
            maxLocations = parsed;
        }
        if (maxUsersRaw) {
            const parsed = toInteger(maxUsersRaw);
            if (!Number.isInteger(parsed) || parsed < 1) {
                setError('User limit must be at least 1.');
                return;
            }
            maxUsers = parsed;
        }

        let creditsLimit: number | null = null;
        if (!editForm.unlimitedCredits) {
            const parsedCredits = toInteger(editForm.creditsLimit);
            if (!Number.isInteger(parsedCredits) || parsedCredits < 0) {
                setError('Credits limit must be a non-negative integer.');
                return;
            }
            creditsLimit = parsedCredits;
        }

        const priceMonthly = toOptionalPrice(editForm.priceMonthly);
        if (Number.isNaN(priceMonthly)) {
            setError('Monthly price must be a valid number.');
            return;
        }

        setSaving(`update:${selectedPlan.id}`);
        try {
            const payload: Record<string, unknown> = {
                code,
                name,
                status: editForm.status,
                creditQuotaLimit: creditsLimit,
                priceMonthly,
            };
            if (maxLocations !== undefined) payload.locationLimit = maxLocations;
            if (maxUsers !== undefined) payload.userLimit = maxUsers;

            await writeJson<{ id?: string; updated?: boolean }>(`/admin/plans/${selectedPlan.code}`, 'PUT', payload);
            setNotice({ tone: 'success', text: `${selectedPlan.name} updated.` });
            await refresh(selectedPlan.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update plan');
        } finally {
            setSaving((current) => (current === `update:${selectedPlan.id}` ? null : current));
        }
    }

    async function deletePlan(plan: PlanRecord) {
        if (typeof window !== 'undefined') {
            const confirmed = window.confirm(`Delete ${plan.name}? This will remove the plan from the catalog.`);
            if (!confirmed) return;
        }

        setError(null);
        setNotice(null);
        setSaving(`delete:${plan.id}`);
        try {
            await writeJson<{ id?: string; deleted?: boolean }>(`/admin/plans/${plan.code}`, 'DELETE');
            setNotice({ tone: 'success', text: `${plan.name} deleted.` });
            await refresh(plan.id === selectedPlanId ? undefined : selectedPlanId ?? undefined);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete plan');
        } finally {
            setSaving((current) => (current === `delete:${plan.id}` ? null : current));
        }
    }

    const selectedStatusMeta = selectedPlan ? STATUS_META[selectedPlan.status] : null;
    const selectedPrices = useMemo(() => {
        if (!selectedPlan) return null;
        return [
            { label: 'Store/location limit', value: formatLimit(selectedPlan.maxLocations) },
            { label: 'User limit', value: formatLimit(selectedPlan.maxUsers) },
            { label: 'Credits limit', value: selectedPlan.creditsLimit === null ? 'Unlimited' : formatLimit(selectedPlan.creditsLimit) },
            { label: 'Price / month', value: formatCurrency(selectedPlan.priceMonthly) },
        ];
    }, [selectedPlan]);

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
                            Plans
                        </h1>
                        <p className="workspace-subtitle">
                            Create and govern pricing plans through the admin API · {loading ? 'Loading...' : `${plans.length} plan${plans.length === 1 ? '' : 's'} synced`}
                        </p>
                    </div>

                    <label className="form-group" style={{ minWidth: 280, flex: '1 1 320px' }}>
                        <span className="form-label">Search</span>
                        <input
                            className="form-input"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Filter by code, name, limit, or price"
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
                        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: item.color }}>Pricing governance</div>
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
                    {notice.text}
                </div>
            ) : null}

            <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(320px, 0.65fr)', gap: '0.85rem', alignItems: 'start' }}>
                <article className="surface-card" style={{ overflowX: 'auto' }}>
                    <div style={{ padding: '0.95rem 1rem 0.55rem', display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div>
                            <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Plan catalog</h2>
                            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                Select Edit to load a plan into the pricing editor.
                            </div>
                        </div>

                        <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => void refresh(selectedPlanId ?? undefined)}
                            disabled={saving === 'load'}
                            type="button"
                        >
                            {saving === 'load' ? 'Refreshing...' : 'Refresh'}
                        </button>
                    </div>

                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                        <thead>
                            <tr style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: '#f8faff' }}>
                                {['Code', 'Name', 'Status', 'Limits', 'Price / month', 'Actions'].map((header) => (
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
                            {filteredPlans.map((plan, index) => {
                                const isSelected = plan.id === selectedPlanId;
                                const statusStyle = STATUS_META[plan.status];
                                return (
                                    <tr
                                        key={plan.id}
                                        style={{
                                            borderBottom: index < filteredPlans.length - 1 ? '1px solid var(--border)' : 'none',
                                            background: isSelected ? '#f8faff' : 'transparent',
                                        }}
                                    >
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ fontWeight: 800, fontSize: '0.86rem', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
                                                {plan.code}
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)', marginBottom: 2 }}>{plan.name}</div>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                                {plan.creditsLimit === null ? 'Usage tracked on unlimited credits' : 'Finite usage credits included'}
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <span className="badge" style={badgeStyle(statusStyle.color, statusStyle.bg, statusStyle.border)}>
                                                {statusStyle.label}
                                            </span>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ display: 'grid', gap: '0.34rem' }}>
                                                <div style={{ display: 'flex', gap: '0.42rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                                    <span className="badge" style={badgeStyle('#2f63ff', '#edf3ff', '#c9d9ff')}>
                                                        {plan.maxLocations === null ? 'Unlimited locations' : `${formatLimit(plan.maxLocations)} locations`}
                                                    </span>
                                                    <span className="badge" style={badgeStyle('#0f8c52', '#e9fbf1', '#bdeed4')}>
                                                        {plan.maxUsers === null ? 'Unlimited users' : `${formatLimit(plan.maxUsers)} users`}
                                                    </span>
                                                </div>
                                                <div style={{ display: 'flex', gap: '0.42rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                                    <span className="badge" style={badgeStyle(plan.creditsLimit === null ? '#cb3653' : '#cc7f06', plan.creditsLimit === null ? '#ffeef2' : '#fff4e2', plan.creditsLimit === null ? '#ffd0da' : '#ffe1a6')}>
                                                        {plan.creditsLimit === null ? 'Unlimited credits' : `${formatLimit(plan.creditsLimit)} credits`}
                                                    </span>
                                                </div>
                                            </div>
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem', fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 700 }}>
                                            {formatCurrency(plan.priceMonthly)}
                                        </td>
                                        <td style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                                <button
                                                    className="btn btn-sm btn-secondary"
                                                    type="button"
                                                    onClick={() => setSelectedPlanId(plan.id)}
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    className="btn btn-sm"
                                                    style={actionButtonStyle('danger')}
                                                    type="button"
                                                    disabled={saving === `delete:${plan.id}`}
                                                    onClick={() => void deletePlan(plan)}
                                                >
                                                    {saving === `delete:${plan.id}` ? 'Deleting...' : 'Delete'}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}

                            {!loading && filteredPlans.length === 0 ? (
                                <tr>
                                    <td colSpan={6} style={{ padding: '1rem', fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                                        No plans match the current filter.
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                </article>

                <div style={{ display: 'grid', gap: '0.85rem' }}>
                    <article className="surface-card" style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '0.8rem' }}>
                            <div>
                                <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Create plan</h2>
                                <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                    Publish a new pricing plan from the admin API.
                                </div>
                            </div>
                            <span className="badge" style={badgeStyle('#2f63ff', '#edf3ff', '#c9d9ff')}>
                                POST /admin/plans
                            </span>
                        </div>

                        <form onSubmit={(event) => void createPlan(event)} style={{ display: 'grid', gap: '0.78rem' }}>
                            <label className="form-group">
                                <span className="form-label">Plan code</span>
                                <input
                                    className="form-input"
                                    value={createForm.code}
                                    onChange={(event) => setCreateForm((current) => ({ ...current, code: event.target.value }))}
                                    placeholder="starter"
                                    autoComplete="off"
                                />
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                    Stable technical key used by billing and provisioning.
                                </span>
                            </label>

                            <label className="form-group">
                                <span className="form-label">Name</span>
                                <input
                                    className="form-input"
                                    value={createForm.name}
                                    onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                                    placeholder="Starter"
                                />
                            </label>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Status</span>
                                    <select
                                        className="form-input"
                                        value={createForm.status}
                                        onChange={(event) => setCreateForm((current) => ({ ...current, status: event.target.value as PlanStatus }))}
                                    >
                                        <option value="ACTIVE">ACTIVE</option>
                                        <option value="INACTIVE">INACTIVE</option>
                                    </select>
                                </label>

                                <label className="form-group">
                                    <span className="form-label">Monthly price</span>
                                    <input
                                        className="form-input"
                                        type="number"
                                        step="0.01"
                                        min="0"
                                        value={createForm.priceMonthly}
                                        onChange={(event) => setCreateForm((current) => ({ ...current, priceMonthly: event.target.value }))}
                                        placeholder="29"
                                    />
                                </label>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Store/location limit</span>
                                    <input
                                        className="form-input"
                                        type="number"
                                        min="1"
                                        step="1"
                                        value={createForm.maxLocations}
                                        onChange={(event) => setCreateForm((current) => ({ ...current, maxLocations: event.target.value }))}
                                    />
                                </label>

                                <label className="form-group">
                                    <span className="form-label">User limit</span>
                                    <input
                                        className="form-input"
                                        type="number"
                                        min="1"
                                        step="1"
                                        value={createForm.maxUsers}
                                        onChange={(event) => setCreateForm((current) => ({ ...current, maxUsers: event.target.value }))}
                                    />
                                </label>
                            </div>

                            <div className="surface-muted" style={{ padding: '0.85rem', display: 'grid', gap: '0.7rem' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', cursor: 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={createForm.unlimitedCredits}
                                        onChange={(event) =>
                                            setCreateForm((current) => ({
                                                ...current,
                                                unlimitedCredits: event.target.checked,
                                                creditsLimit: event.target.checked ? '' : current.creditsLimit || '1000',
                                            }))
                                        }
                                    />
                                    <span style={{ fontSize: '0.84rem', fontWeight: 650, color: 'var(--text-primary)' }}>
                                        Unlimited credits
                                    </span>
                                </label>

                                <label className="form-group">
                                    <span className="form-label">Credits limit</span>
                                    <input
                                        className="form-input"
                                        type="number"
                                        min="0"
                                        step="1"
                                        value={createForm.creditsLimit}
                                        onChange={(event) => setCreateForm((current) => ({ ...current, creditsLimit: event.target.value }))}
                                        disabled={createForm.unlimitedCredits}
                                        placeholder="1000"
                                    />
                                </label>

                                <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                                    Unlimited plans still track usage for reporting, forecasting, and support escalation.
                                </div>
                            </div>

                            <button className="btn" type="submit" disabled={saving === 'create'}>
                                {saving === 'create' ? 'Creating...' : 'Create Plan'}
                            </button>
                        </form>
                    </article>

                    <article className="surface-card" style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '0.8rem' }}>
                            <div style={{ minWidth: 0 }}>
                                <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Selected plan</h2>
                                <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                    {selectedPlan ? `${selectedPlan.name} · ${selectedPlan.code}` : 'Pick a row in the catalog to edit it.'}
                                </div>
                            </div>
                            {selectedStatusMeta ? (
                                <span className="badge" style={badgeStyle(selectedStatusMeta.color, selectedStatusMeta.bg, selectedStatusMeta.border)}>
                                    {selectedStatusMeta.label}
                                </span>
                            ) : null}
                        </div>

                        {selectedPlan ? (
                            <form onSubmit={(event) => void updatePlan(event)} style={{ display: 'grid', gap: '0.78rem' }}>
                                <label className="form-group">
                                    <span className="form-label">Plan code</span>
                                    <input
                                        className="form-input"
                                        value={editForm.code}
                                        onChange={(event) => setEditForm((current) => ({ ...current, code: event.target.value }))}
                                        autoComplete="off"
                                    />
                                </label>

                                <label className="form-group">
                                    <span className="form-label">Name</span>
                                    <input
                                        className="form-input"
                                        value={editForm.name}
                                        onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))}
                                    />
                                </label>

                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' }}>
                                    <label className="form-group">
                                        <span className="form-label">Status</span>
                                        <select
                                            className="form-input"
                                            value={editForm.status}
                                            onChange={(event) => setEditForm((current) => ({ ...current, status: event.target.value as PlanStatus }))}
                                        >
                                            <option value="ACTIVE">ACTIVE</option>
                                            <option value="INACTIVE">INACTIVE</option>
                                        </select>
                                    </label>

                                    <label className="form-group">
                                        <span className="form-label">Monthly price</span>
                                        <input
                                            className="form-input"
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            value={editForm.priceMonthly}
                                            onChange={(event) => setEditForm((current) => ({ ...current, priceMonthly: event.target.value }))}
                                            placeholder="29"
                                        />
                                    </label>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.75rem' }}>
                                    <label className="form-group">
                                        <span className="form-label">Store/location limit</span>
                                        <input
                                            className="form-input"
                                            type="number"
                                            min="1"
                                            step="1"
                                            value={editForm.maxLocations}
                                            onChange={(event) => setEditForm((current) => ({ ...current, maxLocations: event.target.value }))}
                                        />
                                    </label>

                                    <label className="form-group">
                                        <span className="form-label">User limit</span>
                                        <input
                                            className="form-input"
                                            type="number"
                                            min="1"
                                            step="1"
                                            value={editForm.maxUsers}
                                            onChange={(event) => setEditForm((current) => ({ ...current, maxUsers: event.target.value }))}
                                        />
                                    </label>
                                </div>

                                <div className="surface-muted" style={{ padding: '0.85rem', display: 'grid', gap: '0.7rem' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={editForm.unlimitedCredits}
                                            onChange={(event) =>
                                                setEditForm((current) => ({
                                                    ...current,
                                                    unlimitedCredits: event.target.checked,
                                                    creditsLimit: event.target.checked ? '' : current.creditsLimit || '1000',
                                                }))
                                            }
                                        />
                                        <span style={{ fontSize: '0.84rem', fontWeight: 650, color: 'var(--text-primary)' }}>
                                            Unlimited credits
                                        </span>
                                    </label>

                                    <label className="form-group">
                                        <span className="form-label">Credits limit</span>
                                        <input
                                            className="form-input"
                                            type="number"
                                            min="0"
                                            step="1"
                                            value={editForm.creditsLimit}
                                            onChange={(event) => setEditForm((current) => ({ ...current, creditsLimit: event.target.value }))}
                                            disabled={editForm.unlimitedCredits}
                                            placeholder="1000"
                                        />
                                    </label>

                                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                                        Unlimited plans still track usage for reporting, forecasting, and support escalation.
                                    </div>
                                </div>

                                {selectedPrices ? (
                                    <div
                                        className="surface-muted"
                                        style={{
                                            padding: '0.75rem 0.85rem',
                                            display: 'grid',
                                            gap: '0.45rem',
                                            fontSize: '0.76rem',
                                            color: 'var(--text-muted)',
                                        }}
                                    >
                                        {selectedPrices.map((row) => (
                                            <div key={row.label}>
                                                {row.label}: <strong style={{ color: 'var(--text-primary)' }}>{row.value}</strong>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}

                                <button className="btn" type="submit" disabled={saving === `update:${selectedPlan.id}`}>
                                    {saving === `update:${selectedPlan.id}` ? 'Saving...' : 'Save changes'}
                                </button>

                                <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                    <button
                                        className="btn btn-sm btn-secondary"
                                        type="button"
                                        onClick={() => void refresh(selectedPlan.id)}
                                    >
                                        Reload
                                    </button>
                                    <button
                                        className="btn btn-sm"
                                        style={actionButtonStyle('danger')}
                                        type="button"
                                        disabled={saving === `delete:${selectedPlan.id}`}
                                        onClick={() => void deletePlan(selectedPlan)}
                                    >
                                        {saving === `delete:${selectedPlan.id}` ? 'Deleting...' : 'Delete plan'}
                                    </button>
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
                                No plan selected. Use Edit from the catalog to load a record into the pricing editor.
                            </div>
                        )}
                    </article>
                </div>
            </section>
        </div>
    );
}
