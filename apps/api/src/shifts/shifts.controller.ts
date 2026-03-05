import { Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, SetMetadata, Query, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { PrismaClient } from '@prisma/client';

const Permission = (perm: string) => SetMetadata('permission', perm);

@Controller({ path: 'shifts', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class ShiftsController {
    private prisma = new PrismaClient();

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
        return shift;
    }

    @Put(':id')
    @Permission('shifts:write')
    async update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
        const data: any = {};
        if (body.userId) data.userId = body.userId;
        if (body.startTime) data.startTime = new Date(body.startTime);
        if (body.endTime) data.endTime = new Date(body.endTime);
        if (body.role) data.role = body.role;

        const updateResult = await this.prisma.shift.updateMany({
            where: { id, tenantId: req.user.tenantId },
            data
        });

        if (updateResult.count === 0) throw new NotFoundException('Shift not found');
        return this.findOne(id, req);
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
        return { updated: updates.length };
    }
}
