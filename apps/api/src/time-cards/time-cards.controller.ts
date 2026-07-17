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
    Patch,
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
import {
    parseUtcInstant,
    timeCardAuditValue,
    TimeCardCorrectionBody,
} from './time-card-correction';
import {
    correctTimeCardInTransaction,
    TIME_CARD_RELATIONS,
} from './time-card-correction.workflow';
import {
    assertClockOutWithinPayrollPeriod,
    isPayrollLockConstraint,
    lockTimeCardPayrollContext,
    resolveTimeCardPayrollAssignment,
} from './time-card-payroll-lock';
import { lockActiveSchedulableUser } from '../common/schedulable-user';

const Permission = (perm: string) => SetMetadata('permission', perm);
const TIME_CARD_STATUS = {
    OPEN: 'OPEN',
    CLOSED: 'CLOSED',
    VOID: 'VOID',
} as const;
const TEAM_TIME_CARD_PERMISSIONS = ['users:read', 'shifts:read'];
const DEFAULT_TIME_CARD_PAGE_SIZE = 100;
const MAX_TIME_CARD_PAGE_SIZE = 250;

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
        @Query('limit') limitRaw?: string,
        @Query('cursor') cursorRaw?: string,
    ) {
        await this.assertTimeCardsEntitled(req);
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

        const pageSize = this.parsePageSize(limitRaw);
        const cursor = this.parseCursor(cursorRaw);
        const cards = await this.tenantDb.withTenant(tenantId, (tx) => tx.timeCard.findMany({
            where,
            orderBy: [{ clockInAt: 'desc' }, { id: 'desc' }],
            take: pageSize + 1,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            include: this.includeRelations(),
        }));
        const page = cards.slice(0, pageSize);
        const nextCursor = cards.length > pageSize && page.length > 0
            ? page[page.length - 1].id
            : null;

        return {
            data: page.map((card: any) => this.serialize(card)),
            tenantId,
            nextCursor,
        };
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
            orderBy: [{ clockInAt: 'desc' }, { id: 'desc' }],
            include: this.includeRelations(),
        }));

        return { data: card ? this.serialize(card) : null };
    }

    @Get(':id')
    @Permission('time_cards:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        await this.assertTimeCardsEntitled(req);
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
                const location = locationId
                    ? await this.assertLocationInTenant(tx, locationId, tenantId)
                    : null;

                const clockInAt = requestedClockInAt ?? new Date();
                const payroll = await resolveTimeCardPayrollAssignment(tx, tenantId, clockInAt, location);

                const created = await tx.timeCard.create({
                    data: {
                        tenantId,
                        userId: targetUserId,
                        locationId,
                        shiftId: body.shiftId ?? null,
                        clockInOperationId: operationId,
                        clockInRequestHash: requestHash,
                        clockInAt,
                        payrollPeriodId: payroll.payrollPeriodId,
                        workTimeZone: payroll.workTimeZone,
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
                        newValue: timeCardAuditValue(created),
                    },
                });
                return created;
            }, { maxWait: 5_000, timeout: 10_000 });
            return this.serialize(card);
        } catch (error) {
            const replay = await this.tenantDb.withTenant(tenantId, (tx) =>
                this.findClockInReplay(tx, tenantId, operationId, requestHash));
            if (replay) return this.serialize(replay);
            if (!this.isUniqueConstraintError(error)) throw error;
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
            const initialCard = await this.findScopedTimeCard(tx, id, req, false);
            const payrollPeriods = await lockTimeCardPayrollContext(
                tx,
                tenantId,
                id,
                [initialCard.payrollPeriodId],
            );
            const card = await this.findScopedTimeCard(tx, id, req, false);
            if (card.status !== TIME_CARD_STATUS.OPEN) {
                throw new BadRequestException('This time card is already closed.');
            }

            const clockOutAt = requestedClockOutAt ?? new Date();
            if (clockOutAt <= card.clockInAt) {
                throw new BadRequestException('Clock out must be after clock in.');
            }
            assertClockOutWithinPayrollPeriod(card.payrollPeriodId, clockOutAt, payrollPeriods);

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
                    revision: card.revision,
                },
                data: {
                    clockOutAt,
                    breakMinutes,
                    ...(notes !== undefined ? { notes } : {}),
                    status: TIME_CARD_STATUS.CLOSED,
                    revision: { increment: 1 },
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
                    oldValue: timeCardAuditValue(card),
                    newValue: timeCardAuditValue(updated),
                },
            });
            return updated;
        }, { maxWait: 5_000, timeout: 10_000 }).catch((error: unknown) => {
            if (isPayrollLockConstraint(error)) {
                throw new ConflictException('This time card belongs to a locked payroll period and cannot be changed.');
            }
            throw error;
        });

        return this.serialize(updated);
    }

    @Patch(':id/correction')
    @Permission('time_cards:write')
    async correct(@Param('id') id: string, @Body() body: TimeCardCorrectionBody, @Req() req: any) {
        this.assertCanManageTeam(req);
        const tenantId = req.user.tenantId;
        const corrected = await this.tenantDb.withTenant(
            tenantId,
            async (tx) => {
                await this.featureAccessService.assertFeatureEntitledInTransaction(
                    tx,
                    tenantId,
                    'time_cards',
                );
                const corrected = await correctTimeCardInTransaction(tx, tenantId, req.user.sub, id, body);
                if (corrected.payrollPeriodId && corrected.clockOutAt) {
                    const payrollPeriods = await lockTimeCardPayrollContext(
                        tx,
                        tenantId,
                        id,
                        [corrected.payrollPeriodId],
                    );
                    assertClockOutWithinPayrollPeriod(
                        corrected.payrollPeriodId,
                        corrected.clockOutAt,
                        payrollPeriods,
                    );
                }
                return corrected;
            },
            { maxWait: 5_000, timeout: 10_000 },
        ).catch((error: unknown) => {
            if (this.errorContainsConstraint(error, 'TimeCard_employee_no_overlap')) {
                throw new ConflictException('Corrected time cards cannot overlap another card for this employee.');
            }
            if (isPayrollLockConstraint(error)) {
                throw new ConflictException('This time card belongs to a locked payroll period and cannot be changed.');
            }
            throw error;
        });
        return this.serialize(corrected);
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

    private errorContainsConstraint(error: unknown, constraint: string): boolean {
        if (error instanceof Error && error.message.includes(constraint)) return true;
        try {
            return JSON.stringify(error).includes(constraint);
        } catch {
            return false;
        }
    }

    private includeRelations() {
        return TIME_CARD_RELATIONS;
    }

    private async assertTimeCardsEntitled(req: any): Promise<FeatureResolution> {
        return this.featureAccessService.assertFeatureEntitled(req.user.tenantId, 'time_cards');
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

    private assertCanManageTeam(req: any): void {
        if (!this.canViewTeam(req)) {
            throw new ForbiddenException('Team time-card corrections require manager access.');
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
        const user = await lockActiveSchedulableUser(tx, tenantId, userId);
        if (!user) {
            throw new BadRequestException('User is not available for time tracking in this workspace.');
        }
    }

    private async assertLocationInTenant(tx: TenantPrismaTransaction, locationId: string, tenantId: string) {
        const location = await tx.location.findFirst({
            where: { id: locationId, tenantId, deletedAt: null },
            select: { id: true, timezone: true },
        });
        if (!location) {
            throw new BadRequestException('Location is not available for this workspace.');
        }
        return location;
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

    private parsePageSize(value?: string): number {
        if (value === undefined || value.trim() === '') return DEFAULT_TIME_CARD_PAGE_SIZE;
        if (!/^[0-9]+$/.test(value.trim())) {
            throw new BadRequestException('limit must be a positive integer');
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIME_CARD_PAGE_SIZE) {
            throw new BadRequestException('limit must be between 1 and ' + MAX_TIME_CARD_PAGE_SIZE);
        }
        return parsed;
    }

    private parseCursor(value?: string): string | null {
        if (value === undefined) return null;
        const normalized = value.trim();
        if (!normalized || normalized.length > 200) {
            throw new BadRequestException('cursor must contain between 1 and 200 characters');
        }
        return normalized;
    }

    private parseDate(value: string, field: string): Date {
        return parseUtcInstant(value, field);
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

    private serialize(card: any) {
        const end = card.clockOutAt ? new Date(card.clockOutAt) : new Date();
        const grossMinutes = Math.max(0, Math.floor((end.getTime() - new Date(card.clockInAt).getTime()) / 60000));
        const workedMinutes = Math.max(0, grossMinutes - (card.breakMinutes ?? 0));
        return {
            ...card,
            displayTimeZone: card.workTimeZone ?? 'UTC',
            grossMinutes,
            workedMinutes,
        };
    }
}
