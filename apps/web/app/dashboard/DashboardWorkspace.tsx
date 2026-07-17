'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, Clock3, MapPin, Plus, Users, UserPlus } from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
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

type ActionIcon = typeof CalendarDays | typeof LunchLineupMark;

type QuickAction = {
    label: string;
    desc: string;
    icon: ActionIcon;
    href: string;
    tier: 'primary' | 'secondary';
};

const QUICK_ACTIONS: QuickAction[] = [
    {
        label: 'Build Weekly Schedule',
        desc: 'Assign and optimize shifts in one workspace',
        icon: CalendarDays,
        href: '/dashboard/scheduling',
        tier: 'primary' as const,
    },
    {
        label: 'Generate Lunch Plan',
        desc: 'Auto-stagger breaks with policy controls',
        icon: LunchLineupMark,
        href: '/dashboard/lunch-breaks',
        tier: 'primary' as const,
    },
    {
        label: 'Invite a Team Member',
        desc: 'Add staff and assign roles instantly',
        icon: UserPlus,
        href: '/dashboard/staff',
        tier: 'secondary' as const,
    },
    {
        label: 'Add New Location',
        desc: 'Extend scheduling to another storefront',
        icon: Plus,
        href: '/dashboard/locations',
        tier: 'secondary' as const,
    },
];

function formatCount(count: number, singular: string, plural?: string): string {
    return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}

