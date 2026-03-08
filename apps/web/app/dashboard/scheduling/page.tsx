'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { CalendarDays, Sparkles, WandSparkles } from 'lucide-react';
import type { SchedulerViewMode, StaffScheduleEvent } from '@/components/scheduling/StaffScheduler';

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

type SelectedShift = StaffScheduleEvent & { staffName: string };

type AutoPreview = {
  coverageGain: number;
  resolvedOpenShifts: number;
  mealRisks: number;
};

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

const EVENTS: StaffScheduleEvent[] = [
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

const BREAK_EVENTS: StaffScheduleEvent[] = [
  { id: 'b1', resourceId: 'r1', title: 'Lunch', start: wd(0, 13, 10), end: wd(0, 13, 45), extendedProps: { role: 'MANAGER', kind: 'lunch' } },
  { id: 'b2', resourceId: 'r2', title: 'Break', start: wd(2, 14, 20), end: wd(2, 14, 35), extendedProps: { role: 'CASHIER', kind: 'break' } },
  { id: 'b3', resourceId: 'r3', title: 'Lunch overdue', start: wd(4, 16, 30), end: wd(4, 17), extendedProps: { role: 'FLOOR', kind: 'lunch', conflict: 'Meal window risk' } },
  { id: 'b4', resourceId: 'r5', title: 'Break', start: wd(5, 18, 10), end: wd(5, 18, 25), extendedProps: { role: 'KITCHEN', kind: 'break' } },
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
  const [showFullDay, setShowFullDay] = useState(false);
  const [selectedShift, setSelectedShift] = useState<SelectedShift | null>(null);
  const [viewMode, setViewMode] = useState<SchedulerViewMode>('threeDay');
  const [autoPreview, setAutoPreview] = useState<AutoPreview | null>(null);
  const [scheduleEvents, setScheduleEvents] = useState<StaffScheduleEvent[]>([...EVENTS, ...BREAK_EVENTS]);

  useEffect(() => {
    const saved = localStorage.getItem('ll:schedule:viewMode') as SchedulerViewMode | null;
    if (saved === 'day' || saved === 'threeDay' || saved === 'week') setViewMode(saved);
  }, []);

  useEffect(() => {
    localStorage.setItem('ll:schedule:viewMode', viewMode);
  }, [viewMode]);

  const handleAutoSchedule = async () => {
    setIsAutoScheduling(true);
    await new Promise((r) => setTimeout(r, 900));
    setIsAutoScheduling(false);
    setAutoPreview({ coverageGain: 8, resolvedOpenShifts: 2, mealRisks: 0 });
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

  const filteredEvents = useMemo(
    () => scheduleEvents.filter((event) => !activeFilter || event.extendedProps.kind || event.extendedProps.role === activeFilter),
    [activeFilter, scheduleEvents]
  );

  const linkedBreaks = useMemo(() => {
    if (!selectedShift) return [] as StaffScheduleEvent[];
    return scheduleEvents.filter(
      (event) =>
        (event.extendedProps.kind === 'lunch' || event.extendedProps.kind === 'break') &&
        event.resourceId === selectedShift.resourceId &&
        new Date(event.start) >= new Date(selectedShift.start) &&
        new Date(event.end) <= new Date(selectedShift.end)
    );
  }, [scheduleEvents, selectedShift]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: '100%' }}>
      <section className="surface-card" style={{ padding: '1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '0.8rem', alignItems: 'start' }}>
          <div>
            <div className="workspace-kicker">Schedule workspace</div>
            <h1 className="workspace-title" style={{ fontSize: '1.6rem', marginBottom: 2 }}>
              Schedule Builder
            </h1>
            <p className="workspace-subtitle">Downtown Bistro · {weekLabel}</p>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'inline-flex', border: '1px solid #d6dfef', borderRadius: 999, overflow: 'hidden', background: '#f7f9ff' }}>
              {(['day', 'threeDay', 'week'] as SchedulerViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  style={{
                    border: 'none',
                    borderLeft: mode === 'day' ? 'none' : '1px solid #d6dfef',
                    background: viewMode === mode ? '#e8efff' : 'transparent',
                    color: viewMode === mode ? '#234ed9' : 'var(--text-secondary)',
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    padding: '0.24rem 0.54rem',
                    cursor: 'pointer',
                  }}
                >
                  {mode === 'threeDay' ? '3-Day' : mode === 'day' ? 'Day' : 'Week'}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
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
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
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
                  <WandSparkles size={13} />
                  Auto-Schedule Preview
                </>
              )}
            </Button>

            <Button variant={published ? 'success' : 'default'} size="sm" onClick={handlePublish} disabled={isPublishing || published}>
              {isPublishing ? 'Publishing...' : published ? 'Published' : 'Publish Schedule'}
            </Button>

            <Button variant="outline" size="sm" onClick={() => setShowFullDay((v) => !v)}>
              {showFullDay ? 'Compact Hours' : 'Show Full Day'}
            </Button>
          </div>
        </div>

        {autoPreview ? (
          <div
            style={{
              marginTop: '0.9rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '0.5rem 0.65rem',
              borderRadius: 10,
              border: '1px solid #cfe0ff',
              background: '#edf3ff',
              color: '#234ed9',
              fontSize: '0.78rem',
              fontWeight: 700,
              flexWrap: 'wrap',
            }}
          >
            <span>
              Preview: +{autoPreview.coverageGain}% coverage · {autoPreview.resolvedOpenShifts} open shifts resolved · {autoPreview.mealRisks} meal risks
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" onClick={() => setAutoPreview(null)}>
                Accept preview
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAutoPreview(null)}>
                Keep editing
              </Button>
            </div>
          </div>
        ) : (
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
            Drag shifts between staff and days. Coverage and risk preview updates live while dragging.
          </div>
        )}
      </section>

      <section
        style={{
          height: 'calc(100vh - 220px)',
          minHeight: 580,
          overflow: 'hidden',
          padding: 0,
          border: 'none',
          background: 'transparent',
          boxShadow: 'none',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 300px',
          gap: '0.75rem',
        }}
      >
        <div style={{ minWidth: 0, minHeight: 0 }}>
          <StaffScheduler
            resources={RESOURCES}
            events={filteredEvents}
            viewMode={viewMode}
            initialDate={WEEK_START.toISOString().split('T')[0]}
            compactWindow={!showFullDay}
            onEventSelect={(event) => {
              const staff = RESOURCES.find((resource) => resource.id === event.resourceId);
              setSelectedShift({ ...event, staffName: staff?.title ?? 'Unknown' });
            }}
            onEventChange={(id, start, end, resourceId) => {
              setScheduleEvents((prev) =>
                prev.map((event) => (event.id === id ? { ...event, start, end, resourceId } : event))
              );
              setSelectedShift((prev) => (prev && prev.id === id ? { ...prev, start, end, resourceId } : prev));
            }}
          />
        </div>

        <aside className="surface-card" style={{ padding: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          <h3 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 800 }}>Shift inspector</h3>
          {!selectedShift ? (
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              Select a shift to inspect meal timing, compliance, and coverage impact.
            </p>
          ) : (
            <>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {selectedShift.staffName}
              </div>
              <div style={{ fontSize: '0.92rem', fontWeight: 800, marginTop: -2 }}>{selectedShift.title}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {new Date(selectedShift.start).toLocaleString('en-US', {
                  weekday: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}{' '}
                -{' '}
                {new Date(selectedShift.end).toLocaleString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
                Role: {selectedShift.extendedProps.role}
              </div>
              <div style={{ borderTop: '1px solid #e4e9f4', paddingTop: 8, fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                <div>Lunch: {linkedBreaks.find((b) => b.extendedProps.kind === 'lunch') ? 'Scheduled' : 'Not scheduled'}</div>
                <div>Breaks: {linkedBreaks.filter((b) => b.extendedProps.kind === 'break').length}</div>
                <div>Coverage impact if moved: +1 slot likely in dinner window</div>
              </div>
              <div
                style={{
                  marginTop: 4,
                  borderTop: '1px solid #e4e9f4',
                  paddingTop: 8,
                  fontSize: '0.75rem',
                  color: selectedShift.extendedProps.conflict ? '#b2454c' : '#4f648b',
                  fontWeight: 700,
                }}
              >
                {selectedShift.extendedProps.conflict ? `Compliance risk: ${selectedShift.extendedProps.conflict}` : 'Compliance status: healthy'}
              </div>
              <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
                <Button size="sm" variant="outline">Move shift</Button>
                <Button size="sm" variant="outline">Add meal</Button>
                <Button size="sm" variant="outline">Adjust role</Button>
                <Button size="sm" variant="outline">Duplicate next day</Button>
              </div>
            </>
          )}
        </aside>
      </section>
    </div>
  );
}
