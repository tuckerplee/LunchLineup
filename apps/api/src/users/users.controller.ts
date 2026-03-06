import { Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, SetMetadata, Query, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const Permission = (perm: string) => SetMetadata('permission', perm);
type UserRoleValue = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
const USER_ROLE: Record<UserRoleValue, UserRoleValue> = {
    SUPER_ADMIN: 'SUPER_ADMIN',
    ADMIN: 'ADMIN',
    MANAGER: 'MANAGER',
    STAFF: 'STAFF',
};

@Controller({ path: 'users', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class UsersController {
    private prisma = new PrismaClient();

    @Get()
    @Permission('users:read')
    async findAll(@Req() req: any, @Query('locationId') locationId?: string) {
        const users = await this.prisma.user.findMany({
            where: { tenantId: req.user.tenantId, deletedAt: null }
        });
        // Remove secrets before returning
        return { data: users.map((u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role })), tenantId: req.user.tenantId };
    }

    @Get(':id')
    @Permission('users:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        const user = await this.prisma.user.findFirst({
            where: { id, tenantId: req.user.tenantId, deletedAt: null }
        });
        if (!user) throw new NotFoundException('User not found');
        return { id: user.id, name: user.name, email: user.email, role: user.role };
    }

    @Post('invite')
    @Permission('users:write')
    async invite(@Body() body: { email: string; name: string; role: UserRoleValue }, @Req() req: any) {
        const user = await this.prisma.user.create({
            data: {
                tenantId: req.user.tenantId,
                email: body.email,
                name: body.name,
                role: body.role || USER_ROLE.STAFF,
            }
        });

        // 2. Send invitation email handled via events/queues in real implementation
        // 3. Log to audit log
        await this.prisma.auditLog.create({
            data: {
                tenantId: req.user.tenantId,
                userId: req.user.sub,
                action: 'USER_INVITED',
                resource: 'User',
                resourceId: user.id
            }
        });

        return { id: user.id, email: user.email, name: user.name, role: user.role, status: 'INVITED' };
    }

    @Put(':id/role')
    @Permission('users:admin')
    async updateRole(@Param('id') id: string, @Body() body: { role: UserRoleValue }, @Req() req: any) {
        await this.prisma.user.updateMany({
            where: { id, tenantId: req.user.tenantId },
            data: { role: body.role }
        });
        return { id, role: body.role };
    }

    @Delete(':id')
    @Permission('users:admin')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deactivate(@Param('id') id: string, @Req() req: any) {
        // Soft delete
        await this.prisma.user.updateMany({
            where: { id, tenantId: req.user.tenantId },
            data: { deletedAt: new Date() }
        });
        // Revoke all sessions
        await this.prisma.session.updateMany({
            where: { userId: id },
            data: { revokedAt: new Date() }
        });
    }
}