function firstName(name?: string | null): string {
    const value = name?.trim();
    if (!value) return 'team';
    return value.split(/\s+/)[0] ?? 'team';
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

    const summaryCards = useMemo(() => {
        const data = overview;
        const staffUnavailable = !isLoading && (data?.staffCount == null || data.managerCount == null);
        const coverageUnavailable = !isLoading && (data?.coveragePercent == null || data.openShiftCount == null);
        const breaksUnavailable = !isLoading && (
            data?.breakCompliancePercent == null
            || data.lunchPlanCount == null
            || data.lunchBreaksEnabled == null
        );
        const locationsUnavailable = !isLoading && (
            data?.locationCount == null
            || data.scheduleCount == null
            || data.latestScheduleLabel == null
        );

        return [
            {
                label: 'Active staff',
                value: isLoading ? '—' : staffUnavailable ? 'Unavailable' : String(data?.staffCount),
                delta: isLoading
                    ? 'Loading staff counts...'
                    : staffUnavailable
                        ? 'Staff totals could not be loaded.'
                        : formatCount(data?.managerCount ?? 0, 'manager') + ' active',
                tone: '#2f63ff',
                bg: 'linear-gradient(145deg, #edf3ff, #f7f9ff)',
                icon: Users,
                unavailable: staffUnavailable,
            },
            {
                label: "This week's coverage",
                value: isLoading ? '—' : coverageUnavailable ? 'Unavailable' : `${data?.coveragePercent}%`,
                delta: isLoading
                    ? 'Loading shift coverage...'
                    : coverageUnavailable
                        ? 'Shift coverage could not be loaded.'
                        : (data?.openShiftCount ?? 0) > 0
                            ? `${formatCount(data?.openShiftCount ?? 0, 'open shift')} remaining`
                            : 'All shifts are assigned',
                tone: '#17b26a',
                bg: 'linear-gradient(145deg, #e9fbf1, #f7fffb)',
                icon: CalendarDays,
                unavailable: coverageUnavailable,
            },
            {
                label: 'Break compliance',
                value: isLoading ? '—' : breaksUnavailable ? 'Unavailable' : `${data?.breakCompliancePercent}%`,
                delta: isLoading
                    ? 'Loading lunch data...'
                    : breaksUnavailable
                        ? 'Lunch coverage could not be loaded.'
                        : data?.lunchBreaksEnabled
                            ? `${formatCount(data.lunchPlanCount ?? 0, 'shift')} with lunch plans`
                            : 'Lunch breaks require an active paid subscription and usage credits',
                tone: '#f59e0b',
                bg: 'linear-gradient(145deg, #fff6e7, #fffaf1)',
                icon: Clock3,
                unavailable: breaksUnavailable,
            },
            {
                label: 'Locations online',
                value: isLoading ? '—' : locationsUnavailable ? 'Unavailable' : String(data?.locationCount),
                delta: isLoading
                    ? 'Loading locations...'
                    : locationsUnavailable
                        ? 'Location or schedule data could not be loaded.'
                        : (data?.scheduleCount ?? 0) > 0
                            ? `${data?.latestScheduleLabel}`
                            : 'No schedules created yet',
                tone: '#22b8cf',
                bg: 'linear-gradient(145deg, #e9fafe, #f6fdff)',
                icon: MapPin,
                unavailable: locationsUnavailable,
            },
        ];
    }, [isLoading, overview]);

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

    const heroActions = useMemo(() => {
        const actions: Array<{ href: string; label: string; className: string }> = [];
        if (needsFirstLocation) {
            return [{
                href: '/dashboard/locations',
                label: 'Add First Location',
                className: 'btn btn-primary',
            }];
        }
        if (capabilities.canWriteShifts) {
            actions.push({ href: '/dashboard/scheduling?focus=open', label: 'Assign Open Shifts', className: 'btn btn-primary' });
        }
        if (capabilities.canReadScheduling) {
            actions.push({
                href: '/dashboard/scheduling',
                label: capabilities.canWriteShifts ? 'Build Weekly Schedule' : 'View Schedule',
                className: capabilities.canWriteShifts ? 'btn btn-secondary' : 'btn btn-primary',
            });
        }
        if (!capabilities.canReadScheduling && capabilities.canReadTimeCards) {
            actions.push({ href: '/dashboard/time-cards', label: 'Open Time Cards', className: 'btn btn-primary' });
        }
        return actions;
    }, [capabilities, needsFirstLocation]);

    const quickActions = useMemo(() => {
        const actions: typeof QUICK_ACTIONS = [];
        if (needsFirstLocation) {
            return [{
                ...QUICK_ACTIONS[3],
                label: 'Set Up First Location',
                desc: 'Add the timezone and operating location for this workspace',
                tier: 'primary',
            }];
        }
        if (capabilities.canWriteShifts) {
            actions.push(QUICK_ACTIONS[0]);
        } else if (capabilities.canReadScheduling) {
            actions.push({
                ...QUICK_ACTIONS[0],
                label: 'Review Weekly Schedule',
                desc: 'View assigned shifts and open coverage',
                tier: 'primary',
            });
        }

        if (capabilities.canWriteLunchBreaks) {
            actions.push(QUICK_ACTIONS[1]);
        } else if (capabilities.canReadLunchBreaks) {
            actions.push({
                ...QUICK_ACTIONS[1],
                label: 'Review Lunch Plan',
                desc: 'View generated meals, breaks, and coverage risk',
                tier: 'primary',
            });
        }

        if (capabilities.canWriteUsers) {
            actions.push(QUICK_ACTIONS[2]);
        } else if (capabilities.canReadUsers) {
            actions.push({
                ...QUICK_ACTIONS[2],
                label: 'Staff Directory',
                desc: 'Review team members and assigned roles',
                tier: 'secondary',
            });
        }

        if (capabilities.canWriteLocations) {
            actions.push(QUICK_ACTIONS[3]);
        } else if (capabilities.canReadLocations) {
            actions.push({
                ...QUICK_ACTIONS[3],
                label: 'Locations',
                desc: 'Review workspace locations',
                tier: 'secondary',
            });
        }

        if (capabilities.canReadTimeCards) {
            actions.push({
                label: capabilities.canWriteTimeCards ? 'Open Time Clock' : 'Review Time Cards',
                desc: capabilities.canWriteTimeCards ? 'Clock in, clock out, and review history' : 'Review time card history',
                icon: Clock3,
                href: '/dashboard/time-cards',
                tier: 'secondary',
            });
        }

        return actions;
    }, [capabilities, needsFirstLocation]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1420 }}>
            {error ? (
                <section aria-live="polite" style={{ padding: '0.95rem 1rem', border: '1px solid #ffd0da', background: '#fff8fa', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: '0.88rem', color: '#b8334d', fontWeight: 700 }}>
                        {error}
                    </div>
                    <button type="button" className="btn btn-secondary" onClick={() => void loadOverview()} disabled={isLoading}>
                        {isLoading ? 'Retrying...' : 'Retry'}
                    </button>
                </section>
            ) : null}

            <section
                className="surface-card animate-fade-up"
                style={{
                    padding: '1.6rem',
                    background:
                        'radial-gradient(35rem 18rem at 0% 0%, rgba(79,121,255,0.16), transparent 60%), radial-gradient(28rem 14rem at 100% 100%, rgba(34,184,207,0.14), transparent 60%), #ffffff',
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                    <div style={{ maxWidth: 720, display: 'grid', gap: '0.32rem' }}>
                        <h1 className="workspace-title" style={{ marginBottom: '0.35rem' }}>
                            {needsFirstLocation
                                ? 'Complete workspace setup'
                                : `Welcome back, ${firstName(overview?.profile?.name)}`}
                        </h1>
                        <p className="workspace-subtitle">
                            {todayLabel} - {overview?.profile?.tenantName ?? 'Live dashboard'}
                        </p>
                        <p style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: 650 }}>
                            {isLoading
                                ? 'Loading live overview data...'
                                : needsFirstLocation
                                    ? 'Add the first location before creating schedules or inviting the wider team.'
                                    : overview?.openShiftCount == null
                                        ? 'Shift coverage is unavailable. Retry the affected dashboard widgets.'
                                        : `${formatCount(overview.openShiftCount, 'open shift')} need assignment. ${overview.lunchBreaksEnabled === null ? 'Lunch feature access is unavailable.' : overview.lunchBreaksEnabled ? 'Lunch coverage is available.' : 'Lunch coverage requires an active paid subscription and usage credits.'}`}
                        </p>
                    </div>

                    <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                        {heroActions.map((action) => (
                            <Link key={`${action.href}-${action.label}`} href={action.href} className={action.className}>
                                {action.label}
                            </Link>
                        ))}
                    </div>
                </div>
            </section>

            <section>
                <article
                    className="surface-card animate-slide-up"
                    style={{
                        padding: '1rem 1.1rem',
                        border: '1px solid #ffd0da',
                        background: 'linear-gradient(145deg, #fff1f4, #fff8fa)',
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <div style={{ display: 'grid', gap: '0.2rem' }}>
                            <h2 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Open shift coverage</h2>
                            <p style={{ fontSize: '0.88rem', color: '#b8324a', fontWeight: 700 }}>
                                {isLoading
                                    ? 'Loading open shift data...'
                                    : overview?.openShiftCount == null
                                        ? 'Open shift data is unavailable.'
                                        : `${formatCount(overview.openShiftCount, 'shift')} need assignment before the next planning cycle`}
                            </p>
                            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                {isLoading
                                    ? 'Loading schedule details...'
                                    : overview?.coveragePercent == null
                                        ? 'Coverage data is unavailable.'
                                        : `${overview.coveragePercent}% staffed across the current shift set`}
                            </p>
                        </div>
                        {!isLoading && overview?.openShiftCount == null ? (
                            <button type="button" className="btn btn-secondary" onClick={() => void loadOverview()}>
                                Retry
                            </button>
                        ) : capabilities.canReadScheduling ? (
                            <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
                                {capabilities.canWriteShifts ? (
                                    <Link href="/dashboard/scheduling?focus=open" className="btn btn-primary">
                                        Assign now
                                    </Link>
                                ) : null}
                                <Link href="/dashboard/scheduling" className={capabilities.canWriteShifts ? 'btn btn-secondary' : 'btn btn-primary'}>
                                    View schedule
                                </Link>
                            </div>
                        ) : null}
                    </div>
                </article>
            </section>

            <section
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: '0.9rem',
                }}
            >
                {summaryCards.map((card) => {
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
                            <div style={{ fontSize: '1.85rem', fontWeight: 800, letterSpacing: 0, color: 'var(--text-primary)' }}>
                                {card.value}
                            </div>
                            <div style={{ fontSize: '0.78rem', color: card.tone, fontWeight: 700 }}>{card.delta}</div>
                            {card.unavailable ? (
                                <button type="button" className="btn btn-secondary" onClick={() => void loadOverview()} style={{ marginTop: '0.65rem' }}>
                                    Retry
                                </button>
                            ) : null}
                        </article>
                    );
                })}
            </section>

            <section>
                <article
                    className="surface-card"
                    style={{
                        padding: '1rem 1.1rem',
                        background:
                            'radial-gradient(22rem 11rem at 0% 0%, rgba(106, 199, 154, 0.14), transparent 70%), radial-gradient(20rem 10rem at 100% 100%, rgba(34, 184, 207, 0.1), transparent 70%), #ffffff',
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <div style={{ display: 'grid', gap: '0.2rem' }}>
                            <h2 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--text-primary)' }}>Today&apos;s break status</h2>
                            <div style={{ display: 'grid', gap: '0.15rem', fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                                <p>{isLoading ? 'Loading break plans...' : overview?.lunchPlanCount == null ? 'Break plan data is unavailable.' : `${formatCount(overview.lunchPlanCount, 'shift')} have lunch plans`}</p>
                                <p>{isLoading ? 'Loading schedule counts...' : overview?.publishedScheduleCount == null ? 'Schedule data is unavailable.' : `${formatCount(overview.publishedScheduleCount, 'published schedule')}`}</p>
                                <p style={{ color: '#b55f00' }}>
                                    {isLoading
                                        ? 'Loading feature access...'
                                        : overview?.lunchBreaksEnabled == null || overview.breakCompliancePercent == null
                                            ? 'Lunch compliance is unavailable.'
                                            : overview.lunchBreaksEnabled
                                                ? `${overview.breakCompliancePercent}% lunch compliance`
                                                : 'Lunch breaks require an active paid subscription and usage credits'}
                                </p>
                                <p style={{ color: '#148f56' }}>
                                    {isLoading
                                        ? 'Loading coverage status...'
                                        : overview?.coveragePercent == null
                                            ? 'Coverage status is unavailable.'
                                            : `${overview.coveragePercent}% coverage across current shifts`}
                                </p>
                            </div>
                        </div>
                        {!isLoading && (
                            overview?.lunchPlanCount == null
                            || overview.publishedScheduleCount == null
                            || overview.lunchBreaksEnabled == null
                            || overview.coveragePercent == null
                        ) ? (
                            <button type="button" className="btn btn-secondary" onClick={() => void loadOverview()}>
                                Retry
                            </button>
                        ) : capabilities.canReadLunchBreaks ? (
                            <Link href="/dashboard/lunch-breaks" className="btn btn-secondary">
                                {capabilities.canWriteLunchBreaks ? 'Open Lunch Plan' : 'Review Lunch Plan'}
                            </Link>
                        ) : null}
                    </div>
                </article>
            </section>

            <section>
                <article className="surface-card" style={{ padding: '1.2rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)' }}>Coverage this week</h2>
                        {capabilities.canReadScheduling ? (
                            <Link href="/dashboard/scheduling" className="text-sm text-brand" style={{ fontWeight: 700 }}>
                                Open scheduler
                            </Link>
                        ) : null}
                    </div>

                    {isLoading ? (
                        <p role="status" style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>Loading weekly coverage...</p>
                    ) : overview?.coverageDays == null ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>Weekly coverage is unavailable.</p>
                            <button type="button" className="btn btn-secondary" onClick={() => void loadOverview()}>Retry</button>
                        </div>
                    ) : (
                    <div style={{ display: 'grid', gap: '0.52rem' }}>
                        {overview.coverageDays.map((d) => {
                            const tone =
                                d.tone === 'healthy'
                                    ? { chip: '#e9fbf1', dot: '#17b26a', text: '#148f56' }
                                    : d.tone === 'risk'
                                        ? { chip: '#fff6e7', dot: '#f59e0b', text: '#9a6400' }
                                        : { chip: '#ffeef2', dot: '#e74867', text: '#b8334d' };

                            return (
                                <div key={d.day} className="surface-muted" style={{ padding: '0.58rem 0.68rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                                        <span style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--text-primary)', minWidth: 32 }}>{d.day}</span>
                                        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {d.status}
                                        </span>
                                    </div>
                                    <span
                                        style={{
                                            background: tone.chip,
                                            color: tone.text,
                                            borderRadius: 999,
                                            padding: '0.2rem 0.48rem',
                                            fontSize: '0.68rem',
                                            fontWeight: 800,
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '0.28rem',
                                            flexShrink: 0,
                                        }}
                                    >
                                        <span style={{ width: 7, height: 7, borderRadius: 999, background: tone.dot, display: 'inline-block' }} />
                                        {d.tone === 'healthy' ? 'Healthy' : d.tone === 'risk' ? 'At risk' : 'Needs attention'}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                    )}
                </article>
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.85rem' }}>
                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.85rem' }}>
                    {quickActions.filter((action) => action.tier === 'primary').map((action) => {
                        const Icon = action.icon;
                        return (
                        <Link
                            key={action.label}
                            href={action.href}
                            className="surface-card"
                            style={{
                                padding: '1.15rem',
                                display: 'flex',
                                gap: '0.85rem',
                                background:
                                    'radial-gradient(16rem 10rem at 0% 0%, rgba(79,121,255,0.12), transparent 70%), #ffffff',
                            }}
                        >
                            <span
                                style={{
                                    width: 48,
                                    height: 48,
                                    borderRadius: 13,
                                    border: '1px solid #cfe0ff',
                                    background: '#edf3ff',
                                    display: 'grid',
                                    placeItems: 'center',
                                    fontSize: '1.2rem',
                                    flexShrink: 0,
                                }}
                            >
                                <Icon size={20} />
                            </span>
                            <div>
                                <div style={{ fontSize: '0.98rem', fontWeight: 750, color: 'var(--text-primary)' }}>{action.label}</div>
                                <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{action.desc}</div>
                            </div>
                        </Link>
                        );
                    })}
                </div>

                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                    {quickActions.filter((action) => action.tier === 'secondary').map((action) => {
                        const Icon = action.icon;
                        return (
                        <Link key={action.label} href={action.href} className="surface-card" style={{ padding: '0.85rem', display: 'flex', gap: '0.68rem' }}>
                            <span
                                style={{
                                    width: 38,
                                    height: 38,
                                    borderRadius: 11,
                                    border: '1px solid var(--border)',
                                    background: 'var(--bg-soft)',
                                    display: 'grid',
                                    placeItems: 'center',
                                    fontSize: '1rem',
                                    flexShrink: 0,
                                }}
                            >
                                <Icon size={20} />
                            </span>
                            <div>
                                <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)' }}>{action.label}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{action.desc}</div>
                            </div>
                        </Link>
                        );
                    })}
                </div>
                {quickActions.length === 0 ? (
                    <div className="surface-card" style={{ gridColumn: '1 / -1', padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.84rem' }}>
                        No additional workspace routes are available for this role.
                    </div>
                ) : null}
            </section>

            <section>
                <article className="surface-card" style={{ padding: '1.2rem' }}>
                    <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)', marginBottom: '1rem' }}>
                        Recent changes
                    </h2>
                    {isLoading ? (
                        <p role="status" style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>Loading recent changes...</p>
                    ) : overview?.activityItems == null ? (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>Recent changes are unavailable.</p>
                            <button type="button" className="btn btn-secondary" onClick={() => void loadOverview()}>Retry</button>
                        </div>
                    ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                        {liveItems.map((item) => (
                            <div key={`${item.category}-${item.title}`} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
                                <span className="status-dot" style={{ marginTop: 7, background: item.tone }} />
                                <div>
                                    <div style={{ display: 'flex', gap: '0.42rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: 2 }}>
                                        <span
                                            style={{
                                                borderRadius: 999,
                                                padding: '0.08rem 0.4rem',
                                                fontSize: '0.65rem',
                                                fontWeight: 700,
                                                color: item.tone,
                                                background: 'rgba(47, 99, 255, 0.09)',
                                                border: '1px solid var(--border)',
                                            }}
                                        >
                                            {item.category}
                                        </span>
                                        <p style={{ fontSize: '0.81rem', color: 'var(--text-primary)', fontWeight: 700, lineHeight: 1.35 }}>
                                            {item.title}
                                        </p>
                                    </div>
                                    <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{item.detail}</p>
                                    <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{item.time}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                    )}
                </article>
            </section>
        </div>
    );
}
