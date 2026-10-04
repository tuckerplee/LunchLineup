import type {
  OperationsListQuery,
  ScheduleSummaryListResponse,
  SessionIdentity,
  ShiftSummaryListResponse,
  StaffRosterQuery,
  StaffRosterResponse,
} from '@lunchlineup/api-contract';
import { Prisma, UserRole } from '@prisma/client';
import type { MfaSessionObserver, MfaVerificationObservation } from '@lunchlineup/rbac';
import { authorizeCurrentMutation, assertCurrentMutation, mutationIdentity } from '../people/mutation-authority';
import { retryPayrollSerializableMutation } from '../payroll/domain';
import type { TenantDatabase, TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';
import { decodeCursor, page, parseLimit, parseWindow } from './pagination';
import { serializeSchedule, serializeShift } from './serialization';

const SCHEDULABLE_ROLES = [UserRole.MANAGER, UserRole.STAFF] as const;

export function immutableOperationsInput<T>(input: T): T {
  const copied = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  };
  freeze(copied);
  return copied;
}

export function operationsIdentity(input: SessionIdentity): SessionIdentity {
  return immutableOperationsInput(mutationIdentity(input));
}

/** Explicit owner wait: no ORM interception and no asynchronous guard work. */
export async function operationsWait<T>(assertCurrent: () => void, operation: () => PromiseLike<T>): Promise<T> {
  assertCurrent();
  const result = await operation();
  assertCurrent();
  return result;
}

export type OperationsAuthorityScope = {
  run<T>(operation: (transaction: TenantTransaction, current: SessionIdentity, assertCurrent: () => void) => Promise<T>): Promise<T>;
};

/** One released observation, never reminted by a phase/retry/receipt read. */
export async function prepareOperationsAuthority(
  database: Pick<TenantDatabase, 'withTenant'>,
  identity: SessionIdentity,
  permissions: readonly [string, ...string[]],
  observer?: Partial<MfaSessionObserver>,
): Promise<OperationsAuthorityScope> {
  identity = operationsIdentity(identity);
  permissions = Object.freeze([...permissions]) as readonly [string, ...string[]];
  const owner = observer, observe = owner?.observeSessionMfa;
  const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };
  const authorize = async (transaction: TenantTransaction) => {
    const authority = await authorizeCurrentMutation(transaction, identity, permissions[0]);
    for (const permission of permissions.slice(1)) {
      if (!authority.actorAccess.permissions.has(permission)) {
        throw new ProblemError(403, 'permission_denied', `${permission} permission is no longer active for this account.`, 'Forbidden');
      }
    }
    return authority;
  };
  const preflight = await retryPayrollSerializableMutation(() => database.withTenant(identity.tenantId, authorize, options));
  const requestExpiresAt = preflight.expiresAtEpochMs;
  let observation: MfaVerificationObservation | null = null;
  if (preflight.requiresMfa) {
    if (typeof observe !== 'function') {
      throw new ProblemError(503, 'identity_service_unavailable', 'Session validation is temporarily unavailable.', 'Service unavailable');
    }
    try {
      const value = await observe.call(owner, { ...preflight.identity });
      if (value) observation = Object.freeze({ sub: value.sub, tenantId: value.tenantId, sessionId: value.sessionId,
        expiresAtEpochMs: value.expiresAtEpochMs, expiresAtMonotonicMs: value.expiresAtMonotonicMs });
    } catch {
      throw new ProblemError(503, 'identity_service_unavailable', 'Session validation is temporarily unavailable.', 'Service unavailable');
    }
  }
  assertCurrentMutation(preflight, observation);
  return {
    run: <T>(operation: (transaction: TenantTransaction, current: SessionIdentity, assertCurrent: () => void) => Promise<T>): Promise<T> =>
      retryPayrollSerializableMutation(() => database.withTenant(identity.tenantId, async transaction => {
        const authority = await authorize(transaction);
        const current = immutableOperationsInput({ ...identity, sub: authority.actor.id, publicUserId: authority.actor.publicId,
          role: authority.actor.role, legacyRole: authority.actorAccess.legacyRole,
          permissions: [...authority.actorAccess.permissions], roles: authority.actorAccess.roles.map(role => ({
            id: role.publicId, name: role.name, isSystem: role.isSystem, legacyRole: role.legacyRole,
          })) });
        const assertCurrent = () => {
          if (requestExpiresAt <= Date.now()) {
            throw new ProblemError(403, 'permission_denied', 'The original request session deadline has expired.', 'Forbidden');
          }
          assertCurrentMutation(authority, observation);
        };
        assertCurrent();
        const result = await operation(transaction, current, assertCurrent);
        assertCurrent();
        return result;
      }, options)),
  };
}

/** Only bounded driver conflicts/connectivity failures can trigger receipt recovery. */
export function isOperationsReceiptRecovery(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  const code = candidate.code;
  const driverCode = code === 'P2010' ? candidate.meta?.code : undefined;
  return code === 'P2002' || code === 'P2034' || code === '40001' || code === '55P03'
    || code === 'P1001' || code === 'P1002' || code === 'P1008' || code === 'P1017'
    || code === 'P2024' || code === 'P2028'
    || (code === 'P2010' && (driverCode === '40001' || driverCode === '55P03'));
}

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
  constructor(private readonly database: Pick<TenantDatabase, 'withTenant'>,
    private readonly observer?: Partial<MfaSessionObserver>) {}

  async listSchedules(
    identity: SessionIdentity,
    query: OperationsListQuery,
  ): Promise<ScheduleSummaryListResponse> {
    identity = operationsIdentity(identity); query = immutableOperationsInput(query);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const window = parseWindow(query);
    const scope = await prepareOperationsAuthority(this.database, identity, ['schedules:read'], this.observer);
    return scope.run(async (transaction, identity, assertCurrent) => {
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
      assertCurrent();
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
    identity = operationsIdentity(identity); query = immutableOperationsInput(query);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const window = parseWindow(query);
    const scope = await prepareOperationsAuthority(this.database, identity, ['shifts:read'], this.observer);
    return scope.run(async (transaction, identity, assertCurrent) => {
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
      assertCurrent();
      const result = page(rows, limit, (row) => ({ timestamp: row.startTime, publicId: row.publicId }), window);
      return {
        data: result.data.map((row) => serializeShift(row)),
        pagination: result.pagination,
      };
    });
  }

  async staffRoster(identity: SessionIdentity, query: StaffRosterQuery): Promise<StaffRosterResponse> {
    identity = operationsIdentity(identity); query = immutableOperationsInput(query);
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const scope = await prepareOperationsAuthority(this.database, identity, ['shifts:read'], this.observer);
    return scope.run(async (transaction, identity, assertCurrent) => {
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
      assertCurrent();
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
