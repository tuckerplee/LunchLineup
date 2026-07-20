import type { TimeCardRecord } from '@lunchlineup/api-contract';
import { ProblemError } from '../platform/problem';

export type TimeCardWithPublicRelations = {
  publicId: string;
  clockInAt: Date;
  clockOutAt: Date | null;
  breakMinutes: number;
  status: 'OPEN' | 'CLOSED' | 'VOID';
  revision: number;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  workTimeZone: string;
  user: { publicId: string; name: string; username: string | null; role: string };
  location: { publicId: string; name: string; timezone: string } | null;
  shift: { publicId: string } | null;
  breaks: readonly { publicId: string; startAt: Date; endAt: Date }[];
};

export function serializeTimeCard(row: TimeCardWithPublicRelations, now = new Date()): TimeCardRecord {
  const end = row.clockOutAt ?? now;
  const grossMinutes = Math.max(0, Math.floor((end.getTime() - row.clockInAt.getTime()) / 60_000));
  const workedMinutes = Math.max(0, grossMinutes - row.breakMinutes);
  if (!Number.isInteger(row.breakMinutes) || row.breakMinutes < 0 || !Number.isInteger(row.revision) || row.revision < 1) {
    throw new ProblemError(500, 'invalid_time_card_record', 'A saved time-card record is invalid.', 'Time-card data error');
  }
  return {
    id: row.publicId,
    userId: row.user.publicId,
    locationId: row.location?.publicId ?? null,
    shiftId: row.shift?.publicId ?? null,
    clockInAt: row.clockInAt.toISOString(),
    clockOutAt: row.clockOutAt?.toISOString() ?? null,
    breakMinutes: row.breakMinutes,
    status: row.status,
    revision: row.revision,
    grossMinutes,
    workedMinutes,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    displayTimeZone: row.workTimeZone || 'UTC',
    breaks: row.breaks.map((interval) => {
      if (interval.endAt <= interval.startAt) {
        throw new ProblemError(500, 'invalid_time_card_break', 'A saved time-card break is invalid.', 'Time-card data error');
      }
      return {
        id: interval.publicId,
        startAt: interval.startAt.toISOString(),
        endAt: interval.endAt.toISOString(),
      };
    }),
    user: {
      id: row.user.publicId,
      name: row.user.name || 'Unnamed',
      username: row.user.username?.trim() || null,
      role: row.user.role,
    },
    location: row.location
      ? { id: row.location.publicId, name: row.location.name, timezone: row.location.timezone }
      : null,
  };
}
