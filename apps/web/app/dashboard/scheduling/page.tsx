'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { CalendarDays, Sparkles } from 'lucide-react';

const StaffScheduler = dynamic(
  () => import('@/components/scheduling/StaffScheduler').then((m) => m.StaffScheduler),
  {
    ssr: false,
    loading: () => (
      <div className="surface-card" style={{ minHeight: 520, padding: '1rem' }}>
        <div className="skeleton" style={{ height: 24, width: 180, marginBottom: '1rem' }} />
        <div className="skeleton" style={{ height: 420, width: '100%' }} />
      </div>
    ),
  }
);

const TODAY = new Date();
const WEEK_START = new Date(TODAY);
WEEK_START.setDate(TODAY.getDate() - ((TODAY.getDay() + 6) % 7));

const wd = (offsetDays: number, h: number, m = 0) => {
  const d = new Date(WEEK_START);
  d.setDate(d.getDate() + offsetDays);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const RESOURCES = [
  { id: 'r1', title: 'Alice J.', role: 'MANAGER', avatarInitials: 'AJ', hue: 220 },
  { id: 'r2', title: 'Bob T.', role: 'CASHIER', avatarInitials: 'BT', hue: 160 },
  { id: 'r3', title: 'Casey L.', role: 'FLOOR', avatarInitials: 'CL', hue: 40 },
  { id: 'r4', title: 'Riley P.', role: 'SERVER', avatarInitials: 'RP', hue: 270 },
  { id: 'r5', title: 'Jordan M.', role: 'KITCHEN', avatarInitials: 'JM', hue: 340 },
];

const EVENTS = [
  { id: 'e1', resourceId: 'r1', title: 'Manager', start: wd(0, 9), end: wd(0, 17), extendedProps: { role: 'MANAGER' } },
  { id: 'e2', resourceId: 'r1', title: 'Manager', start: wd(1, 9), end: wd(1, 17), extendedProps: { role: 'MANAGER' } },
  { id: 'e3', resourceId: 'r1', title: 'Manager', start: wd(3, 9), end: wd(3, 17), extendedProps: { role: 'MANAGER' } },
  { id: 'e4', resourceId: 'r1', title: 'Manager', start: wd(4, 9), end: wd(4, 17), extendedProps: { role: 'MANAGER' } },
  { id: 'e5', resourceId: 'r2', title: 'Cashier', start: wd(0, 10), end: wd(0, 18), extendedProps: { role: 'CASHIER' } },
  { id: 'e6', resourceId: 'r2', title: 'Cashier', start: wd(2, 10), end: wd(2, 18), extendedProps: { role: 'CASHIER' } },
  { id: 'e7', resourceId: 'r2', title: 'Cashier', start: wd(4, 10), end: wd(4, 15), extendedProps: { role: 'CASHIER' } },
  { id: 'e8', resourceId: 'r3', title: 'Floor', start: wd(0, 12), end: wd(0, 20), extendedProps: { role: 'FLOOR' } },
  { id: 'e9', resourceId: 'r3', title: 'Floor', start: wd(1, 12), end: wd(1, 20), extendedProps: { role: 'FLOOR' } },
  { id: 'e10', resourceId: 'r3', title: 'Floor', start: wd(5, 11), end: wd(5, 19), extendedProps: { role: 'FLOOR' } },
  { id: 'e11', resourceId: 'r4', title: 'Server', start: wd(2, 9), end: wd(2, 17), extendedProps: { role: 'SERVER' } },
  { id: 'e12', resourceId: 'r4', title: 'Server', start: wd(4, 9), end: wd(4, 17), extendedProps: { role: 'SERVER' } },
  { id: 'e13', resourceId: 'r4', title: 'Server', start: wd(6, 10), end: wd(6, 16), extendedProps: { role: 'SERVER' } },
  { id: 'e14', resourceId: 'r5', title: 'Kitchen', start: wd(0, 14), end: wd(0, 22), extendedProps: { role: 'KITCHEN' } },
  { id: 'e15', resourceId: 'r5', title: 'Kitchen', start: wd(2, 14), end: wd(2, 22), extendedProps: { role: 'KITCHEN' } },
  { id: 'e16', resourceId: 'r5', title: 'Kitchen', start: wd(5, 14), end: wd(5, 22), extendedProps: { role: 'KITCHEN' } },
];

const ROLE_COLORS: Record<string, string> = {
  MANAGER: '#2f63ff',
  CASHIER: '#17b26a',
  FLOOR: '#f59e0b',
  SERVER: '#8b5cf6',
  KITCHEN: '#e74867',
};

export default function SchedulingPage() {
  const [isAutoScheduling, setIsAutoScheduling] = useState(false);
  const [published, setPublished] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);

  const handleAutoSchedule = async () => {
    setIsAutoScheduling(true);
    await new Promise((r) => setTimeout(r, 1500));
    setIsAutoScheduling(false);
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    await new Promise((r) => setTimeout(r, 1000));
    setIsPublishing(false);
    setPublished(true);
  };

  const weekLabel = useMemo(() => {
    const weekStartLabel = WEEK_START.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const weekEnd = new Date(WEEK_START);
    weekEnd.setDate(WEEK_START.getDate() + 6);
    const weekEndLabel = weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${weekStartLabel} - ${weekEndLabel}`;
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: '100%' }}>
      <section className="surface-card" style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <div className="workspace-kicker">Schedule workspace</div>
            <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
              Schedule Builder
            </h1>
            <p className="workspace-subtitle">Downtown Bistro · {weekLabel}</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 4, flexWrap: 'wrap' }}>
              {Object.entries(ROLE_COLORS).map(([role, color]) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => setActiveFilter((f) => (f === role ? null : role))}
                  style={{
                    border: `1px solid ${activeFilter === role ? color : 'var(--border)'}`,
                    background: activeFilter === role ? `${color}18` : '#ffffff',
                    color: activeFilter === role ? color : 'var(--text-secondary)',
                    borderRadius: 999,
                    padding: '0.24rem 0.6rem',
                    fontSize: '0.66rem',
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: color, display: 'inline-block' }} />
                  {role}
                </button>
              ))}
            </div>

            <Button variant="outline" size="sm" onClick={handleAutoSchedule} disabled={isAutoScheduling}>
              {isAutoScheduling ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ animation: 'spin 1s linear infinite' }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Optimizing...
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  Auto-Schedule
                </>
              )}
            </Button>

            <Button variant={published ? 'success' : 'default'} size="sm" onClick={handlePublish} disabled={isPublishing || published}>
              {isPublishing ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ animation: 'spin 1s linear infinite' }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Publishing...
                </>
              ) : published ? (
                'Published'
              ) : (
                'Publish'
              )}
            </Button>
          </div>
        </div>

        <div
          style={{
            marginTop: '0.9rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '0.45rem 0.6rem',
            borderRadius: 10,
            border: '1px solid #cfe0ff',
            background: '#edf3ff',
            color: '#234ed9',
            fontSize: '0.8rem',
            fontWeight: 600,
          }}
        >
          <CalendarDays size={14} />
          Drag shifts between staff and days. Changes sync in real time.
        </div>
      </section>

      <section className="surface-card" style={{ minHeight: 540, overflow: 'hidden', padding: '0.7rem' }}>
        <StaffScheduler
          resources={RESOURCES}
          events={EVENTS.filter((event) => !activeFilter || event.extendedProps.role === activeFilter)}
          initialDate={WEEK_START.toISOString().split('T')[0]}
          onEventChange={(id, start, end, resourceId) => {
            console.log('Shift moved:', { id, start, end, resourceId });
          }}
        />
      </section>
    </div>
  );
}
