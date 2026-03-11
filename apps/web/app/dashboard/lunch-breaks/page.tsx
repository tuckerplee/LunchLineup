'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { fetchWithSession } from '@/lib/client-api';

type FeatureResolution = {
  enabled: boolean;
  source: 'plan' | 'stripe' | 'credits' | 'manual' | 'disabled';
  reason: string;
  creditCost: number | null;
};

type FeatureMatrixResponse = {
  usageCredits: number;
  features: {
    scheduling: FeatureResolution;
    lunch_breaks: FeatureResolution;
  };
};

type GeneratedBreak = {
  type: 'break1' | 'lunch' | 'break2';
  startTime: string;
  endTime: string;
  durationMinutes: number;
  paid: boolean;
};

type GeneratedShiftBreaks = {
  shiftId: string | null;
  userId: string | null;
  employeeName: string | null;
  startTime: string;
  endTime: string;
  breaks: GeneratedBreak[];
};

type GenerateResponse = {
  source: 'shared_schedule' | 'standalone';
  persisted: boolean;
  policy: LunchBreakPolicy;
  creditConsumption: { consumedCredits: number; newBalance: number | null };
  data: GeneratedShiftBreaks[];
};

type LunchBreakPolicy = {
  break1OffsetMinutes: number;
  lunchOffsetMinutes: number;
  break2OffsetMinutes: number;
  break1DurationMinutes: number;
  lunchDurationMinutes: number;
  break2DurationMinutes: number;
  timeStepMinutes: number;
};

type BreakEditorKey = 'break1' | 'lunch' | 'break2';

type EditableBreak = {
  time: string;
  durationMinutes: number;
  skipped: boolean;
};

type DayShiftRow = {
  shiftId: string;
  userId: string | null;
  employeeName: string;
  startTime: string;
  endTime: string;
  break1: EditableBreak;
  lunch: EditableBreak;
  break2: EditableBreak;
  dirty: boolean;
  saving: boolean;
};

type ManualShiftRow = {
  id: string;
  employeeName: string;
  startTime: string;
  endTime: string;
};

type SetupShiftRow = {
  id: string;
  shiftId: string | null;
  employeeId: string;
  employeeName: string;
  role: string;
  startTime: string;
  endTime: string;
};

type SetupDragState = {
  rowId: string;
  startX: number;
  trackWidth: number;
  originalStartMinutes: number;
  durationMinutes: number;
};

type PlanPreviewSegment = {
  id: string;
  label: string;
  tone: 'meal' | 'break';
  leftPct: number;
  widthPct: number;
};

type PlanPreviewRow = {
  id: string;
  employeeName: string;
  shiftLabel: string;
  segments: PlanPreviewSegment[];
};

type AutoCalendarSegment = {
  id: string;
  label: string;
  tone: 'meal' | 'break';
  leftPct: number;
  widthPct: number;
};

type AutoCalendarRow = {
  id: string;
  employeeName: string;
  shiftLabel: string;
  shiftLeftPct: number;
  shiftWidthPct: number;
  segments: AutoCalendarSegment[];
};

type LunchBreakDaySession = {
  mode: 'auto' | 'manual';
  autoSetupComplete: boolean;
  lastShiftId: string | null;
};

const LUNCH_BREAKS_SESSION_KEY = 'lunch-breaks/day-session/v1';

type EmployeeCard = {
  id: string;
  name: string;
  role?: string;
  source: 'scheduled' | 'available';
};

const BREAK_KEYS: BreakEditorKey[] = ['break1', 'lunch', 'break2'];

const BREAK_META: Record<BreakEditorKey, { label: string; minimumDuration: number }> = {
  break1: { label: 'Break 1', minimumDuration: 5 },
  lunch: { label: 'Meal', minimumDuration: 15 },
  break2: { label: 'Break 2', minimumDuration: 5 },
};

const POLICY_FIELDS = [
  { key: 'break1OffsetMinutes', label: 'Break 1 Offset (min)' },
  { key: 'lunchOffsetMinutes', label: 'Lunch Offset (min)' },
  { key: 'break2OffsetMinutes', label: 'Break 2 Offset (min)' },
  { key: 'break1DurationMinutes', label: 'Break 1 Duration (min)' },
  { key: 'lunchDurationMinutes', label: 'Lunch Duration (min)' },
  { key: 'break2DurationMinutes', label: 'Break 2 Duration (min)' },
  { key: 'timeStepMinutes', label: 'Conflict Step (min)' },
] as const;

const DEFAULT_POLICY: LunchBreakPolicy = {
  break1OffsetMinutes: 120,
  lunchOffsetMinutes: 240,
  break2OffsetMinutes: 120,
  break1DurationMinutes: 10,
  lunchDurationMinutes: 30,
  break2DurationMinutes: 10,
  timeStepMinutes: 5,
};

