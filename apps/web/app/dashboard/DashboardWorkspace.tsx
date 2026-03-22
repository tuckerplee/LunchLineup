'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, Clock3, MapPin, Users } from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { fetchWithSession } from '@/lib/client-api';

type DashboardProfile = {
    name?: string | null;
    tenantName?: string | null;
};

type ApiUser = {
    role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
};

type ApiLocation = {
    id: string;
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

type ApiLunchBreaks = {
    data?: Array<{
        breaks?: Array<{
            type?: 'break1' | 'lunch' | 'break2';
        }>;
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
    staffCount: number;
    managerCount: number;
    locationCount: number;
    scheduleCount: number;
    publishedScheduleCount: number;
    totalShiftCount: number;
    openShiftCount: number;
    coveragePercent: number;
    breakCompliancePercent: number;
    lunchBreaksEnabled: boolean;
    schedulingEnabled: boolean;
    usageCredits: number;
    latestScheduleLabel: string;
    lunchPlanCount: number;
    coverageDays: CoverageDay[];
    activityItems: ActivityItem[];
};

const QUICK_ACTIONS = [
    {
        label: 'Build Weekly Schedule',
        desc: 'Assign and optimize shifts in one workspace',
        icon: '📅',
        href: '/dashboard/scheduling',
        tier: 'primary' as const,
    },
    {
        label: 'Generate Lunch Plan',
        desc: 'Auto-stagger breaks with policy controls',
        icon: <LunchLineupMark size={20} />,
        href: '/dashboard/lunch-breaks',
        tier: 'primary' as const,
    },
    {
        label: 'Invite a Team Member',
        desc: 'Add staff and assign roles instantly',
        icon: '👋',
        href: '/dashboard/staff',
        tier: 'secondary' as const,
    },
    {
        label: 'Add New Location',
        desc: 'Extend scheduling to another storefront',
        icon: '🏢',
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

async function fetchJsonOrNull<T>(path: string): Promise<T | null> {
    const response = await fetchWithSession(path);
    if (!response.ok) return null;
    return response.json() as Promise<T>;
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
        setIsLoading(true);
        setError(null);

        try {
            const [profile, users, locations, schedules, shifts, features, lunchBreaks, notifications] = await Promise.all([
                fetchJsonOrNull<{ user?: DashboardProfile }>('/auth/me'),
                fetchJsonOrNull<{ data?: ApiUser[] }>('/users'),
                fetchJsonOrNull<{ data?: ApiLocation[] }>('/locations'),
                fetchJsonOrNull<{ data?: ApiSchedule[] }>('/schedules'),
                fetchJsonOrNull<{ data?: ApiShift[] }>('/shifts'),
                fetchJsonOrNull<ApiFeatureMatrix>('/billing/features'),
                fetchJsonOrNull<ApiLunchBreaks>('/lunch-breaks'),
                fetchJsonOrNull<{ data?: ApiNotification[] }>('/notifications?status=all&limit=5'),
            ]);

            const profileData = profile?.user ?? null;
            const userRows = users?.data ?? [];
            const locationRows = locations?.data ?? [];
            const scheduleRows = schedules?.data ?? [];
            const shiftRows = shifts?.data ?? [];
            const featureMatrix = features ?? { usageCredits: 0, features: {} };
            const lunchBreakRows = lunchBreaks?.data ?? [];
            const notificationRows = notifications?.data ?? [];

            const staffRows = userRows.filter((user) => user.role === 'MANAGER' || user.role === 'STAFF');
            const managerCount = staffRows.filter((user) => user.role === 'MANAGER').length;
            const totalShiftCount = shiftRows.length;
            const openShiftCount = shiftRows.filter((shift) => !shift.userId).length;
            const staffedShiftCount = Math.max(0, totalShiftCount - openShiftCount);
            const coveragePercent = totalShiftCount > 0 ? Math.round((staffedShiftCount / totalShiftCount) * 100) : 0;

            const lunchPlanCount = lunchBreakRows.filter((row) => (
                Array.isArray(row.breaks) && row.breaks.some((entry) => entry.type === 'lunch')
            )).length;
            const breakCompliancePercent = totalShiftCount > 0 ? Math.round((lunchPlanCount / totalShiftCount) * 100) : 0;
            const latestSchedule = scheduleRows
                .slice()
                .sort((left, right) => new Date(right.startDate).getTime() - new Date(left.startDate).getTime())[0] ?? null;
            const coverageDays = buildCoverageDays(shiftRows);
            const activityItems = notificationRows.map((entry) => ({
                category: categoryForNotification(entry.type),
                title: entry.title || 'Update',
                detail: entry.body || 'Recent activity',
                time: relativeTimeLabel(entry.createdAt),
                tone: toneForNotification(entry.type),
            }));

            setOverview({
                profile: profileData,
                staffCount: staffRows.length,
                managerCount,
                locationCount: locationRows.length,
                scheduleCount: scheduleRows.length,
                publishedScheduleCount: scheduleRows.filter((schedule) => schedule.status === 'PUBLISHED').length,
                totalShiftCount,
                openShiftCount,
                coveragePercent,
                breakCompliancePercent,
                lunchBreaksEnabled: Boolean(featureMatrix.features.lunch_breaks?.enabled),
                schedulingEnabled: Boolean(featureMatrix.features.scheduling?.enabled),
                usageCredits: featureMatrix.usageCredits ?? 0,
                latestScheduleLabel: formatScheduleLabel(latestSchedule),
                lunchPlanCount,
                coverageDays,
                activityItems,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to load dashboard overview.');
            setOverview(null);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadOverview();
    }, [loadOverview]);

    const summaryCards = useMemo(() => {
        const data = overview ?? {
            staffCount: 0,
            managerCount: 0,
            locationCount: 0,
            scheduleCount: 0,
            publishedScheduleCount: 0,
            totalShiftCount: 0,
            openShiftCount: 0,
            coveragePercent: 0,
            breakCompliancePercent: 0,
            lunchBreaksEnabled: false,
            schedulingEnabled: false,
            usageCredits: 0,
            latestScheduleLabel: 'No schedules yet',
            lunchPlanCount: 0,
            coverageDays: [],
            activityItems: [],
        };

        return [
            {
                label: 'Active staff',
                value: isLoading ? '—' : String(data.staffCount),
                delta: isLoading
                    ? 'Loading staff counts...'
                    : `${formatCount(data.managerCount, 'manager')} active`,
                tone: '#2f63ff',
                bg: 'linear-gradient(145deg, #edf3ff, #f7f9ff)',
                icon: Users,
            },
            {
                label: "This week's coverage",
                value: isLoading ? '—' : `${data.coveragePercent}%`,
                delta: isLoading
                    ? 'Loading shift coverage...'
                    : data.openShiftCount > 0
                        ? `${formatCount(data.openShiftCount, 'open shift')} remaining`
                        : 'All shifts are assigned',
                tone: '#17b26a',
                bg: 'linear-gradient(145deg, #e9fbf1, #f7fffb)',
                icon: CalendarDays,
            },
            {
                label: 'Break compliance',
                value: isLoading ? '—' : `${data.breakCompliancePercent}%`,
                delta: isLoading
                    ? 'Loading lunch data...'
                    : data.lunchBreaksEnabled
                        ? `${formatCount(data.lunchPlanCount, 'shift')} with lunch plans`
                        : 'Lunch breaks are locked on the current plan',
                tone: '#f59e0b',
                bg: 'linear-gradient(145deg, #fff6e7, #fffaf1)',
                icon: Clock3,
            },
            {
                label: 'Locations online',
                value: isLoading ? '—' : String(data.locationCount),
                delta: isLoading
                    ? 'Loading locations...'
                    : data.scheduleCount > 0
                        ? `${data.latestScheduleLabel}`
                        : 'No schedules created yet',
                tone: '#22b8cf',
                bg: 'linear-gradient(145deg, #e9fafe, #f6fdff)',
                icon: MapPin,
            },
        ];
    }, [isLoading, overview]);

    const liveItems = useMemo(() => {
        const data = overview;
        if (!data) {
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

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: 1420 }}>
            {error ? (
                <section className="surface-card" style={{ padding: '0.95rem 1rem', border: '1px solid #ffd0da', background: 'linear-gradient(145deg, #fff1f4, #fff8fa)' }}>
                    <div style={{ fontSize: '0.88rem', color: '#b8334d', fontWeight: 700 }}>
                        {error}
                    </div>
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
                            Welcome back, {firstName(overview?.profile?.name)}
                        </h1>
                        <p className="workspace-subtitle">
                            {todayLabel} · {overview?.profile?.tenantName ?? 'Live dashboard'}
                        </p>
                        <p style={{ color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: 650 }}>
                            {isLoading
                                ? 'Loading live overview data...'
                                : `${formatCount(overview?.openShiftCount ?? 0, 'open shift')} need assignment. ${overview?.lunchBreaksEnabled ? 'Lunch coverage is available.' : 'Lunch coverage is locked by plan.'}`}
                        </p>
                    </div>

                    <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                        <Link href="/dashboard/scheduling?focus=open" className="btn btn-primary">
                            Assign Open Shifts
                        </Link>
                        <Link href="/dashboard/scheduling" className="btn btn-secondary">
                            Build Weekly Schedule
                        </Link>
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
                                    : `${formatCount(overview?.openShiftCount ?? 0, 'shift')} need assignment before the next planning cycle`}
                            </p>
                            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                {isLoading
                                    ? 'Loading schedule details...'
                                    : `${overview?.coveragePercent ?? 0}% staffed across the current shift set`}
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: '0.55rem', flexWrap: 'wrap' }}>
                            <Link href="/dashboard/scheduling?focus=open" className="btn btn-primary">
                                Assign now
                            </Link>
                            <Link href="/dashboard/scheduling" className="btn btn-secondary">
                                View schedule
                            </Link>
                        </div>
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
                            <div style={{ fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.03em', color: 'var(--text-primary)' }}>
                                {card.value}
                            </div>
                            <div style={{ fontSize: '0.78rem', color: card.tone, fontWeight: 700 }}>{card.delta}</div>
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
                                <p>{isLoading ? 'Loading break plans...' : `${formatCount(overview?.lunchPlanCount ?? 0, 'shift')} have lunch plans`}</p>
                                <p>{isLoading ? 'Loading schedule counts...' : `${formatCount(overview?.publishedScheduleCount ?? 0, 'published schedule')}`}</p>
                                <p style={{ color: '#b55f00' }}>
                                    {isLoading
                                        ? 'Loading feature access...'
                                        : overview?.lunchBreaksEnabled
                                            ? `${overview.breakCompliancePercent}% lunch compliance`
                                            : 'Lunch breaks are not enabled on the current plan'}
                                </p>
                                <p style={{ color: '#148f56' }}>
                                    {isLoading
                                        ? 'Loading coverage status...'
                                        : `${overview?.coveragePercent ?? 0}% coverage across current shifts`}
                                </p>
                            </div>
                        </div>
                        <Link href="/dashboard/lunch-breaks" className="btn btn-secondary">
                            Open Lunch Plan
                        </Link>
                    </div>
                </article>
            </section>

            <section>
                <article className="surface-card" style={{ padding: '1.2rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)' }}>Coverage this week</h2>
                        <Link href="/dashboard/scheduling" className="text-sm text-brand" style={{ fontWeight: 700 }}>
                            Open scheduler
                        </Link>
                    </div>

                    <div style={{ display: 'grid', gap: '0.52rem' }}>
                        {(overview?.coverageDays ?? []).map((d) => {
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
                </article>
            </section>

            <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.85rem' }}>
                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.85rem' }}>
                    {QUICK_ACTIONS.filter((action) => action.tier === 'primary').map((action) => (
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
                                {action.icon}
                            </span>
                            <div>
                                <div style={{ fontSize: '0.98rem', fontWeight: 750, color: 'var(--text-primary)' }}>{action.label}</div>
                                <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{action.desc}</div>
                            </div>
                        </Link>
                    ))}
                </div>

                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                    {QUICK_ACTIONS.filter((action) => action.tier === 'secondary').map((action) => (
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
                                {action.icon}
                            </span>
                            <div>
                                <div style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--text-primary)' }}>{action.label}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{action.desc}</div>
                            </div>
                        </Link>
                    ))}
                </div>
            </section>

            <section>
                <article className="surface-card" style={{ padding: '1.2rem' }}>
                    <h2 style={{ fontSize: '1rem', fontWeight: 750, color: 'var(--text-primary)', marginBottom: '1rem' }}>
                        Recent changes
                    </h2>
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
                </article>
            </section>
        </div>
    );
}
