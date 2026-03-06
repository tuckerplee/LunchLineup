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
    SUPER_ADMIN: '#fb7185',
    ADMIN: '#748ffc',
    MANAGER: '#34d399',
    STAFF: '#94a3b8',
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
            { label: 'Total Tenants', value: stats?.totalTenants ?? '—', delta: 'live', icon: '🏢', color: '#748ffc' },
            { label: 'Total Users', value: stats?.totalUsers ?? '—', delta: 'live', icon: '👥', color: '#34d399' },
            { label: 'Active Sessions', value: stats?.activeSessions ?? '—', delta: 'right now', icon: '🔗', color: '#fbbf24' },
            { label: 'Solver Queue', value: stats?.solverQueue ?? '—', delta: 'jobs pending', icon: '⚙️', color: '#94a3b8' },
        ],
        [stats],
    );

    const statusColor = (s: string) => (
        s === 'online'
            ? '#34d399'
            : s === 'degraded'
                ? '#fbbf24'
                : s === 'offline'
                    ? '#f43f5e'
                    : '#94a3b8'
    );

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1400 }}>
            <div>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>
                    System Overview
                </h1>
                <p style={{ fontSize: '0.875rem', color: 'rgba(148,163,184,0.7)' }}>
                    {loading ? 'Loading...' : 'Live platform status'}
                </p>
            </div>

            {error ? (
                <div style={{ padding: '0.85rem 1rem', borderRadius: 10, border: '1px solid rgba(244,63,94,0.35)', color: '#fda4af' }}>
                    {error}
                </div>
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                {platformStats.map((s, i) => (
                    <div key={i} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '1.25rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                            <span style={{ fontSize: '0.8125rem', color: 'rgba(148,163,184,0.7)', fontWeight: 500 }}>{s.label}</span>
                            <div style={{ width: 34, height: 34, borderRadius: 8, fontSize: '0.875rem', background: `${s.color}18`, border: `1px solid ${s.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{s.icon}</div>
                        </div>
                        <div style={{ fontSize: '2rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.03em' }}>{s.value}</div>
                        <div style={{ fontSize: '0.75rem', color: 'rgba(148,163,184,0.5)', marginTop: '0.25rem' }}>{s.delta}</div>
                    </div>
                ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '1.25rem' }}>
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '1.5rem' }}>
                    <h2 style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f1f5f9', marginBottom: '1.25rem' }}>Recent Audit Log</h2>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr>
                                {['Time', 'Action', 'Actor', 'Role'].map(h => (
                                    <th key={h} style={{ textAlign: 'left', fontSize: '0.6875rem', fontWeight: 600, color: 'rgba(148,163,184,0.5)', letterSpacing: '0.06em', textTransform: 'uppercase', paddingBottom: '0.75rem', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {audit.map((row) => {
                                const actor = row.user?.email ?? 'system';
                                const role = row.user?.role ?? 'SYSTEM';
                                const roleColor = ROLE_COLORS[role] ?? '#94a3b8';
                                return (
                                    <tr key={row.id}>
                                        <td style={{ padding: '0.75rem 0', fontSize: '0.75rem', color: 'rgba(148,163,184,0.5)', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingRight: '1rem', whiteSpace: 'nowrap' }}>{relativeTime(row.createdAt)}</td>
                                        <td style={{ padding: '0.75rem 0', fontSize: '0.8125rem', color: '#e2e8f0', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingRight: '1rem' }}>{row.action} · {row.resource}</td>
                                        <td style={{ padding: '0.75rem 0', fontSize: '0.75rem', color: 'rgba(148,163,184,0.6)', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', paddingRight: '1rem' }}>{actor}</td>
                                        <td style={{ padding: '0.75rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                            <span style={{ fontSize: '0.5625rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: roleColor, background: `${roleColor}20`, padding: '2px 7px', borderRadius: 999 }}>
                                                {role}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                            {!loading && audit.length === 0 ? (
                                <tr>
                                    <td colSpan={4} style={{ padding: '0.9rem 0', fontSize: '0.85rem', color: 'rgba(148,163,184,0.7)' }}>
                                        No audit records found.
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                </div>

                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '1.5rem' }}>
                    <h2 style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f1f5f9', marginBottom: '1.25rem' }}>System Health</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {(health?.components ?? []).map((svc, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', minWidth: 0 }}>
                                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(svc.status), flexShrink: 0 }} />
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontSize: '0.875rem', color: '#e2e8f0' }}>{svc.label}</div>
                                        <div style={{ fontSize: '0.6875rem', color: 'rgba(148,163,184,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {svc.details ?? 'No details'}
                                        </div>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginLeft: '0.75rem' }}>
                                    <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: statusColor(svc.status), textTransform: 'uppercase', letterSpacing: '0.04em' }}>{svc.status}</span>
                                    <span style={{ fontSize: '0.625rem', color: 'rgba(148,163,184,0.55)' }}>
                                        {svc.latencyMs === null ? '—' : `${svc.latencyMs}ms`}
                                    </span>
                                </div>
                            </div>
                        ))}
                        {!loading && !health?.components?.length ? (
                            <div style={{ fontSize: '0.8125rem', color: 'rgba(148,163,184,0.65)' }}>No health checks available.</div>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
