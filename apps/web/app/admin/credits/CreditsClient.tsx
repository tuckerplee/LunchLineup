'use client';

import type { FormEvent } from 'react';
import styles from './credits.module.css';
import { creditGrantConfirmation, estimateCreditGrant, isCreditBalanceValue } from './credit-grant-estimate';
import { createCreditReadOwner, type CreditReadLane, type CreditReadPending } from './credit-read-owner';
import { parseCreditGrantAcknowledgement, type CreditGrantAcknowledgement } from './credit-grant-acknowledgement';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJsonWithSession, fetchWithSession, withIdempotencyKey } from '@/lib/client-api';
import {
    EMPTY_ADMIN_LIST_PAGINATION,
    buildAdminListPath,
    mergeAdminListPage,
    parseAdminListPagination,
} from '../admin-list-pagination';
import {
    createCreditGrantSubmissionState,
    submitCreditGrant,
    type CreditGrantPayload,
} from './credit-grant-submission';

type CreditTenant = {
    id: string;
    name: string;
    slug: string;
    planTier: string;
    usageCredits: number;
    creditDebt: number;
};

type CreditHistoryRow = {
    id: string;
    amount: number;
    reason: string;
    createdAt: string;
    tenant: Pick<CreditTenant, 'id' | 'name' | 'slug'> | null;
};

type CreditsPayload = {
    tenants?: CreditTenant[];
    history?: CreditHistoryRow[];
    tenantPagination?: unknown;
    historyPagination?: unknown;
};

type CreditGrantForm = {
    tenantId: string;
    amount: string;
    reason: string;
};

const PLAN_COLORS: Record<string, { color: string; bg: string; border: string }> = {
    FREE: { color: '#4c5f85', bg: '#eef2f9', border: '#d3ddeb' },
    STARTER: { color: '#1d4ed8', bg: '#edf3ff', border: '#c9d9ff' },
    GROWTH: { color: '#166534', bg: '#e9fbf1', border: '#bdeed4' },
    ENTERPRISE: { color: '#7c4a03', bg: '#fff4e2', border: '#ffe1a6' },
};

const HISTORY_META = {
    positive: { label: 'Grant', color: '#166534', bg: '#e9fbf1', border: '#bdeed4' },
    negative: { label: 'Debit', color: '#b4233f', bg: '#ffeef2', border: '#ffd0da' },
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

function jsonWriteInit(
    method: 'POST' | 'PUT' | 'DELETE',
    payload: unknown,
    idempotencyKey: string,
): RequestInit {
    return withIdempotencyKey({
        method,
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...getCsrfHeaders(),
        },
        body: JSON.stringify(payload),
    }, idempotencyKey);
}

async function writeJson(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    payload: unknown,
    idempotencyKey: string,
): Promise<CreditGrantAcknowledgement> {
    const response = await fetchWithSession(path, jsonWriteInit(method, payload, idempotencyKey));
    const responsePayload = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) {
        const message = typeof (responsePayload as { message?: unknown }).message === 'string'
            ? String((responsePayload as { message: string }).message)
            : `Request failed (${response.status})`;
        throw new Error(message);
    }
    return parseCreditGrantAcknowledgement(response.status, responsePayload);
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
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
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

function parseCreditsPayload(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
        return {
            tenants: [] as CreditTenant[],
            history: [] as CreditHistoryRow[],
            tenantPagination: EMPTY_ADMIN_LIST_PAGINATION,
            historyPagination: EMPTY_ADMIN_LIST_PAGINATION,
        };
    }

    const typed = payload as CreditsPayload;
    return {
        tenants: Array.isArray(typed.tenants) ? typed.tenants : [],
        history: Array.isArray(typed.history) ? typed.history : [],
        tenantPagination: parseAdminListPagination(typed.tenantPagination),
        historyPagination: parseAdminListPagination(typed.historyPagination),
    };
}

function parseAmount(value: string): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
}

