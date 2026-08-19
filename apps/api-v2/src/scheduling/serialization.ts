import type { ScheduleBoardResponse, ScheduleChangeSetResponse, ScheduleCreateResponse } from '@lunchlineup/api-contract';
import { ProblemError } from '../platform/problem';
import { scheduleEtag } from './contract-helpers';

export type PublicScheduleRow = {
  id: string;
  publicId: string;
  locationId: string;
  startDate: Date;
  endDate: Date;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: Date | null;
  revision: number;
};

export type PublicShiftRow = {
  id: string;
  publicId: string;
  userId: string | null;
  locationId: string;
  scheduleId: string | null;
  startTime: Date;
  endTime: Date;
  role: string | null;
  user: {
    id: string;
    publicId: string;
    name: string;
    role: 'MANAGER' | 'STAFF';
  } | null;
  breaks: Array<{
    startTime: Date;
    endTime: Date;
    paid: boolean;
  }>;
};

export function serializeSchedule(
  schedule: PublicScheduleRow,
  locationPublicId: string,
): ScheduleCreateResponse['data'] {
  return {
    id: schedule.publicId,
    locationId: locationPublicId,
    startDate: schedule.startDate.toISOString(),
    endDate: schedule.endDate.toISOString(),
    status: schedule.status,
    publishedAt: schedule.publishedAt?.toISOString() ?? null,
    revision: schedule.revision,
    etag: scheduleEtag(schedule.publicId, schedule.revision),
  };
}

export function serializeShift(
  shift: PublicShiftRow,
  locationPublicId: string,
  schedulePublicId: string,
): ScheduleBoardResponse['data']['shifts'][number] {
  if (!shift.scheduleId) {
    throw new ProblemError(
      500,
      'invalid_scheduling_record',
      'A saved shift is missing its schedule.',
      'Scheduling data error',
    );
  }
  return {
    id: shift.publicId,
    userId: shift.user?.publicId ?? null,
    locationId: locationPublicId,
    scheduleId: schedulePublicId,
    startTime: shift.startTime.toISOString(),
    endTime: shift.endTime.toISOString(),
    role: shift.role,
    user: shift.user
      ? {
          id: shift.user.publicId,
          name: shift.user.name || 'Unnamed',
          role: shift.user.role,
        }
      : null,
    breaks: shift.breaks.map((item) => ({
      startTime: item.startTime.toISOString(),
      endTime: item.endTime.toISOString(),
      paid: item.paid,
    })),
  };
}

export type ChangeSetResponseData = ScheduleChangeSetResponse['data'];
