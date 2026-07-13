import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, HttpStatus, NotFoundException, Optional, Param, Post, Put, Query, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlanTier, Prisma, PrismaClient, TenantStatus, UserRole } from '@prisma/client';
import Redis from 'ioredis';
import { MetricsService } from '../common/metrics.service';
import { MeteringService } from '../billing/metering.service';
import { isTenantPlanCode, listPlanDefinitions, normalizePlanCode, planDefinitionToResponse, resolveFallbackPlanDefinition } from '../billing/plan-definitions';
import { assertPlanUserLimitChangeAllowsExistingTenants, assertTenantCanAddActiveUser } from '../billing/user-capacity';
import { StripeService } from '../billing/stripe.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { TenantAccountLifecycleService, type TenantLifecycleActor, type TenantRetentionStage } from './tenant-account-lifecycle.service';
import { RbacService } from '../auth/rbac.service';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantExportService } from './tenant-export.service';
import { AdminUserMfaRecoveryService } from './admin-user-mfa-recovery.service';
import {
    TENANT_RETENTION_POLICY,
    buildExpiredTenantApplicationDataWhere,
    buildExpiredTenantRetentionWhere,
    buildTenantRetentionSchedule,
    isTenantReadyForRetentionPurge,
    serializeTenantRetentionCandidate,
} from './tenant-account-lifecycle';

