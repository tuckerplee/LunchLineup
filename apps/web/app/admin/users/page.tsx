import { requireRole } from '@/lib/server-auth';

const USERS = [
    { name: 'Alice Johnson', email: 'alice@downbistro.com', tenant: 'Downtown Bistro', role: 'ADMIN', status: 'active', lastLogin: '2h ago' },
    { name: 'Bob Torres', email: 'bob@downbistro.com', tenant: 'Downtown Bistro', role: 'MANAGER', status: 'active', lastLogin: '1d ago' },
    { name: 'Casey Lee', email: 'casey@downbistro.com', tenant: 'Downtown Bistro', role: 'STAFF', status: 'active', lastLogin: '3d ago' },
    { name: 'Dana Reyes', email: 'dana@harborview.com', tenant: 'Harbor View Cafe', role: 'ADMIN', status: 'active', lastLogin: '5m ago' },
    { name: 'Evan Park', email: 'evan@mesacoll.com', tenant: 'Mesa Collective', role: 'ADMIN', status: 'active', lastLogin: 'Just now' },
    { name: 'Fiona Walsh', email: 'fiona@mesacoll.com', tenant: 'Mesa Collective', role: 'MANAGER', status: 'locked', lastLogin: '2w ago' },
];

const ROLE_COLORS: Record<string, { color: string; bg: string; border: string }> = {
    ADMIN: { color: '#2f63ff', bg: '#edf3ff', border: '#c9d9ff' },
    MANAGER: { color: '#0f8c52', bg: '#e9fbf1', border: '#bdeed4' },
    STAFF: { color: '#4c5f85', bg: '#eef2f9', border: '#d3ddeb' },
};

export default function AdminUsersPage() {
    requireRole(['SUPER_ADMIN']);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1440 }}>
            <section className="surface-card" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div>
                        <div className="workspace-kicker" style={{ color: '#cb3653' }}>
                            Identity and access
                        </div>
                        <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
                            Users
                        </h1>
                        <p className="workspace-subtitle">Cross-tenant user management · {USERS.length} accounts</p>
                    </div>

                    <div
                        className="surface-muted"
                        style={{
                            padding: '0.5rem 0.7rem',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.45rem',
                            color: 'var(--text-muted)',
                            fontSize: '0.84rem',
                        }}
                    >
                        🔍 Search users...
                    </div>
                </div>
            </section>

            <section className="surface-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1040 }}>
                    <thead>
                        <tr style={{ background: '#f8faff', borderBottom: '1px solid var(--border)' }}>
                            {['User', 'Organization', 'Role', 'Status', 'Last Login', 'Actions'].map((h) => (
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
                        {USERS.map((user, i) => {
                            const initials = user.name
                                .split(' ')
                                .map((part) => part[0])
                                .join('');
                            const roleStyle = ROLE_COLORS[user.role] ?? ROLE_COLORS.STAFF;
                            const isLocked = user.status === 'locked';

                            return (
                                <tr key={user.email} style={{ borderBottom: i < USERS.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                                            <div
                                                style={{
                                                    width: 34,
                                                    height: 34,
                                                    borderRadius: '50%',
                                                    flexShrink: 0,
                                                    background: '#edf3ff',
                                                    border: '1px solid #c9d9ff',
                                                    display: 'grid',
                                                    placeItems: 'center',
                                                    fontSize: '0.66rem',
                                                    fontWeight: 700,
                                                    color: '#2f63ff',
                                                }}
                                            >
                                                {initials}
                                            </div>
                                            <div>
                                                <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)' }}>{user.name}</div>
                                                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{user.email}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td style={{ padding: '0.86rem 1rem', fontSize: '0.83rem', color: 'var(--text-secondary)' }}>{user.tenant}</td>
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <span
                                            className="badge"
                                            style={{
                                                fontSize: '0.62rem',
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.06em',
                                                color: roleStyle.color,
                                                background: roleStyle.bg,
                                                borderColor: roleStyle.border,
                                            }}
                                        >
                                            {user.role}
                                        </span>
                                    </td>
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.42rem' }}>
                                            <span className="status-dot" style={{ background: isLocked ? '#e74867' : '#17b26a' }} />
                                            <span style={{ fontSize: '0.82rem', color: isLocked ? '#cb3653' : '#0f8c52', fontWeight: 600 }}>
                                                {isLocked ? 'Locked' : 'Active'}
                                            </span>
                                        </div>
                                    </td>
                                    <td style={{ padding: '0.86rem 1rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{user.lastLogin}</td>
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                            <button className="btn btn-sm btn-secondary">Impersonate</button>
                                            <button
                                                className="btn btn-sm"
                                                style={{
                                                    background: isLocked ? '#e9fbf1' : '#ffeef2',
                                                    color: isLocked ? '#0f8c52' : '#cb3653',
                                                    borderColor: isLocked ? '#bdeed4' : '#ffd0da',
                                                }}
                                            >
                                                {isLocked ? 'Unlock' : 'Lock'}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
