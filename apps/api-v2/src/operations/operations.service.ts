import type {
  OperationsListQuery,
  ScheduleSummaryListResponse,
  SessionIdentity,
  ShiftSummaryListResponse,
  StaffRosterQuery,
  StaffRosterResponse,
} from '@lunchlineup/api-contract';
import { UserRole } from '@prisma/client';
import type { TenantDatabase } from '../platform/database';
import { decodeCursor, page, parseLimit, parseWindow } from './pagination';
import { serializeSchedule, serializeShift } from './serialization';

const SCHEDULABLE_ROLES = [UserRole.MANAGER, UserRole.STAFF] as const;

function normalizedRole(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/[\s-]+/g, '_').toUpperCase() : '';
}

export function isStaffIdentity(identity: SessionIdentity): boolean {
  return [
    identity.legacyRole,
    identity.role,
    ...identity.roles.flatMap((role) => [role.name, role.legacyRole]),
  ].some((role) => normalizedRole(role) === 'STAFF');
}

const schedulableShiftUserFilter = {
  OR: [
    { userId: null },
    {
      user: {
        is: {
          role: { in: [...SCHEDULABLE_ROLES] },
          deletedAt: null,
          suspendedAt: null,
        },
      },
    },
  ],
};

/**
 * Native, screen-independent operational read models. List cursors and every
 * externally visible reference use generated public UUIDs, never storage IDs.
 */
export class OperationsService {
  constructor(private readonly database: Pick<TenantDatabase, 'withTenant'>) {}

  async listSchedules(
    identity: SessionIdentity,
    query: OperationsListQuery,
  ): Promise<ScheduleSummaryListResponse> {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const window = parseWindow(query);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const where: Record<string, unknown> = {
        tenantId: identity.tenantId,
        deletedAt: null,
        location: {
          is: {
            deletedAt: null,
            ...(query.locationId ? { publicId: query.locationId } : {}),
          },
        },
      };
      const and: Record<string, unknown>[] = [];
      if (window.startDate) and.push({ endDate: { gt: window.startDate } });
      if (window.endDate) and.push({ startDate: { lt: window.endDate } });
      if (cursor) {
        and.push({
          OR: [
            { startDate: { lt: cursor.timestamp } },
            { startDate: cursor.timestamp, publicId: { lt: cursor.publicId } },
          ],
        });
      }
      if (isStaffIdentity(identity)) {
        where.status = 'PUBLISHED';
        where.shifts = {
          some: {
            tenantId: identity.tenantId,
            userId: identity.sub,
            deletedAt: null,
          },
        };
      }
      if (and.length > 0) where.AND = and;
      const rows = await transaction.schedule.findMany({
        where: where as never,
        orderBy: [{ startDate: 'desc' }, { publicId: 'desc' }],
        take: limit + 1,
        select: {
          publicId: true,
          startDate: true,
          endDate: true,
          status: true,
          publishedAt: true,
          revision: true,
          location: { select: { publicId: true } },
        },
      });
      const result = page(rows, limit, (row) => ({ timestamp: row.startDate, publicId: row.publicId }), window);
      return {
        data: result.data.map((row) => serializeSchedule(row)),
        pagination: result.pagination,
      };
    });
  }

  async listShifts(
    identity: SessionIdentity,
    query: OperationsListQuery,
  ): Promise<ShiftSummaryListResponse> {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const window = parseWindow(query);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const scheduleFilter: Record<string, unknown> = {
        ...(query.scheduleId ? { publicId: query.scheduleId } : {}),
      };
      if (isStaffIdentity(identity)) {
        scheduleFilter.status = 'PUBLISHED';
        scheduleFilter.deletedAt = null;
      }
      const where: Record<string, unknown> = {
        tenantId: identity.tenantId,
        deletedAt: null,
        location: {
          is: {
            deletedAt: null,
            ...(query.locationId ? { publicId: query.locationId } : {}),
          },
        },
        AND: [schedulableShiftUserFilter],
      };
      if (Object.keys(scheduleFilter).length > 0) where.schedule = { is: scheduleFilter };
      if (isStaffIdentity(identity)) where.userId = identity.sub;
      const and = where.AND as Record<string, unknown>[];
      if (window.startDate) and.push({ endTime: { gt: window.startDate } });
      if (window.endDate) and.push({ startTime: { lt: window.endDate } });
      if (cursor) {
        and.push({
          OR: [
            { startTime: { gt: cursor.timestamp } },
            { startTime: cursor.timestamp, publicId: { gt: cursor.publicId } },
          ],
        });
      }
      const rows = await transaction.shift.findMany({
        where: where as never,
        orderBy: [{ startTime: 'asc' }, { publicId: 'asc' }],
        take: limit + 1,
        select: {
          publicId: true,
          userId: true,
          startTime: true,
          endTime: true,
          role: true,
          location: { select: { publicId: true } },
          schedule: { select: { publicId: true } },
          user: { select: { publicId: true, name: true, role: true } },
          breaks: {
            orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
            select: { id: true, type: true, startTime: true, endTime: true, paid: true },
          },
        },
      });
      const result = page(rows, limit, (row) => ({ timestamp: row.startTime, publicId: row.publicId }), window);
      return {
        data: result.data.map((row) => serializeShift(row)),
        pagination: result.pagination,
      };
    });
  }

  async staffRoster(identity: SessionIdentity, query: StaffRosterQuery): Promise<StaffRosterResponse> {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const rows = await transaction.user.findMany({
        where: {
          tenantId: identity.tenantId,
          deletedAt: null,
          suspendedAt: null,
          role: { in: [...SCHEDULABLE_ROLES] },
          ...(isStaffIdentity(identity) ? { id: identity.sub } : {}),
          ...(cursor ? { publicId: { gt: cursor.publicId } } : {}),
        },
        orderBy: { publicId: 'asc' },
        take: limit + 1,
        select: { publicId: true, name: true, role: true },
      });
      const result = page(rows, limit, (row) => ({ timestamp: new Date(0), publicId: row.publicId }));
      return {
        data: result.data.map((row) => ({
          id: row.publicId,
          name: row.name || 'Unnamed',
          role: row.role === 'MANAGER' ? 'MANAGER' : 'STAFF',
        })),
        pagination: result.pagination,
      };
    });
  }
}