@Controller({ path: 'admin', version: '1' })
@RequirePermission('admin_portal:access')
@UseGuards(JwtAuthGuard)
export class AdminController {
    private static readonly DEFAULT_TENANT_TRIAL_DAYS = 14;
    private static readonly MAX_TENANT_TRIAL_DAYS = 90;
    private static readonly MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
    private prisma = new PrismaClient();
    private readonly tenantDb: TenantPrismaService;
    private readonly tenantAccountLifecycle: TenantAccountLifecycleService;
    private readonly tenantProvisioning: TenantProvisioningService;
    private readonly tenantExport: TenantExportService;
    private readonly userMfaRecovery: AdminUserMfaRecoveryService;
    private static readonly USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;
    private static readonly OWNER_EMAIL_REGEX = /^[a-z0-9.!#$%*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
    private static readonly RETAINED_RECORD_PURGE_CONFIRM = 'purge-expired-retained-records';
    private static readonly APPLICATION_DATA_PURGE_CONFIRM = 'purge-expired-application-data';

    constructor(
        private readonly configService: ConfigService,
        private readonly metricsService: MetricsService,
        private readonly meteringService: MeteringService,
        @Optional() tenantDb?: TenantPrismaService,
        @Optional() private readonly stripeBilling?: StripeService,
        @Optional() rbacService?: RbacService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService(this.prisma);
        this.prisma = this.tenantDb.client;
        this.userMfaRecovery = new AdminUserMfaRecoveryService(this.tenantDb);
        this.tenantAccountLifecycle = new TenantAccountLifecycleService(this.tenantDb, this.stripeBilling);
        this.tenantProvisioning = new TenantProvisioningService(
            this.tenantDb,
            rbacService ?? new RbacService(this.tenantDb),
        );
        this.tenantExport = new TenantExportService(this.tenantDb, this.metricsService);
    }

    private assertSuperAdmin(req: any) {
        if (!Array.isArray(req?.user?.permissions) || !req.user.permissions.includes('admin_portal:access')) {
            throw new ForbiddenException('admin_portal:access permission required.');
        }
    }

    private normalizeCreditGrantIdempotencyKey(value: unknown): string {
        if (typeof value !== 'string' || !value.trim()) {
            throw new BadRequestException('Idempotency-Key header is required for credit grants.');
        }
        const key = value.trim();
        if (key.length > 255 || /[\u0000-\u001f\u007f]/.test(key)) {
            throw new BadRequestException('Idempotency-Key must be 255 printable characters or fewer.');
        }
        return key;
    }

    private tenantLifecycleActor(req: any, permission = 'settings:write'): TenantLifecycleActor {
        const tenantId = req?.user?.tenantId;
        if (typeof tenantId !== 'string' || !tenantId.trim()) {
            throw new BadRequestException('tenantId is required for tenant account lifecycle operations.');
        }
        if (!Array.isArray(req?.user?.permissions) || !req.user.permissions.includes(permission)) {
            throw new ForbiddenException(`${permission} permission required.`);
        }
        return {
            tenantId,
            userId: req?.user?.sub,
            ipAddress: req?.ip ?? req?.headers?.['x-forwarded-for'] ?? null,
            userAgent: req?.headers?.['user-agent'] ?? null,
        };
    }

    private withPlatformAdmin<T>(
        operation: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
    ): Promise<T> {
        return this.tenantDb.withPlatformAdmin(operation, options);
    }

    private auditUserIdForTenant(req: any, tenantId: string): string | null {
        return req?.user?.tenantId === tenantId ? req.user.sub : null;
    }

    private platformAuditAttribution(req: any): {
        actorUserId: string | null;
        actorTenantId: string | null;
        ipAddress: string | null;
        userAgent: string | null;
    } {
        const forwardedFor = req?.headers?.['x-forwarded-for'];
        const forwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
        const userAgentHeader = req?.headers?.['user-agent'];
        const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;
        return {
            actorUserId: typeof req?.user?.sub === 'string' ? req.user.sub : null,
            actorTenantId: typeof req?.user?.tenantId === 'string' ? req.user.tenantId : null,
            ipAddress: typeof req?.ip === 'string'
                ? req.ip
                : typeof forwardedIp === 'string'
                    ? forwardedIp.split(',')[0].trim() || null
                    : typeof req?.socket?.remoteAddress === 'string'
                        ? req.socket.remoteAddress
                        : null,
            userAgent: typeof userAgent === 'string' ? userAgent : null,
        };
    }

    private platformAuditData(req: any, targetTenantId: string) {
        return {
            userId: this.auditUserIdForTenant(req, targetTenantId),
            ...this.platformAuditAttribution(req),
        };
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

    private tenantTrialDays(): number {
        const configured = this.configService.get<string>('ADMIN_TENANT_TRIAL_DAYS');
        if (configured === undefined || configured === null || configured.trim() === '') {
            return AdminController.DEFAULT_TENANT_TRIAL_DAYS;
        }

        const parsed = Number(configured);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > AdminController.MAX_TENANT_TRIAL_DAYS) {
            throw new ServiceUnavailableException(
                `ADMIN_TENANT_TRIAL_DAYS must be an integer from 1 to ${AdminController.MAX_TENANT_TRIAL_DAYS}.`,
            );
        }
        return parsed;
    }

    private resolveProvisioningTrialEnd(status: TenantStatus, raw: string | null | undefined): Date | null {
        const requested = this.parseOptionalIsoDate(raw);
        if (status !== TenantStatus.TRIAL) {
            if (requested !== undefined && requested !== null) {
                throw new BadRequestException('trialEndsAt is only valid when status is TRIAL.');
            }
            return null;
        }
        if (requested === null) {
            throw new BadRequestException('TRIAL tenants require a concrete future trialEndsAt.');
        }

        const now = new Date();
        const latestAllowed = new Date(
            now.getTime() + this.tenantTrialDays() * AdminController.MILLISECONDS_PER_DAY,
        );
        const trialEndsAt = requested ?? latestAllowed;
        if (trialEndsAt.getTime() <= now.getTime()) {
            throw new BadRequestException('trialEndsAt must be in the future.');
        }
        if (trialEndsAt.getTime() > latestAllowed.getTime()) {
            throw new BadRequestException(
                `trialEndsAt cannot exceed the configured ${this.tenantTrialDays()}-day trial window.`,
            );
        }
        return trialEndsAt;
    }

    private parseRetentionAsOf(raw: unknown): Date {
        if (raw === undefined || raw === null || raw === '') return new Date();
        if (typeof raw !== 'string') {
            throw new BadRequestException('asOf must be an ISO date string.');
        }

        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
            throw new BadRequestException(`Invalid asOf date: ${raw}`);
        }
        return parsed;
    }

    private parseRetentionDryRun(raw: unknown): boolean {
        if (raw === undefined) return true;
        if (typeof raw !== 'boolean') {
            throw new BadRequestException('dryRun must be a boolean.');
        }
        return raw;
    }

    private parseRetentionStage(raw: unknown): 'application_data' | 'retained_records' {
        if (raw === undefined || raw === null || raw === '') return 'retained_records';
        if (raw !== 'application_data' && raw !== 'retained_records') {
            throw new BadRequestException('stage must equal application_data or retained_records.');
        }
        return raw;
    }

    private assertRetentionExecuteConfirmed(
        dryRun: boolean,
        stage: 'application_data' | 'retained_records',
        rawConfirmation: unknown,
    ) {
        if (dryRun) return;
        const expected = stage === 'application_data'
            ? AdminController.APPLICATION_DATA_PURGE_CONFIRM
            : AdminController.RETAINED_RECORD_PURGE_CONFIRM;
        if (rawConfirmation !== expected) {
            throw new BadRequestException(
                `executeConfirmation must equal ${expected} when dryRun is false.`,
            );
        }
    }

