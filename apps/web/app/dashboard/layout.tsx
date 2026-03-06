'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import {
  Bell,
  CalendarDays,
  ChevronDown,
  LayoutGrid,
  LogOut,
  MapPin,
  Settings,
  Store,
  Users,
  UtensilsCrossed,
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Overview', icon: LayoutGrid, exact: true },
  { href: '/dashboard/scheduling', label: 'Scheduling', icon: CalendarDays, exact: false },
  { href: '/dashboard/lunch-breaks', label: 'Lunch & Breaks', icon: UtensilsCrossed, exact: false },
  { href: '/dashboard/staff', label: 'Staff', icon: Users, exact: false },
  { href: '/dashboard/locations', label: 'Locations', icon: MapPin, exact: false },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, exact: false },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const notifCount = 2;

  const currentPage = useMemo(() => {
    const match = NAV_ITEMS.find((item) => (item.exact ? pathname === item.href : pathname.startsWith(item.href)));
    return match?.label ?? 'Workspace';
  }, [pathname]);

  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar" aria-label="Sidebar navigation">
        <div className="workspace-sidebar-inner">
          <div style={{ padding: '1.1rem 1rem', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  background: 'linear-gradient(135deg, #4f79ff, #2f63ff 60%, #22b8cf 120%)',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'white',
                }}
                aria-hidden="true"
              >
                <UtensilsCrossed size={16} />
              </div>
              <div>
                <div style={{ fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>LunchLineup</div>
                <div className="workspace-kicker">Workforce Ops</div>
              </div>
            </div>
          </div>

          <div style={{ padding: '0.8rem 0.8rem 0.6rem' }}>
            <button
              type="button"
              className="surface-muted"
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '0.55rem',
                padding: '0.55rem 0.62rem',
                color: 'var(--text-primary)',
                fontSize: '0.84rem',
                fontWeight: 650,
                cursor: 'pointer',
              }}
            >
              <Store size={14} />
              Downtown Bistro
              <ChevronDown size={13} style={{ marginLeft: 'auto', color: 'var(--text-muted)' }} />
            </button>
          </div>

          <nav style={{ padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`workspace-nav-link ${isActive ? 'active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span aria-hidden="true" style={{ width: 18, display: 'inline-grid', placeItems: 'center' }}>
                    <Icon size={16} />
                  </span>
                  {item.label}
                  {isActive ? (
                    <span
                      className="status-dot"
                      style={{ marginLeft: 'auto', background: 'linear-gradient(180deg, #4171ff, #2f63ff)' }}
                      aria-hidden="true"
                    />
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <div style={{ borderTop: '1px solid var(--border)', padding: '0.8rem' }}>
            <Link href="/auth/logout" prefetch={false} className="workspace-nav-link" style={{ justifyContent: 'flex-start' }}>
              <LogOut size={16} />
              Sign out
            </Link>
          </div>
        </div>
      </aside>

      <section className="workspace-main">
        <header className="workspace-topbar">
          <div>
            <div className="workspace-kicker">Team Workspace</div>
            <div style={{ fontSize: '1.03rem', fontWeight: 700, color: 'var(--text-primary)' }}>{currentPage}</div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
            <button
              id="notification-bell"
              type="button"
              aria-label="Notifications"
              style={{
                position: 'relative',
                width: 38,
                height: 38,
                borderRadius: 12,
                border: '1px solid var(--border)',
                background: '#ffffff',
                color: 'var(--text-secondary)',
                display: 'grid',
                placeItems: 'center',
                cursor: 'pointer',
              }}
            >
              <Bell size={17} />
              {notifCount > 0 ? (
                <span
                  style={{
                    position: 'absolute',
                    top: -4,
                    right: -4,
                    minWidth: 19,
                    height: 19,
                    padding: '0 5px',
                    borderRadius: 999,
                    background: 'var(--rose)',
                    color: 'white',
                    fontWeight: 700,
                    fontSize: '0.66rem',
                    display: 'grid',
                    placeItems: 'center',
                    border: '2px solid #f4f7fd',
                  }}
                >
                  {notifCount}
                </span>
              ) : null}
            </button>

            <button
              type="button"
              aria-label="Account menu"
              style={{
                border: '1px solid var(--border)',
                background: '#ffffff',
                borderRadius: 999,
                padding: '0.2rem 0.35rem 0.2rem 0.2rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.45rem',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #4171ff, #2f63ff 60%, #22b8cf)',
                  color: 'white',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                AJ
              </span>
              <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>
        </header>

        <main className="workspace-content">{children}</main>
      </section>
    </div>
  );
}
