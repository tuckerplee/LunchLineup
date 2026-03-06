'use client';

import Link from 'next/link';
import { ArrowRight, CalendarDays, Clock3, MapPin, Sparkles, Users } from 'lucide-react';

const STAT_CARDS = [
  {
    label: 'Active Staff',
    value: '42',
    delta: '+12% vs last week',
    tone: '#2f63ff',
    bg: 'linear-gradient(145deg, #edf3ff, #f7f9ff)',
    icon: Users,
  },
  {
    label: 'Shifts This Week',
    value: '148',
    delta: '92% covered',
    tone: '#17b26a',
    bg: 'linear-gradient(145deg, #e9fbf1, #f7fffb)',
    icon: CalendarDays,
  },
  {
    label: 'Open Shifts',
    value: '3',
    delta: 'Needs assignment',
    tone: '#e74867',
    bg: 'linear-gradient(145deg, #ffeef2, #fff8fa)',
    icon: Clock3,
  },
  {
    label: 'Locations',
    value: '2',
    delta: 'All online',
    tone: '#22b8cf',
    bg: 'linear-gradient(145deg, #e9fafe, #f6fdff)',
    icon: MapPin,
  },
];

const ACTIVITY_ITEMS = [
  { time: '2m ago', text: 'Alice J. accepted Monday manager shift', tone: 'var(--emerald)' },
  { time: '14m ago', text: 'Week of Mar 9 schedule was published', tone: 'var(--brand)' },
  { time: '1h ago', text: 'Bob T. requested shift swap for Friday 9am-5pm', tone: 'var(--amber)' },
  { time: '3h ago', text: 'Lunch stagger generated for dinner team', tone: 'var(--cyan)' },
  { time: 'Yesterday', text: 'Auto-scheduler reached 98% coverage', tone: 'var(--emerald)' },
];

const QUICK_ACTIONS = [
  {
    label: 'Build Weekly Schedule',
    desc: 'Assign and optimize shifts in one workspace',
    icon: '📅',
    href: '/dashboard/scheduling',
  },
  {
    label: 'Generate Lunch Plan',
    desc: 'Auto-stagger breaks with policy controls',
    icon: '🍱',
    href: '/dashboard/lunch-breaks',
  },
  {
    label: 'Invite a Team Member',
    desc: 'Add staff and assign roles instantly',
    icon: '👋',
    href: '/dashboard/staff',
  },
  {
    label: 'Add New Location',
    desc: 'Extend scheduling to another storefront',
    icon: '🏢',
    href: '/dashboard/locations',
  },
];

const FLOW_STEPS = ['Select location', 'Add shift data', 'Run schedule action', 'Review and publish'];

