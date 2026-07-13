import {
    BadRequestException,
    Body,
    Controller,
    ConflictException,
    ForbiddenException,
    Get,
    Headers,
    NotFoundException,
    Optional,
    Param,
    Post,
    Query,
    Req,
    SetMetadata,
    UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { FeatureAccessService, FeatureResolution } from '../billing/feature-access.service';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import {
    normalizeTimeCardIdempotencyKey,
    timeCardClockInOperationId,
    timeCardClockInRequestHash,
} from './time-card-idempotency';

const Permission = (perm: string) => SetMetadata('permission', perm);
const UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
const TIME_CARD_STATUS = {
    OPEN: 'OPEN',
    CLOSED: 'CLOSED',
    VOID: 'VOID',
} as const;
const TEAM_TIME_CARD_PERMISSIONS = ['users:read', 'shifts:read'];

type ClockInBody = {
    userId?: string;
    locationId?: string;
    shiftId?: string;
    clockInAt?: string;
    notes?: string;
};

type ClockOutBody = {
    clockOutAt?: string;
    breakMinutes?: number;
    notes?: string;
};

@Controller({ path: 'time-cards', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class TimeCardsController {
    private readonly tenantDb: TenantPrismaService;

    constructor(
        private readonly featureAccessService: FeatureAccessService,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
    }

    @Get()
    @Permission('time_cards:read')
    async findAll(
        @Req() req: any,
        @Query('userId') userId?: string,
        @Query('locationId') locationId?: string,
        @Query('startDate') startDate?: string,
        @Query('endDate') endDate?: string,
    ) {
        const tenantId = req.user.tenantId;
        const where: any = {
            tenantId,
            deletedAt: null,
        };

        const canViewTeam = this.canViewTeam(req);
        if (canViewTeam && userId) {
            where.userId = userId;
        } else if (!canViewTeam) {
            where.userId = req.user.sub;
        }
        if (locationId) {
            where.locationId = locationId;
        }
        if (startDate || endDate) {
            where.clockInAt = {};
            if (startDate) where.clockInAt.gte = this.parseDate(startDate, 'startDate');
            if (endDate) where.clockInAt.lt = this.parseDate(endDate, 'endDate');
        }

        const cards = await this.tenantDb.withTenant(tenantId, (tx) => tx.timeCard.findMany({
            where,
            orderBy: { clockInAt: 'desc' },
            include: this.includeRelations(),
        }));

        return { data: cards.map((card: any) => this.serialize(card)), tenantId };
    }

    @Get('active')
    @Permission('time_cards:read')
    async active(@Req() req: any, @Query('userId') userId?: string) {
        const tenantId = req.user.tenantId;
        const targetUserId = this.resolveReadableUserId(req, userId);
        const card = await this.tenantDb.withTenant(tenantId, (tx) => tx.timeCard.findFirst({
            where: {
                tenantId,
                userId: targetUserId,
                status: TIME_CARD_STATUS.OPEN,
                deletedAt: null,
            },
            orderBy: { clockInAt: 'desc' },
            include: this.includeRelations(),
        }));

        return { data: card ? this.serialize(card) : null };
    }

    @Get(':id')
    @Permission('time_cards:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const card = await this.tenantDb.withTenant(tenantId, (tx) => this.findScopedTimeCard(tx, id, req, true));
        return this.serialize(card);
    }

    @Post('clock-in')
    @Permission('time_cards:write')
    async clockIn(
        @Body() body: ClockInBody,
        @Req() req: any,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        const tenantId = req.user.tenantId;
        const targetUserId = this.resolveWritableUserId(req, body.userId);
        const normalizedIdempotencyKey = normalizeTimeCardIdempotencyKey(idempotencyKey);
        this.assertManualClockEventAllowed(req, body.clockInAt, 'clockInAt');
        const requestedClockInAt = body.clockInAt ? this.parseDate(body.clockInAt, 'clockInAt') : null;
        const notes = this.trimOptional(body.notes) ?? null;
        const operationId = timeCardClockInOperationId(tenantId, normalizedIdempotencyKey);
        const requestHash = timeCardClockInRequestHash({
            actorUserId: req.user.sub,
            targetUserId,
            locationId: body.locationId ?? null,
            shiftId: body.shiftId ?? null,
            clockInAt: requestedClockInAt?.toISOString() ?? null,
            notes,
        });
        const committedReplay = await this.tenantDb.withTenant(tenantId, (tx) =>
            this.findClockInReplay(tx, tenantId, operationId, requestHash));
        if (committedReplay) return this.serialize(committedReplay);

        try {
            const card = await this.tenantDb.withTenant(tenantId, async (tx) => {
                const replay = await this.findClockInReplay(tx, tenantId, operationId, requestHash);
                if (replay) return replay;

                const entitlement = await this.featureAccessService.assertFeatureEnabledInTransaction(
                    tx,
                    tenantId,
                    'time_cards',
                );

                await this.assertUserInTenant(tx, targetUserId, tenantId);
                const openCard = await tx.timeCard.findFirst({
                    where: {
                        tenantId,
                        userId: targetUserId,
                        status: TIME_CARD_STATUS.OPEN,
                        deletedAt: null,
                    },
                    select: { id: true },
                });
                if (openCard) {
                    throw new BadRequestException('This employee already has an open time card.');
                }

                const shift = body.shiftId ? await this.assertShiftInTenant(tx, body.shiftId, tenantId, targetUserId) : null;
                const locationId = body.locationId ?? shift?.locationId ?? null;
                if (shift && locationId && locationId !== shift.locationId) {
                    throw new BadRequestException('Time card location must match the selected shift location.');
                }
                if (locationId) {
                    await this.assertLocationInTenant(tx, locationId, tenantId);
                }

                const created = await tx.timeCard.create({
                    data: {
                        tenantId,
                        userId: targetUserId,
                        locationId,
                        shiftId: body.shiftId ?? null,
                        clockInOperationId: operationId,
                        clockInRequestHash: requestHash,
                        clockInAt: requestedClockInAt ?? new Date(),
                        notes,
                        status: TIME_CARD_STATUS.OPEN,
                    },
                    include: this.includeRelations(),
                });
                await this.featureAccessService.recordFeatureUsageInTransaction(
                    tx,
                    tenantId,
                    entitlement,
                    `Time card clock-in (${created.id})`,
                    operationId,
                );
                await tx.auditLog.create({
                    data: {
                        tenantId,
                        userId: req.user.sub,
                        action: 'TIME_CARD_CLOCKED_IN',
                        resource: 'TimeCard',
                        resourceId: created.id,
                        newValue: this.timeCardAuditValue(created),
                    },
                });
                return created;
            });
            return this.serialize(card);
        } catch (error) {
            if (!this.isUniqueConstraintError(error)) throw error;
            const replay = await this.tenantDb.withTenant(tenantId, (tx) =>
                this.findClockInReplay(tx, tenantId, operationId, requestHash));
            if (replay) return this.serialize(replay);
            throw new BadRequestException('This employee already has an open time card.');
        }
    }
    @Post(':id/clock-out')
    @Permission('time_cards:write')
    async clockOut(@Param('id') id: string, @Body() body: ClockOutBody, @Req() req: any) {
        const tenantId = req.user.tenantId;
        this.assertManualClockEventAllowed(req, body.clockOutAt, 'clockOutAt');
        const requestedClockOutAt = body.clockOutAt ? this.parseDate(body.clockOutAt, 'clockOutAt') : null;
        const updated = await this.tenantDb.withTenant(tenantId, async (tx) => {
            const card = await this.findScopedTimeCard(tx, id, req, false);
            if (card.status !== TIME_CARD_STATUS.OPEN) {
                throw new BadRequestException('This time card is already closed.');
            }

            const clockOutAt = requestedClockOutAt ?? new Date();
            if (clockOutAt <= card.clockInAt) {
                throw new BadRequestException('Clock out must be after clock in.');
            }

            const totalMinutes = Math.floor((clockOutAt.getTime() - card.clockInAt.getTime()) / 60000);
            const breakMinutes = this.normalizeBreakMinutes(body.breakMinutes, totalMinutes);
            const notes = this.trimOptional(body.notes);
            const closeResult = await tx.timeCard.updateMany({
                where: {
                    id: card.id,
                    tenantId,
                    deletedAt: null,
                    status: TIME_CARD_STATUS.OPEN,
                    clockOutAt: null,
                },
                data: {
                    clockOutAt,
                    breakMinutes,
                    ...(notes !== undefined ? { notes } : {}),
                    status: TIME_CARD_STATUS.CLOSED,
                },
            });
            if (closeResult.count !== 1) {
                throw new ConflictException('This time card was already clocked out by another request.');
            }
            const updated = await this.findScopedTimeCard(tx, id, req, true);
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: req.user.sub,
                    action: 'TIME_CARD_CLOCKED_OUT',
                    resource: 'TimeCard',
                    resourceId: updated.id,
                    oldValue: this.timeCardAuditValue(card),
                    newValue: this.timeCardAuditValue(updated),
                },
            });
            return updated;
        });

        return this.serialize(updated);
    }

    private async findClockInReplay(
        tx: TenantPrismaTransaction,
        tenantId: string,
        operationId: string,
        requestHash: string,
    ): Promise<any | null> {
        const existing = await tx.timeCard.findUnique({
            where: { clockInOperationId: operationId },
            include: this.includeRelations(),
        });
        if (!existing || existing.tenantId !== tenantId) return null;
        if (existing.clockInRequestHash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used with a different clock-in request.');
        }
        return existing;
    }

    private isUniqueConstraintError(error: unknown): boolean {
        return typeof error === 'object'
            && error !== null
            && 'code' in error
            && (error as { code?: unknown }).code === 'P2002';
    }
    private includeRelations() {
        return {
            user: { select: { id: true, name: true, username: true, role: true } },
            location: { select: { id: true, name: true } },
            shift: { select: { id: true, startTime: true, endTime: true } },
        };
    }

    private async assertTimeCardsEnabled(req: any): Promise<FeatureResolution> {
        return this.featureAccessService.assertFeatureEnabled(req.user.tenantId, 'time_cards');
    }
    private canViewTeam(req: any): boolean {
        const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
        return TEAM_TIME_CARD_PERMISSIONS.every((permission) => permissions.includes(permission));
    }

    private resolveReadableUserId(req: any, requestedUserId?: string): string {
        const requested = requestedUserId?.trim();
        if (this.canViewTeam(req)) {
            return requested || req.user.sub;
        }
        if (requested && requested !== req.user.sub) {
            throw new ForbiddenException('Staff can only view their own time cards.');
        }
        return req.user.sub;
    }

    private resolveWritableUserId(req: any, requestedUserId?: string): string {
        const requested = requestedUserId?.trim();
        if (this.canViewTeam(req)) {
            return requested || req.user.sub;
        }
        if (requested && requested !== req.user.sub) {
            throw new ForbiddenException('Staff can only manage their own time cards.');
        }
        return req.user.sub;
    }

    private assertManualClockEventAllowed(req: any, value: string | undefined, field: string): void {
        if (value !== undefined && value !== null && !this.canViewTeam(req)) {
            throw new ForbiddenException(`Staff self-service ${field} uses server time.`);
        }
    }

    private async findScopedTimeCard(tx: TenantPrismaTransaction, id: string, req: any, includeClosed: boolean) {
        const where: any = {
            id,
            tenantId: req.user.tenantId,
            deletedAt: null,
        };
        if (!includeClosed) {
            where.status = { not: TIME_CARD_STATUS.VOID };
        }
        if (!this.canViewTeam(req)) {
            where.userId = req.user.sub;
        }

        const card = await tx.timeCard.findFirst({
            where,
            include: this.includeRelations(),
        });
        if (!card) {
            throw new NotFoundException('Time card not found');
        }
        return card;
    }

    private async assertUserInTenant(tx: TenantPrismaTransaction, userId: string, tenantId: string) {
        const user = await tx.user.findFirst({
            where: { id: userId, tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!user) {
            throw new BadRequestException('User is not available for this workspace.');
        }
    }

    private async assertLocationInTenant(tx: TenantPrismaTransaction, locationId: string, tenantId: string) {
        const location = await tx.location.findFirst({
            where: { id: locationId, tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!location) {
            throw new BadRequestException('Location is not available for this workspace.');
        }
    }

    private async assertShiftInTenant(tx: TenantPrismaTransaction, shiftId: string, tenantId: string, targetUserId: string) {
        const shift = await tx.shift.findFirst({
            where: { id: shiftId, tenantId, deletedAt: null },
            select: { id: true, locationId: true, userId: true },
        });
        if (!shift) {
            throw new BadRequestException('Shift is not available for this workspace.');
        }
        if (shift.userId && shift.userId !== targetUserId) {
            throw new BadRequestException('Shift is assigned to a different employee.');
        }
        return shift;
    }

    private parseDate(value: string, field: string): Date {
        if (typeof value !== 'string' || !value.trim()) {
            throw new BadRequestException(`${field} is required`);
        }
        const normalized = value.trim();
        const match = UTC_INSTANT_RE.exec(normalized);
        if (!match) {
            throw new BadRequestException(`Invalid ${field}. Use UTC ISO 8601.`);
        }
        const parsed = new Date(normalized);
        if (!this.isValidUtcInstant(parsed, match)) {
            throw new BadRequestException(`Invalid ${field}. Use UTC ISO 8601.`);
        }
        return parsed;
    }

    private isValidUtcInstant(parsed: Date, match: RegExpExecArray): boolean {
        return Number.isFinite(parsed.getTime()) &&
            parsed.getUTCFullYear() === Number(match[1]) &&
            parsed.getUTCMonth() === Number(match[2]) - 1 &&
            parsed.getUTCDate() === Number(match[3]) &&
            parsed.getUTCHours() === Number(match[4]) &&
            parsed.getUTCMinutes() === Number(match[5]) &&
            parsed.getUTCSeconds() === Number(match[6] ?? 0);
    }

    private normalizeBreakMinutes(value: number | undefined, totalMinutes: number): number {
        if (value === undefined || value === null) return 0;
        const numeric = Number(value);
        if (!Number.isInteger(numeric) || numeric < 0) {
            throw new BadRequestException('Break minutes must be a non-negative whole number.');
        }
        if (numeric > 0 && numeric >= totalMinutes) {
            throw new BadRequestException('Break minutes must be less than worked minutes.');
        }
        return numeric;
    }

    private trimOptional(value?: string): string | null | undefined {
        if (value === undefined) return undefined;
        if (typeof value !== 'string') {
            throw new BadRequestException('notes must be a string');
        }
        const trimmed = value.trim();
        return trimmed || null;
    }

    private timeCardAuditValue(card: any) {
        return {
            targetUserId: card.userId,
            locationId: card.locationId ?? null,
            shiftId: card.shiftId ?? null,
            clockInAt: this.toAuditIso(card.clockInAt),
            clockOutAt: this.toAuditIso(card.clockOutAt),
            breakMinutes: card.breakMinutes ?? 0,
            status: card.status,
        };
    }

    private toAuditIso(value: Date | string | null | undefined): string | null {
        if (!value) return null;
        return new Date(value).toISOString();
    }

    private serialize(card: any) {
        const end = card.clockOutAt ? new Date(card.clockOutAt) : new Date();
        const grossMinutes = Math.max(0, Math.floor((end.getTime() - new Date(card.clockInAt).getTime()) / 60000));
        const workedMinutes = Math.max(0, grossMinutes - (card.breakMinutes ?? 0));
        return {
            ...card,
            grossMinutes,
            workedMinutes,
        };
    }
}
