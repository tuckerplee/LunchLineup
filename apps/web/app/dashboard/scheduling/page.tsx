'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { CalendarDays, CheckCircle2, Plus, Printer, RefreshCw, RotateCcw, Send, Settings2, WandSparkles } from 'lucide-react';
import {
  ApiRequestError,
  fetchJsonWithSession,
  fetchWithSession,
  idempotentRequestAttempt,
  withIdempotencyKey,
  type IdempotentRequestAttempt,
} from '@/lib/client-api';
import { getWorkspaceCapabilities, hasSchedulingReadAccess } from '@/lib/permissions';
import { fetchAllBoundedPages, type BoundedPage } from '@/lib/bounded-pagination';
import {
  addLocalDays,
  dateValueInTimeZone,
  formatDateInTimeZone,
  localDateRange,
  safeTimeZone,
  timeValueInTimeZone,
} from '@/lib/location-timezone';
import type { SchedulerViewMode, StaffScheduleEvent, StaffScheduleSlotSelection } from '@/components/scheduling/StaffScheduler';
import { publishNotificationOutcome } from './publish-result';
import { schedulePublishAttempt } from './publish-attempt';
import {
  creditCount,
  parseSchedulePublishPreflight,
  parseSchedulePublishResponse,
  publishPreflightSummary,
  publishSettlementSummary,
  schedulePublishCostMatches,
  schedulePublishFailure,
  type SchedulePublishPreflight,
} from './publish-settlement';
import {
  executeBreakGenerationWithRecovery,
  type BreakGenerationAttempt,
  type BreakGenerationResponse,
} from './break-generation-recovery';
import {
  assertBreakGenerationResponseScope,
  buildLocationScheduleQuery,
  buildLocationShiftQuery,
  locationShiftScopeMatches,
  resolveTenantVisibleLocation,
  shiftIdsForLocation,
  shiftsForLocation,
  type LocationShiftScope,
} from './location-shift-scope';
import { DemandWindowEditor } from './DemandWindowEditor';
import type { DemandWindowRecord } from './demand-window-contract';
import { localTimeWindowFromInstants, serializeLocalTimeWindow } from './local-time-window';
import { containingDraftScheduleForShift, fallbackDraftWindowForShift } from './manual-shift-schedule';
import {
  clearAutoScheduleRecovery,
  readAutoScheduleRecoveries,
  saveAutoScheduleRecovery,
} from './auto-schedule-recovery';
import {
  beginShiftUpdateAttempt,
  clearShiftUpdateAttempt,
} from './shift-update-recovery';

