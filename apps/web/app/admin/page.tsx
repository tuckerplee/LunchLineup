import { requireRole } from '@/lib/server-auth';

const HEALTH_INDICATORS = [
    { label: 'API', status: 'online', latency: '12ms' },
    { label: 'Database', status: 'online', latency: '4ms' },
    { label: 'Redis', status: 'online', latency: '1ms' },
    { label: 'RabbitMQ', status: 'online', latency: '2ms' },
    { label: 'Engine', status: 'online', latency: '—' },
    { label: 'Storage', status: 'online', latency: '—' },
];

const PLATFORM_STATS = [
    { label: 'Total Tenants', value: '3', delta: '+1 this week', icon: '🏢', color: '#748ffc' },
    { label: 'Active Users', value: '12', delta: 'across all orgs', icon: '👥', color: '#34d399' },
    { label: 'Active Sessions', value: '4', delta: 'right now', icon: '🔗', color: '#fbbf24' },
    { label: 'Solver Queue', value: '0', delta: 'jobs pending', icon: '⚙️', color: '#94a3b8' },
];

const RECENT_AUDIT = [
    { time: '2m ago', action: 'Schedule published', actor: 'alice@downbistro.com', role: 'MANAGER' },
    { time: '18m ago', action: 'User invited', actor: 'admin@downbistro.com', role: 'ADMIN' },
    { time: '1h ago', action: 'Credits granted (+500)', actor: 'system@lunchlineup.io', role: 'SUPER_ADMIN' },
    { time: '3h ago', action: 'Account locked', actor: 'system@lunchlineup.io', role: 'SUPER_ADMIN' },
    { time: 'Yesterday', action: 'Tenant created', actor: 'system@lunchlineup.io', role: 'SUPER_ADMIN' },
];

const ROLE_COLORS: Record<string, string> = {
    SUPER_ADMIN: '#fb7185',
    ADMIN: '#748ffc',
    MANAGER: '#34d399',
    STAFF: '#94a3b8',
};

export default function AdminOverviewPage() {
    requireRole(['SUPER_ADMIN']);

    const statusColor = (s: string) => s === 'online' ? '#34d399' : s === 'degraded' ? '#fbbf24' : '#f43f5e';

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1400 }}>
            <div>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>
                    System Overview
                </h1>
                <p style={{ fontSize: '0.875rem', color: 'rgba(148,163,184,0.7)' }}>
                    Internal platform console · {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                </p>
            </div>

            {/* Platform stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                {PLATFORM_STATS.map((s, i) => (
                    <div key={i} style={{
                        background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                        borderRadius: 14, padding: '1.25rem',
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                            <span style={{ fontSize: '0.8125rem', color: 'rgba(148,163,184,0.7)', fontWeight: 500 }}>{s.label}</span>
                            <div style={{
                                width: 34, height: 34, borderRadius: 8, fontSize: '0.875rem',
                                background: `${s.color}18`, border: `1px solid ${s.color}30`,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                            }}>{s.icon}</div>
                        </div>
                        <div style={{ fontSize: '2rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.03em' }}>{s.value}</div>
                        <div style={{ fontSize: '0.75rem', color: 'rgba(148,163,184,0.5)', marginTop: '0.25rem' }}>{s.delta}</div>
                    </div>
                ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '1.25rem' }}>
                {/* Audit log */}
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
                            {RECENT_AUDIT.map((row, i) => (
                                <tr key={i}>
                                    <td style={{ padding: '0.75rem 0', fontSize: '0.75rem', color: 'rgba(148,163,184,0.5)', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingRight: '1rem', whiteSpace: 'nowrap' }}>{row.time}</td>
                                    <td style={{ padding: '0.75rem 0', fontSize: '0.8125rem', color: '#e2e8f0', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingRight: '1rem' }}>{row.action}</td>
                                    <td style={{ padding: '0.75rem 0', fontSize: '0.75rem', color: 'rgba(148,163,184,0.6)', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: 'monospace', paddingRight: '1rem' }}>{row.actor}</td>
                                    <td style={{ padding: '0.75rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                        <span style={{ fontSize: '0.5625rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: ROLE_COLORS[row.role], background: `${ROLE_COLORS[row.role]}20`, padding: '2px 7px', borderRadius: 999 }}>
                                            {row.role}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* System health */}
                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '1.5rem' }}>
                    <h2 style={{ fontWeight: 700, fontSize: '0.9375rem', color: '#f1f5f9', marginBottom: '1.25rem' }}>System Health</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {HEALTH_INDICATORS.map((svc, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(svc.status), flexShrink: 0 }} />
                                    <span style={{ fontSize: '0.875rem', color: '#e2e8f0' }}>{svc.label}</span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                                    {svc.latency !== '—' && (
                                        <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'rgba(148,163,184,0.5)' }}>{svc.latency}</span>
                                    )}
                                    <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: statusColor(svc.status), textTransform: 'uppercase', letterSpacing: '0.04em' }}>{svc.status}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
