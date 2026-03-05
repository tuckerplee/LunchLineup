'use client';

import React, { useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import resourceTimelinePlugin from '@fullcalendar/resource-timeline';
import interactionPlugin from '@fullcalendar/interaction';

// ── Types ──────────────────────────────────────────────────────────────────────

interface StaffResource {
    id: string;
    title: string;
    role: string;
    avatarInitials: string;
    hue: number; // for per-person color
}

interface ScheduleEvent {
    id: string;
    resourceId: string;
    title: string;
    start: string;
    end: string;
    extendedProps: { role: string };
}

// ── Role colors (mapped to our design tokens) ─────────────────────────────────

const ROLE_PALETTE: Record<string, { bg: string; border: string; text: string }> = {
    MANAGER: { bg: '#5c7cfa22', border: '#5c7cfa', text: '#748ffc' },
    CASHIER: { bg: '#10b98120', border: '#10b981', text: '#34d399' },
    FLOOR: { bg: '#f59e0b20', border: '#f59e0b', text: '#fbbf24' },
    SERVER: { bg: '#8b5cf620', border: '#8b5cf6', text: '#c4b5fd' },
    KITCHEN: { bg: '#f43f5e20', border: '#f43f5e', text: '#fb7185' },
    DEFAULT: { bg: '#ffffff10', border: '#475569', text: '#94a3b8' },
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface StaffSchedulerProps {
    resources: StaffResource[];
    events: ScheduleEvent[];
    initialDate?: string;
    onEventChange?: (eventId: string, newStart: string, newEnd: string, newResourceId: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function StaffScheduler({ resources, events, initialDate, onEventChange }: StaffSchedulerProps) {
    const calRef = useRef<FullCalendar>(null);
    const [currentLabel, setCurrentLabel] = useState('');

    const handleDatesSet = (info: { view: { title: string } }) => {
        setCurrentLabel(info.view.title);
    };

    return (
        <div className="staff-scheduler-root">
            <FullCalendar
                ref={calRef}
                plugins={[resourceTimelinePlugin, interactionPlugin]}
                initialView="resourceTimelineWeek"
                initialDate={initialDate}
                schedulerLicenseKey="GPL-My-Project-Is-Open-Source"

                // Resources = staff rows
                resources={resources.map(r => ({
                    id: r.id,
                    title: r.title,
                    extendedProps: { role: r.role, initials: r.avatarInitials, hue: r.hue },
                }))}

                // Events = shifts
                events={events}

                // Interaction
                editable
                droppable
                resourceAreaWidth="160px"
                slotDuration={{ hours: 1 }}
                scrollTime="08:00:00"
                height="auto"
                headerToolbar={false} // we render our own toolbar
                datesSet={handleDatesSet}

                // Render custom resource label (staff row)
                resourceLabelContent={(arg) => {
                    const props = arg.resource.extendedProps as { role: string; initials: string; hue: number };
                    return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                            <div style={{
                                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                                background: `hsl(${props.hue}, 60%, 22%)`,
                                border: `1px solid hsl(${props.hue}, 60%, 45%)`,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '0.5625rem', fontWeight: 700,
                                color: `hsl(${props.hue}, 90%, 72%)`,
                            }}>
                                {props.initials}
                            </div>
                            <div>
                                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#f1f5f9', lineHeight: 1.2 }}>
                                    {arg.resource.title}
                                </div>
                                <div style={{ fontSize: '0.625rem', color: '#64748b', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                    {props.role}
                                </div>
                            </div>
                        </div>
                    );
                }}

                // Render shift event
                eventContent={(arg) => {
                    const role = (arg.event.extendedProps as { role: string }).role;
                    const colors = ROLE_PALETTE[role] ?? ROLE_PALETTE.DEFAULT;
                    const start = arg.event.start?.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) ?? '';
                    const end = arg.event.end?.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) ?? '';
                    return (
                        <div style={{
                            background: colors.bg,
                            borderLeft: `3px solid ${colors.border}`,
                            borderRadius: '0 6px 6px 0',
                            padding: '3px 8px',
                            height: '100%',
                            overflow: 'hidden',
                            cursor: 'grab',
                        }}>
                            <div style={{ fontSize: '0.6875rem', fontWeight: 700, color: colors.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {start}–{end}
                            </div>
                            <div style={{ fontSize: '0.5625rem', color: colors.text, opacity: 0.75, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
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

                // FullCalendar theme overrides via CSS classes
                viewClassNames="fc-dark"
            />

            {/* Deep CSS overrides for FullCalendar dark theme */}
            <style>{`
                .staff-scheduler-root {
                    --fc-border-color:       rgba(255,255,255,0.06);
                    --fc-today-bg-color:     rgba(92,124,250,0.06);
                    --fc-now-indicator-color:#5c7cfa;
                    --fc-event-border-color: transparent;
                    --fc-event-bg-color:     transparent;
                    --fc-event-text-color:   #f1f5f9;
                    --fc-page-bg-color:      transparent;
                    --fc-neutral-bg-color:   rgba(255,255,255,0.02);
                    --fc-list-event-hover-bg-color: rgba(255,255,255,0.04);
                    font-family: Inter, system-ui, sans-serif;
                }

                /* Table cells */
                .fc .fc-timeline-slot-label,
                .fc .fc-col-header-cell,
                .fc .fc-resource-area-column-group a,
                .fc .fc-datagrid-cell-main {
                    color: #94a3b8;
                    font-size: 0.75rem;
                    font-weight: 500;
                    border-color: rgba(255,255,255,0.06) !important;
                }

                .fc .fc-timeline-slot-frame,
                .fc .fc-datagrid-cell-frame {
                    background: transparent;
                }

                /* Resource area (left column) */
                .fc .fc-resource-timeline-divider,
                .fc .fc-datagrid-header,
                .fc .fc-resource-area {
                    background: rgba(15,22,41,0.6);
                    border-color: rgba(255,255,255,0.06);
                }

                /* Header (day labels) */
                .fc .fc-col-header-cell {
                    background: rgba(255,255,255,0.025);
                    padding: 8px 0;
                    font-weight: 600;
                    font-size: 0.8125rem;
                    color: #cbd5e1;
                }

                /* Today highlight */
                .fc .fc-timeline-slot.fc-day-today {
                    background: rgba(92,124,250,0.06);
                }

                /* Row stripes */
                .fc .fc-timeline-lane:nth-child(even) {
                    background: rgba(255,255,255,0.01);
                }

                /* Scrollbars */
                .fc .fc-scroller::-webkit-scrollbar { width: 6px; height: 6px; }
                .fc .fc-scroller::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 9999px; }

                /* Remove FullCalendar's default light-mode background */
                .fc-theme-standard td,
                .fc-theme-standard th,
                .fc-theme-standard .fc-scrollgrid {
                    border-color: rgba(255,255,255,0.06);
                    background: transparent;
                }

                .fc-datagrid-cell-cushion { padding: 4px 12px; }

                /* Event hover */
                .fc-event:hover { opacity: 0.85; cursor: grab; }
                .fc-event:active { cursor: grabbing; }
            `}</style>
        </div>
    );
}
