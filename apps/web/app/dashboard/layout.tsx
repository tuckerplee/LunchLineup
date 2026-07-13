'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';
import {
  Bell,
  LogOut,
  Settings,
  Store,
} from 'lucide-react';
import {
  canOpenDashboardAccountSettings,
  getDashboardCurrentPage,
  getDashboardUserInitials,
  getVisibleDashboardNavItems,
} from './dashboard-navigation';

type DashboardRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type NotificationType = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'SCHEDULE_PUBLISHED' | 'SHIFT_ASSIGNED' | 'SHIFT_CHANGED';
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
type DashboardNotification = {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<DashboardUser | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<DashboardNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const toneByType: Record<NotificationType, string> = {
    INFO: 'var(--text-muted)',
    SUCCESS: 'var(--teal)',
    WARNING: 'var(--amber)',
    ERROR: 'var(--rose)',
    SCHEDULE_PUBLISHED: '#2f63ff',
    SHIFT_ASSIGNED: '#2f63ff',
    SHIFT_CHANGED: 'var(--amber)',
  };

  function getCsrfToken(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
  }

  function formatRelative(timestamp: string): string {
    const ms = Date.now() - new Date(timestamp).getTime();
    const minutes = Math.max(1, Math.floor(ms / 60000));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
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
                <div style={{ fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>LunchLineup</div>
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
            <Link
              href="/auth/logout"
              prefetch={false}
              className="workspace-mobile-signout btn btn-secondary btn-sm"
              aria-label="Sign out"
            >
              <LogOut size={16} />
              Sign out
            </Link>
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
                {unreadCount > 0 ? (
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
                    {unreadCount}
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem' }}>
                    <div style={{ fontSize: '0.86rem', fontWeight: 750, color: 'var(--text-primary)' }}>Notifications</div>
                    <button
                      type="button"
                      onClick={() => void markAllAsRead()}
                      disabled={unreadCount === 0}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: unreadCount === 0 ? 'var(--text-muted)' : '#2f63ff',
                        fontWeight: 700,
                        fontSize: '0.72rem',
                        cursor: unreadCount === 0 ? 'default' : 'pointer',
                      }}
                    >
                      Mark all read
                    </button>
                  </div>
                  {notifications.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => void markOneAsRead(item.id)}
                      className="surface-muted"
                      style={{
                        padding: '0.55rem',
                        display: 'flex',
                        gap: '0.45rem',
                        alignItems: 'flex-start',
                        border: '1px solid var(--border)',
                        textAlign: 'left',
                        background: item.readAt ? '#ffffff' : '#f8fbff',
                        cursor: item.readAt ? 'default' : 'pointer',
                      }}
                    >
                      <span className="status-dot" style={{ marginTop: 6, background: toneByType[item.type] ?? 'var(--text-muted)' }} />
                      <span style={{ display: 'grid', gap: 3 }}>
                        <span style={{ fontSize: '0.76rem', color: 'var(--text-primary)', fontWeight: 750 }}>{item.title}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{item.body}</span>
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 700 }}>{formatRelative(item.createdAt)}</span>
                      </span>
                    </button>
                  ))}
                  {notifications.length === 0 ? (
                    <div className="surface-muted" style={{ padding: '0.65rem', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                      No notifications yet.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

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
