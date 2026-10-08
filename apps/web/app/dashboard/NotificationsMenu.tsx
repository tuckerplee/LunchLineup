'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X } from 'lucide-react';

export type DashboardNotification = {
  id: string;
  type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'SCHEDULE_PUBLISHED' | 'SHIFT_ASSIGNED' | 'SHIFT_CHANGED';
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

type NotificationsMenuProps = {
  error?: string | null;
  busy?: boolean;
  onRetry: () => void | Promise<void>;
  notificationsOpen: boolean;
  notifications: DashboardNotification[];
  unreadCount: number;
  onOpenChange: (open: boolean) => void;
  onMarkOneAsRead: (notificationId: string) => void | Promise<void>;
  onMarkAllAsRead: () => void | Promise<void>;
};

const toneByType: Record<DashboardNotification['type'], string> = {
  INFO: 'var(--text-muted)',
  SUCCESS: 'var(--teal)',
  WARNING: 'var(--amber)',
  ERROR: 'var(--rose)',
  SCHEDULE_PUBLISHED: '#2f63ff',
  SHIFT_ASSIGNED: '#2f63ff',
  SHIFT_CHANGED: 'var(--amber)',
};

function formatRelative(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

export function NotificationsMenu({
  error, busy, onRetry,
  notificationsOpen,
  notifications,
  unreadCount,
  onOpenChange,
  onMarkOneAsRead,
  onMarkAllAsRead,
}: NotificationsMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const closeNotifications = useCallback(() => {
    onOpenChange(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onOpenChange]);

  // Portal past the topbar's backdrop-filter containing block; align to the bell
  // while keeping the complete dialog inside the visible viewport.
  useLayoutEffect(() => {
    if (!notificationsOpen) return;
    const positionDialog = () => {
      const dialog = dialogRef.current;
      const trigger = triggerRef.current;
      if (!dialog || !trigger) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const gutter = 12;
      const dialogWidth = Math.min(320, width - gutter * 2);
      const anchor = trigger.getBoundingClientRect();
      const dialogTop = Math.max(top + gutter, Math.min(anchor.bottom + 8, top + height - 160));
      Object.assign(dialog.style, {
        left: `${Math.max(left + gutter, Math.min(anchor.right - dialogWidth, left + width - dialogWidth - gutter))}px`,
        top: `${dialogTop}px`,
        width: `${dialogWidth}px`,
        maxHeight: `${Math.max(0, top + height - dialogTop - gutter)}px`,
      });
    };
    positionDialog();
    window.addEventListener('resize', positionDialog);
    window.addEventListener('scroll', positionDialog, true);
    window.visualViewport?.addEventListener('resize', positionDialog);
    window.visualViewport?.addEventListener('scroll', positionDialog);
    return () => {
      window.removeEventListener('resize', positionDialog);
      window.removeEventListener('scroll', positionDialog, true);
      window.visualViewport?.removeEventListener('resize', positionDialog);
      window.visualViewport?.removeEventListener('scroll', positionDialog);
    };
  }, [notificationsOpen]);

  useEffect(() => {
    if (!notificationsOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const selector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(selector))
      .filter((element) => !element.hasAttribute('disabled') && element.tabIndex >= 0);
    (focusableElements()[0] ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeNotifications();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [closeNotifications, notificationsOpen]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        id="notification-bell"
        ref={triggerRef}
        type="button"
        aria-label="Notifications"
        aria-controls={notificationsOpen ? 'notifications-dialog' : undefined}
        aria-expanded={notificationsOpen}
        aria-haspopup="dialog"
        onClick={() => notificationsOpen ? closeNotifications() : onOpenChange(true)}
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
        <Bell size={17} aria-hidden="true" />
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
      {notificationsOpen ? createPortal(
        <div
          id="notifications-dialog"
          ref={dialogRef}
          className="surface-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notifications-dialog-title"
          tabIndex={-1}
          style={{
            position: 'fixed',
            zIndex: 120,
            boxSizing: 'border-box',
            overflow: 'hidden',
            padding: '0.75rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.55rem',
          }}
        >
          <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem' }}>
            <div id="notifications-dialog-title" style={{ fontSize: '0.86rem', fontWeight: 750, color: 'var(--text-primary)' }}>
              Notifications
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <button
                type="button"
                aria-label="Close notifications"
                title="Close notifications"
                onClick={closeNotifications}
                className="btn btn-ghost btn-sm"
                style={{ width: 30, height: 30, padding: 0, display: 'grid', placeItems: 'center' }}
              >
                <X size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => void onMarkAllAsRead()}
                disabled={busy || unreadCount === 0}
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
          </div>
          <div style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'grid', gap: '0.55rem', overflowWrap: 'anywhere' }}>
          {error ? <div role="alert" style={{ color: '#b42318', fontSize: '0.8rem' }}>
            {error} <button type="button" disabled={busy} onClick={() => void onRetry()}>Retry notifications</button>
          </div> : null}
          {notifications.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy || Boolean(item.readAt)}
              onClick={() => void onMarkOneAsRead(item.id)}
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
              <span
                className="status-dot"
                style={{ marginTop: 6, background: toneByType[item.type] ?? 'var(--text-muted)' }}
                aria-hidden="true"
              />
              <span style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <span style={{ fontSize: '0.76rem', color: 'var(--text-primary)', fontWeight: 750 }}>{item.title}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{item.body}</span>
                <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 700 }}>{formatRelative(item.createdAt)}</span>
              </span>
            </button>
          ))}
          {notifications.length === 0 && !error ? (
            <div className="surface-muted" style={{ padding: '0.65rem', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>
              No notifications yet.
            </div>
          ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}