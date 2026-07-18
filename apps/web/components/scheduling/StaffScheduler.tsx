'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { formatTimeInTimeZone, instantToWallClockDate, wallClockDateToIso } from '@/lib/location-timezone';
import {
    dateForTimelineOffset,
    projectIntervalIntoDailyWindows,
    resolveSchedulerTimelineLayout,
    timelineOffsetForDate,
    type SchedulerTimelineViewMode,
} from './scheduler-projection';

interface StaffResource {
    id: string;
    title: string;
    role: string;
    avatarInitials: string;
    hue: number;
}

export interface StaffScheduleEvent {
    id: string;
    resourceId: string;
    title: string;
    start: string;
    end: string;
    extendedProps: { role: string; kind?: 'shift' | 'lunch' | 'break'; conflict?: string };
}

export type SchedulerViewMode = SchedulerTimelineViewMode;

type CoverageTone = 'healthy' | 'risk' | 'critical';

type DragState = {
    eventId: string;
    startX: number;
    startY: number;
    currentY: number;
    originalStart: Date;
    originalEnd: Date;
};

type ShiftActionState = {
    event: StaffScheduleEvent;
    left: number;
    top: number;
};

export type StaffScheduleSlotSelection = {
    resourceId: string;
    start: string;
    end: string;
};

interface StaffSchedulerProps {
    resources: StaffResource[];
    events: StaffScheduleEvent[];
    viewMode: SchedulerViewMode;
    initialDate?: string;
    timeZone: string;
    compactWindow?: boolean;
    onEventChange?: (eventId: string, newStart: string, newEnd: string, newResourceId: string) => void;
    onEventSelect?: (event: StaffScheduleEvent) => void;
    onEventDelete?: (event: StaffScheduleEvent) => void;
    onSlotSelect?: (slot: StaffScheduleSlotSelection) => void;
    onTimeSelectionError?: (message: string) => void;
}

const ROLE_PALETTE: Record<string, { bg: string; border: string; text: string }> = {
    MANAGER: { bg: '#edf3ff', border: '#2f63ff', text: '#234ed9' },
    CASHIER: { bg: '#e9fbf1', border: '#17b26a', text: '#0f8c52' },
    FLOOR: { bg: '#fff4e2', border: '#f59e0b', text: '#cc7f06' },
    SERVER: { bg: '#f2ebff', border: '#8b5cf6', text: '#7041e1' },
    KITCHEN: { bg: '#ffedf1', border: '#e74867', text: '#cb3653' },
    DEFAULT: { bg: '#f3f6ff', border: '#6f80a4', text: '#4c5f85' },
};

function toneForCoverage(count: number): CoverageTone {
    if (count < 2) return 'critical';
    if (count < 3) return 'risk';
    return 'healthy';
}

function isCoverageShift(event: StaffScheduleEvent): boolean {
    return !event.extendedProps.kind || event.extendedProps.kind === 'shift';
}

