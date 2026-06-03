'use client';

import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { CalendarDays, Download, Plus, Printer, RefreshCw, Settings2, Sparkles, Upload, WandSparkles } from 'lucide-react';
import { fetchJsonWithSession } from '@/lib/client-api';
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
  },
);

type StaffRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type StaffRosterItem = { id: string; name: string; role: StaffRole };
type LocationItem = { id: string; name: string };
type BreakItem = { startTime: string; endTime: string; paid: boolean };
type ShiftRecord = {
  id: string;
  userId: string | null;
  locationId: string;
  startTime: string;
  endTime: string;
  role: string | null;
  user?: { id: string; name: string; role: StaffRole } | null;
  breaks?: BreakItem[];
};
type ShiftDraft = {
  userId: string;
  locationId: string;
  role: string;
  shiftDate: string;
  startTime: string;
  endTime: string;
};
type GeneratedAssignment = {
  shiftId: string;
  staffName: string;
  role: string;
  lunch: string;
  breaks: string[];
  risk: 'healthy' | 'watch';
};

const UNASSIGNED_RESOURCE_ID = 'unassigned';
const OPEN_SHIFT_VALUE = '__open_shift__';
const TODAY = new Date();
const DEFAULT_SHIFT_DRAFT: ShiftDraft = {
  userId: '',
  locationId: '',
  role: 'STAFF',
  shiftDate: toDateInputValue(TODAY),
  startTime: '09:00',
  endTime: '17:00',
};

function getCsrfTokenFromCookie(): string {
  if (typeof document === 'undefined') return '';
  const pair = document.cookie.split('; ').find((entry) => entry.startsWith('csrf_token='));
  return pair ? decodeURIComponent(pair.split('=')[1] ?? '') : '';
}

function jsonWriteInit(method: 'POST' | 'PUT', payload: unknown): RequestInit {
  const csrfToken = getCsrfTokenFromCookie();
  return {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: JSON.stringify(payload),
  };
}

