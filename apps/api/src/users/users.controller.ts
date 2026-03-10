import { Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, SetMetadata, Query, HttpCode, HttpStatus, NotFoundException, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { PrismaClient } from '@prisma/client';
import { AuthService } from '../auth/auth.service';

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
    private static readonly USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;
    private static readonly PIN_REGEX = /^\d{4,8}$/;

    constructor(private readonly authService: AuthService) { }

    private isSystemGeneratedEmail(email: string): boolean {
        return email.endsWith('@staff.lunchlineup.local');
    }

    private sanitizeEmailForResponse(email: string | null): string {
        if (!email) return '';
        return this.isSystemGeneratedEmail(email) ? '' : email;
    }

    private normalizeUsername(username?: string): string | null {
        const normalized = (username ?? '').trim().toLowerCase();
        return normalized || null;
    }

    private createTemporaryPin(): string {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    @Get()
    @Permission('users:read')
    async findAll(@Req() req: any, @Query('locationId') locationId?: string) {
        const users = await this.prisma.user.findMany({
            where: { tenantId: req.user.tenantId, deletedAt: null }
        });
        // Remove secrets before returning
        return {
            data: users.map((u: any) => ({
                id: u.id,
                name: u.name,
                email: this.sanitizeEmailForResponse(u.email),
                username: u.username ?? '',
                role: u.role,
                pinEnabled: Boolean(u.pinHash),
                pinResetRequired: Boolean(u.pinResetRequired),
            })),
            tenantId: req.user.tenantId,
        };
    }

    @Get(':id')
    @Permission('users:read')
    async findOne(@Param('id') id: string, @Req() req: any) {
        const user = await this.prisma.user.findFirst({
            where: { id, tenantId: req.user.tenantId, deletedAt: null }
        });
        if (!user) throw new NotFoundException('User not found');
        return {
            id: user.id,
            name: user.name,
            email: this.sanitizeEmailForResponse(user.email),
            username: user.username ?? '',
            role: user.role,
            pinEnabled: Boolean(user.pinHash),
            pinResetRequired: Boolean(user.pinResetRequired),
        };
    }

    @Post('invite')
    @Permission('users:write')
    async invite(@Body() body: { email?: string; username?: string; pin?: string; name: string; role?: UserRoleValue }, @Req() req: any) {
        const role = body.role || USER_ROLE.STAFF;
        const normalizedName = (body.name || '').trim();
        const normalizedEmail = (body.email || '').trim().toLowerCase();
        const normalizedUsername = this.normalizeUsername(body.username);
        const normalizedPin = (body.pin || '').trim();
        const requiresEmail = role === USER_ROLE.ADMIN || role === USER_ROLE.SUPER_ADMIN;
        const hasEmail = Boolean(normalizedEmail);
        const hasUsername = Boolean(normalizedUsername);

        if (!normalizedName) {
            throw new BadRequestException('Name is required');
        }

        if (!hasEmail && !hasUsername) {
            throw new BadRequestException('Provide either email or username');
        }

        if (requiresEmail && !hasEmail) {
            throw new BadRequestException('Email is required for admin accounts');
        }

        if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
            throw new BadRequestException('Invalid email address');
        }

        if (normalizedUsername && !UsersController.USERNAME_REGEX.test(normalizedUsername)) {
            throw new BadRequestException('Username must be 3-32 chars using lowercase letters, numbers, ., _, -');
        }

        if (normalizedPin && !UsersController.PIN_REGEX.test(normalizedPin)) {
            throw new BadRequestException('PIN must be 4-8 numeric digits');
        }

        if (normalizedEmail && normalizedUsername) {
            throw new BadRequestException('Choose email login or username login, not both');
        }

        const user = await this.prisma.user.create({
            data: {
                tenantId: req.user.tenantId,
                email: normalizedEmail || null,
                username: normalizedUsername,
                name: normalizedName,
                role,
            }
        });

        let temporaryPin: string | null = null;
        if (normalizedUsername) {
            temporaryPin = normalizedPin || this.createTemporaryPin();
            await this.authService.setUserPin(user.id, temporaryPin, !normalizedPin);
        }

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

        return {
            id: user.id,
            email: this.sanitizeEmailForResponse(user.email),
            username: user.username ?? '',
            name: user.name,
            role: user.role,
            pinEnabled: Boolean(user.pinHash) || Boolean(normalizedUsername),
            pinResetRequired: Boolean(normalizedUsername) && !normalizedPin,
            temporaryPin,
            status: 'INVITED',
        };
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

    @Post(':id/pin/reset')
    @Permission('users:admin')
    async resetUserPin(@Param('id') id: string, @Body() body: { pin?: string }, @Req() req: any) {
        const user = await this.prisma.user.findFirst({
            where: { id, tenantId: req.user.tenantId, deletedAt: null },
            select: { id: true, username: true, role: true },
        });
        if (!user) throw new NotFoundException('User not found');
        if (!user.username) throw new BadRequestException('PIN reset is only available for username accounts');

        const newPin = (body.pin || '').trim() || this.createTemporaryPin();
        await this.authService.setUserPin(user.id, newPin, true);

        await this.prisma.auditLog.create({
            data: {
                tenantId: req.user.tenantId,
                userId: req.user.sub,
                action: 'USER_PIN_RESET',
                resource: 'User',
                resourceId: user.id,
            },
        });

        return { id: user.id, username: user.username, temporaryPin: newPin, pinResetRequired: true };
    }

    @Put('me/pin')
    async rotateOwnPin(@Req() req: any, @Body() body: { currentPin: string; newPin: string }) {
        await this.authService.rotateOwnPin(req.user.sub, body.currentPin, body.newPin);
        return { success: true };
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
