import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  LocationCreateRequest,
  LocationListQuery,
  LocationListResponse,
  LocationRecord,
  LocationSummaryResponse,
  LocationUpdateRequest,
  SessionIdentity,
} from '@lunchlineup/api-contract';
import type { TenantDatabase, TenantTransaction } from '../platform/database';
import { ProblemError } from '../platform/problem';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const MAX_LOCATION_NAME_LENGTH = 200;
const MAX_LOCATION_ADDRESS_LENGTH = 500;
const MAX_TIME_ZONE_LENGTH = 100;
const MAX_TENANT_NAME_LENGTH = 200;
const MAX_WORKSPACE_SLUG_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

type LocationCursor = {
  name: string;
  publicId: string;
};

type LocationRow = {
  publicId: string;
  name: string;
  address: string | null;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
};

type LockedLocation = {
  id: string;
  publicId: string;
  timezone: string;
};

type LockedSchedule = {
  id: string;
  status: string;
};

type NormalizedCreate = {
  name: string;
  address: string | null;
  timezone: string;
  tenantName: string | null;
  workspaceSlug: string | null;
};

type NormalizedUpdate = {
  name?: string;
  address?: string | null;
  timezone: string;
};

type IdempotencyIdentity = {
  keyHash: string;
  requestHash: string;
};

