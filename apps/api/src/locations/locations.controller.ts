import { createHash } from 'node:crypto';
import { Controller, Get, Post, Put, Delete, Param, Query, Body, Req, Headers, UseGuards, SetMetadata, HttpCode, HttpStatus, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Optional } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { resolveEffectiveTenantEntitlement, resolveTenantPlanDefinition } from '../billing/plan-definitions';
import { normalizeTimeZone } from '../common/location-timezone';
import { MAX_BOUNDED_LIST_LIMIT, parseBoundedListLimit } from '../common/bounded-pagination';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';

const Permission = (perm: string) => SetMetadata('permission', perm);

type LocationUpdateBody = {
    name?: unknown;
    address?: unknown;
    timezone?: unknown;
};

type LocationUpdateData = {
    name?: string;
    address?: string | null;
    timezone?: string;
};

type LocationCreateBody = {
    name: string;
    address?: string;
    timezone?: string;
    tenantName?: string;
    workspaceSlug?: string;
};

type LockedLocationRow = {
    id: string;
    timezone: string;
};

type LockedScheduleStatusRow = {
    id: string;
    status: string;
};

type LocationListCursor = {
    name: string;
    id: string;
};

function encodeLocationListCursor(location: LocationListCursor): string {
    return Buffer.from(JSON.stringify({ v: 1, name: location.name, id: location.id }), 'utf8').toString('base64url');
}

function decodeLocationListCursor(value: unknown): LocationListCursor | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.length > 512) throw new BadRequestException('Invalid cursor.');
    try {
        const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
            v?: unknown;
            name?: unknown;
            id?: unknown;
        };
        if (
            payload.v !== 1
            || typeof payload.name !== 'string'
            || payload.name.length > 500
            || typeof payload.id !== 'string'
            || !payload.id
            || payload.id.length > 200
        ) {
            throw new Error('Invalid payload');
        }
        return { name: payload.name, id: payload.id };
    } catch {
        throw new BadRequestException('Invalid cursor.');
    }
}

