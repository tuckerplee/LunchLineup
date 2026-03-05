import { requireRole } from '@/lib/server-auth';

const USERS = [
    { name: 'Alice Johnson', email: 'alice@downbistro.com', tenant: 'Downtown Bistro', role: 'ADMIN', status: 'active', lastLogin: '2h ago' },
    { name: 'Bob Torres', email: 'bob@downbistro.com', tenant: 'Downtown Bistro', role: 'MANAGER', status: 'active', lastLogin: '1d ago' },
    { name: 'Casey Lee', email: 'casey@downbistro.com', tenant: 'Downtown Bistro', role: 'STAFF', status: 'active', lastLogin: '3d ago' },
    { name: 'Dana Reyes', email: 'dana@harborview.com', tenant: 'Harbor View Café', role: 'ADMIN', status: 'active', lastLogin: '5m ago' },
    { name: 'Evan Park', email: 'evan@mesacoll.com', tenant: 'Mesa Collective', role: 'ADMIN', status: 'active', lastLogin: 'Just now' },
    { name: 'Fiona Walsh', email: 'fiona@mesacoll.com', tenant: 'Mesa Collective', role: 'MANAGER', status: 'locked', lastLogin: '2w ago' },
];

const ROLE_COLORS: Record<string, { color: string; bg: string }> = {
    ADMIN: { color: '#748ffc', bg: 'rgba(92,124,250,0.15)' },
    MANAGER: { color: '#34d399', bg: 'rgba(16,185,129,0.12)' },
    STAFF: { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' },
};

export default function AdminUsersPage() {
    requireRole(['SUPER_ADMIN']);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1400 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>Users</h1>
                    <p style={{ fontSize: '0.875rem', color: 'rgba(148,163,184,0.6)' }}>Cross-tenant user management · {USERS.length} total accounts</p>
                </div>
                {/* Search placeholder */}
                <div style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.5rem 0.875rem', borderRadius: 8,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: 'rgba(148,163,184,0.5)', fontSize: '0.875rem',
                }}>
                    🔍 Search users…
                </div>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                            {['User', 'Organization', 'Role', 'Status', 'Last Login', 'Actions'].map(h => (
                                <th key={h} style={{ textAlign: 'left', padding: '0.875rem 1.25rem', fontSize: '0.6875rem', fontWeight: 600, color: 'rgba(148,163,184,0.5)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {USERS.map((u, i) => {
                            const initial = u.name.split(' ').map((n: string) => n[0]).join('');
                            const roleStyle = ROLE_COLORS[u.role] ?? { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' };
                            const isLocked = u.status === 'locked';
                            return (
                                <tr key={u.email} style={{ borderBottom: i < USERS.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                                    <td style={{ padding: '0.875rem 1.25rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                                            <div style={{
                                                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                                                background: 'rgba(92,124,250,0.15)', border: '1px solid rgba(92,124,250,0.3)',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: '0.625rem', fontWeight: 700, color: '#748ffc',
                                            }}>{initial}</div>
                                            <div>
                                                <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f1f5f9' }}>{u.name}</div>
                                                <div style={{ fontSize: '0.6875rem', color: 'rgba(148,163,184,0.5)', fontFamily: 'monospace' }}>{u.email}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td style={{ padding: '0.875rem 1.25rem', fontSize: '0.8125rem', color: 'rgba(148,163,184,0.7)' }}>{u.tenant}</td>
                                    <td style={{ padding: '0.875rem 1.25rem' }}>
                                        <span style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', color: roleStyle.color, background: roleStyle.bg, padding: '2px 8px', borderRadius: 999 }}>
                                            {u.role}
                                        </span>
                                    </td>
                                    <td style={{ padding: '0.875rem 1.25rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: isLocked ? '#f43f5e' : '#34d399' }} />
                                            <span style={{ fontSize: '0.8125rem', color: isLocked ? '#fb7185' : '#34d399' }}>{isLocked ? 'Locked' : 'Active'}</span>
                                        </div>
                                    </td>
                                    <td style={{ padding: '0.875rem 1.25rem', fontSize: '0.8125rem', color: 'rgba(148,163,184,0.6)' }}>{u.lastLogin}</td>
                                    <td style={{ padding: '0.875rem 1.25rem' }}>
                                        <div style={{ display: 'flex', gap: '0.375rem' }}>
                                            <button style={{ padding: '3px 10px', borderRadius: 6, background: 'rgba(92,124,250,0.12)', border: '1px solid rgba(92,124,250,0.25)', fontSize: '0.6875rem', fontWeight: 600, color: '#748ffc', cursor: 'pointer', fontFamily: 'inherit' }}>
                                                Impersonate
                                            </button>
                                            <button style={{ padding: '3px 10px', borderRadius: 6, background: isLocked ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)', border: `1px solid ${isLocked ? 'rgba(16,185,129,0.25)' : 'rgba(244,63,94,0.25)'}`, fontSize: '0.6875rem', fontWeight: 600, color: isLocked ? '#34d399' : '#fb7185', cursor: 'pointer', fontFamily: 'inherit' }}>
                                                {isLocked ? 'Unlock' : 'Lock'}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