    private parseRetentionLimit(raw: unknown): number {
        if (raw === undefined || raw === null || raw === '') return 25;
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
            throw new BadRequestException('limit must be an integer from 1 to 25.');
        }
        return limit;
    }

    private parseRetentionContinuation(raw: unknown): { deletedAt: Date; id: string } | null {
        if (raw === undefined || raw === null) return null;
        if (typeof raw !== 'object' || Array.isArray(raw)) {
            throw new BadRequestException('continuation must contain deletedAt and id.');
        }
        const deletedAtRaw = (raw as Record<string, unknown>).deletedAt;
        const idRaw = (raw as Record<string, unknown>).id;
        const deletedAt = typeof deletedAtRaw === 'string' ? new Date(deletedAtRaw) : null;
        if (!deletedAt || Number.isNaN(deletedAt.getTime()) || typeof idRaw !== 'string' || !idRaw.trim()) {
            throw new BadRequestException('continuation must contain a valid deletedAt and id.');
        }
        return { deletedAt, id: idRaw.trim() };
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
        const [totalTenants, totalUsers, activeSessions] = await this.withPlatformAdmin((tx) => Promise.all([
            tx.tenant.count({ where: { deletedAt: null } }),
            tx.user.count({ where: { deletedAt: null } }),
            tx.session.count({
                where: {
                    revokedAt: null,
                    expiresAt: { gt: now },
                },
            }),
        ]));

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

        const data = await this.withPlatformAdmin((tx) => tx.tenant.findMany({
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
        }));

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
            ownerName?: string;
            ownerEmail?: string;
            trialEndsAt?: string | null;
        },
    ) {
        this.assertSuperAdmin(req);
        const name = (body.name || '').trim();
        if (!name) throw new BadRequestException('Tenant name is required');
        const slug = this.toSlug((body.slug || name).trim());
        if (!slug) throw new BadRequestException('Tenant slug is required');
        const planTier = body.planTier?.trim() || PlanTier.FREE;
        const status = body.status?.trim() || (planTier === PlanTier.FREE ? TenantStatus.ACTIVE : TenantStatus.TRIAL);
        if (!this.isPlanTier(planTier)) throw new BadRequestException(`Invalid planTier: ${planTier}`);
        if (!this.isTenantStatus(status)) throw new BadRequestException(`Invalid status: ${status}`);
        if (planTier !== PlanTier.FREE && status === TenantStatus.ACTIVE) {
            throw new BadRequestException(
                'Paid tenants cannot be created ACTIVE without verified Stripe or manual entitlement proof. Create a bounded TRIAL instead.',
            );
        }
        const trialEndsAt = this.resolveProvisioningTrialEnd(status, body.trialEndsAt);
        const usageCredits = Number.isFinite(body.usageCredits as number) ? Number(body.usageCredits) : 0;
        if (!Number.isInteger(usageCredits)) throw new BadRequestException('usageCredits must be an integer');
        const ownerName = (body.ownerName ?? '').trim();
        if (!ownerName) throw new BadRequestException('Owner name is required');
        if (ownerName.length > 120) throw new BadRequestException('Owner name must be 120 characters or less');
        const ownerEmail = (body.ownerEmail ?? '').trim().toLowerCase();
        if (!AdminController.OWNER_EMAIL_REGEX.test(ownerEmail)) {
            throw new BadRequestException('Valid owner email is required');
        }

        return this.tenantProvisioning.createPlatformTenant({
            name,
            slug,
            planTier,
            status,
            trialEndsAt,
            usageCredits,
            ownerName,
            ownerEmail,
            auditActor: this.platformAuditAttribution(req),
        });
    }

    @Put('tenants/:id')
    async updateTenant(
        @Req() req: any,
        @Param('id') id: string,
        @Body() body: {
            name?: string;
            slug?: string;
            usageCredits?: number;
            trialEndsAt?: string | null;
            gracePeriodEndsAt?: string | null;
        },
    ) {
        this.assertSuperAdmin(req);
        const protectedFields = ['planTier', 'status'].filter((field) =>
            Object.prototype.hasOwnProperty.call(body, field),
        );
        if (protectedFields.length > 0) {
            throw new BadRequestException(
                `${protectedFields.join(' and ')} cannot be updated through generic tenant edit. Use Stripe-coordinated billing or dedicated lifecycle actions.`,
            );
        }
        const existingTenant = await this.withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id },
            select: {
                id: true,
                deletedAt: true,
            },
        }));
        if (!existingTenant) {
            throw new BadRequestException('Tenant not found');
        }

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
        if (body.usageCredits !== undefined) {
            if (!Number.isInteger(body.usageCredits)) throw new BadRequestException('usageCredits must be an integer');
            patch.usageCredits = body.usageCredits;
        }
        if (body.trialEndsAt !== undefined) patch.trialEndsAt = this.parseOptionalIsoDate(body.trialEndsAt);
        if (body.gracePeriodEndsAt !== undefined) patch.gracePeriodEndsAt = this.parseOptionalIsoDate(body.gracePeriodEndsAt);
        if (Object.keys(patch).length === 0) throw new BadRequestException('No valid fields to update');

        await this.withPlatformAdmin(async (tx) => {
            await tx.tenant.update({
                where: { id },
                data: patch,
            });

            await tx.auditLog.create({
                data: {
                    tenantId: id,
                    ...this.platformAuditData(req, id),
                    action: 'TENANT_UPDATED',
                    resource: 'Tenant',
                    resourceId: id,
                },
            });
        });

        return { id, updated: true };
    }

    @Post('tenants/:id/suspend')
    async suspendTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        await this.withPlatformAdmin(async (tx) => {
            await tx.tenant.update({
                where: { id },
                data: { status: TenantStatus.SUSPENDED },
            });
            await tx.session.updateMany({
                where: { user: { tenantId: id }, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            await tx.auditLog.create({
                data: { tenantId: id, ...this.platformAuditData(req, id), action: 'TENANT_SUSPENDED', resource: 'Tenant', resourceId: id },
            });
        });
        return { id, status: TenantStatus.SUSPENDED };
    }

    @Post('tenants/:id/activate')
    async activateTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        await this.assertTenantCanBeActivated(id, 'activated');
        await this.withPlatformAdmin(async (tx) => {
            await tx.tenant.update({
                where: { id },
                data: { status: TenantStatus.ACTIVE, deletedAt: null },
            });
            await tx.auditLog.create({
                data: { tenantId: id, ...this.platformAuditData(req, id), action: 'TENANT_ACTIVATED', resource: 'Tenant', resourceId: id },
            });
        });
        return { id, status: TenantStatus.ACTIVE };
    }

    @Post('tenants/:id/archive')
    async archiveTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        const tenant = await this.withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id },
            select: { id: true, stripeSubscriptionId: true },
        }));
        if (!tenant) throw new NotFoundException('Tenant not found');
        if (tenant.stripeSubscriptionId) {
            if (!this.stripeBilling) {
                throw new ServiceUnavailableException('Stripe billing is unavailable; tenant was not archived.');
            }
            await this.stripeBilling.cancelTenantSubscriptionAtPeriodEnd(id, tenant.stripeSubscriptionId);
        }
        await this.withPlatformAdmin(async (tx) => {
            await tx.tenant.update({
                where: { id },
                data: { deletedAt: new Date(), status: TenantStatus.CANCELLED },
            });
            await tx.session.updateMany({
                where: { user: { tenantId: id }, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            await tx.auditLog.create({
                data: { tenantId: id, ...this.platformAuditData(req, id), action: 'TENANT_ARCHIVED', resource: 'Tenant', resourceId: id },
            });
        });
        return { id, archived: true };
    }

    @Post('tenants/:id/restore')
    async restoreTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        await this.assertTenantCanBeActivated(id, 'restored');
        await this.withPlatformAdmin(async (tx) => {
            await tx.tenant.update({
                where: { id },
                data: { deletedAt: null, status: TenantStatus.ACTIVE },
            });
            await tx.auditLog.create({
                data: { tenantId: id, ...this.platformAuditData(req, id), action: 'TENANT_RESTORED', resource: 'Tenant', resourceId: id },
            });
        });
        return { id, restored: true };
    }

    private async assertTenantCanBeActivated(id: string, action: 'activated' | 'restored'): Promise<void> {
        const tenant = await this.withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id },
            select: { id: true, planTier: true, stripeSubscriptionId: true },
        }));
        if (!tenant) throw new NotFoundException('Tenant not found');
        if (tenant.stripeSubscriptionId) {
            if (!this.stripeBilling) {
                throw new ServiceUnavailableException(`Stripe billing is unavailable; tenant was not ${action}.`);
            }
            await this.stripeBilling.assertTenantSubscriptionActive(id, tenant.stripeSubscriptionId);
        } else if (tenant.planTier !== PlanTier.FREE) {
            throw new BadRequestException(`Paid tenants require an active Stripe subscription before being ${action}.`);
        }
    }

    @Delete('tenants/:id')
    async deleteTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);

        if (req?.user?.tenantId === id) {
            throw new BadRequestException('You cannot permanently delete your own tenant.');
        }

        const tenant = await this.withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id },
            select: { id: true, slug: true, status: true, deletedAt: true },
        }));

        if (!tenant) {
            throw new BadRequestException('Tenant not found');
        }

        if (!tenant.deletedAt) {
            throw new BadRequestException('Archive tenant before permanent deletion.');
        }

        const asOf = new Date();
        if (!isTenantReadyForRetentionPurge(tenant, asOf)) {
            throw new BadRequestException('Tenant retained records are not expired. Run the retained-record expiry dry-run for the purge schedule.');
        }

        const attempt = await this.tenantAccountLifecycle.purgeRetentionCandidate(tenant, 'retained_records', asOf);
        this.metricsService.retentionPurgeTenantsTotal?.inc({ stage: 'retained_records', outcome: attempt.outcome });
        if (attempt.outcome === 'failed') {
            throw new ServiceUnavailableException(`Tenant purge failed: ${attempt.error}`);
        }
        if (attempt.outcome === 'skipped') {
            throw new ConflictException(`Tenant purge skipped: ${attempt.reason}`);
        }
        const purged = attempt.result;

        return {
            ...purged,
            retention: buildTenantRetentionSchedule(tenant.deletedAt),
        };
    }

    @Post('retention/purge-expired')
    @HttpCode(HttpStatus.OK)
    async purgeExpiredRetentionRecords(
        @Req() req: any,
        @Body() body: { asOf?: unknown; dryRun?: unknown; limit?: unknown; stage?: unknown; executeConfirmation?: unknown; continuation?: unknown } = {},
    ) {
        this.assertSuperAdmin(req);
        const isRetentionService = req?.user?.service === 'retention-purge';
        const asOf = isRetentionService ? new Date() : this.parseRetentionAsOf(body?.asOf);
        const dryRun = this.parseRetentionDryRun(body?.dryRun);
        const stage = this.parseRetentionStage(body?.stage);
        if (isRetentionService && stage !== 'application_data') {
            throw new ForbiddenException('Retention service automation is restricted to the application_data stage.');
        }
        this.assertRetentionExecuteConfirmed(dryRun, stage, body?.executeConfirmation);
        const limit = this.parseRetentionLimit(body?.limit);
        const continuation = this.parseRetentionContinuation(body?.continuation);
        const eligibilityWhere = stage === 'application_data'
            ? buildExpiredTenantApplicationDataWhere(asOf)
            : buildExpiredTenantRetentionWhere(asOf);
        const where: Prisma.TenantWhereInput = continuation
            ? {
                AND: [
                    eligibilityWhere,
                    {
                        OR: [
                            { deletedAt: { gt: continuation.deletedAt } },
                            { deletedAt: continuation.deletedAt, id: { gt: continuation.id } },
                        ],
                    },
                ],
            }
            : eligibilityWhere;

        const candidates = await this.withPlatformAdmin((tx) => tx.tenant.findMany({
                where,
                orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
                take: limit,
                select: { id: true, slug: true, status: true, deletedAt: true, applicationDataPurgedAt: true },
            }), { maxWait: 2_000, timeout: 5_000 });
        const pendingDeletionBillingCandidates = stage === 'application_data' && !continuation
            ? await this.tenantAccountLifecycle.listPendingDeletionBillingCandidates(limit)
            : [];
        const blockedTenants = [
            ...candidates
                .filter((tenant) => tenant.id === req?.user?.tenantId)
                .map((tenant) => ({ id: tenant.id, reason: 'Refusing to purge the caller tenant.' })),
            ...pendingDeletionBillingCandidates
                .filter((tenant) => tenant.id === req?.user?.tenantId)
                .map((tenant) => ({ id: tenant.id, reason: 'Refusing to reconcile deletion billing for the caller tenant.' })),
        ];
        const executableCandidates = candidates.filter((tenant) => tenant.id !== req?.user?.tenantId);
        const executableDeletionBillingCandidates = pendingDeletionBillingCandidates
            .filter((tenant) => tenant.id !== req?.user?.tenantId);
        const attempts = [];
        const deletionBillingAttempts = [];

        if (!dryRun) {
            for (const tenant of executableDeletionBillingCandidates) {
                const attempt = await this.tenantAccountLifecycle.reconcilePendingDeletionBillingCandidate(tenant.id);
                deletionBillingAttempts.push(attempt);
                this.metricsService.retentionPurgeTenantsTotal?.inc({ stage: 'deletion_billing', outcome: attempt.outcome });
            }
            for (const tenant of executableCandidates) {
                const attempt = await this.tenantAccountLifecycle.purgeRetentionCandidate(
                    tenant,
                    stage as TenantRetentionStage,
                    asOf,
                );
                attempts.push(attempt);
                this.metricsService.retentionPurgeTenantsTotal?.inc({ stage, outcome: attempt.outcome });
            }
        }
        const processedTenants = attempts
            .filter((attempt) => attempt.outcome === 'processed')
            .map((attempt) => attempt.result);
        const reconciledDeletionTenants = deletionBillingAttempts
            .filter((attempt) => attempt.outcome === 'processed')
            .map((attempt) => attempt.result);
        const skippedTenants = [...deletionBillingAttempts, ...attempts]
            .filter((attempt) => attempt.outcome === 'skipped')
            .map((attempt) => ({ id: attempt.tenantId, reason: attempt.reason }));
        const failedTenants = [...deletionBillingAttempts, ...attempts]
            .filter((attempt) => attempt.outcome === 'failed')
            .map((attempt) => ({ id: attempt.tenantId, error: attempt.error }));
        const lastCandidate = candidates.at(-1);
        const nextContinuation = candidates.length === limit && lastCandidate?.deletedAt
            ? { deletedAt: lastCandidate.deletedAt.toISOString(), id: lastCandidate.id }
            : null;

        return {
            asOf: asOf.toISOString(),
            dryRun,
            stage,
            limit,
            policy: {
                ...TENANT_RETENTION_POLICY,
                retainedRecords: Array.from(TENANT_RETENTION_POLICY.retainedRecords),
            },
            candidates: candidates.map((tenant) => serializeTenantRetentionCandidate(tenant, asOf)),
            blockedTenants,
            skippedTenants,
            failedTenants,
            processedTenantCount: processedTenants.length + reconciledDeletionTenants.length,
            skippedTenantCount: skippedTenants.length + blockedTenants.length,
            failedTenantCount: failedTenants.length,
            nextContinuation,
            pendingDeletionBillingCandidates: pendingDeletionBillingCandidates.map((tenant) => ({
                id: tenant.id,
                deletionRequestedAt: tenant.deletionRequestedAt.toISOString(),
            })),
            reconciledDeletionTenants,
            applicationDataPurgedTenants: stage === 'application_data' ? processedTenants : [],
            purgedTenants: stage === 'retained_records' ? processedTenants : [],
            externalRetention: {
                databaseBackups: 'Verify backup pruning separately; API deletion cannot remove immutable backup payloads.',
                securityLogs: 'Verify log retention separately; API deletion cannot remove external log payloads.',
            },
        };
    }

    @Post('account/export')
    @RequirePermission('account:data_export')
    @HttpCode(HttpStatus.OK)
    async exportOwnTenant(@Req() req: any) {
        return this.tenantExport.start(this.tenantLifecycleActor(req, 'account:data_export'));
    }

    @Get('account/exports')
    @RequirePermission('account:data_export')
    async listOwnTenantExports(@Req() req: any) {
        return this.tenantExport.listRecent(this.tenantLifecycleActor(req, 'account:data_export'));
    }

    @Get('account/exports/:jobId')
    @RequirePermission('account:data_export')
    async getOwnTenantExport(@Req() req: any, @Param('jobId') jobId: string) {
        const actor = this.tenantLifecycleActor(req, 'account:data_export');
        return this.tenantExport.status(actor, jobId);
    }

    @Get('account/exports/:jobId/download')
    @RequirePermission('account:data_export')
    async downloadOwnTenantExport(@Req() req: any, @Param('jobId') jobId: string, @Res() res: any) {
        const actor = this.tenantLifecycleActor(req, 'account:data_export');
        const artifact = await this.tenantExport.openDownload(actor, jobId);
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Content-Length', String(artifact.bytes));
        res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
        artifact.stream.pipe(res);
    }

    @Get('account/status')
    @RequirePermission('settings:write')
    async getOwnTenantAccountStatus(@Req() req: any) {
        return this.tenantAccountLifecycle.getStatus(this.tenantLifecycleActor(req));
    }

    @Post('account/cancel')
    @RequirePermission('tenant_account:lifecycle')
    async cancelOwnTenant(
        @Req() req: any,
        @Body() body: { confirmation?: unknown; reason?: unknown },
    ) {
        return this.tenantAccountLifecycle.cancelTenant(
            this.tenantLifecycleActor(req, 'tenant_account:lifecycle'),
            body,
        );
    }

    @Delete('account')
    @RequirePermission('tenant_account:lifecycle')
    async requestOwnTenantDeletion(
        @Req() req: any,
        @Body() body: { confirmation?: unknown },
    ) {
        return this.tenantAccountLifecycle.requestDeletion(
            this.tenantLifecycleActor(req, 'tenant_account:lifecycle'),
            body,
        );
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

        const data = await this.withPlatformAdmin((tx) => tx.user.findMany({
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
        }));

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
                mfaEnabled: user.mfaEnabled,
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
        const existingUser = await this.withPlatformAdmin((tx) => tx.user.findUnique({
            where: { id },
            select: {
                tenantId: true,
                deletedAt: true,
            },
        }));
        if (!existingUser) {
            throw new BadRequestException('User not found');
        }

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

        const updated = await this.withPlatformAdmin(async (tx) => {
            if (body.tenantId !== undefined && !existingUser.deletedAt && body.tenantId !== existingUser.tenantId) {
                await assertTenantCanAddActiveUser(tx as any, body.tenantId as string);
            }
            const updated = await tx.user.update({
                where: { id },
                data: patch,
                include: { tenant: { select: { id: true, name: true, slug: true } } },
            });

            await tx.auditLog.create({
                data: {
                    tenantId: updated.tenantId,
                    ...this.platformAuditData(req, updated.tenantId),
                    action: 'USER_UPDATED',
                    resource: 'User',
                    resourceId: id,
                },
            });

            return updated;
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

    @Post('users/:id/mfa/reset')
    async resetUserMfa(
        @Req() req: any,
        @Param('id') id: string,
        @Body() body: { confirmation?: string; reason?: string },
    ) {
        this.assertSuperAdmin(req);
        const actor = this.platformAuditAttribution(req);
        return this.userMfaRecovery.reset({
            targetUserId: id,
            confirmation: body?.confirmation ?? '',
            reason: body?.reason ?? '',
            actorUserId: actor.actorUserId ?? '',
            actorTenantId: actor.actorTenantId ?? '',
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
        });
    }

    @Post('users/:id/lock')
    async lockUser(@Req() req: any, @Param('id') id: string, @Body() body: { minutes?: number }) {
        this.assertSuperAdmin(req);
        const minutes = Number.isFinite(body?.minutes as number) ? Math.max(1, Math.min(60 * 24 * 30, Number(body.minutes))) : 60;
        const lockedUntil = new Date(Date.now() + minutes * 60 * 1000);
        await this.withPlatformAdmin(async (tx) => {
            const user = await tx.user.update({
                where: { id },
                data: { lockedUntil, pinLockedUntil: lockedUntil },
            });
            await tx.session.updateMany({
                where: { userId: id, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            await tx.auditLog.create({
                data: { tenantId: user.tenantId, ...this.platformAuditData(req, user.tenantId), action: 'USER_LOCKED', resource: 'User', resourceId: id },
            });
        });
        return { id, lockedUntil };
    }

    @Post('users/:id/unlock')
    async unlockUser(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        await this.withPlatformAdmin(async (tx) => {
            const user = await tx.user.update({
                where: { id },
                data: { lockedUntil: null, pinLockedUntil: null, loginAttempts: 0, pinLoginAttempts: 0 },
            });
            await tx.auditLog.create({
                data: { tenantId: user.tenantId, ...this.platformAuditData(req, user.tenantId), action: 'USER_UNLOCKED', resource: 'User', resourceId: id },
            });
        });
        return { id, unlocked: true };
    }

    @Post('users/:id/suspend')
    async suspendUser(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        const now = new Date();
        await this.withPlatformAdmin(async (tx) => {
            const user = await tx.user.update({
                where: { id },
                data: { deletedAt: now, lockedUntil: now, pinLockedUntil: now },
            });
            await tx.session.updateMany({
                where: { userId: id, revokedAt: null },
                data: { revokedAt: now },
            });
            await tx.auditLog.create({
                data: { tenantId: user.tenantId, ...this.platformAuditData(req, user.tenantId), action: 'USER_SUSPENDED', resource: 'User', resourceId: id },
            });
        });
        return { id, suspended: true };
    }

    @Post('users/:id/activate')
    async activateUser(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        await this.withPlatformAdmin(async (tx) => {
            const existingUser = await tx.user.findUnique({
                where: { id },
                select: {
                    tenantId: true,
                    deletedAt: true,
                },
            });
            if (!existingUser) {
                throw new BadRequestException('User not found');
            }
            if (existingUser.deletedAt) {
                await assertTenantCanAddActiveUser(tx as any, existingUser.tenantId);
            }
            const user = await tx.user.update({
                where: { id },
                data: { deletedAt: null, lockedUntil: null, pinLockedUntil: null, loginAttempts: 0, pinLoginAttempts: 0 },
            });
            await tx.auditLog.create({
                data: { tenantId: user.tenantId, ...this.platformAuditData(req, user.tenantId), action: 'USER_ACTIVATED', resource: 'User', resourceId: id },
            });
        });
        return { id, activated: true };
    }

    @Get('audit')
    async audit(@Req() req: any, @Query('limit') limitRaw?: string) {
        this.assertSuperAdmin(req);

        const limit = Math.min(Math.max(Number(limitRaw) || 25, 1), 100);
        const rows = await this.withPlatformAdmin((tx) => tx.auditLog.findMany({
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
        }));

        return {
            data: rows.map((row: any) => ({
                id: row.id,
                tenantId: row.tenantId,
                action: row.action,
                resource: row.resource,
                resourceId: row.resourceId,
                actorUserId: row.actorUserId,
                actorTenantId: row.actorTenantId,
                ipAddress: row.ipAddress,
                userAgent: row.userAgent,
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
        const [tenants, transactions] = await this.withPlatformAdmin((tx) => Promise.all([
            tx.tenant.findMany({
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
            tx.creditTransaction.findMany({
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
        ]));

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

    @Post('credits/grant')
    @HttpCode(HttpStatus.CREATED)
    async grantCredits(
        @Req() req: any,
        @Body() body: { tenantId: string; amount: number; reason: string },
        @Headers('idempotency-key') idempotencyKeyHeader?: string,
    ) {
        this.assertSuperAdmin(req);

        const tenantId = (body.tenantId ?? '').trim();
        const reason = (body.reason ?? '').trim();
        const amount = Number(body.amount);
        const idempotencyKey = this.normalizeCreditGrantIdempotencyKey(idempotencyKeyHeader);

        if (!tenantId) throw new BadRequestException('tenantId is required');
        if (!reason) throw new BadRequestException('reason is required');
        if (!Number.isInteger(amount) || amount <= 0) {
            throw new BadRequestException('amount must be a positive integer');
        }

        const newBalance = await this.meteringService.grantCredits(tenantId, amount, reason, idempotencyKey);

        return {
            success: true,
            newBalance,
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

        await this.withPlatformAdmin((tx) => tx.auditLog.create({
            data: {
                tenantId: req.user.tenantId,
                ...this.platformAuditData(req, req.user.tenantId),
                action: 'PLAN_CREATED',
                resource: 'PlanDefinition',
                resourceId: plan.code,
                newValue: planDefinitionToResponse(plan) as any,
            },
        }));

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

        const plan = await this.withPlatformAdmin(async (tx) => {
            if (patch.userLimit !== undefined) {
                await assertPlanUserLimitChangeAllowsExistingTenants(tx as any, code, patch.userLimit);
            }
            return existing
                ? tx.planDefinition.update({
                    where: { code },
                    data: patch,
                })
                : tx.planDefinition.create({
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
        });

        await this.withPlatformAdmin((tx) => tx.auditLog.create({
            data: {
                tenantId: req.user.tenantId,
                ...this.platformAuditData(req, req.user.tenantId),
                action: 'PLAN_UPDATED',
                resource: 'PlanDefinition',
                resourceId: plan.code,
                newValue: planDefinitionToResponse(plan) as any,
            },
        }));

        return planDefinitionToResponse(plan);
    }

    @Delete('plans/:codeOrId')
    async deletePlan(@Req() req: any, @Param('codeOrId') codeOrId: string) {
        this.assertSuperAdmin(req);

        const plan = await this.findPlanByCodeOrId(codeOrId);
        if (!plan) {
            throw new NotFoundException(`Plan ${normalizePlanCode(codeOrId)} not found.`);
        }
        if (resolveFallbackPlanDefinition(plan.code)) {
            throw new BadRequestException('Built-in plans cannot be deleted. Mark the plan inactive instead.');
        }

        await this.prisma.planDefinition.delete({ where: { code: plan.code } });
        await this.withPlatformAdmin((tx) => tx.auditLog.create({
            data: {
                tenantId: req.user.tenantId,
                ...this.platformAuditData(req, req.user.tenantId),
                action: 'PLAN_DELETED',
                resource: 'PlanDefinition',
                resourceId: plan.code,
                oldValue: planDefinitionToResponse(plan) as any,
            },
        }));

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