function countCoverageAt(date: Date, events: StaffScheduleEvent[], timeZone: string): number {
    let count = 0;
    for (const event of events) {
        if (!isCoverageShift(event)) continue;
        const start = instantToWallClockDate(event.start, timeZone);
        const end = instantToWallClockDate(event.end, timeZone);
        if (date >= start && date < end) count += 1;
    }
    return count;
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

export function StaffScheduler({ resources, events, viewMode, initialDate, timeZone, compactWindow = true, onEventChange, onEventSelect, onEventDelete, onSlotSelect, onTimeSelectionError }: StaffSchedulerProps) {
    const [drag, setDrag] = useState<DragState | null>(null);
    const [dragDeltaHours, setDragDeltaHours] = useState(0);
    const [shiftAction, setShiftAction] = useState<ShiftActionState | null>(null);
    const [pendingDeleteEventId, setPendingDeleteEventId] = useState<string | null>(null);
    const timelineScrollRef = useRef<HTMLDivElement | null>(null);
    const resourceListRef = useRef<HTMLDivElement | null>(null);
    const suppressShiftClickRef = useRef(false);
    const [viewportWidth, setViewportWidth] = useState(0);

    const dayCount = viewMode === 'day' ? 1 : viewMode === 'threeDay' ? 3 : 7;
    const minHour = compactWindow ? 9 : 0;
    const maxHour = compactWindow ? 22 : 24;
    const hoursPerDay = maxHour - minHour;

    const rangeStart = useMemo(() => {
        const d = initialDate ? new Date(`${initialDate}T00:00:00`) : new Date();
        d.setHours(0, 0, 0, 0);
        return d;
    }, [initialDate]);

    const dayStarts = useMemo(() => {
        return Array.from({ length: dayCount }, (_, i) => {
            const d = new Date(rangeStart);
            d.setDate(d.getDate() + i);
            return d;
        });
    }, [dayCount, rangeStart]);

    const totalHours = dayCount * hoursPerDay;
    const {
        hourWidth,
        timelineWidth,
        allowsHorizontalScroll,
    } = resolveSchedulerTimelineLayout(viewMode, viewportWidth, totalHours);
    const labelEvery = viewMode === 'week' ? 3 : hourWidth < 22 ? 3 : 2;

    useEffect(() => {
        if (!timelineScrollRef.current) return;
        const node = timelineScrollRef.current;
        const update = () => setViewportWidth(node.clientWidth);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    const currentLabel = useMemo(() => {
        const start = dayStarts[0];
        const end = dayStarts[dayStarts.length - 1];
        return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }, [dayStarts]);

    const coverageDays = useMemo(() => {
        return dayStarts.map((day) => {
            const bins: CoverageTone[] = [];
            for (let hour = minHour; hour < maxHour; hour += 1) {
                const t = new Date(day);
                t.setHours(hour, 0, 0, 0);
                bins.push(toneForCoverage(countCoverageAt(t, events, timeZone)));
            }
            return {
                label: day.toLocaleDateString('en-US', { weekday: 'short' }),
                bins,
            };
        });
    }, [dayStarts, events, maxHour, minHour, timeZone]);

    const { positionedShifts, breakMarkersByShift } = useMemo(() => {
        const shifts = events
            .filter((event) => !event.extendedProps.kind)
            .flatMap((event) => {
                const eventStart = instantToWallClockDate(event.start, timeZone);
                const eventEnd = instantToWallClockDate(event.end, timeZone);
                return projectIntervalIntoDailyWindows(eventStart, eventEnd, dayStarts, minHour, maxHour)
                    .map((segment) => ({
                        ...event,
                        segmentKey: `${event.id}:${segment.dayIndex}`,
                        left: segment.leftHours * hourWidth,
                        width: Math.max(26, Math.max(0.25, segment.durationHours) * hourWidth - 2),
                        shiftStart: eventStart,
                        shiftEnd: eventEnd,
                        segmentStart: segment.segmentStart,
                        segmentEnd: segment.segmentEnd,
                    }));
            });

        const breaks = events.filter((event) => event.extendedProps.kind === 'break' || event.extendedProps.kind === 'lunch');
        const markers = new Map<string, Array<{ leftPct: number; widthPct: number; kind: 'lunch' | 'break'; conflict?: string }>>();

        for (const breakEvent of breaks) {
            const breakStart = instantToWallClockDate(breakEvent.start, timeZone);
            const breakEnd = instantToWallClockDate(breakEvent.end, timeZone);
            const owners = shifts.filter(
                (shift) =>
                    shift.resourceId === breakEvent.resourceId &&
                    breakStart >= shift.shiftStart &&
                    breakEnd <= shift.shiftEnd &&
                    breakEnd > shift.segmentStart &&
                    breakStart < shift.segmentEnd
            );
            for (const owner of owners) {
                const markerStart = breakStart > owner.segmentStart ? breakStart : owner.segmentStart;
                const markerEnd = breakEnd < owner.segmentEnd ? breakEnd : owner.segmentEnd;
                const segmentDurationMs = Math.max(1, owner.segmentEnd.getTime() - owner.segmentStart.getTime());
                const leftPct = ((markerStart.getTime() - owner.segmentStart.getTime()) / segmentDurationMs) * 100;
                const widthPct = Math.max(6, ((markerEnd.getTime() - markerStart.getTime()) / segmentDurationMs) * 100);
                const existing = markers.get(owner.segmentKey) ?? [];
                existing.push({
                    leftPct: clamp(leftPct, 0, 94),
                    widthPct: clamp(widthPct, 6, 100),
                    kind: breakEvent.extendedProps.kind as 'lunch' | 'break',
                    conflict: breakEvent.extendedProps.conflict,
                });
                markers.set(owner.segmentKey, existing);
            }
        }

        return { positionedShifts: shifts, breakMarkersByShift: markers };
    }, [dayStarts, events, hourWidth, maxHour, minHour, timeZone]);
    const dragHint = useMemo(() => {
        if (!drag) return 'Drag horizontally to change time, drag vertically to reassign, or click a shift to edit.';
        if (dragDeltaHours === 0) return 'Release on a staff row to reassign without changing time.';
        const minutes = Math.round(Math.abs(dragDeltaHours) * 60);
        const duration = minutes < 60
            ? `${minutes} minutes`
            : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
        return `Release to save ${duration} ${dragDeltaHours > 0 ? 'later' : 'earlier'}.`;
    }, [drag, dragDeltaHours]);

    const handleDragStart = (e: React.PointerEvent<HTMLButtonElement>, event: StaffScheduleEvent) => {
        if (event.extendedProps.kind || !onEventChange || e.button !== 0) return;
        const originalStart = instantToWallClockDate(event.start, timeZone);
        const originalEnd = instantToWallClockDate(event.end, timeZone);
        e.currentTarget.setPointerCapture(e.pointerId);
        setShiftAction(null);
        setPendingDeleteEventId(null);
        suppressShiftClickRef.current = false;
        setDrag({ eventId: event.id, startX: e.clientX, startY: e.clientY, currentY: e.clientY, originalStart, originalEnd });
        setDragDeltaHours(0);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!drag) return;
        const deltaPx = e.clientX - drag.startX;
        const deltaY = e.clientY - drag.startY;
        const deltaHours = Math.round((deltaPx / hourWidth) * 4) / 4;
        if (deltaHours !== 0 || Math.abs(deltaY) > 4) suppressShiftClickRef.current = true;
        setDrag((current) => (current ? { ...current, currentY: e.clientY } : current));
        setDragDeltaHours(deltaHours);
    };

    const findResourceIdAtPoint = (clientX: number, clientY: number): string | null => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-resource-id]'));
        const row = rows.find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return clientY >= rect.top && clientY <= rect.bottom && clientX >= rect.left && clientX <= rect.right;
        });
        return row?.dataset.resourceId ?? null;
    };

    const handlePointerUp = (e?: React.PointerEvent) => {
        if (!drag) return;

        let newResourceId: string | null = null;
        if (e) {
            newResourceId = findResourceIdAtPoint(e.clientX, e.clientY);
        }

        if (dragDeltaHours !== 0) {
            const originalOffset = timelineOffsetForDate(drag.originalStart, dayStarts, minHour, maxHour);
            const newStart = originalOffset === null
                ? new Date(drag.originalStart.getTime() + dragDeltaHours * 3600000)
                : dateForTimelineOffset(originalOffset + dragDeltaHours, dayStarts, minHour, maxHour);
            const deltaMs = newStart.getTime() - drag.originalStart.getTime();
            const newEnd = new Date(drag.originalEnd.getTime() + deltaMs);
            const event = events.find((ev) => ev.id === drag.eventId);
            if (event) {
                try {
                    const startIso = wallClockDateToIso(newStart, timeZone);
                    const endIso = wallClockDateToIso(newEnd, timeZone);
                    onEventChange?.(event.id, startIso, endIso, newResourceId ?? event.resourceId);
                } catch (error) {
                    onTimeSelectionError?.((error as Error).message);
                }
            }
        } else if (newResourceId) {
            const event = events.find((ev) => ev.id === drag.eventId);
            if (event && newResourceId !== event.resourceId) {
                onEventChange?.(event.id, event.start, event.end, newResourceId);
            }
        }

        setDrag(null);
        setDragDeltaHours(0);
    };

    const cancelDrag = () => {
        if (!drag) return;
        suppressShiftClickRef.current = true;
        setDrag(null);
        setDragDeltaHours(0);
    };

    const handleShiftClick = (e: React.MouseEvent, event: StaffScheduleEvent) => {
        e.stopPropagation();
        if (dragDeltaHours !== 0 || suppressShiftClickRef.current) {
            suppressShiftClickRef.current = false;
            return;
        }
        if (onEventSelect) {
            setShiftAction(null);
            setPendingDeleteEventId(null);
            onEventSelect(event);
            return;
        }
        const rowRect = e.currentTarget.closest('.timeline-row')?.getBoundingClientRect();
        const buttonRect = e.currentTarget.getBoundingClientRect();
        const rowWidth = rowRect?.width ?? timelineWidth;
        setPendingDeleteEventId(null);
        setShiftAction({
            event,
            left: clamp(buttonRect.left - (rowRect?.left ?? 0), 8, Math.max(8, rowWidth - 190)),
            top: buttonRect.bottom - (rowRect?.top ?? 0) + 6,
        });
    };

    const handleTimelineScroll = () => {
        if (!timelineScrollRef.current || !resourceListRef.current) return;
        resourceListRef.current.scrollTop = timelineScrollRef.current.scrollTop;
    };

    const handleSlotClick = (e: React.MouseEvent<HTMLDivElement>, resourceId: string) => {
        if (!onSlotSelect || drag || e.defaultPrevented) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const relativeX = clamp(e.clientX - rect.left, 0, timelineWidth - 1);
        const hourOffset = Math.floor(relativeX / hourWidth);
        const start = dateForTimelineOffset(hourOffset, dayStarts, minHour, maxHour);
        const dayIndex = Math.min(dayStarts.length - 1, Math.floor(hourOffset / hoursPerDay));
        const dayStart = new Date(dayStarts[dayIndex]);
        dayStart.setHours(minHour, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setHours(maxHour, 0, 0, 0);
        const end = new Date(start);
        end.setHours(end.getHours() + 8);
        if (end > dayEnd) end.setTime(dayEnd.getTime());
        if (end <= start) end.setHours(start.getHours() + 1);
        setShiftAction(null);
        setPendingDeleteEventId(null);
        try {
            const startIso = wallClockDateToIso(start, timeZone);
            const endIso = wallClockDateToIso(end, timeZone);
            onSlotSelect({ resourceId, start: startIso, end: endIso });
        } catch (error) {
            onTimeSelectionError?.((error as Error).message);
        }
    };

    const formatActionTime = (dateIso: string) =>
        formatTimeInTimeZone(dateIso, timeZone);

    return (
        <div className="scheduler-root" onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={cancelDrag}>
            <div className="scheduler-status">
                <span id="scheduler-timeline-instructions">{dragHint}</span>
                <span>{currentLabel}</span>
            </div>

            <div className="coverage-strip">
                {coverageDays.map((day) => (
                    <div key={day.label} className="coverage-day">
                        <span className="coverage-label">{day.label}</span>
                        <div className="coverage-bins" style={{ gridTemplateColumns: `repeat(${hoursPerDay}, minmax(0, 1fr))` }}>
                            {day.bins.map((tone, idx) => (
                                <span key={`${day.label}-${idx}`} className={`coverage-bin coverage-bin-${tone}`} />
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            <div className="timeline-workspace">
                <div className="resource-column" role="region" aria-label="Team members">
                    <div className="resource-column-header">Team</div>
                    <div className="resource-list" ref={resourceListRef} role="list" aria-label="Scheduled team members">
                        {resources.map((r) => (
                            <div key={r.id} className="resource-row-name" role="listitem" aria-label={r.title + ', ' + r.role}>
                                <div className="avatar" style={{ background: `hsl(${r.hue}, 92%, 96%)`, borderColor: `hsl(${r.hue}, 72%, 78%)`, color: '#1f2d49' }}>
                                    {r.avatarInitials}
                                </div>
                                <div>
                                    <div className="resource-name">{r.title}</div>
                                    <div className="resource-role">{r.role}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div
                    className="timeline-scroll"
                    ref={timelineScrollRef}
                    role="region"
                    aria-label={currentLabel + ' staff schedule timeline'}
                    aria-describedby="scheduler-timeline-instructions"
                    tabIndex={0}
                    onScroll={handleTimelineScroll}
                    style={{ overflowX: allowsHorizontalScroll ? 'auto' : 'hidden' }}
                >
                    <div className="timeline-canvas" style={{ width: timelineWidth }}>
                        <div className="timeline-header sticky">
                            {dayStarts.map((day, dayIdx) => (
                                <div key={dayIdx} className="day-header" style={{ left: dayIdx * hoursPerDay * hourWidth, width: hoursPerDay * hourWidth }}>
                                    {day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                                </div>
                            ))}

                            {Array.from({ length: totalHours }, (_, i) => {
                                const hour = (minHour + (i % hoursPerDay)) % 24;
                                return (
                                    <div key={`h-${i}`} className="hour-label" style={{ left: i * hourWidth, width: hourWidth }}>
                                        {i % labelEvery === 0 ? `${hour}:00` : ''}
                                    </div>
                                );
                            })}
                        </div>

                        <div className="timeline-body" role="list" aria-label="Staff schedule rows">
                            {resources.map((resource) => {
                                const resourceEvents = positionedShifts.filter((e) => e.resourceId === resource.id);
                                return (
                                    <div
                                        key={resource.id}
                                        className="timeline-row"
                                        data-resource-id={resource.id}
                                        data-resource-title={resource.title}
                                        role="listitem"
                                        aria-label={resource.title + ', ' + resource.role + ', schedule timeline'}
                                        onClick={(ev) => handleSlotClick(ev, resource.id)}
                                    >
                                        <div
                                            className="timeline-grid"
                                            style={{
                                                backgroundSize: `${hourWidth}px 100%`,
                                                backgroundImage:
                                                    'repeating-linear-gradient(to right, #dce4f1 0, #dce4f1 1px, transparent 1px, transparent 100%)',
                                            }}
                                        />

                                        {Array.from({ length: dayCount - 1 }, (_, i) => (
                                            <div key={`sep-${resource.id}-${i}`} className="day-separator" style={{ left: (i + 1) * hoursPerDay * hourWidth }} />
                                        ))}

                                        {resourceEvents.map((event) => {
                                            const colors = ROLE_PALETTE[event.extendedProps.role] ?? ROLE_PALETTE.DEFAULT;
                                            const start = formatTimeInTimeZone(event.start, timeZone, false);
                                            const end = formatTimeInTimeZone(event.end, timeZone, false);
                                            const isDragged = drag?.eventId === event.id;
                                            const offsetPx = isDragged ? dragDeltaHours * hourWidth : 0;
                                            const offsetY = isDragged ? drag.currentY - drag.startY : 0;
                                            const left = clamp(event.left + offsetPx, 0, Math.max(0, timelineWidth - event.width));

                                            return (
                                                <button
                                                    key={event.segmentKey}
                                                    type="button"
                                                    onPointerDown={(ev) => handleDragStart(ev, event)}
                                                    onClick={(ev) => handleShiftClick(ev, event)}
                                                    className="shift-block"
                                                    aria-label={`Edit ${event.title} shift, ${start} to ${end}`}
                                                    title={`${event.title}, ${start} to ${end}. Click to edit or drag to move.`}
                                                    style={{
                                                        left,
                                                        width: event.width,
                                                        background: colors.bg,
                                                        borderLeftColor: colors.border,
                                                        color: colors.text,
                                                        opacity: isDragged ? 0.8 : 1,
                                                        transform: isDragged ? `translateY(${offsetY}px)` : undefined,
                                                        zIndex: isDragged ? 7 : undefined,
                                                    }}
                                                >
                                                    <span className="shift-time">{`${start}-${end}`}</span>
                                                    {viewMode !== 'week' ? <span className="shift-role">{event.extendedProps.role}</span> : null}
                                                    {breakMarkersByShift.get(event.segmentKey)?.length ? (
                                                        <div className="shift-markers" aria-hidden="true">
                                                            {breakMarkersByShift.get(event.segmentKey)?.map((marker, i) => (
                                                                <span
                                                                    key={`${event.segmentKey}-marker-${i}`}
                                                                    className={`shift-marker ${marker.kind === 'lunch' ? 'shift-marker-lunch' : 'shift-marker-break'} ${marker.conflict ? 'shift-marker-conflict' : ''}`}
                                                                    style={{ left: `${marker.leftPct}%`, width: `${marker.widthPct}%` }}
                                                                >
                                                                    {marker.kind === 'lunch' ? 'M' : 'B'}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    ) : null}
                                                </button>
                                            );
                                        })}
                                        {shiftAction && shiftAction.event.resourceId === resource.id ? (
                                            <div className="shift-action-popover" style={{ left: shiftAction.left, top: shiftAction.top }} onClick={(ev) => ev.stopPropagation()}>
                                                <div>
                                                    <strong>{shiftAction.event.title}</strong>
                                                    <span>{formatActionTime(shiftAction.event.start)} - {formatActionTime(shiftAction.event.end)}</span>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        onEventSelect?.(shiftAction.event);
                                                        setShiftAction(null);
                                                        setPendingDeleteEventId(null);
                                                    }}
                                                >
                                                    Edit shift
                                                </button>
                                                {onEventDelete ? (
                                                    <button
                                                        type="button"
                                                        className="shift-action-delete"
                                                        onClick={() => {
                                                            if (pendingDeleteEventId === shiftAction.event.id) {
                                                                onEventDelete(shiftAction.event);
                                                                setShiftAction(null);
                                                                setPendingDeleteEventId(null);
                                                                return;
                                                            }
                                                            setPendingDeleteEventId(shiftAction.event.id);
                                                        }}
                                                        onBlur={() => {
                                                            window.setTimeout(() => setPendingDeleteEventId((current) => (current === shiftAction.event.id ? null : current)), 120);
                                                        }}
                                                    >
                                                        {pendingDeleteEventId === shiftAction.event.id ? 'Confirm delete' : 'Delete'}
                                                    </button>
                                                ) : null}
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setShiftAction(null);
                                                        setPendingDeleteEventId(null);
                                                    }}
                                                >
                                                    Close
                                                </button>
                                            </div>
                                        ) : null}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>

            <style jsx>{`
                .scheduler-root {
                    height: 100%;
                    min-height: 0;
                    display: flex;
                    flex-direction: column;
                    gap: 0.35rem;
                }

                .scheduler-status {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 0.75rem;
                    padding: 0 0.35rem;
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    font-weight: 600;
                }

                .coverage-strip {
                    display: grid;
                    grid-template-columns: repeat(${dayCount}, minmax(0, 1fr));
                    gap: 8px;
                    padding: 0 0.35rem 0.35rem;
                }

                .coverage-day {
                    min-width: 0;
                }

                .coverage-label {
                    display: block;
                    font-size: 0.62rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    color: #637499;
                    margin-bottom: 3px;
                    letter-spacing: 0;
                }

                .coverage-bins {
                    display: grid;
                    gap: 1px;
                }

                .coverage-bin {
                    height: 4px;
                    border-radius: 2px;
                }

                .coverage-bin-healthy { background: #22b067; }
                .coverage-bin-risk { background: #f59e0b; }
                .coverage-bin-critical { background: #e74867; }

                .timeline-workspace {
                    flex: 1;
                    min-height: 0;
                    display: grid;
                    grid-template-columns: 180px minmax(0, 1fr);
                    border: 1px solid #dce4f1;
                    border-radius: 10px;
                    overflow: hidden;
                    background: #fff;
                }

                .resource-column {
                    min-height: 0;
                    display: flex;
                    flex-direction: column;
                    border-right: 1px solid #dce4f1;
                    background: #f7f9ff;
                }

                .resource-column-header {
                    position: sticky;
                    top: 0;
                    z-index: 3;
                    height: 46px;
                    display: flex;
                    align-items: center;
                    padding: 0 10px;
                    font-size: 0.72rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0;
                    color: #526381;
                    border-bottom: 1px solid #dce4f1;
                    background: #f7f9ff;
                }

                .resource-list {
                    flex: 1;
                    min-height: 0;
                    overflow: hidden;
                }

                .resource-row-name {
                    height: 42px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 0 10px;
                    border-bottom: 1px solid #e6ecf7;
                }

                .avatar {
                    width: 26px;
                    height: 26px;
                    border-radius: 50%;
                    border: 1px solid;
                    display: grid;
                    place-items: center;
                    font-size: 0.56rem;
                    font-weight: 700;
                }

                .resource-name {
                    font-size: 0.73rem;
                    font-weight: 700;
                    line-height: 1.1;
                    color: #1f2d49;
                }

                .resource-role {
                    font-size: 0.56rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0;
                    color: #526381;
                }

                .timeline-scroll {
                    overflow: auto;
                    height: 100%;
                    min-width: 0;
                    min-height: 0;
                    overscroll-behavior: contain;
                }

                .timeline-canvas {
                    position: relative;
                    min-height: 100%;
                }

                .timeline-header {
                    position: sticky;
                    top: 0;
                    z-index: 4;
                    height: 46px;
                    border-bottom: 1px solid #dce4f1;
                    background: #f9fbff;
                }

                .day-header {
                    position: absolute;
                    top: 0;
                    height: 22px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.68rem;
                    font-weight: 700;
                    color: #3f5278;
                    border-right: 1px solid #dce4f1;
                }

                .hour-label {
                    position: absolute;
                    top: 22px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.58rem;
                    color: #526381;
                    border-right: 1px solid #eef2fb;
                }

                .timeline-body {
                    position: relative;
                }

                .timeline-row {
                    position: relative;
                    height: 42px;
                    border-bottom: 1px solid #e6ecf7;
                    background: #fff;
                    cursor: crosshair;
                }

                .timeline-grid {
                    position: absolute;
                    inset: 0;
                }

                .day-separator {
                    position: absolute;
                    top: 0;
                    bottom: 0;
                    width: 1px;
                    background: #cfd9ec;
                }

                .shift-block {
                    position: absolute;
                    top: 4px;
                    bottom: 4px;
                    border: none;
                    border-left: 3px solid;
                    border-radius: 4px;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: flex-start;
                    gap: 1px;
                    padding: 0 6px;
                    text-align: left;
                    cursor: grab;
                    touch-action: none;
                    user-select: none;
                    overflow: hidden;
                }

                .shift-action-popover {
                    position: absolute;
                    z-index: 8;
                    width: 180px;
                    border: 1px solid #cfd9ec;
                    border-radius: 8px;
                    background: #fff;
                    box-shadow: 0 14px 34px rgba(31, 45, 73, 0.16);
                    padding: 8px;
                    display: grid;
                    gap: 6px;
                    cursor: default;
                }

                .shift-action-popover div {
                    display: grid;
                    gap: 2px;
                    padding: 2px 2px 4px;
                }

                .shift-action-popover strong {
                    font-size: 0.76rem;
                    line-height: 1.2;
                    color: #1f2d49;
                }

                .shift-action-popover span {
                    font-size: 0.68rem;
                    color: #526381;
                    font-weight: 700;
                }

                .shift-action-popover button {
                    height: 30px;
                    border: 1px solid #dce4f1;
                    border-radius: 6px;
                    background: #f9fbff;
                    color: #1f2d49;
                    font-size: 0.72rem;
                    font-weight: 800;
                    cursor: pointer;
                }

                .shift-action-popover button:first-of-type {
                    background: #eef4ff;
                    border-color: #b8c9ff;
                    color: #234ed9;
                }

                .shift-action-popover .shift-action-delete {
                    border-color: #fecdd3;
                    background: #fff1f2;
                    color: #be123c;
                }

                .shift-action-popover .shift-action-delete:hover {
                    background: #ffe4e6;
                    border-color: #fda4af;
                }

                .shift-block:active {
                    cursor: grabbing;
                }

                .shift-time {
                    font-size: 0.63rem;
                    font-weight: 700;
                    white-space: nowrap;
                }

                .shift-role {
                    font-size: 0.54rem;
                    text-transform: uppercase;
                    letter-spacing: 0;
                    opacity: 0.85;
                    white-space: nowrap;
                }

                .shift-markers {
                    position: absolute;
                    left: 4px;
                    right: 4px;
                    bottom: 2px;
                    height: 8px;
                    pointer-events: none;
                }

                .shift-marker {
                    position: absolute;
                    height: 8px;
                    border-radius: 999px;
                    font-size: 0.46rem;
                    font-weight: 800;
                    line-height: 8px;
                    text-align: center;
                    color: #244362;
                    background: #b9d5ff;
                    border: 1px solid #86a9da;
                }

                .shift-marker-break {
                    background: #cfeef9;
                    border-color: #96d0e3;
                }

                .shift-marker-lunch {
                    background: #e5f5d9;
                    border-color: #b3d295;
                }

                .shift-marker-conflict {
                    background: #ffe7ea;
                    border-color: #ef8a98;
                    color: #8f2e3b;
                }

                @media (max-width: 700px) {
                    .timeline-workspace {
                        grid-template-columns: 112px minmax(0, 1fr);
                    }

                    .resource-column-header,
                    .resource-row-name {
                        padding-left: 6px;
                        padding-right: 6px;
                    }

                    .resource-row-name {
                        gap: 6px;
                    }

                    .avatar {
                        width: 24px;
                        height: 24px;
                        flex: 0 0 24px;
                    }

                    .resource-name,
                    .resource-role {
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                    }
                }
            `}</style>
        </div>
    );
}
