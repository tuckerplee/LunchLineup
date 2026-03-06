import { requireRole, can, type UserRole } from '@/lib/server-auth';
import { RoleGate } from '@/components/ui/RoleGate';

const STAFF = [
    { name: 'Alice Johnson', initials: 'AJ', role: 'ADMIN', location: 'Downtown Bistro', status: 'active', shifts: 5, hue: 220 },
    { name: 'Bob Torres', initials: 'BT', role: 'MANAGER', location: 'Downtown Bistro', status: 'active', shifts: 4, hue: 160 },
    { name: 'Casey Lee', initials: 'CL', role: 'STAFF', location: 'Downtown Bistro', status: 'active', shifts: 3, hue: 40 },
    { name: 'Riley Park', initials: 'RP', role: 'STAFF', location: 'Downtown Bistro', status: 'active', shifts: 4, hue: 270 },
    { name: 'Jordan Mills', initials: 'JM', role: 'STAFF', location: 'Downtown Bistro', status: 'inactive', shifts: 0, hue: 340 },
];

const ROLE_COLORS: Record<string, { color: string; bg: string }> = {
    ADMIN: { color: '#2f63ff', bg: '#edf3ff' },
    MANAGER: { color: '#0f8c52', bg: '#e9fbf1' },
    STAFF: { color: '#4c5f85', bg: '#eef2f9' },
};

export default function StaffPage() {
    const user = requireRole(['ADMIN', 'MANAGER']);
    const canManage = can(user.role as UserRole, 'manage_users');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1280 }}>
            <section className="surface-card" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.8rem' }}>
                    <div>
                        <div className="workspace-kicker">People workspace</div>
                        <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>
                            Team Members
                        </h1>
                        <p className="workspace-subtitle">{STAFF.length} members · Downtown Bistro</p>
                    </div>
                    <RoleGate userRole={user.role as UserRole} allow={['ADMIN', 'MANAGER']}>
                        <button className="btn btn-primary">+ Invite Member</button>
                    </RoleGate>
                </div>

                <div
                    style={{
                        marginTop: '1rem',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                        gap: '0.7rem',
                    }}
                >
                    {[
                        { label: 'Total Staff', value: STAFF.length, tone: '#2f63ff', icon: '👥' },
                        { label: 'Active', value: STAFF.filter((s) => s.status === 'active').length, tone: '#17b26a', icon: '✅' },
                        { label: 'On Shift Today', value: 3, tone: '#f59e0b', icon: '🕐' },
                        { label: 'Avg Shifts / Week', value: '3.2', tone: '#22b8cf', icon: '📊' },
                    ].map((stat) => (
                        <div key={stat.label} className="surface-muted" style={{ padding: '0.7rem 0.8rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                                <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 600 }}>{stat.label}</span>
                                <span>{stat.icon}</span>
                            </div>
                            <div style={{ fontSize: '1.45rem', fontWeight: 800, color: stat.tone, letterSpacing: '-0.02em' }}>{stat.value}</div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="surface-card" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
                    <thead>
                        <tr style={{ background: '#f8faff', borderBottom: '1px solid var(--border)' }}>
                            {['Member', 'Role', 'Location', 'Status', 'Shifts This Week', ...(canManage ? ['Actions'] : [])].map((h) => (
                                <th
                                    key={h}
                                    style={{
                                        textAlign: 'left',
                                        padding: '0.8rem 1rem',
                                        fontSize: '0.67rem',
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
                        {STAFF.map((s, i) => {
                            const roleStyle = ROLE_COLORS[s.role] ?? ROLE_COLORS.STAFF;
                            return (
                                <tr key={s.name} style={{ borderBottom: i < STAFF.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                                            <div
                                                style={{
                                                    width: 34,
                                                    height: 34,
                                                    borderRadius: '50%',
                                                    flexShrink: 0,
                                                    background: `hsl(${s.hue}, 95%, 96%)`,
                                                    border: `1px solid hsl(${s.hue}, 70%, 78%)`,
                                                    display: 'grid',
                                                    placeItems: 'center',
                                                    fontSize: '0.66rem',
                                                    fontWeight: 800,
                                                    color: `hsl(${s.hue}, 76%, 34%)`,
                                                }}
                                            >
                                                {s.initials}
                                            </div>
                                            <div>
                                                <div style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text-primary)' }}>{s.name}</div>
                                                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                                                    {s.status === 'active' ? 'Available this week' : 'Not currently scheduled'}
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <span
                                            style={{
                                                fontSize: '0.66rem',
                                                fontWeight: 800,
                                                letterSpacing: '0.05em',
                                                color: roleStyle.color,
                                                background: roleStyle.bg,
                                                padding: '0.18rem 0.5rem',
                                                borderRadius: 999,
                                                border: `1px solid ${roleStyle.color}40`,
                                            }}
                                        >
                                            {s.role}
                                        </span>
                                    </td>
                                    <td style={{ padding: '0.86rem 1rem', fontSize: '0.84rem', color: 'var(--text-secondary)' }}>{s.location}</td>
                                    <td style={{ padding: '0.86rem 1rem' }}>
                                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                                            <span className="status-dot" style={{ background: s.status === 'active' ? '#17b26a' : '#9aa7be' }} />
                                            <span style={{ fontSize: '0.82rem', color: s.status === 'active' ? '#0f8c52' : 'var(--text-muted)' }}>
                                                {s.status === 'active' ? 'Active' : 'Inactive'}
                                            </span>
                                        </div>
                                    </td>
                                    <td style={{ padding: '0.86rem 1rem', fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)' }}>{s.shifts}</td>
                                    {canManage ? (
                                        <td style={{ padding: '0.86rem 1rem' }}>
                                            <div style={{ display: 'flex', gap: '0.35rem' }}>
                                                <button className="btn btn-sm btn-secondary">Edit</button>
                                                <button className="btn btn-sm" style={{ background: '#ffedf1', color: '#cb3653', borderColor: '#ffd0da' }}>
                                                    Remove
                                                </button>
                                            </div>
                                        </td>
                                    ) : null}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