export default function DashboardPage() {
  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1420 }}>
      <section
        className="surface-card animate-fade-up"
        style={{
          padding: '1.6rem',
          background:
            'radial-gradient(35rem 18rem at 0% 0%, rgba(79,121,255,0.16), transparent 60%), radial-gradient(28rem 14rem at 100% 100%, rgba(34,184,207,0.14), transparent 60%), #ffffff',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 660 }}>
            <div className="badge badge-brand" style={{ marginBottom: '0.8rem' }}>
              <Sparkles size={13} /> Live workspace
            </div>
            <h1 className="workspace-title" style={{ marginBottom: '0.35rem' }}>
              Welcome back, Alex
            </h1>
            <p className="workspace-subtitle">
              {todayLabel} · Downtown Bistro. Your team has strong coverage today and just 3 open shifts.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            <Link href="/dashboard/scheduling" className="btn btn-primary">
              New Schedule
              <ArrowRight size={14} />
            </Link>
            <Link href="/dashboard/lunch-breaks" className="btn btn-secondary">
              Plan Lunches
            </Link>
          </div>
        </div>

        <div
          style={{
            marginTop: '1rem',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: '0.75rem',
          }}
        >
          {FLOW_STEPS.map((step, i) => (
            <div key={step} className="surface-muted" style={{ padding: '0.65rem 0.75rem', display: 'flex', gap: '0.55rem' }}>
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  background: i === FLOW_STEPS.length - 1 ? 'var(--brand)' : '#d8e3ff',
                  color: i === FLOW_STEPS.length - 1 ? '#ffffff' : '#2f63ff',
                  fontSize: '0.76rem',
                  fontWeight: 700,
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{step}</span>
            </div>
          ))}
        </div>
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '0.9rem',
        }}
      >
        {STAT_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.label} className="surface-card animate-slide-up" style={{ padding: '1rem', background: card.bg }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.55rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', fontWeight: 600 }}>{card.label}</span>
                <span
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 12,
                    display: 'grid',
                    placeItems: 'center',
                    color: card.tone,
                    background: '#ffffff',
                    border: '1px solid rgba(0,0,0,0.05)',
                  }}
                >
                  <Icon size={16} />
                </span>
              </div>
              <div style={{ fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
                {card.value}
              </div>
              <div style={{ fontSize: '0.78rem', color: card.tone, fontWeight: 700 }}>{card.delta}</div>
            </article>
          );
        })}
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 0.8fr)',
          gap: '1rem',
        }}
      >
        <article className="surface-card" style={{ padding: '1.2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)' }}>Weekly Coverage Snapshot</h2>
            <Link href="/dashboard/scheduling" className="text-sm text-brand" style={{ fontWeight: 700 }}>
              Open scheduler
            </Link>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '0.5rem' }}>
            {[
              { day: 'Mon', value: 8, target: 10 },
              { day: 'Tue', value: 10, target: 10 },
              { day: 'Wed', value: 7, target: 10 },
              { day: 'Thu', value: 9, target: 10 },
              { day: 'Fri', value: 10, target: 10 },
              { day: 'Sat', value: 6, target: 10 },
              { day: 'Sun', value: 4, target: 10 },
            ].map((d) => (
              <div key={d.day} style={{ display: 'grid', gap: 6 }}>
                <div
                  style={{
                    height: 120,
                    borderRadius: 12,
                    border: '1px solid var(--border)',
                    background: '#f8faff',
                    display: 'flex',
                    alignItems: 'flex-end',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: `${(d.value / d.target) * 100}%`,
                      width: '100%',
                      borderRadius: 10,
                      background:
                        d.value >= d.target
                          ? 'linear-gradient(180deg, #2f63ff, #446fff)'
                          : d.value >= 8
                            ? 'linear-gradient(180deg, #17b26a, #16a366)'
                            : 'linear-gradient(180deg, #f59e0b, #dc8b08)',
                      transition: 'height 550ms var(--ease-out)',
                    }}
                  />
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700 }}>{d.day}</div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', fontWeight: 700 }}>{d.value} staff</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Coverage Rate</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--emerald)', fontWeight: 700 }}>87%</span>
            </div>
            <div style={{ height: 10, borderRadius: 999, background: '#edf2ff', overflow: 'hidden' }}>
              <div
                style={{
                  width: '87%',
                  height: '100%',
                  borderRadius: 999,
                  background: 'linear-gradient(90deg, #17b26a 0%, #2f63ff 75%)',
                }}
              />
            </div>
          </div>
        </article>

        <article className="surface-card" style={{ padding: '1.2rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)', marginBottom: '1rem' }}>
            Team Activity
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            {ACTIVITY_ITEMS.map((item) => (
              <div key={item.text} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                <span className="status-dot" style={{ marginTop: 7, background: item.tone }} />
                <div>
                  <p style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{item.text}</p>
                  <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{item.time}</span>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.85rem' }}>
        {QUICK_ACTIONS.map((action) => (
          <Link key={action.label} href={action.href} className="surface-card" style={{ padding: '0.95rem', display: 'flex', gap: '0.75rem' }}>
            <span
              style={{
                width: 42,
                height: 42,
                borderRadius: 12,
                border: '1px solid #cfe0ff',
                background: '#edf3ff',
                display: 'grid',
                placeItems: 'center',
                fontSize: '1.15rem',
                flexShrink: 0,
              }}
            >
              {action.icon}
            </span>
            <div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>{action.label}</div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{action.desc}</div>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
