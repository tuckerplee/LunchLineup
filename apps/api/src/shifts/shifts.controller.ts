import { Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, SetMetadata, Query, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { PrismaClient } from '@prisma/client';
import { NotificationType, NotificationsService } from '../notifications/notifications.service';

const Permission = (perm: string) => SetMetadata('permission', perm);

@Controller({ path: 'shifts', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class ShiftsController {
    private prisma = new PrismaClient();
    constructor(private readonly notificationsService: NotificationsService) { }

    private formatShiftWindow(startTime: Date, endTime: Date): string {
        const start = startTime.toISOString().replace('T', ' ').slice(0, 16);
        const end = endTime.toISOString().replace('T', ' ').slice(0, 16);
        return `${start} - ${end} UTC`;
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
        const where: any = { tenantId, deletedAt: null };
        if (locationId) where.locationId = locationId;
        if (scheduleId) where.scheduleId = scheduleId;
        if (startDate && endDate) {
            where.startTime = { gte: new Date(startDate) };
            where.endTime = { lte: new Date(endDate) };
        }

        const shifts = await this.prisma.shift.findMany({ where });
        return { data: shifts, tenantId };
    }

    /**
     * Lightweight staff roster for schedule/lunch planners.
     * Uses shifts:read permission so STAFF can access names needed for planning views.
     */
    @Get('staff-roster')
    @Permission('shifts:read')
    async staffRoster(@Req() req: any) {
        const users = await this.prisma.user.findMany({
            where: {
                tenantId: req.user.tenantId,
                deletedAt: null,
                role: { in: ['MANAGER', 'STAFF'] },
            },
            orderBy: { name: 'asc' },
            select: {
                id: true,
                name: true,
                role: true,
            },
        });

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
        const shift = await this.prisma.shift.findFirst({
            where: { id, tenantId: req.user.tenantId, deletedAt: null },
            include: { breaks: true }
        });
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
        const shift = await this.prisma.shift.create({
            data: {
                tenantId: req.user.tenantId,
                locationId: body.locationId,
                scheduleId: body.scheduleId,
                userId: body.userId,
                startTime: new Date(body.startTime),
                endTime: new Date(body.endTime),
                role: body.role,
            }
        });

        if (shift.userId) {
            await this.notificationsService.send(
                req.user.tenantId,
                shift.userId,
                NotificationType.SHIFT_ASSIGNED,
                'New shift assigned',
                `You were assigned a shift (${this.formatShiftWindow(shift.startTime, shift.endTime)}).`,
            );
        }

        return shift;
    }

    @Put(':id')
    @Permission('shifts:write')
    async update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
        const existingShift = await this.prisma.shift.findFirst({
            where: { id, tenantId: req.user.tenantId, deletedAt: null },
            select: {
                id: true,
                userId: true,
                startTime: true,
                endTime: true,
                role: true,
            },
        });
        if (!existingShift) throw new NotFoundException('Shift not found');

        const data: any = {};
        if (Object.prototype.hasOwnProperty.call(body, 'userId')) data.userId = body.userId ?? null;
        if (body.startTime) data.startTime = new Date(body.startTime);
        if (body.endTime) data.endTime = new Date(body.endTime);
        if (body.role) data.role = body.role;

        const updateResult = await this.prisma.shift.updateMany({
            where: { id, tenantId: req.user.tenantId },
            data
        });

        if (updateResult.count === 0) throw new NotFoundException('Shift not found');
        const updatedShift = await this.findOne(id, req);
        const assignmentChanged = existingShift.userId !== updatedShift.userId;
        const detailsChanged =
            existingShift.startTime.getTime() !== updatedShift.startTime.getTime() ||
            existingShift.endTime.getTime() !== updatedShift.endTime.getTime() ||
            existingShift.role !== updatedShift.role;

        if (updatedShift.userId && assignmentChanged) {
            await this.notificationsService.send(
                req.user.tenantId,
                updatedShift.userId,
                NotificationType.SHIFT_ASSIGNED,
                'New shift assigned',
                `You were assigned a shift (${this.formatShiftWindow(updatedShift.startTime, updatedShift.endTime)}).`,
            );
        } else if (updatedShift.userId && detailsChanged) {
            await this.notificationsService.send(
                req.user.tenantId,
                updatedShift.userId,
                NotificationType.SHIFT_CHANGED,
                'Shift updated',
                `Your shift was updated (${this.formatShiftWindow(updatedShift.startTime, updatedShift.endTime)}).`,
            );
        }

        return updatedShift;
    }

    @Delete(':id')
    @Permission('shifts:delete')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string, @Req() req: any) {
        await this.prisma.shift.updateMany({
            where: { id, tenantId: req.user.tenantId },
            data: { deletedAt: new Date() }
        });
    }

    /**
     * Bulk assign shifts via drag-and-drop.
     * Used by the frontend scheduling grid.
     */
    @Post('bulk-assign')
    @Permission('shifts:write')
    async bulkAssign(@Body() body: { assignments: Array<{ shiftId: string; userId: string }> }, @Req() req: any) {
        // Process in transaction
        const updates = body.assignments.map(a =>
            this.prisma.shift.updateMany({
                where: { id: a.shiftId, tenantId: req.user.tenantId },
                data: { userId: a.userId }
            })
        );

        await this.prisma.$transaction(updates);

        const assignedShifts = await this.prisma.shift.findMany({
            where: {
                tenantId: req.user.tenantId,
                id: { in: body.assignments.map((assignment) => assignment.shiftId) },
                deletedAt: null,
            },
            select: {
                id: true,
                userId: true,
                startTime: true,
                endTime: true,
            },
        });

        await this.notificationsService.sendMany(
            assignedShifts
                .filter((shift) => Boolean(shift.userId))
                .map((shift) => ({
                    tenantId: req.user.tenantId,
                    userId: shift.userId as string,
                    type: NotificationType.SHIFT_ASSIGNED,
                    title: 'New shift assigned',
                    body: `You were assigned a shift (${this.formatShiftWindow(shift.startTime, shift.endTime)}).`,
                })),
        );

        return { updated: updates.length };
    }
}
