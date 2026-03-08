'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';
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
  { href: '/dashboard/scheduling', label: 'Scheduling', icon: CalendarDays, exact: false, priority: 'strong', badge: 3 },
  { href: '/dashboard/lunch-breaks', label: 'Lunch & Breaks', icon: UtensilsCrossed, exact: false, badge: 1 },
  { href: '/dashboard/staff', label: 'Staff', icon: Users, exact: false },
  { href: '/dashboard/locations', label: 'Locations', icon: MapPin, exact: false },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, exact: false },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notifications = [
    { id: 'swap-1', text: 'Bob T. requested shift swap', tone: 'var(--amber)' },
    { id: 'coverage-1', text: 'Friday dinner coverage below minimum', tone: 'var(--rose)' },
  ];
  const notifCount = notifications.length;

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
                  style={
                    item.priority === 'strong' && !isActive
                      ? {
                          borderColor: '#cfe0ff',
                          background: '#f3f7ff',
                          color: 'var(--text-primary)',
                          fontWeight: 700,
                        }
                      : undefined
                  }
                >
                  <span
                    aria-hidden="true"
                    style={
                      item.priority === 'strong' && !isActive
                        ? {
                            width: 18,
                            display: 'inline-grid',
                            placeItems: 'center',
                            color: '#2f63ff',
                          }
                        : { width: 18, display: 'inline-grid', placeItems: 'center' }
                    }
                  >
                    <Icon size={16} />
                  </span>
                  {item.label}
                  {item.badge ? (
                    <span
                      style={{
                        marginLeft: 'auto',
                        minWidth: 18,
                        height: 18,
                        padding: '0 5px',
                        borderRadius: 999,
                        display: 'inline-grid',
                        placeItems: 'center',
                        fontSize: '0.64rem',
                        fontWeight: 800,
                        color: isActive ? '#ffffff' : '#2f63ff',
                        background: isActive ? 'linear-gradient(180deg, #4171ff, #2f63ff)' : '#e3edff',
                        border: '1px solid #c9d9ff',
                      }}
                    >
                      {item.badge}
                    </span>
                  ) : null}
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
            <div style={{ position: 'relative' }}>
              <button
                id="notification-bell"
                type="button"
                aria-label="Notifications"
                aria-expanded={notificationsOpen}
                aria-haspopup="dialog"
                onClick={() => setNotificationsOpen((open) => !open)}
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
              {notificationsOpen ? (
                <div
                  className="surface-card"
                  role="dialog"
                  aria-label="Notifications"
                  style={{
                    position: 'absolute',
                    top: '2.8rem',
                    right: 0,
                    width: 320,
                    zIndex: 30,
                    padding: '0.75rem',
                    display: 'grid',
                    gap: '0.55rem',
                  }}
                >
                  <div style={{ fontSize: '0.86rem', fontWeight: 750, color: 'var(--text-primary)' }}>Notifications</div>
                  {notifications.map((item) => (
                    <div key={item.id} className="surface-muted" style={{ padding: '0.55rem', display: 'flex', gap: '0.45rem', alignItems: 'flex-start' }}>
                      <span className="status-dot" style={{ marginTop: 6, background: item.tone }} />
                      <span style={{ fontSize: '0.79rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{item.text}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

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
