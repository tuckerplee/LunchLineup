'use client';

import Link from 'next/link';

const STAT_CARDS = [
  { label: 'Active Staff', value: '42', delta: '+12%', deltaColor: 'var(--emerald)', icon: '👥', iconBg: 'rgba(92, 124, 250, 0.12)', iconBorder: 'rgba(92, 124, 250, 0.2)' },
  { label: 'Shifts This Week', value: '148', delta: 'scheduled', deltaColor: 'var(--text-muted)', icon: '📋', iconBg: 'rgba(16, 185, 129, 0.1)', iconBorder: 'rgba(16, 185, 129, 0.2)' },
  { label: 'Open Shifts', value: '3', delta: 'Requires action', deltaColor: 'var(--rose)', icon: '⚠️', iconBg: 'rgba(244, 63, 94, 0.1)', iconBorder: 'rgba(244, 63, 94, 0.2)' },
  { label: 'Locations', value: '2', delta: 'Active', deltaColor: 'var(--text-muted)', icon: '📍', iconBg: 'rgba(245, 158, 11, 0.1)', iconBorder: 'rgba(245, 158, 11, 0.2)' },
];

const ACTIVITY_ITEMS = [
  { time: '2m ago', text: 'Alice J. accepted Monday shift', color: 'var(--emerald)' },
  { time: '14m ago', text: 'Schedule "Week of Mar 10" published', color: 'var(--brand)' },
  { time: '1h ago', text: 'Bob T. requested shift swap — Friday 9–5', color: 'var(--amber)' },
  { time: '3h ago', text: 'Casey L. clocked out 17:02', color: 'var(--text-muted)' },
  { time: 'Yesterday', text: 'Auto-schedule completed — 98% coverage', color: 'var(--emerald)' },
];

export default function DashboardPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1400 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>
            Dashboard
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Wednesday, March 4, 2026 · Downtown Bistro
          </p>
        </div>
        <Link href="/dashboard/scheduling" style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.5625rem 1.125rem',
          background: 'linear-gradient(135deg, #5c7cfa, #748ffc)',
          color: 'white', fontWeight: 600, fontSize: '0.875rem',
          borderRadius: 10, textDecoration: 'none',
          boxShadow: 'var(--shadow-brand)',
          transition: 'all 200ms',
        }}>
          + New Schedule
        </Link>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        {STAT_CARDS.map((card, i) => (
          <div key={i} style={{
            background: 'var(--bg-glass)',
            border: '1px solid var(--border)',
            borderRadius: 14, padding: '1.25rem',
            position: 'relative', overflow: 'hidden',
            transition: 'all 200ms var(--ease-out)',
            cursor: 'default',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', fontWeight: 500 }}>{card.label}</span>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: card.iconBg, border: `1px solid ${card.iconBorder}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem',
              }}>{card.icon}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
              <span style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.03em' }}>{card.value}</span>
              <span style={{ fontSize: '0.8125rem', fontWeight: 500, color: card.deltaColor }}>{card.delta}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Main content grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '1.25rem' }}>
        {/* Upcoming schedules */}
        <div style={{
          background: 'var(--bg-glass)', border: '1px solid var(--border)',
          borderRadius: 14, padding: '1.5rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
            <h2 style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>
              This Week at a Glance
            </h2>
            <Link href="/dashboard/scheduling" style={{
              fontSize: '0.8125rem', color: 'var(--brand)', fontWeight: 600, textDecoration: 'none',
            }}>View full schedule →</Link>
          </div>

          {/* Mini weekly bar chart */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '0.5rem' }}>
            {[
              { day: 'M', count: 8, max: 10 },
              { day: 'T', count: 10, max: 10 },
              { day: 'W', count: 7, max: 10 },
              { day: 'T', count: 9, max: 10 },
              { day: 'F', count: 10, max: 10 },
              { day: 'Sa', count: 6, max: 10 },
              { day: 'Su', count: 4, max: 10 },
            ].map((d, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.375rem' }}>
                <div style={{
                  width: '100%', borderRadius: 6, overflow: 'hidden',
                  height: 80, background: 'rgba(255,255,255,0.04)',
                  display: 'flex', alignItems: 'flex-end',
                }}>
                  <div style={{
                    width: '100%',
                    height: `${(d.count / d.max) * 100}%`,
                    background: d.count === d.max
                      ? 'linear-gradient(180deg, #5c7cfa, #4263eb)'
                      : d.count >= 8
                        ? 'linear-gradient(180deg, #10b981, #059669)'
                        : 'linear-gradient(180deg, #f59e0b, #d97706)',
                    borderRadius: 6,
                    transition: 'height 500ms var(--ease-out)',
                  }} />
                </div>
                <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', fontWeight: 500 }}>{d.day}</span>
                <span style={{ fontSize: '0.6875rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{d.count}</span>
              </div>
            ))}
          </div>

          {/* Coverage status bar */}
          <div style={{ marginTop: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Coverage</span>
              <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--emerald)' }}>87%</span>
            </div>
            <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: '87%',
                background: 'linear-gradient(90deg, #10b981, #5c7cfa)',
                borderRadius: 6,
              }} />
            </div>
          </div>

          {/* Staff coverage table mini */}
          <div style={{ marginTop: '1.25rem', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { name: 'Alice J.', role: 'Manager', shifts: 5, color: '#5c7cfa' },
              { name: 'Bob T.', role: 'Cashier', shifts: 4, color: '#10b981' },
              { name: 'Casey L.', role: 'Floor', shifts: 3, color: '#f59e0b' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem', borderRadius: 8, background: 'rgba(255,255,255,0.03)' }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                  background: `${s.color}22`, border: `1px solid ${s.color}44`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.6875rem', fontWeight: 700, color: s.color,
                }}>
                  {s.name.split(' ').map(n => n[0]).join('')}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>{s.name}</div>
                  <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>{s.role}</div>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.shifts} shifts</span>
              </div>
            ))}
          </div>
        </div>

        {/* Activity feed */}
        <div style={{
          background: 'var(--bg-glass)', border: '1px solid var(--border)',
          borderRadius: 14, padding: '1.5rem',
        }}>
          <h2 style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)', marginBottom: '1.25rem' }}>
            Activity
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {ACTIVITY_ITEMS.map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: item.color, marginTop: 5,
                }} />
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{item.text}</p>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{item.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Quick actions row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
        {[
          { label: 'Build new schedule', icon: '📅', href: '/dashboard/scheduling', desc: 'Open the drag-and-drop scheduler' },
          { label: 'Add staff member', icon: '👤', href: '/dashboard/staff', desc: 'Invite or create a new employee' },
          { label: 'Add location', icon: '🏢', href: '/dashboard/locations', desc: 'Register a new restaurant location' },
        ].map((action, i) => (
          <Link key={i} href={action.href} style={{
            display: 'flex', alignItems: 'center', gap: '0.875rem',
            padding: '1rem 1.125rem',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid var(--border)',
            borderRadius: 12, textDecoration: 'none',
            transition: 'all 200ms var(--ease-out)',
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(92, 124, 250, 0.1)',
              border: '1px solid rgba(92, 124, 250, 0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.25rem',
              flexShrink: 0,
            }}>{action.icon}</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--text-primary)', marginBottom: '0.125rem' }}>{action.label}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{action.desc}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