function toDateInputValue(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toUtcDateInputValue(date: Date): string {
  if (!Number.isFinite(date.getTime())) return toDateInputValue(new Date());
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDateInputValue(dateValue: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (!Number.isFinite(date.getTime())) return null;
  return date;
}

function shiftDate(dateValue: string, days: number): string {
  const date = parseDateInputValue(dateValue) ?? new Date();
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
}

function dayWindow(dateValue: string): { startIso: string; endIso: string } {
  const base = parseDateInputValue(dateValue) ?? new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 0, 0, 0, 0);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function toTimeInputValue(iso: string): string {
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function toDisplayTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function toDisplayShift(startIso: string, endIso: string): string {
  return `${toDisplayTime(startIso)} - ${toDisplayTime(endIso)}`;
}

function cloneRow(row: DayShiftRow): DayShiftRow {
  return {
    ...row,
    break1: { ...row.break1 },
    lunch: { ...row.lunch },
    break2: { ...row.break2 },
  };
}

function buildEditableBreak(
  generated: GeneratedShiftBreaks,
  type: BreakEditorKey,
  fallbackDuration: number,
): EditableBreak {
  const found = generated.breaks.find((entry) => entry.type === type);
  if (!found) {
    return {
      time: '',
      durationMinutes: fallbackDuration,
      skipped: true,
    };
  }
  return {
    time: toTimeInputValue(found.startTime),
    durationMinutes: found.durationMinutes > 0 ? found.durationMinutes : fallbackDuration,
    skipped: false,
  };
}

function toDayShiftRow(generated: GeneratedShiftBreaks, policy: LunchBreakPolicy): DayShiftRow | null {
  if (!generated.shiftId) return null;

  return {
    shiftId: generated.shiftId,
    userId: generated.userId,
    employeeName: generated.employeeName ?? 'Unassigned',
    startTime: generated.startTime,
    endTime: generated.endTime,
    break1: buildEditableBreak(generated, 'break1', policy.break1DurationMinutes),
    lunch: buildEditableBreak(generated, 'lunch', policy.lunchDurationMinutes),
    break2: buildEditableBreak(generated, 'break2', policy.break2DurationMinutes),
    dirty: false,
    saving: false,
  };
}

function resolveShiftIsoForTime(startIso: string, endIso: string, timeValue: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!match) return null;

  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const candidate = new Date(start);
  candidate.setHours(hours, minutes, 0, 0);

  if (candidate.getTime() < start.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }

  if (candidate.getTime() > end.getTime()) {
    const previousDay = new Date(candidate);
    previousDay.setDate(previousDay.getDate() - 1);
    if (previousDay.getTime() >= start.getTime() && previousDay.getTime() <= end.getTime()) {
      return previousDay.toISOString();
    }
    return null;
  }

  return candidate.toISOString();
}

function toIsoForDateAndTime(dateValue: string, timeValue: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!match) return null;
  const base = parseDateInputValue(dateValue);
  if (!base) return null;
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(match[1]), Number(match[2]), 0, 0);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function toShiftRangeIso(dateValue: string, startTime: string, endTime: string): { startIso: string; endIso: string } | null {
  const startIso = toIsoForDateAndTime(dateValue, startTime);
  const endIso = toIsoForDateAndTime(dateValue, endTime);
  if (!startIso || !endIso) return null;
  const startMs = new Date(startIso).getTime();
  let endMs = new Date(endIso).getTime();
  if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

function timeValueToMinutes(timeValue: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTimeValue(totalMinutes: number): string {
  const bounded = Math.max(0, Math.min(24 * 60 - 1, Math.round(totalMinutes)));
  const hh = String(Math.floor(bounded / 60)).padStart(2, '0');
  const mm = String(bounded % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function defaultManualShifts(): ManualShiftRow[] {
  return [
    { id: 'manual-1', employeeName: 'Alex', startTime: '09:00', endTime: '17:00' },
    { id: 'manual-2', employeeName: 'Blair', startTime: '10:00', endTime: '18:00' },
    { id: 'manual-3', employeeName: 'Casey', startTime: '11:00', endTime: '19:00' },
  ];
}

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getCsrfTokenFromCookie(): string {
  if (typeof document === 'undefined') return '';
  const pair = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith('csrf_token='));
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

function readLunchBreakSession(): Record<string, LunchBreakDaySession> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(LUNCH_BREAKS_SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, LunchBreakDaySession>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLunchBreakSession(next: Record<string, LunchBreakDaySession>): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LUNCH_BREAKS_SESSION_KEY, JSON.stringify(next));
}

function breakStatusLabel(current: EditableBreak): string {
  if (current.skipped) return 'Skipped';
  if (!current.time) return 'Missing time';
  return `${current.time} · ${current.durationMinutes}m`;
}

export default function LunchBreaksPage() {
  const [features, setFeatures] = useState<FeatureMatrixResponse | null>(null);
  const [policy, setPolicy] = useState<LunchBreakPolicy>(DEFAULT_POLICY);
  const [policyLoaded, setPolicyLoaded] = useState<LunchBreakPolicy>(DEFAULT_POLICY);
  const [serverToday, setServerToday] = useState<string>(toDateInputValue(new Date()));
  const [selectedDate, setSelectedDate] = useState<string>(toDateInputValue(new Date()));
  const [dayRows, setDayRows] = useState<DayShiftRow[]>([]);
  const [baselines, setBaselines] = useState<Record<string, DayShiftRow>>({});
  const [lastRun, setLastRun] = useState<GenerateResponse | null>(null);
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDayLoading, setIsDayLoading] = useState(false);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [isGeneratingDay, setIsGeneratingDay] = useState(false);
  const [isGeneratingManual, setIsGeneratingManual] = useState(false);
  const [manualShifts, setManualShifts] = useState<ManualShiftRow[]>(defaultManualShifts());
  const [plannerMode, setPlannerMode] = useState<'auto' | 'manual' | null>(null);
  const [autoGuideStep, setAutoGuideStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [availableEmployees, setAvailableEmployees] = useState<EmployeeCard[]>([]);
  const [selectedAutoEmployeeIds, setSelectedAutoEmployeeIds] = useState<string[]>([]);
  const [setupShiftRows, setSetupShiftRows] = useState<SetupShiftRow[]>([]);
  const [setupDrag, setSetupDrag] = useState<SetupDragState | null>(null);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialSelectedDateRef = useRef(selectedDate);
  const hasRestoredSessionRef = useRef<string | null>(null);

  const updateDaySession = useCallback((changes: Partial<LunchBreakDaySession>) => {
    const currentMap = readLunchBreakSession();
    const current = currentMap[selectedDate] ?? {
      mode: 'auto',
      autoSetupComplete: false,
      lastShiftId: null,
    };
    const next: LunchBreakDaySession = { ...current, ...changes };
    currentMap[selectedDate] = next;
    writeLunchBreakSession(currentMap);
  }, [selectedDate]);

  const loadFeatures = useCallback(async (): Promise<FeatureMatrixResponse> => {
    const res = await fetchWithSession('/billing/features');
    if (!res.ok) throw new Error('Unable to load feature status.');
    return (await res.json()) as FeatureMatrixResponse;
  }, []);

  const loadServerToday = useCallback(async (): Promise<string | null> => {
    const res = await fetchWithSession('/health');
    if (!res.ok) return null;
    const headerDate = res.headers.get('date');
    if (!headerDate) return null;
    const parsed = new Date(headerDate);
    if (!Number.isFinite(parsed.getTime())) return null;
    return toUtcDateInputValue(parsed);
  }, []);

  const loadPolicy = useCallback(async (): Promise<LunchBreakPolicy> => {
    const res = await fetchWithSession('/lunch-breaks/policy');
    if (!res.ok) throw new Error('Unable to load lunch/break policy.');
    const payload = (await res.json()) as Partial<LunchBreakPolicy>;
    return { ...DEFAULT_POLICY, ...payload };
  }, []);

  const loadDayRows = useCallback(async (dateValue: string, policyValue: LunchBreakPolicy): Promise<DayShiftRow[]> => {
    const { startIso, endIso } = dayWindow(dateValue);
    const query = new URLSearchParams({
      startDate: startIso,
      endDate: endIso,
    });

    setIsDayLoading(true);
    try {
      const res = await fetchWithSession(`/lunch-breaks?${query.toString()}`);
      if (!res.ok) {
        throw new Error('Unable to load lunch/break grid for selected day.');
      }

      const payload = (await res.json()) as { data: GeneratedShiftBreaks[] };
      const rows = (Array.isArray(payload.data) ? payload.data : [])
        .map((entry) => toDayShiftRow(entry, policyValue))
        .filter((entry): entry is DayShiftRow => entry !== null);

      const baselineMap: Record<string, DayShiftRow> = {};
      for (const row of rows) {
        baselineMap[row.shiftId] = cloneRow(row);
      }

      setDayRows(rows);
      setBaselines(baselineMap);
      return rows;
    } finally {
      setIsDayLoading(false);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [serverTodayValue, featureData, policyData] = await Promise.all([loadServerToday(), loadFeatures(), loadPolicy()]);
      if (serverTodayValue) {
        setServerToday(serverTodayValue);
        setSelectedDate(serverTodayValue);
        initialSelectedDateRef.current = serverTodayValue;
      }

      setFeatures(featureData);
      setPolicy(policyData);
      setPolicyLoaded(policyData);

      if (featureData.features.lunch_breaks.enabled) {
        await loadDayRows(initialSelectedDateRef.current, policyData);
      } else {
        setDayRows([]);
        setBaselines({});
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [loadFeatures, loadPolicy, loadDayRows, loadServerToday]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const lunchBreakFeature = features?.features.lunch_breaks;
  const schedulingFeature = features?.features.scheduling;
  const hasSchedulingEnabled = Boolean(schedulingFeature?.enabled);
  const hasSharedScheduleData = Boolean(hasSchedulingEnabled && dayRows.length > 0);

  useEffect(() => {
    if (!lunchBreakFeature?.enabled) return;
    if (isLoading) return;

    void loadDayRows(selectedDate, policyLoaded).catch((err) => {
      setError((err as Error).message);
    });
  }, [isLoading, loadDayRows, lunchBreakFeature?.enabled, policyLoaded, selectedDate]);

  useEffect(() => {
    if (isLoading) return;
    if (!lunchBreakFeature?.enabled) return;
    if (hasRestoredSessionRef.current === selectedDate) return;

    hasRestoredSessionRef.current = selectedDate;
    // Always start on mode picker when opening a day so users can choose auto/manual explicitly.
    setPlannerMode(null);
    setAutoGuideStep(1);
  }, [isLoading, lunchBreakFeature?.enabled, selectedDate]);

  const updateBreak = useCallback((shiftId: string, key: BreakEditorKey, next: Partial<EditableBreak>) => {
    setDayRows((prev) =>
      prev.map((row) =>
        row.shiftId === shiftId
          ? {
              ...row,
              [key]: { ...row[key], ...next },
              dirty: true,
            }
          : row,
      ),
    );
  }, []);

  const resetRow = useCallback((shiftId: string) => {
    const baseline = baselines[shiftId];
    if (!baseline) return;
    setDayRows((prev) => prev.map((row) => (row.shiftId === shiftId ? cloneRow(baseline) : row)));
  }, [baselines]);

  const handleSavePolicy = useCallback(async () => {
    setIsSavingPolicy(true);
    setError(null);
    try {
      const res = await fetchWithSession('/lunch-breaks/policy', {
        ...jsonWriteInit('PUT', policy),
      });
      if (!res.ok) throw new Error('Failed to save lunch/break policy.');
      const payload = (await res.json()) as Partial<LunchBreakPolicy>;
      const merged = { ...DEFAULT_POLICY, ...payload };
      setPolicy(merged);
      setPolicyLoaded(merged);
      await loadDayRows(selectedDate, merged);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSavingPolicy(false);
    }
  }, [loadDayRows, policy, selectedDate]);

  const saveRow = useCallback(
    async (shiftId: string): Promise<boolean> => {
      const row = dayRows.find((candidate) => candidate.shiftId === shiftId);
      if (!row) return false;

      setDayRows((prev) =>
        prev.map((candidate) => (candidate.shiftId === shiftId ? { ...candidate, saving: true } : candidate)),
      );

      try {
        const breaks = BREAK_KEYS.map((key) => {
          const current = row[key];
          if (current.skipped) {
            return { type: key, skip: true };
          }

          const resolvedStart = resolveShiftIsoForTime(row.startTime, row.endTime, current.time);
          if (!resolvedStart) {
            throw new Error(`${row.employeeName}: ${key} time is outside of the shift window.`);
          }

          return {
            type: key,
            startTime: resolvedStart,
            durationMinutes: Math.max(1, Math.round(current.durationMinutes || 0)),
            skip: false,
          };
        });

        const res = await fetchWithSession(`/lunch-breaks/shift/${shiftId}`, {
          ...jsonWriteInit('PUT', { breaks }),
        });
        if (!res.ok) throw new Error(`Failed to save row for ${row.employeeName}.`);

        const payload = (await res.json()) as GeneratedShiftBreaks;
        const mapped = toDayShiftRow(payload, policyLoaded);
        if (!mapped) throw new Error('Saved row did not include a shift id.');

        setDayRows((prev) =>
          prev.map((candidate) =>
            candidate.shiftId === shiftId ? { ...mapped, dirty: false, saving: false } : candidate,
          ),
        );
        setBaselines((prev) => ({
          ...prev,
          [shiftId]: { ...mapped, dirty: false, saving: false },
        }));
        return true;
      } catch (err) {
        setDayRows((prev) =>
          prev.map((candidate) => (candidate.shiftId === shiftId ? { ...candidate, saving: false } : candidate)),
        );
        setError((err as Error).message);
        return false;
      }
    },
    [dayRows, policyLoaded],
  );

  const saveAllDirtyRows = useCallback(async () => {
    const dirty = dayRows.filter((row) => row.dirty);
    if (dirty.length === 0) return;
    setError(null);

    for (const row of dirty) {
      const ok = await saveRow(row.shiftId);
      if (!ok) break;
    }
  }, [dayRows, saveRow]);

  const generateForSelectedDay = useCallback(async () => {
    if (dayRows.length === 0) {
      setError(
        hasSchedulingEnabled
          ? 'No schedule shifts found for selected day. Import shifts or use manual entry.'
          : 'No linked schedule source is available. Use manual entry for this day.',
      );
      return;
    }

    const selectedIds = new Set(selectedAutoEmployeeIds);
    const selectedRows = dayRows.filter((row) => selectedIds.has(row.userId ?? row.shiftId));

    if (selectedRows.length === 0) {
      setError('Select at least one scheduled employee in setup before generating a plan.');
      return;
    }

    setIsGeneratingDay(true);
    setError(null);
    try {
      const res = await fetchWithSession('/lunch-breaks/generate', {
        ...jsonWriteInit('POST', {
          shiftIds: selectedRows.map((row) => row.shiftId),
          persist: true,
          policy,
        }),
      });
      if (!res.ok) throw new Error('Failed to generate lunch/break assignments for this day.');

      const payload = (await res.json()) as GenerateResponse;
      setLastRun(payload);
      updateDaySession({ mode: 'auto', autoSetupComplete: true, lastShiftId: selectedShiftId ?? null });
      await loadDayRows(selectedDate, policyLoaded);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsGeneratingDay(false);
    }
  }, [dayRows, hasSchedulingEnabled, loadDayRows, policy, policyLoaded, selectedAutoEmployeeIds, selectedDate, selectedShiftId, updateDaySession]);

  const addManualShift = useCallback(() => {
    const nextIndex = manualShifts.length + 1;
    setManualShifts((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}-${nextIndex}`,
        employeeName: `Employee ${nextIndex}`,
        startTime: '09:00',
        endTime: '17:00',
      },
    ]);
  }, [manualShifts.length]);

  const updateManualShift = useCallback((id: string, changes: Partial<ManualShiftRow>) => {
    setManualShifts((prev) => prev.map((row) => (row.id === id ? { ...row, ...changes } : row)));
  }, []);

  const removeManualShift = useCallback((id: string) => {
    setManualShifts((prev) => prev.filter((row) => row.id !== id));
  }, []);

  const generateFromManualShifts = useCallback(async () => {
    setIsGeneratingManual(true);
    setError(null);
    try {
      const shifts = manualShifts.map((row) => {
        const start = toIsoForDateAndTime(selectedDate, row.startTime);
        const end = toIsoForDateAndTime(selectedDate, row.endTime);
        if (!start || !end) {
          throw new Error(`Invalid shift time for ${row.employeeName || 'employee'}.`);
        }
        const startMs = new Date(start).getTime();
        let endMs = new Date(end).getTime();
        if (endMs <= startMs) {
          endMs += 24 * 60 * 60 * 1000;
        }
        return {
          employeeName: row.employeeName.trim() || 'Unassigned',
          startTime: new Date(startMs).toISOString(),
          endTime: new Date(endMs).toISOString(),
        };
      });

      if (shifts.length === 0) {
        throw new Error('Add at least one employee shift to generate a lunch/break plan.');
      }

      const res = await fetchWithSession('/lunch-breaks/generate', {
        ...jsonWriteInit('POST', {
          shifts,
          persist: false,
          policy,
        }),
      });
      if (!res.ok) throw new Error('Failed to generate lunch/breaks from manual shifts.');
      const payload = (await res.json()) as GenerateResponse;
      setLastRun(payload);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsGeneratingManual(false);
    }
  }, [manualShifts, policy, selectedDate]);

  useEffect(() => {
    setSelectedShiftId((current) => {
      if (dayRows.length === 0) return null;
      if (current && dayRows.some((row) => row.shiftId === current)) return current;
      const remembered = readLunchBreakSession()[selectedDate]?.lastShiftId;
      if (remembered && dayRows.some((row) => row.shiftId === remembered)) return remembered;
      return dayRows[0].shiftId;
    });
  }, [dayRows, selectedDate]);

  const selectedDateLabel = useMemo(() => {
    const base = parseDateInputValue(selectedDate) ?? new Date();
    return base.toLocaleDateString([], {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }, [selectedDate]);

  const dirtyCount = dayRows.filter((row) => row.dirty).length;
  const hasSharedRows = dayRows.length > 0;
  const mealRiskCount = dayRows.filter((row) => row.lunch.skipped || !row.lunch.time).length;
  const breakRiskCount = dayRows.filter(
    (row) =>
      (!row.break1.skipped && !row.break1.time) ||
      (!row.break2.skipped && !row.break2.time),
  ).length;
  const mealsAssignedCount = dayRows.filter((row) => !row.lunch.skipped && Boolean(row.lunch.time)).length;
  const breaksAssignedCount = dayRows.reduce((count, row) => {
    const break1Assigned = !row.break1.skipped && Boolean(row.break1.time) ? 1 : 0;
    const break2Assigned = !row.break2.skipped && Boolean(row.break2.time) ? 1 : 0;
    return count + break1Assigned + break2Assigned;
  }, 0);
  const complianceRiskCount = dayRows.filter(
    (row) =>
      row.lunch.skipped ||
      !row.lunch.time ||
      (!row.break1.skipped && !row.break1.time) ||
      (!row.break2.skipped && !row.break2.time),
  ).length;

  const runPrimaryGeneration = useCallback(() => {
    if (plannerMode === 'auto') {
      void generateForSelectedDay();
      return;
    }
    if (plannerMode === 'manual') {
      void generateFromManualShifts();
      return;
    }
  }, [generateForSelectedDay, generateFromManualShifts, plannerMode]);

  const autoCalendarRows = useMemo<AutoCalendarRow[]>(() => {
    const base = parseDateInputValue(selectedDate) ?? new Date();
    const dayStartMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0).getTime();
    const windowStartMinutes = 9 * 60;
    const windowEndMinutes = 22 * 60;
    const windowMinutes = windowEndMinutes - windowStartMinutes;

    const toMinutesFromDayStart = (iso: string): number => {
      const ms = new Date(iso).getTime();
      return (ms - dayStartMs) / 60000;
    };

    return dayRows.map((row) => {
      const rawShiftStartMinutes = toMinutesFromDayStart(row.startTime);
      const rawShiftEndMinutes = toMinutesFromDayStart(row.endTime);
      const shiftStartMinutes = clamp(rawShiftStartMinutes, windowStartMinutes, windowEndMinutes - 15);
      const shiftEndMinutes = clamp(Math.max(rawShiftEndMinutes, shiftStartMinutes + 15), shiftStartMinutes + 15, windowEndMinutes);
      const shiftLeftPct = ((shiftStartMinutes - windowStartMinutes) / windowMinutes) * 100;
      const shiftWidthPct = ((shiftEndMinutes - shiftStartMinutes) / windowMinutes) * 100;

      const segments: AutoCalendarSegment[] = BREAK_KEYS.flatMap((key) => {
        const current = row[key];
        if (current.skipped || !current.time) return [];
        const startIso = resolveShiftIsoForTime(row.startTime, row.endTime, current.time);
        if (!startIso) return [];
        const startMinutes = toMinutesFromDayStart(startIso);
        const endMinutes = startMinutes + Math.max(1, current.durationMinutes || 0);
        const clampedStart = clamp(startMinutes, windowStartMinutes, windowEndMinutes - 1);
        const clampedEnd = clamp(Math.max(endMinutes, clampedStart + 1), clampedStart + 1, windowEndMinutes);
        return [{
          id: `${row.shiftId}-${key}`,
          label: key === 'lunch' ? 'Lunch' : 'Break',
          tone: key === 'lunch' ? 'meal' : 'break',
          leftPct: ((clampedStart - windowStartMinutes) / windowMinutes) * 100,
          widthPct: ((clampedEnd - clampedStart) / windowMinutes) * 100,
        }];
      });

      return {
        id: row.shiftId,
        employeeName: row.employeeName,
        shiftLabel: toDisplayShift(row.startTime, row.endTime),
        shiftLeftPct: clamp(shiftLeftPct, 0, 96),
        shiftWidthPct: clamp(shiftWidthPct, 4, 100),
        segments: segments.map((segment) => ({
          ...segment,
          leftPct: clamp(segment.leftPct, 0, 96),
          widthPct: clamp(segment.widthPct, 2.5, 100),
        })),
      };
    });
  }, [dayRows, selectedDate]);

  const selectedRow = useMemo(() => {
    if (!selectedShiftId) return null;
    return dayRows.find((row) => row.shiftId === selectedShiftId) ?? null;
  }, [dayRows, selectedShiftId]);

  useEffect(() => {
    if (!(plannerMode === 'auto' && autoGuideStep >= 5)) return;
    if (!selectedRow || !selectedRow.dirty || selectedRow.saving) return;

    const timeout = window.setTimeout(() => {
      void saveRow(selectedRow.shiftId);
    }, 650);

    return () => window.clearTimeout(timeout);
  }, [autoGuideStep, plannerMode, saveRow, selectedRow]);

  useEffect(() => {
    if (!plannerMode) return;
    updateDaySession({ mode: plannerMode });
  }, [plannerMode, updateDaySession]);

  useEffect(() => {
    if (!(plannerMode === 'auto' && autoGuideStep >= 5)) return;
    updateDaySession({ lastShiftId: selectedShiftId ?? null });
  }, [autoGuideStep, plannerMode, selectedShiftId, updateDaySession]);

  useEffect(() => {
    if (!(plannerMode === 'auto' && autoGuideStep >= 5)) return;
    if (!lunchBreakFeature?.enabled) return;
    if (isDayLoading || isGeneratingDay) return;
    if (dayRows.some((row) => row.dirty || row.saving)) return;

    const interval = window.setInterval(() => {
      void loadDayRows(selectedDate, policyLoaded).catch(() => {
        // keep polling silent; explicit errors are surfaced on direct user actions
      });
    }, 8000);

    return () => window.clearInterval(interval);
  }, [
    autoGuideStep,
    dayRows,
    isDayLoading,
    isGeneratingDay,
    loadDayRows,
    lunchBreakFeature?.enabled,
    plannerMode,
    policyLoaded,
    selectedDate,
  ]);

  const standalonePreview = useMemo(
    () => (lastRun?.source === 'standalone' ? lastRun.data : []),
    [lastRun],
  );

  const previewRows = useMemo<PlanPreviewRow[]>(() => {
    if (plannerMode === 'auto') {
      return dayRows.map((row) => {
        const shiftStartMs = new Date(row.startTime).getTime();
        const shiftEndMs = new Date(row.endTime).getTime();
        const shiftDurationMs = Math.max(1, shiftEndMs - shiftStartMs);

        const segments: PlanPreviewSegment[] = BREAK_KEYS.flatMap((key) => {
          const current = row[key];
          if (current.skipped || !current.time) return [];
          const startIso = resolveShiftIsoForTime(row.startTime, row.endTime, current.time);
          if (!startIso) return [];
          const startMs = new Date(startIso).getTime();
          const endMs = startMs + Math.max(1, current.durationMinutes) * 60 * 1000;
          const leftPct = ((startMs - shiftStartMs) / shiftDurationMs) * 100;
          const widthPct = ((endMs - startMs) / shiftDurationMs) * 100;

          return [{
            id: `${row.shiftId}-${key}`,
            label: BREAK_META[key].label,
            tone: key === 'lunch' ? 'meal' : 'break',
            leftPct: clamp(leftPct, 0, 96),
            widthPct: clamp(widthPct, 4, 100),
          }];
        });

        return {
          id: row.shiftId,
          employeeName: row.employeeName,
          shiftLabel: toDisplayShift(row.startTime, row.endTime),
          segments,
        };
      });
    }

    return standalonePreview.map((row, index) => {
      const shiftStartMs = new Date(row.startTime).getTime();
      const shiftEndMs = new Date(row.endTime).getTime();
      const shiftDurationMs = Math.max(1, shiftEndMs - shiftStartMs);

      const segments: PlanPreviewSegment[] = row.breaks.map((item, breakIndex) => {
        const startMs = new Date(item.startTime).getTime();
        const endMs = new Date(item.endTime).getTime();
        const leftPct = ((startMs - shiftStartMs) / shiftDurationMs) * 100;
        const widthPct = ((endMs - startMs) / shiftDurationMs) * 100;

        return {
          id: `${index}-${breakIndex}-${item.type}`,
          label: item.type === 'lunch' ? 'Meal' : 'Break',
          tone: item.type === 'lunch' ? 'meal' : 'break',
          leftPct: clamp(leftPct, 0, 96),
          widthPct: clamp(widthPct, 4, 100),
        };
      });

      return {
        id: row.shiftId ?? `preview-${index}`,
        employeeName: row.employeeName ?? 'Unassigned',
        shiftLabel: toDisplayShift(row.startTime, row.endTime),
        segments,
      };
    });
  }, [dayRows, plannerMode, standalonePreview]);

  const isAutoMode = plannerMode === 'auto';
  const isManualMode = plannerMode === 'manual';
  const isGeneratingPrimary = isAutoMode ? isGeneratingDay : isManualMode ? isGeneratingManual : false;
  const statusShiftsCount = isAutoMode ? dayRows.length : standalonePreview.length;
  const statusMealsAssigned = isAutoMode
    ? mealsAssignedCount
    : standalonePreview.reduce((count, row) => count + row.breaks.filter((entry) => entry.type === 'lunch').length, 0);
  const statusBreaksAssigned = isAutoMode
    ? breaksAssignedCount
    : standalonePreview.reduce(
      (count, row) => count + row.breaks.filter((entry) => entry.type === 'break1' || entry.type === 'break2').length,
      0,
    );
  const statusComplianceRisk = isAutoMode
    ? complianceRiskCount
    : standalonePreview.reduce(
      (count, row) => (row.breaks.some((entry) => entry.type === 'lunch') ? count : count + 1),
      0,
    );

  const scheduledEmployees = useMemo<EmployeeCard[]>(() => {
    const seen = new Set<string>();
    const cards: EmployeeCard[] = [];
    for (const row of dayRows) {
      const key = row.userId ?? row.employeeName.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cards.push({
        id: row.userId ?? row.shiftId,
        name: row.employeeName || 'Unassigned',
        role: row.userId ? 'Scheduled' : 'Open shift',
        source: 'scheduled',
      });
    }
    return cards;
  }, [dayRows]);

  const step3EmployeePool = useMemo(
    () => (scheduledEmployees.length > 0 ? scheduledEmployees : availableEmployees),
    [availableEmployees, scheduledEmployees],
  );

  useEffect(() => {
    if (!(isAutoMode && autoGuideStep === 3)) return;
    if (step3EmployeePool.length === 0) return;

    setSelectedAutoEmployeeIds((prev) => {
      if (prev.length > 0) {
        const filtered = prev.filter((id) => step3EmployeePool.some((employee) => employee.id === id));
        if (filtered.length > 0) return filtered;
      }
      return step3EmployeePool.map((employee) => employee.id);
    });
  }, [autoGuideStep, isAutoMode, step3EmployeePool]);

  const selectedAutoEmployees = useMemo(
    () => step3EmployeePool.filter((employee) => selectedAutoEmployeeIds.includes(employee.id)),
    [selectedAutoEmployeeIds, step3EmployeePool],
  );

  useEffect(() => {
    if (!(isAutoMode && autoGuideStep === 4)) return;

    setSetupShiftRows((prev) => {
      if (prev.length > 0) {
        const validIds = new Set(selectedAutoEmployees.map((employee) => employee.id));
        const filtered = prev.filter((row) => validIds.has(row.employeeId));
        if (filtered.length > 0) return filtered;
      }

      const selectedIds = new Set(selectedAutoEmployeeIds);
      const selectedRows = dayRows.filter((row) => selectedIds.has(row.userId ?? row.shiftId));
      if (selectedRows.length > 0) {
        return selectedRows.map((row) => ({
          id: row.shiftId,
          shiftId: row.shiftId,
          employeeId: row.userId ?? row.shiftId,
          employeeName: row.employeeName,
          role: selectedAutoEmployees.find((employee) => employee.id === (row.userId ?? row.shiftId))?.role ?? 'Scheduled',
          startTime: toTimeInputValue(row.startTime),
          endTime: toTimeInputValue(row.endTime),
        }));
      }

      return selectedAutoEmployees.map((employee, index) => ({
        id: `setup-${employee.id}-${index + 1}`,
        shiftId: null,
        employeeId: employee.id,
        employeeName: employee.name,
        role: employee.role ?? 'Staff',
        startTime: '09:00',
        endTime: '17:00',
      }));
    });
  }, [autoGuideStep, dayRows, isAutoMode, selectedAutoEmployeeIds, selectedAutoEmployees]);

  const applySetupShifts = useCallback(() => {
    const persistedUserIds = new Set<string>([
      ...availableEmployees.map((employee) => employee.id),
      ...dayRows.map((row) => row.userId).filter((value): value is string => Boolean(value)),
    ]);

    const setupRowsByShiftId = new Map(
      setupShiftRows
        .filter((row) => Boolean(row.shiftId))
        .map((row) => [row.shiftId as string, row]),
    );

    if (setupRowsByShiftId.size > 0) {
      void Promise.all(
        Array.from(setupRowsByShiftId.values()).map(async (setupRow) => {
          const range = toShiftRangeIso(selectedDate, setupRow.startTime, setupRow.endTime);
          if (!range || !setupRow.shiftId) return;

          const body: Record<string, string> = {
            startTime: range.startIso,
            endTime: range.endIso,
          };
          if (persistedUserIds.has(setupRow.employeeId)) {
            body.userId = setupRow.employeeId;
          }

          const res = await fetchWithSession(`/shifts/${setupRow.shiftId}`, {
            ...jsonWriteInit('PUT', body),
          });
          if (!res.ok) {
            throw new Error(`Failed to persist shift update for ${setupRow.employeeName}.`);
          }
        }),
      )
        .then(async () => {
          await loadDayRows(selectedDate, policyLoaded);
        })
        .catch((err) => {
          setError((err as Error).message);
        });
    }

    const manualRows = setupShiftRows.filter((row) => !row.shiftId);
    if (dayRows.length === 0 && manualRows.length > 0) {
      setManualShifts(
        manualRows.map((row, index) => ({
          id: `manual-from-setup-${index + 1}`,
          employeeName: row.employeeName,
          startTime: row.startTime,
          endTime: row.endTime,
        })),
      );
      setPlannerMode('manual');
      updateDaySession({ mode: 'manual', autoSetupComplete: true });
      return;
    }

    updateDaySession({ mode: 'auto', autoSetupComplete: true, lastShiftId: selectedShiftId ?? null });
    setAutoGuideStep(5);
  }, [
    availableEmployees,
    dayRows,
    loadDayRows,
    policyLoaded,
    selectedDate,
    selectedShiftId,
    setupShiftRows,
    updateDaySession,
  ]);

  const setupTimelineStart = 9 * 60;
  const setupTimelineEnd = 22 * 60;
  const setupTimelineWindow = setupTimelineEnd - setupTimelineStart;

  const startSetupDrag = useCallback((event: { clientX: number; currentTarget: EventTarget & HTMLSpanElement }, row: SetupShiftRow) => {
    const trackEl = (event.currentTarget.parentElement as HTMLElement | null);
    if (!trackEl) return;
    const trackBounds = trackEl.getBoundingClientRect();
    const startMinutes = timeValueToMinutes(row.startTime);
    const endMinutes = timeValueToMinutes(row.endTime);
    const durationMinutes = Math.max(30, endMinutes - startMinutes);
    setSetupDrag({
      rowId: row.id,
      startX: event.clientX,
      trackWidth: Math.max(1, trackBounds.width),
      originalStartMinutes: startMinutes,
      durationMinutes,
    });
  }, []);

  const onSetupDragMove = useCallback((event: { clientX: number }) => {
    if (!setupDrag) return;
    const deltaPx = event.clientX - setupDrag.startX;
    const deltaMinutesRaw = (deltaPx / setupDrag.trackWidth) * setupTimelineWindow;
    const deltaMinutes = Math.round(deltaMinutesRaw / 15) * 15;
    const earliestStart = setupTimelineStart;
    const latestStart = setupTimelineEnd - setupDrag.durationMinutes;
    const nextStartMinutes = clamp(setupDrag.originalStartMinutes + deltaMinutes, earliestStart, latestStart);
    const nextEndMinutes = nextStartMinutes + setupDrag.durationMinutes;

    setSetupShiftRows((prev) =>
      prev.map((row) =>
        row.id === setupDrag.rowId
          ? {
              ...row,
              startTime: minutesToTimeValue(nextStartMinutes),
              endTime: minutesToTimeValue(nextEndMinutes),
            }
          : row,
      ),
    );
  }, [setupDrag, setupTimelineWindow]);

  const endSetupDrag = useCallback(() => {
    if (!setupDrag) return;
    setSetupDrag(null);
  }, [setupDrag]);

  useEffect(() => {
    if (!(isAutoMode && autoGuideStep === 3)) return;
    if (scheduledEmployees.length > 0) return;
    if (availableEmployees.length > 0) return;

    let isActive = true;
    setIsLoadingEmployees(true);
    void fetchWithSession('/shifts/staff-roster')
      .then(async (res) => {
        if (!res.ok) return;
        const payload = (await res.json()) as { data?: Array<{ id: string; name: string; role?: string }> };
        if (!isActive) return;
        const list = Array.isArray(payload.data)
          ? payload.data
              .filter((user) => user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN')
              .map((user) => ({
                id: user.id,
                name: user.name || 'Unnamed',
                role: user.role,
                source: 'available' as const,
              }))
          : [];
        setAvailableEmployees(list);
      })
      .finally(() => {
        if (isActive) setIsLoadingEmployees(false);
      });

    return () => {
      isActive = false;
    };
  }, [autoGuideStep, availableEmployees.length, isAutoMode, scheduledEmployees.length]);

  const weeklyPickerDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => shiftDate(serverToday, index - 1)),
    [serverToday],
  );

  const choosePlannerMode = useCallback((mode: 'auto' | 'manual') => {
    setPlannerMode(mode);
    setAutoGuideStep(mode === 'auto' ? 2 : 5);
  }, []);

  const showGuidedWindow =
    !isLoading && Boolean(lunchBreakFeature?.enabled) && (plannerMode === null || (isAutoMode && autoGuideStep < 5));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: '100%' }}>
      {!showGuidedWindow ? (
        <section
          className="surface-card"
          style={{ padding: '1rem' }}
        >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: '0.8rem',
            alignItems: 'start',
          }}
        >
          <div>
            <div className="workspace-kicker">Lunch & breaks workspace</div>
            <h1 className="workspace-title" style={{ fontSize: '1.58rem', marginBottom: 2 }}>
              Lunch & Break Planner
            </h1>
            <p className="workspace-subtitle">Generate compliant lunches and staggered breaks for the selected day.</p>
            <div style={{ marginTop: 4, fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 700 }}>
              {selectedDateLabel} break plan
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Button variant="outline" size="sm" onClick={() => setSelectedDate(shiftDate(selectedDate, -1))}>Prev Day</Button>
              <input
                type="date"
                value={selectedDate}
                onChange={(event) => setSelectedDate(event.target.value)}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: '#ffffff',
                  color: 'var(--text-primary)',
                  padding: '0.38rem 0.55rem',
                  fontSize: '0.8rem',
                }}
              />
              <Button variant="outline" size="sm" onClick={() => setSelectedDate(toDateInputValue(new Date()))}>Today</Button>
              <Button variant="outline" size="sm" onClick={() => setSelectedDate(shiftDate(selectedDate, 1))}>Next Day</Button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPlannerMode(null);
                  setAutoGuideStep(1);
                }}
                disabled={!lunchBreakFeature?.enabled}
              >
                Switch mode
              </Button>
              <Button
                size="sm"
                variant="default"
                onClick={runPrimaryGeneration}
                disabled={
                  isGeneratingPrimary ||
                  isLoading ||
                  !lunchBreakFeature?.enabled ||
                  plannerMode === null
                }
                style={{ minWidth: 250 }}
              >
                {isGeneratingPrimary ? 'Generating plan...' : 'Generate Lunch & Break Plan'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void saveAllDirtyRows()} disabled={dirtyCount === 0}>
                {dirtyCount > 0 ? `Save ${dirtyCount} changes` : 'Save changes'}
              </Button>
            </div>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
              Uses current shifts and policy to generate staggered lunches and breaks.
            </div>
          </div>
        </div>

        <div style={{ marginTop: '0.85rem', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            Shifts loaded: <strong style={{ color: 'var(--text-primary)' }}>{statusShiftsCount}</strong>
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: statusMealsAssigned > 0 ? '#166534' : '#b45309' }}>
            Meals assigned: <strong>{statusMealsAssigned}</strong>
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: statusBreaksAssigned > 0 ? '#166534' : '#b45309' }}>
            Breaks assigned: <strong>{statusBreaksAssigned}</strong>
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: statusComplianceRisk > 0 ? '#b45309' : '#166534' }}>
            Compliance risks: <strong>{statusComplianceRisk}</strong>
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {isDayLoading ? 'Refreshing shifts...' : `${dayRows.length} shifts in view`}
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: mealRiskCount > 0 ? '#b45309' : '#166534' }}>
            {mealRiskCount > 0 ? `${mealRiskCount} meal windows missing` : 'Meals covered'}
          </div>
          <div className="surface-muted" style={{ padding: '0.38rem 0.58rem', fontSize: '0.78rem', color: breakRiskCount > 0 ? '#b45309' : '#166534' }}>
            {breakRiskCount > 0 ? `${breakRiskCount} break timings unresolved` : 'Break timings healthy'}
          </div>
        </div>

        {lastRun ? (
          <div
            style={{
              marginTop: '0.75rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '0.4rem 0.62rem',
              borderRadius: 10,
              border: '1px solid #cfe0ff',
              background: '#edf3ff',
              color: '#234ed9',
              fontSize: '0.78rem',
              fontWeight: 700,
            }}
          >
            Last run: {lastRun.source} · persisted {lastRun.persisted ? 'yes' : 'no'} · credits {lastRun.creditConsumption.consumedCredits}
          </div>
        ) : null}

        {previewRows.length > 0 ? (
          <div className="surface-muted" style={{ marginTop: '0.75rem', padding: '0.65rem', display: 'grid', gap: 6 }}>
            <div style={{ fontWeight: 800, color: 'var(--text-primary)', fontSize: '0.8rem' }}>Plan preview</div>
            {previewRows.slice(0, 4).map((row) => (
              <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr) auto', gap: 8, alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.76rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.employeeName}
                  </div>
                </div>
                <div style={{ position: 'relative', height: 18, borderRadius: 999, background: '#eaf0fb', border: '1px solid #d6e0f3' }}>
                  {row.segments.map((segment) => (
                    <span
                      key={segment.id}
                      title={segment.label}
                      style={{
                        position: 'absolute',
                        left: `${segment.leftPct}%`,
                        width: `${segment.widthPct}%`,
                        top: 2,
                        bottom: 2,
                        borderRadius: 999,
                        background: segment.tone === 'meal' ? '#9fd6a8' : '#9ac9f4',
                        border: segment.tone === 'meal' ? '1px solid #74b782' : '1px solid #6aa8de',
                      }}
                    />
                  ))}
                </div>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', fontWeight: 700 }}>{row.shiftLabel}</div>
              </div>
            ))}
          </div>
        ) : null}
        </section>
      ) : null}

      {showGuidedWindow ? (
        <section
          className="surface-card"
          style={{
            minHeight: 'calc(100vh - 250px)',
            display: 'grid',
            placeItems: 'center',
            padding: '1.25rem',
          }}
        >
          <div style={{ width: 'min(880px, 100%)', display: 'grid', gap: 14 }}>
            <AnimatePresence mode="wait">
              {plannerMode === null ? (
                <motion.div
                  key="guide-step-1"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  style={{ display: 'grid', gap: 14 }}
                >
                  <div style={{ textAlign: 'center', display: 'grid', gap: 6 }}>
                    <div className="workspace-kicker">Lunch & breaks</div>
                    <h2 className="workspace-title" style={{ margin: 0, fontSize: '1.45rem' }}>
                      Choose how to start today&apos;s plan
                    </h2>
                    <p className="workspace-subtitle" style={{ margin: 0 }}>
                      Select one workflow to continue.
                    </p>
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                      gap: 12,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => choosePlannerMode('auto')}
                      style={{
                        textAlign: 'left',
                        border: '1px solid #cfe0ff',
                        borderRadius: 14,
                        background: 'linear-gradient(180deg, #f7faff 0%, #edf4ff 100%)',
                        padding: '1rem',
                        display: 'grid',
                        gap: 8,
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Auto Break</div>
                      <div style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                        {hasSchedulingEnabled
                          ? `Use schedule data when available and auto-build lunch and break assignments for ${selectedDateLabel}.`
                          : `Auto-build lunch and break assignments for ${selectedDateLabel}, with manual shift input when needed.`}
                      </div>
                      <span style={{ color: '#234ed9', fontSize: '0.78rem', fontWeight: 800 }}>
                        {hasSchedulingEnabled ? 'Use schedule data when available' : 'Works without scheduling'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => choosePlannerMode('manual')}
                      style={{
                        textAlign: 'left',
                        border: '1px solid var(--border)',
                        borderRadius: 14,
                        background: '#ffffff',
                        padding: '1rem',
                        display: 'grid',
                        gap: 8,
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Manual Entry</div>
                      <div style={{ fontSize: '0.83rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                        Enter today&apos;s shifts directly on this page, then generate a lunch and break plan from manual data.
                      </div>
                      <span style={{ color: '#234ed9', fontSize: '0.78rem', fontWeight: 800 }}>Build from manual shifts</span>
                    </button>
                  </div>
                </motion.div>
              ) : null}

              {isAutoMode && autoGuideStep === 2 ? (
                <motion.div
                  key="guide-step-2"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  style={{
                    width: 'min(640px, 100%)',
                    marginInline: 'auto',
                    border: '1px solid #cfe0ff',
                    borderRadius: 14,
                    background: 'linear-gradient(180deg, #f7faff 0%, #eef4ff 100%)',
                    padding: '1rem',
                    display: 'grid',
                    gap: 12,
                  }}
                >
                  <div className="workspace-kicker">Auto break setup</div>
                  <h2 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }}>
                    Choose the day you&apos;re planning.
                  </h2>
                  <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                    Select one day from this week to continue.
                  </p>
                  <div className="surface-muted" style={{ borderRadius: 12, padding: '0.75rem', display: 'grid', gap: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
                      {weeklyPickerDays.map((dateValue) => {
                        const [y, m, d] = dateValue.split('-').map((part) => Number(part));
                        const date = new Date(y, m - 1, d);
                        const weekday = date.toLocaleDateString([], { weekday: 'short' });
                        const dayOfMonth = date.getDate();
                        const isActive = dateValue === selectedDate;
                        return (
                          <button
                            key={`weekly-pick-${dateValue}`}
                            type="button"
                            onClick={() => setSelectedDate(dateValue)}
                            style={{
                              border: isActive ? '1px solid #83a8ff' : '1px solid var(--border)',
                              background: isActive ? '#edf3ff' : '#ffffff',
                              color: isActive ? '#234ed9' : 'var(--text-primary)',
                              borderRadius: 10,
                              padding: '0.5rem 0.35rem',
                              fontSize: '0.8rem',
                              display: 'grid',
                              gap: 2,
                              placeItems: 'center',
                              cursor: 'pointer',
                              fontWeight: isActive ? 800 : 600,
                            }}
                          >
                            <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{weekday}</span>
                            <span>{dayOfMonth}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ textAlign: 'center', display: 'grid', gap: 3 }}>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, color: 'var(--text-primary)' }}>{selectedDateLabel}</div>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Downtown Bistro</div>
                      <div style={{ fontSize: '0.75rem', color: dayRows.length > 0 ? '#166534' : '#b45309' }}>
                        {dayRows.length > 0
                          ? `${dayRows.length} shifts available for this day`
                          : hasSchedulingEnabled
                            ? 'No schedule shifts found for this day yet'
                            : 'No schedule source connected for this workspace'}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <Button variant="outline" size="sm" onClick={() => { setPlannerMode(null); setAutoGuideStep(1); }}>
                      Back
                    </Button>
                    <Button size="sm" onClick={() => setAutoGuideStep(3)}>
                      Continue
                    </Button>
                  </div>
                </motion.div>
              ) : null}

              {isAutoMode && autoGuideStep === 3 ? (
                <motion.div
                  key="guide-step-3"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  style={{
                    width: 'min(640px, 100%)',
                    marginInline: 'auto',
                    border: '1px solid #cfe0ff',
                    borderRadius: 14,
                    background: 'linear-gradient(180deg, #f7faff 0%, #eef4ff 100%)',
                    padding: '1rem',
                    display: 'grid',
                    gap: 12,
                  }}
                >
                  <div className="workspace-kicker">Auto break setup</div>
                  <h2 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }}>
                    Ready to create today&apos;s schedule
                  </h2>
                  <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                    {hasSchedulingEnabled
                      ? `We'll use schedule data when available for ${selectedDateLabel} and guide break placement in the planner.`
                      : `You'll continue with manual shift input for ${selectedDateLabel} and still get guided break planning.`}
                  </p>
                  <div className="surface-muted" style={{ borderRadius: 12, padding: '0.75rem', display: 'grid', gap: 8 }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {scheduledEmployees.length > 0 ? 'Scheduled employees for this day' : 'Available staff members at this store'}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      Select who should be included in this lunch and break plan.
                    </div>
                    {isLoadingEmployees ? (
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Loading employees...</div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 6 }}>
                        {step3EmployeePool.slice(0, 24).map((employee) => {
                          const isSelected = selectedAutoEmployeeIds.includes(employee.id);
                          return (
                            <div
                              key={`step3-emp-${employee.id}`}
                              role="button"
                              tabIndex={0}
                              aria-pressed={isSelected}
                              onClick={() => {
                                setSelectedAutoEmployeeIds((prev) =>
                                  prev.includes(employee.id) ? prev.filter((id) => id !== employee.id) : [...prev, employee.id],
                                );
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  setSelectedAutoEmployeeIds((prev) =>
                                    prev.includes(employee.id) ? prev.filter((id) => id !== employee.id) : [...prev, employee.id],
                                  );
                                }
                              }}
                              style={{
                                border: isSelected ? '1px solid #5b87f7' : '1px solid var(--border)',
                                borderRadius: 10,
                                background: isSelected ? '#edf3ff' : '#ffffff',
                                padding: '0.4rem',
                                display: 'grid',
                                gap: 3,
                                justifyItems: 'center',
                                textAlign: 'center',
                                cursor: 'pointer',
                                boxShadow: isSelected ? '0 0 0 1px rgba(91,135,247,0.24)' : 'none',
                              }}
                            >
                              <div
                                style={{
                                  width: 26,
                                  height: 26,
                                  borderRadius: 999,
                                  display: 'grid',
                                  placeItems: 'center',
                                  border: '1px solid #c9d6ef',
                                  background: '#eef4ff',
                                  color: '#244aa8',
                                  fontSize: '0.66rem',
                                  fontWeight: 800,
                                }}
                              >
                                {getInitials(employee.name)}
                              </div>
                              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                                {employee.name}
                              </div>
                              <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                                {employee.role ?? (employee.source === 'scheduled' ? 'Scheduled' : 'Available')}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {!isLoadingEmployees ? (
                      <div style={{ fontSize: '0.74rem', color: selectedAutoEmployeeIds.length > 0 ? '#166534' : '#b45309' }}>
                        {selectedAutoEmployeeIds.length > 0
                          ? `${selectedAutoEmployeeIds.length} selected`
                          : 'Select at least one person to continue.'}
                      </div>
                    ) : null}
                    {!isLoadingEmployees && scheduledEmployees.length === 0 && availableEmployees.length === 0 ? (
                      <div style={{ fontSize: '0.78rem', color: '#b45309' }}>
                        No staff members found yet. You can still continue and add shifts manually.
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <Button variant="outline" size="sm" onClick={() => setAutoGuideStep(2)}>
                      Back
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setAutoGuideStep(4)}
                      disabled={step3EmployeePool.length > 0 && selectedAutoEmployeeIds.length === 0}
                    >
                      Next
                    </Button>
                  </div>
                </motion.div>
              ) : null}

              {isAutoMode && autoGuideStep === 4 ? (
                <motion.div
                  key="guide-step-4"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  style={{
                    width: 'min(980px, 100%)',
                    marginInline: 'auto',
                    border: '1px solid #cfe0ff',
                    borderRadius: 14,
                    background: 'linear-gradient(180deg, #f7faff 0%, #eef4ff 100%)',
                    padding: '1rem',
                    display: 'grid',
                    gap: 12,
                  }}
                >
                  <div className="workspace-kicker">Auto break setup</div>
                  <h2 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }}>
                    Adjust who works when
                  </h2>
                  <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--text-secondary)' }}>
                    Fine-tune shifts before planning breaks. Drag blocks to move times, or edit names and times manually.
                  </p>

                  <div
                    className="surface-muted"
                    onMouseMove={onSetupDragMove}
                    onMouseUp={endSetupDrag}
                    onMouseLeave={endSetupDrag}
                    style={{ borderRadius: 12, padding: '0.75rem', display: 'grid', gap: 8 }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-primary)' }}>Shift preview</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Drag blocks to adjust start/end windows</div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', fontSize: '0.66rem', color: 'var(--text-muted)', fontWeight: 700 }}>
                      <span>9:00</span>
                      <span style={{ textAlign: 'center' }}>13:00</span>
                      <span style={{ textAlign: 'center' }}>17:00</span>
                      <span style={{ textAlign: 'right' }}>22:00</span>
                    </div>

                    {setupShiftRows.length > 0 ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {setupShiftRows.map((row) => {
                          const rawStart = timeValueToMinutes(row.startTime);
                          const rawEnd = timeValueToMinutes(row.endTime);
                          const clampedStart = clamp(rawStart, setupTimelineStart, setupTimelineEnd - 30);
                          const clampedEnd = clamp(Math.max(rawEnd, clampedStart + 30), clampedStart + 30, setupTimelineEnd);
                          const duration = clampedEnd - clampedStart;
                          const leftPct = ((clampedStart - setupTimelineStart) / setupTimelineWindow) * 100;
                          const widthPct = (duration / setupTimelineWindow) * 100;
                          return (
                            <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: 8, alignItems: 'center' }}>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {row.employeeName}
                                </div>
                                <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{row.role}</div>
                              </div>
                              <div style={{ position: 'relative', height: 32, borderRadius: 10, border: '1px solid #d6e0f3', background: '#ffffff' }}>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  aria-label={`Shift for ${row.employeeName}`}
                                  onMouseDown={(event) => startSetupDrag(event, row)}
                                  onKeyDown={(event) => {
                                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                                    event.preventDefault();
                                    const delta = event.key === 'ArrowRight' ? 15 : -15;
                                    const nextStart = clamp(clampedStart + delta, setupTimelineStart, setupTimelineEnd - duration);
                                    const nextEnd = nextStart + duration;
                                    setSetupShiftRows((prev) =>
                                      prev.map((candidate) =>
                                        candidate.id === row.id
                                          ? { ...candidate, startTime: minutesToTimeValue(nextStart), endTime: minutesToTimeValue(nextEnd) }
                                          : candidate,
                                      ),
                                    );
                                  }}
                                  style={{
                                    position: 'absolute',
                                    left: `${leftPct}%`,
                                    width: `${Math.max(widthPct, 8)}%`,
                                    top: 4,
                                    bottom: 4,
                                    borderRadius: 8,
                                    background: '#dce9ff',
                                    border: '1px solid #8fb0ef',
                                    color: '#23458c',
                                    display: 'grid',
                                    placeItems: 'center',
                                    cursor: 'grab',
                                    fontSize: '0.66rem',
                                    fontWeight: 700,
                                    userSelect: 'none',
                                  }}
                                >
                                  {minutesToTimeValue(clampedStart)}-{minutesToTimeValue(clampedEnd)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.78rem', color: '#b45309' }}>
                        Select at least one person in the previous step to configure shifts.
                      </div>
                    )}
                  </div>

                  <div className="surface-muted" style={{ borderRadius: 12, padding: '0.75rem', display: 'grid', gap: 8 }}>
                    <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-primary)' }}>Manual edit</div>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {setupShiftRows.map((row) => (
                        <div key={`manual-${row.id}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1fr) 130px 130px', gap: 8, alignItems: 'center' }}>
                          <div style={{ fontSize: '0.76rem', fontWeight: 700, color: 'var(--text-primary)' }}>{row.employeeName}</div>
                          <input
                            type="time"
                            value={row.startTime}
                            onChange={(event) =>
                              setSetupShiftRows((prev) =>
                                prev.map((candidate) => {
                                  if (candidate.id !== row.id) return candidate;
                                  const nextStart = event.target.value;
                                  const nextStartMin = timeValueToMinutes(nextStart);
                                  const currentEndMin = timeValueToMinutes(candidate.endTime);
                                  const nextEnd = currentEndMin <= nextStartMin ? minutesToTimeValue(nextStartMin + 30) : candidate.endTime;
                                  return { ...candidate, startTime: nextStart, endTime: nextEnd };
                                }),
                              )
                            }
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: '#ffffff',
                              color: 'var(--text-primary)',
                              padding: '0.36rem 0.45rem',
                              fontSize: '0.78rem',
                            }}
                          />
                          <input
                            type="time"
                            value={row.endTime}
                            onChange={(event) =>
                              setSetupShiftRows((prev) =>
                                prev.map((candidate) => {
                                  if (candidate.id !== row.id) return candidate;
                                  const nextEnd = event.target.value;
                                  const startMin = timeValueToMinutes(candidate.startTime);
                                  const endMin = timeValueToMinutes(nextEnd);
                                  return {
                                    ...candidate,
                                    endTime: endMin <= startMin ? minutesToTimeValue(startMin + 30) : nextEnd,
                                  };
                                }),
                              )
                            }
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: '#ffffff',
                              color: 'var(--text-primary)',
                              padding: '0.36rem 0.45rem',
                              fontSize: '0.78rem',
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <Button variant="outline" size="sm" onClick={() => setAutoGuideStep(3)}>
                      Back
                    </Button>
                    <Button size="sm" onClick={applySetupShifts} disabled={setupShiftRows.length === 0}>
                      Continue to planner
                    </Button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </section>
      ) : null}

      {isLoading ? (
        <section className="surface-card" style={{ padding: '1rem', color: 'var(--text-muted)' }}>
          Loading lunch & break workspace...
        </section>
      ) : null}

      {!isLoading && lunchBreakFeature && !lunchBreakFeature.enabled ? (
        <section
          className="surface-card"
          style={{
            padding: '1rem',
            borderColor: 'rgba(244,63,94,0.35)',
            background: 'rgba(244,63,94,0.08)',
          }}
        >
          <div style={{ fontWeight: 800, color: '#fb7185' }}>Lunch & Breaks is locked</div>
          <div style={{ marginTop: 4, fontSize: '0.86rem', color: 'var(--text-secondary)' }}>{lunchBreakFeature.reason}</div>
        </section>
      ) : null}

      {!isLoading && lunchBreakFeature?.enabled && !showGuidedWindow ? (
        <section
          style={{
            minHeight: 620,
            height: 'calc(100vh - 250px)',
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 340px',
            gap: '0.75rem',
          }}
        >
          <div className="surface-card" style={{ padding: '0.72rem', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {isAutoMode ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    flexWrap: 'wrap',
                    padding: '0 0.35rem',
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>
                    {hasSchedulingEnabled
                      ? `Using schedule data as source of truth for ${selectedDateLabel}`
                      : `Running in manual-first mode for ${selectedDateLabel}`}
                  </span>
                  <span style={{ fontWeight: 700 }}>
                    {selectedAutoEmployees.length > 0
                      ? `${selectedAutoEmployees.length} selected for plan`
                      : dirtyCount > 0
                        ? `${dirtyCount} unsaved edits`
                        : 'All edits saved'}
                  </span>
                </div>
                <div style={{ minHeight: 0, flex: 1 }}>
                  {hasSharedRows ? (
                    <div className="surface-muted" style={{ padding: '0.7rem', display: 'grid', gap: 8, minHeight: '100%' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                        <div style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                          Calendar schedule for {selectedDateLabel}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                          Shift + lunch/break placement
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', fontSize: '0.66rem', color: 'var(--text-muted)', fontWeight: 700 }}>
                        <span>9:00</span>
                        <span style={{ textAlign: 'center' }}>13:00</span>
                        <span style={{ textAlign: 'center' }}>17:00</span>
                        <span style={{ textAlign: 'right' }}>22:00</span>
                      </div>

                      <div style={{ display: 'grid', gap: 8, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}>
                        {autoCalendarRows.map((row) => (
                          <button
                            key={`planner-calendar-${row.id}`}
                            type="button"
                            onClick={() => setSelectedShiftId(row.id)}
                            style={{
                              border: selectedShiftId === row.id ? '1px solid #83a8ff' : '1px solid #d6e0f3',
                              borderRadius: 10,
                              background: selectedShiftId === row.id ? '#edf3ff' : '#ffffff',
                              padding: '0.55rem',
                              display: 'grid',
                              gridTemplateColumns: '180px minmax(0, 1fr)',
                              gap: 8,
                              alignItems: 'center',
                              textAlign: 'left',
                              cursor: 'pointer',
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: '0.76rem', fontWeight: 800, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {row.employeeName}
                              </div>
                              <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{row.shiftLabel}</div>
                            </div>

                            <div style={{ position: 'relative', height: 30, borderRadius: 999, border: '1px solid #d6e0f3', background: '#f6f9ff' }}>
                              <span
                                style={{
                                  position: 'absolute',
                                  left: `${row.shiftLeftPct}%`,
                                  width: `${row.shiftWidthPct}%`,
                                  top: 3,
                                  bottom: 3,
                                  borderRadius: 999,
                                  background: '#d9e8ff',
                                  border: '1px solid #9ebdf0',
                                }}
                              />
                              {row.segments.map((segment) => (
                                <span
                                  key={segment.id}
                                  title={segment.label}
                                  style={{
                                    position: 'absolute',
                                    left: `${segment.leftPct}%`,
                                    width: `${segment.widthPct}%`,
                                    top: 7,
                                    bottom: 7,
                                    borderRadius: 999,
                                    background: segment.tone === 'meal' ? '#b7e3be' : '#b8d8f7',
                                    border: segment.tone === 'meal' ? '1px solid #74b782' : '1px solid #6aa8de',
                                  }}
                                />
                              ))}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="surface-muted" style={{ padding: '0.75rem' }}>
                      <div style={{ fontWeight: 800, color: 'var(--text-primary)', marginBottom: 2 }}>
                        No shifts loaded for {selectedDateLabel.split(',')[0]}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {hasSchedulingEnabled
                          ? 'Import shifts from Scheduling, or switch to manual entry.'
                          : 'Switch to manual entry to add shifts and generate lunches and breaks.'}
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {hasSchedulingEnabled ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              void loadDayRows(selectedDate, policyLoaded).catch((err) => {
                                setError((err as Error).message);
                              });
                            }}
                          >
                            Import schedule shifts
                          </Button>
                        ) : null}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setPlannerMode('manual');
                            setAutoGuideStep(5);
                          }}
                        >
                          Use manual entry
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ display: 'grid', gap: '0.72rem', minHeight: 0, overflowY: 'auto', padding: '0.1rem' }}>
                <div className="surface-muted" style={{ padding: '0.75rem' }}>
                  <div style={{ fontWeight: 800, color: 'var(--text-primary)', marginBottom: 2 }}>No shifts loaded for {selectedDateLabel.split(',')[0]}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {hasSchedulingEnabled
                      ? 'Import shifts from Scheduling or add a quick scenario to generate a break plan.'
                      : 'Add a quick scenario to generate a break plan.'}
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {hasSchedulingEnabled ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void loadDayRows(selectedDate, policyLoaded).catch((err) => {
                            setError((err as Error).message);
                          });
                        }}
                      >
                        Import schedule shifts
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={addManualShift}>
                      Add manual shifts
                    </Button>
                  </div>
                </div>

                <div style={{ display: 'grid', gap: 8 }}>
                  {manualShifts.map((row) => (
                    <div key={row.id} className="surface-muted" style={{ padding: '0.68rem', display: 'grid', gap: 8 }}>
                      <input
                        type="text"
                        value={row.employeeName}
                        onChange={(event) => updateManualShift(row.id, { employeeName: event.target.value })}
                        style={{
                          width: '100%',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          background: '#ffffff',
                          color: 'var(--text-primary)',
                          padding: '0.36rem 0.45rem',
                          fontSize: '0.82rem',
                        }}
                      />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Start</span>
                          <input
                            type="time"
                            value={row.startTime}
                            onChange={(event) => updateManualShift(row.id, { startTime: event.target.value })}
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: '#ffffff',
                              color: 'var(--text-primary)',
                              padding: '0.34rem 0.4rem',
                              fontSize: '0.78rem',
                            }}
                          />
                        </label>
                        <label style={{ display: 'grid', gap: 4 }}>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>End</span>
                          <input
                            type="time"
                            value={row.endTime}
                            onChange={(event) => updateManualShift(row.id, { endTime: event.target.value })}
                            style={{
                              border: '1px solid var(--border)',
                              borderRadius: 8,
                              background: '#ffffff',
                              color: 'var(--text-primary)',
                              padding: '0.34rem 0.4rem',
                              fontSize: '0.78rem',
                            }}
                          />
                        </label>
                        <Button variant="outline" size="sm" onClick={() => removeManualShift(row.id)} disabled={manualShifts.length <= 1}>
                          Remove shift
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button size="sm" onClick={() => void generateFromManualShifts()} disabled={isGeneratingManual}>
                    {isGeneratingManual ? 'Generating...' : 'Generate Lunch & Break Plan'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={addManualShift}>
                    Add shift
                  </Button>
                </div>

                {standalonePreview.length > 0 ? (
                  <div className="surface-muted" style={{ padding: '0.75rem', display: 'grid', gap: 6 }}>
                    <div style={{ fontWeight: 800, fontSize: '0.84rem', color: 'var(--text-primary)' }}>Standalone preview</div>
                    {standalonePreview.map((row, idx) => (
                      <div key={`preview-${row.employeeName ?? 'shift'}-${idx}`} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>{row.employeeName ?? 'Unassigned'}</strong>
                        {' · '}
                        {toDisplayShift(row.startTime, row.endTime)}
                        {' · '}
                        {row.breaks.length} planned break(s)
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <aside className="surface-card" style={{ padding: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.72rem', overflowY: 'auto' }}>
            <h3 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 800 }}>Assignment inspector</h3>

            {isAutoMode && hasSharedRows ? (
              selectedRow ? (
                <>
                  <div className="surface-muted" style={{ padding: '0.72rem', display: 'grid', gap: 4 }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {selectedRow.employeeName}
                    </div>
                    <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {toDisplayShift(selectedRow.startTime, selectedRow.endTime)}
                    </div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                      {selectedRow.userId ? 'Linked from scheduling shift' : 'Open shift assignment'}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gap: 8 }}>
                    {BREAK_KEYS.map((key) => {
                      const current = selectedRow[key];
                      const info = BREAK_META[key];
                      return (
                        <div key={`${selectedRow.shiftId}-${key}`} className="surface-muted" style={{ padding: '0.62rem', display: 'grid', gap: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <strong style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>{info.label}</strong>
                            <span style={{ fontSize: '0.72rem', color: current.skipped || !current.time ? '#b45309' : '#166534' }}>
                              {breakStatusLabel(current)}
                            </span>
                          </div>
                          <label style={{ fontSize: '0.74rem', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <input
                              type="checkbox"
                              checked={current.skipped}
                              disabled={selectedRow.saving}
                              onChange={(event) => updateBreak(selectedRow.shiftId, key, { skipped: event.target.checked })}
                            />
                            Skip {info.label.toLowerCase()}
                          </label>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 6 }}>
                            <input
                              type="time"
                              value={current.time}
                              disabled={current.skipped || selectedRow.saving}
                              onChange={(event) => updateBreak(selectedRow.shiftId, key, { time: event.target.value })}
                              style={{
                                border: '1px solid var(--border)',
                                borderRadius: 8,
                                background: '#ffffff',
                                color: 'var(--text-primary)',
                                padding: '0.34rem 0.42rem',
                                fontSize: '0.78rem',
                              }}
                            />
                            <input
                              type="number"
                              min={info.minimumDuration}
                              value={current.durationMinutes}
                              disabled={current.skipped || selectedRow.saving}
                              onChange={(event) =>
                                updateBreak(selectedRow.shiftId, key, {
                                  durationMinutes: Number(event.target.value),
                                })
                              }
                              style={{
                                border: '1px solid var(--border)',
                                borderRadius: 8,
                                background: '#ffffff',
                                color: 'var(--text-primary)',
                                padding: '0.34rem 0.42rem',
                                fontSize: '0.78rem',
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button size="sm" onClick={() => void saveRow(selectedRow.shiftId)} disabled={!selectedRow.dirty || selectedRow.saving}>
                      {selectedRow.saving ? 'Saving...' : 'Save shift'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => resetRow(selectedRow.shiftId)} disabled={!selectedRow.dirty || selectedRow.saving}>
                      Reset
                    </Button>
                  </div>
                </>
              ) : (
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Select a shift in the timeline to edit meal and break placement.
                </p>
              )
            ) : (
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {hasSchedulingEnabled
                  ? 'Generate from manual shifts to preview assignments, or load schedule shifts to unlock direct editing.'
                  : 'Generate from manual shifts to preview assignments. Schedule integration is optional and currently not enabled.'}
              </p>
            )}

            <details style={{ borderTop: '1px solid var(--border)', paddingTop: '0.72rem' }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.84rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                Planning settings
              </summary>
              <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {POLICY_FIELDS.map((field) => (
                    <label key={field.key} style={{ display: 'grid', gap: 4 }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{field.label}</span>
                      <input
                        type="number"
                        value={policy[field.key]}
                        min={1}
                        onChange={(event) =>
                          setPolicy((prev) => ({
                            ...prev,
                            [field.key]: Number(event.target.value),
                          }))
                        }
                        style={{
                          background: '#ffffff',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          color: 'var(--text-primary)',
                          padding: '0.36rem 0.48rem',
                          fontSize: '0.78rem',
                        }}
                      />
                    </label>
                  ))}
                </div>
                <Button variant="secondary" size="sm" onClick={handleSavePolicy} disabled={isSavingPolicy}>
                  {isSavingPolicy ? 'Saving...' : 'Save policy'}
                </Button>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  <div>Access source: <strong style={{ textTransform: 'capitalize' }}>{lunchBreakFeature.source}</strong></div>
                  <div>Usage credits: <strong>{features?.usageCredits ?? 0}</strong></div>
                  <div>Credit cost/run: <strong>{lunchBreakFeature.creditCost ?? 0}</strong></div>
                  <div>
                    Scheduling link:{' '}
                    <strong>
                      {hasSchedulingEnabled
                        ? hasSharedScheduleData
                          ? `${dayRows.length} linked shifts`
                          : 'No linked shifts'
                        : 'Scheduling not enabled'}
                    </strong>
                  </div>
                </div>
              </div>
            </details>
          </aside>
        </section>
      ) : null}

      {error ? (
        <div
          style={{
            padding: '0.8rem 0.9rem',
            borderRadius: 10,
            border: '1px solid rgba(244,63,94,0.35)',
            color: '#fda4af',
            background: 'rgba(244,63,94,0.06)',
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
