'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatTimeInTimeZone, instantToWallClockDate, wallClockDateToIso } from '@/lib/location-timezone';
import {
    dateForTimelineOffset,
    projectIntervalIntoDailyWindows,
    resolveSchedulerTimelineLayout,
    timelineOffsetForDate,
    type SchedulerTimelineViewMode,
} from './scheduler-projection';
import {
    SCHEDULER_TOUCH_ACTIVATION_DELAY_MS,
    resolveSchedulerDrop,
    schedulerBoardId,
    schedulerDeltaHours,
    schedulerDroppableId,
    schedulerPointerActivated,
    type SchedulerGestureMode,
} from './scheduler-gesture';

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
    extendedProps: {
        role: string;
        kind?: 'shift' | 'lunch' | 'break';
        conflict?: string;
        locked?: boolean;
        published?: boolean;
    };
}

export type SchedulerViewMode = SchedulerTimelineViewMode;

type CoverageTone = 'healthy' | 'risk' | 'critical';

type DragState = {
    event: StaffScheduleEvent;
    mode: SchedulerGestureMode;
    phase: 'pending' | 'active';
    pointerId: number;
    pointerType: string;
    handle: HTMLButtonElement;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    originalStart: Date;
    originalEnd: Date;
    targetResourceId: string | null;
    insideBoard: boolean;
};

