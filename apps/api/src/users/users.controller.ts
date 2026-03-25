import { Controller, Get, Post, Put, Delete, Param, Body, Req, UseGuards, SetMetadata, Query, HttpCode, HttpStatus, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { PrismaClient } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { assertTenantCanAddActiveUser } from '../billing/user-capacity';
import { RbacService } from '../auth/rbac.service';

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
    private static readonly SYSTEM_EMAIL_DOMAIN = 'staff.lunchlineup.local';
    private static readonly WORKSPACE_SETTINGS_KEY = 'workspace_settings';

    constructor(
        private readonly authService: AuthService,
        private readonly rbacService: RbacService,
    ) { }

    private isSystemGeneratedEmail(email: string): boolean {
        return email.endsWith(`@${UsersController.SYSTEM_EMAIL_DOMAIN}`);
    }

    private sanitizeEmailForResponse(email: string | null): string {
        if (!email) return '';
        return this.isSystemGeneratedEmail(email) ? '' : email;
    }

    private normalizeUsername(username?: string): string | null {
        const normalized = (username ?? '').trim().toLowerCase();
        return normalized || null;
    }

    private usernameFromName(name: string): string {
        const base = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '.')
            .replace(/^\.+|\.+$/g, '')
            .slice(0, 28);
        if (!base) return 'staff.user';
        return base.length < 3 ? `${base}.usr` : base;
    }

    private async generateUniqueUsername(tenantId: string, name: string): Promise<string> {
        const seed = this.usernameFromName(name);
        let candidate = seed;
        for (let i = 0; i < 20; i += 1) {
            const taken = await this.prisma.user.findFirst({
                where: { tenantId, username: candidate, deletedAt: null },
                select: { id: true },
            });
            if (!taken) return candidate;
            candidate = `${seed.slice(0, 24)}.${Math.floor(1000 + Math.random() * 9000)}`;
        }
        return `${seed.slice(0, 20)}.${Date.now().toString().slice(-6)}`;
    }

    private createTemporaryPin(): string {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    private async resolveInviteRole(tenantId: string, requestedRole?: UserRoleValue): Promise<UserRoleValue> {
        if (requestedRole) {
            return requestedRole;
        }

        const workspaceSettings = await this.prisma.tenantSetting.findUnique({
            where: {
                tenantId_key: {
                    tenantId,
                    key: UsersController.WORKSPACE_SETTINGS_KEY,
                },
            },
            select: { value: true },
        });

        const defaultInviteRole = workspaceSettings?.value && typeof workspaceSettings.value === 'object' && !Array.isArray(workspaceSettings.value)
            ? (workspaceSettings.value as { team?: { defaultInviteRole?: unknown } }).team?.defaultInviteRole
            : undefined;

        if (defaultInviteRole === USER_ROLE.MANAGER) {
            return USER_ROLE.MANAGER;
        }
        if (defaultInviteRole === USER_ROLE.STAFF) {
            return USER_ROLE.STAFF;
        }
        return USER_ROLE.STAFF;
    }

    @Get()
    @Permission('users:read')
    async findAll(@Req() req: any, @Query('locationId') locationId?: string) {
        await this.rbacService.ensureTenantRoles(req.user.tenantId);
        const users = await this.prisma.user.findMany({
            where: { tenantId: req.user.tenantId, deletedAt: null },
            orderBy: { createdAt: 'asc' },
        });

        const roleAssignments = await Promise.all(
            users.map((user) => this.rbacService.getUserRoleAssignments(user.id, req.user.tenantId)),
        );

        return {
            data: users.map((u: any, index: number) => ({
                id: u.id,
                name: u.name,
                email: this.sanitizeEmailForResponse(u.email),
                username: u.username ?? '',
                role: u.role,
                pinEnabled: Boolean(u.pinHash),
                pinResetRequired: Boolean(u.pinResetRequired),
                assignedRoles: roleAssignments[index] ?? [],
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
        const assignedRoles = await this.rbacService.getUserRoleAssignments(user.id, req.user.tenantId);
        return {
            id: user.id,
            name: user.name,
            email: this.sanitizeEmailForResponse(user.email),
            username: user.username ?? '',
            role: user.role,
            pinEnabled: Boolean(user.pinHash),
            pinResetRequired: Boolean(user.pinResetRequired),
            assignedRoles,
        };
    }

    @Post('invite')
    @Permission('users:write')
    async invite(@Body() body: { email?: string; username?: string; pin?: string; name: string; role?: UserRoleValue; roleId?: string }, @Req() req: any) {
        const normalizedName = (body.name || '').trim();
        const normalizedEmail = (body.email || '').trim().toLowerCase();
        const normalizedUsername = this.normalizeUsername(body.username);
        const normalizedPin = (body.pin || '').trim();
        const hasEmail = Boolean(normalizedEmail);
        const hasUsername = Boolean(normalizedUsername);

        if (!normalizedName) {
            throw new BadRequestException('Name is required');
        }

        if (!hasEmail && !hasUsername) {
            throw new BadRequestException('Provide either email or username');
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

        await assertTenantCanAddActiveUser(this.prisma, req.user.tenantId);

        const requestedLegacyRole = await this.resolveInviteRole(req.user.tenantId, body.role);
        const requestedRoleId = (body.roleId || '').trim();
        const availableRoles = await this.rbacService.listRolesForTenant(req.user.tenantId);
        const selectedRole = requestedRoleId
            ? availableRoles.find((role) => role.id === requestedRoleId)
            : availableRoles.find((role) => role.legacyRole === requestedLegacyRole);

        if (!selectedRole) {
            throw new BadRequestException('Selected role is invalid for this tenant');
        }

        const selectedPermissions = selectedRole.rolePermissions.map((item) => item.permission.key);
        const requiresEmail = selectedPermissions.includes('auth:login_email');
        const allowsPin = selectedPermissions.includes('auth:login_pin');

        if (requiresEmail && !hasEmail) {
            throw new BadRequestException('Email is required for the selected role');
        }
        if (!allowsPin && hasUsername) {
            throw new BadRequestException('Username and PIN login is not enabled for the selected role');
        }

        const user = await this.prisma.user.create({
            data: {
                tenantId: req.user.tenantId,
                email: normalizedEmail || null,
                username: normalizedUsername,
                name: normalizedName,
                role: requestedLegacyRole,
            },
        });

        await this.rbacService.assignRolesToUser(user.id, req.user.tenantId, [selectedRole.id]);

        let temporaryPin: string | null = null;
        if (normalizedUsername && allowsPin) {
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
            assignedRoles: await this.rbacService.getUserRoleAssignments(user.id, req.user.tenantId),
            status: 'INVITED',
        };
    }

    @Put(':id/role')
    @Permission('users:admin')
    async updateRole(@Param('id') id: string, @Body() body: { role: UserRoleValue }, @Req() req: any) {
        const updated = await this.prisma.user.updateMany({
            where: { id, tenantId: req.user.tenantId },
            data: { role: body.role }
        });
        if (updated.count === 0) throw new NotFoundException('User not found');
        await this.rbacService.assignRolesToUser(
            id,
            req.user.tenantId,
            (
                await this.rbacService.listRolesForTenant(req.user.tenantId)
            ).filter((role) => role.legacyRole === body.role).map((role) => role.id).slice(0, 1),
        );
        return {
            id,
            role: body.role,
            assignedRoles: await this.rbacService.getUserRoleAssignments(id, req.user.tenantId),
        };
    }

    @Post(':id/pin/reset')
    @Permission('users:admin')
    async resetUserPin(@Param('id') id: string, @Body() body: { pin?: string }, @Req() req: any) {
        const user = await this.prisma.user.findFirst({
            where: { id, tenantId: req.user.tenantId, deletedAt: null },
            select: { id: true, username: true, role: true, name: true, email: true },
        });
        if (!user) throw new NotFoundException('User not found');

        let username = user.username;
        if (!username) {
            const canBootstrapUsername = !user.email || this.isSystemGeneratedEmail(user.email);
            if (!canBootstrapUsername) {
                throw new BadRequestException('PIN reset is only available for username accounts');
            }

            username = await this.generateUniqueUsername(req.user.tenantId, user.name);
            await this.prisma.user.update({
                where: { id: user.id },
                data: { username },
            });
        }

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

        return { id: user.id, username, temporaryPin: newPin, pinResetRequired: true };
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

    @Get('access/catalog')
    @Permission('roles:read')
    async accessCatalog(@Req() req: any) {
        const [permissions, roles] = await Promise.all([
            this.rbacService.listPermissions(),
            this.rbacService.listRolesForTenant(req.user.tenantId),
        ]);

        return {
            permissions: permissions.map((permission) => ({
                key: permission.key,
                label: permission.label,
                description: permission.description,
                category: permission.category,
            })),
            roles: roles.map((role) => ({
                id: role.id,
                name: role.name,
                slug: role.slug,
                description: role.description,
                isSystem: role.isSystem,
                isDefault: role.isDefault,
                legacyRole: role.legacyRole,
                userCount: role._count.assignments,
                permissions: role.rolePermissions.map((item) => item.permission.key).sort(),
            })),
        };
    }

    @Get(':id/access')
    @Permission('roles:read')
    async userAccess(@Param('id') id: string, @Req() req: any) {
        const user = await this.prisma.user.findFirst({
            where: { id, tenantId: req.user.tenantId, deletedAt: null },
            select: { id: true, role: true, tenantId: true },
        });
        if (!user) throw new NotFoundException('User not found');

        const access = await this.rbacService.getEffectiveAccess(user.id, user.tenantId);
        return access;
    }

    @Put(':id/access')
    @Permission('roles:assign')
    async updateUserAccess(@Param('id') id: string, @Body() body: { roleIds: string[] }, @Req() req: any) {
        const user = await this.prisma.user.findFirst({
            where: { id, tenantId: req.user.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!user) throw new NotFoundException('User not found');

        const assignedRoles = await this.rbacService.assignRolesToUser(id, req.user.tenantId, Array.isArray(body.roleIds) ? body.roleIds : []);
        return { id, assignedRoles };
    }

    @Post('roles')
    @Permission('roles:write')
    async createAccessRole(
        @Body() body: { name: string; description?: string; permissionKeys: string[] },
        @Req() req: any,
    ) {
        try {
            const role = await this.rbacService.createRole(req.user.tenantId, body);
            return {
                id: role.id,
                name: role.name,
                description: role.description,
                isSystem: role.isSystem,
                permissions: role.rolePermissions.map((item) => item.permission.key).sort(),
            };
        } catch (error) {
            throw new ConflictException(error instanceof Error ? error.message : 'Unable to create role');
        }
    }

    @Put('roles/:roleId')
    @Permission('roles:write')
    async updateAccessRole(
        @Param('roleId') roleId: string,
        @Body() body: { name: string; description?: string; permissionKeys: string[] },
        @Req() req: any,
    ) {
        const role = await this.rbacService.updateRole(req.user.tenantId, roleId, body);
        if (!role) throw new NotFoundException('Role not found');
        return {
            id: role.id,
            name: role.name,
            description: role.description,
            isSystem: role.isSystem,
            userCount: role._count.assignments,
            permissions: role.rolePermissions.map((item) => item.permission.key).sort(),
        };
    }

    @Delete('roles/:roleId')
    @Permission('roles:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteAccessRole(@Param('roleId') roleId: string, @Req() req: any) {
        const deleted = await this.rbacService.deleteRole(req.user.tenantId, roleId);
        if (!deleted) {
            throw new NotFoundException('Role not found or cannot be deleted');
        }
    }
}
