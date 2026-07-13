import { createHash } from 'node:crypto';
import { Controller, Get, Post, Put, Delete, Param, Body, Req, Headers, UseGuards, SetMetadata, HttpCode, HttpStatus, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Optional } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { resolveEffectiveTenantEntitlement, resolveTenantPlanDefinition } from '../billing/plan-definitions';
import { normalizeTimeZone } from '../common/location-timezone';
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
};

type LockedLocationRow = {
    id: string;
    timezone: string;
};

type LockedScheduleStatusRow = {
    id: string;
    status: string;
};

@Controller({ path: 'locations', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class LocationsController {
    private readonly tenantDb: TenantPrismaService;

    constructor(@Optional() tenantDb?: TenantPrismaService) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
    }

    @Get()
    @Permission('locations:read')
    async findAll(@Req() req: any) {
        const tenantId = req.user.tenantId;
        const locations = await this.tenantDb.withTenant(tenantId, (tx) => tx.location.findMany({
            where: { tenantId, deletedAt: null },
        }));
        return { data: locations, tenantId };
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
        const locationName = body.name?.trim();
        const tenantName = body.tenantName?.trim();
        const timezone = body.timezone === undefined
            ? undefined
            : this.parseTimeZone(body.timezone);
        const requestIdentity = this.locationCreateRequestIdentity(idempotencyKey, {
            name: locationName,
            tenantName,
            address: body.address,
            timezone,
        });

        if (!locationName) {
            throw new BadRequestException('Location name is required');
        }

        const canWrite = Array.isArray(req.user?.permissions) && req.user.permissions.includes('locations:write');
        if (!canWrite) {
            throw new ForbiddenException('Insufficient permissions for locations:write');
        }

        const location = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockLocationCapacity(tx, tenantId);

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
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`location-capacity:${tenantId}`}, 0))`;
    }

    private locationCreateRequestIdentity(
        idempotencyKey: string | undefined,
        payload: { name: string | undefined; tenantName: string | undefined; address: string | undefined; timezone: string | undefined },
    ): { keyHash: string; requestHash: string } | null {
        if (idempotencyKey === undefined) return null;
        const normalizedKey = idempotencyKey.trim();
        if (!normalizedKey || normalizedKey.length > 200) {
            throw new BadRequestException('Idempotency-Key must contain between 1 and 200 characters');
        }

        const requestPayload = JSON.stringify({
            name: payload.name ?? null,
            tenantName: payload.tenantName ?? null,
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

        if (Object.prototype.hasOwnProperty.call(body, 'timezone')) {
            if (typeof body.timezone !== 'string') {
                throw new BadRequestException('timezone must be a string');
            }
            data.timezone = this.parseTimeZone(body.timezone);
        }

        if (Object.keys(data).length === 0) {
            throw new BadRequestException('At least one supported location field is required');
        }

        return data;
    }

    private parseTimeZone(value: string): string {
        if (!value.trim()) {
            throw new BadRequestException('timezone is required');
        }
        return normalizeTimeZone(value);
    }
}
