'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchJsonWithSession } from '@/lib/client-api';

type AdminStats = {
    totalTenants: number;
    totalUsers: number;
    activeSessions: number;
    solverQueue: number;
};

type AuditItem = {
    id: string;
    action: string;
    resource: string;
    resourceId: string | null;
    createdAt: string;
    user: {
        id: string;
        name: string;
        email: string;
        role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
    } | null;
};

type HealthItem = {
    label: string;
    status: 'online' | 'degraded' | 'offline' | 'unknown';
    latencyMs: number | null;
    details?: string;
};

type HealthPayload = {
    checkedAt: string;
    overall: 'online' | 'degraded' | 'offline';
    components: HealthItem[];
};

const ROLE_COLORS: Record<string, string> = {
    SUPER_ADMIN: '#cb3653',
    ADMIN: '#2f63ff',
    MANAGER: '#0f8c52',
    STAFF: '#4c5f85',
};

function relativeTime(value: string): string {
    const date = new Date(value);
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function statusColor(status: HealthItem['status']) {
    if (status === 'online') return '#17b26a';
    if (status === 'degraded') return '#f59e0b';
    if (status === 'offline') return '#e74867';
    return '#6f80a4';
}

export default function AdminOverviewPage() {
    const [stats, setStats] = useState<AdminStats | null>(null);
    const [audit, setAudit] = useState<AuditItem[]>([]);
    const [health, setHealth] = useState<HealthPayload | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        Promise.all([
            fetchJsonWithSession<AdminStats>('/admin/stats'),
            fetchJsonWithSession<{ data?: AuditItem[] }>('/admin/audit?limit=20'),
            fetchJsonWithSession<HealthPayload>('/admin/health'),
        ])
            .then(([statsPayload, auditPayload, healthPayload]) => {
                setStats(statsPayload);
                setAudit(Array.isArray(auditPayload.data) ? auditPayload.data : []);
                setHealth(healthPayload);
            })
            .catch((err: Error) => setError(err.message))
            .finally(() => setLoading(false));
    }, []);

    const platformStats = useMemo(
        () => [
            { label: 'Total Tenants', value: stats?.totalTenants ?? '-', delta: 'live orgs', icon: '🏢', color: '#2f63ff', bg: '#edf3ff' },
            { label: 'Total Users', value: stats?.totalUsers ?? '-', delta: 'all accounts', icon: '👥', color: '#17b26a', bg: '#e9fbf1' },
            { label: 'Active Sessions', value: stats?.activeSessions ?? '-', delta: 'right now', icon: '🔗', color: '#f59e0b', bg: '#fff4e2' },
            { label: 'Solver Queue', value: stats?.solverQueue ?? '-', delta: 'pending jobs', icon: '⚙️', color: '#22b8cf', bg: '#e9fafe' },
        ],
        [stats],
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1440 }}>
            <section
                className="surface-card"
                style={{
                    padding: '1rem',
                    background:
                        'radial-gradient(36rem 16rem at 0% 0%, rgba(231,72,103,0.12), transparent 60%), radial-gradient(34rem 17rem at 100% 100%, rgba(79,121,255,0.12), transparent 60%), #ffffff',
                }}
            >
                <div className="workspace-kicker" style={{ color: '#cb3653' }}>
                    Platform health
                </div>
                <h1 className="workspace-title" style={{ fontSize: '1.65rem', marginBottom: 2 }}>
                    System Overview
                </h1>
                <p className="workspace-subtitle">{loading ? 'Loading diagnostics...' : 'Live platform status and operations telemetry.'}</p>
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

            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0.75rem' }}>
                {platformStats.map((card) => (
                    <article key={card.label} className="surface-card" style={{ padding: '0.95rem', background: card.bg }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
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
                                {card.icon}
                            </span>
                        </div>
                        <div style={{ fontSize: '1.9rem', fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>{card.value}</div>
                        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: card.color }}>{card.delta}</div>
                    </article>
                ))}
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 0.8fr)', gap: '0.85rem' }}>
                <article className="surface-card" style={{ padding: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
                        <h2 style={{ fontSize: '1rem', fontWeight: 760, color: 'var(--text-primary)' }}>Recent Audit Log</h2>
                        <span className="badge" style={{ background: '#edf3ff', borderColor: '#c9d9ff', color: '#2f63ff' }}>
                            Last 20 events
                        </span>
                    </div>

                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                    {['Time', 'Action', 'Actor', 'Role'].map((h) => (
                                        <th
                                            key={h}
                                            style={{
                                                textAlign: 'left',
                                                fontSize: '0.66rem',
                                                fontWeight: 700,
                                                color: 'var(--text-muted)',
                                                letterSpacing: '0.08em',
                                                textTransform: 'uppercase',
                                                padding: '0.58rem 0.3rem',
                                            }}
                                        >
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {audit.map((row, idx) => {
                                    const actor = row.user?.email ?? 'system';
                                    const role = row.user?.role ?? 'SYSTEM';
                                    const roleColor = ROLE_COLORS[role] ?? '#4c5f85';
                                    return (
                                        <tr key={row.id} style={{ background: idx % 2 === 0 ? '#fbfcff' : 'transparent' }}>
                                            <td style={{ padding: '0.62rem 0.3rem', fontSize: '0.76rem', color: 'var(--text-muted)' }}>{relativeTime(row.createdAt)}</td>
                                            <td style={{ padding: '0.62rem 0.3rem', fontSize: '0.83rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                                                {row.action} · {row.resource}
                                            </td>
                                            <td
                                                style={{
                                                    padding: '0.62rem 0.3rem',
                                                    fontSize: '0.75rem',
                                                    color: 'var(--text-secondary)',
                                                    fontFamily: 'var(--font-mono)',
                                                }}
                                            >
                                                {actor}
                                            </td>
                                            <td style={{ padding: '0.62rem 0.3rem' }}>
                                                <span
                                                    className="badge"
                                                    style={{
                                                        fontSize: '0.6rem',
                                                        textTransform: 'uppercase',
                                                        letterSpacing: '0.06em',
                                                        color: roleColor,
                                                        background: `${roleColor}18`,
                                                        borderColor: `${roleColor}44`,
                                                    }}
                                                >
                                                    {role}
                                                </span>
                                            </td>
                                        </tr>
                                    );
                                })}

                                {!loading && audit.length === 0 ? (
                                    <tr>
                                        <td colSpan={4} style={{ padding: '0.85rem 0.3rem', fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                                            No audit records found.
                                        </td>
                                    </tr>
                                ) : null}
                            </tbody>
                        </table>
                    </div>
                </article>

                <article className="surface-card" style={{ padding: '1rem' }}>
                    <h2 style={{ fontSize: '1rem', fontWeight: 760, color: 'var(--text-primary)', marginBottom: '0.8rem' }}>System Health</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.66rem' }}>
                        {(health?.components ?? []).map((svc) => (
                            <div key={svc.label} className="surface-muted" style={{ padding: '0.65rem 0.7rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.6rem' }}>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.42rem' }}>
                                            <span className="status-dot" style={{ background: statusColor(svc.status) }} />
                                            <span style={{ fontSize: '0.86rem', color: 'var(--text-primary)', fontWeight: 650 }}>{svc.label}</span>
                                        </div>
                                        <div
                                            style={{
                                                fontSize: '0.72rem',
                                                color: 'var(--text-muted)',
                                                marginTop: 2,
                                                whiteSpace: 'nowrap',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                            }}
                                        >
                                            {svc.details ?? 'No details'}
                                        </div>
                                    </div>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: statusColor(svc.status) }}>
                                            {svc.status}
                                        </div>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{svc.latencyMs === null ? '-' : `${svc.latencyMs}ms`}</div>
                                    </div>
                                </div>
                            </div>
                        ))}

                        {!loading && !health?.components?.length ? (
                            <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>No health checks available.</div>
                        ) : null}
                    </div>
                </article>
            </section>
        </div>
    );
}
