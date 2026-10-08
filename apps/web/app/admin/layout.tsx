import { LogoutLink } from '@/components/auth/LogoutLink';
import { getServerUser } from '@/lib/server-auth';
import { redirect } from 'next/navigation';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { LogOut } from 'lucide-react';
import { AdminNav } from './AdminNav';
import styles from './admin-shell.module.css';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const user = await getServerUser();
    if (!user || !user.permissions.includes('admin_portal:access')) redirect('/dashboard');
    const environment = process.env.NEXT_PUBLIC_APP_ENV ?? process.env.NODE_ENV ?? 'development';
    const roleLabel = user.role.replaceAll('_', ' ');

    return (
        <div className={`workspace-shell ${styles.shell}`} style={{ background: '#f7f9ff' }}>
            <aside
                className="workspace-sidebar"
                aria-label="Admin sidebar"
                style={{
                    background:
                        'radial-gradient(40rem 24rem at -10% -20%, rgba(231,72,103,0.16), transparent 58%), linear-gradient(180deg, #fef8fa, #f7f9ff 42%, #f9fbff)',
                }}
            >
                <div className={`workspace-sidebar-inner ${styles.sidebarInner}`} style={{ borderColor: '#f0d5de' }}>
                    <div className={styles.brand} style={{ padding: '1.05rem 1rem', borderBottom: '1px solid #f0d5de' }}>
                        <div className={styles.brandRow} style={{ display: 'flex', alignItems: 'center', gap: '0.62rem', marginBottom: '0.55rem' }}>
                            <div
                                aria-hidden="true"
                                className={styles.brandMark}
                                style={{
                                    width: 34,
                                    height: 34,
                                    flexShrink: 0,
                                    display: 'grid',
                                    placeItems: 'center',
                                }}
                            >
                                <LunchLineupMark size={34} />
                            </div>
                            <div className={styles.brandText}>
                                <div className={styles.brandName} style={{ fontWeight: 800, letterSpacing: 0, color: 'var(--text-primary)' }}>LunchLineup</div>
                                <div className="workspace-kicker">Platform Admin</div>
                            </div>
                        </div>

                        <span
                            className={`badge ${styles.roleBadge}`}
                            style={{
                                fontSize: '0.62rem',
                                textTransform: 'uppercase',
                                letterSpacing: '0.08em',
                                background: '#ffeef2',
                                color: '#b4233f',
                                borderColor: '#ffcfda',
                            }}
                        >
                            {roleLabel}
                        </span>
                    </div>

                    <AdminNav />

                    <div style={{ borderTop: '1px solid #f0d5de', padding: '0.8rem' }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.45rem', paddingLeft: '0.2rem' }}>
                            Signed in as {roleLabel.toLowerCase()}
                        </div>
                        <LogoutLink
                            className="workspace-nav-link"
                            style={{ color: '#b4233f', borderColor: '#ffd5df', background: '#fff6f8' }}
                        >
                            <span aria-hidden="true">↩</span>
                            Sign out
                        </LogoutLink>
                    </div>
                </div>
            </aside>

            <section className="workspace-main">
                <header
                    className={`workspace-topbar ${styles.topbar}`}
                    style={{
                        borderBottomColor: '#f0d5de',
                        background:
                            'linear-gradient(180deg, rgba(255,250,252,0.94), rgba(247,249,255,0.92))',
                    }}
                >
                    <div>
                        <div className="workspace-kicker" style={{ color: '#b4233f' }}>
                            Internal Console
                        </div>
                        <div className={styles.heading} style={{ fontWeight: 700, color: 'var(--text-primary)' }}>System Administration</div>
                    </div>

                    <div className={styles.actions} style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
                        <LogoutLink
                            className={`workspace-mobile-signout btn btn-secondary btn-sm ${styles.mobileSignout}`}
                            aria-label="Sign out"
                        >
                            <LogOut aria-hidden="true" size={16} />
                            <span className="workspace-mobile-signout-label">Sign out</span>
                        </LogoutLink>
                        <span className={`badge ${styles.environment}`} style={{ background: '#ffeef2', borderColor: '#ffcfda', color: '#b4233f' }}>
                            {environment}
                        </span>
                        <span
                            className={styles.avatar}
                            aria-hidden="true"
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
