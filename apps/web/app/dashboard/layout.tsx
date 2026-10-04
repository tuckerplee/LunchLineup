'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { fetchJsonWithSession, fetchWithSession } from '@/lib/client-api';
import { handleLogoutNavigation } from '@/lib/logout-navigation';
import {
  LogOut,
  Settings,
  Store,
} from 'lucide-react';
import { NotificationsMenu, type DashboardNotification } from './NotificationsMenu';
import { DashboardMobileNavigation } from './DashboardMobileNavigation';
import {
  canOpenDashboardAccountSettings,
  getDashboardCurrentPage,
  getDashboardMobileNavGroups,
  getDashboardUserInitials,
  getVisibleDashboardNavItems,
} from './dashboard-navigation';

type DashboardRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type DashboardUser = {
  publicUserId: string;
  role: DashboardRole;
  permissions?: string[];
  roleLabel?: string;
  workspaceName?: string;
  workspaceScope: string;
  sessionScope: string;
  email?: string | null;
  username?: string | null;
  name?: string | null;
};

type NotificationFeed = { data: DashboardNotification[]; unreadCount: number };
const notificationTypes = new Set(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'SCHEDULE_PUBLISHED', 'SHIFT_ASSIGNED', 'SHIFT_CHANGED']);
const publicNotificationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i;
const notificationRefreshError = 'Notifications could not be refreshed. Previously loaded messages may be out of date.';
const savedNotificationRefreshError = 'Read status was saved, but notifications could not be refreshed. Retry to refresh the saved state.';
const confirmedNotificationRefreshError = 'Read status was confirmed, but notifications could not be refreshed. Retry to refresh the saved state.';

function notificationScope(user: DashboardUser | null): string | null {
  if (!user || [user.publicUserId, user.workspaceScope, user.sessionScope].some(value => typeof value !== 'string' || !value)) return null;
  return JSON.stringify([user.publicUserId, user.workspaceScope, user.sessionScope]);
}

function notificationRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function notificationInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function parseNotificationFeed(value: unknown): NotificationFeed {
  if (!notificationRecord(value) || !Array.isArray(value.data) || value.data.length > 100
    || !Number.isSafeInteger(value.unreadCount) || (value.unreadCount as number) < 0
    || value.data.some(row => !notificationRecord(row) || typeof row.id !== 'string' || !publicNotificationId.test(row.id)
      || typeof row.type !== 'string' || !notificationTypes.has(row.type)
      || typeof row.title !== 'string' || typeof row.body !== 'string'
      || !notificationInstant(row.createdAt) || (row.readAt !== null && !notificationInstant(row.readAt)))
    || new Set(value.data.map(row => row.id)).size !== value.data.length) {
    throw new Error('The notification feed could not be confirmed.');
  }
  return { data: value.data as DashboardNotification[], unreadCount: value.unreadCount as number };
}

