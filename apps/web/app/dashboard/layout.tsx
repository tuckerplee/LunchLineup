'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Bell, CalendarDays, LayoutGrid, LogOut, MapPin, Settings, Store, Users, UtensilsCrossed } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Overview', icon: LayoutGrid, exact: true },
  { href: '/dashboard/scheduling', label: 'Scheduling', icon: CalendarDays, exact: false },
  { href: '/dashboard/lunch-breaks', label: 'Lunch/Breaks', icon: UtensilsCrossed, exact: false },
  { href: '/dashboard/staff', label: 'Staff', icon: Users, exact: false },
  { href: '/dashboard/locations', label: 'Locations', icon: MapPin, exact: false },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings, exact: false },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [notifCount] = useState(2);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      {/* ── Sidebar ── */}
      <aside style={{
        width: 220, flexShrink: 0,
        background: 'var(--bg-elevated)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        padding: '0',
      }}>
        {/* Logo */}
        <div style={{
          padding: '1.25rem 1.25rem 0',
          borderBottom: '1px solid var(--border)',
          paddingBottom: '1.25rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{
              width: 28, height: 28, borderRadius: 7,
              background: 'linear-gradient(135deg, #5c7cfa, #748ffc)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.875rem',
            }}><UtensilsCrossed size={14} /></div>
            <span style={{ fontWeight: 800, fontSize: '0.9375rem', color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
              LunchLineup
            </span>
          </div>
        </div>

        {/* Location pill / tenant selector */}
        <div style={{ padding: '0.875rem 1rem' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.5rem 0.75rem',
            background: 'rgba(92, 124, 250, 0.08)',
            border: '1px solid rgba(92, 124, 250, 0.2)',
            borderRadius: 8, cursor: 'pointer',
          }}>
            <span style={{ fontSize: '0.6875rem', color: 'var(--brand)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              <Store size={12} style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} />
              Downtown Bistro
            </span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.75rem' }}>▾</span>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '0.25rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.625rem',
                  padding: '0.5625rem 0.75rem',
                  borderRadius: 8,
                  textDecoration: 'none',
                  fontSize: '0.875rem', fontWeight: isActive ? 600 : 400,
                  color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                  background: isActive ? 'rgba(92, 124, 250, 0.12)' : 'transparent',
                  border: isActive ? '1px solid rgba(92, 124, 250, 0.2)' : '1px solid transparent',
                  transition: 'all 150ms',
                }}
              >
                <span style={{ width: 20, textAlign: 'center', display: 'inline-flex', justifyContent: 'center' }}>
                  <Icon size={16} />
                </span>
                {item.label}
                {isActive && (
                  <span style={{
                    marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%',
                    background: 'var(--brand)',
                  }} />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Bottom */}
        <div style={{
          padding: '1rem 0.75rem',
          borderTop: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: '4px',
        }}>
          <Link href="/auth/logout" prefetch={false} style={{
            display: 'flex', alignItems: 'center', gap: '0.625rem',
            padding: '0.5625rem 0.75rem',
            borderRadius: 8, textDecoration: 'none',
            fontSize: '0.875rem', color: 'var(--text-muted)',
            transition: 'all 150ms',
          }}>
            <LogOut size={16} /> Sign out
          </Link>
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top header */}
        <header style={{
          height: 56,
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          padding: '0 1.5rem', gap: '0.875rem',
          background: 'var(--bg-elevated)',
          flexShrink: 0,
        }}>
          {/* Notification bell */}
          <button id="notification-bell" style={{
            position: 'relative', background: 'none', border: 'none',
            cursor: 'pointer', padding: 6, borderRadius: 8,
            color: 'var(--text-muted)', fontSize: '1.125rem',
            transition: 'all 150ms',
          }}>
            <Bell size={18} />
            {notifCount > 0 && (
              <span style={{
                position: 'absolute', top: 2, right: 2,
                width: 16, height: 16, borderRadius: '50%',
                background: 'var(--rose)', color: 'white',
                fontSize: '0.625rem', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '2px solid var(--bg-elevated)',
              }}>{notifCount}</span>
            )}
          </button>

          {/* User avatar */}
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--brand), var(--emerald))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.75rem', fontWeight: 700, color: 'white',
            cursor: 'pointer',
          }}>
            AJ
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, overflowY: 'auto', padding: '1.5rem' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
