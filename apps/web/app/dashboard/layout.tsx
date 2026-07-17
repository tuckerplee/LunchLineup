'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';
import {
  LogOut,
  Settings,
  Store,
} from 'lucide-react';
import { NotificationsMenu, type DashboardNotification } from './NotificationsMenu';
import {
  canOpenDashboardAccountSettings,
  getDashboardCurrentPage,
  getDashboardUserInitials,
  getVisibleDashboardNavItems,
} from './dashboard-navigation';

type DashboardRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type DashboardUser = {
  sub: string;
  role: DashboardRole;
  permissions?: string[];
  tenantId: string;
  sessionId: string;
  email?: string | null;
  username?: string | null;
  name?: string | null;
  tenantName?: string | null;
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<DashboardUser | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<DashboardNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  function getCsrfToken(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
  }

  useEffect(() => {
    let cancelled = false;

    async function loadHeaderData() {
      try {
        const me = await fetchJsonWithSession<{ user?: DashboardUser }>('/auth/me');
        if (cancelled) return;
        setUser(me.user ?? null);
      } catch {
        if (!cancelled) setUser(null);
        return;
      }

      try {
        const feed = await fetchJsonWithSession<{ data: DashboardNotification[]; unreadCount: number }>('/notifications?status=all&limit=20');
        if (cancelled) return;
        setNotifications(feed.data ?? []);
        setUnreadCount(feed.unreadCount ?? 0);
      } catch {
        if (!cancelled) {
          setNotifications([]);
          setUnreadCount(0);
        }
      }
    }

    async function refreshFeed() {
      try {
        const feed = await fetchJsonWithSession<{ data: DashboardNotification[]; unreadCount: number }>('/notifications?status=all&limit=20');
        if (!cancelled) {
          setNotifications(feed.data ?? []);
          setUnreadCount(feed.unreadCount ?? 0);
        }
      } catch {
        if (!cancelled) {
          setNotifications([]);
          setUnreadCount(0);
        }
      }
    }

    void loadHeaderData();
    const interval = window.setInterval(() => {
      void refreshFeed();
    }, 45000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  async function markOneAsRead(notificationId: string) {
    const csrf = getCsrfToken();
    const response = await fetchWithSession('/notifications/read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      body: JSON.stringify({ ids: [notificationId] }),
    });
    if (!response.ok) return;

    setNotifications((current) => current.map((item) => (item.id === notificationId ? { ...item, readAt: new Date().toISOString() } : item)));
    setUnreadCount((count) => Math.max(0, count - 1));
  }

  async function markAllAsRead() {
    const csrf = getCsrfToken();
    const response = await fetchWithSession('/notifications/read-all', {
      method: 'POST',
      headers: {
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
    });
    if (!response.ok) return;

    setNotifications((current) => current.map((item) => (item.readAt ? item : { ...item, readAt: new Date().toISOString() })));
    setUnreadCount(0);
  }

  const visibleNavItems = useMemo(() => getVisibleDashboardNavItems(user?.permissions), [user?.permissions]);
  const canOpenAccountSettings = useMemo(() => canOpenDashboardAccountSettings(user?.permissions), [user?.permissions]);

  const currentPage = useMemo(() => {
    return getDashboardCurrentPage(pathname, visibleNavItems);
  }, [pathname, visibleNavItems]);

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
                  display: 'grid',
                  placeItems: 'center',
                }}
                aria-hidden="true"
              >
                <LunchLineupMark size={34} />
              </div>
              <div>
                <div style={{ fontWeight: 800, letterSpacing: 0, color: 'var(--text-primary)' }}>LunchLineup</div>
                <div className="workspace-kicker">Workforce Ops</div>
              </div>
            </div>
          </div>

          <div style={{ padding: '0.8rem 0.8rem 0.6rem' }}>
            <div
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
              }}
            >
              <Store size={14} />
              {user?.tenantName || 'Team Workspace'}
            </div>
          </div>

          <nav style={{ padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
            {visibleNavItems.map((item) => {
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
            <Link
              href="/auth/logout"
              prefetch={false}
              className="workspace-mobile-signout btn btn-secondary btn-sm"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={16} aria-hidden="true" />
            </Link>
            <NotificationsMenu
              notificationsOpen={notificationsOpen}
              notifications={notifications}
              unreadCount={unreadCount}
              onOpenChange={setNotificationsOpen}
              onMarkOneAsRead={markOneAsRead}
              onMarkAllAsRead={markAllAsRead}
            />

            {canOpenAccountSettings ? (
              <Link
                href="/dashboard/settings"
                aria-label="Account settings"
                title="Account settings"
                style={{
                  border: '1px solid var(--border)',
                  background: '#ffffff',
                  borderRadius: 999,
                  padding: '0.2rem 0.35rem 0.2rem 0.2rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
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
                  {getDashboardUserInitials(user)}
                </span>
                <span style={{ fontSize: '0.76rem', fontWeight: 700, color: 'var(--text-primary)' }}>{user?.name || user?.username || 'Account'}</span>
                <Settings size={14} style={{ color: 'var(--text-muted)' }} />
              </Link>
            ) : (
              <div
                aria-label="Account"
                style={{
                  border: '1px solid var(--border)',
                  background: '#ffffff',
                  borderRadius: 999,
                  padding: '0.2rem 0.35rem 0.2rem 0.2rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
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
                  {getDashboardUserInitials(user)}
                </span>
                <span style={{ fontSize: '0.76rem', fontWeight: 700, color: 'var(--text-primary)' }}>{user?.name || user?.username || 'Account'}</span>
              </div>
            )}
          </div>
        </header>

        <main className="workspace-content">{children}</main>
      </section>
    </div>
  );
}