type MoveDialogState = {
    event: StaffScheduleEvent;
    mode: SchedulerGestureMode;
    resourceId: string;
    offsetMinutes: string;
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
    onEventCopy?: (eventId: string, newStart: string, newEnd: string, newResourceId: string) => void;
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

export function StaffScheduler({ resources, events, viewMode, initialDate, timeZone, compactWindow = true, onEventChange, onEventCopy, onEventSelect, onEventDelete, onSlotSelect, onTimeSelectionError }: StaffSchedulerProps) {
    const reactBoardId = useId();
    const boardId = useMemo(() => schedulerBoardId(reactBoardId), [reactBoardId]);
    const [drag, setDrag] = useState<DragState | null>(null);
    const dragRef = useRef<DragState | null>(null);
    const touchActivationTimerRef = useRef<number | null>(null);
    const suppressHandleClickRef = useRef(false);
    const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);
    const [shiftAction, setShiftAction] = useState<ShiftActionState | null>(null);
    const [pendingDeleteEventId, setPendingDeleteEventId] = useState<string | null>(null);
    const schedulerRootRef = useRef<HTMLDivElement | null>(null);
    const timelineScrollRef = useRef<HTMLDivElement | null>(null);
    const resourceListRef = useRef<HTMLDivElement | null>(null);
    const resourceRowRefs = useRef(new Map<string, HTMLDivElement>());
    const shiftHandleRefs = useRef(new Map<string, HTMLButtonElement>());
    const moveDialogResourceRef = useRef<HTMLSelectElement | null>(null);
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
        const markers = new Map<string, Array<{
            leftPct: number;
            widthPct: number;
            kind: 'lunch' | 'break';
            conflict?: string;
            ariaLabel: string;
        }>>();

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
                    ariaLabel: `${breakEvent.extendedProps.kind === 'lunch' ? 'Meal' : 'Break'} ${formatTimeInTimeZone(breakEvent.start, timeZone, false)} to ${formatTimeInTimeZone(breakEvent.end, timeZone, false)}${breakEvent.extendedProps.conflict ? `, conflict: ${breakEvent.extendedProps.conflict}` : ''}`,
                });
                markers.set(owner.segmentKey, existing);
            }
        }

        return { positionedShifts: shifts, breakMarkersByShift: markers };
    }, [dayStarts, events, hourWidth, maxHour, minHour, timeZone]);
    const isEventLocked = (event: StaffScheduleEvent) =>
        Boolean(event.extendedProps.locked || event.extendedProps.published);

    const setCurrentDrag = (next: DragState | null) => {
        dragRef.current = next;
        setDrag(next);
    };

    const clearTouchActivationTimer = () => {
        if (touchActivationTimerRef.current === null) return;
        window.clearTimeout(touchActivationTimerRef.current);
        touchActivationTimerRef.current = null;
    };

    const releaseDragCapture = (current: DragState | null) => {
        if (!current) return;
        try {
            if (current.handle.hasPointerCapture(current.pointerId)) {
                current.handle.releasePointerCapture(current.pointerId);
            }
        } catch {
            // A detached handle has already lost capture; cancellation remains local and callback-free.
        }
    };

    const cancelDrag = (suppressHandleClick = true) => {
        const current = dragRef.current;
        if (!current) return;
        clearTouchActivationTimer();
        dragRef.current = null;
        setDrag(null);
        suppressHandleClickRef.current = suppressHandleClick;
        releaseDragCapture(current);
    };

    const findResourceIdAtPoint = (clientX: number, clientY: number): string | null => {
        for (const [resourceId, row] of resourceRowRefs.current) {
            const rect = row.getBoundingClientRect();
            if (clientY >= rect.top && clientY <= rect.bottom && clientX >= rect.left && clientX <= rect.right) {
                return resourceId;
            }
        }
        return null;
    };

    const resolveShiftedTimes = (event: StaffScheduleEvent, deltaHours: number) => {
        const originalStart = instantToWallClockDate(event.start, timeZone);
        const originalEnd = instantToWallClockDate(event.end, timeZone);
        if (deltaHours === 0) {
            return { start: originalStart, end: originalEnd, startIso: event.start, endIso: event.end };
        }
        const originalOffset = timelineOffsetForDate(originalStart, dayStarts, minHour, maxHour);
        if (originalOffset === null) return null;
        const nextOffset = originalOffset + deltaHours;
        if (nextOffset < 0 || nextOffset >= totalHours) return null;
        const start = dateForTimelineOffset(nextOffset, dayStarts, minHour, maxHour);
        const deltaMs = start.getTime() - originalStart.getTime();
        const end = new Date(originalEnd.getTime() + deltaMs);
        return {
            start,
            end,
            startIso: wallClockDateToIso(start, timeZone),
            endIso: wallClockDateToIso(end, timeZone),
        };
    };

    const buildDragPreview = (current: DragState) => {
        const deltaHours = schedulerDeltaHours(current.currentX - current.startX, hourWidth);
        const callbackAvailable = current.mode === 'copy' ? Boolean(onEventCopy) : Boolean(onEventChange);
        const decision = resolveSchedulerDrop({
            active: current.phase === 'active',
            insideBoard: current.insideBoard,
            locked: isEventLocked(current.event),
            callbackAvailable,
            sourceResourceId: current.event.resourceId,
            targetResourceId: current.targetResourceId,
            deltaHours,
        });
        const sourceTitle = resources.find((resource) => resource.id === current.event.resourceId)?.title ?? 'current staff member';
        const targetTitle = resources.find((resource) => resource.id === current.targetResourceId)?.title ?? 'outside the schedule';
        try {
            const shifted = resolveShiftedTimes(current.event, deltaHours);
            if (!shifted) {
                return {
                    decision: { kind: 'cancel', reason: 'outside-board' } as const,
                    deltaHours,
                    label: `Cannot ${current.mode} ${current.event.title}: the target time is outside this board.`,
                    shifted: null,
                    errorMessage: null,
                    sourceTitle,
                    targetTitle,
                };
            }
            const verb = current.mode === 'copy' ? 'Copy' : 'Move';
            const startLabel = `${String(shifted.start.getHours()).padStart(2, '0')}:${String(shifted.start.getMinutes()).padStart(2, '0')}`;
            const endLabel = `${String(shifted.end.getHours()).padStart(2, '0')}:${String(shifted.end.getMinutes()).padStart(2, '0')}`;
            const label = decision.kind === 'apply'
                ? `${verb} ${current.event.title} from ${sourceTitle} to ${targetTitle}, ${startLabel} to ${endLabel}.`
                : `Cannot ${current.mode} ${current.event.title} to ${targetTitle}, ${startLabel} to ${endLabel}.`;
            return { decision, deltaHours, label, shifted, errorMessage: null, sourceTitle, targetTitle };
        } catch (error) {
            const errorMessage = (error as Error).message;
            return {
                decision: { kind: 'cancel', reason: 'unavailable' } as const,
                deltaHours,
                label: `Cannot ${current.mode} ${current.event.title}: ${errorMessage}`,
                shifted: null,
                errorMessage,
                sourceTitle,
                targetTitle,
            };
        }
    };

    const dragPreview = drag?.phase === 'active' ? buildDragPreview(drag) : null;
    const dragHint = drag?.phase === 'active'
        ? dragPreview?.label ?? 'Release on a valid staff row or press Escape to cancel.'
        : drag?.pointerType === 'touch'
            ? 'Keep holding the move handle to start; release to cancel.'
            : 'Use a shift card for details. Use its move handle to drag, copy, or open keyboard controls.';

    const handleDragStart = (e: React.PointerEvent<HTMLButtonElement>, event: StaffScheduleEvent) => {
        const mode: SchedulerGestureMode = (e.shiftKey || e.altKey) && onEventCopy ? 'copy' : 'move';
        if (event.extendedProps.kind || isEventLocked(event) || (mode === 'copy' ? !onEventCopy : !onEventChange) || e.button !== 0) return;
        e.stopPropagation();
        setShiftAction(null);
        setPendingDeleteEventId(null);
        setMoveDialog(null);
        suppressHandleClickRef.current = false;
        const next: DragState = {
            event,
            mode,
            phase: 'pending',
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            handle: e.currentTarget,
            startX: e.clientX,
            startY: e.clientY,
            currentX: e.clientX,
            currentY: e.clientY,
            originalStart: instantToWallClockDate(event.start, timeZone),
            originalEnd: instantToWallClockDate(event.end, timeZone),
            targetResourceId: event.resourceId,
            insideBoard: true,
        };
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // Synthetic component tests may not establish a native active-pointer record.
        }
        setCurrentDrag(next);
        if (e.pointerType === 'touch') {
            touchActivationTimerRef.current = window.setTimeout(() => {
                const pending = dragRef.current;
                if (!pending || pending.pointerId !== e.pointerId || pending.phase !== 'pending') return;
                suppressHandleClickRef.current = true;
                setCurrentDrag({ ...pending, phase: 'active' });
            }, SCHEDULER_TOUCH_ACTIVATION_DELAY_MS);
        }
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const current = dragRef.current;
        if (!current || e.pointerId !== current.pointerId) return;
        const targetResourceId = findResourceIdAtPoint(e.clientX, e.clientY);
        const mode: SchedulerGestureMode = (e.shiftKey || e.altKey) && onEventCopy ? 'copy' : 'move';
        const movedEnough = schedulerPointerActivated(current.startX, current.startY, e.clientX, e.clientY);
        if (current.phase === 'pending' && current.pointerType === 'touch' && movedEnough) {
            cancelDrag(true);
            return;
        }
        const phase = current.phase === 'active' || movedEnough ? 'active' : 'pending';
        if (phase === 'active') {
            clearTouchActivationTimer();
            suppressHandleClickRef.current = true;
            e.preventDefault();
        }
        setCurrentDrag({
            ...current,
            mode,
            phase,
            currentX: e.clientX,
            currentY: e.clientY,
            targetResourceId,
            insideBoard: targetResourceId !== null,
        });
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        const current = dragRef.current;
        if (!current || e.pointerId !== current.pointerId) return;
        const targetResourceId = findResourceIdAtPoint(e.clientX, e.clientY);
        const completed: DragState = {
            ...current,
            currentX: e.clientX,
            currentY: e.clientY,
            targetResourceId,
            insideBoard: targetResourceId !== null,
        };
        if (completed.phase !== 'active') {
            cancelDrag(false);
            return;
        }
        const preview = buildDragPreview(completed);
        clearTouchActivationTimer();
        dragRef.current = null;
        setDrag(null);
        suppressHandleClickRef.current = true;
        releaseDragCapture(current);
        if (preview.decision.kind !== 'apply' || !preview.shifted) {
            if (preview.errorMessage) onTimeSelectionError?.(preview.errorMessage);
            return;
        }
        const applyChange = completed.mode === 'copy' ? onEventCopy : onEventChange;
        applyChange?.(
            completed.event.id,
            preview.shifted.startIso,
            preview.shifted.endIso,
            preview.decision.resourceId,
        );
    };

    useEffect(() => {
        if (!drag && !moveDialog) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (dragRef.current) cancelDrag(true);
            if (moveDialog) {
                const eventId = moveDialog.event.id;
                setMoveDialog(null);
                window.setTimeout(() => shiftHandleRefs.current.get(eventId)?.focus(), 0);
            }
        };
        const handleWindowBlur = () => cancelDrag(true);
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('blur', handleWindowBlur);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('blur', handleWindowBlur);
        };
    }, [drag, moveDialog]);

    useEffect(() => () => {
        clearTouchActivationTimer();
        dragRef.current = null;
    }, []);

    useEffect(() => {
        if (!moveDialog) return;
        moveDialogResourceRef.current?.focus();
    }, [moveDialog]);

    const openMoveDialog = (event: StaffScheduleEvent) => {
        if (isEventLocked(event) || !onEventChange) return;
        setShiftAction(null);
        setPendingDeleteEventId(null);
        setMoveDialog({ event, mode: 'move', resourceId: event.resourceId, offsetMinutes: '0' });
    };

    const closeMoveDialog = () => {
        const eventId = moveDialog?.event.id;
        setMoveDialog(null);
        window.setTimeout(() => {
            if (eventId) shiftHandleRefs.current.get(eventId)?.focus();
        }, 0);
    };

    const handleMoveDialogSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!moveDialog || isEventLocked(moveDialog.event)) return;
        const offsetMinutes = Number(moveDialog.offsetMinutes);
        if (!Number.isFinite(offsetMinutes) || offsetMinutes % 15 !== 0) return;
        const decision = resolveSchedulerDrop({
            active: true,
            insideBoard: resources.some((resource) => resource.id === moveDialog.resourceId),
            locked: false,
            callbackAvailable: moveDialog.mode === 'copy' ? Boolean(onEventCopy) : Boolean(onEventChange),
            sourceResourceId: moveDialog.event.resourceId,
            targetResourceId: moveDialog.resourceId,
            deltaHours: offsetMinutes / 60,
        });
        if (decision.kind !== 'apply') return;
        try {
            const shifted = resolveShiftedTimes(moveDialog.event, offsetMinutes / 60);
            if (!shifted) return;
            const applyChange = moveDialog.mode === 'copy' ? onEventCopy : onEventChange;
            applyChange?.(moveDialog.event.id, shifted.startIso, shifted.endIso, decision.resourceId);
            closeMoveDialog();
        } catch (error) {
            onTimeSelectionError?.((error as Error).message);
        }
    };

    const trapMoveDialogFocus = (event: React.KeyboardEvent<HTMLFormElement>) => {
        if (event.key !== 'Tab') return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), select:not([disabled]), input:not([disabled])',
        ));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const handleShiftClick = (e: React.MouseEvent, event: StaffScheduleEvent) => {
        e.stopPropagation();
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

    const draggedPositionedEvent = drag?.phase === 'active'
        ? positionedShifts.find((event) => event.id === drag.event.id)
        : null;
    const moveDialogOffsetMinutes = moveDialog ? Number(moveDialog.offsetMinutes) : 0;
    const moveDialogDecision = moveDialog
        ? resolveSchedulerDrop({
            active: true,
            insideBoard: resources.some((resource) => resource.id === moveDialog.resourceId),
            locked: isEventLocked(moveDialog.event),
            callbackAvailable: moveDialog.mode === 'copy' ? Boolean(onEventCopy) : Boolean(onEventChange),
            sourceResourceId: moveDialog.event.resourceId,
            targetResourceId: moveDialog.resourceId,
            deltaHours: moveDialogOffsetMinutes / 60,
        })
        : null;
    let moveDialogPreview = '';
    if (moveDialog && Number.isFinite(moveDialogOffsetMinutes) && moveDialogOffsetMinutes % 15 === 0) {
        try {
            const shifted = resolveShiftedTimes(moveDialog.event, moveDialogOffsetMinutes / 60);
            const person = resources.find((resource) => resource.id === moveDialog.resourceId)?.title ?? 'unknown staff member';
            if (shifted) {
                moveDialogPreview = `${moveDialog.mode === 'copy' ? 'Copy' : 'Move'} to ${person}, ${String(shifted.start.getHours()).padStart(2, '0')}:${String(shifted.start.getMinutes()).padStart(2, '0')} to ${String(shifted.end.getHours()).padStart(2, '0')}:${String(shifted.end.getMinutes()).padStart(2, '0')}.`;
            }
        } catch (error) {
            moveDialogPreview = (error as Error).message;
        }
    }

    return (
        <div
            id={boardId}
            ref={schedulerRootRef}
            className="scheduler-root"
            data-scheduler-board-id={boardId}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => cancelDrag(true)}
        >
            <div className="scheduler-status">
                <span id={`${boardId}-instructions`} role="status" aria-live="polite">{dragHint}</span>
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
                    aria-describedby={`${boardId}-instructions`}
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
                                        ref={(node) => {
                                            if (node) resourceRowRefs.current.set(resource.id, node);
                                            else resourceRowRefs.current.delete(resource.id);
                                        }}
                                        className={`timeline-row ${drag?.phase === 'active' && drag.targetResourceId === resource.id
                                            ? dragPreview?.decision.kind === 'apply'
                                                ? 'timeline-row--drop-valid'
                                                : 'timeline-row--drop-invalid'
                                            : ''}`}
                                        data-resource-id={resource.id}
                                        data-resource-title={resource.title}
                                        data-scheduler-droppable-id={schedulerDroppableId(boardId, resource.id)}
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
                                            const locked = isEventLocked(event);
                                            const isSourceGhost = drag?.phase === 'active' && drag.event.id === event.id;
                                            const canMove = !locked && Boolean(onEventChange);

                                            return (
                                                <div
                                                    key={event.segmentKey}
                                                    className={`shift-block ${isSourceGhost ? 'shift-block--source-ghost' : ''} ${locked ? 'shift-block--locked' : ''}`}
                                                    data-shift-event-id={event.id}
                                                    style={{
                                                        left: event.left,
                                                        width: event.width,
                                                        background: colors.bg,
                                                        borderLeftColor: colors.border,
                                                        color: colors.text,
                                                    }}
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={(ev) => handleShiftClick(ev, event)}
                                                        className="shift-details-button"
                                                        aria-label={`${locked ? 'View' : 'Edit'} ${event.title} shift, ${start} to ${end}${locked ? ', published' : ''}`}
                                                        title={`${event.title}, ${start} to ${end}. Click for ${locked ? 'published shift details' : 'details or editing'}.`}
                                                    >
                                                        <span className="shift-time">{`${start}-${end}`}</span>
                                                        {viewMode !== 'week' ? <span className="shift-role">{event.extendedProps.role}</span> : null}
                                                        {breakMarkersByShift.get(event.segmentKey)?.length ? (
                                                            <span className="shift-markers" role="list" aria-label="Shift breaks">
                                                                {breakMarkersByShift.get(event.segmentKey)?.map((marker, i) => (
                                                                    <span
                                                                        key={`${event.segmentKey}-marker-${i}`}
                                                                        role="listitem"
                                                                        aria-label={marker.ariaLabel}
                                                                        className={`shift-marker ${marker.kind === 'lunch' ? 'shift-marker-lunch' : 'shift-marker-break'} ${marker.conflict ? 'shift-marker-conflict' : ''}`}
                                                                        style={{ left: `${marker.leftPct}%`, width: `${marker.widthPct}%` }}
                                                                    >
                                                                        <span aria-hidden="true">{marker.kind === 'lunch' ? 'M' : 'B'}</span>
                                                                    </span>
                                                                ))}
                                                            </span>
                                                        ) : null}
                                                    </button>
                                                    <button
                                                        ref={(node) => {
                                                            if (node) shiftHandleRefs.current.set(event.id, node);
                                                        }}
                                                        type="button"
                                                        className="shift-drag-handle"
                                                        disabled={!canMove}
                                                        aria-label={locked
                                                            ? `${event.title} is published and cannot be moved`
                                                            : canMove
                                                                ? `Move or copy ${event.title}`
                                                                : `${event.title} cannot be moved`}
                                                        aria-describedby={`${boardId}-instructions`}
                                                        title={locked ? 'Published shift: open details to reopen it before moving.' : 'Drag to move. Shift- or Alt-drag to copy. Click or press Enter for keyboard controls.'}
                                                        onPointerDown={(ev) => handleDragStart(ev, event)}
                                                        onLostPointerCapture={() => cancelDrag(true)}
                                                        onBlur={() => {
                                                            if (dragRef.current?.event.id === event.id) cancelDrag(true);
                                                        }}
                                                        onKeyDown={(ev) => {
                                                            if (ev.key !== 'Enter' && ev.key !== ' ') return;
                                                            ev.preventDefault();
                                                            ev.stopPropagation();
                                                            openMoveDialog(event);
                                                        }}
                                                        onClick={(ev) => {
                                                            ev.preventDefault();
                                                            ev.stopPropagation();
                                                            if (suppressHandleClickRef.current) {
                                                                suppressHandleClickRef.current = false;
                                                                return;
                                                            }
                                                            openMoveDialog(event);
                                                        }}
                                                    >
                                                        <span aria-hidden="true">⠿</span>
                                                    </button>
                                                </div>
                                            );
                                        })}
                                        {drag?.phase === 'active'
                                            && draggedPositionedEvent
                                            && dragPreview?.shifted
                                            && drag.targetResourceId === resource.id ? (
                                                <div
                                                    className={`shift-drag-preview ${dragPreview.decision.kind === 'apply' ? 'shift-drag-preview--valid' : 'shift-drag-preview--invalid'}`}
                                                    aria-hidden="true"
                                                    style={{
                                                        left: clamp(
                                                            draggedPositionedEvent.left + dragPreview.deltaHours * hourWidth,
                                                            0,
                                                            Math.max(0, timelineWidth - draggedPositionedEvent.width),
                                                        ),
                                                        width: draggedPositionedEvent.width,
                                                        background: (ROLE_PALETTE[drag.event.extendedProps.role] ?? ROLE_PALETTE.DEFAULT).bg,
                                                        borderLeftColor: (ROLE_PALETTE[drag.event.extendedProps.role] ?? ROLE_PALETTE.DEFAULT).border,
                                                        color: (ROLE_PALETTE[drag.event.extendedProps.role] ?? ROLE_PALETTE.DEFAULT).text,
                                                    }}
                                                >
                                                    <span className="shift-time">
                                                        {`${String(dragPreview.shifted.start.getHours()).padStart(2, '0')}:${String(dragPreview.shifted.start.getMinutes()).padStart(2, '0')}-${String(dragPreview.shifted.end.getHours()).padStart(2, '0')}:${String(dragPreview.shifted.end.getMinutes()).padStart(2, '0')}`}
                                                    </span>
                                                    <span className="shift-preview-action">{drag.mode === 'copy' ? 'Copy' : 'Move'} to {dragPreview.targetTitle}</span>
                                                </div>
                                            ) : null}
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
                                                    {isEventLocked(shiftAction.event) ? 'View shift details' : 'Edit shift'}
                                                </button>
                                                {onEventDelete && !isEventLocked(shiftAction.event) ? (
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

            {moveDialog ? (
                <div
                    className="shift-move-dialog-backdrop"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) closeMoveDialog();
                    }}
                >
                    <form
                        className="shift-move-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={`${boardId}-move-dialog-title`}
                        aria-describedby={`${boardId}-move-dialog-description`}
                        onSubmit={handleMoveDialogSubmit}
                        onKeyDown={trapMoveDialogFocus}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="shift-move-dialog__heading">
                            <div>
                                <h2 id={`${boardId}-move-dialog-title`}>Move or copy shift</h2>
                                <p id={`${boardId}-move-dialog-description`}>
                                    {moveDialog.event.title}, {formatActionTime(moveDialog.event.start)} to {formatActionTime(moveDialog.event.end)}.
                                </p>
                            </div>
                            <button type="button" className="shift-move-dialog__close" aria-label="Close move shift dialog" onClick={closeMoveDialog}>×</button>
                        </div>

                        {onEventCopy ? (
                            <label>
                                Action
                                <select
                                    value={moveDialog.mode}
                                    onChange={(event) => setMoveDialog((current) => current ? { ...current, mode: event.target.value as SchedulerGestureMode } : current)}
                                >
                                    <option value="move">Move</option>
                                    <option value="copy">Copy</option>
                                </select>
                            </label>
                        ) : null}

                        <label>
                            Team member
                            <select
                                ref={moveDialogResourceRef}
                                value={moveDialog.resourceId}
                                onChange={(event) => setMoveDialog((current) => current ? { ...current, resourceId: event.target.value } : current)}
                            >
                                {resources.map((resource) => (
                                    <option key={resource.id} value={resource.id}>{resource.title}</option>
                                ))}
                            </select>
                        </label>

                        <label>
                            Time adjustment in minutes
                            <input
                                type="number"
                                step="15"
                                min={-totalHours * 60}
                                max={totalHours * 60}
                                value={moveDialog.offsetMinutes}
                                onChange={(event) => setMoveDialog((current) => current ? { ...current, offsetMinutes: event.target.value } : current)}
                            />
                        </label>

                        <p className="shift-move-dialog__preview" role="status" aria-live="polite">
                            {moveDialogPreview || 'Choose a staff member or a 15-minute time adjustment.'}
                        </p>

                        <div className="shift-move-dialog__actions">
                            <button type="button" onClick={closeMoveDialog}>Cancel</button>
                            <button
                                type="submit"
                                className="shift-move-dialog__apply"
                                disabled={moveDialogDecision?.kind !== 'apply' || !moveDialogPreview}
                            >
                                Apply {moveDialog.mode}
                            </button>
                        </div>
                    </form>
                </div>
            ) : null}

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
                    height: 52px;
                    display: flex;
                    align-items: center;
                    padding: 0 10px;
                    font-size: 0.78rem;
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
                    height: 56px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 0 10px;
                    border-bottom: 1px solid #e6ecf7;
                }

                .avatar {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    border: 1px solid;
                    display: grid;
                    place-items: center;
                    font-size: 0.66rem;
                    font-weight: 700;
                }

                .resource-name {
                    font-size: 0.8rem;
                    font-weight: 700;
                    line-height: 1.1;
                    color: #1f2d49;
                }

                .resource-role {
                    font-size: 0.65rem;
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
                    height: 52px;
                    border-bottom: 1px solid #dce4f1;
                    background: #f9fbff;
                }

                .day-header {
                    position: absolute;
                    top: 0;
                    height: 26px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.72rem;
                    font-weight: 700;
                    color: #3f5278;
                    border-right: 1px solid #dce4f1;
                }

                .hour-label {
                    position: absolute;
                    top: 26px;
                    height: 26px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.65rem;
                    color: #526381;
                    border-right: 1px solid #eef2fb;
                }

                .timeline-body {
                    position: relative;
                }

                .timeline-row {
                    position: relative;
                    height: 56px;
                    border-bottom: 1px solid #e6ecf7;
                    background: #fff;
                    cursor: crosshair;
                    transition: box-shadow 120ms ease, background 120ms ease;
                }

                .timeline-row--drop-valid {
                    background: #edfdf5;
                    box-shadow: inset 0 0 0 3px #17b26a;
                }

                .timeline-row--drop-invalid {
                    background: #fff1f2;
                    box-shadow: inset 0 0 0 3px #e74867;
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
                    top: 6px;
                    bottom: 6px;
                    border-left: 4px solid;
                    border-radius: 6px;
                    user-select: none;
                    overflow: hidden;
                }

                .shift-block--source-ghost {
                    opacity: 0.38;
                    outline: 2px dashed currentColor;
                    outline-offset: -2px;
                }

                .shift-block--source-ghost > * {
                    pointer-events: none;
                }

                .shift-block--locked {
                    background-image: repeating-linear-gradient(135deg, transparent 0, transparent 7px, rgba(82, 99, 129, 0.08) 7px, rgba(82, 99, 129, 0.08) 12px);
                }

                .shift-details-button {
                    position: absolute;
                    inset: 0;
                    width: 100%;
                    border: 0;
                    border-radius: inherit;
                    background: transparent;
                    color: inherit;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: flex-start;
                    gap: 2px;
                    padding: 4px 40px 4px 8px;
                    text-align: left;
                    cursor: pointer;
                    touch-action: pan-x pan-y;
                    overflow: hidden;
                }

                .shift-details-button:focus-visible,
                .shift-drag-handle:focus-visible {
                    outline: 3px solid #234ed9;
                    outline-offset: -3px;
                }

                .shift-drag-handle {
                    position: absolute;
                    z-index: 2;
                    top: 4px;
                    right: 4px;
                    bottom: 4px;
                    width: 32px;
                    min-width: 32px;
                    border: 1px solid rgba(31, 45, 73, 0.3);
                    border-radius: 5px;
                    background: rgba(255, 255, 255, 0.82);
                    color: #1f2d49;
                    display: grid;
                    place-items: center;
                    font-size: 1rem;
                    font-weight: 900;
                    line-height: 1;
                    cursor: grab;
                    touch-action: none;
                }

                .shift-drag-handle:active {
                    cursor: grabbing;
                }

                .shift-drag-handle:disabled {
                    cursor: not-allowed;
                    opacity: 0.5;
                }

                .shift-drag-preview {
                    position: absolute;
                    z-index: 7;
                    top: 6px;
                    bottom: 6px;
                    border-left: 4px solid;
                    border-radius: 6px;
                    padding: 5px 8px;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    gap: 2px;
                    pointer-events: none;
                    overflow: hidden;
                    box-shadow: 0 8px 20px rgba(31, 45, 73, 0.2);
                }

                .shift-drag-preview--valid {
                    outline: 3px solid #17b26a;
                }

                .shift-drag-preview--invalid {
                    outline: 3px solid #e74867;
                    filter: grayscale(0.35);
                }

                .shift-preview-action {
                    font-size: 0.65rem;
                    font-weight: 800;
                    white-space: nowrap;
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
                    min-height: 40px;
                    border: 1px solid #dce4f1;
                    border-radius: 6px;
                    background: #f9fbff;
                    color: #1f2d49;
                    font-size: 0.76rem;
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

                .shift-time {
                    font-size: 0.72rem;
                    font-weight: 700;
                    white-space: nowrap;
                }

                .shift-role {
                    font-size: 0.62rem;
                    text-transform: uppercase;
                    letter-spacing: 0;
                    opacity: 0.85;
                    white-space: nowrap;
                }

                .shift-markers {
                    position: absolute;
                    left: 8px;
                    right: 40px;
                    bottom: 3px;
                    height: 12px;
                    pointer-events: none;
                }

                .shift-marker {
                    position: absolute;
                    min-width: 12px;
                    height: 12px;
                    border-radius: 999px;
                    font-size: 0.56rem;
                    font-weight: 800;
                    line-height: 10px;
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

                .shift-move-dialog-backdrop {
                    position: fixed;
                    inset: 0;
                    z-index: 80;
                    display: grid;
                    place-items: center;
                    padding: 20px;
                    background: rgba(16, 24, 40, 0.48);
                }

                .shift-move-dialog {
                    width: min(440px, 100%);
                    max-height: calc(100vh - 40px);
                    overflow: auto;
                    display: grid;
                    gap: 14px;
                    border: 1px solid #cfd9ec;
                    border-radius: 12px;
                    background: #fff;
                    box-shadow: 0 24px 64px rgba(31, 45, 73, 0.28);
                    padding: 18px;
                    color: #1f2d49;
                }

                .shift-move-dialog__heading {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    gap: 12px;
                }

                .shift-move-dialog h2,
                .shift-move-dialog p {
                    margin: 0;
                }

                .shift-move-dialog h2 {
                    font-size: 1.05rem;
                }

                .shift-move-dialog__heading p {
                    margin-top: 4px;
                    color: #526381;
                    font-size: 0.82rem;
                }

                .shift-move-dialog label {
                    display: grid;
                    gap: 6px;
                    font-size: 0.8rem;
                    font-weight: 800;
                }

                .shift-move-dialog select,
                .shift-move-dialog input,
                .shift-move-dialog button {
                    min-height: 44px;
                    border: 1px solid #cfd9ec;
                    border-radius: 7px;
                    background: #fff;
                    color: #1f2d49;
                    font: inherit;
                    padding: 0 10px;
                }

                .shift-move-dialog__close {
                    width: 44px;
                    padding: 0 !important;
                    font-size: 1.5rem !important;
                    cursor: pointer;
                }

                .shift-move-dialog__preview {
                    min-height: 42px;
                    border-radius: 7px;
                    background: #eef4ff;
                    color: #234ed9;
                    padding: 10px;
                    font-size: 0.82rem;
                    font-weight: 800;
                }

                .shift-move-dialog__actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 10px;
                }

                .shift-move-dialog__actions button {
                    min-width: 96px;
                    cursor: pointer;
                }

                .shift-move-dialog__actions .shift-move-dialog__apply {
                    border-color: #234ed9;
                    background: #234ed9;
                    color: #fff;
                    font-weight: 800;
                }

                .shift-move-dialog__actions button:disabled {
                    cursor: not-allowed;
                    opacity: 0.5;
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
                        width: 30px;
                        height: 30px;
                        flex: 0 0 30px;
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
