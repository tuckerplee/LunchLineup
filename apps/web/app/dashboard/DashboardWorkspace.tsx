'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchWithSession } from '@/lib/client-api';
import { getWorkspaceCapabilities } from '@/lib/permissions';
import { fetchAllBoundedPages, type BoundedPage } from '@/lib/bounded-pagination';

type DashboardProfile = {
    name?: string | null;
    tenantName?: string | null;
    permissions?: string[];
};

type ApiUserDirectoryResponse = {
    summary?: {
        staffCount?: number;
        managerCount?: number;
    };
};
type ApiLocationSummary = {
    count?: number;
};

type ApiSchedule = {
    id: string;
    status: 'DRAFT' | 'PUBLISHED';
    startDate: string;
    endDate: string;
};

type ApiShift = {
    id: string;
    userId?: string | null;
    startTime?: string;
};

type ApiFeatureMatrix = {
    usageCredits: number;
    features: {
        scheduling?: { enabled: boolean };
        lunch_breaks?: { enabled: boolean };
    };
};

type ApiLunchBreak = {
    breaks?: Array<{
        type?: 'break1' | 'lunch' | 'break2';
    }>;
};

type ApiNotification = {
    id: string;
    type: string;
    title: string;
    body: string;
    createdAt: string;
};

type CoverageDay = {
    day: string;
    status: string;
    tone: 'healthy' | 'risk' | 'attention';
};

type ActivityItem = {
    category: string;
    title: string;
    detail: string;
    time: string;
    tone: string;
};

type OverviewSnapshot = {
    profile: DashboardProfile | null;
    staffCount: number | null;
    managerCount: number | null;
    locationCount: number | null;
    scheduleCount: number | null;
    publishedScheduleCount: number | null;
    totalShiftCount: number | null;
    openShiftCount: number | null;
    coveragePercent: number | null;
    breakCompliancePercent: number | null;
    lunchBreaksEnabled: boolean | null;
    latestScheduleLabel: string | null;
    lunchPlanCount: number | null;
    coverageDays: CoverageDay[] | null;
    activityItems: ActivityItem[] | null;
};

type FetchResult<T> =
    | { ok: true; data: T }
    | { ok: false };

type ManagerTask = {
    label: string;
    detail: string;
    href: string;
    priority: 'urgent' | 'routine';
};

function formatCount(count: number, singular: string, plural?: string): string {
    return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}

function formatScheduleLabel(schedule: ApiSchedule | null): string {
    if (!schedule) return 'No schedules yet';
    const start = new Date(schedule.startDate);
    const end = new Date(schedule.endDate);
    const formatter = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
    });
    return `${schedule.status.toLowerCase()} · ${formatter.format(start)} - ${formatter.format(end)}`;
}

async function fetchJsonResult<T>(path: string): Promise<FetchResult<T>> {
    try {
        const response = await fetchWithSession(path);
        if (!response.ok) return { ok: false };
        return { ok: true, data: await response.json() as T };
    } catch {
        return { ok: false };
    }
}

function dashboardWindowPath(path: '/schedules' | '/shifts' | '/lunch-breaks', startOffsetDays: number, endOffsetDays: number): string {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = new Date(start);
    start.setDate(start.getDate() + startOffsetDays);
    end.setDate(end.getDate() + endOffsetDays);
    const params = new URLSearchParams({
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        limit: '200',
    });
    return `${path}?${params.toString()}`;
}

async function fetchBoundedJsonResult<T>(path: string): Promise<FetchResult<{ data: T[] }>> {
    try {
        const data = await fetchAllBoundedPages(path, async (nextPath) => {
            const page = await fetchJsonResult<BoundedPage<T>>(nextPath);
            if (!page.ok) throw new Error('Bounded list request failed.');
            return page.data;
        });
        return { ok: true, data: { data } };
    } catch {
        return { ok: false };
    }
}

function categoryForNotification(type: string): string {
    if (type.includes('SCHEDULE')) return 'Schedule';
    if (type.includes('SHIFT')) return 'Staffing';
    if (type.includes('WARNING')) return 'Warning';
    if (type.includes('ERROR')) return 'Alert';
    if (type.includes('SUCCESS')) return 'Update';
    return 'Activity';
}

