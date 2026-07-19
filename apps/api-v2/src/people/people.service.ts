import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { Prisma, type UserRole } from '@prisma/client';
import type {
  AccessCatalogResponse,
  AccessRoleResponse,
  ReplaceStaffAccessResponse,
  ResetStaffPinResponse,
  SessionIdentity,
  StaffAccessResponse,
  StaffDirectoryQuery,
  StaffDirectoryResponse,
  StaffInvitationDeliveryResponse,
  StaffInvitationRequest,
  StaffInvitationResponse,
  StaffLegacyRole,
  StaffMember,
  StaffSchedulingProfile,
  StaffSchedulingProfileRequest,
} from '@lunchlineup/api-contract';
import type { ApiV2Config } from '../config';
import type { TenantDatabase, TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';
import {
  MAX_CUSTOM_ROLES_PER_TENANT,
  MAX_ROLES_PER_USER,
  accessFor,
  accessFromIdentity,
  assignedRole,
  assertCanAdministerTarget,
  assertCanGrantPermissions,
  authorizeMutation,
  canDelegateRole,
  resolveTenantRolePublicIds,
  resolveTenantUserPublicIds,
  safeEmail,
  type RoleWithPermissions,
  withSerializable,
} from './access';
import { InvitationOutbox } from './invitation-outbox';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_SKILLS = 50;
const MAX_AVAILABILITY_WINDOWS = 21;
const MAX_SKILL_LENGTH = 64;
const USERNAME = /^[a-z0-9._-]{3,32}$/;
const EMAIL = /^[a-z0-9.!#$%*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PIN = /^\d{4,8}$/;
const SYSTEM_EMAIL_DOMAIN = 'staff.lunchlineup.local';
const WORKSPACE_SETTINGS_KEY = 'workspace_settings';

type UserCursor = { timestamp: string; publicId: string };
type AvailabilityWindow = {
  locationId: string | null;
  dayOfWeek: number;
  startTimeMinutes: number;
  endTimeMinutes: number;
};
type AvailabilityScope = { locationId: string | null; days: number[] };

function problem(status: number, code: string, detail: string, title?: string): ProblemError {
  return new ProblemError(status, code, detail, title ?? 'Request could not be completed');
}

function publicUser(row: {
  publicId: string;
  name: string;
  email: string | null;
  username: string | null;
  role: UserRole;
  pinHash: string | null;
  pinResetRequired: boolean;
}, roles: readonly RoleWithPermissions[]): StaffMember {
  return {
    id: row.publicId,
    name: row.name,
    email: safeEmail(row.email),
    username: row.username ?? '',
    role: row.role,
    pinEnabled: Boolean(row.pinHash),
    pinResetRequired: Boolean(row.pinResetRequired),
    assignedRoles: roles.map(assignedRole),
  };
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw problem(422, 'invalid_pagination', `limit must be an integer from 1 through ${MAX_LIST_LIMIT}.`, 'Pagination validation failed');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
    throw problem(422, 'invalid_pagination', `limit must be an integer from 1 through ${MAX_LIST_LIMIT}.`, 'Pagination validation failed');
  }
  return parsed;
}

function encodeCursor(cursor: UserCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, timestamp: cursor.timestamp, publicId: cursor.publicId }), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown): UserCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512) {
    throw problem(422, 'invalid_pagination', 'cursor is invalid.', 'Pagination validation failed');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed.v !== 1
      || typeof parsed.timestamp !== 'string'
      || Number.isNaN(new Date(parsed.timestamp).getTime())
      || typeof parsed.publicId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(parsed.publicId)
    ) throw new Error('invalid cursor');
    return { timestamp: parsed.timestamp, publicId: parsed.publicId };
  } catch {
    throw problem(422, 'invalid_pagination', 'cursor is invalid.', 'Pagination validation failed');
  }
}

function canonicalPermissions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw problem(422, 'invalid_permission_keys', 'permissionKeys must be an array.', 'Role validation failed');
  }
  const values = value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw problem(422, 'invalid_permission_keys', 'permissionKeys must only contain non-empty strings.', 'Role validation failed');
    }
    return entry.trim().toLowerCase();
  });
  return [...new Set(values)].sort();
}

function normalizedRoleIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw problem(422, 'invalid_role_ids', 'roleIds must be an array.', 'Access validation failed');
  }
  const ids = value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw problem(422, 'invalid_role_ids', 'roleIds must only contain non-empty strings.', 'Access validation failed');
    }
    return entry.trim();
  });
  const unique = [...new Set(ids)];
  if (unique.length > MAX_ROLES_PER_USER) {
    throw problem(422, 'invalid_role_ids', `A staff member may be assigned at most ${MAX_ROLES_PER_USER} roles.`, 'Access validation failed');
  }
  return unique;
}

function normalizedRoleName(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw problem(422, 'invalid_role_name', 'Role name is invalid.', 'Role validation failed');
  }
  const name = value.trim();
  if (!name || name.length > 80) {
    throw problem(422, 'invalid_role_name', 'Role name must contain 1 through 80 characters.', 'Role validation failed');
  }
  return name;
}

function normalizedDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw problem(422, 'invalid_role_description', 'Role description must be a string.', 'Role validation failed');
  }
  const description = value.trim();
  if (description.length > 240) {
    throw problem(422, 'invalid_role_description', 'Role description must contain at most 240 characters.', 'Role validation failed');
  }
  return description || null;
}

function roleSlug(name: string): string {
  const value = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return value || `role-${Date.now().toString(36)}`;
}

function temporaryPin(): string {
  return randomInt(100_000, 1_000_000).toString();
}

