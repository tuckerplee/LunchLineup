import { Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, SetMetadata, Query, HttpCode, HttpStatus, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { PrismaClient } from '@prisma/client';

const Permission = (perm: string) => SetMetadata('permission', perm);

@Controller({ path: 'locations', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class LocationsController {
    private prisma = new PrismaClient();

    @Get()
    @Permission('locations:read')
    async findAll(@Req() req: any) {
        const tenantId = req.user.tenantId;
        const locations = await this.prisma.location.findMany({
            where: { tenantId, deletedAt: null }
        });
        return { data: locations, tenantId };
    }

    @Get(':id')
    @Permission('locations:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        const location = await this.prisma.location.findFirst({
            where: { id, tenantId: req.user.tenantId, deletedAt: null }
        });
        if (!location) throw new NotFoundException('Location not found');
        return location;
    }

    @Post()
    async create(
        @Body() body: { name: string; address?: string; timezone?: string; tenantName?: string },
        @Req() req: any,
    ) {
        const tenantId = req.user.tenantId;
        const userRole = req.user.role;
        const locationName = body.name?.trim();
        const tenantName = body.tenantName?.trim();

        if (!locationName) {
            throw new BadRequestException('Location name is required');
        }

        const existingLocationCount = await this.prisma.location.count({
            where: { tenantId, deletedAt: null },
        });
        const isBootstrapCreate = existingLocationCount === 0;
        const canWrite = ['SUPER_ADMIN', 'ADMIN'].includes(userRole) || isBootstrapCreate;
        if (!canWrite) {
            throw new ForbiddenException('Insufficient permissions for locations:write');
        }

        const location = await this.prisma.$transaction(async (tx) => {
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
                    timezone: body.timezone,
                    tenantId,
                },
            });
        });

        return location;
    }

    @Put(':id')
    @Permission('locations:write')
    async update(@Param('id') id: string, @Body() body: any, @Req() req: any) {
        const location = await this.prisma.location.updateMany({
            where: { id, tenantId: req.user.tenantId },
            data: body
        });
        if (location.count === 0) throw new NotFoundException('Location not found');
        return this.findOne(id, req);
    }

    @Delete(':id')
    @Permission('locations:delete')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Param('id') id: string, @Req() req: any) {
        await this.prisma.location.updateMany({
            where: { id, tenantId: req.user.tenantId },
            data: { deletedAt: new Date() }
        });
    }
}
