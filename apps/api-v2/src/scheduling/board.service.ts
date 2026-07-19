import type {
  SessionIdentity,
  ScheduleBoardResponse,
  SchedulerView,
} from '@lunchlineup/api-contract';
import type { UserRole } from '@prisma/client';
import { TenantDatabase } from '../platform/database';
import { ProblemError } from '../platform/problem';
import { boardRange } from './time-zone';
import {
  serializeSchedule,
  serializeShift,
  type PublicScheduleRow,
  type PublicShiftRow,
} from './serialization';

const MAX_LOCATIONS = 500;
const MAX_STAFF = 1000;
const MAX_SCHEDULES = 200;
const MAX_SHIFTS = 5000;

function normalizedRole(value: string | null | undefined): string {
  return value?.trim().replace(/[\s-]+/g, '_').toUpperCase() ?? '';
}

function isStaffIdentity(identity: SessionIdentity): boolean {
  return [
    identity.legacyRole,
    identity.role,
    ...identity.roles.flatMap((role) => [role.name, role.legacyRole]),
  ]
    .some((role) => normalizedRole(role) === 'STAFF');
}

function schedulableRole(value: UserRole): 'MANAGER' | 'STAFF' {
  if (value === 'MANAGER' || value === 'STAFF') return value;
  throw new ProblemError(
    500,
    'invalid_scheduling_record',
    'A scheduling record references an ineligible staff role.',
    'Scheduling data error',
  );
}

export type BoardQuery = {
  date: string;
  view: SchedulerView;
  locationId?: string;
};

export class ScheduleBoardService {
  constructor(private readonly database: TenantDatabase) {}

  async get(identity: SessionIdentity, query: BoardQuery): Promise<ScheduleBoardResponse> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const firstLocations = await transaction.location.findMany({
        where: { tenantId: identity.tenantId, deletedAt: null },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: MAX_LOCATIONS + 1,
        select: {
          id: true,
          publicId: true,
          name: true,
          timezone: true,
        },
      });
      const requestedLocation = query.locationId
        ? await transaction.location.findFirst({
            where: {
              tenantId: identity.tenantId,
              publicId: query.locationId,
              deletedAt: null,
            },
            select: {
              id: true,
              publicId: true,
              name: true,
              timezone: true,
            },
          })
        : null;

      const visibleLocations = firstLocations.slice(0, MAX_LOCATIONS);
      if (requestedLocation && !visibleLocations.some((item) => item.id === requestedLocation.id)) {
        visibleLocations[MAX_LOCATIONS - 1] = requestedLocation;
        visibleLocations.sort((left, right) => (
          left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
        ));
      }
      const selected = requestedLocation ?? visibleLocations[0] ?? null;
      const range = boardRange(query.date, query.view, selected?.timezone ?? 'America/New_York');
      if (!selected) {
        return {
          data: {
            permissions: [...new Set(identity.permissions)].sort(),
            locations: [],
            locationsTruncated: false,
            selectedLocationId: null,
            staff: [],
            schedules: [],
            shifts: [],
            range: {
              start: range.start.toISOString(),
              end: range.end.toISOString(),
            },
          },
          meta: { generatedAt: new Date().toISOString() },
        };
      }

      const staffOnly = isStaffIdentity(identity);
      const [staffRows, scheduleRows] = await Promise.all([
        transaction.user.findMany({
          where: {
            tenantId: identity.tenantId,
            deletedAt: null,
            suspendedAt: null,
            role: { in: ['MANAGER', 'STAFF'] },
            ...(staffOnly ? { id: identity.sub } : {}),
          },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: MAX_STAFF + 1,
          select: {
            id: true,
            publicId: true,
            name: true,
            role: true,
          },
        }),
        transaction.schedule.findMany({
          where: {
            tenantId: identity.tenantId,
            locationId: selected.id,
            deletedAt: null,
            startDate: { lt: range.end },
            endDate: { gt: range.start },
          },
          orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
          take: MAX_SCHEDULES + 1,
          select: {
            id: true,
            publicId: true,
            locationId: true,
            startDate: true,
            endDate: true,
            status: true,
            publishedAt: true,
            revision: true,
          },
        }),
      ]);
      if (staffRows.length > MAX_STAFF || scheduleRows.length > MAX_SCHEDULES) {
        throw new ProblemError(
          422,
          'schedule_board_too_large',
          'The selected board contains too much data for one safe response. Choose a shorter range.',
          'Schedule board too large',
        );
      }

      const scheduleIds = scheduleRows.map((schedule) => schedule.id);
      const shiftRows = scheduleIds.length === 0
        ? []
        : await transaction.shift.findMany({
          where: {
            tenantId: identity.tenantId,
            locationId: selected.id,
            scheduleId: { in: scheduleIds },
            deletedAt: null,
            OR: [
              { userId: null },
              {
                user: {
                  is: {
                    role: { in: ['MANAGER', 'STAFF'] },
                    deletedAt: null,
                    suspendedAt: null,
                  },
                },
              },
            ],
            ...(staffOnly
              ? {
                  userId: identity.sub,
                  schedule: { is: { status: 'PUBLISHED', deletedAt: null } },
                }
              : {
                  schedule: { is: { deletedAt: null } },
                }),
          },
          orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
          take: MAX_SHIFTS + 1,
          select: {
            id: true,
            publicId: true,
            userId: true,
            locationId: true,
            scheduleId: true,
            startTime: true,
            endTime: true,
            role: true,
            user: {
              select: {
                id: true,
                publicId: true,
                name: true,
                role: true,
              },
            },
            breaks: {
              orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
              select: {
                startTime: true,
                endTime: true,
                paid: true,
              },
            },
          },
        });

      if (shiftRows.length > MAX_SHIFTS) {
        throw new ProblemError(
          422,
          'schedule_board_too_large',
          'The selected board contains too much data for one safe response. Choose a shorter range.',
          'Schedule board too large',
        );
      }

      const schedules = scheduleRows as PublicScheduleRow[];
      const schedulePublicIdByInternalId = new Map(schedules.map((schedule) => [schedule.id, schedule.publicId]));
      const serializedShifts = (shiftRows as unknown as PublicShiftRow[]).map((shift) => {
        const schedulePublicId = shift.scheduleId
          ? schedulePublicIdByInternalId.get(shift.scheduleId)
          : undefined;
        if (!schedulePublicId) {
          throw new ProblemError(
            500,
            'invalid_scheduling_record',
            'A saved shift could not be matched to its schedule.',
            'Scheduling data error',
          );
        }
        return serializeShift(shift, selected.publicId, schedulePublicId);
      });

      return {
        data: {
          permissions: [...new Set(identity.permissions)].sort(),
          locations: visibleLocations.map((location) => ({
            id: location.publicId,
            name: location.name,
            timezone: location.timezone,
          })),
          locationsTruncated: firstLocations.length > MAX_LOCATIONS,
          selectedLocationId: selected.publicId,
          staff: staffRows.map((person) => ({
            id: person.publicId,
            name: person.name || 'Unnamed',
            role: schedulableRole(person.role),
          })),
          schedules: schedules.map((schedule) => serializeSchedule(schedule, selected.publicId)),
          shifts: serializedShifts,
          range: {
            start: range.start.toISOString(),
            end: range.end.toISOString(),
          },
        },
        meta: { generatedAt: new Date().toISOString() },
      };
    });
  }
}
