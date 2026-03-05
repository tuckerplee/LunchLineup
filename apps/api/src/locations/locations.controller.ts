import { Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, SetMetadata, Query, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
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
    @Permission('locations:write')
    async create(@Body() body: { name: string; address?: string; timezone?: string }, @Req() req: any) {
        const location = await this.prisma.location.create({
            data: { ...body, tenantId: req.user.tenantId }
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
