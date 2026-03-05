import { requireRole } from '@/lib/server-auth';

const TENANTS = [
    { name: 'Downtown Bistro', slug: 'downtown-bistro', plan: 'STARTER', status: 'ACTIVE', users: 8, credits: 420, created: 'Feb 10, 2026' },
    { name: 'Harbor View Café', slug: 'harbor-view', plan: 'FREE', status: 'TRIAL', users: 3, credits: 1000, created: 'Mar 1, 2026' },
    { name: 'Mesa Collective', slug: 'mesa-collective', plan: 'ENTERPRISE', status: 'ACTIVE', users: 42, credits: 9999, created: 'Jan 5, 2026' },
];

const PLAN_COLORS: Record<string, { color: string; bg: string }> = {
    FREE: { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' },
    STARTER: { color: '#748ffc', bg: 'rgba(92,124,250,0.15)' },
    GROWTH: { color: '#34d399', bg: 'rgba(16,185,129,0.15)' },
    ENTERPRISE: { color: '#fbbf24', bg: 'rgba(245,158,11,0.15)' },
};

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
    TRIAL: { color: '#fbbf24', bg: 'rgba(245,158,11,0.12)' },
    ACTIVE: { color: '#34d399', bg: 'rgba(16,185,129,0.12)' },
    SUSPENDED: { color: '#fb7185', bg: 'rgba(244,63,94,0.12)' },
    PAST_DUE: { color: '#fb7185', bg: 'rgba(244,63,94,0.12)' },
};

const Pill = ({ label, color, bg }: { label: string; color: string; bg: string }) => (
    <span style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color, background: bg, padding: '2px 8px', borderRadius: 999, border: `1px solid ${color}30` }}>
        {label}
    </span>
);

export default function AdminTenantsPage() {
    requireRole(['SUPER_ADMIN']);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1400 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>Tenants</h1>
                    <p style={{ fontSize: '0.875rem', color: 'rgba(148,163,184,0.6)' }}>{TENANTS.length} organizations registered</p>
                </div>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                            {['Organization', 'Plan', 'Status', 'Users', 'Credits', 'Created', 'Actions'].map(h => (
                                <th key={h} style={{ textAlign: 'left', padding: '0.875rem 1.25rem', fontSize: '0.6875rem', fontWeight: 600, color: 'rgba(148,163,184,0.5)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {TENANTS.map((t, i) => (
                            <tr key={t.slug} style={{ borderBottom: i < TENANTS.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                                <td style={{ padding: '1rem 1.25rem' }}>
                                    <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f1f5f9', marginBottom: '0.125rem' }}>{t.name}</div>
                                    <div style={{ fontSize: '0.6875rem', fontFamily: 'monospace', color: 'rgba(148,163,184,0.4)' }}>{t.slug}</div>
                                </td>
                                <td style={{ padding: '1rem 1.25rem' }}><Pill label={t.plan} {...PLAN_COLORS[t.plan]} /></td>
                                <td style={{ padding: '1rem 1.25rem' }}><Pill label={t.status} {...STATUS_COLORS[t.status]} /></td>
                                <td style={{ padding: '1rem 1.25rem', fontSize: '0.875rem', color: '#e2e8f0', fontWeight: 600 }}>{t.users}</td>
                                <td style={{ padding: '1rem 1.25rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                        <span style={{ fontSize: '0.875rem', color: '#fbbf24', fontWeight: 700 }}>{t.credits.toLocaleString()}</span>
                                        <span style={{ fontSize: '0.6875rem', color: 'rgba(148,163,184,0.4)' }}>credits</span>
                                    </div>
                                </td>
                                <td style={{ padding: '1rem 1.25rem', fontSize: '0.8125rem', color: 'rgba(148,163,184,0.6)' }}>{t.created}</td>
                                <td style={{ padding: '1rem 1.25rem' }}>
                                    <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                                        {[
                                            { label: 'Credits', color: '#fbbf24' },
                                            { label: t.status === 'SUSPENDED' ? 'Activate' : 'Suspend', color: t.status === 'SUSPENDED' ? '#34d399' : '#fb7185' },
                                        ].map(btn => (
                                            <button key={btn.label} style={{
                                                padding: '4px 10px', borderRadius: 6,
                                                background: `${btn.color}15`, border: `1px solid ${btn.color}30`,
                                                fontSize: '0.6875rem', fontWeight: 600, color: btn.color,
                                                cursor: 'pointer', fontFamily: 'Inter, system-ui, sans-serif',
                                            }}>
                                                {btn.label}
                                            </button>
                                        ))}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
