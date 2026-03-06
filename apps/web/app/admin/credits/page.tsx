import { requireRole } from '@/lib/server-auth';

const TENANTS_WITH_CREDITS = [
    { name: 'Downtown Bistro', slug: 'downtown-bistro', credits: 420, plan: 'STARTER' },
    { name: 'Harbor View Cafe', slug: 'harbor-view', credits: 1000, plan: 'FREE' },
    { name: 'Mesa Collective', slug: 'mesa-collective', credits: 9999, plan: 'ENTERPRISE' },
];

const CREDIT_HISTORY = [
    { tenant: 'Harbor View Cafe', amount: +1000, reason: 'Beta signup bonus', date: 'Mar 1, 2026', actor: 'system' },
    { tenant: 'Downtown Bistro', amount: +500, reason: 'Early adopter grant', date: 'Feb 10, 2026', actor: 'system' },
    { tenant: 'Downtown Bistro', amount: -80, reason: 'Schedule auto-generation x 8', date: 'Feb 28, 2026', actor: 'engine' },
    { tenant: 'Mesa Collective', amount: +9999, reason: 'Enterprise unlimited package', date: 'Jan 5, 2026', actor: 'system' },
];

export default function AdminCreditsPage() {
    requireRole(['SUPER_ADMIN']);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1440 }}>
            <section className="surface-card" style={{ padding: '1rem' }}>
                <div className="workspace-kicker" style={{ color: '#cb3653' }}>
                    Billing controls
                </div>
                <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
                    Credits
                </h1>
                <p className="workspace-subtitle">Grant and review usage credits per tenant</p>
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 0.85fr)', gap: '0.85rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                    <article className="surface-card" style={{ padding: '0.95rem' }}>
                        <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)', marginBottom: '0.75rem' }}>Tenant Balances</h2>
                        <div style={{ display: 'grid', gap: '0.55rem' }}>
                            {TENANTS_WITH_CREDITS.map((tenant) => (
                                <div
                                    key={tenant.slug}
                                    className="surface-muted"
                                    style={{
                                        padding: '0.72rem 0.78rem',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        gap: '0.85rem',
                                    }}
                                >
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)' }}>{tenant.name}</div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
                                            {tenant.slug} · {tenant.plan}
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#cc7f06', letterSpacing: '-0.02em' }}>
                                                {tenant.credits.toLocaleString()}
                                            </div>
                                            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>credits</div>
                                        </div>
                                        <button
                                            className="btn btn-sm"
                                            style={{ background: '#fff4e2', color: '#cc7f06', borderColor: '#ffe1a6' }}
                                        >
                                            + Grant
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </article>

                    <article className="surface-card" style={{ overflowX: 'auto' }}>
                        <div style={{ padding: '0.95rem 1rem 0.55rem' }}>
                            <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)' }}>Transaction History</h2>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                            <thead>
                                <tr style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: '#f8faff' }}>
                                    {['Tenant', 'Amount', 'Reason', 'Date', 'By'].map((h) => (
                                        <th
                                            key={h}
                                            style={{
                                                textAlign: 'left',
                                                padding: '0.7rem 1rem',
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
                                {CREDIT_HISTORY.map((row, i) => (
                                    <tr key={`${row.tenant}-${row.date}-${i}`} style={{ borderBottom: i < CREDIT_HISTORY.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                        <td style={{ padding: '0.76rem 1rem', fontSize: '0.84rem', color: 'var(--text-primary)', fontWeight: 600 }}>{row.tenant}</td>
                                        <td style={{ padding: '0.76rem 1rem', fontWeight: 800, fontSize: '0.85rem', color: row.amount > 0 ? '#0f8c52' : '#cb3653' }}>
                                            {row.amount > 0 ? '+' : ''}
                                            {row.amount.toLocaleString()}
                                        </td>
                                        <td style={{ padding: '0.76rem 1rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{row.reason}</td>
                                        <td style={{ padding: '0.76rem 1rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{row.date}</td>
                                        <td style={{ padding: '0.76rem 1rem', fontSize: '0.74rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{row.actor}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </article>
                </div>

                <article className="surface-card" style={{ padding: '1rem', height: 'fit-content' }}>
                    <h2 style={{ fontSize: '0.98rem', fontWeight: 760, color: 'var(--text-primary)', marginBottom: '0.8rem' }}>Grant Credits</h2>
                    <div style={{ display: 'grid', gap: '0.78rem' }}>
                        <label className="form-group">
                            <span className="form-label">Tenant</span>
                            <select className="form-input">
                                {TENANTS_WITH_CREDITS.map((tenant) => (
                                    <option key={tenant.slug} value={tenant.slug}>
                                        {tenant.name}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="form-group">
                            <span className="form-label">Amount</span>
                            <input type="number" defaultValue={500} className="form-input" />
                        </label>

                        <label className="form-group">
                            <span className="form-label">Reason</span>
                            <input type="text" defaultValue="Beta program grant" className="form-input" />
                        </label>

                        <button className="btn" style={{ background: '#ffeef2', color: '#cb3653', borderColor: '#ffd0da' }}>
                            Grant Credits
                        </button>
                    </div>
                </article>
            </section>
        </div>
    );
}
