import { Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, SetMetadata, Query, HttpCode, HttpStatus, NotFoundException, BadRequestException, ConflictException, Optional } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { Prisma, UserRole } from '@prisma/client';
import { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import { FeatureAccessService } from '../billing/feature-access.service';
import {
    dateValueInTimeZone,
    localDateBoundaryUtc,
    nextLocalDateBoundaryUtc,
    normalizeTimeZone,
} from '../common/location-timezone';

const Permission = (perm: string) => SetMetadata('permission', perm);
const UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
const SCHEDULABLE_USER_ROLES = [UserRole.MANAGER, UserRole.STAFF];
const MAX_BULK_ASSIGNMENTS = 500;
const schedulableShiftUserFilter = {
    OR: [
        { userId: null },
        { user: { is: { role: { in: SCHEDULABLE_USER_ROLES }, deletedAt: null } } },
    ],
};

type ShiftScheduleWindow = {
    id: string;
    locationId: string;
    status: string;
    startDate: Date;
    endDate: Date;
};

type LockedActiveLocationRow = {
    id: string;
    timezone: string;
};

@Controller({ path: 'shifts', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class ShiftsController {
    private readonly tenantDb: TenantPrismaService;

    constructor(
        private readonly featureAccessService: FeatureAccessService,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
    }

    @Get()
    @Permission('shifts:read')
    async findAll(
        @Req() req: any,
        @Query('locationId') locationId?: string,
        @Query('scheduleId') scheduleId?: string,
        @Query('startDate') startDate?: string,
        @Query('endDate') endDate?: string,
    ) {
        const tenantId = req.user.tenantId;
        const where: any = {
            tenantId,
            deletedAt: null,
            location: { is: { deletedAt: null } },
        };
        const and: any[] = [schedulableShiftUserFilter];
        if (this.isStaffUser(req)) {
            where.userId = this.actorUserId(req);
            where.schedule = { is: { status: 'PUBLISHED' } };
        }
        if (locationId) where.locationId = locationId;
        if (scheduleId) where.scheduleId = scheduleId;
        if (startDate || endDate) {
            if (startDate) and.push({ endTime: { gt: this.parseShiftDate(startDate, 'startDate') } });
            if (endDate) and.push({ startTime: { lt: this.parseShiftDate(endDate, 'endDate') } });
        }
        where.AND = and;

        const shifts = await this.tenantDb.withTenant(tenantId, (tx) => tx.shift.findMany({
            where,
            orderBy: { startTime: 'asc' },
            include: {
                user: { select: { id: true, name: true, role: true } },
                breaks: { orderBy: { startTime: 'asc' } },
            },
        }));
        return { data: shifts, tenantId };
    }

    /**
     * Lightweight staff roster for schedule/lunch planners.
     * Uses shifts:read permission so STAFF can access names needed for planning views.
     */
    @Get('staff-roster')
    @Permission('shifts:read')
    async staffRoster(@Req() req: any) {
        const tenantId = req.user.tenantId;
        const where: any = {
            tenantId,
            deletedAt: null,
            role: { in: SCHEDULABLE_USER_ROLES },
        };
        if (this.isStaffUser(req)) where.id = this.actorUserId(req);
        const users = await this.tenantDb.withTenant(tenantId, (tx) => tx.user.findMany({
            where,
            orderBy: { name: 'asc' },
            select: {
                id: true,
                name: true,
                role: true,
            },
        }));

        return {
            data: users.map((user) => ({
                id: user.id,
                name: user.name || 'Unnamed',
                role: user.role,
            })),
        };
    }

    @Get(':id')
    @Permission('shifts:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const shift = await this.tenantDb.withTenant(tenantId, (tx) => this.findShiftById(tx, id, tenantId, req));
        if (!shift) throw new NotFoundException('Shift not found');
        return shift;
    }

    @Post()
    @Permission('shifts:write')
    async create(@Body() body: {
        locationId: string;
        scheduleId?: string;
        userId?: string;
        startTime: string;
        endTime: string;
        role?: string;
    }, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const startTime = this.parseShiftDate(body.startTime, 'startTime');
        const endTime = this.parseShiftDate(body.endTime, 'endTime');
        this.assertShiftWindow(startTime, endTime);
        await this.assertSchedulingFeature(tenantId);

        const shift = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantSchedulingMutations(tx, tenantId);
            const location = await this.assertLocationInTenant(tx, body.locationId, tenantId);
            if (body.userId) {
                await this.assertUserInTenant(tx, body.userId, tenantId);
            }

            const schedule = body.scheduleId
                ? await this.assertScheduleInTenant(tx, body.scheduleId, tenantId, body.locationId)
                : await this.findOrCreateContainingDraftSchedule(
                    tx,
                    tenantId,
                    body.locationId,
                    startTime,
                    endTime,
                    location.timezone,
                );
            this.assertShiftWithinSchedule(startTime, endTime, schedule);
            await this.assertNoShiftOverlap(tx, tenantId, body.userId ?? null, startTime, endTime);

            const shift = await tx.shift.create({
                data: {
                    tenantId,
                    locationId: body.locationId,
                    scheduleId: schedule.id,
                    userId: body.userId,
                    startTime,
                    endTime,
                    role: this.normalizeShiftRole(body.role),
                },
            });
            return shift;
        });

        return shift;
    }

    @Put(':id')
    @Permission('shifts:write')
    async update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
        const tenantId = req.user.tenantId;
        await this.assertSchedulingFeature(tenantId);
        const updatedShift = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantSchedulingMutations(tx, tenantId);
            const existingShift = await tx.shift.findFirst({
                where: { id, tenantId, deletedAt: null },
                select: {
                    id: true,
                    scheduleId: true,
                    locationId: true,
                    userId: true,
                    startTime: true,
                    endTime: true,
                    role: true,
                    location: { select: { timezone: true } },
                    schedule: { select: { id: true, locationId: true, status: true, startDate: true, endDate: true } },
                },
            });
            if (!existingShift) throw new NotFoundException('Shift not found');
            if (Object.prototype.hasOwnProperty.call(body, 'userId')) {
                await this.assertLocationInTenant(tx, existingShift.locationId, tenantId);
            }
            await this.lockScheduleRowsForMutation(tx, tenantId, [existingShift.scheduleId]);
            if (existingShift.schedule?.status === 'PUBLISHED') {
                throw new BadRequestException('Published schedules are locked. Create a new draft before changing shifts.');
            }

            const data: any = {};
            if (Object.prototype.hasOwnProperty.call(body, 'userId')) {
                if (body.userId) {
                    await this.assertUserInTenant(tx, body.userId, tenantId);
                }
                data.userId = body.userId ?? null;
            }
            const hasStartTime = Object.prototype.hasOwnProperty.call(body, 'startTime');
            const hasEndTime = Object.prototype.hasOwnProperty.call(body, 'endTime');
            const nextStartTime = hasStartTime ? this.parseShiftDate(body.startTime, 'startTime') : existingShift.startTime;
            const nextEndTime = hasEndTime ? this.parseShiftDate(body.endTime, 'endTime') : existingShift.endTime;
            const nextUserId = Object.prototype.hasOwnProperty.call(body, 'userId') ? body.userId ?? null : existingShift.userId;
            this.assertShiftWindow(nextStartTime, nextEndTime);
            if (existingShift.schedule) {
                this.assertShiftWithinSchedule(nextStartTime, nextEndTime, existingShift.schedule);
            }
            await this.assertNoShiftOverlap(tx, tenantId, nextUserId, nextStartTime, nextEndTime, [id]);
            if (hasStartTime) data.startTime = nextStartTime;
            if (hasEndTime) data.endTime = nextEndTime;
            if (Object.prototype.hasOwnProperty.call(body, 'role')) data.role = this.normalizeShiftRole(body.role);

            const updateResult = await tx.shift.updateMany({
                where: { id, tenantId },
                data
            });

            if (updateResult.count === 0) throw new NotFoundException('Shift not found');
            const updatedShift = await this.findShiftById(tx, id, tenantId);
            if (!updatedShift) throw new NotFoundException('Shift not found');
            return updatedShift;
        });

        return updatedShift;
    }

    @Delete(':id')
    @Permission('shifts:delete')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        await this.assertSchedulingFeature(tenantId);
        await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantSchedulingMutations(tx, tenantId);
            const shift = await tx.shift.findFirst({
                where: { id, tenantId, deletedAt: null },
                select: { id: true, scheduleId: true, schedule: { select: { status: true } } },
            });
            if (!shift) throw new NotFoundException('Shift not found');
            await this.lockScheduleRowsForMutation(tx, tenantId, [shift.scheduleId]);
            if (shift.schedule?.status === 'PUBLISHED') {
                throw new BadRequestException('Published schedules are locked. Create a new draft before deleting shifts.');
            }

            await tx.shift.updateMany({
                where: { id, tenantId },
                data: { deletedAt: new Date() }
            });
        });
    }

    /**
     * Bulk assign shifts via drag-and-drop.
     * Used by the frontend scheduling grid.
     */
    @Post('bulk-assign')
    @Permission('shifts:write')
    async bulkAssign(@Body() body: { assignments: Array<{ shiftId: string; userId?: string | null }> }, @Req() req: any) {
        const assignments = this.normalizeBulkAssignments(body);
        const tenantId = req.user.tenantId;
        await this.assertSchedulingFeature(tenantId);
        const shiftIds = Array.from(new Set(assignments.map((assignment) => assignment.shiftId).filter(Boolean)));
        const updated = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.lockTenantSchedulingMutations(tx, tenantId);
            const discoveredShifts = await tx.shift.findMany({
                where: {
                    tenantId,
                    id: { in: shiftIds },
                    deletedAt: null,
                },
                select: { id: true, scheduleId: true },
            });
            if (discoveredShifts.length !== shiftIds.length || discoveredShifts.some((shift) => !shift.scheduleId)) {
                throw new BadRequestException('One or more shifts are not available for this tenant.');
            }
            const discoveredScheduleByShiftId = new Map(
                discoveredShifts.map((shift) => [shift.id, shift.scheduleId]),
            );
            await this.lockScheduleRowsForMutation(
                tx,
                tenantId,
                discoveredShifts.map((shift) => shift.scheduleId),
            );

            const targetShifts = await tx.shift.findMany({
                where: {
                    tenantId,
                    id: { in: shiftIds },
                    deletedAt: null,
                },
                select: {
                    id: true,
                    scheduleId: true,
                    locationId: true,
                    startTime: true,
                    endTime: true,
                    location: { select: { timezone: true } },
                    schedule: { select: { status: true } },
                },
            });
            if (targetShifts.length !== shiftIds.length) {
                throw new BadRequestException('One or more shifts are not available for this tenant.');
            }
            if (targetShifts.some((shift) => discoveredScheduleByShiftId.get(shift.id) !== shift.scheduleId)) {
                throw new ConflictException('Shift assignments changed while this request was being validated. Retry the assignment.');
            }
            const locationIds = Array.from(new Set(targetShifts.map((shift) => shift.locationId))).sort();
            for (const locationId of locationIds) {
                await this.assertLocationInTenant(tx, locationId, tenantId);
            }
            if (targetShifts.some((shift) => shift.schedule?.status === 'PUBLISHED')) {
                throw new BadRequestException('Published schedules are locked. Create a new draft before assigning shifts.');
            }

            const shiftsById = new Map(targetShifts.map((shift) => [shift.id, shift]));
            const userIds = Array.from(new Set(assignments.map((assignment) => assignment.userId).filter(Boolean)));
            for (const userId of userIds) {
                await this.assertUserInTenant(tx, userId as string, tenantId);
            }

            const nextAssignments = assignments.map((assignment) => {
                const shift = shiftsById.get(assignment.shiftId);
                if (!shift) throw new BadRequestException('One or more shifts are not available for this tenant.');
                return {
                    shiftId: assignment.shiftId,
                    userId: assignment.userId ?? null,
                    startTime: shift.startTime,
                    endTime: shift.endTime,
                };
            });
            this.assertNoBatchOverlaps(nextAssignments);
            for (const assignment of nextAssignments) {
                await this.assertNoShiftOverlap(
                    tx,
                    tenantId,
                    assignment.userId,
                    assignment.startTime,
                    assignment.endTime,
                    shiftIds,
                );
            }

            for (const assignment of assignments) {
                const targetShift = shiftsById.get(assignment.shiftId);
                const result = await tx.shift.updateMany({
                    where: {
                        id: assignment.shiftId,
                        tenantId,
                        scheduleId: targetShift?.scheduleId,
                        deletedAt: null,
                    },
                    data: { userId: assignment.userId ?? null },
                });
                if (result.count !== 1) {
                    throw new ConflictException('Shift assignments changed while this request was being applied. Retry the assignment.');
                }
            }

            return assignments.length;
        });

        return { updated };
    }

    private async assertSchedulingFeature(tenantId: string): Promise<void> {
        await this.featureAccessService.assertFeatureEnabled(tenantId, 'scheduling');
    }

    private async assertLocationInTenant(tx: TenantPrismaTransaction, locationId: string | undefined, tenantId: string) {
        if (!locationId) throw new BadRequestException('locationId is required');
        const rows = await tx.$queryRaw<LockedActiveLocationRow[]>`
            SELECT "id", "timezone"
            FROM "Location"
            WHERE "id" = ${locationId}
              AND "tenantId" = ${tenantId}
              AND "deletedAt" IS NULL
            FOR UPDATE
        `;
        const location = rows[0];
        if (!location) throw new BadRequestException('Location is not available for this tenant.');
        return { ...location, timezone: normalizeTimeZone(location.timezone) };
    }

    private async assertScheduleInTenant(
        tx: TenantPrismaTransaction,
        scheduleId: string,
        tenantId: string,
        locationId: string,
    ): Promise<ShiftScheduleWindow> {
        await this.lockScheduleRowsForMutation(tx, tenantId, [scheduleId]);
        const schedule = await tx.schedule.findFirst({
            where: { id: scheduleId, tenantId, deletedAt: null },
            select: { id: true, locationId: true, status: true, startDate: true, endDate: true },
        });
        if (!schedule) throw new BadRequestException('Schedule is not available for this tenant.');
        if (schedule.locationId !== locationId) {
            throw new BadRequestException('Schedule is not available for this location.');
        }
        if (schedule.status !== 'DRAFT') {
            throw new BadRequestException('Published schedules are locked. Create a new draft before changing shifts.');
        }
        return schedule;
    }

    private async assertUserInTenant(tx: TenantPrismaTransaction, userId: string, tenantId: string) {
        const user = await tx.user.findFirst({
            where: { id: userId, tenantId, deletedAt: null, role: { in: SCHEDULABLE_USER_ROLES } },
            select: { id: true },
        });
        if (!user) throw new BadRequestException('User is not available for scheduling in this tenant.');
    }

    private parseShiftDate(value: string | undefined, field: string): Date {
        if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required`);
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

    private assertShiftWindow(startTime: Date, endTime: Date) {
        if (endTime <= startTime) {
            throw new BadRequestException('Shift end time must be after start time.');
        }
    }

    private assertShiftWithinSchedule(
        startTime: Date,
        endTime: Date,
        schedule: Pick<ShiftScheduleWindow, 'startDate' | 'endDate'>,
    ): void {
        if (!(schedule.startDate instanceof Date) || !(schedule.endDate instanceof Date)) {
            throw new BadRequestException('Schedule window is invalid.');
        }
        if (startTime < schedule.startDate || endTime > schedule.endDate) {
            throw new BadRequestException('Shift must stay within its schedule window.');
        }
    }

    private normalizeShiftRole(value: unknown): string | null {
        if (value === undefined || value === null || value === '') return null;
        if (typeof value !== 'string') {
            throw new BadRequestException('role must be a string');
        }
        const role = value.trim();
        if (!role) return null;
        if (role.length > 64) {
            throw new BadRequestException('role must be 64 characters or less');
        }
        return role;
    }

    private normalizeBulkAssignments(body: unknown): Array<{ shiftId: string; userId?: string | null }> {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new BadRequestException('Bulk assignment body must be an object.');
        }
        const assignments = (body as { assignments?: unknown }).assignments;
        if (!Array.isArray(assignments)) {
            throw new BadRequestException('assignments must be an array.');
        }
        if (assignments.length > MAX_BULK_ASSIGNMENTS) {
            throw new BadRequestException(`assignments must contain ${MAX_BULK_ASSIGNMENTS} or fewer items.`);
        }

        const seenShiftIds = new Set<string>();
        return assignments.map((assignment) => {
            if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
                throw new BadRequestException('Each assignment must be an object.');
            }
            const shiftId = (assignment as { shiftId?: unknown }).shiftId;
            const userId = (assignment as { userId?: unknown }).userId;
            if (typeof shiftId !== 'string' || !shiftId.trim()) {
                throw new BadRequestException('Each assignment requires a shiftId.');
            }
            const normalizedShiftId = shiftId.trim();
            if (seenShiftIds.has(normalizedShiftId)) {
                throw new BadRequestException('Each shift can only appear once in a bulk assignment.');
            }
            seenShiftIds.add(normalizedShiftId);

            if (userId === undefined || userId === null || userId === '') {
                return { shiftId: normalizedShiftId, userId: null };
            }
            if (typeof userId !== 'string' || !userId.trim()) {
                throw new BadRequestException('assignment userId must be a string or null.');
            }
            return { shiftId: normalizedShiftId, userId: userId.trim() };
        });
    }

    private async assertNoShiftOverlap(
        tx: TenantPrismaTransaction,
        tenantId: string,
        userId: string | null | undefined,
        startTime: Date,
        endTime: Date,
        excludeShiftIds: string[] = [],
    ) {
        if (!userId) return;
        const where: any = {
            tenantId,
            userId,
            deletedAt: null,
            startTime: { lt: endTime },
            endTime: { gt: startTime },
        };
        if (excludeShiftIds.length > 0) {
            where.id = { notIn: excludeShiftIds };
        }
        const overlapCount = await tx.shift.count({ where });
        if (overlapCount > 0) {
            throw new BadRequestException('User already has a shift that overlaps this time window.');
        }
    }

    private assertNoBatchOverlaps(assignments: Array<{
        shiftId: string;
        userId: string | null;
        startTime: Date;
        endTime: Date;
    }>) {
        const byUser = new Map<string, Array<{ shiftId: string; startTime: Date; endTime: Date }>>();
        for (const assignment of assignments) {
            if (!assignment.userId) continue;
            const existing = byUser.get(assignment.userId) ?? [];
            for (const other of existing) {
                if (assignment.startTime < other.endTime && assignment.endTime > other.startTime) {
                    throw new BadRequestException('Bulk assignment contains overlapping shifts for the same user.');
                }
            }
            existing.push({
                shiftId: assignment.shiftId,
                startTime: assignment.startTime,
                endTime: assignment.endTime,
            });
            byUser.set(assignment.userId, existing);
        }
    }

    private async findOrCreateContainingDraftSchedule(
        tx: TenantPrismaTransaction,
        tenantId: string,
        locationId: string,
        shiftStart: Date,
        shiftEnd: Date,
        timeZone: string,
    ): Promise<ShiftScheduleWindow> {
        const startDate = localDateBoundaryUtc(dateValueInTimeZone(shiftStart, timeZone), timeZone);
        const endDate = nextLocalDateBoundaryUtc(new Date(shiftEnd.getTime() - 1), timeZone);

        const existing = await tx.schedule.findFirst({
            where: {
                tenantId,
                locationId,
                status: 'DRAFT',
                deletedAt: null,
                startDate: { lte: shiftStart },
                endDate: { gte: shiftEnd },
            },
            orderBy: [{ startDate: 'desc' }, { endDate: 'asc' }],
            select: { id: true, locationId: true, status: true, startDate: true, endDate: true },
        });
        if (existing) {
            await this.lockScheduleRowsForMutation(tx, tenantId, [existing.id]);
            return existing;
        }

        const overlappingSchedule = await tx.schedule.findFirst({
            where: {
                tenantId,
                locationId,
                deletedAt: null,
                startDate: { lt: endDate },
                endDate: { gt: startDate },
            },
            select: { id: true, status: true },
        });
        if (overlappingSchedule) {
            await this.lockScheduleRowsForMutation(tx, tenantId, [overlappingSchedule.id]);
            if (overlappingSchedule.status === 'DRAFT') {
                throw new BadRequestException('An existing draft schedule does not contain the full shift interval. Extend that draft before adding this shift.');
            }
            throw new BadRequestException('Published schedules are locked. Create an explicit draft schedule before adding shifts.');
        }

        const created = await tx.schedule.create({
            data: {
                tenantId,
                locationId,
                startDate,
                endDate,
                status: 'DRAFT',
            },
            select: { id: true },
        });
        return {
            id: created.id,
            locationId,
            status: 'DRAFT',
            startDate,
            endDate,
        };
    }

    private isStaffUser(req: any): boolean {
        const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
        return [req.user?.legacyRole, req.user?.role, ...roles]
            .some((role) => this.isRole(role, UserRole.STAFF));
    }

    private isRole(value: unknown, expected: UserRole): boolean {
        return typeof value === 'string'
            && value.trim().replace(/[\s-]+/g, '_').toUpperCase() === expected;
    }

    private async lockScheduleRowsForMutation(
        tx: TenantPrismaTransaction,
        tenantId: string,
        scheduleIds: Array<string | null | undefined>,
    ): Promise<void> {
        const ids = Array.from(new Set(scheduleIds.filter((id): id is string => Boolean(id)))).sort();
        if (ids.length === 0) return;

        const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
            SELECT "id", "status"
            FROM "Schedule"
            WHERE "tenantId" = ${tenantId}
              AND "id" IN (${Prisma.join(ids)})
            ORDER BY "id" ASC
            FOR UPDATE
        `;
        if (rows.some((row) => row.status !== 'DRAFT')) {
            throw new BadRequestException('Published schedules are locked. Reopen the schedule before changing shifts.');
        }
    }

    private async lockTenantSchedulingMutations(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ): Promise<void> {
        await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${`lunchlineup:scheduling:${tenantId}`}, 0))
        `;
    }

    private actorUserId(req: any): string {
        return req.user?.sub ?? req.user?.id;
    }

    private async findShiftById(tx: TenantPrismaTransaction, id: string, tenantId: string, req?: any) {
        const where: any = {
            id,
            tenantId,
            deletedAt: null,
            location: { is: { deletedAt: null } },
        };
        if (req && this.isStaffUser(req)) {
            where.userId = this.actorUserId(req);
            where.schedule = { is: { status: 'PUBLISHED' } };
        }
        return tx.shift.findFirst({
            where,
            include: { breaks: true },
        });
    }
}
