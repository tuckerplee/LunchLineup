import { requireRole } from '@/lib/server-auth';

const TENANTS_WITH_CREDITS = [
    { name: 'Downtown Bistro', slug: 'downtown-bistro', credits: 420, plan: 'STARTER' },
    { name: 'Harbor View Café', slug: 'harbor-view', credits: 1000, plan: 'FREE' },
    { name: 'Mesa Collective', slug: 'mesa-collective', credits: 9999, plan: 'ENTERPRISE' },
];

const CREDIT_HISTORY = [
    { tenant: 'Harbor View Café', amount: +1000, reason: 'Beta signup bonus', date: 'Mar 1, 2026', actor: 'system' },
    { tenant: 'Downtown Bistro', amount: +500, reason: 'Early adopter grant', date: 'Feb 10, 2026', actor: 'system' },
    { tenant: 'Downtown Bistro', amount: -80, reason: 'Schedule auto-generation × 8', date: 'Feb 28, 2026', actor: 'engine' },
    { tenant: 'Mesa Collective', amount: +9999, reason: 'Enterprise unlimited package', date: 'Jan 5, 2026', actor: 'system' },
];

export default function AdminCreditsPage() {
    requireRole(['SUPER_ADMIN']);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1400 }}>
            <div>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>Credits</h1>
                <p style={{ fontSize: '0.875rem', color: 'rgba(148,163,184,0.6)' }}>Grant and manage usage credits per tenant</p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '1.25rem' }}>
                {/* Tenant credit balances */}
                <div>
                    <h2 style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#e2e8f0', marginBottom: '1rem' }}>Tenant Balances</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {TENANTS_WITH_CREDITS.map((t) => (
                            <div key={t.slug} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem 1.25rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12 }}>
                                <div>
                                    <div style={{ fontWeight: 600, fontSize: '0.9375rem', color: '#f1f5f9' }}>{t.name}</div>
                                    <div style={{ fontSize: '0.6875rem', color: 'rgba(148,163,184,0.4)', fontFamily: 'monospace', marginTop: 2 }}>{t.slug} · {t.plan}</div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                                    <div style={{ textAlign: 'right' }}>
                                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fbbf24', letterSpacing: '-0.02em' }}>{t.credits.toLocaleString()}</div>
                                        <div style={{ fontSize: '0.6875rem', color: 'rgba(148,163,184,0.4)' }}>credits</div>
                                    </div>
                                    <button style={{
                                        padding: '6px 14px', borderRadius: 8,
                                        background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)',
                                        fontSize: '0.8125rem', fontWeight: 600, color: '#fbbf24',
                                        cursor: 'pointer', fontFamily: 'inherit',
                                    }}>
                                        + Grant
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Transaction history */}
                    <h2 style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#e2e8f0', margin: '1.5rem 0 1rem' }}>Transaction History</h2>
                    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                                    {['Tenant', 'Amount', 'Reason', 'Date', 'By'].map(h => (
                                        <th key={h} style={{ textAlign: 'left', padding: '0.75rem 1rem', fontSize: '0.6875rem', fontWeight: 600, color: 'rgba(148,163,184,0.4)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {CREDIT_HISTORY.map((row, i) => (
                                    <tr key={i} style={{ borderBottom: i < CREDIT_HISTORY.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                                        <td style={{ padding: '0.75rem 1rem', fontSize: '0.8125rem', color: '#e2e8f0' }}>{row.tenant}</td>
                                        <td style={{ padding: '0.75rem 1rem', fontWeight: 700, fontSize: '0.875rem', color: row.amount > 0 ? '#34d399' : '#fb7185' }}>
                                            {row.amount > 0 ? '+' : ''}{row.amount.toLocaleString()}
                                        </td>
                                        <td style={{ padding: '0.75rem 1rem', fontSize: '0.8125rem', color: 'rgba(148,163,184,0.7)' }}>{row.reason}</td>
                                        <td style={{ padding: '0.75rem 1rem', fontSize: '0.8125rem', color: 'rgba(148,163,184,0.5)' }}>{row.date}</td>
                                        <td style={{ padding: '0.75rem 1rem', fontSize: '0.75rem', fontFamily: 'monospace', color: 'rgba(148,163,184,0.4)' }}>{row.actor}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Quick grant form */}
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '1.5rem', height: 'fit-content' }}>
                    <h2 style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#e2e8f0', marginBottom: '1.25rem' }}>Grant Credits</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div>
                            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'rgba(148,163,184,0.8)', marginBottom: '0.375rem' }}>Tenant</label>
                            <select style={{ width: '100%', padding: '0.5625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: '#e2e8f0', fontSize: '0.875rem', fontFamily: 'inherit' }}>
                                {TENANTS_WITH_CREDITS.map(t => <option key={t.slug} value={t.slug} style={{ background: '#1e1e2a' }}>{t.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'rgba(148,163,184,0.8)', marginBottom: '0.375rem' }}>Amount</label>
                            <input type="number" defaultValue={500} style={{ width: '100%', padding: '0.5625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: '#e2e8f0', fontSize: '0.875rem', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                        </div>
                        <div>
                            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'rgba(148,163,184,0.8)', marginBottom: '0.375rem' }}>Reason</label>
                            <input type="text" defaultValue="Beta program grant" style={{ width: '100%', padding: '0.5625rem 0.875rem', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: '#e2e8f0', fontSize: '0.875rem', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                        </div>
                        <button style={{
                            padding: '0.625rem 1rem', borderRadius: 8,
                            background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.35)',
                            fontSize: '0.875rem', fontWeight: 700, color: '#fbbf24',
                            cursor: 'pointer', fontFamily: 'inherit',
                        }}>
                            💳 Grant Credits
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
