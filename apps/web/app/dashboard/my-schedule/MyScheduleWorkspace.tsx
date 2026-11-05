'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Clock3, MapPin, RefreshCw, UtensilsCrossed } from 'lucide-react';

import { apiV2 } from '@/lib/api-v2';
import { createLatestRequestGate } from '@/lib/latest-request';
import {
  currentWeekStart,
  formatBreak,
  formatShiftRange,
  loadMySchedule,
  weekRangeLabel,
  type MyScheduleResult,
} from '@/lib/my-schedule';
import { addLocalDays } from '@/lib/location-timezone';

type Props = { currentUserId: string };

const LOAD_ERROR = 'Your schedule could not be loaded. Check your connection and try again.';

export function MyScheduleWorkspace({ currentUserId }: Props) {
  const [thisWeek, setThisWeek] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState<0 | 1>(0);
  const [result, setResult] = useState<MyScheduleResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(createLatestRequestGate<string>());

  useEffect(() => {
    // Resolve "today" in the browser so the week matches the viewer's calendar.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setThisWeek(currentWeekStart(new Date(), zone));
    const requestGate = gate.current;
    return () => requestGate.invalidate();
  }, []);

  const weekStart = useMemo(
    () => (thisWeek ? addLocalDays(thisWeek, weekOffset * 7) : null),
    [thisWeek, weekOffset],
  );

  const load = useCallback(async (target: string) => {
    const ticket = gate.current.begin(target);
    setIsLoading(true);
    setError(null);
    try {
      const next = await loadMySchedule(apiV2, target, currentUserId);
      if (!gate.current.isLatest(ticket)) return;
      setResult(next);
    } catch {
      if (!gate.current.isLatest(ticket)) return;
      setResult(null);
      setError(LOAD_ERROR);
    } finally {
      if (gate.current.isLatest(ticket)) setIsLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    if (weekStart) void load(weekStart);
  }, [load, weekStart]);

  const days = result?.days ?? [];
  const showContent = !isLoading && !error && result !== null;

  return (
    <div style={{ display: 'grid', gap: '1rem', minWidth: 0, maxWidth: 720 }}>
      <section className="surface-card" style={{ padding: '1rem', display: 'grid', gap: '0.85rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.8rem', flexWrap: 'wrap' }}>
          <div>
            <div className="workspace-kicker">Your shifts</div>
            <h1 className="workspace-title" style={{ fontSize: '1.55rem', marginBottom: 2 }}>My Schedule</h1>
            <p className="workspace-subtitle">{weekStart ? weekRangeLabel(weekStart) : 'Loading...'}</p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => weekStart && void load(weekStart)}
            disabled={!weekStart || isLoading}
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
        <div role="group" aria-label="Week" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={weekOffset === 0 ? 'btn btn-primary' : 'btn btn-secondary'}
            aria-pressed={weekOffset === 0}
            onClick={() => setWeekOffset(0)}
          >
            This week
          </button>
          <button
            type="button"
            className={weekOffset === 1 ? 'btn btn-primary' : 'btn btn-secondary'}
            aria-pressed={weekOffset === 1}
            onClick={() => setWeekOffset(1)}
          >
            Next week
          </button>
        </div>
      </section>

      {error ? (
        <section className="surface-card" role="alert" style={{ padding: '1rem', display: 'grid', gap: '0.6rem' }}>
          <div style={{ color: '#B22945', fontWeight: 700 }}>{error}</div>
          <div>
            <button type="button" className="btn btn-secondary" onClick={() => weekStart && void load(weekStart)} disabled={isLoading}>
              Try again
            </button>
          </div>
        </section>
      ) : null}

      {isLoading && !error ? (
        <section className="surface-card" aria-busy="true" aria-label="Loading your schedule" style={{ padding: '1rem', display: 'grid', gap: '0.75rem' }}>
          <div className="skeleton" style={{ height: 20, width: 160 }} />
          <div className="skeleton" style={{ height: 64, width: '100%' }} />
          <div className="skeleton" style={{ height: 64, width: '100%' }} />
        </section>
      ) : null}

      {showContent && days.length === 0 ? (
        <section className="surface-card" style={{ padding: '1.5rem 1rem', textAlign: 'center', display: 'grid', gap: '0.4rem', justifyItems: 'center' }}>
          <CalendarDays size={28} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
          <h2 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--text-primary)' }}>No published shifts yet</h2>
          <p className="workspace-subtitle" style={{ margin: 0 }}>
            Shifts appear here once your manager publishes the schedule for this week.
          </p>
        </section>
      ) : null}

      {showContent && result?.locationsTruncated ? (
        <p className="workspace-subtitle" role="status" style={{ margin: 0 }}>
          Showing shifts from the first {result?.locationsChecked} locations.
        </p>
      ) : null}

      {showContent ? days.map((day) => (
        <section key={day.dateValue} className="surface-card" aria-labelledby={`my-schedule-${day.dateValue}`} style={{ padding: '1rem', display: 'grid', gap: '0.7rem' }}>
          <h2 id={`my-schedule-${day.dateValue}`} style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>{day.label}</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.7rem' }}>
            {day.shifts.map((shift) => (
              <li key={shift.id} className="surface-muted" style={{ padding: '0.75rem', display: 'grid', gap: '0.35rem', minWidth: 0, overflowWrap: 'anywhere' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  <Clock3 size={15} aria-hidden="true" />
                  {formatShiftRange(shift)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--text-secondary)', fontSize: '0.86rem' }}>
                  <MapPin size={14} aria-hidden="true" />
                  {shift.locationName}{shift.role ? ` - ${shift.role}` : ''}
                </div>
                {shift.breaks.length > 0 ? (
                  <ul aria-label="Lunch and breaks" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.25rem' }}>
                    {shift.breaks.map((item) => (
                      <li key={`${item.startTime}-${item.endTime}`} style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                        <UtensilsCrossed size={13} aria-hidden="true" />
                        {formatBreak(item, shift.timeZone)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )) : null}
    </div>
  );
}
