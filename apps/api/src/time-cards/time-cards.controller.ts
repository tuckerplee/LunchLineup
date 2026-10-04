import {
    BadRequestException,
    Body,
    Controller,
    ConflictException,
    ForbiddenException,
    Get,
    Headers,
    HttpException,
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
import { RbacService } from '../auth/rbac.service';
import { AuthService } from '../auth/auth.service';
import { freezeMutationActor, type CurrentMutationActor } from '../auth/current-mutation';
import { FeatureAccessService } from '../billing/feature-access.service';
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
type TimeAuthority = { req: any; targetUserId?: string };

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
        @Optional() tenantDb: TenantPrismaService | undefined,
        private readonly rbacService: RbacService,
        private readonly authService: AuthService,
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
        const input = { userId, locationId, startDate, endDate };
        const pageSize = this.parsePageSize(limitRaw);
        const cursor = this.parseCursor(cursorRaw);
        const startsAt = input.startDate ? this.parseDate(input.startDate, 'startDate') : undefined;
        const endsAt = input.endDate ? this.parseDate(input.endDate, 'endDate') : undefined;
        return this.runTimeAction(req, 'time_cards:read', {}, async (tx, current, assertCurrent) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, current.req.user.tenantId, 'time_cards');
            assertCurrent();
            const tenantId = current.req.user.tenantId;
            const where: any = { tenantId, deletedAt: null };
            if (this.canViewTeam(current.req) && input.userId) where.userId = input.userId;
            else if (!this.canViewTeam(current.req)) where.userId = current.req.user.sub;
            if (input.locationId) where.locationId = input.locationId;
            if (startsAt || endsAt) where.clockInAt = {
                ...(startsAt ? { gte: startsAt } : {}), ...(endsAt ? { lt: endsAt } : {}),
            };
            const cards = await tx.timeCard.findMany({ where,
                orderBy: [{ clockInAt: 'desc' }, { id: 'desc' }], take: pageSize + 1,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: this.includeRelations(),
            });
            assertCurrent();
            const page = cards.slice(0, pageSize);
            const nextCursor = cards.length > pageSize && page.length > 0 ? page[page.length - 1].id : null;
            return { data: page.map((card: any) => this.serialize(card)), tenantId, nextCursor };
        });
    }

    @Get('active')
    @Permission('time_cards:read')
    async active(@Req() req: any, @Query('userId') userId?: string) {
        const requestedUserId = userId;
        return this.runTimeAction(req, 'time_cards:read', {}, async (tx, current, assertCurrent) => {
            const targetUserId = this.resolveReadableUserId(current.req, requestedUserId);
            const card = await tx.timeCard.findFirst({ where: { tenantId: current.req.user.tenantId,
                userId: targetUserId, status: TIME_CARD_STATUS.OPEN, deletedAt: null },
                orderBy: [{ clockInAt: 'desc' }, { id: 'desc' }], include: this.includeRelations(),
            });
            assertCurrent();
            return { data: card ? this.serialize(card) : null };
        });
    }

    @Get(':id')
    @Permission('time_cards:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        const cardId = id;
        return this.runTimeAction(req, 'time_cards:read', {}, async (tx, current, assertCurrent) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, current.req.user.tenantId, 'time_cards');
            assertCurrent();
            const card = await this.findScopedTimeCard(tx, cardId, current.req, true, assertCurrent);
            assertCurrent();
            return this.serialize(card);
        });
    }

    @Post('clock-in')
    @Permission('time_cards:write')
    async clockIn(
        @Body() body: ClockInBody,
        @Req() req: any,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        const intent: ClockInBody = { userId: body.userId, locationId: body.locationId, shiftId: body.shiftId,
            clockInAt: body.clockInAt, notes: body.notes };
        const normalizedIdempotencyKey = normalizeTimeCardIdempotencyKey(idempotencyKey);
        const capturedActor = freezeMutationActor({ userId: req.user?.sub, tenantId: req.user?.tenantId, sessionId: req.user?.sessionId });
        const tenantId = capturedActor.tenantId;
        const actorUserId = capturedActor.userId;
        const targetUserId = intent.userId?.trim() || actorUserId;
        const requestedClockInAt = intent.clockInAt ? this.parseDate(intent.clockInAt, 'clockInAt') : null;
        const notes = this.trimOptional(intent.notes) ?? null;
        const operationId = timeCardClockInOperationId(tenantId, normalizedIdempotencyKey);
        const requestHash = timeCardClockInRequestHash({ actorUserId, targetUserId,
            locationId: intent.locationId ?? null, shiftId: intent.shiftId ?? null,
            clockInAt: requestedClockInAt?.toISOString() ?? null, notes });
        const scope = { userId: targetUserId };
        const receipt = async (tx: TenantPrismaTransaction, current: TimeAuthority, assertCurrent: () => void) => {
            this.resolveWritableUserId(current.req, intent.userId);
            this.assertManualClockEventAllowed(current.req, intent.clockInAt, 'clockInAt');
            const replay = await this.findClockInReplay(tx, tenantId, operationId, requestHash, assertCurrent);
            assertCurrent();
            return replay;
        };
        return this.runTimeAction({ user: { sub: capturedActor.userId, tenantId: capturedActor.tenantId,
            sessionId: capturedActor.sessionId } }, 'time_cards:write', scope, async (tx, current, assertCurrent) => {
            this.resolveWritableUserId(current.req, intent.userId);
            this.assertManualClockEventAllowed(current.req, intent.clockInAt, 'clockInAt');
            const replay = await this.findClockInReplay(tx, tenantId, operationId, requestHash, assertCurrent);
            assertCurrent();
            if (replay) return this.serialize(replay);

            const entitlement = await this.featureAccessService.assertFeatureEnabledInTransaction(
                tx,
                tenantId,
                'time_cards',
            );
            assertCurrent();

            await this.assertUserInTenant(tx, targetUserId, tenantId);
            assertCurrent();
            const openCard = await tx.timeCard.findFirst({
                where: {
                    tenantId,
                    userId: targetUserId,
                    status: TIME_CARD_STATUS.OPEN,
                    deletedAt: null,
                },
                select: { id: true },
            });
            assertCurrent();
            if (openCard) {
                throw new BadRequestException('This employee already has an open time card.');
            }

            const shift = intent.shiftId ? await this.assertShiftInTenant(tx, intent.shiftId, tenantId, targetUserId) : null;
            assertCurrent();
            const locationId = intent.locationId ?? shift?.locationId ?? null;
            if (shift && locationId && locationId !== shift.locationId) {
                throw new BadRequestException('Time card location must match the selected shift location.');
            }
            const location = locationId
                ? await this.assertLocationInTenant(tx, locationId, tenantId)
                : null;
            assertCurrent();

            const clockInAt = requestedClockInAt ?? new Date();
            const payroll = await resolveTimeCardPayrollAssignment(tx, tenantId, clockInAt, location, assertCurrent);

            assertCurrent();
            const created = await tx.timeCard.create({
                data: {
                    tenantId,
                    userId: targetUserId,
                    locationId,
                    shiftId: intent.shiftId ?? null,
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
            assertCurrent();
            await this.featureAccessService.recordFeatureUsageInTransaction(
                tx,
                tenantId,
                entitlement,
                `Time card clock-in (${created.id})`,
                operationId,
                undefined,
                assertCurrent,
            );
            assertCurrent();
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: current.req.user.sub,
                    action: 'TIME_CARD_CLOCKED_IN',
                    resource: 'TimeCard',
                    resourceId: created.id,
                    newValue: timeCardAuditValue(created),
                },
            });
            assertCurrent();
            return this.serialize(created);
        }, {
            isRecoverable: error => this.isClockInReceiptRecovery(error),
            operation: async (tx, current, assertCurrent, error) => {
                const replay = await receipt(tx, current, assertCurrent);
                assertCurrent();
                if (replay) return this.serialize(replay);
                if (this.isUniqueConstraintError(error)) {
                    throw new BadRequestException('This employee already has an open time card.');
                }
                throw error;
            },
        });
    }

    @Post(':id/clock-out')
    @Permission('time_cards:write')
    async clockOut(@Param('id') id: string, @Body() body: ClockOutBody, @Req() req: any) {
        const intent: ClockOutBody = { clockOutAt: body.clockOutAt, breakMinutes: body.breakMinutes, notes: body.notes };
        const cardId = id;
        const requestedClockOutAt = intent.clockOutAt ? this.parseDate(intent.clockOutAt, 'clockOutAt') : null;
        return this.runTimeAction(req, 'time_cards:write', { cardId }, async (tx, current, assertCurrent) => {
            const tenantId = current.req.user.tenantId;
            this.assertManualClockEventAllowed(current.req, intent.clockOutAt, 'clockOutAt');
            const initialCard = await this.findScopedTimeCard(tx, cardId, current.req, false, assertCurrent);
            this.assertDiscoveredTarget(initialCard, current);
            assertCurrent();
            const payrollPeriods = await lockTimeCardPayrollContext(
                tx,
                tenantId,
                cardId,
                [initialCard.payrollPeriodId],
                assertCurrent,
            );
            assertCurrent();
            const card = await this.findScopedTimeCard(tx, cardId, current.req, false, assertCurrent);
            assertCurrent();
            this.assertDiscoveredTarget(card, current);
            if (card.status !== TIME_CARD_STATUS.OPEN) {
                throw new BadRequestException('This time card is already closed.');
            }

            const clockOutAt = requestedClockOutAt ?? new Date();
            if (clockOutAt <= card.clockInAt) {
                throw new BadRequestException('Clock out must be after clock in.');
            }
            assertClockOutWithinPayrollPeriod(card.payrollPeriodId, clockOutAt, payrollPeriods);

            const totalMinutes = Math.floor((clockOutAt.getTime() - card.clockInAt.getTime()) / 60000);
            const breakMinutes = this.normalizeBreakMinutes(intent.breakMinutes, totalMinutes);
            const notes = this.trimOptional(intent.notes);
            assertCurrent();
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
            assertCurrent();
            if (closeResult.count !== 1) {
                throw new ConflictException('This time card was already clocked out by another request.');
            }
            const updated = await this.findScopedTimeCard(tx, cardId, current.req, true, assertCurrent);
            assertCurrent();
            await tx.auditLog.create({
                data: {
                    tenantId,
                    userId: current.req.user.sub,
                    action: 'TIME_CARD_CLOCKED_OUT',
                    resource: 'TimeCard',
                    resourceId: updated.id,
                    oldValue: timeCardAuditValue(card),
                    newValue: timeCardAuditValue(updated),
                },
            });
            assertCurrent();
            return this.serialize(updated);
        }).catch((error: unknown) => {
            if (isPayrollLockConstraint(error)) {
                throw new ConflictException('This time card belongs to a locked payroll period and cannot be changed.');
            }
            throw error;
        });
    }

    @Patch(':id/correction')
    @Permission('time_cards:write')
    async correct(@Param('id') id: string, @Body() body: TimeCardCorrectionBody, @Req() req: any) {
        const cardId = id;
        const intent: TimeCardCorrectionBody = {};
        for (const key of ['clockInAt', 'clockOutAt', 'expectedUpdatedAt', 'reason', 'breakIntervals'] as const) {
            if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
            const value = body[key];
            (intent as any)[key] = key === 'breakIntervals' && Array.isArray(value)
                ? value.map(interval => interval && typeof interval === 'object' ? { ...interval } : interval) : value;
        }
        return this.runTimeAction(req, 'time_cards:write', { cardId }, async (tx, current, assertCurrent) => {
            this.assertCanManageTeam(current.req);
            const tenantId = current.req.user.tenantId;
            if (current.targetUserId) {
                const initial = await this.findScopedTimeCard(tx, cardId, current.req, true, assertCurrent);
                this.assertDiscoveredTarget(initial, current);
            }
            assertCurrent();
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, 'time_cards');
            assertCurrent();
            const corrected = await correctTimeCardInTransaction(tx, tenantId, current.req.user.sub, cardId, intent, assertCurrent);
            assertCurrent();
            if (corrected.payrollPeriodId && corrected.clockOutAt) {
                const periods = await lockTimeCardPayrollContext(tx, tenantId, cardId, [corrected.payrollPeriodId], assertCurrent);
                assertCurrent();
                assertClockOutWithinPayrollPeriod(corrected.payrollPeriodId, corrected.clockOutAt, periods);
            }
            assertCurrent();
            return this.serialize(corrected);
        }).catch((error: unknown) => {
            if (this.errorContainsConstraint(error, 'TimeCard_employee_no_overlap')) {
                throw new ConflictException('Corrected time cards cannot overlap another card for this employee.');
            }
            if (isPayrollLockConstraint(error)) {
                throw new ConflictException('This time card belongs to a locked payroll period and cannot be changed.');
            }
            throw error;
        });
    }

    private runTimeAction<T>(
        req: any,
        permission: string,
        target: { userId?: string; cardId?: string },
        operation: (tx: TenantPrismaTransaction, current: TimeAuthority, assertCurrent: () => void) => Promise<T>,
        recovery?: { isRecoverable: (error: unknown) => boolean;
            operation: (tx: TenantPrismaTransaction, current: TimeAuthority, assertCurrent: () => void, error: unknown) => Promise<T> },
    ): Promise<T> {
        const actor = { userId: req.user?.sub, tenantId: req.user?.tenantId, sessionId: req.user?.sessionId };
        const selectedTarget = { ...target };
        const authorize = async (tx: TenantPrismaTransaction, selected: CurrentMutationActor): Promise<TimeAuthority> => {
            let targetUserId = selectedTarget.userId;
            if (selectedTarget.cardId) {
                // Locator only: parent Tenant fence precedes combined sorted User
                // locks; the operation rebinds the scoped card before effects.
                await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${selected.tenantId} FOR UPDATE`;
                const locator = await tx.timeCard.findFirst({ where: { id: selectedTarget.cardId,
                    tenantId: selected.tenantId, deletedAt: null }, select: { userId: true } });
                targetUserId = locator?.userId;
            }
            await this.rbacService.authorizeActorMutationInTransaction(tx, selected, permission,
                targetUserId ? [targetUserId] : []);
            const access = await this.rbacService.getEffectiveAccessInTransaction(tx, selected.userId, selected.tenantId);
            return { req: { user: { sub: selected.userId, tenantId: selected.tenantId, sessionId: selected.sessionId,
                permissions: access.permissions.slice(), role: access.primaryRole } }, targetUserId };
        };
        return this.rbacService.runCurrentMutation({ actor, requiredPermission: permission,
            mfaObserver: this.authService, transactionOptions: { maxWait: 5_000, timeout: 10_000 },
        }, authorize, (tx, current, assertCurrent) => operation(tx, current, assertCurrent), recovery ? {
            isRecoverable: recovery.isRecoverable,
            operation: (tx, current, assertCurrent, _actor, error) => recovery.operation(tx, current, assertCurrent, error),
        } : undefined);
    }

    private assertDiscoveredTarget(card: any, current: TimeAuthority): void {
        if (current.targetUserId && current.targetUserId !== card.userId) {
            throw new ConflictException('This time card changed while authorization was being checked.');
        }
    }

    private isClockInReceiptRecovery(error: unknown): boolean {
        if (error instanceof BadRequestException && error.message === 'This employee already has an open time card.') return true;
        if (error instanceof HttpException || !error || typeof error !== 'object') return false;
        const value = error as { code?: unknown; meta?: { code?: unknown } };
        const code = value.code;
        if (typeof code !== 'string') return false;
        if (['P2002', 'P2028', 'P1001', 'P1002', 'P1017'].includes(code)) return true;
        if (code !== 'P2010') return false;
        const sqlState = value.meta?.code;
        return typeof sqlState === 'string' && ['55P03', '57014', '08006', '57P01'].includes(sqlState);
    }

    private async findClockInReplay(
        tx: TenantPrismaTransaction,
        tenantId: string,
        operationId: string,
        requestHash: string,
        assertCurrent: () => void = () => {},
    ): Promise<any | null> {
        const existing = await tx.timeCard.findUnique({
            where: { clockInOperationId: operationId },
            include: this.includeRelations(),
        });
        assertCurrent();
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

    private async findScopedTimeCard(tx: TenantPrismaTransaction, id: string, req: any, includeClosed: boolean, assertCurrent: () => void = () => {}) {
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
        assertCurrent();
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
