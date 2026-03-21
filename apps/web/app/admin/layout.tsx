import Link from 'next/link';
import { getServerUser } from '@/lib/server-auth';
import { redirect } from 'next/navigation';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';

const ADMIN_NAV = [
    { href: '/admin', label: 'Overview', icon: '◈' },
    { href: '/admin/tenants', label: 'Tenants', icon: '🏢' },
    { href: '/admin/users', label: 'Users', icon: '👥' },
    { href: '/admin/credits', label: 'Credits', icon: '💳' },
    { href: '/admin/plans', label: 'Plans', icon: '📦' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
    const user = getServerUser();
    if (!user || user.role !== 'SUPER_ADMIN') redirect('/dashboard');

    return (
        <div className="workspace-shell" style={{ background: '#f7f9ff' }}>
            <aside
                className="workspace-sidebar"
                aria-label="Admin sidebar"
                style={{
                    background:
                        'radial-gradient(40rem 24rem at -10% -20%, rgba(231,72,103,0.16), transparent 58%), linear-gradient(180deg, #fef8fa, #f7f9ff 42%, #f9fbff)',
                }}
            >
                <div className="workspace-sidebar-inner" style={{ borderColor: '#f0d5de' }}>
                    <div style={{ padding: '1.05rem 1rem', borderBottom: '1px solid #f0d5de' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.62rem', marginBottom: '0.55rem' }}>
                            <div
                                aria-hidden="true"
                                style={{
                                    width: 34,
                                    height: 34,
                                    display: 'grid',
                                    placeItems: 'center',
                                }}
                            >
                                <LunchLineupMark size={34} />
                            </div>
                            <div>
                                <div style={{ fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>LunchLineup</div>
                                <div className="workspace-kicker">Platform Admin</div>
                            </div>
                        </div>

                        <span
                            className="badge"
                            style={{
                                fontSize: '0.62rem',
                                textTransform: 'uppercase',
                                letterSpacing: '0.08em',
                                background: '#ffeef2',
                                color: '#cb3653',
                                borderColor: '#ffcfda',
                            }}
                        >
                            System Admin
                        </span>
                    </div>

                    <nav style={{ flex: 1, padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {ADMIN_NAV.map((item) => (
                            <Link
                                key={item.href}
                                href={item.href}
                                className="workspace-nav-link"
                                style={{
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                <span aria-hidden="true" style={{ width: 18, display: 'inline-grid', placeItems: 'center' }}>
                                    {item.icon}
                                </span>
                                {item.label}
                            </Link>
                        ))}
                    </nav>

                    <div style={{ borderTop: '1px solid #f0d5de', padding: '0.8rem' }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.45rem', paddingLeft: '0.2rem' }}>
                            Signed in as System Admin
                        </div>
                        <Link
                            href="/auth/logout"
                            className="workspace-nav-link"
                            style={{ color: '#cb3653', borderColor: '#ffd5df', background: '#fff6f8' }}
                        >
                            <span aria-hidden="true">↩</span>
                            Sign out
                        </Link>
                    </div>
                </div>
            </aside>

            <section className="workspace-main">
                <header
                    className="workspace-topbar"
                    style={{
                        borderBottomColor: '#f0d5de',
                        background:
                            'linear-gradient(180deg, rgba(255,250,252,0.94), rgba(247,249,255,0.92))',
                    }}
                >
                    <div>
                        <div className="workspace-kicker" style={{ color: '#cb3653' }}>
                            Internal Console
                        </div>
                        <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>System Administration</div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                        <span className="badge" style={{ background: '#ffeef2', borderColor: '#ffcfda', color: '#cb3653' }}>
                            Production
                        </span>
                        <span
                            style={{
                                width: 32,
                                height: 32,
                                borderRadius: '50%',
                                display: 'grid',
                                placeItems: 'center',
                                background: 'linear-gradient(135deg, #f26f87, #e74867)',
                                color: '#ffffff',
                                fontWeight: 800,
                                fontSize: '0.73rem',
                            }}
                        >
                            SA
                        </span>
                    </div>
                </header>

                <main className="workspace-content">{children}</main>
            </section>
        </div>
    );
}
