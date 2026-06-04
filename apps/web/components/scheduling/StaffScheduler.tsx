'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

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

export type SchedulerViewMode = 'day' | 'threeDay' | 'week';

type CoverageTone = 'healthy' | 'risk' | 'critical';

type DragState = {
    eventId: string;
    startX: number;
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
    compactWindow?: boolean;
    onEventChange?: (eventId: string, newStart: string, newEnd: string, newResourceId: string) => void;
    onEventSelect?: (event: StaffScheduleEvent) => void;
    onSlotSelect?: (slot: StaffScheduleSlotSelection) => void;
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

function countCoverageAt(date: Date, events: StaffScheduleEvent[]): number {
    let count = 0;
    for (const event of events) {
        if (!isCoverageShift(event)) continue;
        const start = new Date(event.start);
        const end = new Date(event.end);
        if (date >= start && date < end) count += 1;
    }
    return count;
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

export function StaffScheduler({ resources, events, viewMode, initialDate, compactWindow = true, onEventChange, onEventSelect, onSlotSelect }: StaffSchedulerProps) {
    const [drag, setDrag] = useState<DragState | null>(null);
    const [dragDeltaHours, setDragDeltaHours] = useState(0);
    const [shiftAction, setShiftAction] = useState<ShiftActionState | null>(null);
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

    const timelineStart = useMemo(() => {
        const d = new Date(rangeStart);
        d.setHours(minHour, 0, 0, 0);
        return d;
    }, [minHour, rangeStart]);

    const totalHours = dayCount * hoursPerDay;
    const fitViewport = viewMode !== 'week' && viewportWidth > 0;
    const hourWidth = fitViewport ? viewportWidth / totalHours : viewMode === 'day' ? 70 : viewMode === 'threeDay' ? 48 : 24;
    const timelineWidth = fitViewport ? viewportWidth : totalHours * hourWidth;
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
                bins.push(toneForCoverage(countCoverageAt(t, events)));
            }
            return {
                label: day.toLocaleDateString('en-US', { weekday: 'short' }),
                bins,
            };
        });
    }, [dayStarts, events, maxHour, minHour]);

    const { positionedShifts, breakMarkersByShift } = useMemo(() => {
        const endOfRange = new Date(timelineStart);
        endOfRange.setHours(endOfRange.getHours() + totalHours);

        const visible = events
            .filter((event) => {
                const start = new Date(event.start);
                const end = new Date(event.end);
                return end > timelineStart && start < endOfRange;
            });

        const shifts = visible
            .filter((event) => !event.extendedProps.kind)
            .map((event) => {
                const eventStart = new Date(event.start);
                const eventEnd = new Date(event.end);

                const clampedStart = eventStart < timelineStart ? timelineStart : eventStart;
                const clampedEnd = eventEnd > endOfRange ? endOfRange : eventEnd;

                const hoursFromStart = (clampedStart.getTime() - timelineStart.getTime()) / 3600000;
                const durationHours = Math.max(0.25, (clampedEnd.getTime() - clampedStart.getTime()) / 3600000);

                const left = hoursFromStart * hourWidth;
                const width = Math.max(26, durationHours * hourWidth - 2);

                return {
                    ...event,
                    left,
                    width,
                    shiftStart: eventStart,
                    shiftEnd: eventEnd,
                };
            });

        const breaks = visible.filter((event) => event.extendedProps.kind === 'break' || event.extendedProps.kind === 'lunch');
        const markers = new Map<string, Array<{ leftPct: number; widthPct: number; kind: 'lunch' | 'break'; conflict?: string }>>();

        for (const breakEvent of breaks) {
            const breakStart = new Date(breakEvent.start);
            const breakEnd = new Date(breakEvent.end);
            const owner = shifts.find(
                (shift) =>
                    shift.resourceId === breakEvent.resourceId &&
                    breakStart >= shift.shiftStart &&
                    breakEnd <= shift.shiftEnd
            );
            if (!owner) continue;

            const shiftDurationMs = Math.max(1, owner.shiftEnd.getTime() - owner.shiftStart.getTime());
            const leftPct = ((breakStart.getTime() - owner.shiftStart.getTime()) / shiftDurationMs) * 100;
            const widthPct = Math.max(6, ((breakEnd.getTime() - breakStart.getTime()) / shiftDurationMs) * 100);
            const existing = markers.get(owner.id) ?? [];
            existing.push({
                leftPct: clamp(leftPct, 0, 94),
                widthPct: clamp(widthPct, 6, 100),
                kind: breakEvent.extendedProps.kind as 'lunch' | 'break',
                conflict: breakEvent.extendedProps.conflict,
            });
            markers.set(owner.id, existing);
        }

        return { positionedShifts: shifts, breakMarkersByShift: markers };
    }, [events, hourWidth, timelineStart, totalHours]);

    const dragHint = useMemo(() => {
        if (!drag) return 'Drag shifts to reassign. Live risk feedback updates while dragging.';
        if (dragDeltaHours === 0) return 'Shift anchored';
        return dragDeltaHours > 0 ? 'Moving later may improve dinner coverage' : 'Moving earlier may improve lunch coverage';
    }, [drag, dragDeltaHours]);

    const handleDragStart = (e: React.MouseEvent, event: StaffScheduleEvent) => {
        if (event.extendedProps.kind) return;
        const originalStart = new Date(event.start);
        const originalEnd = new Date(event.end);
        setShiftAction(null);
        suppressShiftClickRef.current = false;
        setDrag({ eventId: event.id, startX: e.clientX, originalStart, originalEnd });
        setDragDeltaHours(0);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!drag) return;
        const deltaPx = e.clientX - drag.startX;
        const deltaHours = Math.round(deltaPx / hourWidth);
        if (deltaHours !== 0) suppressShiftClickRef.current = true;
        setDragDeltaHours(deltaHours);
    };

    const handleMouseUp = () => {
        if (!drag) return;

        if (dragDeltaHours !== 0) {
            const newStart = new Date(drag.originalStart);
            const newEnd = new Date(drag.originalEnd);
            newStart.setHours(newStart.getHours() + dragDeltaHours);
            newEnd.setHours(newEnd.getHours() + dragDeltaHours);
            const event = events.find((ev) => ev.id === drag.eventId);
            if (event) {
                onEventChange?.(event.id, newStart.toISOString(), newEnd.toISOString(), event.resourceId);
            }
        }

        setDrag(null);
        setDragDeltaHours(0);
    };

    const handleShiftClick = (e: React.MouseEvent, event: StaffScheduleEvent) => {
        e.stopPropagation();
        if (dragDeltaHours !== 0 || suppressShiftClickRef.current) {
            suppressShiftClickRef.current = false;
            return;
        }
        const rowRect = e.currentTarget.closest('.timeline-row')?.getBoundingClientRect();
        const buttonRect = e.currentTarget.getBoundingClientRect();
        const rowWidth = rowRect?.width ?? timelineWidth;
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
        const start = new Date(timelineStart);
        start.setHours(start.getHours() + hourOffset, 0, 0, 0);
        const dayStart = new Date(start);
        dayStart.setHours(minHour, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setHours(maxHour, 0, 0, 0);
        const end = new Date(start);
        end.setHours(end.getHours() + 8);
        if (end > dayEnd) end.setTime(dayEnd.getTime());
        if (end <= start) end.setHours(start.getHours() + 1);
        setShiftAction(null);
        onSlotSelect({ resourceId, start: start.toISOString(), end: end.toISOString() });
    };

    const formatActionTime = (dateIso: string) =>
        new Date(dateIso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

    return (
        <div className="scheduler-root" onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
            <div className="scheduler-status">
                <span>{dragHint}</span>
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
                <div className="resource-column">
                    <div className="resource-column-header">Team</div>
                    <div className="resource-list" ref={resourceListRef}>
                        {resources.map((r) => (
                            <div key={r.id} className="resource-row-name">
                                <div className="avatar" style={{ background: `hsl(${r.hue}, 92%, 96%)`, borderColor: `hsl(${r.hue}, 72%, 78%)`, color: `hsl(${r.hue}, 76%, 34%)` }}>
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
                    onScroll={handleTimelineScroll}
                    style={{ overflowX: viewMode === 'week' ? 'auto' : 'hidden' }}
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

                        <div className="timeline-body">
                            {resources.map((resource) => {
                                const resourceEvents = positionedShifts.filter((e) => e.resourceId === resource.id);
                                return (
                                    <div key={resource.id} className="timeline-row" onClick={(ev) => handleSlotClick(ev, resource.id)}>
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
                                            const start = new Date(event.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                                            const end = new Date(event.end).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                                            const isDragged = drag?.eventId === event.id;
                                            const offsetPx = isDragged ? dragDeltaHours * hourWidth : 0;
                                            const left = clamp(event.left + offsetPx, 0, Math.max(0, timelineWidth - event.width));

                                            return (
                                                <button
                                                    key={event.id}
                                                    type="button"
                                                    onMouseDown={(ev) => handleDragStart(ev, event)}
                                                    onClick={(ev) => handleShiftClick(ev, event)}
                                                    className="shift-block"
                                                    style={{
                                                        left,
                                                        width: event.width,
                                                        background: colors.bg,
                                                        borderLeftColor: colors.border,
                                                        color: colors.text,
                                                        opacity: isDragged ? 0.8 : 1,
                                                    }}
                                                >
                                                    <span className="shift-time">{`${start}-${end}`}</span>
                                                    {viewMode !== 'week' ? <span className="shift-role">{event.extendedProps.role}</span> : null}
                                                    {breakMarkersByShift.get(event.id)?.length ? (
                                                        <div className="shift-markers" aria-hidden="true">
                                                            {breakMarkersByShift.get(event.id)?.map((marker, i) => (
                                                                <span
                                                                    key={`${event.id}-marker-${i}`}
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
                                                    }}
                                                >
                                                    Edit shift
                                                </button>
                                                <button type="button" onClick={() => setShiftAction(null)}>Close</button>
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
                    letter-spacing: 0.05em;
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
                    letter-spacing: 0.05em;
                    color: #647595;
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
                    letter-spacing: 0.05em;
                    color: #6f80a4;
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
                    color: #7688ad;
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
                    color: #647595;
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
                    letter-spacing: 0.04em;
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
            `}</style>
        </div>
    );
}
