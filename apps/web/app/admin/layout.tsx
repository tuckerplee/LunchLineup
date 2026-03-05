import Link from 'next/link';
import { getServerUser, ROLE_META } from '@/lib/server-auth';
import { redirect } from 'next/navigation';

const ADMIN_NAV = [
    { href: '/admin', label: 'Overview', icon: '◈', exact: true },
    { href: '/admin/tenants', label: 'Tenants', icon: '🏢', exact: false },
    { href: '/admin/users', label: 'Users', icon: '👥', exact: false },
    { href: '/admin/credits', label: 'Credits', icon: '💳', exact: false },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
    const user = getServerUser();
    if (!user || user.role !== 'SUPER_ADMIN') redirect('/dashboard');

    const roleMeta = ROLE_META['SUPER_ADMIN'];

    return (
        <div style={{ display: 'flex', minHeight: '100vh', background: '#0a0a0f' }}>
            {/* ── System Admin Sidebar ── */}
            <aside style={{
                width: 220, flexShrink: 0,
                background: '#0f0a14',
                borderRight: '1px solid rgba(244,63,94,0.2)',
                display: 'flex', flexDirection: 'column',
            }}>
                {/* Logo + System Admin badge */}
                <div style={{ padding: '1.25rem', borderBottom: '1px solid rgba(244,63,94,0.15)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <div style={{
                            width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                            background: 'linear-gradient(135deg, #f43f5e, #e11d48)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.875rem',
                        }}>🍱</div>
                        <span style={{ fontWeight: 800, fontSize: '0.9375rem', color: '#f1f5f9', letterSpacing: '-0.01em' }}>
                            LunchLineup
                        </span>
                    </div>
                    <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.375rem',
                        padding: '3px 10px', borderRadius: 999,
                        background: 'rgba(244,63,94,0.15)',
                        border: '1px solid rgba(244,63,94,0.35)',
                        fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.08em',
                        textTransform: 'uppercase', color: '#fb7185',
                    }}>
                        <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#f43f5e', animation: 'pulse 2s infinite' }} />
                        System Admin
                    </div>
                </div>

                {/* Nav */}
                <nav style={{ flex: 1, padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {ADMIN_NAV.map(item => (
                        <Link key={item.href} href={item.href} style={{
                            display: 'flex', alignItems: 'center', gap: '0.625rem',
                            padding: '0.5625rem 0.75rem', borderRadius: 8,
                            textDecoration: 'none', fontSize: '0.875rem', fontWeight: 500,
                            color: 'rgba(241,245,249,0.7)',
                            transition: 'all 150ms',
                        }}>
                            <span style={{ fontSize: '1rem', width: 20, textAlign: 'center' }}>{item.icon}</span>
                            {item.label}
                        </Link>
                    ))}
                </nav>

                {/* Back to dashboard link (shows tenant dashboard route) */}
                <div style={{ padding: '1rem 0.75rem', borderTop: '1px solid rgba(244,63,94,0.15)' }}>
                    <div style={{ fontSize: '0.6875rem', color: 'rgba(148,163,184,0.5)', marginBottom: '0.375rem', paddingLeft: '0.75rem' }}>
                        Signed in as System Admin
                    </div>
                    <Link href="/api/v1/auth/logout" style={{
                        display: 'flex', alignItems: 'center', gap: '0.625rem',
                        padding: '0.5625rem 0.75rem', borderRadius: 8,
                        textDecoration: 'none', fontSize: '0.875rem',
                        color: 'rgba(148,163,184,0.7)', transition: 'all 150ms',
                    }}>
                        <span>🚪</span> Sign out
                    </Link>
                </div>
            </aside>

            {/* ── Main ── */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* Top header */}
                <header style={{
                    height: 56, flexShrink: 0,
                    borderBottom: '1px solid rgba(244,63,94,0.2)',
                    background: '#0f0a14',
                    display: 'flex', alignItems: 'center', padding: '0 1.5rem',
                    justifyContent: 'space-between',
                }}>
                    <span style={{ fontSize: '0.75rem', color: 'rgba(148,163,184,0.5)' }}>
                        Internal Platform Console · LunchLineup v0.1
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{
                            width: 32, height: 32, borderRadius: '50%',
                            background: 'linear-gradient(135deg, #f43f5e, #e11d48)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.75rem', fontWeight: 800, color: 'white',
                        }}>S</div>
                    </div>
                </header>

                <main style={{ flex: 1, overflowY: 'auto', padding: '1.5rem', background: '#0a0a0f' }}>
                    {children}
                </main>
            </div>

            <style>{`
                @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
            `}</style>
        </div>
    );
}