function toneForNotification(type: string): string {
    if (type.includes('ERROR')) return 'var(--rose)';
    if (type.includes('WARNING')) return 'var(--amber)';
    if (type.includes('SUCCESS')) return 'var(--emerald)';
    if (type.includes('SHIFT')) return 'var(--cyan)';
    return 'var(--brand)';
}

function relativeTimeLabel(value: string): string {
    const date = new Date(value);
    const deltaMs = Date.now() - date.getTime();
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'Now';
    const deltaMinutes = Math.floor(deltaMs / 60000);
    if (deltaMinutes < 1) return 'Now';
    if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
    const deltaHours = Math.floor(deltaMinutes / 60);
    if (deltaHours < 24) return `${deltaHours}h ago`;
    const deltaDays = Math.floor(deltaHours / 24);
    return `${deltaDays}d ago`;
}

function buildCoverageDays(shifts: ApiShift[]): CoverageDay[] {
    const dayFormatter = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    return Array.from({ length: 7 }).map((_, index) => {
        const dayDate = new Date(startOfToday);
        dayDate.setDate(startOfToday.getDate() + index);
        const nextDay = new Date(dayDate);
        nextDay.setDate(dayDate.getDate() + 1);

        const dayShifts = shifts.filter((shift) => {
            if (!shift.startTime) return false;
            const start = new Date(shift.startTime);
            return start >= dayDate && start < nextDay;
        });

        const openCount = dayShifts.filter((shift) => !shift.userId).length;
        if (dayShifts.length === 0) {
            return { day: dayFormatter.format(dayDate), status: 'No scheduled shifts', tone: 'attention' };
        }
        if (openCount === 0) {
            return { day: dayFormatter.format(dayDate), status: 'Fully covered', tone: 'healthy' };
        }
        if (openCount === 1) {
            return { day: dayFormatter.format(dayDate), status: '1 open shift', tone: 'risk' };
        }
        return { day: dayFormatter.format(dayDate), status: `${openCount} open shifts`, tone: 'attention' };
    });
}