function fmtTime(dateIso: string) {
  return new Date(dateIso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayCountForView(mode: SchedulerViewMode): number {
  return mode === 'day' ? 1 : mode === 'threeDay' ? 3 : 7;
}

function viewRange(dateValue: string, mode: SchedulerViewMode) {
  const start = new Date(`${dateValue}T00:00:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + dayCountForView(mode));
  return { start: start.toISOString(), end: end.toISOString() };
}

function visibleDateValues(dateValue: string, mode: SchedulerViewMode): string[] {
  const start = new Date(`${dateValue}T00:00:00`);
  return Array.from({ length: dayCountForView(mode) }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return toDateInputValue(date);
  });
}

function shortDateLabel(dateValue: string): string {
  return new Date(`${dateValue}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function shiftDateKey(shift: ShiftRecord): string {
  return toDateInputValue(new Date(shift.startTime));
}

function timeOnDate(dateValue: string, timeValue: string): string {
  const [hours = 0, minutes = 0] = timeValue.split(':').map((part) => Number.parseInt(part, 10));
  const date = new Date(`${dateValue}T00:00:00`);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function shiftRange(dateValue: string, startTime: string, endTime: string) {
  return {
    startTime: timeOnDate(dateValue, startTime),
    endTime: timeOnDate(dateValue, endTime),
  };
}

function isValidShiftWindow(dateValue: string, startTime: string, endTime: string): boolean {
  const start = new Date(timeOnDate(dateValue, startTime)).getTime();
  const end = new Date(timeOnDate(dateValue, endTime)).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function timeValueFromIso(dateIso: string): string {
  return new Date(dateIso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function applyStaffToShift(shift: ShiftRecord, person: StaffRosterItem | null): ShiftRecord {
  return {
    ...shift,
    userId: person?.id ?? null,
    user: person ? { id: person.id, name: person.name, role: person.role } : null,
  };
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return 'LL';
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('');
}

function hueForName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function normalizeRole(role: string | null | undefined): string {
  if (!role) return 'STAFF';
  return role.toUpperCase();
}

function shiftToEvent(shift: ShiftRecord): StaffScheduleEvent {
  return {
    id: shift.id,
    resourceId: shift.userId ?? UNASSIGNED_RESOURCE_ID,
    title: normalizeRole(shift.role ?? shift.user?.role),
    start: shift.startTime,
    end: shift.endTime,
    extendedProps: { role: normalizeRole(shift.role ?? shift.user?.role) },
  };
}

function breakToEvents(shift: ShiftRecord): StaffScheduleEvent[] {
  return (shift.breaks ?? []).map((item, index) => ({
    id: `${shift.id}-break-${index}`,
    resourceId: shift.userId ?? UNASSIGNED_RESOURCE_ID,
    title: item.paid ? 'Break' : 'Lunch',
    start: item.startTime,
    end: item.endTime,
    extendedProps: {
      role: item.paid ? 'BREAK' : 'LUNCH',
      kind: item.paid ? 'break' : 'lunch',
    },
  }));
}

function shiftsToEvents(shifts: ShiftRecord[]): StaffScheduleEvent[] {
  return shifts.flatMap((shift) => [shiftToEvent(shift), ...breakToEvents(shift)]);
}

function assignmentFromShift(shift: ShiftRecord): GeneratedAssignment {
  const paid = (shift.breaks ?? []).filter((item) => item.paid);
  const unpaid = (shift.breaks ?? []).filter((item) => !item.paid);
  const durationMins = Math.max(60, Math.floor((new Date(shift.endTime).getTime() - new Date(shift.startTime).getTime()) / 60000));
  const lunch = unpaid[0];
  return {
    shiftId: shift.id,
    staffName: shift.user?.name ?? 'Open shift',
    role: normalizeRole(shift.role ?? shift.user?.role),
    lunch: lunch ? `${fmtTime(lunch.startTime)}-${fmtTime(lunch.endTime)}` : 'Unassigned',
    breaks: paid.map((item) => `${fmtTime(item.startTime)}-${fmtTime(item.endTime)}`),
    risk: durationMins > 480 && (!lunch || new Date(lunch.startTime).getHours() >= 16) ? 'watch' : 'healthy',
  };
}

function SchedulingContent() {
  const searchParams = useSearchParams();
  const initialDate = searchParams.get('date');
  const initialDateValue = initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : toDateInputValue(TODAY);
  const openFocus = searchParams.get('focus') === 'open';
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [viewMode, setViewMode] = useState<SchedulerViewMode>('threeDay');
  const [selectedDate, setSelectedDate] = useState(initialDateValue);
  const [staff, setStaff] = useState<StaffRosterItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [shifts, setShifts] = useState<ShiftRecord[]>([]);
  const [generated, setGenerated] = useState<GeneratedAssignment[]>([]);
  const [showShiftForm, setShowShiftForm] = useState(false);
  const [shiftDraft, setShiftDraft] = useState<ShiftDraft>({ ...DEFAULT_SHIFT_DRAFT, shiftDate: initialDateValue });
  const [error, setError] = useState<string | null>(null);

  const loadSchedule = useCallback(async (dateValue: string, mode: SchedulerViewMode) => {
    setIsLoading(true);
    setError(null);
    try {
      const range = viewRange(dateValue, mode);
      const [staffPayload, locationsPayload, shiftsPayload] = await Promise.all([
        fetchJsonWithSession<{ data: StaffRosterItem[] }>('/shifts/staff-roster'),
        fetchJsonWithSession<{ data: LocationItem[] }>('/locations'),
        fetchJsonWithSession<{ data: ShiftRecord[] }>(`/shifts?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`),
      ]);
      setStaff(staffPayload.data ?? []);
      setLocations(locationsPayload.data ?? []);
      setShifts(shiftsPayload.data ?? []);
      setGenerated((shiftsPayload.data ?? []).filter((shift) => (shift.breaks ?? []).length > 0).map(assignmentFromShift));
    } catch (err) {
      setError((err as Error).message);
      setStaff([]);
      setLocations([]);
      setShifts([]);
      setGenerated([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchedule(selectedDate, viewMode);
  }, [loadSchedule, selectedDate, viewMode]);

  useEffect(() => {
    setShiftDraft((current) => {
      const visibleDates = visibleDateValues(selectedDate, viewMode);
      if (visibleDates.includes(current.shiftDate)) return current;
      return { ...current, shiftDate: selectedDate };
    });
  }, [selectedDate, viewMode]);

  useEffect(() => {
    setShiftDraft((current) => {
      if (!locations[0]?.id) return current.locationId ? { ...current, locationId: '' } : current;
      if (locations.some((location) => location.id === current.locationId)) return current;
      return { ...current, locationId: locations[0].id };
    });
  }, [locations]);

  const resources = useMemo(() => {
    const staffResources = staff.map((person) => ({
      id: person.id,
      title: person.name || 'Unnamed',
      role: person.role,
      avatarInitials: getInitials(person.name),
      hue: hueForName(person.id || person.name),
    }));
    return [
      ...staffResources,
      { id: UNASSIGNED_RESOURCE_ID, title: 'Open Shifts', role: 'UNASSIGNED', avatarInitials: 'OS', hue: 210 },
    ];
  }, [staff]);

  const openShifts = useMemo(() => shifts.filter((shift) => !shift.userId), [shifts]);
  const visibleShifts = openFocus ? openShifts : shifts;
  const visibleResources = useMemo(() => {
    if (!openFocus) return resources;
    return resources.filter((resource) => resource.id === UNASSIGNED_RESOURCE_ID);
  }, [openFocus, resources]);

  const scheduleEvents = useMemo(() => shiftsToEvents(visibleShifts), [visibleShifts]);
  const locationNameById = useMemo(() => new Map(locations.map((location) => [location.id, location.name])), [locations]);
  const builderDates = useMemo(() => visibleDateValues(selectedDate, viewMode), [selectedDate, viewMode]);

  const dateLabel = useMemo(
    () => {
      const dates = visibleDateValues(selectedDate, viewMode);
      if (dates.length === 1) return shortDateLabel(dates[0]);
      return `${shortDateLabel(dates[0])} - ${shortDateLabel(dates[dates.length - 1])}`;
    },
    [selectedDate, viewMode],
  );

  const handleDraftStaffChange = (value: string) => {
    const selectedStaff = staff.find((person) => person.id === value);
    setShiftDraft((current) => ({
      ...current,
      userId: value,
      role: selectedStaff?.role ?? current.role,
    }));
  };

  const addShift = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setIsSaved(false);
    setError(null);
    const locationId = shiftDraft.locationId || locations[0]?.id;
    if (!locationId) {
      setError('Add a location before creating schedule shifts.');
      return;
    }
    if (!isValidShiftWindow(shiftDraft.shiftDate, shiftDraft.startTime, shiftDraft.endTime)) {
      setError('Shift end time must be after start time.');
      return;
    }

    const selectedStaff = staff.find((person) => person.id === shiftDraft.userId);
    if (!selectedStaff) {
      setError('Select a staff member before creating a shift.');
      return;
    }
    const range = shiftRange(shiftDraft.shiftDate, shiftDraft.startTime, shiftDraft.endTime);
    try {
      const created = await fetchJsonWithSession<ShiftRecord>('/shifts', {
        ...jsonWriteInit('POST', {
          locationId,
          userId: selectedStaff.id,
          role: normalizeRole(shiftDraft.role || selectedStaff.role),
          ...range,
        }),
      });
      setShifts((current) => [...current, created]);
      setShowShiftForm(false);
      setShiftDraft((current) => ({
        ...current,
        userId: '',
        role: 'STAFF',
      }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const prepareShiftForStaff = (person: StaffRosterItem, shiftDate: string, startTime = '09:00', endTime = '17:00') => {
    setError(null);
    setShiftDraft((current) => ({
      ...current,
      userId: person.id,
      role: person.role,
      shiftDate,
      startTime,
      endTime,
    }));
    setShowShiftForm(true);
  };

  const shiftsForStaffDate = (personId: string, dateValue: string) =>
    shifts.filter((shift) => shift.userId === personId && shiftDateKey(shift) === dateValue);

  const assignShift = async (id: string, userId: string) => {
    const currentShift = shifts.find((shift) => shift.id === id);
    if (!currentShift) return;

    setIsSaved(false);
    setError(null);
    const nextUserId = userId === OPEN_SHIFT_VALUE ? null : userId;
    const selectedStaff = nextUserId ? staff.find((person) => person.id === nextUserId) ?? null : null;
    setShifts((previous) => previous.map((shift) => (shift.id === id ? applyStaffToShift(shift, selectedStaff) : shift)));
    try {
      const updated = await fetchJsonWithSession<ShiftRecord>(`/shifts/${id}`, {
        ...jsonWriteInit('PUT', {
          startTime: currentShift.startTime,
          endTime: currentShift.endTime,
          userId: nextUserId,
        }),
      });
      setShifts((previous) => previous.map((shift) => (shift.id === id ? updated : shift)));
      setIsSaved(true);
    } catch (err) {
      setError((err as Error).message);
      void loadSchedule(selectedDate, viewMode);
    }
  };

  const runGenerate = async () => {
    setIsSaved(false);
    setIsGenerating(true);
    setError(null);
    try {
      const shiftIds = shifts.map((shift) => shift.id);
      if (shiftIds.length === 0) {
        setGenerated([]);
        return;
      }
      await fetchJsonWithSession('/lunch-breaks/generate', {
        ...jsonWriteInit('POST', { shiftIds, persist: true }),
      });
      const range = viewRange(selectedDate, viewMode);
      const refreshed = await fetchJsonWithSession<{ data: ShiftRecord[] }>(
        `/shifts?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`,
      );
      setShifts(refreshed.data ?? []);
      setGenerated((refreshed.data ?? []).map(assignmentFromShift));
      setIsSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await loadSchedule(selectedDate, viewMode);
      setIsSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const openPrintSchedule = () => {
    const params = new URLSearchParams({ date: selectedDate, autoprint: '1' });
    window.open(`/dashboard/scheduling/print?${params.toString()}`, '_blank', 'noopener,noreferrer');
  };

  const updateShift = async (id: string, start: string, end: string, userId: string) => {
    setIsSaved(false);
    const nextUserId = userId === UNASSIGNED_RESOURCE_ID ? null : userId;
    const selectedStaff = nextUserId ? staff.find((person) => person.id === nextUserId) ?? null : null;
    setShifts((previous) =>
      previous.map((shift) => (shift.id === id ? applyStaffToShift({ ...shift, startTime: start, endTime: end }, selectedStaff) : shift)),
    );
    try {
      const updated = await fetchJsonWithSession<ShiftRecord>(`/shifts/${id}`, {
        ...jsonWriteInit('PUT', {
          startTime: start,
          endTime: end,
          userId: nextUserId,
        }),
      });
      setShifts((previous) => previous.map((shift) => (shift.id === id ? updated : shift)));
      setIsSaved(true);
    } catch (err) {
      setError((err as Error).message);
      void loadSchedule(selectedDate, viewMode);
    }
  };

  return (
    <>
      <div className="scheduler-page">
        <section className="scheduler-topbar surface-card">
          <div className="scheduler-topbar__left">
            <span className="workspace-kicker">Schedule workspace</span>
            <h1 className="workspace-title">Calendar</h1>
            <p className="workspace-subtitle">{isLoading ? 'Loading real tenant schedule...' : dateLabel}</p>
          </div>

          <div className="scheduler-topbar__controls">
            <label className="scheduler-day-picker">
              <CalendarDays size={15} />
              <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </label>

            <div className="scheduler-view-toggle" role="group" aria-label="Scheduler view">
              {(['day', 'threeDay', 'week'] as SchedulerViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={viewMode === mode ? 'active' : ''}
                  onClick={() => setViewMode(mode)}
                >
                  {mode === 'threeDay' ? '3-Day' : mode === 'day' ? 'Day' : 'Week'}
                </button>
              ))}
            </div>

            <Button onClick={runGenerate} disabled={isGenerating || shifts.length === 0}>
              {isGenerating ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ animation: 'spin 1s linear infinite' }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Generating...
                </>
              ) : (
                <>
                  <WandSparkles size={15} />
                  Generate breaks
                </>
              )}
            </Button>

            <Button variant="secondary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Refreshing...' : isSaved ? 'Synced' : 'Refresh'}
            </Button>

            <Button variant="outline" onClick={openPrintSchedule} disabled={isLoading || shifts.length === 0}>
              <Printer size={15} />
              Print schedule
            </Button>

            <Button variant="ghost" size="icon" aria-label="Advanced settings" onClick={() => setShowAdvanced((value) => !value)}>
              <Settings2 size={16} />
            </Button>
          </div>
        </section>

        {error ? <div className="scheduler-error">{error}</div> : null}

        {openFocus ? (
          <section className="scheduler-focus-banner" aria-label="Open shift focus">
            <div>
              <strong>Open shifts focus</strong>
              <span>{openShifts.length} open shift{openShifts.length === 1 ? '' : 's'} shown. Assigned shifts are hidden in this view.</span>
            </div>
            <a className="btn btn-secondary btn-sm" href="/dashboard/scheduling">Show all shifts</a>
          </section>
        ) : null}

        {showAdvanced ? (
          <section className="scheduler-advanced surface-card" aria-label="Advanced settings panel">
            <p><strong>Advanced</strong> actions use tenant-scoped schedule data and do not cross company boundaries.</p>
            <div className="scheduler-advanced__actions">
              <Button variant="outline" size="sm" onClick={() => void loadSchedule(selectedDate, viewMode)}><RefreshCw size={14} /> Reload</Button>
              <Button variant="outline" size="sm" disabled><Upload size={14} /> Import shifts</Button>
              <Button variant="outline" size="sm" disabled><Download size={14} /> Export policy</Button>
            </div>
          </section>
        ) : null}

        <section className="scheduler-panels">
          <article className="surface-card scheduler-panel scheduler-panel--builder">
            <header>
              <div>
                <h2>Shift inputs</h2>
                <p>{staff.length} staff and {locations.length} location{locations.length === 1 ? '' : 's'} available for this tenant.</p>
              </div>
              {!openFocus ? (
                <Button size="sm" onClick={() => setShowShiftForm((value) => !value)}>
                  <Plus size={14} />
                  {showShiftForm ? 'Close' : 'Add shift'}
                </Button>
              ) : null}
            </header>

            {showShiftForm && !openFocus ? (
              <form className="shift-form" onSubmit={addShift}>
                <label>
                  <span>Staff</span>
                  <select value={shiftDraft.userId} onChange={(event) => handleDraftStaffChange(event.target.value)}>
                    <option value="">Select staff</option>
                    {staff.map((person) => (
                      <option key={person.id} value={person.id}>{person.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Location</span>
                  <select value={shiftDraft.locationId} onChange={(event) => setShiftDraft((current) => ({ ...current, locationId: event.target.value }))}>
                    <option value="">Select location</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>{location.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Role</span>
                  <select value={shiftDraft.role} onChange={(event) => setShiftDraft((current) => ({ ...current, role: event.target.value }))}>
                    <option value="STAFF">Staff</option>
                    <option value="MANAGER">Manager</option>
                    <option value="ADMIN">Admin</option>
                    <option value="SUPER_ADMIN">Super admin</option>
                  </select>
                </label>
                <label>
                  <span>Date</span>
                  <input
                    type="date"
                    value={shiftDraft.shiftDate}
                    onChange={(event) => setShiftDraft((current) => ({ ...current, shiftDate: event.target.value }))}
                  />
                </label>
                <label>
                  <span>Start</span>
                  <input
                    type="time"
                    value={shiftDraft.startTime}
                    onChange={(event) => setShiftDraft((current) => ({ ...current, startTime: event.target.value }))}
                  />
                </label>
                <label>
                  <span>End</span>
                  <input
                    type="time"
                    value={shiftDraft.endTime}
                    onChange={(event) => setShiftDraft((current) => ({ ...current, endTime: event.target.value }))}
                  />
                </label>
                <div className="shift-form__actions">
                  <Button
                    size="sm"
                    type="submit"
                    disabled={!locations.length || !shiftDraft.userId || !isValidShiftWindow(shiftDraft.shiftDate, shiftDraft.startTime, shiftDraft.endTime)}
                  >
                    Create shift
                  </Button>
                  <Button size="sm" type="button" variant="ghost" onClick={() => setShowShiftForm(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}

            {!openFocus ? (
              <div className="schedule-builder" aria-label="Schedule builder grid">
                <div className="schedule-builder__grid" style={{ gridTemplateColumns: `minmax(150px, 0.9fr) repeat(${builderDates.length}, minmax(150px, 1fr))` }}>
                  <div className="schedule-builder__corner">Staff</div>
                  {builderDates.map((dateValue) => (
                    <div key={dateValue} className="schedule-builder__day">{shortDateLabel(dateValue)}</div>
                  ))}
                  {staff.map((person) => (
                    <div key={person.id} className="schedule-builder__row">
                      <div className="schedule-builder__staff">
                        <strong>{person.name}</strong>
                        <span>{person.role}</span>
                      </div>
                      {builderDates.map((dateValue) => {
                        const cellShifts = shiftsForStaffDate(person.id, dateValue);
                        return (
                          <div key={`${person.id}-${dateValue}`} className="schedule-builder__cell">
                            {cellShifts.length > 0 ? (
                              <div className="schedule-builder__shifts">
                                {cellShifts.map((shift) => (
                                  <button
                                    key={shift.id}
                                    type="button"
                                    className="schedule-builder__shift"
                                    onClick={() => prepareShiftForStaff(person, dateValue, timeValueFromIso(shift.startTime), timeValueFromIso(shift.endTime))}
                                    title="Use these times for a new shift"
                                  >
                                    <span>{timeValueFromIso(shift.startTime)}-{timeValueFromIso(shift.endTime)}</span>
                                    <small>{normalizeRole(shift.role ?? person.role)}</small>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            <button
                              type="button"
                              className="schedule-builder__add"
                              onClick={() => prepareShiftForStaff(person, dateValue)}
                            >
                              <Plus size={13} />
                              Add
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {visibleShifts.length === 0 ? (
              <div className="scheduler-empty">
                <h3>{openFocus ? 'No open shifts' : 'No shifts yet'}</h3>
                <p>{openFocus ? 'All loaded shifts are assigned for this date.' : 'Use the staff grid above to add shifts by person and date.'}</p>
                <div>
                  {!openFocus ? <Button size="sm" onClick={() => setShowShiftForm(true)}><Plus size={14} /> Add shift</Button> : null}
                </div>
              </div>
            ) : (
              <div className="scheduler-table-wrap">
                <table className="scheduler-table">
                  <thead>
                    <tr>
                      <th>Assignee</th>
                      <th>Location</th>
                      <th>Role</th>
                      <th>Shift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleShifts.map((shift) => (
                      <tr key={shift.id} className={!shift.userId ? 'is-open-shift' : undefined}>
                        <td>
                          <select
                            className="scheduler-inline-select"
                            value={shift.userId ?? OPEN_SHIFT_VALUE}
                            onChange={(event) => void assignShift(shift.id, event.target.value)}
                            aria-label={`Assign ${fmtTime(shift.startTime)} shift`}
                          >
                            <option value={OPEN_SHIFT_VALUE}>Open shift</option>
                            {staff.map((person) => (
                              <option key={person.id} value={person.id}>{person.name}</option>
                            ))}
                          </select>
                        </td>
                        <td>{locationNameById.get(shift.locationId) ?? 'Unknown'}</td>
                        <td>{normalizeRole(shift.role ?? shift.user?.role)}</td>
                        <td>{timeValueFromIso(shift.startTime)} - {timeValueFromIso(shift.endTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="scheduler-table-actions">
                  {!openFocus ? <Button size="sm" onClick={() => setShowShiftForm(true)}><Plus size={14} /> Add shift</Button> : null}
                </div>
              </div>
            )}
          </article>

          <article className="surface-card scheduler-panel">
            <header>
              <h2>Lunch and break assignments</h2>
              <p>Generated records are saved to the shared lunch/break system.</p>
            </header>

            {isGenerating ? (
              <div className="scheduler-loading" aria-label="Loading generated assignments">
                <div className="skeleton" style={{ height: 48 }} />
                <div className="skeleton" style={{ height: 48 }} />
                <div className="skeleton" style={{ height: 48 }} />
              </div>
            ) : generated.length === 0 ? (
              <div className="scheduler-empty">
                <h3>Ready to build breaks</h3>
                <p>Generate assignments to populate the break grid and lunch/break workspace.</p>
                <div>
                  <Button size="sm" onClick={runGenerate} disabled={shifts.length === 0}><Sparkles size={14} /> Generate breaks</Button>
                </div>
              </div>
            ) : (
              <ul className="assignment-list" aria-label="Generated assignments">
                {generated.map((assignment, index) => (
                  <li key={assignment.shiftId} className="assignment-item" style={{ animationDelay: `${index * 20}ms` }}>
                    <div>
                      <strong>{assignment.staffName}</strong>
                      <small>{assignment.role}</small>
                    </div>
                    <div className="assignment-chips">
                      <span className="badge badge-info">Lunch {assignment.lunch}</span>
                      {assignment.breaks.map((item, breakIndex) => (
                        <span key={`${assignment.shiftId}-${breakIndex}`} className="badge badge-info">Break {item}</span>
                      ))}
                      <span className={assignment.risk === 'watch' ? 'badge badge-warn' : 'badge badge-success'}>
                        {assignment.risk === 'watch' ? 'Watch window' : 'Healthy'}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </section>

        <section className="surface-card scheduler-timeline-panel">
          <header>
            <h2>Timeline review</h2>
            <p>Drag shifts to adjust times. Changes save immediately to the tenant schedule.</p>
          </header>
          <div className="scheduler-timeline-shell">
            <StaffScheduler
              resources={visibleResources}
              events={scheduleEvents}
              viewMode={viewMode}
              initialDate={selectedDate}
              onEventChange={(id, start, end, resourceId) => void updateShift(id, start, end, resourceId)}
            />
          </div>
        </section>
      </div>

      <style jsx>{`
        .scheduler-page {
          min-height: 100%;
          display: grid;
          gap: 16px;
        }

        .scheduler-error {
          padding: 0.8rem 0.95rem;
          border-radius: 12px;
          border: 1px solid #ffd0da;
          background: #fff1f4;
          color: #cb3653;
          font-weight: 650;
          font-size: 0.86rem;
        }

        .scheduler-focus-banner {
          padding: 0.8rem 0.95rem;
          border: 1px solid #bfdbfe;
          border-radius: var(--r-md);
          background: #eff6ff;
          color: var(--text);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          flex-wrap: wrap;
        }

        .scheduler-focus-banner div {
          display: grid;
          gap: 2px;
        }

        .scheduler-focus-banner strong {
          font-size: 0.86rem;
        }

        .scheduler-focus-banner span {
          color: var(--text-muted);
          font-size: 0.8rem;
        }

        .scheduler-topbar {
          padding: 20px 24px;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
        }

        .scheduler-topbar__left p {
          margin-top: 4px;
        }

        .scheduler-topbar__controls {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .scheduler-day-picker {
          height: 40px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border-radius: var(--r-md);
          border: 1px solid var(--border);
          background: var(--surface);
          padding: 0 12px;
          color: var(--text-muted);
        }

        .scheduler-day-picker input {
          border: 0;
          background: transparent;
          color: var(--text);
        }

        .scheduler-view-toggle {
          display: inline-flex;
          border-radius: var(--r-pill);
          overflow: hidden;
          border: 1px solid var(--border);
          background: var(--surface-soft);
        }

        .scheduler-view-toggle button {
          border: 0;
          background: transparent;
          color: var(--text-muted);
          font-size: 12px;
          font-weight: 700;
          height: 32px;
          padding: 0 10px;
          cursor: pointer;
        }

        .scheduler-view-toggle button.active {
          background: #e0e7ff;
          color: var(--brand-800);
        }

        .scheduler-advanced {
          padding: 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }

        .scheduler-advanced p {
          margin: 0;
          font-size: 14px;
          color: var(--text-muted);
        }

        .scheduler-advanced__actions {
          display: inline-flex;
          gap: 8px;
        }

        .scheduler-panels {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }

        .scheduler-panel {
          padding: 24px;
          min-height: 360px;
        }

        .scheduler-panel--builder {
          grid-column: 1 / -1;
        }

        .scheduler-panel header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }

        .scheduler-panel header h2,
        .scheduler-timeline-panel header h2 {
          margin: 0;
          font-size: 20px;
          line-height: 1.3;
        }

        .scheduler-panel header p,
        .scheduler-timeline-panel header p {
          margin: 6px 0 0;
          font-size: 14px;
          color: var(--text-muted);
        }

        .shift-form {
          margin-top: 16px;
          padding: 12px;
          border: 1px solid var(--border);
          border-radius: var(--r-md);
          background: var(--surface-soft);
          display: grid;
          grid-template-columns: minmax(160px, 1.2fr) minmax(160px, 1fr) minmax(130px, 0.8fr) repeat(3, minmax(96px, 0.55fr));
          gap: 10px;
          align-items: end;
        }

        .shift-form label {
          display: grid;
          gap: 5px;
          min-width: 0;
        }

        .shift-form span {
          font-size: 12px;
          font-weight: 800;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .shift-form select,
        .shift-form input,
        .scheduler-inline-select {
          width: 100%;
          height: 36px;
          border: 1px solid var(--border);
          border-radius: var(--r-sm);
          background: var(--surface);
          color: var(--text);
          font-size: 13px;
          padding: 0 10px;
        }

        .shift-form__actions {
          grid-column: 1 / -1;
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }

        .schedule-builder {
          margin-top: 16px;
          overflow: auto;
          border: 1px solid var(--border);
          border-radius: var(--r-md);
          background: var(--surface);
        }

        .schedule-builder__grid {
          display: grid;
          min-width: 680px;
        }

        .schedule-builder__row {
          display: contents;
        }

        .schedule-builder__corner,
        .schedule-builder__day,
        .schedule-builder__staff,
        .schedule-builder__cell {
          border-bottom: 1px solid var(--border);
          border-right: 1px solid var(--border);
        }

        .schedule-builder__corner,
        .schedule-builder__day {
          min-height: 42px;
          padding: 10px;
          background: var(--surface-soft);
          color: var(--text-muted);
          font-size: 12px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          display: flex;
          align-items: center;
        }

        .schedule-builder__staff {
          min-height: 94px;
          padding: 12px;
          display: grid;
          align-content: start;
          gap: 4px;
          background: #fbfdff;
        }

        .schedule-builder__staff strong {
          font-size: 13px;
          line-height: 1.25;
        }

        .schedule-builder__staff span {
          color: var(--text-muted);
          font-size: 12px;
        }

        .schedule-builder__cell {
          min-height: 94px;
          padding: 8px;
          display: grid;
          align-content: space-between;
          gap: 8px;
        }

        .schedule-builder__shifts {
          display: grid;
          gap: 6px;
        }

        .schedule-builder__shift,
        .schedule-builder__add {
          border: 1px solid var(--border);
          border-radius: var(--r-sm);
          background: var(--surface-soft);
          color: var(--text);
          min-height: 34px;
          padding: 6px 8px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          cursor: pointer;
          font-size: 12px;
        }

        .schedule-builder__shift:hover,
        .schedule-builder__add:hover {
          border-color: var(--brand-600);
          background: #eef4ff;
        }

        .schedule-builder__shift small {
          color: var(--text-muted);
          font-size: 10px;
          font-weight: 800;
        }

        .schedule-builder__add {
          justify-content: center;
          color: var(--brand-800);
          font-weight: 800;
        }

        .scheduler-empty,
        .scheduler-loading {
          margin-top: 16px;
          min-height: 210px;
          border: 1px dashed var(--border-strong);
          border-radius: var(--r-md);
          background: var(--surface-soft);
          display: grid;
          place-items: center;
          padding: 20px;
          text-align: center;
          gap: 10px;
        }

        .scheduler-empty h3 {
          margin: 0;
          font-size: 20px;
        }

        .scheduler-empty p {
          margin: 0;
          color: var(--text-muted);
          font-size: 14px;
          max-width: 44ch;
        }

        .scheduler-empty div {
          display: inline-flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: center;
        }

        .scheduler-loading {
          padding: 20px;
          display: grid;
          gap: 10px;
          place-items: stretch;
        }

        .scheduler-table-wrap {
          margin-top: 16px;
          overflow: auto;
          border: 1px solid var(--border);
          border-radius: var(--r-md);
          padding: 0 0 12px;
        }

        .scheduler-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
        }

        .scheduler-table thead th {
          text-align: left;
          height: 52px;
          padding: 0 12px;
          font-weight: 700;
          color: var(--text-muted);
          background: var(--surface-soft);
          border-bottom: 1px solid var(--border);
          position: sticky;
          top: 0;
        }

        .scheduler-table tbody td {
          height: 48px;
          padding: 0 12px;
          border-top: 1px solid #f1f5f9;
        }

        .scheduler-table tbody tr:hover {
          background: rgba(79, 70, 229, 0.06);
        }

        .scheduler-table tbody tr.is-open-shift {
          background: #fff7ed;
        }

        .scheduler-table-actions {
          margin-top: 12px;
          padding: 0 12px;
        }

        .assignment-list {
          margin-top: 16px;
          list-style: none;
          padding: 0;
          display: grid;
          gap: 10px;
        }

        .assignment-item {
          border: 1px solid var(--border);
          background: var(--surface-soft);
          border-radius: var(--r-md);
          padding: 12px;
          display: grid;
          gap: 8px;
          opacity: 0;
          transform: scale(0.98);
          animation: assignment-in 180ms var(--ease-decelerate) forwards;
        }

        .assignment-item strong {
          display: block;
        }

        .assignment-item small {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-soft);
        }

        .assignment-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .scheduler-timeline-panel {
          padding: 24px;
        }

        .scheduler-timeline-shell {
          margin-top: 16px;
          min-height: 520px;
        }

        @keyframes assignment-in {
          from { opacity: 0; transform: scale(0.98); }
          to { opacity: 1; transform: scale(1); }
        }

        @media (max-width: 1200px) {
          .scheduler-panels {
            grid-template-columns: 1fr;
          }

          .shift-form {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }

        @media (max-width: 768px) {
          .scheduler-panel,
          .scheduler-timeline-panel,
          .scheduler-topbar {
            padding: 16px;
          }

          .scheduler-day-picker {
            width: 100%;
          }

          .scheduler-topbar__controls {
            width: 100%;
            justify-content: flex-start;
          }

          .scheduler-panel header {
            flex-direction: column;
          }

          .shift-form {
            grid-template-columns: 1fr;
          }

          .shift-form__actions {
            justify-content: flex-start;
            flex-wrap: wrap;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .assignment-item {
            animation: none;
            opacity: 1;
            transform: none;
          }
        }
      `}</style>
    </>
  );
}

export default function SchedulingPage() {
  return (
    <Suspense fallback={<div className="surface-card" style={{ minHeight: 520, padding: '1rem' }} />}>
      <SchedulingContent />
    </Suspense>
  );
}
