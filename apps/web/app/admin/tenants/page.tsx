import { requireRole } from '@/lib/server-auth';

const TENANTS = [
    { name: 'Downtown Bistro', slug: 'downtown-bistro', plan: 'STARTER', status: 'ACTIVE', users: 8, credits: 420, created: 'Feb 10, 2026' },
    { name: 'Harbor View Cafe', slug: 'harbor-view', plan: 'FREE', status: 'TRIAL', users: 3, credits: 1000, created: 'Mar 1, 2026' },
    { name: 'Mesa Collective', slug: 'mesa-collective', plan: 'ENTERPRISE', status: 'ACTIVE', users: 42, credits: 9999, created: 'Jan 5, 2026' },
];

const PLAN_COLORS: Record<string, { color: string; bg: string; border: string }> = {
    FREE: { color: '#4c5f85', bg: '#eef2f9', border: '#d3ddeb' },
    STARTER: { color: '#2f63ff', bg: '#edf3ff', border: '#c9d9ff' },
    GROWTH: { color: '#0f8c52', bg: '#e9fbf1', border: '#bdeed4' },
    ENTERPRISE: { color: '#cc7f06', bg: '#fff4e2', border: '#ffe1a6' },
};

const STATUS_COLORS: Record<string, { color: string; bg: string; border: string }> = {
    TRIAL: { color: '#cc7f06', bg: '#fff4e2', border: '#ffe1a6' },
    ACTIVE: { color: '#0f8c52', bg: '#e9fbf1', border: '#bdeed4' },
    SUSPENDED: { color: '#cb3653', bg: '#ffeef2', border: '#ffd0da' },
    PAST_DUE: { color: '#cb3653', bg: '#ffeef2', border: '#ffd0da' },
};

const Pill = ({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) => (
    <span
        className="badge"
        style={{
            fontSize: '0.62rem',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color,
            background: bg,
            borderColor: border,
        }}
    >
        {label}
    </span>
);

export default function AdminTenantsPage() {
    requireRole(['SUPER_ADMIN']);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1440 }}>
            <section className="surface-card" style={{ padding: '1rem' }}>
                <div className="workspace-kicker" style={{ color: '#cb3653' }}>
                    Organization control
                </div>
                <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
                    Tenants
                </h1>
                <p className="workspace-subtitle">{TENANTS.length} organizations registered across the platform</p>
            </section>

            <section className="surface-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                    <thead>
                        <tr style={{ background: '#f8faff', borderBottom: '1px solid var(--border)' }}>
                            {['Organization', 'Plan', 'Status', 'Users', 'Credits', 'Created', 'Actions'].map((h) => (
                                <th
                                    key={h}
                                    style={{
                                        textAlign: 'left',
                                        padding: '0.8rem 1rem',
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
                        {TENANTS.map((tenant, i) => (
                            <tr key={tenant.slug} style={{ borderBottom: i < TENANTS.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                <td style={{ padding: '0.9rem 1rem' }}>
                                    <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)', marginBottom: 2 }}>{tenant.name}</div>
                                    <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{tenant.slug}</div>
                                </td>
                                <td style={{ padding: '0.9rem 1rem' }}>
                                    <Pill label={tenant.plan} {...PLAN_COLORS[tenant.plan]} />
                                </td>
                                <td style={{ padding: '0.9rem 1rem' }}>
                                    <Pill label={tenant.status} {...STATUS_COLORS[tenant.status]} />
                                </td>
                                <td style={{ padding: '0.9rem 1rem', fontSize: '0.86rem', color: 'var(--text-primary)', fontWeight: 700 }}>{tenant.users}</td>
                                <td style={{ padding: '0.9rem 1rem' }}>
                                    <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.35rem' }}>
                                        <span style={{ fontSize: '0.88rem', color: '#cc7f06', fontWeight: 800 }}>{tenant.credits.toLocaleString()}</span>
                                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>credits</span>
                                    </div>
                                </td>
                                <td style={{ padding: '0.9rem 1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{tenant.created}</td>
                                <td style={{ padding: '0.9rem 1rem' }}>
                                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                        <button className="btn btn-sm btn-secondary">Credits</button>
                                        <button
                                            className="btn btn-sm"
                                            style={{
                                                background: tenant.status === 'SUSPENDED' ? '#e9fbf1' : '#ffeef2',
                                                color: tenant.status === 'SUSPENDED' ? '#0f8c52' : '#cb3653',
                                                borderColor: tenant.status === 'SUSPENDED' ? '#bdeed4' : '#ffd0da',
                                            }}
                                        >
                                            {tenant.status === 'SUSPENDED' ? 'Activate' : 'Suspend'}
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