export function DashboardWorkspace() {
    const [todayLabel, setTodayLabel] = useState('Today');
    const [overview, setOverview] = useState<OverviewSnapshot | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const loadGenerationRef = useRef(0);

    useEffect(() => {
        setTodayLabel(
            new Date().toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
            }),
        );
    }, []);

    const loadOverview = useCallback(async () => {
        const loadGeneration = loadGenerationRef.current + 1;
        loadGenerationRef.current = loadGeneration;
        setIsLoading(true);
        setError(null);

        const schedulePath = dashboardWindowPath('/schedules', -7, 90);
        const shiftPath = dashboardWindowPath('/shifts', 0, 7);
        const lunchBreakPath = dashboardWindowPath('/lunch-breaks', 0, 7);
        const [profile, userDirectory, locationSummary, schedules, shifts, features, lunchBreaks, notifications] = await Promise.all([
            fetchJsonResult<{ user?: DashboardProfile }>('/auth/me'),
            fetchJsonResult<ApiUserDirectoryResponse>('/users?limit=1'),
            fetchJsonResult<ApiLocationSummary>('/locations/summary'),
            fetchBoundedJsonResult<ApiSchedule>(schedulePath),
            fetchBoundedJsonResult<ApiShift>(shiftPath),
            fetchJsonResult<ApiFeatureMatrix>('/billing/features'),
            fetchBoundedJsonResult<ApiLunchBreak>(lunchBreakPath),
            fetchJsonResult<{ data?: ApiNotification[] }>('/notifications?status=all&limit=5'),
        ]);

        const profileData = profile.ok && profile.data.user ? profile.data.user : null;
        const loadedCapabilities = getWorkspaceCapabilities(profileData?.permissions ?? []);
        const userSummary = userDirectory.ok ? userDirectory.data.summary : undefined;
        const validStaffSummary = Number.isSafeInteger(userSummary?.staffCount)
            && Number.isSafeInteger(userSummary?.managerCount);
        const staffCount = loadedCapabilities.canReadUsers && validStaffSummary
            ? Number(userSummary?.staffCount)
            : null;
        const managerCount = loadedCapabilities.canReadUsers && validStaffSummary
            ? Number(userSummary?.managerCount)
            : null;
        const locationCount = loadedCapabilities.canReadLocations
            && locationSummary.ok
            && Number.isSafeInteger(locationSummary.data.count)
            ? Number(locationSummary.data.count)
            : null;
        const scheduleRows = loadedCapabilities.canReadScheduling && schedules.ok ? schedules.data.data : null;
        const shiftRows = loadedCapabilities.canReadScheduling && shifts.ok ? shifts.data.data : null;
        const lunchBreakRows = loadedCapabilities.canReadLunchBreaks && lunchBreaks.ok ? lunchBreaks.data.data : null;
        const notificationRows = notifications.ok && Array.isArray(notifications.data.data)
            ? notifications.data.data
            : null;

        const totalShiftCount = shiftRows?.length ?? null;
        const openShiftCount = shiftRows
            ? shiftRows.filter((shift) => !shift.userId).length
            : null;
        const coveragePercent = totalShiftCount === null || openShiftCount === null
            ? null
            : totalShiftCount > 0
                ? Math.round(((totalShiftCount - openShiftCount) / totalShiftCount) * 100)
                : 0;
        const lunchPlanCount = lunchBreakRows
            ? lunchBreakRows.filter((row) => (
                Array.isArray(row.breaks) && row.breaks.some((entry) => entry.type === 'lunch')
            )).length
            : null;
        const breakCompliancePercent = totalShiftCount === null || lunchPlanCount === null
            ? null
            : totalShiftCount > 0
                ? Math.round((lunchPlanCount / totalShiftCount) * 100)
                : 0;
        const latestSchedule = scheduleRows
            ? scheduleRows
                .slice()
                .sort((left, right) => new Date(right.startDate).getTime() - new Date(left.startDate).getTime())[0] ?? null
            : null;
        const activityItems = notificationRows?.map((entry) => ({
            category: categoryForNotification(entry.type),
            title: entry.title || 'Update',
            detail: entry.body || 'Recent activity',
            time: relativeTimeLabel(entry.createdAt),
            tone: toneForNotification(entry.type),
        })) ?? null;

        const nextOverview: OverviewSnapshot = {
            profile: profileData,
            staffCount,
            managerCount,
            locationCount,
            scheduleCount: scheduleRows?.length ?? null,
            publishedScheduleCount: scheduleRows
                ? scheduleRows.filter((schedule) => schedule.status === 'PUBLISHED').length
                : null,
            totalShiftCount,
            openShiftCount,
            coveragePercent,
            breakCompliancePercent,
            lunchBreaksEnabled: features.ok ? Boolean(features.data.features?.lunch_breaks?.enabled) : null,
            latestScheduleLabel: scheduleRows ? formatScheduleLabel(latestSchedule) : null,
            lunchPlanCount,
            coverageDays: shiftRows ? buildCoverageDays(shiftRows) : null,
            activityItems,
        };
        const hasUnavailableData = !profileData
            || (loadedCapabilities.canReadUsers && (staffCount === null || managerCount === null))
            || (loadedCapabilities.canReadLocations && locationCount === null)
            || (loadedCapabilities.canReadScheduling && (scheduleRows === null || shiftRows === null))
            || (loadedCapabilities.canReadLunchBreaks && lunchBreakRows === null)
            || !features.ok
            || notificationRows === null;

        if (loadGeneration !== loadGenerationRef.current) return;
        setOverview(nextOverview);
        setError(hasUnavailableData ? 'Some dashboard data is unavailable. Retry to refresh affected widgets.' : null);
        setIsLoading(false);
    }, []);

    useEffect(() => {
        void loadOverview();
    }, [loadOverview]);

    const liveItems = useMemo(() => {
        const data = overview;
        if (!data || data.activityItems === null) {
            return [];
        }
        if (data.activityItems.length > 0) {
            return data.activityItems;
        }
        return [{
            category: 'Activity',
            title: 'No recent activity',
            detail: 'New notifications will appear here as work is published and shifts are updated.',
            time: 'Now',
            tone: 'var(--text-muted)',
        }];
    }, [overview]);

    const capabilities = useMemo(
        () => getWorkspaceCapabilities(overview?.profile?.permissions ?? []),
        [overview?.profile?.permissions],
    );
    const needsFirstLocation = !isLoading
        && overview !== null
        && overview.locationCount === 0
        && capabilities.canWriteLocations;

    const managerTasks = useMemo<ManagerTask[]>(() => {
        const tasks: ManagerTask[] = [];
        if (needsFirstLocation) {
            tasks.push({
                href: '/dashboard/locations',
                label: 'Set up your first location',
                detail: 'Add a location before building schedules for the team.',
                priority: 'urgent',
            });
        }

        if (capabilities.canWriteShifts && overview?.openShiftCount != null && overview.openShiftCount > 0) {
            tasks.push({
                href: '/dashboard/scheduling?focus=open',
                label: `Assign ${formatCount(overview.openShiftCount, 'open shift')}`,
                detail: 'Close coverage gaps before the next shift starts.',
                priority: 'urgent',
            });
        }

        if (capabilities.canReadScheduling && overview?.scheduleCount === 0) {
            tasks.push({
                href: '/dashboard/scheduling',
                label: capabilities.canWriteSchedules ? "Build this week's schedule" : "Review this week's schedule",
                detail: 'There is no schedule in the current planning window.',
                priority: 'urgent',
            });
        }

        if (capabilities.canReadLunchBreaks && overview?.lunchBreaksEnabled && overview.lunchPlanCount === 0) {
            tasks.push({
                href: '/dashboard/lunch-breaks',
                label: capabilities.canWriteLunchBreaks ? "Plan this week's breaks" : "Review this week's breaks",
                detail: 'No lunch plans are currently assigned to shifts.',
                priority: 'urgent',
            });
        }

        if (capabilities.canReadTimeCards) {
            tasks.push({
                href: '/dashboard/time-cards',
                label: 'Review time cards',
                detail: 'Check completed punches and resolve anything that needs attention.',
                priority: 'routine',
            });
        }

        if (capabilities.canReadPayroll) {
            tasks.push({
                href: '/dashboard/payroll',
                label: 'Prepare payroll',
                detail: 'Review approvals, lock the period, export, and confirm results.',
                priority: 'routine',
            });
        }

        if (tasks.length === 0 && capabilities.canReadScheduling) {
            tasks.push({
                href: '/dashboard/scheduling',
                label: "Review this week's schedule",
                detail: 'Coverage is ready for a final manager check.',
                priority: 'routine',
            });
        }

        return tasks;
    }, [capabilities, needsFirstLocation, overview]);

    const weekStatus = useMemo(() => [
        capabilities.canReadScheduling ? {
            href: '/dashboard/scheduling',
            label: 'Schedule',
            value: isLoading ? 'Loading…' : overview?.coveragePercent == null ? 'Unavailable' : `${overview.coveragePercent}% covered`,
            detail: isLoading ? 'Checking shift coverage.' : overview?.openShiftCount == null ? 'Coverage could not be loaded.' : `${formatCount(overview.openShiftCount, 'open shift')} remaining`,
        } : null,
        capabilities.canReadLunchBreaks ? {
            href: '/dashboard/lunch-breaks',
            label: 'Breaks',
            value: isLoading ? 'Loading…' : overview?.breakCompliancePercent == null ? 'Unavailable' : `${overview.breakCompliancePercent}% planned`,
            detail: isLoading ? 'Checking lunch plans.' : overview?.lunchPlanCount == null ? 'Break plans could not be loaded.' : `${formatCount(overview.lunchPlanCount, 'shift')} with lunch plans`,
        } : null,
        capabilities.canReadUsers ? {
            href: '/dashboard/staff',
            label: 'Team',
            value: isLoading ? 'Loading…' : overview?.staffCount == null ? 'Unavailable' : formatCount(overview.staffCount, 'person', 'people'),
            detail: isLoading ? 'Checking team totals.' : overview?.managerCount == null ? 'Staff totals could not be loaded.' : formatCount(overview.managerCount, 'manager'),
        } : null,
        capabilities.canReadLocations ? {
            href: '/dashboard/locations',
            label: 'Locations',
            value: isLoading ? 'Loading…' : overview?.locationCount == null ? 'Unavailable' : formatCount(overview.locationCount, 'location'),
            detail: isLoading ? 'Checking workspace locations.' : overview?.latestScheduleLabel ?? 'Schedule status could not be loaded.',
        } : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null), [capabilities, isLoading, overview]);

    return (
        <div className="manager-dashboard">
            {error ? (
                <section className="manager-dashboard-alert" aria-live="polite">
                    <div>{error}</div>
                    <button type="button" className="btn btn-secondary" onClick={() => void loadOverview()} disabled={isLoading}>
                        {isLoading ? 'Retrying...' : 'Retry'}
                    </button>
                </section>
            ) : null}

            <header className="manager-dashboard-header">
                <div>
                    <div className="workspace-kicker">{overview?.profile?.tenantName ?? 'Manager workspace'}</div>
                    <h1 className="workspace-title">Manager dashboard</h1>
                    <p className="workspace-subtitle">{todayLabel}</p>
                </div>
            </header>

            <section className="surface-card manager-dashboard-section" aria-labelledby="needs-attention-title">
                <div className="manager-dashboard-section-heading">
                    <div>
                        <div className="workspace-kicker">Your next steps</div>
                        <h2 id="needs-attention-title">Needs attention</h2>
                    </div>
                    <span className="manager-dashboard-count">{managerTasks.length}</span>
                </div>
                {isLoading ? <p role="status" className="manager-dashboard-muted">Loading manager tasks…</p> : null}
                {!isLoading && managerTasks.length === 0 ? <p className="manager-dashboard-muted">Nothing needs action right now.</p> : null}
                {!isLoading && managerTasks.length > 0 ? (
                    <div className="manager-task-list">
                        {managerTasks.map((task) => (
                            <Link key={`${task.href}-${task.label}`} href={task.href} className={`manager-task-link manager-task-${task.priority}`}>
                                <span><strong>{task.label}</strong><small>{task.detail}</small></span>
                                <span aria-hidden="true">→</span>
                            </Link>
                        ))}
                    </div>
                ) : null}
            </section>

            <section className="surface-card manager-dashboard-section" aria-labelledby="this-week-title">
                <div className="manager-dashboard-section-heading">
                    <div>
                        <div className="workspace-kicker">Current status</div>
                        <h2 id="this-week-title">This week</h2>
                    </div>
                    {error ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadOverview()}>Retry unavailable data</button> : null}
                </div>
                <div className="manager-week-grid">
                    {weekStatus.map((item) => (
                        <Link key={item.label} href={item.href} className="manager-week-link">
                            <span>{item.label}</span>
                            <strong>{item.value}</strong>
                            <small>{item.detail}</small>
                        </Link>
                    ))}
                </div>

                {capabilities.canReadScheduling ? (
                    <div className="manager-coverage-strip" role="region" aria-label="Daily shift coverage" tabIndex={0}>
                        {isLoading ? <span>Loading daily coverage…</span> : overview?.coverageDays?.map((day) => (
                            <span key={day.day} className={`manager-coverage-day manager-coverage-${day.tone}`}>
                                <strong>{day.day}</strong><small>{day.status}</small>
                            </span>
                        )) ?? <span>Daily coverage is unavailable.</span>}
                    </div>
                ) : null}

                <div className="manager-recent">
                    <h3>Recent changes</h3>
                    {isLoading ? <p role="status" className="manager-dashboard-muted">Loading recent changes…</p> : null}
                    {!isLoading && overview?.activityItems == null ? <p className="manager-dashboard-muted">Recent changes are unavailable.</p> : null}
                    {!isLoading && overview?.activityItems !== null ? (
                        <ul>
                            {liveItems.slice(0, 3).map((item) => (
                                <li key={`${item.category}-${item.title}`}>
                                    <span className="status-dot" style={{ background: item.tone }} />
                                    <span><strong>{item.title}</strong><small>{item.detail} · {item.time}</small></span>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            </section>
        </div>
    );
}