function parseNotificationMutation(value: unknown, all: boolean): { updated: number; unreadCount: number } {
  if (!notificationRecord(value) || !Number.isSafeInteger(value.updated) || (value.updated as number) < 0
    || (!all && (value.updated as number) > 1)
    || !Number.isSafeInteger(value.unreadCount) || (value.unreadCount as number) < 0
    || (all && (value.success !== true || value.unreadCount !== 0))) {
    throw new Error('The notification update response could not be confirmed.');
  }
  return { updated: value.updated as number, unreadCount: value.unreadCount as number };
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<DashboardUser | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState<DashboardNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [notificationBusy, setNotificationBusy] = useState(false);

  const notificationContextRef = useRef({ mounted: false, generation: 0, scope: null as string | null });
  const notificationFeedRef = useRef<AbortController | null>(null);
  const notificationActionRef = useRef<{ controller: AbortController; scope: string } | null>(null);

  function getCsrfToken(): string {
    if (typeof document === 'undefined') return '';
    const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
    return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
  }

  function invalidateNotificationFeed(): number {
    notificationFeedRef.current?.abort();
    notificationFeedRef.current = null;
    return ++notificationContextRef.current.generation;
  }

  function currentNotificationScope(scope: string): boolean {
    const context = notificationContextRef.current;
    return context.mounted && context.scope === scope;
  }

  async function refreshNotifications(scope: string, failureMessage = notificationRefreshError): Promise<void> {
    if (!currentNotificationScope(scope)) return;
    const generation = invalidateNotificationFeed();
    const controller = new AbortController();
    notificationFeedRef.current = controller;
    const current = () => currentNotificationScope(scope)
      && notificationContextRef.current.generation === generation && !controller.signal.aborted;
    try {
      const payload = await fetchJsonWithSession<unknown>('/notifications?status=all&limit=20', { signal: controller.signal });
      if (!current()) return;
      const feed = parseNotificationFeed(payload);
      setNotifications(feed.data);
      setUnreadCount(feed.unreadCount);
      setNotificationError(null);
    } catch {
      if (current()) setNotificationError(failureMessage);
    } finally {
      if (notificationFeedRef.current === controller) notificationFeedRef.current = null;
    }
  }

  useEffect(() => {
    const context = notificationContextRef.current;
    context.mounted = true;
    context.scope = null;
    const generation = invalidateNotificationFeed();
    const identityController = new AbortController();
    async function loadHeaderData() {
      try {
        const me = await fetchJsonWithSession<{ user?: DashboardUser }>('/auth/me', { signal: identityController.signal });
        if (!context.mounted || context.generation !== generation || identityController.signal.aborted) return;
        const nextUser = me.user ?? null;
        const scope = notificationScope(nextUser);
        context.scope = scope;
        setUser(nextUser);
        if (scope) await refreshNotifications(scope);
        else { setNotifications([]); setUnreadCount(0); }
      } catch {
        if (context.mounted && context.generation === generation && !identityController.signal.aborted) {
          context.scope = null;
          setUser(null);
          setNotifications([]);
          setUnreadCount(0);
        }
      }
    }
    void loadHeaderData();
    const interval = window.setInterval(() => {
      if (!context.scope || notificationActionRef.current || notificationFeedRef.current) return;
      void refreshNotifications(context.scope);
    }, 45000);
    return () => {
      context.mounted = false;
      context.scope = null;
      invalidateNotificationFeed();
      identityController.abort();
      notificationActionRef.current?.controller.abort();
      notificationActionRef.current = null;
      window.clearInterval(interval);
    };
  }, []);

  async function retryNotifications() {
    const scope = notificationScope(user);
    if (!scope || !currentNotificationScope(scope) || notificationActionRef.current) return;
    const action = { controller: new AbortController(), scope };
    notificationActionRef.current = action;
    setNotificationBusy(true);
    try { await refreshNotifications(scope); }
    finally {
      if (notificationActionRef.current === action && currentNotificationScope(scope)) {
        notificationActionRef.current = null;
        setNotificationBusy(false);
      }
    }
  }

  async function mutateNotificationRead(notificationId?: string) {
    const scope = notificationScope(user);
    if (!scope || !currentNotificationScope(scope) || notificationActionRef.current) return;
    if (notificationId !== undefined && !notifications.some(row => row.id === notificationId && row.readAt === null)) return;
    const all = notificationId === undefined;
    const action = { controller: new AbortController(), scope };
    notificationActionRef.current = action;
    invalidateNotificationFeed();
    setNotificationBusy(true);
    setNotificationError(null);
    const current = () => notificationActionRef.current === action && currentNotificationScope(scope) && !action.controller.signal.aborted;
    try {
      const csrf = getCsrfToken();
      const response = await fetchWithSession(all ? '/notifications/read-all' : '/notifications/read', {
        method: 'POST',
        signal: action.controller.signal,
        headers: {
          ...(!all ? { 'Content-Type': 'application/json' } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        ...(!all ? { body: JSON.stringify({ ids: [notificationId] }) } : {}),
      });
      if (!current()) return;
      if (!response.ok) throw new Error('Notification update could not be confirmed.');
      const payload: unknown = await response.json();
      if (!current()) return;
      const result = parseNotificationMutation(payload, all);
      setUnreadCount(result.unreadCount);
      // Saved timestamps and concurrent arrivals come from readback, never from the browser clock.
      await refreshNotifications(scope, result.updated > 0 ? savedNotificationRefreshError : confirmedNotificationRefreshError);
    } catch {
      if (current()) setNotificationError('Notification update could not be confirmed. Retry to refresh the saved state.');
    } finally {
      if (current()) {
        notificationActionRef.current = null;
        setNotificationBusy(false);
      }
    }
  }

  async function markOneAsRead(notificationId: string) { await mutateNotificationRead(notificationId); }
  async function markAllAsRead() { await mutateNotificationRead(); }

  const visibleNavItems = useMemo(() => getVisibleDashboardNavItems(user?.permissions), [user?.permissions]);
  const mobileNavGroups = useMemo(() => getDashboardMobileNavGroups(user?.permissions), [user?.permissions]);
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
              {user?.workspaceName || 'Team Workspace'}
            </div>
          </div>

          <nav className="workspace-desktop-navigation" aria-label="Workspace navigation" style={{ padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
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

          <DashboardMobileNavigation pathname={pathname} {...mobileNavGroups} />

          <div style={{ borderTop: '1px solid var(--border)', padding: '0.8rem' }}>
            <a href="/auth/logout" onClick={handleLogoutNavigation} className="workspace-nav-link" style={{ justifyContent: 'flex-start' }}>
              <LogOut size={16} />
              Sign out
            </a>
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
            <a
              href="/auth/logout"
              onClick={handleLogoutNavigation}
              className="workspace-mobile-signout btn btn-secondary btn-sm"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={16} aria-hidden="true" />
            </a>
            <NotificationsMenu
              error={notificationError}
              busy={notificationBusy}
              onRetry={retryNotifications}
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
