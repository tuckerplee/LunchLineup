import { Controller, Get, Post, Put, Param, Body, Req, UseGuards, SetMetadata, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { PrismaClient } from '@prisma/client';
import { NotificationType, NotificationsService } from '../notifications/notifications.service';

const Permission = (perm: string) => SetMetadata('permission', perm);
const SCHEDULE_STATUS = {
    DRAFT: 'DRAFT',
    PUBLISHED: 'PUBLISHED',
} as const;

@Controller({ path: 'schedules', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class SchedulesController {
    private prisma = new PrismaClient();
    constructor(private readonly notificationsService: NotificationsService) { }

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
                status: SCHEDULE_STATUS.DRAFT,
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
        const now = new Date();

        // 1. Update schedule status to PUBLISHED
        const schedule = await this.prisma.schedule.updateMany({
            where: { id, tenantId: req.user.tenantId, status: SCHEDULE_STATUS.DRAFT },
            data: { status: SCHEDULE_STATUS.PUBLISHED, publishedAt: now }
        });

        if (schedule.count === 0) {
            throw new NotFoundException('Draft schedule not found or already published');
        }

        const publishedSchedule = await this.prisma.schedule.findFirst({
            where: { id, tenantId: req.user.tenantId },
            include: {
                location: { select: { name: true } },
            },
        });
        if (!publishedSchedule) {
            throw new NotFoundException('Published schedule not found');
        }

        const assignedUsers = await this.prisma.shift.findMany({
            where: {
                tenantId: req.user.tenantId,
                scheduleId: id,
                deletedAt: null,
                userId: { not: null },
            },
            select: { userId: true },
            distinct: ['userId'],
        });

        await this.notificationsService.sendMany(
            assignedUsers
                .filter((entry) => Boolean(entry.userId))
                .map((entry) => ({
                    tenantId: req.user.tenantId,
                    userId: entry.userId as string,
                    type: NotificationType.SCHEDULE_PUBLISHED,
                    title: 'Schedule published',
                    body: `${publishedSchedule.location.name}: ${publishedSchedule.startDate.toISOString().slice(0, 10)} to ${publishedSchedule.endDate.toISOString().slice(0, 10)}`,
                })),
        );

        return { id, status: SCHEDULE_STATUS.PUBLISHED, publishedAt: now.toISOString() };
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
