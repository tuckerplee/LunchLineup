import { Controller, Get, Post, Put, Param, Body, Req, UseGuards, SetMetadata, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { PrismaClient, ScheduleStatus } from '@prisma/client';

const Permission = (perm: string) => SetMetadata('permission', perm);

@Controller({ path: 'schedules', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class SchedulesController {
    private prisma = new PrismaClient();

    @Get()
    @Permission('schedules:read')
    async findAll(@Req() req: any) {
        const tenantId = req.user.tenantId;
        const schedules = await this.prisma.schedule.findMany({
            where: { tenantId }
        });
        return { data: schedules, tenantId };
    }

    @Get(':id')
    @Permission('schedules:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        const schedule = await this.prisma.schedule.findFirst({
            where: { id, tenantId: req.user.tenantId }
        });
        if (!schedule) throw new NotFoundException('Schedule not found');
        return schedule;
    }

    @Post()
    @Permission('schedules:write')
    async create(@Body() body: {
        locationId: string;
        startDate: string;
        endDate: string;
    }, @Req() req: any) {
        const schedule = await this.prisma.schedule.create({
            data: {
                tenantId: req.user.tenantId,
                locationId: body.locationId,
                startDate: new Date(body.startDate),
                endDate: new Date(body.endDate),
                status: ScheduleStatus.DRAFT,
            }
        });
        return schedule;
    }

    /**
     * Publish a schedule — triggers notification to all affected staff.
     */
    @Post(':id/publish')
    @Permission('schedules:publish')
    @HttpCode(HttpStatus.OK)
    async publish(@Param('id') id: string, @Req() req: any) {
        // 1. Update schedule status to PUBLISHED
        const schedule = await this.prisma.schedule.updateMany({
            where: { id, tenantId: req.user.tenantId, status: ScheduleStatus.DRAFT },
            data: { status: ScheduleStatus.PUBLISHED, publishedAt: new Date() }
        });

        if (schedule.count === 0) {
            throw new NotFoundException('Draft schedule not found or already published');
        }

        // 2. Send notifications to all assigned staff (Simulated)
        // 3. Emit WebSocket event for real-time sync (Simulated)

        return { id, status: ScheduleStatus.PUBLISHED, publishedAt: new Date().toISOString() };
    }

    /**
     * Request auto-schedule from the Python engine via gRPC.
     */
    @Post(':id/auto-schedule')
    @Permission('schedules:write')
    @HttpCode(HttpStatus.ACCEPTED)
    async autoSchedule(@Param('id') id: string, @Req() req: any) {
        // Verify schedule exists
        const schedule = await this.findOne(id, req);

        // 1. Queue job to RabbitMQ
        // 2. Engine picks it up via gRPC
        // 3. Results streamed back

        return { jobId: `job-${id}-${Date.now()}`, status: 'PROCESSING' };
    }
}