function hashPin(pin: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifiesPin(pin: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;
  const computed = scryptSync(pin, salt, 64).toString('hex');
  const left = Buffer.from(hash, 'utf8');
  const right = Buffer.from(computed, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function pinData(pin: string, pinResetRequired: boolean, now: Date) {
  if (!PIN.test(pin)) {
    throw problem(422, 'invalid_pin', 'PIN must be 4 through 8 numeric digits.', 'PIN validation failed');
  }
  return {
    pinHash: hashPin(pin),
    pinSetAt: now,
    pinResetRequired,
    pinLoginAttempts: 0,
    pinLockedUntil: null,
  };
}

function defaultInviteRole(value: unknown): StaffLegacyRole {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { team?: { defaultInviteRole?: unknown } }).team?.defaultInviteRole
    : undefined;
  return candidate === 'MANAGER' ? 'MANAGER' : 'STAFF';
}

function effectivePlanCode(tenant: {
  planTier: string;
  status: string;
  stripeSubscriptionId: string | null;
  stripeSubscriptionCurrentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
}, now = new Date()): string {
  const plan = ['FREE', 'STARTER', 'GROWTH', 'ENTERPRISE'].includes(tenant.planTier) ? tenant.planTier : 'FREE';
  if (plan === 'FREE') return plan;
  const paid = tenant.status === 'ACTIVE'
    && Boolean(tenant.stripeSubscriptionId?.trim())
    && tenant.stripeSubscriptionCurrentPeriodEnd !== null
    && tenant.stripeSubscriptionCurrentPeriodEnd > now;
  const trial = tenant.status === 'TRIAL' && tenant.trialEndsAt !== null && tenant.trialEndsAt > now;
  return paid || trial ? plan : 'FREE';
}

function normalizedProfile(body: StaffSchedulingProfileRequest): { skills: string[]; availability: AvailabilityWindow[] } {
  if (!Array.isArray(body.skills) || !Array.isArray(body.availability)) {
    throw problem(422, 'invalid_scheduling_profile', 'skills and availability must be arrays.', 'Scheduling profile validation failed');
  }
  if (body.skills.length > MAX_SKILLS || body.availability.length > MAX_AVAILABILITY_WINDOWS) {
    throw problem(422, 'invalid_scheduling_profile', 'Scheduling profile exceeds its supported limits.', 'Scheduling profile validation failed');
  }
  const skills = [...new Set(body.skills.map((value) => {
    if (typeof value !== 'string') throw problem(422, 'invalid_scheduling_profile', 'skills must only contain strings.', 'Scheduling profile validation failed');
    const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!normalized || normalized.length > MAX_SKILL_LENGTH) {
      throw problem(422, 'invalid_scheduling_profile', 'Each skill must contain 1 through 64 characters.', 'Scheduling profile validation failed');
    }
    return normalized;
  }))].sort();
  const availability = body.availability.map((raw, index) => {
    const day = Number(raw.dayOfWeek);
    const start = Number(raw.startTimeMinutes);
    const end = Number(raw.endTimeMinutes);
    if (!Number.isInteger(day) || day < 0 || day > 6 || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || start >= 1440 || end < 0 || end >= 1440 || start === end) {
      throw problem(422, 'invalid_scheduling_profile', `availability[${index}] is invalid.`, 'Scheduling profile validation failed');
    }
    return { locationId: raw.locationId ?? null, dayOfWeek: day, startTimeMinutes: start, endTimeMinutes: end };
  });
  const keys = availability.map((window) => [window.locationId ?? '*', window.dayOfWeek, window.startTimeMinutes, window.endTimeMinutes].join(':'));
  if (new Set(keys).size !== keys.length) {
    throw problem(422, 'invalid_scheduling_profile', 'availability contains duplicate windows.', 'Scheduling profile validation failed');
  }
  availability.sort((left, right) => left.dayOfWeek - right.dayOfWeek
    || left.startTimeMinutes - right.startTimeMinutes
    || left.endTimeMinutes - right.endTimeMinutes
    || (left.locationId ?? '').localeCompare(right.locationId ?? ''));
  return { skills, availability };
}

function availabilityScopes(before: AvailabilityWindow[], after: AvailabilityWindow[]): AvailabilityScope[] {
  const windowsByScopeDay = (rows: AvailabilityWindow[]) => {
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const key = `${row.locationId ?? '*'}:${row.dayOfWeek}`;
      const values = grouped.get(key) ?? [];
      values.push(`${row.startTimeMinutes}:${row.endTimeMinutes}`);
      grouped.set(key, values);
    }
    for (const values of grouped.values()) values.sort();
    return grouped;
  };
  const previous = windowsByScopeDay(before);
  const replacement = windowsByScopeDay(after);
  const changed = new Map<string | null, Set<number>>();
  for (const key of new Set([...previous.keys(), ...replacement.keys()])) {
    if (JSON.stringify(previous.get(key) ?? []) === JSON.stringify(replacement.get(key) ?? [])) continue;
    const separator = key.lastIndexOf(':');
    const locationId = key.slice(0, separator) === '*' ? null : key.slice(0, separator);
    const day = Number(key.slice(separator + 1));
    const days = changed.get(locationId) ?? new Set<number>();
    days.add(day);
    const values = [...(previous.get(key) ?? []), ...(replacement.get(key) ?? [])];
    if (values.some((value) => {
      const [start, end] = value.split(':').map(Number);
      return end <= start;
    })) days.add((day + 1) % 7);
    changed.set(locationId, days);
  }
  return [...changed.entries()].map(([locationId, days]) => ({
    locationId,
    days: [...days].sort((left, right) => left - right),
  }));
}

