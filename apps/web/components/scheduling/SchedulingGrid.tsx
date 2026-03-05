'use client';

import React, { useState } from 'react';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent,
    useDroppable,
    useDraggable,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

export interface Shift {
    id: string;
    userId: string | null;
    userName: string | null;
    startTime: string;
    endTime: string;
    role: string;
    day?: string;
}

const ROLE_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
    MANAGER: { bg: 'rgba(92, 124, 250, 0.15)', border: 'rgba(92, 124, 250, 0.35)', text: '#748ffc', dot: '#5c7cfa' },
    CASHIER: { bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(16, 185, 129, 0.3)', text: '#34d399', dot: '#10b981' },
    FLOOR: { bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(245, 158, 11, 0.3)', text: '#fbbf24', dot: '#f59e0b' },
    KITCHEN: { bg: 'rgba(244, 63, 94, 0.12)', border: 'rgba(244, 63, 94, 0.3)', text: '#fb7185', dot: '#f43f5e' },
    SERVER: { bg: 'rgba(139, 92, 246, 0.12)', border: 'rgba(139, 92, 246, 0.3)', text: '#c4b5fd', dot: '#8b5cf6' },
    DEFAULT: { bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.12)', text: '#94a3b8', dot: '#475569' },
};

function DraggableShift({ shift }: { shift: Shift }) {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: shift.id });
    const colors = ROLE_COLORS[shift.role] ?? ROLE_COLORS.DEFAULT;

    return (
        <div
            ref={setNodeRef}
            {...listeners}
            {...attributes}
            style={{
                padding: '5px 8px',
                borderRadius: 6,
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                cursor: isDragging ? 'grabbing' : 'grab',
                opacity: isDragging ? 0.5 : 1,
                transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
                transition: isDragging ? 'none' : 'transform 200ms',
                userSelect: 'none',
                position: 'relative',
                zIndex: isDragging ? 999 : 1,
            }}
        >
            {shift.userName && (
                <div style={{ fontWeight: 600, fontSize: '0.6875rem', color: colors.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {shift.userName}
                </div>
            )}
            <div style={{ fontSize: '0.625rem', color: colors.text, opacity: 0.7, marginTop: 1 }}>
                {shift.startTime}–{shift.endTime}
            </div>
            <div style={{ fontSize: '0.5625rem', color: colors.dot, fontWeight: 700, marginTop: 1, letterSpacing: '0.03em', textTransform: 'uppercase' }}>
                {shift.role}
            </div>
        </div>
    );
}

function DroppableCell({ id, children }: { id: string; children: React.ReactNode }) {
    const { isOver, setNodeRef } = useDroppable({ id });

    return (
        <div
            ref={setNodeRef}
            style={{
                minHeight: 80,
                padding: '4px',
                borderRight: '1px solid rgba(255,255,255,0.04)',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                background: isOver ? 'rgba(92, 124, 250, 0.08)' : 'transparent',
                transition: 'background 150ms',
                display: 'flex', flexDirection: 'column', gap: 4,
                position: 'relative',
            }}
        >
            {children}
        </div>
    );
}

interface SchedulingGridProps {
    initialShifts: Shift[];
    staffRows?: string[];
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function SchedulingGrid({ initialShifts, staffRows = ['Alice J.', 'Bob T.', 'Casey L.', 'Riley P.', 'Jordan M.'] }: SchedulingGridProps) {
    const [shifts, setShifts] = useState<Shift[]>(initialShifts);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    function handleDragEnd(event: DragEndEvent) {
        const { active, over } = event;
        if (!over) return;
        const cellId = over.id as string; // cell-{staffName}-{day}
        if (!cellId.startsWith('cell-')) return;

        const parts = cellId.split('-');
        const day = parts[parts.length - 1];
        const staff = parts.slice(1, -1).join('-');

        setShifts(prev => prev.map(shift =>
            shift.id === active.id
                ? { ...shift, userName: staff, day }
                : shift
        ));
    }

    const getShiftsForCell = (staffName: string, day: string) =>
        shifts.filter(s => s.userName === staffName && (s.day === day || (!s.day && day === 'Mon')));

    const colWidth = `calc((100% - 100px) / 7)`;

    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <div style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 14, overflow: 'hidden',
                width: '100%',
            }}>
                {/* Header row */}
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: `100px repeat(7, 1fr)`,
                    background: 'rgba(255,255,255,0.03)',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                }}>
                    <div style={{
                        padding: '10px 12px',
                        fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.06em',
                        borderRight: '1px solid rgba(255,255,255,0.06)',
                    }}>
                        Staff
                    </div>
                    {DAYS.map((day, i) => (
                        <div key={day} style={{
                            padding: '10px 8px', textAlign: 'center',
                            fontSize: '0.8125rem', fontWeight: 600,
                            color: i >= 5 ? 'var(--text-muted)' : 'var(--text-primary)',
                            borderRight: i < 6 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                        }}>
                            {day}
                            <div style={{ fontSize: '0.625rem', color: 'var(--text-muted)', fontWeight: 400, marginTop: 1 }}>
                                Mar {3 + i}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Staff rows */}
                {staffRows.map((staffName, rowIdx) => (
                    <div key={staffName} style={{
                        display: 'grid',
                        gridTemplateColumns: `100px repeat(7, 1fr)`,
                        background: rowIdx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                        borderBottom: rowIdx < staffRows.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                    }}>
                        {/* Staff name cell */}
                        <div style={{
                            padding: '8px 12px',
                            borderRight: '1px solid rgba(255,255,255,0.06)',
                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                        }}>
                            <div style={{
                                width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                                background: `hsl(${rowIdx * 60 + 220}, 60%, 30%)`,
                                border: `1px solid hsl(${rowIdx * 60 + 220}, 60%, 50%)`,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '0.5625rem', fontWeight: 700,
                                color: `hsl(${rowIdx * 60 + 220}, 90%, 75%)`,
                            }}>
                                {staffName.split(' ').map(n => n[0]).join('')}
                            </div>
                            <div style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {staffName.split(' ')[0]}
                            </div>
                        </div>

                        {/* Day cells */}
                        {DAYS.map((day) => {
                            const cellId = `cell-${staffName}-${day}`;
                            const cellShifts = getShiftsForCell(staffName, day);
                            return (
                                <DroppableCell key={cellId} id={cellId}>
                                    {cellShifts.map(shift => (
                                        <DraggableShift key={shift.id} shift={shift} />
                                    ))}
                                </DroppableCell>
                            );
                        })}
                    </div>
                ))}
            </div>
        </DndContext>
    );
}
