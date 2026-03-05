import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion } from 'framer-motion';
import { Clock, User } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export interface Shift {
    id: string;
    userId: string | null;
    userName: string | null;
    startTime: string;
    endTime: string;
    role: string;
}

interface ShiftCardProps {
    shift: Shift;
}

export function ShiftCard({ shift }: ShiftCardProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: shift.id });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 50 : 'auto',
    };

    return (
        <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="touch-none w-full outline-none">
            <motion.div
                layoutId={`shift-${shift.id}`}
                whileHover={{ scale: 1.02, y: -2 }}
                whileTap={{ scale: 0.98 }}
                className={cn(
                    "flex flex-col gap-2 p-3 rounded-lg border border-slate-200/50 bg-white/80 backdrop-blur-md shadow-sm select-none cursor-grab active:cursor-grabbing",
                    "transition-colors duration-200 ease-in-out hover:border-blue-400 hover:shadow-md",
                    isDragging && "opacity-60 shadow-xl border-blue-500 ring-2 ring-blue-500/20"
                )}
            >
                <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold tracking-wide uppercase text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                        {shift.role}
                    </span>
                    <div className="flex items-center gap-1 text-slate-500">
                        <Clock className="w-3.5 h-3.5" />
                        <span className="text-xs font-medium tabular-nums shadow-sm">{shift.startTime} - {shift.endTime}</span>
                    </div>
                </div>

                <div className="flex items-center gap-2 mt-1">
                    <div className={cn(
                        "flex items-center justify-center w-7 h-7 rounded-full text-white shadow-inner",
                        shift.userId ? "bg-gradient-to-br from-indigo-500 to-purple-600" : "bg-slate-200 border border-slate-300 border-dashed text-slate-400"
                    )}>
                        {shift.userName ? shift.userName.charAt(0).toUpperCase() : <User className="w-3.5 h-3.5" />}
                    </div>
                    <span className={cn(
                        "text-sm font-medium truncate",
                        shift.userId ? "text-slate-800" : "text-slate-500 italic"
                    )}>
                        {shift.userName || 'Unassigned'}
                    </span>
                </div>
            </motion.div>
        </div>
    );
}