export function CreditsClient() {
    const [tenants, setTenants] = useState<CreditTenant[]>([]);
    const [history, setHistory] = useState<CreditHistoryRow[]>([]);
    const [readPending, setReadPending] = useState<CreditReadPending>({ replacement: true, tenants: false, history: false, ready: false });
    const [readErrors, setReadErrors] = useState<Record<CreditReadLane, string | null>>({ replacement: null, tenants: null, history: null });
    const [grantSaving, setGrantSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [tenantPagination, setTenantPagination] = useState(EMPTY_ADMIN_LIST_PAGINATION);
    const [historyPagination, setHistoryPagination] = useState(EMPTY_ADMIN_LIST_PAGINATION);
    const [form, setForm] = useState<CreditGrantForm>({ tenantId: '', amount: '', reason: '' });
    const grantSubmission = useRef(createCreditGrantSubmissionState());
    const readOwner = useRef(createCreditReadOwner());
    const loading = readPending.replacement;
    const visibleError = error ?? readErrors.replacement ?? readErrors.tenants ?? readErrors.history;

    const loadCredits = useCallback(async (options: {
        tenantCursor?: string | null;
        historyCursor?: string | null;
        appendTenants?: boolean;
        appendHistory?: boolean;
        search?: string;
    } = {}) => {
        const owner = readOwner.current;
        const ticket = options.appendTenants
            ? owner.beginAppend('tenants', options.tenantCursor)
            : options.appendHistory
                ? owner.beginAppend('history', options.historyCursor)
                : owner.beginReplacement(options.search);
        if (!ticket) return;
        const publishPending = () => setReadPending((current) => owner.isActiveVisit(ticket.visit) ? owner.snapshot() : current);
        publishPending();
        setReadErrors((current) => {
            if (!owner.owns(ticket)) return current;
            return ticket.lane === 'replacement'
                ? { replacement: null, tenants: null, history: null }
                : { ...current, [ticket.lane]: null };
        });
        try {
            const path = buildAdminListPath('/admin/credits', {
                tenantLimit: 50,
                tenantCursor: ticket.lane === 'tenants' ? ticket.cursor : undefined,
                q: ticket.query,
                historyLimit: 50,
                historyCursor: ticket.lane === 'history' ? ticket.cursor : undefined,
            });
            const next = parseCreditsPayload(await fetchJsonWithSession<unknown>(path));
            if (!owner.accept(ticket, {
                tenants: next.tenantPagination.hasMore ? next.tenantPagination.nextCursor : null,
                history: next.historyPagination.hasMore ? next.historyPagination.nextCursor : null,
            })) return;
            if (ticket.lane === 'tenants') {
                setTenants((current) => owner.canPublish(ticket) ? mergeAdminListPage(current, next.tenants, true) : current);
                setTenantPagination((current) => owner.canPublish(ticket) ? next.tenantPagination : current);
            } else if (ticket.lane === 'history') {
                setHistory((current) => owner.canPublish(ticket) ? mergeAdminListPage(current, next.history, true) : current);
                setHistoryPagination((current) => owner.canPublish(ticket) ? next.historyPagination : current);
            } else {
                setTenants((current) => owner.canPublish(ticket) ? next.tenants : current);
                setHistory((current) => owner.canPublish(ticket) ? next.history : current);
                setTenantPagination((current) => owner.canPublish(ticket) ? next.tenantPagination : current);
                setHistoryPagination((current) => owner.canPublish(ticket) ? next.historyPagination : current);
                setForm((current) => owner.canPublish(ticket) ? ({
                    ...current,
                    tenantId: next.tenants.some((tenant) => tenant.id === current.tenantId)
                        ? current.tenantId
                        : next.tenants[0]?.id ?? '',
                }) : current);
            }
        } catch (err) {
            if (owner.owns(ticket)) setReadErrors((current) => owner.owns(ticket)
                ? { ...current, [ticket.lane]: err instanceof Error ? err.message : 'Failed to load credit balances' }
                : current);
        } finally {
            if (owner.finish(ticket)) publishPending();
        }
    }, []);

    useEffect(() => {
        const owner = readOwner.current;
        owner.activate();
        void loadCredits();
        return () => owner.deactivate();
    }, [loadCredits]);

    const visibleTenants = useMemo(
        () => [...tenants].sort((a, b) => b.usageCredits - a.usageCredits),
        [tenants],
    );

    const sortedHistory = useMemo(() => {
        return [...history].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [history]);

    const summary = useMemo(() => {
        const totalCredits = tenants.reduce((sum, tenant) => sum + tenant.usageCredits, 0);
        const historyCount = history.length;
        const positiveCount = history.filter((row) => row.amount > 0).length;
        const maxBalance = tenants.length > 0 ? Math.max(...tenants.map((tenant) => tenant.usageCredits)) : 0;

        return [
            { value: tenants.length, subtitle: 'Loaded balances', icon: 'T', color: '#1d4ed8', bg: '#edf3ff' },
            { value: formatCredits(totalCredits), subtitle: 'Loaded credits', icon: 'C', color: '#166534', bg: '#e9fbf1' },
            { value: historyCount, subtitle: 'Loaded ledger rows', icon: 'L', color: '#b4233f', bg: '#ffeef2' },
            { value: formatCredits(maxBalance), subtitle: 'Largest loaded balance', icon: 'M', color: '#7c4a03', bg: '#fff4e2' },
            { value: positiveCount, subtitle: 'positive wallet rows loaded', icon: '+', color: '#166534', bg: '#e9fbf1' },
        ];
    }, [history, tenants]);

    const selectedTenant = useMemo(
        () => tenants.find((tenant) => tenant.id === form.tenantId) ?? null,
        [form.tenantId, tenants],
    );
    const parsedAmount = parseAmount(form.amount);
    const grantEstimate = selectedTenant
        ? estimateCreditGrant(selectedTenant.usageCredits, selectedTenant.creditDebt, parsedAmount)
        : null;

    function applySearch(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        void loadCredits({ search: query.trim() });
    }

    async function grantCredits(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (grantSubmission.current.inFlight) return;
        setError(null);
        setNotice(null);

        if (!form.tenantId) {
            setError('Select a tenant before granting credits.');
            return;
        }

        const amount = parseAmount(form.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            setError('Amount must be a positive integer.');
            return;
        }

        const reason = form.reason.trim();
        if (!reason) {
            setError('Reason is required.');
            return;
        }

        const selected = tenants.find((tenant) => tenant.id === form.tenantId) ?? null;
        if (!selected) {
            setError('Select a valid tenant before granting credits.');
            return;
        }

        const confirmed = window.confirm(
            creditGrantConfirmation(selected.name, amount,
                estimateCreditGrant(selected.usageCredits, selected.creditDebt, amount)),
        );
        if (!confirmed) return;

        const payload: CreditGrantPayload = {
            tenantId: selected.id,
            amount,
            reason,
        };
        const owner = readOwner.current;
        const visit = owner.visit();
        setGrantSaving(true);
        try {
            const result = await submitCreditGrant(
                grantSubmission.current,
                payload,
                (requestPayload, idempotencyKey) => writeJson(
                    '/admin/credits/grant',
                    'POST',
                    requestPayload,
                    idempotencyKey,
                ),
            );
            if (!result.submitted || !owner.isActiveVisit(visit)) return;
            setNotice((current) => owner.isActiveVisit(visit) ? 'Credits granted.' : current);
            // Read the synchronously applied current query, not this submit's
            // captured render scope. A newer search may have completed meanwhile.
            await loadCredits();
        } catch (err) {
            if (owner.isActiveVisit(visit)) setError((current) => owner.isActiveVisit(visit)
                ? err instanceof Error ? err.message : 'Failed to grant credits'
                : current);
        } finally {
            if (owner.isActiveVisit(visit)) setGrantSaving((current) => owner.isActiveVisit(visit) ? false : current);
        }
    }

    return (
        <div className={styles.workspace} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1440 }}>
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
                        <div className="workspace-kicker" style={{ color: '#b4233f' }}>
                            Billing controls
                        </div>
                        <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
                            Credits
                        </h1>
                        <p className="workspace-subtitle">
                            Live tenant balances and ledger data - {loading ? 'Loading...' : tenants.length + ' balances loaded' + ((tenantPagination.hasMore || historyPagination.hasMore) ? ' - more available' : '')}
                        </p>
                    </div>

                    <form onSubmit={applySearch} className={styles.tenantSearch} style={{ flex: '1 1 360px', display: 'flex', gap: '0.45rem', alignItems: 'flex-end' }}>
                        <label className="form-group" style={{ flex: 1 }}>
                            <span className="form-label">Tenant search</span>
                            <input
                                className="form-input"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Search by tenant name or slug"
                                maxLength={100}
                            />
                        </label>
                        <button className="btn btn-sm btn-secondary" type="submit">
                            Search
                        </button>
                    </form>
                </div>
            </section>

            <section className={styles.summaryGrid} aria-label="Loaded credit summary">
                {summary.map((item) => (
                    <article key={item.subtitle} className={`surface-card ${styles.summaryCard}`} style={{ background: item.bg }}>
                        <div className={styles.summaryHeading}>
                            <span className={styles.summaryLabel}>{item.subtitle}</span>
                            <span
                                className={styles.summaryIcon}
                                aria-hidden="true"
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
                        <div className={styles.summaryValue}>{item.value}</div>
                    </article>
                ))}
            </section>

            {visibleError ? (
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
                    {visibleError}
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

            <section className={styles.balanceGrantGrid}>
                <article
                    className="surface-card"
                    aria-label="Tenant credit balances table"
                    tabIndex={0}
                    style={{ overflowX: 'auto' }}
                >
                    <div style={{ padding: '0.95rem 1rem 0.55rem', display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                        <div>
                            <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Tenant Balances</h2>
                            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                Spendable balances shown below.
                            </div>
                        </div>

                        <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => void loadCredits()}
                            disabled={readPending.replacement}
                            type="button"
                        >
                            {readPending.replacement ? 'Refreshing...' : 'Refresh'}
                        </button>
                    </div>

                    <table className={styles.balanceTable} role="table">
                        <thead role="rowgroup">
                            <tr role="row" style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: '#f8faff' }}>
                                {['Tenant', 'Plan', 'Balance', 'Actions'].map((header) => (
                                    <th
                                        role="columnheader"
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
                        <tbody role="rowgroup">
                            {visibleTenants.map((tenant, index) => {
                                const planStyle = PLAN_COLORS[tenant.planTier] ?? PLAN_COLORS.FREE;
                                return (
                                    <tr
                                        role="row"
                                        key={tenant.id}
                                        style={{
                                            borderBottom: index < visibleTenants.length - 1 ? '1px solid var(--border)' : 'none',
                                        }}
                                    >
                                        <td role="cell" style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)', marginBottom: 2 }}>{tenant.name}</div>
                                            <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{tenant.slug}</div>
                                        </td>
                                        <td role="cell" style={{ padding: '0.9rem 1rem' }}>
                                            <span className="badge" style={badgeStyle(planStyle.color, planStyle.bg, planStyle.border)}>
                                                {tenant.planTier}
                                            </span>
                                        </td>
                                        <td role="cell" style={{ padding: '0.9rem 1rem' }}>
                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}>
                                                <span style={{ fontSize: '1.2rem', fontWeight: 800, color: '#7c4a03', letterSpacing: 0 }}>
                                                    {formatCredits(tenant.usageCredits)}
                                                </span>
                                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>credits</span>
                                            </div>
                                        </td>
                                        <td role="cell" style={{ padding: '0.9rem 1rem' }}>
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

                            {!loading && visibleTenants.length === 0 ? (
                                <tr role="row">
                                    <td role="cell" colSpan={4} style={{ padding: '1rem', fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                                        No tenant balances match the current filter.
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                    {tenantPagination.hasMore ? (
                        <div style={{ padding: '0.8rem 1rem', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'center' }}>
                            <button
                                className="btn btn-sm btn-secondary"
                                type="button"
                                disabled={!readPending.ready || readPending.replacement || readPending.tenants || !tenantPagination.nextCursor}
                                onClick={() => void loadCredits({
                                    tenantCursor: tenantPagination.nextCursor,
                                    appendTenants: true,
                                })}
                            >
                                {readPending.tenants ? 'Loading...' : 'Load more tenant balances'}
                            </button>
                        </div>
                    ) : null}
                </article>

                <article className={`surface-card ${styles.grantPanel}`} style={{ padding: '1rem' }}>
                    <div className={styles.grantHeader} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '0.8rem' }}>
                        <div>
                            <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Grant Credits</h2>
                            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                                Repays outstanding debt first, then adds remaining credits to the spendable balance.
                            </div>
                        </div>
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
                                        {tenant.name} - {tenant.slug}
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
                                Loaded spendable balance: <strong style={{ color: 'var(--text-primary)' }}>{selectedTenant && isCreditBalanceValue(selectedTenant.usageCredits) ? formatCredits(selectedTenant.usageCredits) : '-'}</strong>
                            </div>
                            <div>
                                Loaded outstanding debt: <strong style={{ color: 'var(--text-primary)' }}>{selectedTenant && isCreditBalanceValue(selectedTenant.creditDebt) ? formatCredits(selectedTenant.creditDebt) : 'Unavailable'}</strong>
                            </div>
                            <div>
                                Estimated debt repayment: <strong style={{ color: 'var(--text-primary)' }}>{grantEstimate ? formatCredits(grantEstimate.repaidDebt) : '-'}</strong>
                            </div>
                            <div>
                                Estimated spendable balance: <strong style={{ color: 'var(--text-primary)' }}>{grantEstimate ? formatCredits(grantEstimate.newBalance) : '-'}</strong>
                            </div>
                            <div>
                                Estimated remaining debt: <strong style={{ color: 'var(--text-primary)' }}>{grantEstimate ? formatCredits(grantEstimate.debtAfter) : '-'}</strong>
                            </div>
                            <div>Estimates use loaded balances. Actual grants repay current outstanding debt first.</div>
                            {selectedTenant && (!isCreditBalanceValue(selectedTenant.creditDebt) || !isCreditBalanceValue(selectedTenant.usageCredits)) ? (
                                <div>Balance details are unavailable. Refresh balances to show an estimate. You can still grant credits; the server settles debt first.</div>
                            ) : null}
                        </div>

                        <button className="btn" type="submit" disabled={grantSaving || tenants.length === 0}>
                            {grantSaving ? 'Granting...' : 'Grant Credits'}
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

            <article
                className="surface-card"
                aria-label="Credit transaction history table"
                tabIndex={0}
                style={{ overflowX: 'auto' }}
            >
                <div style={{ padding: '0.95rem 1rem 0.55rem' }}>
                    <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Transaction History</h2>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
                        Spendable balance changes and reasons.
                    </div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                    <thead>
                        <tr style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: '#f8faff' }}>
                            {['Time', 'Tenant', 'Spendable change', 'Reason'].map((header) => (
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
                {historyPagination.hasMore ? (
                    <div style={{ padding: '0.8rem 1rem', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'center' }}>
                        <button
                            className="btn btn-sm btn-secondary"
                            type="button"
                            disabled={!readPending.ready || readPending.replacement || readPending.history || !historyPagination.nextCursor}
                            onClick={() => void loadCredits({
                                historyCursor: historyPagination.nextCursor,
                                appendHistory: true,
                            })}
                        >
                            {readPending.history ? 'Loading...' : 'Load more ledger history'}
                        </button>
                    </div>
                ) : null}
            </article>
        </div>
    );
}