@Controller({ path: 'locations', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class LocationsController {
    private readonly tenantDb: TenantPrismaService;

    constructor(@Optional() tenantDb?: TenantPrismaService) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
    }

    @Get()
    @Permission('locations:read')
    async findAll(
        @Req() req: any,
        @Query('limit') limitValue?: string,
        @Query('cursor') cursorValue?: string,
    ) {
        const tenantId = req.user.tenantId;
        const limit = parseBoundedListLimit(limitValue);
        const cursor = decodeLocationListCursor(cursorValue);
        const locations = await this.tenantDb.withTenant(tenantId, (tx) => tx.location.findMany({
            where: {
                tenantId,
                deletedAt: null,
                ...(cursor ? {
                    OR: [
                        { name: { gt: cursor.name } },
                        { name: cursor.name, id: { gt: cursor.id } },
                    ],
                } : {}),
            },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: limit + 1,
        }));
        const hasMore = locations.length > limit;
        const data = hasMore ? locations.slice(0, limit) : locations;
        const last = hasMore ? data.at(-1) : undefined;
        return {
            data,
            tenantId,
            pagination: {
                limit,
                maxLimit: MAX_BOUNDED_LIST_LIMIT,
                returned: data.length,
                hasMore,
                nextCursor: last ? encodeLocationListCursor(last) : null,
            },
        };
    }

    @Get('summary')
    @Permission('locations:read')
    async summary(@Req() req: any) {
        const tenantId = req.user.tenantId;
        const count = await this.tenantDb.withTenant(tenantId, (tx) => tx.location.count({
            where: { tenantId, deletedAt: null },
        }));
        return { count };
    }

    @Get(':id')
    @Permission('locations:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const location = await this.tenantDb.withTenant(tenantId, (tx) => tx.location.findFirst({
            where: { id, tenantId, deletedAt: null },
        }));
        if (!location) throw new NotFoundException('Location not found');
        return location;
    }

    @Post()
    @Permission('locations:write')
    async create(
        @Body() body: LocationCreateBody,
        @Req() req: any,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        const tenantId = req.user.tenantId;
        const locationName = typeof body?.name === 'string' ? body.name.trim() : '';
        const tenantName = typeof body?.tenantName === 'string'
            ? body.tenantName.trim().replace(/\s+/g, ' ')
            : undefined;
        const workspaceSlug = typeof body?.workspaceSlug === 'string'
            ? body.workspaceSlug.trim().toLowerCase()
            : undefined;
        const timezone = this.parseTimeZone(body?.timezone);
        const requestIdentity = this.locationCreateRequestIdentity(idempotencyKey, {
            name: locationName,
            tenantName,
            workspaceSlug,
            address: body.address,
            timezone,
        });

        if (!locationName) {
            throw new BadRequestException('Location name is required');
        }

        if (body?.tenantName !== undefined && typeof body.tenantName !== 'string') {
            throw new BadRequestException('tenantName must be a string');
        }
        if (body?.workspaceSlug !== undefined && typeof body.workspaceSlug !== 'string') {
            throw new BadRequestException('workspaceSlug must be a string');
        }
        if (tenantName && !workspaceSlug) {
            throw new BadRequestException('workspaceSlug is required for first-location setup');
        }

        const canWrite = Array.isArray(req.user?.permissions) && req.user.permissions.includes('locations:write');
        if (!canWrite) {
            throw new ForbiddenException('Insufficient permissions for locations:write');
        }

        const location = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockLocationCapacity(tx, tenantId);
            if (workspaceSlug) {
                await this.assertWorkspaceMatchesSession(tx, tenantId, workspaceSlug);
            }

            if (requestIdentity) {
                const existing = await tx.location.findFirst({
                    where: {
                        tenantId,
                        creationRequestKeyHash: requestIdentity.keyHash,
                    },
                });
                if (existing) {
                    if (existing.creationRequestHash !== requestIdentity.requestHash) {
                        throw new ConflictException('Idempotency-Key was already used for a different location request');
                    }
                    return existing;
                }
            }

            await this.assertLocationLimit(tx, tenantId);
            if (tenantName) {
                const activeLocationCount = await tx.location.count({
                    where: { tenantId, deletedAt: null },
                });
                if (activeLocationCount > 0) {
                    throw new ConflictException('Organization name can only be set during first-location setup');
                }
            }

            if (tenantName) {
                await tx.tenant.update({
                    where: { id: tenantId },
                    data: { name: tenantName },
                });
            }

            return tx.location.create({
                data: {
                    name: locationName,
                    address: body.address,
                    timezone,
                    tenantId,
                    ...(requestIdentity ? {
                        creationRequestKeyHash: requestIdentity.keyHash,
                        creationRequestHash: requestIdentity.requestHash,
                    } : {}),
                },
            });
        });

        return location;
    }

    private async lockLocationCapacity(tx: TenantPrismaTransaction, tenantId: string): Promise<void> {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`location-capacity:${tenantId}`}, 0))`;
    }

    private async assertWorkspaceMatchesSession(
        tx: TenantPrismaTransaction,
        tenantId: string,
        workspaceSlug: string,
    ): Promise<void> {
        const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { slug: true },
        });
        if (tenant.slug !== workspaceSlug) {
            throw new ForbiddenException('First-location setup does not match the signed-in workspace');
        }
    }

    private locationCreateRequestIdentity(
        idempotencyKey: string | undefined,
        payload: {
            name: string | undefined;
            tenantName: string | undefined;
            workspaceSlug: string | undefined;
            address: string | undefined;
            timezone: string | undefined;
        },
    ): { keyHash: string; requestHash: string } | null {
        if (idempotencyKey === undefined) return null;
        const normalizedKey = idempotencyKey.trim();
        if (!normalizedKey || normalizedKey.length > 200) {
            throw new BadRequestException('Idempotency-Key must contain between 1 and 200 characters');
        }

        const requestPayload = JSON.stringify({
            name: payload.name ?? null,
            tenantName: payload.tenantName ?? null,
            workspaceSlug: payload.workspaceSlug ?? null,
            address: payload.address ?? null,
            timezone: payload.timezone ?? null,
        });
        return {
            keyHash: createHash('sha256').update(normalizedKey).digest('hex'),
            requestHash: createHash('sha256').update(requestPayload).digest('hex'),
        };
    }

    @Put(':id')
    @Permission('locations:write')
    async update(@Param('id') id: string, @Body() body: LocationUpdateBody, @Req() req: any) {
        const data = this.parseLocationUpdate(body);
        const tenantId = req.user.tenantId;
        const updated = await this.tenantDb.withTenant(tenantId, async (tx) => {
            const current = await this.lockActiveLocation(tx, tenantId, id);
            if (!current) throw new NotFoundException('Location not found');

            const timezoneChanged = data.timezone !== undefined && data.timezone !== current.timezone;
            if (timezoneChanged) {
                await this.assertTimezoneCanChange(tx, tenantId, id);
            }

            const location = await tx.location.updateMany({
                where: { id, tenantId, deletedAt: null },
                data,
            });
            if (location.count === 0) throw new NotFoundException('Location not found');

            if (timezoneChanged) {
                await this.invalidateDraftSchedules(tx, tenantId, id);
            }

            return tx.location.findFirst({
                where: { id, tenantId, deletedAt: null },
            });
        });
        if (!updated) throw new NotFoundException('Location not found');
        return updated;
    }

    @Delete(':id')
    @Permission('locations:delete')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        await this.tenantDb.withTenant(tenantId, async (tx) => {
            const current = await this.lockActiveLocation(tx, tenantId, id);
            if (!current) return;

            await this.invalidateDraftSchedules(tx, tenantId, id);
            await tx.location.updateMany({
                where: { id, tenantId, deletedAt: null },
                data: { deletedAt: new Date() },
            });
        });
    }

    private async lockActiveLocation(
        tx: TenantPrismaTransaction,
        tenantId: string,
        locationId: string,
    ): Promise<LockedLocationRow | null> {
        const rows = await tx.$queryRaw<LockedLocationRow[]>`
            SELECT "id", "timezone"
            FROM "Location"
            WHERE "id" = ${locationId}
              AND "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
            FOR UPDATE
        `;
        return rows[0] ?? null;
    }

    private async assertTimezoneCanChange(
        tx: TenantPrismaTransaction,
        tenantId: string,
        locationId: string,
    ): Promise<void> {
        const schedules = await tx.$queryRaw<LockedScheduleStatusRow[]>`
            SELECT "id", "status"
            FROM "Schedule"
            WHERE "tenantId" = ${tenantId}
              AND "locationId" = ${locationId}
              AND "deletedAt" IS NULL
            ORDER BY "id" ASC
            FOR UPDATE
        `;
        if (schedules.some((schedule) => schedule.status === 'PUBLISHED' || schedule.status === 'ARCHIVED')) {
            throw new ConflictException(
                'Location timezone cannot change after a schedule has been published. Name and address can still be updated.',
            );
        }
    }

    private async invalidateDraftSchedules(
        tx: TenantPrismaTransaction,
        tenantId: string,
        locationId: string,
    ): Promise<void> {
        await tx.schedule.updateMany({
            where: {
                tenantId,
                locationId,
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
    }

    private async assertLocationLimit(tx: TenantPrismaTransaction, tenantId: string) {
        const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: {
                planTier: true,
                status: true,
                stripeSubscriptionId: true,
                stripeSubscriptionCurrentPeriodEnd: true,
                trialEndsAt: true,
            },
        });

        const effectiveEntitlement = resolveEffectiveTenantEntitlement(tenant);
        const plan = await resolveTenantPlanDefinition(tx as any, effectiveEntitlement.planCode);
        const limit = plan?.locationLimit;
        if (limit === null || limit === undefined) {
            return;
        }

        const locationCount = await tx.location.count({
            where: { tenantId, deletedAt: null },
        });

        if (locationCount >= limit) {
            const planLabel = plan?.name ?? effectiveEntitlement.planCode;
            throw new ForbiddenException(`Location limit reached for ${planLabel} plan.`);
        }
    }

    private parseLocationUpdate(body: LocationUpdateBody | null | undefined): LocationUpdateData {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new BadRequestException('Location update body must be an object');
        }

        const data: LocationUpdateData = {};

        if (Object.prototype.hasOwnProperty.call(body, 'name')) {
            if (typeof body.name !== 'string') {
                throw new BadRequestException('name must be a string');
            }
            const name = body.name.trim();
            if (!name) {
                throw new BadRequestException('Location name is required');
            }
            data.name = name;
        }

        if (Object.prototype.hasOwnProperty.call(body, 'address')) {
            if (body.address === null) {
                data.address = null;
            } else if (typeof body.address === 'string') {
                data.address = body.address.trim() || null;
            } else {
                throw new BadRequestException('address must be a string or null');
            }
        }

        if (!Object.prototype.hasOwnProperty.call(body, 'timezone')) {
            throw new BadRequestException('Location timezone is required.');
        }
        data.timezone = this.parseTimeZone(body.timezone);

        if (Object.keys(data).length === 0) {
            throw new BadRequestException('At least one supported location field is required');
        }

        return data;
    }

    private parseTimeZone(value: unknown): string {
        if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
            throw new BadRequestException('Location timezone is required.');
        }
        if (typeof value !== 'string') {
            throw new BadRequestException('timezone must be a string');
        }
        return normalizeTimeZone(value);
    }
}