const StaffScheduler = dynamic(
  () => import('@/components/scheduling/StaffScheduler').then((m) => m.StaffScheduler),
  {
    ssr: false,
    loading: () => (
      <div style={{ minHeight: 520, padding: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', background: 'var(--surface-soft)' }}>
        <div className="skeleton" style={{ height: 24, width: 180, marginBottom: '1rem' }} />
        <div className="skeleton" style={{ height: 420, width: '100%' }} />
      </div>
    ),
  },
);

type StaffRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type StaffRosterItem = { id: string; name: string; role: StaffRole };
type LocationItem = { id: string; name: string; timezone: string };
type LocationPage = {
  data?: LocationItem[];
  pagination?: { hasMore?: boolean; nextCursor?: string | null };
};
type BreakItem = { startTime: string; endTime: string; paid: boolean };
type ScheduleRecordStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
type ScheduleRecord = {
  id: string;
  locationId: string;
  startDate: string;
  endDate: string;
  status: ScheduleRecordStatus;
  publishedAt?: string | null;
};
type AutoScheduleResponse = {
  jobId: string;
  status: string;
  statusUrl: string;
};
type ScheduleSolveJobSnapshot = {
  jobId: string;
  status: string;
  statusReason?: string | null;
  resultShiftCount?: number | null;
  retryCount?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  statusUrl?: string;
};
type SchedulableShiftRole = 'MANAGER' | 'STAFF';
type ScheduleStatusTone = 'loading' | 'ready' | 'saving' | 'saved' | 'warning' | 'error';
type ScheduleStatus = { tone: ScheduleStatusTone; message: string };
type AutoScheduleRequestAttempt = { key: string; confirmReplace: boolean };
type ShiftRecord = {
  id: string;
  userId: string | null;
  locationId: string;
  scheduleId?: string | null;
  startTime: string;
  endTime: string;
  role: string | null;
  user?: { id: string; name: string; role: StaffRole } | null;
  breaks?: BreakItem[];
};
type ShiftDraft = {
  userId: string;
  locationId: string;
  role: SchedulableShiftRole;
  shiftDate: string;
  startTime: string;
  endTime: string;
};
const UNASSIGNED_RESOURCE_ID = 'unassigned';
const SCHEDULABLE_SHIFT_ROLES: Array<{ value: SchedulableShiftRole; label: string }> = [
  { value: 'STAFF', label: 'Staff' },
  { value: 'MANAGER', label: 'Manager' },
];
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

function deleteWriteInit(): RequestInit {
  const csrfToken = getCsrfTokenFromCookie();
  return {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
  };
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

function viewRange(dateValue: string, mode: SchedulerViewMode, timeZone: string) {
  return localDateRange(dateValue, dayCountForView(mode), timeZone);
}

function visibleDateValues(dateValue: string, mode: SchedulerViewMode): string[] {
  return Array.from({ length: dayCountForView(mode) }, (_, index) => addLocalDays(dateValue, index));
}

function shortDateLabel(dateValue: string): string {
  return new Date(`${dateValue}T12:00:00.000Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function shiftRange(dateValue: string, startTime: string, endTime: string, timeZone: string) {
  return serializeLocalTimeWindow({ date: dateValue, startTime, endTime }, timeZone);
}

function shiftWindowError(dateValue: string, startTime: string, endTime: string, timeZone: string): string | null {
  try {
    shiftRange(dateValue, startTime, endTime, timeZone);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function timeValueFromIso(dateIso: string, timeZone: string): string {
  return timeValueInTimeZone(dateIso, timeZone);
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

function isSchedulableStaffRole(role: string | null | undefined): role is SchedulableShiftRole {
  const normalized = normalizeRole(role);
  return normalized === 'MANAGER' || normalized === 'STAFF';
}

function toSchedulableShiftRole(role: string | null | undefined): SchedulableShiftRole {
  return normalizeRole(role) === 'MANAGER' ? 'MANAGER' : 'STAFF';
}

function formatStatusTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function shiftCountLabel(count: number): string {
  return `${count} shift${count === 1 ? '' : 's'}`;
}

function scheduleWindowLabel(schedule: ScheduleRecord, timeZone: string): string {
  const start = new Date(schedule.startDate);
  const inclusiveEnd = new Date(new Date(schedule.endDate).getTime() - 1);
  const startValue = dateValueInTimeZone(start, timeZone);
  const endValue = dateValueInTimeZone(inclusiveEnd, timeZone);
  if (startValue === endValue) return formatDateInTimeZone(start, timeZone, { weekday: 'short' });
  return `${formatDateInTimeZone(start, timeZone, { weekday: 'short' })} - ${formatDateInTimeZone(inclusiveEnd, timeZone, { weekday: 'short' })}`;
}

function dayRangeFromDateValue(dateValue: string, timeZone: string) {
  return localDateRange(dateValue, 1, timeZone);
}


function rangesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  return new Date(startA).getTime() < new Date(endB).getTime() && new Date(endA).getTime() > new Date(startB).getTime();
}

function assignedOverlapCount(shifts: ShiftRecord[]): number {
  const byUser = new Map<string, ShiftRecord[]>();
  let overlaps = 0;
  for (const shift of shifts) {
    if (!shift.userId) continue;
    const existing = byUser.get(shift.userId) ?? [];
    if (existing.some((item) => new Date(shift.startTime) < new Date(item.endTime) && new Date(shift.endTime) > new Date(item.startTime))) {
      overlaps += 1;
    }
    existing.push(shift);
    byUser.set(shift.userId, existing);
  }
  return overlaps;
}

function publishBlockerForShifts(shifts: ShiftRecord[]): string | null {
  if (shifts.length === 0) return 'Add at least one shift before publishing this schedule.';
  if (assignedOverlapCount(shifts) > 0) return 'Resolve overlapping assigned shifts before publishing this schedule.';
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function jobStatusPath(statusUrl: string | undefined, scheduleId: string, jobId: string): string {
  if (!statusUrl) return `/schedules/${encodeURIComponent(scheduleId)}/auto-schedule/jobs/${encodeURIComponent(jobId)}`;
  if (statusUrl.startsWith('/api/v1/')) return statusUrl.slice('/api/v1'.length);
  if (statusUrl.startsWith('/v1/')) return statusUrl.slice('/v1'.length);
  return statusUrl.startsWith('/') ? statusUrl : `/${statusUrl}`;
}

function isTerminalSolveStatus(status: string): boolean {
  return ['SUCCEEDED', 'FAILED', 'DEAD_LETTERED'].includes(status.toUpperCase());
}

function solveStatusLabel(job: ScheduleSolveJobSnapshot): string {
  const status = job.status.toUpperCase();
  if (status === 'SUCCEEDED') {
    return `Solved${job.resultShiftCount === null || job.resultShiftCount === undefined ? '' : ` ${shiftCountLabel(job.resultShiftCount)}`}`;
  }
  if (status === 'FAILED' || status === 'DEAD_LETTERED') {
    return job.statusReason ? `${status}: ${job.statusReason}` : status;
  }
  if (status === 'RETRYING') return `Retrying${job.retryCount ? ` attempt ${job.retryCount}` : ''}`;
  return status;
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

function SchedulingContent() {
  const searchParams = useSearchParams();
  const initialDate = searchParams.get('date');
  const initialLocationId = searchParams.get('location')?.trim() ?? '';
  const initialDateValue = initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate) ? initialDate : toDateInputValue(TODAY);
  const openFocus = searchParams.get('focus') === 'open';
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [scheduleStatus, setScheduleStatus] = useState<ScheduleStatus>({ tone: 'loading', message: 'Loading saved schedule data.' });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTimeline, setShowTimeline] = useState(true);
  const [viewMode, setViewMode] = useState<SchedulerViewMode>('threeDay');
  const [selectedDate, setSelectedDate] = useState(initialDateValue);
  const [staff, setStaff] = useState<StaffRosterItem[]>([]);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [nextLocationCursor, setNextLocationCursor] = useState<string | null>(null);
  const [isLoadingMoreLocations, setIsLoadingMoreLocations] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [shifts, setShifts] = useState<ShiftRecord[]>([]);
  const [showShiftForm, setShowShiftForm] = useState(false);
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null);
  const [confirmDeleteShiftId, setConfirmDeleteShiftId] = useState<string | null>(null);
  const [confirmPublishScheduleId, setConfirmPublishScheduleId] = useState<string | null>(null);
  const [publishReview, setPublishReview] = useState<SchedulePublishPreflight | null>(null);
  const [publishRetryByScheduleId, setPublishRetryByScheduleId] = useState<Record<string, boolean>>({});
  const [publishSettlementByScheduleId, setPublishSettlementByScheduleId] = useState<Record<string, string>>({});
  const [confirmReopenScheduleId, setConfirmReopenScheduleId] = useState<string | null>(null);
  const [confirmReplaceScheduleId, setConfirmReplaceScheduleId] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isReopening, setIsReopening] = useState(false);
  const [solvingScheduleId, setSolvingScheduleId] = useState<string | null>(null);
  const [solveJobsByScheduleId, setSolveJobsByScheduleId] = useState<Record<string, ScheduleSolveJobSnapshot>>({});
  const autoScheduleAttemptsRef = useRef<Record<string, AutoScheduleRequestAttempt>>({});
  const solveRecoveryStartedRef = useRef(new Set<string>());
  const breakGenerationAttemptRef = useRef<BreakGenerationAttempt | null>(null);
  const shiftCreateAttemptRef = useRef<IdempotentRequestAttempt | null>(null);
  const shiftUpdateAttemptsRef = useRef<Record<string, IdempotentRequestAttempt>>({});
  const publishAttemptsRef = useRef<Record<string, IdempotentRequestAttempt>>({});
  const publishingScheduleIdRef = useRef<string | null>(null);
  const latestLoadRequestRef = useRef(0);
  const solveGenerationRef = useRef(0);
  const selectedLocationRef = useRef(initialLocationId);
  const selectedDateRef = useRef(initialDateValue);
  const viewModeRef = useRef<SchedulerViewMode>('threeDay');
  const [shiftDraft, setShiftDraft] = useState<ShiftDraft>({ ...DEFAULT_SHIFT_DRAFT, shiftDate: initialDateValue });
  const [loadedShiftScope, setLoadedShiftScope] = useState<LocationShiftScope | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const capabilities = useMemo(() => getWorkspaceCapabilities(permissions), [permissions]);
  const activeTimeZone = safeTimeZone(locations.find((location) => location.id === shiftDraft.locationId)?.timezone ?? locations[0]?.timezone);
  const locationTimeZone = useCallback(
    (locationId: string) => safeTimeZone(locations.find((location) => location.id === locationId)?.timezone ?? locations[0]?.timezone),
    [locations],
  );
  const desiredShiftScope = useMemo<LocationShiftScope>(() => ({
    locationId: shiftDraft.locationId || locations[0]?.id || '',
    dateValue: selectedDate,
    viewMode,
  }), [locations, selectedDate, shiftDraft.locationId, viewMode]);
  const locationDataCurrent = locationShiftScopeMatches(loadedShiftScope, desiredShiftScope) && !isLoading;
  const scopeIsStillSelected = useCallback((scope: LocationShiftScope) => (
    selectedLocationRef.current === scope.locationId &&
    selectedDateRef.current === scope.dateValue &&
    viewModeRef.current === scope.viewMode
  ), []);
  const loadDemandWindows = useCallback(async (scheduleId: string) => {
    const payload = await fetchJsonWithSession<{ data: DemandWindowRecord[] }>(`/schedules/${scheduleId}/demand-windows`);
    return payload.data ?? [];
  }, []);
  const saveDemandWindows = useCallback(async (
    scheduleId: string,
    windows: Array<Omit<DemandWindowRecord, 'id'>>,
  ) => {
    const payload = await fetchJsonWithSession<{ data: DemandWindowRecord[] }>(`/schedules/${scheduleId}/demand-windows`, {
      ...jsonWriteInit('PUT', { windows }),
    });
    return payload.data ?? [];
  }, []);
  const loadAllShiftsForSchedule = useCallback((scheduleId: string) => (
    fetchAllBoundedPages(
      `/shifts?scheduleId=${encodeURIComponent(scheduleId)}&limit=200`,
      (path) => fetchJsonWithSession<BoundedPage<ShiftRecord>>(path),
    )
  ), []);
  const loadSchedulePublishReview = useCallback(async (scheduleId: string) => {
    const [scheduleShifts, preflightPayload] = await Promise.all([
      loadAllShiftsForSchedule(scheduleId),
      fetchJsonWithSession<unknown>(`/schedules/${scheduleId}/publish/preflight`),
    ]);
    return {
      blocker: publishBlockerForShifts(scheduleShifts),
      preflight: parseSchedulePublishPreflight(scheduleId, preflightPayload),
    };
  }, [loadAllShiftsForSchedule]);

  const loadSchedule = useCallback(async (dateValue: string, mode: SchedulerViewMode, requestedLocationId?: string) => {
    const requestId = ++latestLoadRequestRef.current;
    setIsLoading(true);
    setLoadedShiftScope(null);
    setError(null);
    setScheduleStatus({ tone: 'loading', message: 'Loading saved schedule data.' });
    try {
      const mePayload = await fetchJsonWithSession<{ user?: { permissions?: string[] } }>('/auth/me');
      const effectivePermissions = mePayload.user?.permissions ?? [];
      if (!hasSchedulingReadAccess(effectivePermissions)) {
        throw new Error('You do not have access to all data required by the scheduling calendar.');
      }
      const [staffRows, locationsPayload, requestedLocation] = await Promise.all([
        fetchAllBoundedPages(
          '/shifts/staff-roster?limit=200',
          (path) => fetchJsonWithSession<BoundedPage<StaffRosterItem>>(path),
        ),
        fetchJsonWithSession<LocationPage>('/locations?limit=200'),
        requestedLocationId ? fetchJsonWithSession<LocationItem>('/locations/' + encodeURIComponent(requestedLocationId)) : Promise.resolve(null),
      ]);
      const locationRows = Array.isArray(locationsPayload.data) ? locationsPayload.data : [];
      if (requestedLocation && !locationRows.some((location) => location.id === requestedLocation.id)) {
        locationRows.push(requestedLocation);
        locationRows.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      }
      const locationContinuation = locationsPayload.pagination?.hasMore === true
        ? locationsPayload.pagination.nextCursor
        : null;
      if (locationsPayload.pagination?.hasMore === true && (typeof locationContinuation !== 'string' || !locationContinuation)) {
        throw new Error('Location list did not provide a continuation cursor.');
      }
      const primaryLocation = resolveTenantVisibleLocation(locationRows, requestedLocationId);
      const range = viewRange(dateValue, mode, safeTimeZone(primaryLocation?.timezone));
      const [scheduleRows, shiftRows] = primaryLocation?.id
        ? await Promise.all([
          fetchAllBoundedPages(
            buildLocationScheduleQuery(range, primaryLocation.id),
            (path) => fetchJsonWithSession<BoundedPage<ScheduleRecord>>(path),
          ),
          fetchAllBoundedPages(
            buildLocationShiftQuery(range, primaryLocation.id),
            (path) => fetchJsonWithSession<BoundedPage<ShiftRecord>>(path),
          ),
        ])
        : [[], []];
      if (requestId !== latestLoadRequestRef.current) return;
      selectedLocationRef.current = primaryLocation?.id ?? '';
      setPermissions(effectivePermissions);
      setStaff(staffRows.slice().sort((left, right) =>
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      ));
      setLocations(locationRows);
      setNextLocationCursor(locationContinuation ?? null);
      setSchedules(scheduleRows);
      setShiftDraft((current) => (
        primaryLocation?.id && current.locationId !== primaryLocation.id
          ? { ...current, locationId: primaryLocation.id }
          : current
      ));
      const locationShifts = primaryLocation?.id
        ? shiftsForLocation(shiftRows, primaryLocation.id)
        : [];
      setShifts(locationShifts);
      setLoadedShiftScope(primaryLocation?.id ? { locationId: primaryLocation.id, dateValue, viewMode: mode } : null);
      const shiftCount = locationShifts.length;
      setScheduleStatus({
        tone: 'ready',
        message: `${shiftCount ? `${shiftCountLabel(shiftCount)} loaded from saved schedule records` : 'No saved shifts in this range'}. Updated ${formatStatusTime(new Date())}.`,
      });
    } catch (err) {
      if (requestId !== latestLoadRequestRef.current) return;
      setError((err as Error).message);
      setStaff([]);
      setLocations([]);
      setNextLocationCursor(null);
      setSchedules([]);
      setShifts([]);
      setLoadedShiftScope(null);
      setScheduleStatus({ tone: 'error', message: 'Schedule data could not be loaded.' });
    } finally {
      if (requestId === latestLoadRequestRef.current) setIsLoading(false);
    }
  }, []);

  const loadMoreLocations = useCallback(async () => {
    if (!nextLocationCursor) return;
    setIsLoadingMoreLocations(true);
    setError(null);
    try {
      const payload = await fetchJsonWithSession<LocationPage>(
        '/locations?limit=200&cursor=' + encodeURIComponent(nextLocationCursor),
      );
      const rows = Array.isArray(payload.data) ? payload.data : [];
      const continuation = payload.pagination?.hasMore === true ? payload.pagination.nextCursor : null;
      if (payload.pagination?.hasMore === true && (typeof continuation !== 'string' || !continuation)) {
        throw new Error('Location list did not provide a continuation cursor.');
      }
      setLocations((current) => {
        const byId = new Map(current.map((location) => [location.id, location]));
        for (const location of rows) byId.set(location.id, location);
        return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      });
      setNextLocationCursor(continuation ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load more locations.');
    } finally {
      setIsLoadingMoreLocations(false);
    }
  }, [nextLocationCursor]);

  useEffect(() => {
    void loadSchedule(selectedDate, viewMode, shiftDraft.locationId || initialLocationId || undefined);
  }, [initialLocationId, loadSchedule, selectedDate, shiftDraft.locationId, viewMode]);

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

  const invalidateLocationData = useCallback((locationId: string, dateValue: string, mode: SchedulerViewMode) => {
    latestLoadRequestRef.current += 1;
    solveGenerationRef.current += 1;
    selectedLocationRef.current = locationId;
    selectedDateRef.current = dateValue;
    viewModeRef.current = mode;
    setLoadedShiftScope(null);
    setShifts([]);
    setIsLoading(true);
    setSolvingScheduleId(null);
  }, []);

  const selectScheduleLocation = (locationId: string) => {
    invalidateLocationData(locationId, selectedDate, viewMode);
    setEditingShiftId(null);
    setConfirmDeleteShiftId(null);
    setShiftDraft((current) => ({ ...current, locationId }));
  };

  const selectScheduleDate = (dateValue: string) => {
    invalidateLocationData(shiftDraft.locationId || locations[0]?.id || '', dateValue, viewMode);
    setSelectedDate(dateValue);
  };

  const selectScheduleViewMode = (mode: SchedulerViewMode) => {
    invalidateLocationData(shiftDraft.locationId || locations[0]?.id || '', selectedDate, mode);
    setViewMode(mode);
  };

  const schedulableStaff = useMemo(() => staff.filter((person) => isSchedulableStaffRole(person.role)), [staff]);

  const resources = useMemo(() => {
    const staffResources = schedulableStaff.map((person) => ({
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
  }, [schedulableStaff]);

  const openShifts = useMemo(() => shifts.filter((shift) => !shift.userId), [shifts]);
  const visibleShifts = openFocus ? openShifts : shifts;
  const visibleResources = useMemo(() => {
    if (!openFocus) return resources;
    return resources.filter((resource) => resource.id === UNASSIGNED_RESOURCE_ID);
  }, [openFocus, resources]);

  const scheduleEvents = useMemo(() => shiftsToEvents(visibleShifts), [visibleShifts]);

  const dateLabel = useMemo(
    () => {
      const dates = visibleDateValues(selectedDate, viewMode);
      if (dates.length === 1) return shortDateLabel(dates[0]);
      return `${shortDateLabel(dates[0])} - ${shortDateLabel(dates[dates.length - 1])}`;
    },
    [selectedDate, viewMode],
  );

  const visibleRange = useMemo(() => viewRange(selectedDate, viewMode, activeTimeZone), [activeTimeZone, selectedDate, viewMode]);
  const scheduleStatusById = useMemo(
    () => new Map(schedules.map((schedule) => [schedule.id, schedule.status])),
    [schedules],
  );
  const locationNameById = useMemo(
    () => new Map(locations.map((location) => [location.id, location.name])),
    [locations],
  );
  const schedulesInRange = useMemo(
    () => schedules
      .filter((schedule) => schedule.status !== 'ARCHIVED')
      .filter((schedule) => !shiftDraft.locationId || schedule.locationId === shiftDraft.locationId)
      .filter((schedule) => rangesOverlap(schedule.startDate, schedule.endDate, visibleRange.start, visibleRange.end))
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()),
    [schedules, shiftDraft.locationId, visibleRange.end, visibleRange.start],
  );
  const scheduleReviewItems = useMemo(
    () => schedulesInRange.map((schedule) => {
      const scheduleShifts = shifts.filter((shift) => shift.scheduleId === schedule.id);
      return {
        schedule,
        locationName: locationNameById.get(schedule.locationId) ?? 'Location',
        loadedShiftCount: scheduleShifts.length,
        openShiftCount: scheduleShifts.filter((shift) => !shift.userId).length,
        blocker: publishBlockerForShifts(scheduleShifts),
        solveJob: solveJobsByScheduleId[schedule.id] ?? null,
      };
    }),
    [locationNameById, schedulesInRange, shifts, solveJobsByScheduleId],
  );

  const isShiftLocked = useCallback(
    (shift: ShiftRecord) => Boolean(shift.scheduleId && scheduleStatusById.get(shift.scheduleId) === 'PUBLISHED'),
    [scheduleStatusById],
  );

  const publishedScheduleForDraft = useCallback(
    (locationId: string, dateValue: string) => {
      const range = dayRangeFromDateValue(dateValue, locationTimeZone(locationId));
      return schedules.find((schedule) =>
        schedule.locationId === locationId &&
        schedule.status === 'PUBLISHED' &&
        rangesOverlap(schedule.startDate, schedule.endDate, range.start, range.end),
      );
    },
    [locationTimeZone, schedules],
  );
  const editingShift = useMemo(
    () => shifts.find((shift) => shift.id === editingShiftId) ?? null,
    [editingShiftId, shifts],
  );
  const canDeleteEditingShift = Boolean(editingShift && capabilities.canDeleteShifts && !isShiftLocked(editingShift));

  const shiftFormBlockReason = useMemo(() => {
    if (!locations.length) return 'Add a location before saving shifts.';
    if (!schedulableStaff.length) return 'Add a staff member or manager before saving shifts.';
    if (!shiftDraft.userId || !schedulableStaff.some((person) => person.id === shiftDraft.userId)) return 'Select a schedulable staff member.';
    const windowError = shiftWindowError(shiftDraft.shiftDate, shiftDraft.startTime, shiftDraft.endTime, locationTimeZone(shiftDraft.locationId));
    if (windowError) return windowError;
    return null;
  }, [locationTimeZone, locations.length, schedulableStaff, shiftDraft]);

  const handleDraftStaffChange = (value: string) => {
    const selectedStaff = schedulableStaff.find((person) => person.id === value);
    setShiftDraft((current) => ({
      ...current,
      userId: value,
      role: selectedStaff ? toSchedulableShiftRole(selectedStaff.role) : current.role,
    }));
  };

  const addShift = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setError(null);
    if (!capabilities.canWriteShifts) {
      setError('You have read-only schedule access.');
      return;
    }
    const locationId = shiftDraft.locationId || locations[0]?.id;
    if (!locationId) {
      setError('Add a location before creating schedule shifts.');
      return;
    }
    if (!locationDataCurrent || !loadedShiftScope) {
      setScheduleStatus({ tone: 'warning', message: 'Wait for the selected location to finish loading before saving shifts.' });
      return;
    }
    const writeScope = loadedShiftScope;
    const draftTimeZone = locationTimeZone(locationId);
    const windowError = shiftWindowError(shiftDraft.shiftDate, shiftDraft.startTime, shiftDraft.endTime, draftTimeZone);
    if (windowError) {
      setError(windowError);
      return;
    }
    const lockedSchedule = publishedScheduleForDraft(locationId, shiftDraft.shiftDate);
    if (!editingShiftId && lockedSchedule) {
      setError(`Published schedules are locked for ${scheduleWindowLabel(lockedSchedule, draftTimeZone)} at ${locationNameById.get(locationId) ?? 'this location'}.`);
      setScheduleStatus({ tone: 'warning', message: 'Create a new draft schedule before adding shifts to a published day.' });
      return;
    }

    const selectedStaff = schedulableStaff.find((person) => person.id === shiftDraft.userId);
    if (!selectedStaff) {
      setError('Select a schedulable staff member before creating a shift.');
      return;
    }
    const range = shiftRange(shiftDraft.shiftDate, shiftDraft.startTime, shiftDraft.endTime, draftTimeZone);
    const containingDraft = containingDraftScheduleForShift(schedules, locationId, range.startTime, range.endTime);
    const nextRole = toSchedulableShiftRole(shiftDraft.role || selectedStaff.role);
    setScheduleStatus({ tone: 'saving', message: editingShiftId ? 'Saving shift changes...' : 'Creating and saving shift...' });
    try {
      if (editingShiftId) {
        const updateRequest = {
          startTime: range.startTime,
          endTime: range.endTime,
          userId: selectedStaff.id,
          role: nextRole,
        };
        const updateAttempt = beginShiftUpdateAttempt(
          window.sessionStorage,
          editingShiftId,
          updateRequest,
          shiftUpdateAttemptsRef.current[editingShiftId],
        );
        shiftUpdateAttemptsRef.current[editingShiftId] = updateAttempt;
        const updated = await fetchJsonWithSession<ShiftRecord>(
          `/shifts/${editingShiftId}`,
          withIdempotencyKey(jsonWriteInit('PUT', updateRequest), updateAttempt.key),
        );
        clearShiftUpdateAttempt(window.sessionStorage, editingShiftId, updateAttempt.key);
        if (shiftUpdateAttemptsRef.current[editingShiftId]?.key === updateAttempt.key) {
          delete shiftUpdateAttemptsRef.current[editingShiftId];
        }
        if (!scopeIsStillSelected(writeScope)) return;
        setShifts((current) => current.map((shift) => (shift.id === editingShiftId ? updated : shift)));
        setScheduleStatus({ tone: 'saved', message: `Shift changes saved at ${formatStatusTime(new Date())}.` });
      } else {
        const createRequest = {
          locationId,
          scheduleId: containingDraft?.id,
          userId: selectedStaff.id,
          role: nextRole,
          ...range,
        };
        const createAttempt = idempotentRequestAttempt(createRequest, shiftCreateAttemptRef.current);
        shiftCreateAttemptRef.current = createAttempt;
        const created = await fetchJsonWithSession<ShiftRecord>(
          '/shifts',
          withIdempotencyKey(jsonWriteInit('POST', createRequest), createAttempt.key),
        );
        if (!scopeIsStillSelected(writeScope)) return;
        setShifts((current) => [...current, created]);
        if (created.scheduleId) {
          const scheduleRange = fallbackDraftWindowForShift(created.startTime, created.endTime, draftTimeZone);
          setSchedules((current) => current.some((schedule) => schedule.id === created.scheduleId)
            ? current
            : [
              ...current,
              {
                id: created.scheduleId as string,
                locationId: created.locationId,
                startDate: scheduleRange.start,
                endDate: scheduleRange.end,
                status: 'DRAFT',
                publishedAt: null,
              },
            ]);
        }
        shiftCreateAttemptRef.current = null;
        setScheduleStatus({ tone: 'saved', message: `Shift created and saved at ${formatStatusTime(new Date())}.` });
      }
      setShowShiftForm(false);
      setEditingShiftId(null);
      setConfirmDeleteShiftId(null);
      setShiftDraft((current) => ({
        ...current,
        userId: '',
        role: 'STAFF',
      }));
    } catch (err) {
      setError((err as Error).message);
      setScheduleStatus({ tone: 'error', message: 'Shift save failed. Schedule was not changed.' });
    }
  };

  const prepareShiftForStaff = (person: StaffRosterItem, shiftDate: string, startTime = '09:00', endTime = '17:00') => {
    if (!capabilities.canWriteShifts) return;
    setError(null);
    setEditingShiftId(null);
    setConfirmDeleteShiftId(null);
    setShiftDraft((current) => ({
      ...current,
      userId: person.id,
      locationId: current.locationId || locations[0]?.id || '',
      role: toSchedulableShiftRole(person.role),
      shiftDate,
      startTime,
      endTime,
    }));
    setShowShiftForm(true);
  };

  const prepareShiftFromBoardSlot = (slot: StaffScheduleSlotSelection) => {
    if (!capabilities.canWriteShifts) return;
    const person = schedulableStaff.find((item) => item.id === slot.resourceId);
    if (!person) return;
    prepareShiftForStaff(person, dateValueInTimeZone(slot.start, activeTimeZone), timeValueFromIso(slot.start, activeTimeZone), timeValueFromIso(slot.end, activeTimeZone));
  };

  const openCreateShift = () => {
    if (!capabilities.canWriteShifts) {
      setError('You have read-only schedule access.');
      return;
    }
    const firstStaff = schedulableStaff[0] ?? null;
    setError(null);
    setEditingShiftId(null);
    setConfirmDeleteShiftId(null);
    if (!locations.length) {
      setShowShiftForm(false);
      setError('Add a location before creating schedule shifts.');
      setScheduleStatus({ tone: 'warning', message: 'Shift creation needs a location first.' });
      return;
    }
    if (!firstStaff) {
      setShowShiftForm(false);
      setError('Add a staff member or manager before creating schedule shifts.');
      setScheduleStatus({ tone: 'warning', message: 'Shift creation needs schedulable staff first.' });
      return;
    }
    setShiftDraft((current) => ({
      ...DEFAULT_SHIFT_DRAFT,
      userId: firstStaff.id,
      locationId: current.locationId || locations[0]?.id || '',
      role: toSchedulableShiftRole(firstStaff.role),
      shiftDate: selectedDate,
    }));
    setShowShiftForm(true);
  };

  const editShiftFromBoard = (event: StaffScheduleEvent) => {
    if (!capabilities.canWriteShifts) return;
    const shift = shifts.find((item) => item.id === event.id);
    if (!shift) return;
    if (isShiftLocked(shift)) {
      setError('Published schedules are locked. Create a new draft before changing shifts.');
      setScheduleStatus({ tone: 'warning', message: 'Published schedule shifts cannot be edited.' });
      return;
    }
    const person = shift.userId ? schedulableStaff.find((item) => item.id === shift.userId) : null;
    const window = localTimeWindowFromInstants(shift.startTime, shift.endTime, locationTimeZone(shift.locationId));
    setError(null);
    setEditingShiftId(shift.id);
    setConfirmDeleteShiftId(null);
    setShiftDraft({
      userId: person?.id ?? '',
      locationId: shift.locationId,
      role: toSchedulableShiftRole(shift.role ?? person?.role),
      shiftDate: window.date,
      startTime: window.startTime,
      endTime: window.endTime,
    });
    setShowShiftForm(true);
  };

  const runGenerate = async () => {
    if (!capabilities.canWriteLunchBreaks) {
      setError('You need lunch/break write access to generate breaks.');
      return;
    }
    setIsGenerating(true);
    setError(null);
    setScheduleStatus({ tone: 'saving', message: 'Generating and saving break plan...' });
    try {
      const activeLocationId = shiftDraft.locationId || locations[0]?.id;
      if (!activeLocationId) {
        setScheduleStatus({ tone: 'warning', message: 'Select a location before generating breaks.' });
        return;
      }
      if (!locationDataCurrent || !loadedShiftScope) {
        setScheduleStatus({ tone: 'warning', message: 'Wait for the selected location to finish loading before generating breaks.' });
        return;
      }
      const generationScope = loadedShiftScope;
      const shiftIds = shiftIdsForLocation(shifts, activeLocationId);
      if (shiftIds.length === 0) {
        setScheduleStatus({ tone: 'warning', message: 'No shifts are loaded for break generation.' });
        return;
      }
      const requestBody = { locationId: activeLocationId, shiftIds, persist: true };
      const refreshedLocationShifts = await executeBreakGenerationWithRecovery({
        requestBody,
        currentAttempt: breakGenerationAttemptRef.current,
        retainAttempt: (attempt) => {
          breakGenerationAttemptRef.current = attempt;
        },
        postGeneration: (key) => fetchJsonWithSession<BreakGenerationResponse>('/lunch-breaks/generate', {
          ...withIdempotencyKey(jsonWriteInit('POST', requestBody), key),
        }),
        reconcile: async (generationResponse) => {
          assertBreakGenerationResponseScope(generationResponse, activeLocationId, shiftIds);
          if (!scopeIsStillSelected(generationScope)) return null;
          const range = viewRange(selectedDate, viewMode, locationTimeZone(activeLocationId));
          const refreshed = await fetchJsonWithSession<{ data: ShiftRecord[] }>(
            buildLocationShiftQuery(range, activeLocationId),
          );
          if (!scopeIsStillSelected(generationScope)) return null;
          return shiftsForLocation(refreshed.data ?? [], activeLocationId);
        },
      });
      if (!refreshedLocationShifts) return;
      setShifts(refreshedLocationShifts);
      setScheduleStatus({ tone: 'saved', message: `Breaks generated and saved for ${shiftCountLabel(refreshedLocationShifts.length)} at ${formatStatusTime(new Date())}.` });
    } catch (err) {
      setError((err as Error).message);
      setScheduleStatus(breakGenerationAttemptRef.current?.postConfirmed
        ? { tone: 'warning', message: 'Breaks were saved, but the calendar could not reconcile them. Retry to refresh without another generation charge.' }
        : { tone: 'error', message: 'Break generation could not be confirmed. Retry will reuse the original request.' });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      await loadSchedule(selectedDate, viewMode, shiftDraft.locationId || undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsRefreshing(false);
    }
  };

  const openPrintSchedule = () => {
    const params = new URLSearchParams({ date: selectedDate, autoprint: '1' });
    const locationId = shiftDraft.locationId || locations[0]?.id;
    if (locationId) params.set('locationId', locationId);
    window.open(`/dashboard/scheduling/print?${params.toString()}`, '_blank', 'noopener,noreferrer');
  };

  const publishSchedule = async (scheduleId: string) => {
    if (publishingScheduleIdRef.current) return;
    if (!capabilities.canPublishSchedules) {
      setError('You need schedule publish access to finalize schedules.');
      return;
    }
    const schedule = schedules.find((item) => item.id === scheduleId);
    if (!schedule || schedule.status !== 'DRAFT') return;
    publishingScheduleIdRef.current = scheduleId;
    setIsPublishing(true);
    setError(null);
    const replayingOriginalAttempt = publishRetryByScheduleId[scheduleId] === true;
    let publishRequestStarted = false;
    setScheduleStatus({
      tone: 'saving',
      message: replayingOriginalAttempt
        ? 'Replaying the original publish attempt...'
        : 'Reviewing schedule readiness and configured credit cost...',
    });
    try {
      const reviewIsConfirmed = confirmPublishScheduleId === scheduleId
        && publishReview?.scheduleId === scheduleId
        && publishReview.sufficientCredits;
      if (!replayingOriginalAttempt && !reviewIsConfirmed) {
        const { blocker, preflight } = await loadSchedulePublishReview(scheduleId);
        if (blocker) {
          setConfirmPublishScheduleId(null);
          setPublishReview(null);
          setError(blocker);
          setScheduleStatus({ tone: 'warning', message: 'Schedule needs cleanup before publish.' });
          return;
        }
        setPublishReview(preflight);
        if (!preflight.sufficientCredits) {
          setConfirmPublishScheduleId(null);
          setScheduleStatus({
            tone: 'warning',
            message: `${publishPreflightSummary(preflight)} Publishing remains blocked until the wallet has enough credits.`,
          });
          return;
        }
        setConfirmPublishScheduleId(scheduleId);
        setScheduleStatus({
          tone: 'warning',
          message: `${publishPreflightSummary(preflight)} Confirm publish for ${scheduleWindowLabel(schedule, locationTimeZone(schedule.locationId))}.`,
        });
        return;
      }

      if (!replayingOriginalAttempt && publishReview) {
        const { blocker, preflight: latestPreflight } = await loadSchedulePublishReview(scheduleId);
        if (blocker) {
          setConfirmPublishScheduleId(null);
          setPublishReview(null);
          setError(blocker);
          setScheduleStatus({ tone: 'warning', message: 'Schedule changed and needs cleanup before publish.' });
          return;
        }
        setPublishReview(latestPreflight);
        if (!latestPreflight.sufficientCredits) {
          setConfirmPublishScheduleId(null);
          setScheduleStatus({
            tone: 'warning',
            message: `${publishPreflightSummary(latestPreflight)} Publishing remains blocked until the wallet has enough credits.`,
          });
          return;
        }
        if (!schedulePublishCostMatches(publishReview, latestPreflight)) {
          setScheduleStatus({
            tone: 'warning',
            message: `${publishPreflightSummary(latestPreflight)} The configured total changed; confirm the updated cost.`,
          });
          return;
        }
      }

      const publishAttempt = schedulePublishAttempt(
        scheduleId,
        publishReview!.acceptedContract,
        publishAttemptsRef.current[scheduleId],
      );
      publishAttemptsRef.current[scheduleId] = publishAttempt;
      publishRequestStarted = true;
      const publishedPayload = await fetchJsonWithSession<unknown>(
        `/schedules/${scheduleId}/publish`,
        withIdempotencyKey(jsonWriteInit('POST', {
          acceptedContract: publishReview!.acceptedContract,
        }), publishAttempt.key),
      );
      const published = parseSchedulePublishResponse(scheduleId, publishedPayload);
      setSchedules((current) => current.map((item) => item.id === scheduleId
        ? { ...item, status: published.status, publishedAt: published.publishedAt }
        : item));
      delete publishAttemptsRef.current[scheduleId];
      setPublishRetryByScheduleId((current) => {
        const next = { ...current };
        delete next[scheduleId];
        return next;
      });
      setPublishReview((current) => current?.scheduleId === scheduleId ? null : current);
      setConfirmPublishScheduleId(null);
      setConfirmReopenScheduleId(null);
      setShowShiftForm(false);
      setEditingShiftId(null);
      setConfirmDeleteShiftId(null);
      const settlementOutcome = publishSettlementSummary(published.settlement);
      setPublishSettlementByScheduleId((current) => ({
        ...current,
        [scheduleId]: settlementOutcome,
      }));
      const notificationOutcome = publishNotificationOutcome(published.notifications);
      setScheduleStatus({
        tone: notificationOutcome?.tone ?? 'saved',
        message: notificationOutcome
          ? `${settlementOutcome} ${notificationOutcome.message}`
          : `${settlementOutcome} Confirmed at ${formatStatusTime(new Date(published.publishedAt))}.`,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Schedule publication failed.');
      const status = err instanceof ApiRequestError ? err.status : null;
      const failure = schedulePublishFailure(status, error.message);
      if (!publishRequestStarted) {
        setConfirmPublishScheduleId(null);
        setScheduleStatus({
          tone: 'error',
          message: status === 402 || status === 403
            ? failure.message
            : 'Publish preflight could not be confirmed. No publish request was sent or settled.',
        });
        setError(error.message);
        return;
      }
      if (failure.resetAttempt) delete publishAttemptsRef.current[scheduleId];
      setPublishRetryByScheduleId((current) => {
        const next = { ...current };
        if (failure.retryMode === 'replay') next[scheduleId] = true;
        else delete next[scheduleId];
        return next;
      });
      if (failure.retryMode === 'review') setConfirmPublishScheduleId(null);
      setError(status === 409 && error.message ? `${failure.message} ${error.message}` : failure.message);
      setScheduleStatus({ tone: failure.retryMode === 'replay' ? 'warning' : 'error', message: failure.message });
    } finally {
      publishingScheduleIdRef.current = null;
      setIsPublishing(false);
    }
  };

  const reopenSchedule = async (scheduleId: string) => {
    if (!capabilities.canPublishSchedules) {
      setError('You need schedule publish access to reopen schedules.');
      return;
    }
    const schedule = schedules.find((item) => item.id === scheduleId);
    if (!schedule || schedule.status !== 'PUBLISHED') return;
    if (confirmReopenScheduleId !== scheduleId) {
      setConfirmReopenScheduleId(scheduleId);
      setConfirmPublishScheduleId(null);
      setScheduleStatus({
        tone: 'warning',
        message: `Confirm reopen for ${scheduleWindowLabel(schedule, locationTimeZone(schedule.locationId))}. Staff will no longer see it until it is published again.`,
      });
      return;
    }

    setIsReopening(true);
    setError(null);
    setScheduleStatus({ tone: 'saving', message: 'Reopening published schedule for correction...' });
    try {
      await fetchJsonWithSession(`/schedules/${scheduleId}/reopen`, {
        ...jsonWriteInit('POST', {}),
      });
      setSchedules((current) => current.map((item) => item.id === scheduleId
        ? { ...item, status: 'DRAFT', publishedAt: null }
        : item));
      setPublishSettlementByScheduleId((current) => {
        const next = { ...current };
        delete next[scheduleId];
        return next;
      });
      setPublishReview((current) => current?.scheduleId === scheduleId ? null : current);
      setConfirmReopenScheduleId(null);
      setConfirmPublishScheduleId(null);
      setShowShiftForm(false);
      setEditingShiftId(null);
      setConfirmDeleteShiftId(null);
      setScheduleStatus({ tone: 'saved', message: 'Schedule reopened as a draft. Corrections are enabled.' });
    } catch (err) {
      setConfirmReopenScheduleId(null);
      setError((err as Error).message);
      setScheduleStatus({ tone: 'error', message: 'Schedule could not be reopened.' });
    } finally {
      setIsReopening(false);
    }
  };

  const runAutoSchedule = async (scheduleId: string, scheduleOverride?: ScheduleRecord) => {
    if (!capabilities.canWriteSchedules) {
      setError('You need schedule write access to auto-schedule.');
      return;
    }
    const schedule = scheduleOverride ?? schedules.find((item) => item.id === scheduleId);
    if (!schedule || schedule.status !== 'DRAFT') return;
    try {
      const demandWindows = await loadDemandWindows(scheduleId);
      if (demandWindows.length === 0) {
        setError('Add and save at least one demand window before auto-scheduling.');
        setScheduleStatus({ tone: 'warning', message: 'Demand setup is required before auto-scheduling.' });
        return;
      }
    } catch (err) {
      setError((err as Error).message);
      setScheduleStatus({ tone: 'error', message: 'Demand setup could not be checked before auto-scheduling.' });
      return;
    }
    let scheduleShifts: ShiftRecord[];
    try {
      scheduleShifts = await loadAllShiftsForSchedule(scheduleId);
    } catch (err) {
      setError((err as Error).message);
      setScheduleStatus({ tone: 'error', message: 'Draft shifts could not be checked before auto-scheduling.' });
      return;
    }
    const replacingNonblankDraft = scheduleShifts.length > 0;
    const existingAttempt = autoScheduleAttemptsRef.current[scheduleId];
    if (!existingAttempt && replacingNonblankDraft && confirmReplaceScheduleId !== scheduleId) {
      setConfirmReplaceScheduleId(scheduleId);
      setScheduleStatus({ tone: 'warning', message: 'Auto-schedule will replace every shift in this draft. Confirm replacement to continue.' });
      return;
    }
    const requestAttempt = existingAttempt ?? {
      key: globalThis.crypto.randomUUID(),
      confirmReplace: replacingNonblankDraft,
    };
    autoScheduleAttemptsRef.current[scheduleId] = requestAttempt;
    saveAutoScheduleRecovery(window.sessionStorage, {
      scheduleId,
      attemptKey: requestAttempt.key,
      confirmReplace: requestAttempt.confirmReplace,
      updatedAt: Date.now(),
    });
    solveRecoveryStartedRef.current.add(scheduleId);
    const solveScope: LocationShiftScope = {
      locationId: selectedLocationRef.current || shiftDraft.locationId,
      dateValue: selectedDateRef.current,
      viewMode: viewModeRef.current,
    };
    const solveGeneration = ++solveGenerationRef.current;
    const solveIsCurrent = () => (
      solveGenerationRef.current === solveGeneration && scopeIsStillSelected(solveScope)
    );
    setSolvingScheduleId(scheduleId);
    setConfirmPublishScheduleId(null);
    setError(null);
    const scheduleTimeZone = locationTimeZone(schedule.locationId);
    setScheduleStatus({ tone: 'saving', message: `Queueing auto-schedule for ${scheduleWindowLabel(schedule, scheduleTimeZone)}...` });
    try {
      const requestInit = jsonWriteInit('POST', {
        constraints: {},
        confirmReplace: requestAttempt.confirmReplace,
      });
      const requestHeaders = new Headers(requestInit.headers);
      requestHeaders.set('Idempotency-Key', requestAttempt.key);
      const queued = await fetchJsonWithSession<AutoScheduleResponse>(`/schedules/${scheduleId}/auto-schedule`, {
        ...requestInit,
        headers: requestHeaders,
      });
      setConfirmReplaceScheduleId(null);
      const statusPath = jobStatusPath(queued.statusUrl, scheduleId, queued.jobId);
      let latest: ScheduleSolveJobSnapshot = {
        jobId: queued.jobId,
        status: queued.status,
        statusUrl: statusPath,
      };
      saveAutoScheduleRecovery(window.sessionStorage, {
        scheduleId,
        attemptKey: requestAttempt.key,
        confirmReplace: requestAttempt.confirmReplace,
        jobId: queued.jobId,
        statusUrl: statusPath,
        updatedAt: Date.now(),
      });
      if (solveIsCurrent()) {
        setSolveJobsByScheduleId((current) => ({ ...current, [scheduleId]: latest }));
        setScheduleStatus({ tone: 'saving', message: `Auto-schedule ${latest.status.toLowerCase()}.` });
      }

      for (let attempt = 0; attempt < 30 && !isTerminalSolveStatus(latest.status); attempt += 1) {
        await sleep(attempt === 0 ? 1200 : 3000);
        const polled = await fetchJsonWithSession<ScheduleSolveJobSnapshot>(statusPath);
        latest = { ...polled, statusUrl: statusPath };
        if (solveIsCurrent()) {
          setSolveJobsByScheduleId((current) => ({ ...current, [scheduleId]: latest }));
          setScheduleStatus({ tone: 'saving', message: solveStatusLabel(latest) });
        }
      }

      if (latest.status.toUpperCase() === 'SUCCEEDED') {
        delete autoScheduleAttemptsRef.current[scheduleId];
        clearAutoScheduleRecovery(window.sessionStorage, scheduleId);
        solveRecoveryStartedRef.current.delete(scheduleId);
        if (!solveIsCurrent()) return;
        await loadSchedule(solveScope.dateValue, solveScope.viewMode, solveScope.locationId || undefined);
        if (solveIsCurrent()) {
          setScheduleStatus({ tone: 'saved', message: `Auto-schedule solved ${scheduleWindowLabel(schedule, scheduleTimeZone)}.` });
        }
        return;
      }
      if (isTerminalSolveStatus(latest.status)) {
        delete autoScheduleAttemptsRef.current[scheduleId];
        clearAutoScheduleRecovery(window.sessionStorage, scheduleId);
        solveRecoveryStartedRef.current.delete(scheduleId);
        if (solveIsCurrent()) {
          setError(solveStatusLabel(latest));
          setScheduleStatus({ tone: 'error', message: 'Auto-schedule failed.' });
        }
        return;
      }
      if (solveIsCurrent()) {
        setScheduleStatus({ tone: 'warning', message: 'Auto-schedule is still running. Reload to refresh job status.' });
      }
    } catch (err) {
      if (solveIsCurrent()) {
        setError((err as Error).message);
        setScheduleStatus({ tone: 'error', message: 'Auto-schedule could not be queued or checked.' });
      }
    } finally {
      if (solveIsCurrent()) setSolvingScheduleId(null);
    }
  };

  useEffect(() => {
    if (isLoading || schedules.length === 0) return;
    for (const recovery of readAutoScheduleRecoveries(window.sessionStorage)) {
      const schedule = schedules.find((item) => item.id === recovery.scheduleId);
      if (!schedule || schedule.status !== 'DRAFT' || solveRecoveryStartedRef.current.has(schedule.id)) continue;
      autoScheduleAttemptsRef.current[schedule.id] = {
        key: recovery.attemptKey,
        confirmReplace: recovery.confirmReplace,
      };
      solveRecoveryStartedRef.current.add(schedule.id);
      void (async () => {
        let jobId = recovery.jobId;
        let statusPath = recovery.statusUrl;
        try {
          if (!jobId) {
            const requestInit = jsonWriteInit('POST', {
              constraints: {},
              confirmReplace: recovery.confirmReplace,
            });
            const headers = new Headers(requestInit.headers);
            headers.set('Idempotency-Key', recovery.attemptKey);
            const queued = await fetchJsonWithSession<AutoScheduleResponse>(
              `/schedules/${schedule.id}/auto-schedule`,
              { ...requestInit, headers },
            );
            jobId = queued.jobId;
            statusPath = jobStatusPath(queued.statusUrl, schedule.id, queued.jobId);
          }
          if (!jobId) return;
          statusPath = jobStatusPath(statusPath, schedule.id, jobId);
          saveAutoScheduleRecovery(window.sessionStorage, {
            scheduleId: schedule.id,
            attemptKey: recovery.attemptKey,
            confirmReplace: recovery.confirmReplace,
            jobId,
            statusUrl: statusPath,
            updatedAt: Date.now(),
          });
          setSolvingScheduleId(schedule.id);
          let latest: ScheduleSolveJobSnapshot = { jobId, status: 'QUEUED', statusUrl: statusPath };
          setSolveJobsByScheduleId((current) => ({ ...current, [schedule.id]: latest }));
          for (let attempt = 0; attempt < 120 && !isTerminalSolveStatus(latest.status); attempt += 1) {
            if (attempt > 0) await sleep(3000);
            const polled = await fetchJsonWithSession<ScheduleSolveJobSnapshot>(statusPath);
            latest = { ...polled, statusUrl: statusPath };
            setSolveJobsByScheduleId((current) => ({ ...current, [schedule.id]: latest }));
          }
          if (isTerminalSolveStatus(latest.status)) {
            clearAutoScheduleRecovery(window.sessionStorage, schedule.id);
            delete autoScheduleAttemptsRef.current[schedule.id];
          }
          if (latest.status.toUpperCase() === 'SUCCEEDED') {
            await loadSchedule(
              selectedDateRef.current,
              viewModeRef.current,
              selectedLocationRef.current || undefined,
            );
            setScheduleStatus({ tone: 'saved', message: `Auto-schedule solved ${scheduleWindowLabel(schedule, locationTimeZone(schedule.locationId))}.` });
          } else if (isTerminalSolveStatus(latest.status)) {
            setError(solveStatusLabel(latest));
            setScheduleStatus({ tone: 'error', message: 'Auto-schedule failed.' });
          }
        } catch (err) {
          setError((err as Error).message);
          setScheduleStatus({ tone: 'warning', message: 'Auto-schedule recovery will retry after reload.' });
        } finally {
          solveRecoveryStartedRef.current.delete(schedule.id);
          setSolvingScheduleId((current) => current === schedule.id ? null : current);
        }
      })();
    }
  }, [isLoading, loadSchedule, locationTimeZone, schedules]);

  const runFirstUseAutoSchedule = async () => {
    if (!capabilities.canWriteSchedules) return;
    const location = locations.find((item) => item.id === shiftDraft.locationId) ?? locations[0];
    if (!location) {
      setError('Add a location before auto-scheduling.');
      return;
    }
    setError(null);
    setScheduleStatus({ tone: 'saving', message: 'Creating a draft schedule...' });
    try {
      const created = await fetchJsonWithSession<ScheduleRecord>('/schedules', {
        ...jsonWriteInit('POST', {
          locationId: location.id,
          startDate: selectedDate,
          endDate: addLocalDays(selectedDate, 7),
        }),
      });
      setSchedules((current) => [...current, created]);
      setScheduleStatus({ tone: 'saved', message: 'Draft schedule created. Add demand before auto-scheduling.' });
    } catch (err) {
      setError((err as Error).message);
      setScheduleStatus({ tone: 'error', message: 'The first schedule week could not be created.' });
    }
  };

  const updateShift = async (id: string, start: string, end: string, userId: string) => {
    if (!capabilities.canWriteShifts) return;
    if (!locationDataCurrent || !loadedShiftScope) return;
    const writeScope = loadedShiftScope;
    const shift = shifts.find((item) => item.id === id);
    if (shift && isShiftLocked(shift)) {
      setError('Published schedules are locked. Create a new draft before changing shifts.');
      setScheduleStatus({ tone: 'warning', message: 'Published schedule shifts cannot be moved.' });
      return;
    }
    const nextUserId = userId === UNASSIGNED_RESOURCE_ID ? null : userId;
    const selectedStaff = nextUserId ? schedulableStaff.find((person) => person.id === nextUserId) ?? null : null;
    setScheduleStatus({ tone: 'saving', message: 'Saving board change...' });
    setShifts((previous) =>
      previous.map((shift) => (shift.id === id ? applyStaffToShift({ ...shift, startTime: start, endTime: end }, selectedStaff) : shift)),
    );
    try {
      const updateRequest = {
        startTime: start,
        endTime: end,
        userId: nextUserId,
      };
      const updateAttempt = beginShiftUpdateAttempt(
        window.sessionStorage,
        id,
        updateRequest,
        shiftUpdateAttemptsRef.current[id],
      );
      shiftUpdateAttemptsRef.current[id] = updateAttempt;
      const updated = await fetchJsonWithSession<ShiftRecord>(
        `/shifts/${id}`,
        withIdempotencyKey(jsonWriteInit('PUT', updateRequest), updateAttempt.key),
      );
      clearShiftUpdateAttempt(window.sessionStorage, id, updateAttempt.key);
      if (shiftUpdateAttemptsRef.current[id]?.key === updateAttempt.key) {
        delete shiftUpdateAttemptsRef.current[id];
      }
      if (!scopeIsStillSelected(writeScope)) return;
      setShifts((previous) => previous.map((shift) => (shift.id === id ? updated : shift)));
      setScheduleStatus({ tone: 'saved', message: `Board change saved at ${formatStatusTime(new Date())}.` });
    } catch (err) {
      setError((err as Error).message);
      setScheduleStatus({ tone: 'error', message: 'Board change failed. Reloading saved schedule.' });
      void loadSchedule(selectedDate, viewMode, shiftDraft.locationId || undefined);
    }
  };

  const deleteShift = async (id: string) => {
    if (!capabilities.canDeleteShifts) {
      setError('You need shift delete access to remove shifts.');
      return;
    }
    if (!locationDataCurrent || !loadedShiftScope) return;
    const writeScope = loadedShiftScope;
    const shift = shifts.find((item) => item.id === id);
    if (!shift) return;
    if (isShiftLocked(shift)) {
      setError('Published schedules are locked. Create a new draft before deleting shifts.');
      setScheduleStatus({ tone: 'warning', message: 'Published schedule shifts cannot be deleted.' });
      return;
    }
    setError(null);
    setScheduleStatus({ tone: 'saving', message: 'Deleting shift...' });
    try {
      const response = await fetchWithSession(`/shifts/${id}`, deleteWriteInit());
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message = (payload as any)?.message;
        throw new Error(typeof message === 'string' ? message : `Request failed (${response.status})`);
      }
      if (!scopeIsStillSelected(writeScope)) return;
      setShifts((previous) => previous.filter((item) => item.id !== id));
      if (editingShiftId === id) {
        setShowShiftForm(false);
        setEditingShiftId(null);
      }
      setConfirmDeleteShiftId(null);
      setScheduleStatus({ tone: 'saved', message: `Shift deleted at ${formatStatusTime(new Date())}.` });
    } catch (err) {
      setError((err as Error).message);
      setScheduleStatus({ tone: 'error', message: 'Shift delete failed. Reloading saved schedule.' });
      void loadSchedule(selectedDate, viewMode, shiftDraft.locationId || undefined);
    }
  };

  return (
    <>
      <div className="scheduler-page">
        <section className="surface-card scheduler-workspace">
        <section className="scheduler-topbar">
          <div className="scheduler-topbar__left">
            <span className="workspace-kicker">Schedule workspace</span>
            <h1 className="workspace-title">Calendar</h1>
            <p className="workspace-subtitle">{dateLabel}</p>
            <div className={`scheduler-status-pill scheduler-status-pill--${scheduleStatus.tone}`} role="status" aria-live="polite">
              {scheduleStatus.message}
            </div>
          </div>

          <div className="scheduler-topbar__controls">
            <label className="scheduler-day-picker">
              <CalendarDays size={15} />
              <input aria-label="Schedule date" type="date" suppressHydrationWarning value={selectedDate} onChange={(event) => selectScheduleDate(event.target.value)} />
            </label>

            <div className="scheduler-view-toggle" role="group" aria-label="Scheduler view">
              {(['day', 'threeDay', 'week'] as SchedulerViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={viewMode === mode ? 'active' : ''}
                  onClick={() => selectScheduleViewMode(mode)}
                >
                  {mode === 'threeDay' ? '3-Day' : mode === 'day' ? 'Day' : 'Week'}
                </button>
              ))}
            </div>

            {nextLocationCursor ? (
              <Button variant="outline" onClick={() => void loadMoreLocations()} disabled={isLoadingMoreLocations}>
                {isLoadingMoreLocations ? 'Loading locations...' : 'Load more locations'}
              </Button>
            ) : null}

            <Button variant="secondary" onClick={handleRefresh} disabled={isLoading || isRefreshing}>
              {isLoading || isRefreshing ? 'Reloading...' : 'Reload'}
            </Button>

            {capabilities.canWriteShifts ? (
              <Button variant="secondary" onClick={openCreateShift}>
                <Plus size={16} />
                Add shift
              </Button>
            ) : null}

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
          <section className="scheduler-advanced" aria-label="Advanced settings panel">
            <p><strong>Advanced</strong> actions use tenant-scoped schedule data and do not cross company boundaries.</p>
            <div className="scheduler-advanced__actions">
              <Button variant="outline" size="sm" onClick={() => void handleRefresh()} disabled={isLoading || isRefreshing}><RefreshCw size={14} /> Reload</Button>
              {capabilities.canWriteLunchBreaks ? (
                <Button variant="outline" size="sm" onClick={runGenerate} disabled={isGenerating || !locationDataCurrent}><WandSparkles size={14} /> {isGenerating ? 'Generating...' : 'Generate breaks'}</Button>
              ) : null}
              {shifts.length > 0 ? (
                <Button variant="outline" size="sm" onClick={openPrintSchedule} disabled={isLoading}><Printer size={14} /> Print</Button>
              ) : null}
            </div>
          </section>
        ) : null}

        {scheduleReviewItems.length > 0 ? (
          <section className="scheduler-publish-panel" aria-label="Schedule publish review">
            <header>
              <div>
                <h2>Publish review</h2>
                <p>{scheduleReviewItems.length} schedule{scheduleReviewItems.length === 1 ? '' : 's'} in {dateLabel}</p>
              </div>
              {schedulesInRange.some((schedule) => schedule.status === 'PUBLISHED') ? (
                <span className="scheduler-publish-badge scheduler-publish-badge--published">
                  <CheckCircle2 size={14} />
                  Published
                </span>
              ) : null}
            </header>
            <div className="scheduler-publish-list">
              {scheduleReviewItems.map(({ schedule, locationName, loadedShiftCount, openShiftCount, blocker, solveJob }) => {
                const isPublished = schedule.status === 'PUBLISHED';
                const isConfirming = confirmPublishScheduleId === schedule.id;
                const canPublish = capabilities.canPublishSchedules && schedule.status === 'DRAFT';
                const canReopen = capabilities.canPublishSchedules && schedule.status === 'PUBLISHED';
                const canSolve = capabilities.canWriteSchedules && schedule.status === 'DRAFT';
                const isSolving = solvingScheduleId === schedule.id;
                const isConfirmingReopen = confirmReopenScheduleId === schedule.id;
                const preflight = publishReview?.scheduleId === schedule.id ? publishReview : null;
                const publishSettlement = publishSettlementByScheduleId[schedule.id];
                const isRetryingPublish = publishRetryByScheduleId[schedule.id] === true;
                return (
                  <div key={schedule.id} className={`scheduler-publish-row scheduler-publish-row--${schedule.status.toLowerCase()}`}>
                    <div className="scheduler-publish-row__main">
                      <span className="scheduler-publish-row__location">{locationName}</span>
                      <span>{scheduleWindowLabel(schedule, locationTimeZone(schedule.locationId))}</span>
                    </div>
                    <div className="scheduler-publish-row__meta">
                      <span>{loadedShiftCount} shift{loadedShiftCount === 1 ? '' : 's'}</span>
                      <span>{openShiftCount} open</span>
                      <span className={`scheduler-publish-badge scheduler-publish-badge--${schedule.status.toLowerCase()}`}>
                        {schedule.status}
                      </span>
                    </div>
                    <div className="scheduler-publish-row__actions">
                      {canSolve ? (
                        <Button
                          size="sm"
                          variant={confirmReplaceScheduleId === schedule.id ? 'default' : 'outline'}
                          onClick={() => void runAutoSchedule(schedule.id)}
                          disabled={Boolean(solvingScheduleId) || isPublishing}
                        >
                          <WandSparkles size={14} />
                          {isSolving ? 'Solving...' : confirmReplaceScheduleId === schedule.id ? 'Confirm replace' : 'Auto-schedule'}
                        </Button>
                      ) : null}
                      {canPublish ? (
                        <Button
                          size="sm"
                          variant={isConfirming ? 'default' : 'secondary'}
                          onClick={() => void publishSchedule(schedule.id)}
                          disabled={isPublishing || Boolean(solvingScheduleId)}
                          aria-describedby={preflight ? `publish-cost-${schedule.id}` : undefined}
                        >
                          <Send size={14} />
                          {isPublishing && publishingScheduleIdRef.current === schedule.id
                            ? 'Checking...'
                            : isRetryingPublish
                              ? 'Retry publish'
                              : isConfirming && preflight
                                ? `Confirm - ${creditCount(preflight.totalConfiguredCost)}`
                                : preflight && !preflight.sufficientCredits
                                  ? 'Recheck credits'
                                  : 'Publish'}
                        </Button>
                      ) : null}
                      {canReopen ? (
                        <Button
                          size="sm"
                          variant={isConfirmingReopen ? 'default' : 'outline'}
                          onClick={() => void reopenSchedule(schedule.id)}
                          disabled={isPublishing || isReopening || Boolean(solvingScheduleId)}
                        >
                          <RotateCcw size={14} />
                          {isConfirmingReopen ? 'Confirm reopen' : 'Reopen'}
                        </Button>
                      ) : null}
                    </div>
                    {solveJob ? (
                      <p className={`scheduler-publish-row__job scheduler-publish-row__job--${solveJob.status.toLowerCase()}`}>
                        {solveStatusLabel(solveJob)}
                      </p>
                    ) : null}
                    {blocker && !isPublished ? <p className="scheduler-publish-row__blocker">{blocker}</p> : null}
                    {preflight && !isPublished ? (
                      <div
                        id={`publish-cost-${schedule.id}`}
                        className={`scheduler-publish-row__cost${preflight.sufficientCredits ? '' : ' scheduler-publish-row__cost--blocked'}`}
                        role="status"
                        aria-live="polite"
                      >
                        <strong>Configured total: {creditCount(preflight.totalConfiguredCost)}</strong>
                        <span>
                          Schedule {creditCount(preflight.scheduleCost)}; matching webhooks{' '}
                          {preflight.matchingWebhookDeliveryCount === 0
                            ? 'none'
                            : `${preflight.matchingWebhookDeliveryCount} x ${creditCount(preflight.matchingWebhookDeliveryUnitCost)} = ${creditCount(preflight.matchingWebhookDeliveryCost)}`}.
                        </span>
                        <span>
                          Wallet balance: {creditCount(preflight.availableCredits)}.{' '}
                          {preflight.sufficientCredits
                            ? `${creditCount(preflight.availableCredits - preflight.totalConfiguredCost)} will remain.`
                            : `${creditCount(preflight.totalConfiguredCost - preflight.availableCredits)} more required.`}
                        </span>
                        <span>Requires an active paid subscription and credits purchased separately or granted by an administrator.</span>
                      </div>
                    ) : null}
                    {isRetryingPublish && !isPublished ? (
                      <p className="scheduler-publish-row__retry">Retry uses the original Idempotency-Key and settlement attempt.</p>
                    ) : null}
                    {publishSettlement && isPublished ? (
                      <p className="scheduler-publish-row__settlement" role="status">{publishSettlement}</p>
                    ) : null}
                    {!isPublished && canSolve ? (
                      <DemandWindowEditor
                        scheduleId={schedule.id}
                        timeZone={locationTimeZone(schedule.locationId)}
                        disabled={Boolean(solvingScheduleId) || isPublishing}
                        loadWindows={loadDemandWindows}
                        saveWindows={saveDemandWindows}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : capabilities.canWriteSchedules && locations.length > 0 ? (
          <section className="scheduler-publish-panel" aria-label="Create first schedule week">
            <header>
              <div>
                <h2>Build this week</h2>
                <p>No schedule exists for {dateLabel}.</p>
              </div>
              <Button onClick={() => void runFirstUseAutoSchedule()} disabled={Boolean(solvingScheduleId)}>
                <Plus size={14} /> Create schedule
              </Button>
            </header>
          </section>
        ) : null}

        <section className="scheduler-calendar-panel" aria-label="Schedule calendar board">
          <header>
            <div>
              <h2>Schedule board</h2>
              <p>
                {scheduleEvents.length} event{scheduleEvents.length === 1 ? '' : 's'} across {dateLabel}.{' '}
                {capabilities.canWriteShifts ? 'Drag shifts on the board to adjust coverage.' : 'Read-only access; schedule changes are hidden for this role.'}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setShowTimeline((value) => !value)}>
              {showTimeline ? 'Hide board' : 'Show board'}
            </Button>
          </header>
          {showTimeline ? (
            <div className={`scheduler-calendar-shell ${capabilities.canWriteShifts ? '' : 'scheduler-calendar-shell--readonly'}`}>
              {!capabilities.canWriteShifts ? (
                <div className="scheduler-readonly-note" role="status">
                  Read-only schedule view
                </div>
              ) : null}
              <StaffScheduler
                resources={visibleResources}
                events={scheduleEvents}
                viewMode={viewMode}
                initialDate={selectedDate}
                timeZone={activeTimeZone}
                onEventChange={capabilities.canWriteShifts && locationDataCurrent ? (id, start, end, resourceId) => void updateShift(id, start, end, resourceId) : undefined}
                onEventSelect={capabilities.canWriteShifts && locationDataCurrent ? editShiftFromBoard : undefined}
                onEventDelete={capabilities.canDeleteShifts && locationDataCurrent ? (event) => void deleteShift(event.id) : undefined}
                onSlotSelect={capabilities.canWriteShifts && locationDataCurrent ? prepareShiftFromBoardSlot : undefined}
                onTimeSelectionError={(message) => {
                  setError(message);
                  setScheduleStatus({ tone: 'warning', message: 'Choose a different time before saving the shift.' });
                }}
              />
            </div>
          ) : (
            <div className="timeline-summary">
              <CalendarDays size={18} />
              <strong>{dateLabel}</strong>
              <span>{visibleShifts.length} shift{visibleShifts.length === 1 ? '' : 's'} ready for review.</span>
            </div>
          )}
        </section>

        {showShiftForm && !openFocus && capabilities.canWriteShifts ? (
          <section className="scheduler-editor-panel" aria-label={editingShiftId ? 'Edit shift' : 'Create shift'}>
            <form className="shift-form" onSubmit={addShift}>
              <label>
                <span>Staff</span>
                <select value={shiftDraft.userId} onChange={(event) => handleDraftStaffChange(event.target.value)}>
                  <option value="">Select staff</option>
                  {schedulableStaff.map((person) => (
                    <option key={person.id} value={person.id}>{person.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Location</span>
                <select value={shiftDraft.locationId} onChange={(event) => selectScheduleLocation(event.target.value)}>
                  <option value="">Select location</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>{location.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Shift role</span>
                <select value={shiftDraft.role} onChange={(event) => setShiftDraft((current) => ({ ...current, role: toSchedulableShiftRole(event.target.value) }))}>
                  {SCHEDULABLE_SHIFT_ROLES.map((role) => (
                    <option key={role.value} value={role.value}>{role.label}</option>
                  ))}
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
              {shiftFormBlockReason ? <p id="shift-form-status" className="shift-form__hint">{shiftFormBlockReason}</p> : null}
              <div className="shift-form__actions">
                {editingShiftId && canDeleteEditingShift ? (
                  <Button
                    size="sm"
                    type="button"
                    variant="destructive"
                    onClick={() => {
                      if (confirmDeleteShiftId === editingShiftId) {
                        void deleteShift(editingShiftId);
                        return;
                      }
                      setConfirmDeleteShiftId(editingShiftId);
                    }}
                    onBlur={() => {
                      window.setTimeout(() => setConfirmDeleteShiftId((current) => (current === editingShiftId ? null : current)), 120);
                    }}
                  >
                    {confirmDeleteShiftId === editingShiftId ? 'Confirm delete' : 'Delete shift'}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  type="submit"
                  disabled={Boolean(shiftFormBlockReason)}
                  aria-describedby={shiftFormBlockReason ? 'shift-form-status' : undefined}
                >
                  {editingShiftId ? 'Save shift' : 'Create shift'}
                </Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => { setShowShiftForm(false); setEditingShiftId(null); setConfirmDeleteShiftId(null); }}>
                  Cancel
                </Button>
              </div>
            </form>
          </section>
        ) : null}

        </section>
      </div>

      <style jsx>{`
        .scheduler-page {
          min-height: 100%;
          display: grid;
          gap: 16px;
        }

        .scheduler-workspace {
          overflow: hidden;
          display: grid;
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
          padding: 16px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
          border-bottom: 1px solid var(--border);
        }

        .scheduler-topbar__left p {
          margin-top: 4px;
        }

        .scheduler-status-pill {
          margin-top: 8px;
          display: inline-flex;
          align-items: center;
          max-width: 100%;
          min-height: 28px;
          border-radius: var(--r-pill);
          border: 1px solid #d3ddeb;
          background: #f7f9ff;
          color: #3f5278;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 750;
          line-height: 1.25;
        }

        .scheduler-status-pill--loading,
        .scheduler-status-pill--saving {
          border-color: #bfdbfe;
          background: #eff6ff;
          color: #1d4ed8;
        }

        .scheduler-status-pill--saved,
        .scheduler-status-pill--ready {
          border-color: #bbf7d0;
          background: #f0fdf4;
          color: #166534;
        }

        .scheduler-status-pill--warning {
          border-color: #fed7aa;
          background: #fff7ed;
          color: #9a3412;
        }

        .scheduler-status-pill--error {
          border-color: #fecdd3;
          background: #fff1f2;
          color: #be123c;
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
          padding: 14px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
          border-bottom: 1px solid var(--border);
          background: var(--surface-soft);
        }

        .scheduler-advanced p {
          margin: 0;
          font-size: 14px;
          color: var(--text-muted);
        }

        .scheduler-advanced__actions {
          display: inline-flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .scheduler-publish-panel {
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
          background: #f8fafc;
          display: grid;
          gap: 12px;
        }

        .scheduler-publish-panel header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }

        .scheduler-publish-panel h2 {
          margin: 0;
          font-size: 18px;
          line-height: 1.25;
        }

        .scheduler-publish-panel p {
          margin: 4px 0 0;
          color: var(--text-muted);
          font-size: 13px;
        }

        .scheduler-publish-list {
          display: grid;
          gap: 8px;
        }

        .scheduler-publish-row {
          min-height: 58px;
          border: 1px solid var(--border);
          border-radius: var(--r-md);
          background: var(--surface);
          padding: 10px;
          display: grid;
          grid-template-columns: minmax(180px, 1fr) auto auto;
          align-items: center;
          gap: 10px;
        }

        .scheduler-publish-row--published {
          border-color: #bbf7d0;
          background: #f8fff9;
        }

        .scheduler-publish-row__main {
          min-width: 0;
          display: grid;
          gap: 2px;
        }

        .scheduler-publish-row__location {
          color: var(--text);
          font-weight: 800;
          font-size: 14px;
          overflow-wrap: anywhere;
        }

        .scheduler-publish-row__main span:last-child {
          color: var(--text-muted);
          font-size: 13px;
        }

        .scheduler-publish-row__meta {
          display: inline-flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          flex-wrap: wrap;
          color: var(--text-muted);
          font-size: 12px;
          font-weight: 750;
        }

        .scheduler-publish-row__actions {
          display: inline-flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          flex-wrap: wrap;
        }

        .scheduler-publish-row__blocker {
          grid-column: 1 / -1;
          margin: 0;
          color: #9a3412;
          font-size: 12px;
          font-weight: 750;
        }

        .scheduler-publish-row__cost {
          grid-column: 1 / -1;
          border: 1px solid #bfdbfe;
          border-radius: var(--r-sm);
          background: #eff6ff;
          padding: 9px 10px;
          display: grid;
          gap: 3px;
          color: #1e3a8a;
          font-size: 12px;
        }

        .scheduler-publish-row__cost strong {
          font-size: 13px;
        }

        .scheduler-publish-row__cost--blocked {
          border-color: #fed7aa;
          background: #fff7ed;
          color: #9a3412;
        }

        .scheduler-publish-row__retry,
        .scheduler-publish-row__settlement {
          grid-column: 1 / -1;
          margin: 0;
          font-size: 12px;
          font-weight: 750;
        }

        .scheduler-publish-row__retry {
          color: #9a3412;
        }

        .scheduler-publish-row__settlement {
          color: #166534;
        }

        .scheduler-publish-row__job {
          grid-column: 1 / -1;
          margin: 0;
          color: #475569;
          font-size: 12px;
          font-weight: 750;
        }

        .scheduler-publish-row__job--succeeded {
          color: #166534;
        }

        .scheduler-publish-row__job--failed,
        .scheduler-publish-row__job--dead_lettered {
          color: #be123c;
        }

        .scheduler-publish-row__job--retrying {
          color: #9a3412;
        }

        .scheduler-publish-badge {
          min-height: 24px;
          border: 1px solid #d3ddeb;
          border-radius: var(--r-pill);
          background: #f1f5f9;
          color: #475569;
          padding: 3px 8px;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          font-weight: 850;
          text-transform: uppercase;
        }

        .scheduler-publish-badge--published {
          border-color: #bbf7d0;
          background: #f0fdf4;
          color: #166534;
        }

        .scheduler-publish-badge--draft {
          border-color: #bfdbfe;
          background: #eff6ff;
          color: #1d4ed8;
        }

        .scheduler-publish-badge--archived {
          border-color: #e2e8f0;
          background: #f8fafc;
          color: #64748b;
        }

        .scheduler-calendar-panel {
          position: relative;
          z-index: 1;
          overflow: hidden;
          padding: 18px 20px 20px;
          border-bottom: 1px solid var(--border);
          background: #fbfdff;
        }

        .scheduler-calendar-panel header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }

        .scheduler-calendar-panel header h2 {
          margin: 0;
          font-size: 22px;
          line-height: 1.25;
        }

        .scheduler-calendar-panel header p {
          margin: 6px 0 0;
          color: var(--text-muted);
          font-size: 14px;
        }

        .scheduler-calendar-shell {
          margin-top: 14px;
          height: clamp(480px, 58vh, 650px);
          min-height: 480px;
          position: relative;
        }

        .scheduler-readonly-note {
          position: absolute;
          top: 8px;
          left: 8px;
          z-index: 8;
          border: 1px solid #d3ddeb;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.94);
          color: var(--text-muted);
          padding: 4px 9px;
          font-size: 12px;
          font-weight: 800;
        }

        :global(.scheduler-calendar-shell--readonly .shift-block),
        :global(.scheduler-calendar-shell--readonly .timeline-row) {
          cursor: default !important;
        }

        :global(.scheduler-calendar-shell--readonly .shift-block) {
          pointer-events: none;
        }

        :global(.scheduler-calendar-shell--readonly .scheduler-status span:first-child) {
          display: none;
        }

        .scheduler-editor-panel {
          position: relative;
          z-index: 2;
          padding: 0 20px 20px;
          border-bottom: 1px solid var(--border);
          background: #fbfdff;
        }

        .shift-form {
          margin-top: 0;
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

        .shift-form__hint {
          grid-column: 1 / -1;
          margin: 0;
          color: #9a3412;
          font-size: 12px;
          font-weight: 750;
        }

        .timeline-summary {
          margin-top: 16px;
          min-height: 58px;
          border: 1px solid var(--border);
          border-radius: var(--r-sm);
          background: var(--surface-soft);
          padding: 10px 12px;
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .timeline-summary svg {
          color: var(--brand-700);
        }

        .timeline-summary strong {
          font-size: 14px;
        }

        .timeline-summary span {
          color: var(--text-muted);
          font-size: 13px;
        }

        .scheduler-timeline-panel {
          padding: 18px 20px;
        }

        .scheduler-timeline-shell {
          margin-top: 16px;
          min-height: 520px;
        }

        @media (max-width: 1200px) {
          .shift-form {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }

        @media (max-width: 768px) {
          .scheduler-editor-panel,
          .scheduler-calendar-panel,
          .scheduler-timeline-panel,
          .scheduler-topbar {
            padding: 16px;
          }

          .scheduler-calendar-shell {
            height: 480px;
          }

          .scheduler-publish-panel {
            padding: 14px 16px;
          }

          .scheduler-publish-row {
            grid-template-columns: 1fr;
            align-items: stretch;
          }

          .scheduler-publish-row__meta {
            justify-content: flex-start;
          }

          .scheduler-publish-row__actions {
            justify-content: flex-start;
          }

          .scheduler-day-picker {
            width: 100%;
          }

          .scheduler-topbar__controls {
            width: 100%;
            justify-content: flex-start;
          }

          .shift-form {
            grid-template-columns: 1fr;
          }

          .shift-form__actions {
            justify-content: flex-start;
            flex-wrap: wrap;
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
