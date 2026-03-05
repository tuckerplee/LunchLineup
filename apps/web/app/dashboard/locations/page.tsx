import { requireRole, can, type UserRole } from '@/lib/server-auth';
import { RoleGate } from '@/components/ui/RoleGate';

const LOCATIONS = [
    {
        id: 'loc-1', name: 'Downtown Bistro', address: '142 Main St, Portland, OR 97201',
        timezone: 'America/Los_Angeles', headcount: 8, status: 'active',
        shiftsThisWeek: 24, openShifts: 1,
    },
    {
        id: 'loc-2', name: 'Pearl District Café', address: '820 NW 23rd Ave, Portland, OR 97210',
        timezone: 'America/Los_Angeles', headcount: 5, status: 'active',
        shiftsThisWeek: 15, openShifts: 0,
    },
];

export default function LocationsPage() {
    const user = requireRole(['ADMIN', 'MANAGER']);
    const canAdd = can(user.role as UserRole, 'manage_locations');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1200 }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                    <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>Locations</h1>
                    <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>{LOCATIONS.length} active locations</p>
                </div>
                <RoleGate userRole={user.role as UserRole} allow={['ADMIN']}>
                    <button style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                        padding: '0.5625rem 1.125rem',
                        background: 'linear-gradient(135deg, #5c7cfa, #748ffc)',
                        color: 'white', fontWeight: 600, fontSize: '0.875rem',
                        borderRadius: 10, border: 'none', cursor: 'pointer',
                        boxShadow: '0 4px 16px rgba(92,124,250,0.3)',
                        fontFamily: 'var(--font-sans)',
                    }}>
                        + Add Location
                    </button>
                </RoleGate>
            </div>

            {/* Location cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '1rem' }}>
                {LOCATIONS.map(loc => (
                    <div key={loc.id} style={{ background: 'var(--bg-glass)', border: '1px solid var(--border)', borderRadius: 14, padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {/* Card header */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                                <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)', marginBottom: '0.25rem' }}>{loc.name}</div>
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{loc.address}</div>
                            </div>
                            <span style={{
                                fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.06em',
                                textTransform: 'uppercase', padding: '3px 8px', borderRadius: 999,
                                color: '#34d399', background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)',
                            }}>Active</span>
                        </div>

                        {/* Stats */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.625rem' }}>
                            {[
                                { label: 'Staff', value: loc.headcount, icon: '👥' },
                                { label: 'Shifts/wk', value: loc.shiftsThisWeek, icon: '📋' },
                                { label: 'Open', value: loc.openShifts, icon: '⚠️', alert: loc.openShifts > 0 },
                            ].map((s, i) => (
                                <div key={i} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '0.625rem', textAlign: 'center' }}>
                                    <div style={{ fontSize: '0.875rem', marginBottom: '0.25rem' }}>{s.icon}</div>
                                    <div style={{ fontSize: '1.125rem', fontWeight: 800, color: s.alert ? '#fb7185' : 'var(--text-primary)', letterSpacing: '-0.02em' }}>{s.value}</div>
                                    <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{s.label}</div>
                                </div>
                            ))}
                        </div>

                        {/* Actions */}
                        <div style={{ display: 'flex', gap: '0.5rem', paddingTop: '0.25rem', borderTop: '1px solid var(--border)' }}>
                            <a href={`/dashboard/scheduling?location=${loc.id}`} style={{ flex: 1, textAlign: 'center', padding: '0.5rem', borderRadius: 8, textDecoration: 'none', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--brand)', background: 'rgba(92,124,250,0.08)', border: '1px solid rgba(92,124,250,0.2)' }}>
                                View Schedule
                            </a>
                            <RoleGate userRole={user.role as UserRole} allow={['ADMIN']}>
                                <button style={{ padding: '0.5rem 0.875rem', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit' }}>
                                    Edit
                                </button>
                            </RoleGate>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
