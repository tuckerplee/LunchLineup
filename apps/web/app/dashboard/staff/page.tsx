import { requireRole, can, ROLE_META, type UserRole } from '@/lib/server-auth';
import { RoleGate } from '@/components/ui/RoleGate';

const STAFF = [
    { name: 'Alice Johnson', initials: 'AJ', role: 'ADMIN', location: 'Downtown Bistro', status: 'active', shifts: 5, hue: 220 },
    { name: 'Bob Torres', initials: 'BT', role: 'MANAGER', location: 'Downtown Bistro', status: 'active', shifts: 4, hue: 160 },
    { name: 'Casey Lee', initials: 'CL', role: 'STAFF', location: 'Downtown Bistro', status: 'active', shifts: 3, hue: 40 },
    { name: 'Riley Park', initials: 'RP', role: 'STAFF', location: 'Downtown Bistro', status: 'active', shifts: 4, hue: 270 },
    { name: 'Jordan Mills', initials: 'JM', role: 'STAFF', location: 'Downtown Bistro', status: 'inactive', shifts: 0, hue: 340 },
];

const ROLE_COLORS: Record<string, { color: string; bg: string }> = {
    ADMIN: { color: '#748ffc', bg: 'rgba(92,124,250,0.15)' },
    MANAGER: { color: '#34d399', bg: 'rgba(16,185,129,0.12)' },
    STAFF: { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' },
};

export default function StaffPage() {
    const user = requireRole(['ADMIN', 'MANAGER']);
    const canInvite = can(user.role as UserRole, 'invite_staff');
    const canManage = can(user.role as UserRole, 'manage_users');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1200 }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>Team</h1>
                    <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>{STAFF.length} members · Downtown Bistro</p>
                </div>
                <RoleGate userRole={user.role as UserRole} allow={['ADMIN', 'MANAGER']}>
                    <button style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                        padding: '0.5625rem 1.125rem',
                        background: 'linear-gradient(135deg, #5c7cfa, #748ffc)',
                        color: 'white', fontWeight: 600, fontSize: '0.875rem',
                        borderRadius: 10, border: 'none', cursor: 'pointer',
                        boxShadow: '0 4px 16px rgba(92,124,250,0.3)',
                        fontFamily: 'var(--font-sans)',
                    }}>
                        + Invite Member
                    </button>
                </RoleGate>
            </div>

            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.875rem' }}>
                {[
                    { label: 'Total Staff', value: STAFF.length, icon: '👥', color: '#748ffc' },
                    { label: 'Active', value: STAFF.filter(s => s.status === 'active').length, icon: '✅', color: '#34d399' },
                    { label: 'On Shift Today', value: 3, icon: '🕐', color: '#fbbf24' },
                    { label: 'Avg Shifts / Wk', value: '3.2', icon: '📊', color: '#94a3b8' },
                ].map((stat, i) => (
                    <div key={i} style={{ background: 'var(--bg-glass)', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem 1.125rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500 }}>{stat.label}</span>
                            <span style={{ fontSize: '1rem' }}>{stat.icon}</span>
                        </div>
                        <span style={{ fontSize: '1.5rem', fontWeight: 800, color: stat.color, letterSpacing: '-0.02em' }}>{stat.value}</span>
                    </div>
                ))}
            </div>

            {/* Staff table */}
            <div style={{ background: 'var(--bg-glass)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)' }}>
                            {['Member', 'Role', 'Location', 'Status', 'Shifts This Week', ...(canManage ? ['Actions'] : [])].map(h => (
                                <th key={h} style={{ textAlign: 'left', padding: '0.875rem 1.25rem', fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {STAFF.map((s, i) => {
                            const roleStyle = ROLE_COLORS[s.role] ?? ROLE_COLORS.STAFF;
                            return (
                                <tr key={s.name} style={{ borderBottom: i < STAFF.length - 1 ? '1px solid var(--border)' : 'none' }}>
                                    <td style={{ padding: '0.875rem 1.25rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                            <div style={{
                                                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                                                background: `hsl(${s.hue}, 55%, 22%)`,
                                                border: `1px solid hsl(${s.hue}, 55%, 42%)`,
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: '0.625rem', fontWeight: 800,
                                                color: `hsl(${s.hue}, 90%, 72%)`,
                                            }}>{s.initials}</div>
                                            <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)' }}>{s.name}</div>
                                        </div>
                                    </td>
                                    <td style={{ padding: '0.875rem 1.25rem' }}>
                                        <span style={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.04em', color: roleStyle.color, background: roleStyle.bg, padding: '2px 8px', borderRadius: 999 }}>
                                            {s.role}
                                        </span>
                                    </td>
                                    <td style={{ padding: '0.875rem 1.25rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>{s.location}</td>
                                    <td style={{ padding: '0.875rem 1.25rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                            <div style={{ width: 7, height: 7, borderRadius: '50%', background: s.status === 'active' ? '#34d399' : '#475569' }} />
                                            <span style={{ fontSize: '0.8125rem', color: s.status === 'active' ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                                                {s.status === 'active' ? 'Active' : 'Inactive'}
                                            </span>
                                        </div>
                                    </td>
                                    <td style={{ padding: '0.875rem 1.25rem', fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>{s.shifts}</td>
                                    {canManage && (
                                        <td style={{ padding: '0.875rem 1.25rem' }}>
                                            <div style={{ display: 'flex', gap: '0.375rem' }}>
                                                <button style={{ padding: '3px 10px', borderRadius: 6, background: 'rgba(92,124,250,0.1)', border: '1px solid rgba(92,124,250,0.25)', fontSize: '0.6875rem', fontWeight: 600, color: '#748ffc', cursor: 'pointer', fontFamily: 'inherit' }}>Edit</button>
                                                <button style={{ padding: '3px 10px', borderRadius: 6, background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)', fontSize: '0.6875rem', fontWeight: 600, color: '#fb7185', cursor: 'pointer', fontFamily: 'inherit' }}>Remove</button>
                                            </div>
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
