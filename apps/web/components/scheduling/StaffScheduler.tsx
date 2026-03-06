'use client';

import React, { useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import resourceTimelinePlugin from '@fullcalendar/resource-timeline';
import interactionPlugin from '@fullcalendar/interaction';

interface StaffResource {
    id: string;
    title: string;
    role: string;
    avatarInitials: string;
    hue: number;
}

interface ScheduleEvent {
    id: string;
    resourceId: string;
    title: string;
    start: string;
    end: string;
    extendedProps: { role: string };
}

const ROLE_PALETTE: Record<string, { bg: string; border: string; text: string }> = {
    MANAGER: { bg: '#edf3ff', border: '#2f63ff', text: '#234ed9' },
    CASHIER: { bg: '#e9fbf1', border: '#17b26a', text: '#0f8c52' },
    FLOOR: { bg: '#fff4e2', border: '#f59e0b', text: '#cc7f06' },
    SERVER: { bg: '#f2ebff', border: '#8b5cf6', text: '#7041e1' },
    KITCHEN: { bg: '#ffedf1', border: '#e74867', text: '#cb3653' },
    DEFAULT: { bg: '#f3f6ff', border: '#6f80a4', text: '#4c5f85' },
};

interface StaffSchedulerProps {
    resources: StaffResource[];
    events: ScheduleEvent[];
    initialDate?: string;
    onEventChange?: (eventId: string, newStart: string, newEnd: string, newResourceId: string) => void;
}

export function StaffScheduler({ resources, events, initialDate, onEventChange }: StaffSchedulerProps) {
    const calRef = useRef<FullCalendar>(null);
    const [currentLabel, setCurrentLabel] = useState('');

    const handleDatesSet = (info: { view: { title: string } }) => {
        setCurrentLabel(info.view.title);
    };

    return (
        <div className="staff-scheduler-root">
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                    padding: '0 0.35rem',
                    color: 'var(--text-secondary)',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                }}
            >
                <span>Drag to move shifts · Resize to adjust hours</span>
                <span style={{ color: 'var(--text-muted)' }}>{currentLabel}</span>
            </div>

            <FullCalendar
                ref={calRef}
                plugins={[resourceTimelinePlugin, interactionPlugin]}
                initialView="resourceTimelineWeek"
                initialDate={initialDate}
                schedulerLicenseKey="GPL-My-Project-Is-Open-Source"
                resources={resources.map((r) => ({
                    id: r.id,
                    title: r.title,
                    extendedProps: { role: r.role, initials: r.avatarInitials, hue: r.hue },
                }))}
                events={events}
                editable
                droppable
                resourceAreaWidth="170px"
                slotDuration={{ hours: 1 }}
                scrollTime="08:00:00"
                height="auto"
                headerToolbar={false}
                datesSet={handleDatesSet}
                resourceLabelContent={(arg) => {
                    const props = arg.resource.extendedProps as { role: string; initials: string; hue: number };
                    return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                            <div
                                style={{
                                    width: 30,
                                    height: 30,
                                    borderRadius: '50%',
                                    flexShrink: 0,
                                    background: `hsl(${props.hue}, 92%, 96%)`,
                                    border: `1px solid hsl(${props.hue}, 72%, 78%)`,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '0.6rem',
                                    fontWeight: 700,
                                    color: `hsl(${props.hue}, 76%, 34%)`,
                                }}
                            >
                                {props.initials}
                            </div>
                            <div>
                                <div style={{ fontSize: '0.76rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                                    {arg.resource.title}
                                </div>
                                <div
                                    style={{
                                        fontSize: '0.62rem',
                                        color: 'var(--text-muted)',
                                        fontWeight: 600,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.05em',
                                    }}
                                >
                                    {props.role}
                                </div>
                            </div>
                        </div>
                    );
                }}
                eventContent={(arg) => {
                    const role = (arg.event.extendedProps as { role: string }).role;
                    const colors = ROLE_PALETTE[role] ?? ROLE_PALETTE.DEFAULT;
                    const start =
                        arg.event.start?.toLocaleTimeString('en-US', {
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                        }) ?? '';
                    const end =
                        arg.event.end?.toLocaleTimeString('en-US', {
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                        }) ?? '';
                    return (
                        <div
                            style={{
                                background: colors.bg,
                                borderLeft: `3px solid ${colors.border}`,
                                borderRadius: '0 8px 8px 0',
                                padding: '3px 8px',
                                height: '100%',
                                overflow: 'hidden',
                                cursor: 'grab',
                            }}
                        >
                            <div
                                style={{
                                    fontSize: '0.68rem',
                                    fontWeight: 700,
                                    color: colors.text,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                }}
                            >
                                {start}-{end}
                            </div>
                            <div
                                style={{
                                    fontSize: '0.56rem',
                                    color: colors.text,
                                    opacity: 0.84,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.04em',
                                }}
                            >
                                {role}
                            </div>
                        </div>
                    );
                }}
                eventChange={(info) => {
                    onEventChange?.(
                        info.event.id,
                        info.event.startStr,
                        info.event.endStr,
                        info.event.getResources()[0]?.id ?? ''
                    );
                }}
            />

            <style>{`
                .staff-scheduler-root {
                    --fc-border-color: #dce4f1;
                    --fc-today-bg-color: rgba(79, 121, 255, 0.08);
                    --fc-now-indicator-color: #2f63ff;
                    --fc-event-border-color: transparent;
                    --fc-event-bg-color: transparent;
                    --fc-event-text-color: var(--text-primary);
                    --fc-page-bg-color: transparent;
                    --fc-neutral-bg-color: #f7f9ff;
                    --fc-list-event-hover-bg-color: #eef3ff;
                    font-family: var(--font-sans);
                }

                .fc .fc-timeline-slot-label,
                .fc .fc-col-header-cell,
                .fc .fc-resource-area-column-group a,
                .fc .fc-datagrid-cell-main {
                    color: var(--text-secondary);
                    font-size: 0.74rem;
                    font-weight: 600;
                    border-color: #dce4f1 !important;
                }

                .fc .fc-timeline-slot-frame,
                .fc .fc-datagrid-cell-frame {
                    background: transparent;
                }

                .fc .fc-resource-timeline-divider,
                .fc .fc-datagrid-header,
                .fc .fc-resource-area {
                    background: #f7f9ff;
                    border-color: #dce4f1;
                }

                .fc .fc-col-header-cell {
                    background: #f9fbff;
                    padding: 9px 0;
                    font-weight: 700;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }

                .fc .fc-timeline-slot.fc-day-today {
                    background: rgba(79, 121, 255, 0.08);
                }

                .fc .fc-timeline-lane:nth-child(even) {
                    background: rgba(237, 242, 255, 0.6);
                }

                .fc .fc-scroller::-webkit-scrollbar {
                    width: 8px;
                    height: 8px;
                }

                .fc .fc-scroller::-webkit-scrollbar-thumb {
                    background: #c4d0e7;
                    border-radius: 9999px;
                }

                .fc-theme-standard td,
                .fc-theme-standard th,
                .fc-theme-standard .fc-scrollgrid {
                    border-color: #dce4f1;
                    background: transparent;
                }

                .fc-datagrid-cell-cushion {
                    padding: 5px 12px;
                }

                .fc-event:hover {
                    opacity: 0.9;
                    cursor: grab;
                }

                .fc-event:active {
                    cursor: grabbing;
                }
            `}</style>
        </div>
    );
}