function publicLocation(row: LocationRow): LocationRecord {
  return {
    id: row.publicId,
    name: row.name,
    address: row.address,
    timezone: row.timezone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function invalidInput(detail: string): ProblemError {
  return new ProblemError(422, 'invalid_location_input', detail, 'Location validation failed');
}

function normalizeText(value: unknown, field: string, maximum: number, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw invalidInput(`${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw invalidInput(`${field} must be a string.`);
  const normalized = value.trim();
  if (required && !normalized) throw invalidInput(`${field} is required.`);
  if (normalized.length > maximum) throw invalidInput(`${field} must be at most ${maximum} characters.`);
  return normalized || null;
}

function normalizeTimeZone(value: unknown): string {
  const timeZone = normalizeText(value, 'timezone', MAX_TIME_ZONE_LENGTH, true);
  if (!timeZone) throw invalidInput('timezone is required.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return timeZone;
  } catch {
    throw new ProblemError(
      422,
      'invalid_timezone',
      'Location timezone must be a valid IANA timezone.',
      'Location validation failed',
    );
  }
}

function parseCreate(body: LocationCreateRequest): NormalizedCreate {
  const name = normalizeText(body.name, 'name', MAX_LOCATION_NAME_LENGTH, true);
  const address = normalizeText(body.address, 'address', MAX_LOCATION_ADDRESS_LENGTH);
  const tenantName = normalizeText(body.tenantName, 'tenantName', MAX_TENANT_NAME_LENGTH);
  const workspaceSlug = normalizeText(body.workspaceSlug, 'workspaceSlug', MAX_WORKSPACE_SLUG_LENGTH)?.toLowerCase() ?? null;
  if (tenantName && !workspaceSlug) {
    throw new ProblemError(
      422,
      'workspace_slug_required',
      'workspaceSlug is required for first-location setup.',
      'Location validation failed',
    );
  }
  return {
    name: name ?? '',
    address,
    timezone: normalizeTimeZone(body.timezone),
    tenantName: tenantName?.replace(/\s+/g, ' ') ?? null,
    workspaceSlug,
  };
}

function parseUpdate(body: LocationUpdateRequest): NormalizedUpdate {
  const output: NormalizedUpdate = { timezone: normalizeTimeZone(body.timezone) };
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    output.name = normalizeText(body.name, 'name', MAX_LOCATION_NAME_LENGTH, true) ?? '';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'address')) {
    output.address = normalizeText(body.address, 'address', MAX_LOCATION_ADDRESS_LENGTH);
  }
  return output;
}

function encodeCursor(cursor: LocationCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, name: cursor.name, publicId: cursor.publicId }), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown): LocationCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512) throw invalidInput('cursor is invalid.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      parsed.v !== 1
      || typeof parsed.name !== 'string'
      || typeof parsed.publicId !== 'string'
      || parsed.name.length > MAX_LOCATION_NAME_LENGTH
      || !parsed.publicId
      || parsed.publicId.length > 128
    ) {
      throw new Error('invalid cursor');
    }
    return { name: parsed.name, publicId: parsed.publicId };
  } catch {
    throw invalidInput('cursor is invalid.');
  }
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw invalidInput(`limit must be an integer from 1 through ${MAX_LIST_LIMIT}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
    throw invalidInput(`limit must be an integer from 1 through ${MAX_LIST_LIMIT}.`);
  }
  return parsed;
}

function idempotencyIdentity(key: string | undefined, input: NormalizedCreate): IdempotencyIdentity | null {
  if (key === undefined) return null;
  const normalizedKey = key.trim();
  if (!normalizedKey || normalizedKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw invalidInput(`Idempotency-Key must contain between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }
  const canonical = JSON.stringify({
    name: input.name,
    address: input.address,
    timezone: input.timezone,
    tenantName: input.tenantName,
    workspaceSlug: input.workspaceSlug,
  });
  return {
    keyHash: createHash('sha256').update(normalizedKey).digest('hex'),
    requestHash: createHash('sha256').update(canonical).digest('hex'),
  };
}

function effectivePlanCode(tenant: {
  planTier: string;
  status: string;
  stripeSubscriptionId: string | null;
  stripeSubscriptionCurrentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
}, now = new Date()): string {
  const requested = tenant.planTier.trim().toUpperCase();
  const planCode = ['FREE', 'STARTER', 'GROWTH', 'ENTERPRISE'].includes(requested) ? requested : 'FREE';
  if (planCode === 'FREE') return 'FREE';
  const paid = tenant.status === 'ACTIVE'
    && Boolean(tenant.stripeSubscriptionId?.trim())
    && tenant.stripeSubscriptionCurrentPeriodEnd !== null
    && tenant.stripeSubscriptionCurrentPeriodEnd > now;
  const trial = tenant.status === 'TRIAL'
    && tenant.trialEndsAt !== null
    && tenant.trialEndsAt > now;
  return paid || trial ? planCode : 'FREE';
}

/**
 * Native tenant-location owner. All route identifiers are public UUIDs while
 * internal keys remain inside this module's RLS-scoped transactions.
 */
export class LocationService {
  constructor(private readonly database: Pick<TenantDatabase, 'withTenant'>) {}

  async list(identity: SessionIdentity, query: LocationListQuery): Promise<LocationListResponse> {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const rows = await transaction.location.findMany({
        where: {
          tenantId: identity.tenantId,
          deletedAt: null,
          ...(cursor ? {
            OR: [
              { name: { gt: cursor.name } },
              { name: cursor.name, publicId: { gt: cursor.publicId } },
            ],
          } : {}),
        },
        orderBy: [{ name: 'asc' }, { publicId: 'asc' }],
        take: limit + 1,
        select: {
          publicId: true,
          name: true,
          address: true,
          timezone: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const hasMore = rows.length > limit;
      const visible = hasMore ? rows.slice(0, limit) : rows;
      const last = visible.at(-1);
      return {
        data: visible.map(publicLocation),
        pagination: {
          limit,
          maxLimit: MAX_LIST_LIMIT,
          returned: visible.length,
          hasMore,
          nextCursor: hasMore && last ? encodeCursor({ name: last.name, publicId: last.publicId }) : null,
        },
      } satisfies LocationListResponse;
    });
  }

  async summary(identity: SessionIdentity): Promise<LocationSummaryResponse> {
    return this.database.withTenant(identity.tenantId, async (transaction) => ({
      count: await transaction.location.count({
        where: { tenantId: identity.tenantId, deletedAt: null },
      }),
    }));
  }

  async get(identity: SessionIdentity, locationPublicId: string): Promise<LocationRecord> {
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const location = await transaction.location.findFirst({
        where: {
          tenantId: identity.tenantId,
          publicId: locationPublicId,
          deletedAt: null,
        },
        select: {
          publicId: true,
          name: true,
          address: true,
          timezone: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!location) throw new ProblemError(404, 'location_not_found', 'The selected location was not found.', 'Location not found');
      return publicLocation(location);
    });
  }

  async create(
    identity: SessionIdentity,
    body: LocationCreateRequest,
    idempotencyKey: string | undefined,
  ): Promise<LocationRecord> {
    const input = parseCreate(body);
    const requestIdentity = idempotencyIdentity(idempotencyKey, input);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      await this.lockCapacity(transaction, identity.tenantId);
      if (input.workspaceSlug) await this.assertWorkspaceMatchesSession(transaction, identity.tenantId, input.workspaceSlug);

      if (requestIdentity) {
        const existing = await transaction.location.findFirst({
          where: {
            tenantId: identity.tenantId,
            creationRequestKeyHash: requestIdentity.keyHash,
          },
          select: {
            publicId: true,
            name: true,
            address: true,
            timezone: true,
            createdAt: true,
            updatedAt: true,
            creationRequestHash: true,
          },
        });
        if (existing) {
          if (existing.creationRequestHash !== requestIdentity.requestHash) {
            throw new ProblemError(
              409,
              'idempotency_key_reused',
              'Idempotency-Key was already used for a different location request.',
              'Request conflict',
            );
          }
          return publicLocation(existing);
        }
      }

      const activeCount = await this.assertLocationCapacity(transaction, identity.tenantId);
      if (input.tenantName && activeCount > 0) {
        throw new ProblemError(
          409,
          'first_location_only',
          'Organization name can only be set during first-location setup.',
          'Request conflict',
        );
      }
      if (input.tenantName) {
        await transaction.tenant.update({
          where: { id: identity.tenantId },
          data: { name: input.tenantName },
        });
      }

      const location = await transaction.location.create({
        data: {
          publicId: randomUUID(),
          tenantId: identity.tenantId,
          name: input.name,
          address: input.address,
          timezone: input.timezone,
          ...(requestIdentity ? {
            creationRequestKeyHash: requestIdentity.keyHash,
            creationRequestHash: requestIdentity.requestHash,
          } : {}),
        },
        select: {
          publicId: true,
          name: true,
          address: true,
          timezone: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return publicLocation(location);
    });
  }

  async update(
    identity: SessionIdentity,
    locationPublicId: string,
    body: LocationUpdateRequest,
  ): Promise<LocationRecord> {
    const input = parseUpdate(body);
    return this.database.withTenant(identity.tenantId, async (transaction) => {
      const current = await this.lockActiveLocation(transaction, identity.tenantId, locationPublicId);
      if (!current) throw new ProblemError(404, 'location_not_found', 'The selected location was not found.', 'Location not found');

      const timezoneChanged = input.timezone !== current.timezone;
      if (timezoneChanged) await this.assertTimezoneCanChange(transaction, identity.tenantId, current.id);

      const location = await transaction.location.update({
        where: { id: current.id },
        data: input,
        select: {
          publicId: true,
          name: true,
          address: true,
          timezone: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (timezoneChanged) await this.invalidateDraftSchedules(transaction, identity.tenantId, current.id);
      return publicLocation(location);
    });
  }

  async remove(identity: SessionIdentity, locationPublicId: string): Promise<void> {
    await this.database.withTenant(identity.tenantId, async (transaction) => {
      const current = await this.lockActiveLocation(transaction, identity.tenantId, locationPublicId);
      if (!current) return;
      await this.invalidateDraftSchedules(transaction, identity.tenantId, current.id);
      await transaction.location.update({
        where: { id: current.id },
        data: { deletedAt: new Date() },
      });
    });
  }

  /** Resolves only active tenant locations for retained API request translation. */
  async resolvePublicIds(tenantId: string, publicIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(publicIds)];
    if (ids.length === 0) return new Map();
    return this.database.withTenant(tenantId, async (transaction) => {
      const rows = await transaction.location.findMany({
        where: { tenantId, publicId: { in: ids }, deletedAt: null },
        select: { id: true, publicId: true },
      });
      return new Map(rows.map((row) => [row.publicId, row.id]));
    });
  }

  /** Resolves historical rows too so retained read responses remain referentially stable. */
  async resolveInternalIds(tenantId: string, internalIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(internalIds)];
    if (ids.length === 0) return new Map();
    return this.database.withTenant(tenantId, async (transaction) => {
      const rows = await transaction.location.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, publicId: true },
      });
      return new Map(rows.map((row) => [row.id, row.publicId]));
    });
  }

  private async lockCapacity(transaction: TenantTransaction, tenantId: string): Promise<void> {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`location-capacity:${tenantId}`}, 0))`;
  }

  private async assertWorkspaceMatchesSession(
    transaction: TenantTransaction,
    tenantId: string,
    workspaceSlug: string,
  ): Promise<void> {
    const tenant = await transaction.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    if (!tenant || tenant.slug !== workspaceSlug) {
      throw new ProblemError(
        403,
        'workspace_session_mismatch',
        'First-location setup does not match the signed-in workspace.',
        'Forbidden',
      );
    }
  }

  private async assertLocationCapacity(transaction: TenantTransaction, tenantId: string): Promise<number> {
    const tenant = await transaction.tenant.findUnique({
      where: { id: tenantId },
      select: {
        planTier: true,
        status: true,
        stripeSubscriptionId: true,
        stripeSubscriptionCurrentPeriodEnd: true,
        trialEndsAt: true,
      },
    });
    if (!tenant) throw new ProblemError(404, 'tenant_not_found', 'The signed-in workspace was not found.', 'Not found');
    const planCode = effectivePlanCode(tenant);
    const plan = await transaction.planDefinition.findUnique({
      where: { code: planCode },
      select: { name: true, locationLimit: true },
    });
    if (!plan) {
      throw new ProblemError(
        503,
        'plan_configuration_unavailable',
        'Location capacity is temporarily unavailable.',
        'Service unavailable',
      );
    }
    const activeCount = await transaction.location.count({
      where: { tenantId, deletedAt: null },
    });
    if (plan.locationLimit !== null && activeCount >= plan.locationLimit) {
      throw new ProblemError(
        403,
        'location_limit_reached',
        `Location limit reached for ${plan.name} plan.`,
        'Forbidden',
      );
    }
    return activeCount;
  }

  private async lockActiveLocation(
    transaction: TenantTransaction,
    tenantId: string,
    locationPublicId: string,
  ): Promise<LockedLocation | null> {
    const rows = await transaction.$queryRaw<LockedLocation[]>(Prisma.sql`
      SELECT "id", "publicId"::text AS "publicId", "timezone"
      FROM "Location"
      WHERE "tenantId" = ${tenantId}
        AND "publicId" = CAST(${locationPublicId} AS uuid)
        AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    return rows[0] ?? null;
  }

  private async assertTimezoneCanChange(
    transaction: TenantTransaction,
    tenantId: string,
    locationId: string,
  ): Promise<void> {
    const schedules = await transaction.$queryRaw<LockedSchedule[]>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "Schedule"
      WHERE "tenantId" = ${tenantId}
        AND "locationId" = ${locationId}
        AND "deletedAt" IS NULL
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    if (schedules.some((schedule) => ['PUBLISHED', 'ARCHIVED'].includes(schedule.status))) {
      throw new ProblemError(
        409,
        'location_timezone_locked',
        'Location timezone cannot change after a schedule has been published. Name and address can still be updated.',
        'Request conflict',
      );
    }
  }

  private async invalidateDraftSchedules(
    transaction: TenantTransaction,
    tenantId: string,
    locationId: string,
  ): Promise<void> {
    await transaction.schedule.updateMany({
      where: {
        tenantId,
        locationId,
        status: 'DRAFT',
        deletedAt: null,
      },
      data: { revision: { increment: 1 } },
    });
  }
}
