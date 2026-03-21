import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlanTier, Prisma, PrismaClient, TenantStatus, UserRole } from '@prisma/client';
import Redis from 'ioredis';
import { MetricsService } from '../common/metrics.service';
import { isTenantPlanCode, listPlanDefinitions, normalizePlanCode, planDefinitionToResponse, resolveFallbackPlanDefinition } from '../billing/plan-definitions';

@Controller({ path: 'admin', version: '1' })
@UseGuards(JwtAuthGuard)
export class AdminController {
    private prisma = new PrismaClient();
    private static readonly USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
    ) { }

    private assertSuperAdmin(req: any) {
        if (req?.user?.role !== 'SUPER_ADMIN') {
            throw new ForbiddenException('SUPER_ADMIN role required.');
        }
    }

    private toSlug(value: string): string {
        return value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64);
    }

    private isPlanTier(value: string): value is PlanTier {
        return Object.values(PlanTier).includes(value as PlanTier);
    }

    private isTenantStatus(value: string): value is TenantStatus {
        return Object.values(TenantStatus).includes(value as TenantStatus);
    }

    private isUserRole(value: string): value is UserRole {
        return Object.values(UserRole).includes(value as UserRole);
    }

    private parseOptionalIsoDate(raw?: string | null): Date | null | undefined {
        if (raw === undefined) return undefined;
        if (raw === null || raw.trim() === '') return null;
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
            throw new BadRequestException(`Invalid date: ${raw}`);
        }
        return parsed;
    }

    private mapUserStatus(user: { deletedAt: Date | null; lockedUntil: Date | null; pinLockedUntil: Date | null }): 'ACTIVE' | 'LOCKED' | 'SUSPENDED' {
        if (user.deletedAt) return 'SUSPENDED';
        const now = new Date();
        if ((user.lockedUntil && user.lockedUntil > now) || (user.pinLockedUntil && user.pinLockedUntil > now)) {
            return 'LOCKED';
        }
        return 'ACTIVE';
    }

    @Get('stats')
    async stats(@Req() req: any) {
        this.assertSuperAdmin(req);

        const now = new Date();
        const [totalTenants, totalUsers, activeSessions] = await Promise.all([
            this.prisma.tenant.count({ where: { deletedAt: null } }),
            this.prisma.user.count({ where: { deletedAt: null } }),
            this.prisma.session.count({
                where: {
                    revokedAt: null,
                    expiresAt: { gt: now },
                },
            }),
        ]);

        return {
            totalTenants,
            totalUsers,
            activeSessions,
            solverQueue: 0,
        };
    }

    @Get('tenants')
    async tenants(@Req() req: any) {
        this.assertSuperAdmin(req);

        const data = await this.prisma.tenant.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                _count: {
                    select: {
                        users: {
                            where: { deletedAt: null },
                        },
                        locations: {
                            where: { deletedAt: null },
                        },
                    },
                },
            },
        });

        return {
            data: data.map((tenant: any) => ({
                id: tenant.id,
                name: tenant.name,
                slug: tenant.slug,
                planTier: tenant.planTier,
                status: tenant.status,
                usageCredits: tenant.usageCredits,
                createdAt: tenant.createdAt,
                trialEndsAt: tenant.trialEndsAt,
                gracePeriodEndsAt: tenant.gracePeriodEndsAt,
                deletedAt: tenant.deletedAt,
                usersCount: tenant._count?.users ?? 0,
                locationsCount: tenant._count?.locations ?? 0,
            })),
        };
    }

    @Post('tenants')
    @HttpCode(HttpStatus.CREATED)
    async createTenant(
        @Req() req: any,
        @Body() body: {
            name: string;
            slug?: string;
            planTier?: string;
            status?: string;
            usageCredits?: number;
        },
    ) {
        this.assertSuperAdmin(req);
        const name = (body.name || '').trim();
        if (!name) throw new BadRequestException('Tenant name is required');
        const slug = this.toSlug((body.slug || name).trim());
        if (!slug) throw new BadRequestException('Tenant slug is required');
        const planTier = body.planTier?.trim() || PlanTier.FREE;
        const status = body.status?.trim() || TenantStatus.TRIAL;
        if (!this.isPlanTier(planTier)) throw new BadRequestException(`Invalid planTier: ${planTier}`);
        if (!this.isTenantStatus(status)) throw new BadRequestException(`Invalid status: ${status}`);
        const usageCredits = Number.isFinite(body.usageCredits as number) ? Number(body.usageCredits) : 0;
        if (!Number.isInteger(usageCredits)) throw new BadRequestException('usageCredits must be an integer');

        const tenant = await this.prisma.tenant.create({
            data: {
                name,
                slug,
                planTier,
                status,
                usageCredits,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                tenantId: tenant.id,
                userId: req.user.sub,
                action: 'TENANT_CREATED',
                resource: 'Tenant',
                resourceId: tenant.id,
            },
        });

        return { id: tenant.id };
    }

    @Put('tenants/:id')
    async updateTenant(
        @Req() req: any,
        @Param('id') id: string,
        @Body() body: {
            name?: string;
            slug?: string;
            planTier?: string;
            status?: string;
            usageCredits?: number;
            trialEndsAt?: string | null;
            gracePeriodEndsAt?: string | null;
        },
    ) {
        this.assertSuperAdmin(req);
        const patch: any = {};
        if (body.name !== undefined) {
            const name = body.name.trim();
            if (!name) throw new BadRequestException('name cannot be empty');
            patch.name = name;
        }
        if (body.slug !== undefined) {
            const slug = this.toSlug(body.slug.trim());
            if (!slug) throw new BadRequestException('slug cannot be empty');
            patch.slug = slug;
        }
        if (body.planTier !== undefined) {
            if (!this.isPlanTier(body.planTier)) throw new BadRequestException(`Invalid planTier: ${body.planTier}`);
            patch.planTier = body.planTier;
        }
        if (body.status !== undefined) {
            if (!this.isTenantStatus(body.status)) throw new BadRequestException(`Invalid status: ${body.status}`);
            patch.status = body.status;
        }
        if (body.usageCredits !== undefined) {
            if (!Number.isInteger(body.usageCredits)) throw new BadRequestException('usageCredits must be an integer');
            patch.usageCredits = body.usageCredits;
        }
        if (body.trialEndsAt !== undefined) patch.trialEndsAt = this.parseOptionalIsoDate(body.trialEndsAt);
        if (body.gracePeriodEndsAt !== undefined) patch.gracePeriodEndsAt = this.parseOptionalIsoDate(body.gracePeriodEndsAt);
        if (Object.keys(patch).length === 0) throw new BadRequestException('No valid fields to update');

        await this.prisma.tenant.update({
            where: { id },
            data: patch,
        });

        await this.prisma.auditLog.create({
            data: {
                tenantId: id,
                userId: req.user.sub,
                action: 'TENANT_UPDATED',
                resource: 'Tenant',
                resourceId: id,
            },
        });

        return { id, updated: true };
    }

    @Post('tenants/:id/suspend')
    async suspendTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.tenant.update({
                where: { id },
                data: { status: TenantStatus.SUSPENDED },
            });
            await tx.session.updateMany({
                where: { user: { tenantId: id }, revokedAt: null },
                data: { revokedAt: new Date() },
            });
        });
        await this.prisma.auditLog.create({
            data: { tenantId: id, userId: req.user.sub, action: 'TENANT_SUSPENDED', resource: 'Tenant', resourceId: id },
        });
        return { id, status: TenantStatus.SUSPENDED };
    }

    @Post('tenants/:id/activate')
    async activateTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        await this.prisma.tenant.update({
            where: { id },
            data: { status: TenantStatus.ACTIVE, deletedAt: null },
        });
        await this.prisma.auditLog.create({
            data: { tenantId: id, userId: req.user.sub, action: 'TENANT_ACTIVATED', resource: 'Tenant', resourceId: id },
        });
        return { id, status: TenantStatus.ACTIVE };
    }

    @Post('tenants/:id/archive')
    async archiveTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.tenant.update({
                where: { id },
                data: { deletedAt: new Date(), status: TenantStatus.CANCELLED },
            });
            await tx.session.updateMany({
                where: { user: { tenantId: id }, revokedAt: null },
                data: { revokedAt: new Date() },
            });
        });
        await this.prisma.auditLog.create({
            data: { tenantId: id, userId: req.user.sub, action: 'TENANT_ARCHIVED', resource: 'Tenant', resourceId: id },
        });
        return { id, archived: true };
    }

    @Post('tenants/:id/restore')
    async restoreTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        await this.prisma.tenant.update({
            where: { id },
            data: { deletedAt: null, status: TenantStatus.ACTIVE },
        });
        await this.prisma.auditLog.create({
            data: { tenantId: id, userId: req.user.sub, action: 'TENANT_RESTORED', resource: 'Tenant', resourceId: id },
        });
        return { id, restored: true };
    }

    @Delete('tenants/:id')
    async deleteTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);

        if (req?.user?.tenantId === id) {
            throw new BadRequestException('You cannot permanently delete your own tenant.');
        }

        const tenant = await this.prisma.tenant.findUnique({
            where: { id },
            select: { id: true, deletedAt: true },
        });

        if (!tenant) {
            throw new BadRequestException('Tenant not found');
        }

        if (!tenant.deletedAt) {
            throw new BadRequestException('Archive tenant before permanent deletion.');
        }

        await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.session.deleteMany({
                where: { user: { tenantId: id } },
            });
            await tx.notification.deleteMany({
                where: { tenantId: id },
            });
            await tx.break.deleteMany({
                where: { shift: { tenantId: id } },
            });
            await tx.shift.deleteMany({
                where: { tenantId: id },
            });
            await tx.schedule.deleteMany({
                where: { tenantId: id },
            });
            await tx.location.deleteMany({
                where: { tenantId: id },
            });
            await tx.tenantSetting.deleteMany({
                where: { tenantId: id },
            });
            await tx.billingEvent.deleteMany({
                where: { tenantId: id },
            });
            await tx.webhookEndpoint.deleteMany({
                where: { tenantId: id },
            });
            await tx.creditTransaction.deleteMany({
                where: { tenantId: id },
            });
            await tx.auditLog.deleteMany({
                where: {
                    OR: [
                        { tenantId: id },
                        { user: { is: { tenantId: id } } },
                    ],
                },
            });
            await tx.user.deleteMany({
                where: { tenantId: id },
            });
            await tx.tenant.delete({
                where: { id },
            });
            await tx.auditLog.create({
                data: {
                    tenantId: id,
                    userId: req.user.sub,
                    action: 'TENANT_DELETED',
                    resource: 'Tenant',
                    resourceId: id,
                },
            });
        });

        return { id, deleted: true };
    }

    @Get('users')
    async users(@Req() req: any, @Query('q') q?: string) {
        this.assertSuperAdmin(req);

        const search = q?.trim();
        const where: any = {};
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { username: { contains: search, mode: 'insensitive' } },
                { tenant: { is: { name: { contains: search, mode: 'insensitive' } } } },
                { tenant: { is: { slug: { contains: search, mode: 'insensitive' } } } },
            ];
        }

        const data = await this.prisma.user.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                    },
                },
            },
            take: 200,
        });

        return {
            data: data.map((user: any) => ({
                id: user.id,
                name: user.name,
                email: user.email,
                username: user.username,
                role: user.role,
                createdAt: user.createdAt,
                lastLoginAt: user.lastLoginAt,
                lockedUntil: user.lockedUntil,
                pinLockedUntil: user.pinLockedUntil,
                deletedAt: user.deletedAt,
                status: this.mapUserStatus(user),
                tenant: user.tenant,
            })),
        };
    }

    @Put('users/:id')
    async updateUser(
        @Req() req: any,
        @Param('id') id: string,
        @Body() body: {
            name?: string;
            email?: string | null;
            username?: string | null;
            role?: string;
            tenantId?: string;
            pinResetRequired?: boolean;
        },
    ) {
        this.assertSuperAdmin(req);
        const patch: any = {};
        if (body.name !== undefined) {
            const name = body.name.trim();
            if (!name) throw new BadRequestException('name cannot be empty');
            patch.name = name;
        }
        if (body.email !== undefined) {
            const email = (body.email ?? '').trim().toLowerCase();
            if (!email) patch.email = null;
            else {
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Invalid email');
                patch.email = email;
            }
        }
        if (body.username !== undefined) {
            const username = (body.username ?? '').trim().toLowerCase();
            if (!username) {
                patch.username = null;
            } else {
                if (!AdminController.USERNAME_REGEX.test(username)) {
                    throw new BadRequestException('Invalid username format');
                }
                patch.username = username;
            }
        }
        if (body.role !== undefined) {
            if (!this.isUserRole(body.role)) throw new BadRequestException(`Invalid role: ${body.role}`);
            patch.role = body.role;
        }
        if (body.tenantId !== undefined) {
            patch.tenantId = body.tenantId;
        }
        if (body.pinResetRequired !== undefined) {
            patch.pinResetRequired = Boolean(body.pinResetRequired);
        }
        if (Object.keys(patch).length === 0) throw new BadRequestException('No valid fields to update');

        const updated = await this.prisma.user.update({
            where: { id },
            data: patch,
            include: { tenant: { select: { id: true, name: true, slug: true } } },
        });

        await this.prisma.auditLog.create({
            data: {
                tenantId: updated.tenantId,
                userId: req.user.sub,
                action: 'USER_UPDATED',
                resource: 'User',
                resourceId: id,
            },
        });

        return {
            id: updated.id,
            name: updated.name,
            email: updated.email,
            username: updated.username,
            role: updated.role,
            status: this.mapUserStatus(updated),
            tenant: updated.tenant,
        };
    }

    @Post('users/:id/lock')
    async lockUser(@Req() req: any, @Param('id') id: string, @Body() body: { minutes?: number }) {
        this.assertSuperAdmin(req);
        const minutes = Number.isFinite(body?.minutes as number) ? Math.max(1, Math.min(60 * 24 * 30, Number(body.minutes))) : 60;
        const lockedUntil = new Date(Date.now() + minutes * 60 * 1000);
        const user = await this.prisma.user.update({
            where: { id },
            data: { lockedUntil, pinLockedUntil: lockedUntil },
        });
        await this.prisma.session.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        await this.prisma.auditLog.create({
            data: { tenantId: user.tenantId, userId: req.user.sub, action: 'USER_LOCKED', resource: 'User', resourceId: id },
        });
        return { id, lockedUntil };
    }

    @Post('users/:id/unlock')
    async unlockUser(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        const user = await this.prisma.user.update({
            where: { id },
            data: { lockedUntil: null, pinLockedUntil: null, loginAttempts: 0, pinLoginAttempts: 0 },
        });
        await this.prisma.auditLog.create({
            data: { tenantId: user.tenantId, userId: req.user.sub, action: 'USER_UNLOCKED', resource: 'User', resourceId: id },
        });
        return { id, unlocked: true };
    }

    @Post('users/:id/suspend')
    async suspendUser(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        const now = new Date();
        const user = await this.prisma.user.update({
            where: { id },
            data: { deletedAt: now, lockedUntil: now, pinLockedUntil: now },
        });
        await this.prisma.session.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: now },
        });
        await this.prisma.auditLog.create({
            data: { tenantId: user.tenantId, userId: req.user.sub, action: 'USER_SUSPENDED', resource: 'User', resourceId: id },
        });
        return { id, suspended: true };
    }

    @Post('users/:id/activate')
    async activateUser(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        const user = await this.prisma.user.update({
            where: { id },
            data: { deletedAt: null, lockedUntil: null, pinLockedUntil: null, loginAttempts: 0, pinLoginAttempts: 0 },
        });
        await this.prisma.auditLog.create({
            data: { tenantId: user.tenantId, userId: req.user.sub, action: 'USER_ACTIVATED', resource: 'User', resourceId: id },
        });
        return { id, activated: true };
    }

    @Get('audit')
    async audit(@Req() req: any, @Query('limit') limitRaw?: string) {
        this.assertSuperAdmin(req);

        const limit = Math.min(Math.max(Number(limitRaw) || 25, 1), 100);
        const rows = await this.prisma.auditLog.findMany({
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        role: true,
                    },
                },
            },
        });

        return {
            data: rows.map((row: any) => ({
                id: row.id,
                tenantId: row.tenantId,
                action: row.action,
                resource: row.resource,
                resourceId: row.resourceId,
                createdAt: row.createdAt,
                user: row.user
                    ? {
                        id: row.user.id,
                        name: row.user.name,
                        email: row.user.email,
                        role: row.user.role,
                    }
                    : null,
            })),
        };
    }

    @Get('credits')
    async credits(@Req() req: any, @Query('limit') limitRaw?: string) {
        this.assertSuperAdmin(req);

        const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 200);
        const [tenants, transactions] = await Promise.all([
            this.prisma.tenant.findMany({
                where: { deletedAt: null },
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    planTier: true,
                    usageCredits: true,
                },
            }),
            this.prisma.creditTransaction.findMany({
                orderBy: { createdAt: 'desc' },
                take: limit,
                include: {
                    tenant: {
                        select: {
                            id: true,
                            name: true,
                            slug: true,
                        },
                    },
                },
            }),
        ]);

        return {
            tenants: tenants.map((tenant: any) => ({
                id: tenant.id,
                name: tenant.name,
                slug: tenant.slug,
                planTier: tenant.planTier,
                usageCredits: tenant.usageCredits,
            })),
            history: transactions.map((tx: any) => ({
                id: tx.id,
                amount: tx.amount,
                reason: tx.reason,
                createdAt: tx.createdAt,
                tenant: tx.tenant
                    ? {
                        id: tx.tenant.id,
                        name: tx.tenant.name,
                        slug: tx.tenant.slug,
                    }
                    : null,
            })),
        };
    }

    @Get('plans')
    async plans(@Req() req: any) {
        this.assertSuperAdmin(req);

        const rows = await listPlanDefinitions(this.prisma);

        return {
            data: rows.map((plan: any) => planDefinitionToResponse(plan)),
        };
    }

    @Post('plans')
    @HttpCode(HttpStatus.CREATED)
    async createPlan(
        @Req() req: any,
        @Body() body: {
            code?: string;
            key?: string;
            name?: string;
            monthlyPriceCents?: number | null;
            priceMonthly?: number | null;
            locationLimit?: number | null;
            storeLimit?: number | null;
            maxLocations?: number | null;
            userLimit?: number | null;
            maxUsers?: number | null;
            creditQuotaLimit?: number | null;
            creditsLimit?: number | null;
            active?: boolean;
            status?: 'ACTIVE' | 'INACTIVE' | string;
            metadata?: Prisma.InputJsonValue | null;
        },
    ) {
        this.assertSuperAdmin(req);

        const code = normalizePlanCode((body.code ?? body.key ?? '').trim());
        if (!code) throw new BadRequestException('code is required');
        if (!isTenantPlanCode(code) && !/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(code)) {
            throw new BadRequestException('code must contain only uppercase letters, numbers, underscores, or hyphens.');
        }

        const existing = await this.prisma.planDefinition.findUnique({ where: { code } });
        if (existing) {
            throw new ConflictException(`Plan ${code} already exists.`);
        }

        const name = (body.name ?? '').trim();
        if (!name) throw new BadRequestException('name is required');

        const monthlyPriceCents = this.parseMonthlyPriceCents(body.monthlyPriceCents, body.priceMonthly);
        const locationLimit = this.parseRequiredInteger(body.locationLimit ?? body.storeLimit ?? body.maxLocations, 'locationLimit');
        const userLimit = this.parseRequiredInteger(body.userLimit ?? body.maxUsers, 'userLimit');
        const creditQuotaLimit = this.parseOptionalIntegerOrNull(body.creditQuotaLimit ?? body.creditsLimit, 'creditQuotaLimit');
        const active = this.parsePlanActive(body.active, body.status) ?? true;
        const metadata = body.metadata === undefined
            ? { features: this.defaultPlanFeaturesFor(code) }
            : body.metadata === null
                ? Prisma.DbNull
                : body.metadata;

        const plan = await this.prisma.planDefinition.create({
            data: {
                code,
                name,
                monthlyPriceCents,
                locationLimit,
                userLimit,
                creditQuotaLimit,
                active,
                metadata,
            },
        });

        await this.prisma.auditLog.create({
            data: {
                tenantId: req.user.tenantId,
                userId: req.user.sub,
                action: 'PLAN_CREATED',
                resource: 'PlanDefinition',
                resourceId: plan.code,
                newValue: planDefinitionToResponse(plan) as any,
            },
        });

        return planDefinitionToResponse(plan);
    }

    @Put('plans/:codeOrId')
    async updatePlan(
        @Req() req: any,
        @Param('codeOrId') codeOrId: string,
        @Body() body: {
            code?: string;
            key?: string;
            name?: string;
            monthlyPriceCents?: number | null;
            priceMonthly?: number | null;
            locationLimit?: number | null;
            storeLimit?: number | null;
            maxLocations?: number | null;
            userLimit?: number | null;
            maxUsers?: number | null;
            creditQuotaLimit?: number | null;
            creditsLimit?: number | null;
            active?: boolean;
            status?: 'ACTIVE' | 'INACTIVE' | string;
            metadata?: Prisma.InputJsonValue | null;
        },
    ) {
        this.assertSuperAdmin(req);

        const existing = await this.findPlanByCodeOrId(codeOrId);
        const code = existing?.code ?? normalizePlanCode(codeOrId);
        const requestedCode = body.code ?? body.key;
        if (requestedCode !== undefined && normalizePlanCode(requestedCode) !== code) {
            throw new BadRequestException('Plan code is immutable. Update the record using the path parameter.');
        }

        const fallbackPlan = existing ?? resolveFallbackPlanDefinition(code);
        if (!fallbackPlan) {
            throw new NotFoundException(`Plan ${code} not found.`);
        }

        const patch: any = {};
        if (body.name !== undefined) {
            const name = body.name.trim();
            if (!name) throw new BadRequestException('name cannot be empty');
            patch.name = name;
        }
        if (body.monthlyPriceCents !== undefined || body.priceMonthly !== undefined) {
            patch.monthlyPriceCents = this.parseMonthlyPriceCents(body.monthlyPriceCents, body.priceMonthly);
        }
        if (body.locationLimit !== undefined || body.storeLimit !== undefined || body.maxLocations !== undefined) {
            patch.locationLimit = this.parseRequiredInteger(body.locationLimit ?? body.storeLimit ?? body.maxLocations, 'locationLimit');
        }
        if (body.userLimit !== undefined || body.maxUsers !== undefined) {
            patch.userLimit = this.parseRequiredInteger(body.userLimit ?? body.maxUsers, 'userLimit');
        }
        if (body.creditQuotaLimit !== undefined || body.creditsLimit !== undefined) {
            patch.creditQuotaLimit = this.parseOptionalIntegerOrNull(body.creditQuotaLimit ?? body.creditsLimit, 'creditQuotaLimit');
        }
        const activePatch = this.parsePlanActive(body.active, body.status);
        if (activePatch !== undefined) {
            patch.active = activePatch;
        }
        if (body.metadata !== undefined) {
            patch.metadata = body.metadata === null ? Prisma.DbNull : body.metadata;
        }

        if (Object.keys(patch).length === 0) {
            throw new BadRequestException('No valid fields to update');
        }

        const plan = existing
            ? await this.prisma.planDefinition.update({
                where: { code },
                data: patch,
            })
            : await this.prisma.planDefinition.create({
                data: {
                    code,
                    name: body.name?.trim() || fallbackPlan.name,
                    monthlyPriceCents: body.monthlyPriceCents !== undefined || body.priceMonthly !== undefined
                        ? this.parseMonthlyPriceCents(body.monthlyPriceCents, body.priceMonthly)
                        : fallbackPlan.monthlyPriceCents,
                    locationLimit: body.locationLimit !== undefined || body.storeLimit !== undefined || body.maxLocations !== undefined
                        ? this.parseRequiredInteger(body.locationLimit ?? body.storeLimit ?? body.maxLocations, 'locationLimit')
                        : fallbackPlan.locationLimit,
                    userLimit: body.userLimit !== undefined || body.maxUsers !== undefined
                        ? this.parseRequiredInteger(body.userLimit ?? body.maxUsers, 'userLimit')
                        : fallbackPlan.userLimit,
                    creditQuotaLimit: body.creditQuotaLimit !== undefined || body.creditsLimit !== undefined
                        ? this.parseOptionalIntegerOrNull(body.creditQuotaLimit ?? body.creditsLimit, 'creditQuotaLimit')
                        : fallbackPlan.creditQuotaLimit,
                    active: this.parsePlanActive(body.active, body.status) ?? fallbackPlan.active,
                    metadata: body.metadata !== undefined
                        ? (body.metadata === null ? Prisma.DbNull : body.metadata)
                        : fallbackPlan.metadata ?? { features: this.defaultPlanFeaturesFor(code) },
                },
            });

        await this.prisma.auditLog.create({
            data: {
                tenantId: req.user.tenantId,
                userId: req.user.sub,
                action: 'PLAN_UPDATED',
                resource: 'PlanDefinition',
                resourceId: plan.code,
                newValue: planDefinitionToResponse(plan) as any,
            },
        });

        return planDefinitionToResponse(plan);
    }

    @Delete('plans/:codeOrId')
    async deletePlan(@Req() req: any, @Param('codeOrId') codeOrId: string) {
        this.assertSuperAdmin(req);

        const plan = await this.findPlanByCodeOrId(codeOrId);
        if (!plan) {
            throw new NotFoundException(`Plan ${normalizePlanCode(codeOrId)} not found.`);
        }

        await this.prisma.planDefinition.delete({ where: { code: plan.code } });
        await this.prisma.auditLog.create({
            data: {
                tenantId: req.user.tenantId,
                userId: req.user.sub,
                action: 'PLAN_DELETED',
                resource: 'PlanDefinition',
                resourceId: plan.code,
                oldValue: planDefinitionToResponse(plan) as any,
            },
        });

        return { code: plan.code, deleted: true };
    }

    @Get('health')
    async health(@Req() req: any) {
        this.assertSuperAdmin(req);

        const checkedAt = new Date().toISOString();
        const components: Array<{
            label: string;
            status: 'online' | 'degraded' | 'offline' | 'unknown';
            latencyMs: number | null;
            details?: string;
        }> = [{ label: 'API', status: 'online', latencyMs: 0, details: 'request handling active' }];

        const dbCheck = await this.timeCheck(async () => {
            await this.prisma.$queryRaw`SELECT 1`;
        });
        components.push({
            label: 'Database',
            status: dbCheck.ok ? 'online' : 'offline',
            latencyMs: dbCheck.latencyMs,
            details: dbCheck.ok ? 'query succeeded' : this.stringifyError(dbCheck.error),
        });

        const redisUrl = this.configService.get<string>('REDIS_URL') ?? process.env.REDIS_URL;
        if (!redisUrl) {
            components.push({
                label: 'Redis',
                status: 'unknown',
                latencyMs: null,
                details: 'REDIS_URL is not configured',
            });
        } else {
            const redisCheck = await this.timeCheck(async () => {
                const redis = new Redis(redisUrl, {
                    lazyConnect: true,
                    maxRetriesPerRequest: 1,
                    connectTimeout: 1500,
                });
                try {
                    await redis.connect();
                    const pong = await redis.ping();
                    if (pong !== 'PONG') {
                        throw new Error(`Unexpected ping response: ${pong}`);
                    }
                } finally {
                    redis.disconnect();
                }
            });

            components.push({
                label: 'Redis',
                status: redisCheck.ok ? 'online' : 'offline',
                latencyMs: redisCheck.latencyMs,
                details: redisCheck.ok ? 'ping succeeded' : this.stringifyError(redisCheck.error),
            });
        }

        let queueDepth: number | null = null;
        try {
            const metric: any = await this.metricsService.solverQueueDepth.get();
            const raw = Array.isArray(metric?.values) ? metric.values[0]?.value : undefined;
            queueDepth = typeof raw === 'number' ? raw : null;
        } catch {
            queueDepth = null;
        }

        components.push({
            label: 'Solver Queue',
            status: queueDepth === null ? 'unknown' : queueDepth > 50 ? 'degraded' : 'online',
            latencyMs: null,
            details: queueDepth === null ? 'no queue telemetry available yet' : `${queueDepth} pending jobs`,
        });

        const hasOffline = components.some((component) => component.status === 'offline');
        const hasDegraded = components.some((component) => component.status === 'degraded');
        const hasUnknown = components.some((component) => component.status === 'unknown');
        const overall = hasOffline ? 'offline' : hasDegraded || hasUnknown ? 'degraded' : 'online';

        return { checkedAt, overall, components };
    }

    private async timeCheck(task: () => Promise<void>) {
        const start = Date.now();
        try {
            await task();
            return { ok: true as const, latencyMs: Date.now() - start, error: null as string | null };
        } catch (error) {
            return { ok: false as const, latencyMs: Date.now() - start, error: this.stringifyError(error) };
        }
    }

    private parseRequiredInteger(value: unknown, field: string): number {
        const parsed = this.parseOptionalInteger(value, field);
        if (parsed === null) {
            throw new BadRequestException(`${field} is required`);
        }
        return parsed;
    }

    private parseOptionalInteger(value: unknown, field: string): number | null {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
            throw new BadRequestException(`${field} must be a non-negative integer`);
        }
        return parsed;
    }

    private parseOptionalIntegerOrNull(value: unknown, field: string): number | null {
        if (value === undefined) {
            return null;
        }
        return this.parseOptionalInteger(value, field);
    }

    private parseMonthlyPriceCents(monthlyPriceCents: unknown, priceMonthly: unknown): number | null {
        if (monthlyPriceCents !== undefined) {
            return this.parseOptionalInteger(monthlyPriceCents, 'monthlyPriceCents');
        }

        if (priceMonthly === undefined || priceMonthly === null || priceMonthly === '') {
            return null;
        }

        const parsed = Number(priceMonthly);
        if (!Number.isFinite(parsed) || parsed < 0) {
            throw new BadRequestException('priceMonthly must be a non-negative number');
        }
        return Math.round(parsed * 100);
    }

    private parsePlanActive(active: unknown, status: unknown): boolean | undefined {
        if (active !== undefined) {
            if (typeof active === 'boolean') {
                return active;
            }
            if (typeof active === 'string') {
                const normalizedActive = active.trim().toLowerCase();
                if (normalizedActive === 'true') return true;
                if (normalizedActive === 'false') return false;
            }
            throw new BadRequestException('active must be true or false');
        }

        if (status === undefined || status === null) {
            return undefined;
        }

        const normalized = String(status).trim().toUpperCase();
        if (normalized === 'ACTIVE') {
            return true;
        }
        if (normalized === 'INACTIVE') {
            return false;
        }
        throw new BadRequestException('status must be ACTIVE or INACTIVE');
    }

    private async findPlanByCodeOrId(codeOrId: string) {
        const byCode = await this.prisma.planDefinition.findUnique({
            where: { code: normalizePlanCode(codeOrId) },
        });
        if (byCode) {
            return byCode;
        }
        return this.prisma.planDefinition.findUnique({
            where: { id: codeOrId },
        });
    }

    private defaultPlanFeaturesFor(code: string) {
        switch (normalizePlanCode(code)) {
            case 'FREE':
                return [];
            case 'STARTER':
                return ['scheduling'];
            case 'GROWTH':
            case 'ENTERPRISE':
                return ['scheduling', 'lunch_breaks'];
            default:
                return [];
        }
    }

    private stringifyError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return 'Unknown error';
    }
}