async function invalidateAffectedDraftSchedules(
  transaction: TenantTransaction,
  tenantId: string,
  changedSkills: string[],
  changedAvailability: AvailabilityScope[],
): Promise<void> {
  const predicates: Prisma.Sql[] = [];
  if (changedSkills.length > 0) predicates.push(Prisma.sql`TRUE`);
  for (const scope of changedAvailability) {
    const locationCondition = scope.locationId === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`schedule."locationId" = ${scope.locationId}`;
    predicates.push(Prisma.sql`
      (${locationCondition})
      AND EXISTS (
        SELECT 1
        FROM generate_series(
          (schedule."startDate" AT TIME ZONE 'UTC' AT TIME ZONE location."timezone")::date,
          ((schedule."endDate" - INTERVAL '1 millisecond') AT TIME ZONE 'UTC' AT TIME ZONE location."timezone")::date,
          INTERVAL '1 day'
        ) AS local_day
        WHERE EXTRACT(DOW FROM local_day)::int IN (${Prisma.join(scope.days)})
      )
    `);
  }
  if (predicates.length === 0) return;
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT schedule."id"
    FROM "Schedule" schedule
    JOIN "Location" location
      ON location."id" = schedule."locationId"
     AND location."tenantId" = schedule."tenantId"
     AND location."deletedAt" IS NULL
    WHERE schedule."tenantId" = ${tenantId}
      AND schedule."status" = 'DRAFT'
      AND schedule."deletedAt" IS NULL
      AND (${Prisma.join(predicates, ' OR ')})
    ORDER BY schedule."id" ASC
    FOR UPDATE OF schedule
  `);
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await transaction.schedule.updateMany({
      where: { id: { in: ids }, tenantId, status: 'DRAFT', deletedAt: null },
      data: { revision: { increment: 1 } },
    });
  }
}

function requestAudit(identity: SessionIdentity): { actorUserId: string; actorTenantId: string } {
  return { actorUserId: identity.sub, actorTenantId: identity.tenantId };
}

/** Native API-02 owner for people, roles, and invitation command state. */
export class PeopleService {
  private readonly invitationOutbox: InvitationOutbox;

  constructor(
    private readonly database: Pick<TenantDatabase, 'withTenant'>,
    config: Pick<ApiV2Config, 'staffInvitationOutboxEnabled' | 'staffInvitationOutboxEncryptionKey' | 'staffInvitationMaxAttempts'>,
  ) {
    this.invitationOutbox = new InvitationOutbox(config);
  }

  async list(identity: SessionIdentity, query: StaffDirectoryQuery): Promise<StaffDirectoryResponse> {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const rows = await transaction.user.findMany({
        where: {
          tenantId: identity.tenantId,
          deletedAt: null,
          ...(cursor ? {
            OR: [
              { createdAt: { gt: new Date(cursor.timestamp) } },
              { createdAt: new Date(cursor.timestamp), publicId: { gt: cursor.publicId } },
            ],
          } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { publicId: 'asc' }],
        take: limit + 1,
        select: {
          id: true,
          publicId: true,
          createdAt: true,
          name: true,
          email: true,
          username: true,
          role: true,
          pinHash: true,
          pinResetRequired: true,
        },
      });
      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const rolesByUser = await this.assignedRolesForUsers(transaction, identity.tenantId, visible.map((user) => user.id));
      const last = visible.at(-1);
      const response: StaffDirectoryResponse = {
        data: visible.map((user) => publicUser(user, rolesByUser.get(user.id) ?? [])),
        pagination: {
          limit,
          maxLimit: MAX_LIST_LIMIT,
          returned: visible.length,
          hasMore,
          nextCursor: hasMore && last
            ? encodeCursor({ timestamp: last.createdAt.toISOString(), publicId: last.publicId })
            : null,
        },
      };
      if (!cursor) response.summary = await this.directorySummary(transaction, identity.tenantId);
      return response;
    });
  }

  async accessCatalog(identity: SessionIdentity): Promise<AccessCatalogResponse> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const [permissions, roles, settings] = await Promise.all([
        transaction.permission.findMany({
          orderBy: [{ category: 'asc' }, { key: 'asc' }],
          select: { key: true, label: true, description: true, category: true },
        }),
        transaction.role.findMany({
          where: { tenantId: identity.tenantId, deletedAt: null },
          select: {
            id: true,
            publicId: true,
            name: true,
            slug: true,
            description: true,
            isSystem: true,
            isDefault: true,
            legacyRole: true,
            rolePermissions: { select: { permission: { select: { key: true } } } },
            _count: { select: { assignments: true } },
          },
          orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
          take: MAX_CUSTOM_ROLES_PER_TENANT + 4,
        }) as Promise<RoleWithPermissions[]>,
        transaction.tenantSetting.findUnique({
          where: { tenantId_key: { tenantId: identity.tenantId, key: WORKSPACE_SETTINGS_KEY } },
          select: { value: true },
        }),
      ]);
      const actorAccess = accessFromIdentity(identity);
      const configured = defaultInviteRole(settings?.value);
      const delegable = roles.filter((role) => canDelegateRole(actorAccess, role));
      const defaultRole = delegable.find((role) => role.legacyRole === configured)
        ?? delegable.find((role) => role.legacyRole === 'STAFF')
        ?? delegable[0];
      return {
        permissions: permissions.map((permission) => ({
          key: permission.key,
          label: permission.label,
          description: permission.description,
          category: permission.category,
        })),
        defaultInviteRoleId: defaultRole?.publicId ?? null,
        roles: roles.map((role) => ({
          ...assignedRole(role),
          slug: role.slug,
          isDefault: role.isDefault,
          userCount: role._count?.assignments ?? 0,
          canDelegate: canDelegateRole(actorAccess, role),
        })),
      };
    });
  }

  async get(identity: SessionIdentity, userPublicId: string): Promise<StaffMember> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { tenantId: identity.tenantId, publicId: userPublicId, deletedAt: null },
        select: {
          id: true, publicId: true, name: true, email: true, username: true,
          role: true, pinHash: true, pinResetRequired: true,
        },
      });
      if (!user) throw problem(404, 'staff_not_found', 'The selected staff member was not found.', 'Staff member not found');
      const roles = await this.assignedRolesForUsers(transaction, identity.tenantId, [user.id]);
      return publicUser(user, roles.get(user.id) ?? []);
    });
  }

  async schedulingProfile(identity: SessionIdentity, userPublicId: string): Promise<StaffSchedulingProfile> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const user = await transaction.user.findFirst({
        where: {
          tenantId: identity.tenantId,
          publicId: userPublicId,
          role: { in: ['MANAGER', 'STAFF'] },
          deletedAt: null,
          suspendedAt: null,
        },
        select: { id: true, publicId: true, name: true },
      });
      if (!user) throw problem(404, 'staff_not_found', 'The selected schedulable staff member was not found.', 'Staff member not found');
      const [skills, availability] = await Promise.all([
        transaction.staffSkill.findMany({
          where: { tenantId: identity.tenantId, userId: user.id },
          select: { skill: true },
          orderBy: { skill: 'asc' },
        }),
        transaction.staffAvailability.findMany({
          where: { tenantId: identity.tenantId, userId: user.id },
          select: {
            locationId: true, dayOfWeek: true, startTimeMinutes: true, endTimeMinutes: true,
            location: { select: { publicId: true } },
          },
          orderBy: [{ dayOfWeek: 'asc' }, { startTimeMinutes: 'asc' }, { locationId: 'asc' }],
        }),
      ]);
      return {
        user: { id: user.publicId, name: user.name },
        skills: skills.map((row) => row.skill),
        availability: availability.map((row) => ({
          locationId: row.location?.publicId ?? null,
          dayOfWeek: row.dayOfWeek,
          startTimeMinutes: row.startTimeMinutes,
          endTimeMinutes: row.endTimeMinutes,
        })),
        availabilityConfigured: availability.length > 0,
      };
    });
  }

  async replaceSchedulingProfile(
    identity: SessionIdentity,
    userPublicId: string,
    body: StaffSchedulingProfileRequest,
  ): Promise<StaffSchedulingProfile> {
    const profile = normalizedProfile(body);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { tenantId: identity.tenantId, publicId: userPublicId, deletedAt: null },
        select: { id: true, publicId: true, name: true },
      });
      if (!user) throw problem(404, 'staff_not_found', 'The selected staff member was not found.', 'Staff member not found');
      await authorizeMutation(transaction, identity, 'users:write', { targetUserId: user.id });
      await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:scheduling:${identity.tenantId}`}, 0))
      `);
      const requestedLocationPublicIds = [...new Set(profile.availability
        .map((window) => window.locationId)
        .filter((value): value is string => Boolean(value)))];
      const locations = requestedLocationPublicIds.length === 0 ? [] : await transaction.location.findMany({
        where: { tenantId: identity.tenantId, publicId: { in: requestedLocationPublicIds }, deletedAt: null },
        select: { id: true, publicId: true },
      });
      if (locations.length !== requestedLocationPublicIds.length) {
        throw problem(422, 'location_not_found', 'Every availability location must be an active workspace location.', 'Scheduling profile validation failed');
      }
      const internalLocationByPublicId = new Map(locations.map((location) => [location.publicId, location.id]));
      const replacement = profile.availability.map((window) => ({
        ...window,
        locationId: window.locationId ? internalLocationByPublicId.get(window.locationId) ?? null : null,
      }));
      const users = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "User"
        WHERE "id" = ${user.id} AND "tenantId" = ${identity.tenantId}
          AND "role" IN ('MANAGER'::"UserRole", 'STAFF'::"UserRole")
          AND "deletedAt" IS NULL AND "suspendedAt" IS NULL
        FOR UPDATE
      `);
      if (users.length !== 1) throw problem(404, 'staff_not_found', 'The selected schedulable staff member was not found.', 'Staff member not found');
      if (locations.length > 0) {
        const locked = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "Location"
          WHERE "tenantId" = ${identity.tenantId} AND "id" IN (${Prisma.join(locations.map((location) => location.id))})
            AND "deletedAt" IS NULL
          FOR UPDATE
        `);
        if (locked.length !== locations.length) {
          throw problem(422, 'location_not_found', 'Every availability location must be an active workspace location.', 'Scheduling profile validation failed');
        }
      }
      const [existingSkills, existingAvailability] = await Promise.all([
        transaction.staffSkill.findMany({
          where: { tenantId: identity.tenantId, userId: user.id },
          select: { skill: true }, orderBy: { skill: 'asc' },
        }),
        transaction.staffAvailability.findMany({
          where: { tenantId: identity.tenantId, userId: user.id },
          select: { locationId: true, dayOfWeek: true, startTimeMinutes: true, endTimeMinutes: true },
        }),
      ]);
      const previousSkills = existingSkills.map((row) => row.skill).sort();
      const changedSkills = [...new Set([
        ...previousSkills.filter((skill) => !profile.skills.includes(skill)),
        ...profile.skills.filter((skill) => !previousSkills.includes(skill)),
      ])].sort();
      await invalidateAffectedDraftSchedules(
        transaction,
        identity.tenantId,
        changedSkills,
        availabilityScopes(existingAvailability, replacement),
      );
      await transaction.staffAvailability.deleteMany({ where: { tenantId: identity.tenantId, userId: user.id } });
      await transaction.staffSkill.deleteMany({ where: { tenantId: identity.tenantId, userId: user.id } });
      if (profile.skills.length > 0) {
        await transaction.staffSkill.createMany({ data: profile.skills.map((skill) => ({ tenantId: identity.tenantId, userId: user.id, skill })) });
      }
      if (replacement.length > 0) {
        await transaction.staffAvailability.createMany({
          data: replacement.map((window) => ({ tenantId: identity.tenantId, userId: user.id, ...window })),
        });
      }
      return {
        user: { id: user.publicId, name: user.name },
        skills: profile.skills,
        availability: profile.availability,
        availabilityConfigured: profile.availability.length > 0,
      };
    });
  }

  async invite(identity: SessionIdentity, body: StaffInvitationRequest): Promise<StaffInvitationResponse> {
    const name = body.name.trim();
    const email = body.email?.trim().toLowerCase() ?? '';
    const username = body.username?.trim().toLowerCase() ?? '';
    const requestedPin = body.pin?.trim() ?? '';
    if (!name) throw problem(422, 'invalid_staff', 'Name is required.', 'Staff validation failed');
    if (!email && !username) throw problem(422, 'invalid_staff', 'Provide either email or username.', 'Staff validation failed');
    if (email && !EMAIL.test(email)) throw problem(422, 'invalid_staff', 'Email is invalid.', 'Staff validation failed');
    if (username && !USERNAME.test(username)) throw problem(422, 'invalid_staff', 'Username is invalid.', 'Staff validation failed');
    if (requestedPin && !PIN.test(requestedPin)) throw problem(422, 'invalid_pin', 'PIN must be 4 through 8 numeric digits.', 'Staff validation failed');
    if (email && username) throw problem(422, 'invalid_staff', 'Choose email login or username login, not both.', 'Staff validation failed');
    return withSerializable(this.database, identity.tenantId, async (transaction) => {
      const existing = await transaction.user.findFirst({
        where: { tenantId: identity.tenantId, ...(email ? { email } : { username }), },
        select: { id: true, deletedAt: true },
      });
      if (existing && !existing.deletedAt) {
        throw problem(409, 'staff_already_exists', 'A staff member already uses this login identity.', 'Staff conflict');
      }
      const authority = await authorizeMutation(transaction, identity, 'users:write', {
        ...(existing ? { targetUserId: existing.id, allowDeletedTarget: true } : {}),
      });
      if (authority.target && authority.targetAccess) {
        assertCanAdministerTarget(
          authority.actor,
          authority.actorAccess,
          authority.target,
          authority.targetAccess,
          'You cannot reactivate your own account.',
        );
      }
      await this.assertUserCapacity(transaction, identity.tenantId);
      const configured = await transaction.tenantSetting.findUnique({
        where: { tenantId_key: { tenantId: identity.tenantId, key: WORKSPACE_SETTINGS_KEY } },
        select: { value: true },
      });
      const selectedRole = body.roleId
        ? await transaction.role.findFirst({
          where: { tenantId: identity.tenantId, publicId: body.roleId, deletedAt: null },
          select: this.roleSelection(),
        })
        : await transaction.role.findFirst({
          where: {
            tenantId: identity.tenantId,
            deletedAt: null,
            isSystem: true,
            legacyRole: body.role ?? defaultInviteRole(configured?.value),
          },
          orderBy: { id: 'asc' },
          select: this.roleSelection(),
        });
      if (!selectedRole) throw problem(422, 'invalid_role', 'Selected role is invalid for this workspace.', 'Staff validation failed');
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Role"
        WHERE "id" = ${selectedRole.id} AND "tenantId" = ${identity.tenantId} AND "deletedAt" IS NULL
        FOR UPDATE
      `);
      const selected = await transaction.role.findFirst({
        where: { id: selectedRole.id, tenantId: identity.tenantId, deletedAt: null },
        select: this.roleSelection(),
      }) as RoleWithPermissions | null;
      if (!selected || !canDelegateRole(authority.actorAccess, selected)) {
        throw problem(403, 'permission_denied', 'You cannot grant the selected access role.', 'Forbidden');
      }
      const selectedPermissions = new Set(selected.rolePermissions.map((entry) => entry.permission.key.trim().toLowerCase()));
      if (email && !selectedPermissions.has('auth:login_email')) {
        throw problem(422, 'invalid_staff', 'Email login is not enabled for the selected role.', 'Staff validation failed');
      }
      if (username && !selectedPermissions.has('auth:login_pin')) {
        throw problem(422, 'invalid_staff', 'Username and PIN login are not enabled for the selected role.', 'Staff validation failed');
      }
      const now = new Date();
      const generatedPin = username ? (requestedPin || temporaryPin()) : null;
      const credentials = generatedPin ? pinData(generatedPin, !requestedPin, now) : {
        pinHash: null, pinSetAt: null, pinResetRequired: false, pinLoginAttempts: 0, pinLockedUntil: null,
      };
      const data = {
        email: email || null,
        username: username || null,
        name,
        role: selected.legacyRole ?? 'STAFF' as UserRole,
        passwordHash: null,
        oidcIssuer: null,
        oidcSubject: null,
        mfaEnabled: false,
        mfaSecret: null,
        mfaBackupCodes: [],
        loginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        ...credentials,
      };
      const user = existing
        ? await transaction.user.update({ where: { id: existing.id }, data: { ...data, deletedAt: null } })
        : await transaction.user.create({ data: { tenantId: identity.tenantId, ...data } });
      await transaction.roleAssignment.deleteMany({ where: { tenantId: identity.tenantId, userId: user.id } });
      await transaction.roleAssignment.create({ data: { tenantId: identity.tenantId, userId: user.id, roleId: selected.id } });
      if (existing) await this.invalidateReactivatedCredentials(transaction, identity.tenantId, user.id, now);
      const invitationDelivery = email
        ? await this.invitationOutbox.enqueue(transaction, { tenantId: identity.tenantId, userId: user.id, recipient: email })
        : { status: 'NOT_APPLICABLE' as const, attempts: 0, canRetry: false, canReissue: false };
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId,
          userId: identity.sub,
          ...requestAudit(identity),
          action: existing ? 'USER_REACTIVATED' : 'USER_INVITED',
          resource: 'User',
          resourceId: user.id,
        },
      });
      return {
        ...publicUser(user, [selected]),
        temporaryPin: generatedPin,
        invitationDelivery,
        status: 'INVITED',
      };
    });
  }

  async invitation(identity: SessionIdentity, userPublicId: string): Promise<StaffInvitationDeliveryResponse> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const internalId = await this.resolveUser(transaction, identity.tenantId, userPublicId);
      return { invitationDelivery: await this.invitationOutbox.status(transaction, identity.tenantId, internalId) };
    });
  }

  async retryInvitation(identity: SessionIdentity, userPublicId: string): Promise<StaffInvitationDeliveryResponse> {
    return withSerializable(this.database, identity.tenantId, async (transaction) => {
      const internalId = await this.resolveUser(transaction, identity.tenantId, userPublicId);
      const authority = await authorizeMutation(transaction, identity, 'users:admin', { targetUserId: internalId });
      assertCanAdministerTarget(authority.actor, authority.actorAccess, authority.target!, authority.targetAccess!, 'You cannot retry your own invitation delivery.');
      return { invitationDelivery: await this.invitationOutbox.retry(transaction, {
        tenantId: identity.tenantId, userId: internalId, actorUserId: identity.sub,
      }) };
    });
  }

  async reissueInvitation(
    identity: SessionIdentity,
    userPublicId: string,
    idempotencyKey: string | undefined,
  ): Promise<StaffInvitationDeliveryResponse> {
    return withSerializable(this.database, identity.tenantId, async (transaction) => {
      const internalId = await this.resolveUser(transaction, identity.tenantId, userPublicId);
      const authority = await authorizeMutation(transaction, identity, 'users:admin', { targetUserId: internalId });
      assertCanAdministerTarget(authority.actor, authority.actorAccess, authority.target!, authority.targetAccess!, 'You cannot reissue your own invitation delivery.');
      return { invitationDelivery: await this.invitationOutbox.reissue(transaction, {
        tenantId: identity.tenantId, userId: internalId, actorUserId: identity.sub, idempotencyKey,
      }) };
    });
  }

  async resetPin(identity: SessionIdentity, userPublicId: string, requestedPin?: string): Promise<ResetStaffPinResponse> {
    const newPin = requestedPin?.trim() || temporaryPin();
    if (!PIN.test(newPin)) throw problem(422, 'invalid_pin', 'PIN must be 4 through 8 numeric digits.', 'PIN validation failed');
    return withSerializable(this.database, identity.tenantId, async (transaction) => {
      const internalId = await this.resolveUser(transaction, identity.tenantId, userPublicId);
      const authority = await authorizeMutation(transaction, identity, 'users:admin', { targetUserId: internalId });
      assertCanAdministerTarget(authority.actor, authority.actorAccess, authority.target!, authority.targetAccess!, 'Use the self-service PIN rotation route for your own account.');
      const target = await transaction.user.findFirst({
        where: { id: internalId, tenantId: identity.tenantId, deletedAt: null },
        select: { id: true, publicId: true, name: true, email: true, username: true },
      });
      if (!target) throw problem(404, 'staff_not_found', 'The selected staff member was not found.', 'Staff member not found');
      let username = target.username;
      if (!username) {
        if (target.email && !target.email.endsWith(`@${SYSTEM_EMAIL_DOMAIN}`)) {
          throw problem(422, 'pin_reset_unavailable', 'PIN reset is only available for username accounts.', 'PIN reset unavailable');
        }
        username = await this.uniqueUsername(transaction, identity.tenantId, target.name);
      }
      const now = new Date();
      await transaction.user.updateMany({
        where: { id: target.id, tenantId: identity.tenantId, deletedAt: null },
        data: { username, ...pinData(newPin, true, now) },
      });
      const sessions = await transaction.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: now } });
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId, userId: identity.sub, ...requestAudit(identity),
          action: 'USER_PIN_RESET', resource: 'User', resourceId: target.id,
          newValue: { pinResetRequired: true, sessionsRevoked: sessions.count },
        },
      });
      return { id: target.publicId, username, temporaryPin: newPin, pinResetRequired: true };
    });
  }

  async replaceOwnPin(identity: SessionIdentity, currentPin: string, newPin: string): Promise<void> {
    if (!PIN.test(currentPin) || !PIN.test(newPin)) {
      throw problem(422, 'invalid_pin', 'PIN must be 4 through 8 numeric digits.', 'PIN validation failed');
    }
    if (currentPin === newPin) {
      throw problem(422, 'invalid_pin', 'New PIN must differ from the current PIN.', 'PIN validation failed');
    }
    await withSerializable(this.database, identity.tenantId, async (transaction) => {
      const authority = await authorizeMutation(transaction, identity, 'auth:login_pin');
      const user = await transaction.user.findFirst({
        where: { id: authority.actor.id, tenantId: identity.tenantId, deletedAt: null, suspendedAt: null },
        select: { id: true, username: true, pinHash: true },
      });
      if (!user || !user.username || !user.pinHash) {
        throw problem(403, 'pin_rotation_unavailable', 'PIN rotation is only available for username accounts.', 'Forbidden');
      }
      if (!verifiesPin(currentPin, user.pinHash)) {
        throw problem(401, 'invalid_current_pin', 'Current PIN is invalid.', 'Unauthorized');
      }
      const now = new Date();
      await transaction.user.updateMany({
        where: { id: user.id, tenantId: identity.tenantId, deletedAt: null, suspendedAt: null },
        data: pinData(newPin, false, now),
      });
      const sessions = await transaction.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId, userId: user.id, ...requestAudit(identity),
          action: 'USER_PIN_ROTATED', resource: 'User', resourceId: user.id,
          newValue: { pinResetRequired: false, sessionsRevoked: sessions.count },
        },
      });
    });
  }

  async access(identity: SessionIdentity, userPublicId: string): Promise<StaffAccessResponse> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { tenantId: identity.tenantId, publicId: userPublicId, deletedAt: null },
        select: { id: true, role: true },
      });
      if (!user) throw problem(404, 'staff_not_found', 'The selected staff member was not found.', 'Staff member not found');
      const roles = await this.assignedRolesForUsers(transaction, identity.tenantId, [user.id]);
      const snapshot = accessFor(user.role, roles.get(user.id) ?? []);
      if (snapshot.roles.length === 0) {
        throw problem(401, 'access_not_configured', 'Staff access has not been configured.', 'Unauthorized');
      }
      return {
        primaryRole: snapshot.roles[0]?.name ?? 'Unknown role',
        roles: snapshot.roles.map((role) => ({
          id: role.publicId,
          name: role.name,
          isSystem: role.isSystem,
          legacyRole: role.legacyRole,
        })),
        permissions: [...snapshot.permissions].sort(),
      };
    });
  }

  async replaceAccess(
    identity: SessionIdentity,
    userPublicId: string,
    rolePublicIds: unknown,
  ): Promise<ReplaceStaffAccessResponse> {
    const requested = normalizedRoleIds(rolePublicIds);
    return withSerializable(this.database, identity.tenantId, async (transaction) => {
      const internalId = await this.resolveUser(transaction, identity.tenantId, userPublicId);
      const authority = await authorizeMutation(transaction, identity, 'roles:assign', { targetUserId: internalId });
      assertCanAdministerTarget(authority.actor, authority.actorAccess, authority.target!, authority.targetAccess!, 'You cannot change your own access roles.');
      const mapping = await resolveTenantRolePublicIds(transaction, identity.tenantId, requested);
      if (mapping.size !== requested.length) {
        throw problem(422, 'invalid_role', 'One or more roles are invalid for this workspace.', 'Access validation failed');
      }
      const roleIds = requested.map((id) => mapping.get(id)!);
      for (const roleId of roleIds) {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id" FROM "Role" WHERE "id" = ${roleId} AND "tenantId" = ${identity.tenantId} AND "deletedAt" IS NULL FOR UPDATE
        `);
      }
      const roles = roleIds.length === 0 ? [] : await transaction.role.findMany({
        where: { tenantId: identity.tenantId, id: { in: roleIds }, deletedAt: null },
        select: this.roleSelection(), orderBy: { id: 'asc' },
      }) as RoleWithPermissions[];
      if (roles.length !== roleIds.length) throw problem(422, 'invalid_role', 'One or more roles are invalid for this workspace.', 'Access validation failed');
      if (roles.some((role) => !canDelegateRole(authority.actorAccess, role))) {
        throw problem(403, 'permission_denied', 'You cannot grant one or more selected access roles.', 'Forbidden');
      }
      await transaction.roleAssignment.deleteMany({ where: { tenantId: identity.tenantId, userId: internalId } });
      if (roleIds.length > 0) {
        await transaction.roleAssignment.createMany({
          data: roleIds.map((roleId) => ({ tenantId: identity.tenantId, userId: internalId, roleId })),
          skipDuplicates: true,
        });
      }
      const legacyRole = roles.reduce<UserRole>((current, role) => (
        role.isSystem && role.legacyRole && ['STAFF', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'].indexOf(role.legacyRole) > ['STAFF', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'].indexOf(current)
          ? role.legacyRole
          : current
      ), 'STAFF');
      await transaction.user.update({ where: { id: internalId }, data: { role: legacyRole } });
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId, userId: identity.sub, ...requestAudit(identity),
          action: 'USER_ACCESS_UPDATED', resource: 'User', resourceId: internalId,
          newValue: { roleIds: roles.map((role) => role.publicId).sort() },
        },
      });
      return { id: userPublicId, assignedRoles: roles.map(assignedRole) };
    });
  }

  async createRole(identity: SessionIdentity, body: { name: string; description?: string; permissionKeys: string[] }): Promise<AccessRoleResponse> {
    const name = normalizedRoleName(body.name);
    const description = normalizedDescription(body.description);
    const permissionKeys = canonicalPermissions(body.permissionKeys);
    return withSerializable(this.database, identity.tenantId, async (transaction) => {
      const authority = await authorizeMutation(transaction, identity, 'roles:write');
      assertCanGrantPermissions(authority.actorAccess, permissionKeys);
      const permissions = permissionKeys.length === 0 ? [] : await transaction.permission.findMany({
        where: { key: { in: permissionKeys } }, select: { id: true, key: true },
      });
      if (permissions.length !== permissionKeys.length) {
        throw problem(422, 'invalid_permission_keys', 'One or more permissions are invalid.', 'Role validation failed');
      }
      const count = await transaction.role.count({ where: { tenantId: identity.tenantId, isSystem: false, deletedAt: null } });
      if (count >= MAX_CUSTOM_ROLES_PER_TENANT) {
        throw problem(422, 'role_limit_reached', `A workspace may configure at most ${MAX_CUSTOM_ROLES_PER_TENANT} custom roles.`, 'Role validation failed');
      }
      const role = await transaction.role.create({
        data: {
          tenantId: identity.tenantId,
          name,
          slug: roleSlug(name),
          description,
          isSystem: false,
          rolePermissions: { createMany: { data: permissions.map((permission) => ({ permissionId: permission.id })) } },
        },
        select: { ...this.roleSelection(), _count: { select: { assignments: true } } },
      }) as RoleWithPermissions;
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId, userId: identity.sub, ...requestAudit(identity),
          action: 'ACCESS_ROLE_CREATED', resource: 'Role', resourceId: role.id,
          oldValue: { name: null, description: null, permissions: [] },
          newValue: { name, description, permissions: permissionKeys },
        },
      });
      return this.roleResponse(role, true);
    });
  }

  async updateRole(
    identity: SessionIdentity,
    rolePublicId: string,
    body: { name: string; description?: string; permissionKeys: string[] },
  ): Promise<AccessRoleResponse> {
    const name = normalizedRoleName(body.name);
    const description = normalizedDescription(body.description);
    const permissionKeys = canonicalPermissions(body.permissionKeys);
    return withSerializable(this.database, identity.tenantId, async (transaction) => {
      const authority = await authorizeMutation(transaction, identity, 'roles:write');
      assertCanGrantPermissions(authority.actorAccess, permissionKeys);
      const role = await transaction.role.findFirst({
        where: { tenantId: identity.tenantId, publicId: rolePublicId, deletedAt: null },
        select: this.roleSelection(),
      }) as RoleWithPermissions | null;
      if (!role) throw problem(404, 'role_not_found', 'The selected access role was not found.', 'Role not found');
      if (role.isSystem) throw problem(403, 'system_role_immutable', 'System access roles cannot be modified.', 'Forbidden');
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Role" WHERE "id" = ${role.id} AND "tenantId" = ${identity.tenantId} AND "deletedAt" IS NULL FOR UPDATE
      `);
      const permissions = permissionKeys.length === 0 ? [] : await transaction.permission.findMany({
        where: { key: { in: permissionKeys } }, select: { id: true, key: true },
      });
      if (permissions.length !== permissionKeys.length) {
        throw problem(422, 'invalid_permission_keys', 'One or more permissions are invalid.', 'Role validation failed');
      }
      await transaction.rolePermission.deleteMany({ where: { roleId: role.id } });
      const updated = await transaction.role.update({
        where: { id: role.id },
        data: {
          name,
          description,
          rolePermissions: { createMany: { data: permissions.map((permission) => ({ permissionId: permission.id })) } },
        },
        select: { ...this.roleSelection(), _count: { select: { assignments: true } } },
      }) as RoleWithPermissions;
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId, userId: identity.sub, ...requestAudit(identity),
          action: 'ACCESS_ROLE_UPDATED', resource: 'Role', resourceId: role.id,
          oldValue: { name: role.name, description: role.description, permissions: role.rolePermissions.map((item) => item.permission.key).sort() },
          newValue: { name, description, permissions: permissionKeys },
        },
      });
      return this.roleResponse(updated, true);
    });
  }

  async deleteRole(identity: SessionIdentity, rolePublicId: string): Promise<void> {
    await withSerializable(this.database, identity.tenantId, async (transaction) => {
      await authorizeMutation(transaction, identity, 'roles:write');
      const role = await transaction.role.findFirst({
        where: { tenantId: identity.tenantId, publicId: rolePublicId, deletedAt: null },
        select: { id: true, name: true, isSystem: true },
      });
      if (!role) throw problem(404, 'role_not_found', 'The selected access role was not found.', 'Role not found');
      if (role.isSystem) throw problem(403, 'system_role_immutable', 'System access roles cannot be deleted.', 'Forbidden');
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Role" WHERE "id" = ${role.id} AND "tenantId" = ${identity.tenantId} AND "deletedAt" IS NULL FOR UPDATE
      `);
      const assignments = await transaction.roleAssignment.count({ where: { tenantId: identity.tenantId, roleId: role.id } });
      if (assignments > 0) {
        throw problem(409, 'role_in_use', `Role cannot be deleted while ${assignments} ${assignments === 1 ? 'assignment exists' : 'assignments exist'}.`, 'Role conflict');
      }
      await transaction.role.update({ where: { id: role.id }, data: { deletedAt: new Date() } });
      await transaction.auditLog.create({
        data: {
          tenantId: identity.tenantId, userId: identity.sub, ...requestAudit(identity),
          action: 'ACCESS_ROLE_DELETED', resource: 'Role', resourceId: role.id,
          oldValue: { name: role.name }, newValue: { deleted: true },
        },
      });
    });
  }

  async resolvePublicUserIds(tenantId: string, publicIds: readonly string[]): Promise<Map<string, string>> {
    return this.database.withTenant(tenantId, (transaction) => resolveTenantUserPublicIds(transaction, tenantId, publicIds));
  }

  async resolveInternalUserIds(tenantId: string, internalIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(internalIds)];
    if (ids.length === 0) return new Map();
    return this.database.withTenant(tenantId, async (transaction) => {
      const rows = await transaction.user.findMany({
        where: { tenantId, id: { in: ids } }, select: { id: true, publicId: true },
      });
      return new Map(rows.map((row) => [row.id, row.publicId]));
    });
  }

  private async resolveUser(transaction: TenantTransaction, tenantId: string, publicId: string): Promise<string> {
    const user = await transaction.user.findFirst({
      where: { tenantId, publicId, deletedAt: null }, select: { id: true },
    });
    if (!user) throw problem(404, 'staff_not_found', 'The selected staff member was not found.', 'Staff member not found');
    return user.id;
  }

  private async assignedRolesForUsers(
    transaction: TenantTransaction,
    tenantId: string,
    userIds: readonly string[],
  ): Promise<Map<string, RoleWithPermissions[]>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const assignments = await transaction.roleAssignment.findMany({
      where: { tenantId, userId: { in: ids }, role: { tenantId, deletedAt: null } },
      select: {
        userId: true,
        role: { select: this.roleSelection() },
      },
      orderBy: [{ userId: 'asc' }, { roleId: 'asc' }],
    }) as Array<{ userId: string; role: RoleWithPermissions }>;
    const output = new Map<string, RoleWithPermissions[]>();
    for (const assignment of assignments) {
      const roles = output.get(assignment.userId) ?? [];
      roles.push(assignment.role);
      output.set(assignment.userId, roles);
    }
    return output;
  }

  private async directorySummary(transaction: TenantTransaction, tenantId: string) {
    const [summary] = await transaction.$queryRaw<Array<{
      totalUsers: number | bigint;
      staffCount: number | bigint;
      managerCount: number | bigint;
      privilegedUsers: number | bigint;
      pinAccounts: number | bigint;
    }>>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "totalUsers",
        COUNT(*) FILTER (WHERE user_row."role" IN ('MANAGER', 'STAFF'))::int AS "staffCount",
        COUNT(*) FILTER (WHERE user_row."role" = 'MANAGER')::int AS "managerCount",
        COUNT(*) FILTER (
          WHERE user_row."role" IN ('SUPER_ADMIN', 'ADMIN')
             OR EXISTS (
                SELECT 1 FROM "RoleAssignment" assignment
                JOIN "Role" role ON role."id" = assignment."roleId" AND role."tenantId" = assignment."tenantId" AND role."deletedAt" IS NULL
                JOIN "RolePermission" role_permission ON role_permission."roleId" = role."id"
                JOIN "Permission" permission ON permission."id" = role_permission."permissionId"
                WHERE assignment."tenantId" = user_row."tenantId"
                  AND assignment."userId" = user_row."id"
                  AND permission."key" IN ('roles:assign', 'users:admin')
             )
        )::int AS "privilegedUsers",
        COUNT(*) FILTER (WHERE user_row."username" IS NOT NULL)::int AS "pinAccounts"
      FROM "User" user_row
      WHERE user_row."tenantId" = ${tenantId} AND user_row."deletedAt" IS NULL
    `);
    return {
      totalUsers: Number(summary?.totalUsers ?? 0),
      staffCount: Number(summary?.staffCount ?? 0),
      managerCount: Number(summary?.managerCount ?? 0),
      privilegedUsers: Number(summary?.privilegedUsers ?? 0),
      pinAccounts: Number(summary?.pinAccounts ?? 0),
    };
  }

  private roleSelection() {
    return {
      id: true,
      publicId: true,
      name: true,
      slug: true,
      description: true,
      isSystem: true,
      isDefault: true,
      legacyRole: true,
      rolePermissions: { select: { permission: { select: { key: true } } } },
    } as const;
  }

  private roleResponse(role: RoleWithPermissions, includeCount: boolean): AccessRoleResponse {
    return {
      id: role.publicId,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      ...(includeCount ? { userCount: role._count?.assignments ?? 0 } : {}),
      permissions: role.rolePermissions.map((item) => item.permission.key.trim().toLowerCase()).sort(),
    };
  }

  private async assertUserCapacity(transaction: TenantTransaction, tenantId: string): Promise<void> {
    await transaction.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
    const tenant = await transaction.tenant.findUnique({
      where: { id: tenantId },
      select: { planTier: true, status: true, stripeSubscriptionId: true, stripeSubscriptionCurrentPeriodEnd: true, trialEndsAt: true },
    });
    if (!tenant) throw problem(404, 'tenant_not_found', 'The signed-in workspace was not found.', 'Not found');
    const plan = await transaction.planDefinition.findUnique({
      where: { code: effectivePlanCode(tenant) as never },
      select: { code: true, userLimit: true },
    });
    if (!plan) throw problem(503, 'plan_configuration_unavailable', 'Staff capacity is temporarily unavailable.', 'Service unavailable');
    if (plan.userLimit === null) return;
    const count = await transaction.user.count({ where: { tenantId, deletedAt: null, suspendedAt: null } });
    if (count >= plan.userLimit) {
      throw problem(422, 'staff_limit_reached', `Staff limit reached for ${plan.code} plan.`, 'Staff capacity reached');
    }
  }

  private async invalidateReactivatedCredentials(
    transaction: TenantTransaction,
    tenantId: string,
    userId: string,
    now: Date,
  ): Promise<void> {
    await transaction.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await transaction.passwordResetToken.updateMany({ where: { tenantId, userId, consumedAt: null }, data: { consumedAt: now } });
    await transaction.passwordResetEmailOutbox.updateMany({
      where: { tenantId, userId, status: { in: ['PENDING', 'SENDING', 'FAILED'] } },
      data: { status: 'DEAD_LETTERED', deadLetteredAt: now, leaseUntil: null, lastError: 'User credentials reprovisioned' },
    });
    await transaction.mfaTotpClaim.deleteMany({ where: { tenantId, userId } });
  }

  private async uniqueUsername(transaction: TenantTransaction, tenantId: string, name: string): Promise<string> {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 28) || 'staff.user';
    const seed = base.length < 3 ? `${base}.usr` : base;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? seed : `${seed.slice(0, 24)}.${randomInt(1000, 10_000)}`;
      const taken = await transaction.user.findFirst({ where: { tenantId, username: candidate }, select: { id: true } });
      if (!taken) return candidate;
    }
    return `${seed.slice(0, 20)}.${Date.now().toString().slice(-6)}`;
  }
}
