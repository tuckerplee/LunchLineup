import Link from 'next/link';
import { requireRole, can, type UserRole } from '@/lib/server-auth';
import { RoleGate } from '@/components/ui/RoleGate';

const LOCATIONS = [
    {
        id: 'loc-1',
        name: 'Downtown Bistro',
        address: '142 Main St, Portland, OR 97201',
        timezone: 'America/Los_Angeles',
        headcount: 8,
        status: 'active',
        shiftsThisWeek: 24,
        openShifts: 1,
    },
    {
        id: 'loc-2',
        name: 'Pearl District Cafe',
        address: '820 NW 23rd Ave, Portland, OR 97210',
        timezone: 'America/Los_Angeles',
        headcount: 5,
        status: 'active',
        shiftsThisWeek: 15,
        openShifts: 0,
    },
];

export default function LocationsPage() {
    const user = requireRole(['ADMIN', 'MANAGER']);
    const canAdd = can(user.role as UserRole, 'manage_locations');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 1280 }}>
            <section className="surface-card" style={{ padding: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.8rem', flexWrap: 'wrap' }}>
                    <div>
                        <div className="workspace-kicker">Location workspace</div>
                        <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>
                            Locations
                        </h1>
                        <p className="workspace-subtitle">{LOCATIONS.length} active locations across your organization</p>
                    </div>

                    {canAdd ? <button className="btn btn-primary">+ Add Location</button> : null}
                </div>
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '0.8rem' }}>
                {LOCATIONS.map((loc) => (
                    <article key={loc.id} className="surface-card" style={{ padding: '1rem', display: 'grid', gap: '0.8rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
                            <div>
                                <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)', marginBottom: 3 }}>{loc.name}</h2>
                                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{loc.address}</p>
                            </div>
                            <span
                                className="badge"
                                style={{
                                    background: '#e9fbf1',
                                    color: '#0f8c52',
                                    borderColor: '#bdeed4',
                                    fontSize: '0.64rem',
                                    letterSpacing: '0.08em',
                                    textTransform: 'uppercase',
                                }}
                            >
                                {loc.status}
                            </span>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.55rem' }}>
                            {[
                                { label: 'Staff', value: loc.headcount, icon: '👥', alert: false },
                                { label: 'Shifts', value: loc.shiftsThisWeek, icon: '📋', alert: false },
                                { label: 'Open', value: loc.openShifts, icon: '⚠️', alert: loc.openShifts > 0 },
                            ].map((s) => (
                                <div key={s.label} className="surface-muted" style={{ padding: '0.6rem', textAlign: 'center' }}>
                                    <div style={{ fontSize: '0.95rem', marginBottom: 2 }}>{s.icon}</div>
                                    <div
                                        style={{
                                            fontSize: '1.15rem',
                                            fontWeight: 800,
                                            color: s.alert ? '#cb3653' : 'var(--text-primary)',
                                            letterSpacing: '-0.02em',
                                        }}
                                    >
                                        {s.value}
                                    </div>
                                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
                                        {s.label}
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                            <span>Timezone: {loc.timezone}</span>
                            <span>Weekly health: {loc.openShifts > 0 ? 'Attention needed' : 'On track'}</span>
                        </div>

                        <div style={{ display: 'flex', gap: '0.5rem', paddingTop: '0.2rem' }}>
                            <Link href={`/dashboard/scheduling?location=${loc.id}`} className="btn btn-secondary" style={{ flex: 1 }}>
                                View Schedule
                            </Link>
                            <RoleGate userRole={user.role as UserRole} allow={['ADMIN']}>
                                <button className="btn btn-ghost">Edit</button>
                            </RoleGate>
                        </div>
                    </article>
                ))}
            </section>
        </div>
    );
}
