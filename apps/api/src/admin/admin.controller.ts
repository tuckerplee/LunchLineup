import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, NotFoundException, type OnModuleDestroy, Optional, Param, Post, Put, Query, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlanTier, Prisma, PrismaClient, TenantStatus, UserRole } from '@prisma/client';
import Redis from 'ioredis';
import { MetricsService } from '../common/metrics.service';
import {
    buildBoundedListPage,
    decodeBoundedListCursor,
    parseBoundedListLimit,
} from '../common/bounded-pagination';
import { MeteringService } from '../billing/metering.service';
import {
    DEFAULT_PLAN_FEATURES,
    FEATURE_KEYS,
    isTenantPlanCode,
    listPlanDefinitions,
    normalizePlanCode,
    planDefinitionToResponse,
    resolveFallbackPlanDefinition,
} from '../billing/plan-definitions';
import { assertPlanUserLimitChangeAllowsExistingTenants } from '../billing/user-capacity';
import { StripeService } from '../billing/stripe.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { isSerializableTransactionConflict } from '../database/transaction-error';
import { RequirePermission } from '../auth/require-permission.decorator';
import { applyOnboardingSignupAttemptRetention } from '../auth/onboarding-signup-retention';
import { TenantAccountLifecycleService, type TenantLifecycleActor, type TenantRetentionStage } from './tenant-account-lifecycle.service';
import { RbacService } from '../auth/rbac.service';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantExportService } from './tenant-export.service';
import { AdminUserMfaRecoveryService } from './admin-user-mfa-recovery.service';
import { AdminUserLifecycleService, type AdminUserLifecycleActor } from './admin-user-lifecycle.service';
import { applyStaffInvitationOutboxRetention } from '../users/staff-invitation-outbox.service';
import {
    TENANT_RETENTION_POLICY,
    applyDormantSessionRetention,
    applyPasswordResetTokenRetention,
    buildExpiredTenantApplicationDataWhere,
    buildExpiredTenantRetentionWhere,
    buildTenantRetentionSchedule,
    isTenantReadyForRetentionPurge,
    serializeTenantRetentionCandidate,
} from './tenant-account-lifecycle';

type AdminUserDirectoryStatus = 'ALL' | 'ACTIVE' | 'LOCKED' | 'SUSPENDED' | 'DELETED';
type SolverQueueTelemetry = {
    ready: number;
    retry: number;
    deadLetter: number;
};

@Controller({ path: 'admin', version: '1' })
@RequirePermission('admin_portal:access')
@UseGuards(JwtAuthGuard)
export class AdminController implements OnModuleDestroy {
    private static readonly DEFAULT_TENANT_TRIAL_DAYS = 14;
    private static readonly MAX_TENANT_TRIAL_DAYS = 90;
    private static readonly MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
    private prisma = new PrismaClient();
    private readonly tenantDb: TenantPrismaService;
    private readonly tenantAccountLifecycle: TenantAccountLifecycleService;
    private readonly tenantProvisioning: TenantProvisioningService;
    private readonly tenantExport: TenantExportService;
    private readonly userMfaRecovery: AdminUserMfaRecoveryService;
    private readonly userLifecycle: AdminUserLifecycleService;
    private readonly rbac: RbacService;
    private static readonly USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;
    private static readonly PUBLIC_USER_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    private static readonly OWNER_EMAIL_REGEX = /^[a-z0-9.!#$%*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
    private static readonly RETAINED_RECORD_PURGE_CONFIRM = 'purge-expired-retained-records';
    private static readonly APPLICATION_DATA_PURGE_CONFIRM = 'purge-expired-application-data';
    private static readonly WORKER_METRICS_TIMEOUT_MS = 1_000;
    private static readonly WORKER_METRICS_MAX_BYTES = 2_000_000;

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
        this.rbac = rbacService ?? new RbacService(this.tenantDb);
        this.userMfaRecovery = new AdminUserMfaRecoveryService(this.tenantDb, this.rbac);
        this.userLifecycle = new AdminUserLifecycleService(this.tenantDb, this.rbac);
        this.tenantAccountLifecycle = new TenantAccountLifecycleService(this.tenantDb, this.stripeBilling);
        this.tenantProvisioning = new TenantProvisioningService(
            this.tenantDb,
            this.rbac,
        );
        this.tenantExport = new TenantExportService(this.tenantDb, this.metricsService);
    }

    onModuleDestroy(): void {
        this.tenantExport.onModuleDestroy();
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

    private creditGrantAuditId(transactionId: string): string {
        return `${transactionId}-audit`;
    }

    private creditGrantAuditMatches(
        audit: {
            tenantId: string;
            action: string;
            resource: string;
            resourceId: string | null;
            newValue: Prisma.JsonValue | null;
        } | null,
        expected: {
            tenantId: string;
            transactionId: string;
            amount: number;
            reason: string;
            newBalance: number;
        },
    ): boolean {
        const value = audit?.newValue;
        return audit?.tenantId === expected.tenantId
            && audit.action === 'TENANT_CREDITS_GRANTED'
            && audit.resource === 'CreditTransaction'
            && audit.resourceId === expected.transactionId
            && value !== null
            && typeof value === 'object'
            && !Array.isArray(value)
            && value.creditTransactionId === expected.transactionId
            && value.amount === expected.amount
            && value.reason === expected.reason
            && value.newBalance === expected.newBalance;
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

    private async withPlatformAdminUserMutation<T>(
        operation: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return await this.withPlatformAdmin(operation, {
                    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                });
            } catch (error) {
                if (!isSerializableTransactionConflict(error)) throw error;
                if (attempt === 1) {
                    throw new ConflictException('Authorization or access state changed concurrently; retry the request');
                }
            }
        }
        throw new ConflictException('Authorization or access state changed concurrently; retry the request');
    }

    private async resolveAdminUserIdentifier(
        tx: Prisma.TransactionClient,
        identifier: string,
    ): Promise<{ id: string; publicId: string }> {
        const normalized = typeof identifier === 'string' ? identifier.trim() : '';
        if (!normalized) throw new BadRequestException('User not found');

        // Retained unit and operator callers may still use old opaque IDs. All
        // browser-visible UUIDs resolve through User.publicId first.
        if (!AdminController.PUBLIC_USER_ID_REGEX.test(normalized)) {
            return { id: normalized, publicId: normalized };
        }
        const byPublicId = await tx.user.findUnique({
            where: { publicId: normalized },
            select: { id: true, publicId: true },
        });
        if (byPublicId) return byPublicId;
        const byStorageId = await tx.user.findUnique({
            where: { id: normalized },
            select: { id: true, publicId: true },
        });
        if (!byStorageId) throw new BadRequestException('User not found');
        return byStorageId;
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

    private adminUserLifecycleActor(req: any): AdminUserLifecycleActor {
        const attribution = this.platformAuditAttribution(req);
        if (!attribution.actorUserId || !attribution.actorTenantId) {
            throw new BadRequestException('Authenticated platform administrator identity is required.');
        }
        const sessionId = typeof req?.user?.sessionId === 'string' ? req.user.sessionId.trim() : '';
        if (!sessionId) {
            throw new BadRequestException('Authenticated platform administrator session is required.');
        }
        return {
            userId: attribution.actorUserId,
            tenantId: attribution.actorTenantId,
            sessionId,
            ipAddress: attribution.ipAddress,
            userAgent: attribution.userAgent,
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

    private mapUserStatus(
        user: { deletedAt: Date | null; suspendedAt: Date | null; lockedUntil: Date | null; pinLockedUntil: Date | null },
        now = new Date(),
    ): Exclude<AdminUserDirectoryStatus, 'ALL'> {
        if (user.deletedAt) return 'DELETED';
        if (user.suspendedAt) return 'SUSPENDED';
        if ((user.lockedUntil && user.lockedUntil > now) || (user.pinLockedUntil && user.pinLockedUntil > now)) {
            return 'LOCKED';
        }
        return 'ACTIVE';
    }

    private parseAdminUserDirectoryStatus(value: unknown): AdminUserDirectoryStatus {
        if (value === undefined || value === null || value === '') return 'ALL';
        if (typeof value !== 'string') {
            throw new BadRequestException('Invalid status filter.');
        }
        const status = value.trim().toUpperCase();
        if (!['ALL', 'ACTIVE', 'LOCKED', 'SUSPENDED', 'DELETED'].includes(status)) {
            throw new BadRequestException('Invalid status filter. Use ALL, ACTIVE, LOCKED, SUSPENDED, or DELETED.');
        }
        return status as AdminUserDirectoryStatus;
    }

    private buildAdminUserSearchWhere(search: string): Prisma.UserWhereInput {
        const normalizedRoleSearch = search.trim().toUpperCase().replace(/[\s-]+/g, '_');
        const matchingRoles = Object.values(UserRole).filter((role) => role.includes(normalizedRoleSearch));
        const fields: Prisma.UserWhereInput[] = [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { username: { contains: search, mode: 'insensitive' } },
            { tenant: { is: { name: { contains: search, mode: 'insensitive' } } } },
            { tenant: { is: { slug: { contains: search, mode: 'insensitive' } } } },
        ];
        if (matchingRoles.length > 0) {
            fields.push({ role: { in: matchingRoles } });
        }
        return { OR: fields };
    }

    private buildAdminUserStatusWhere(
        status: Exclude<AdminUserDirectoryStatus, 'ALL'>,
        now: Date,
    ): Prisma.UserWhereInput {
        switch (status) {
            case 'DELETED':
                return { deletedAt: { not: null } };
            case 'SUSPENDED':
                return { deletedAt: null, suspendedAt: { not: null } };
            case 'LOCKED':
                return {
                    deletedAt: null,
                    suspendedAt: null,
                    OR: [
                        { lockedUntil: { gt: now } },
                        { pinLockedUntil: { gt: now } },
                    ],
                };
            case 'ACTIVE':
                return {
                    deletedAt: null,
                    suspendedAt: null,
                    AND: [
                        { OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
                        { OR: [{ pinLockedUntil: null }, { pinLockedUntil: { lte: now } }] },
                    ],
                };
        }
    }

    @Get('stats')
    async stats(@Req() req: any) {
        this.assertSuperAdmin(req);

        const now = new Date();
        const [[totalTenants, totalUsers, activeSessions], solverQueue] = await Promise.all([
            this.withPlatformAdmin((tx) => Promise.all([
                tx.tenant.count({ where: { deletedAt: null } }),
                tx.user.count({ where: { deletedAt: null } }),
                tx.session.count({
                    where: {
                        revokedAt: null,
                        expiresAt: { gt: now },
                    },
                }),
            ])),
            this.readSolverQueueTelemetry(),
        ]);

        return {
            totalTenants,
            totalUsers,
            activeSessions,
            solverQueue: solverQueue === null ? null : solverQueue.ready + solverQueue.retry,
            solverQueueReady: solverQueue?.ready ?? null,
            solverQueueRetry: solverQueue?.retry ?? null,
            solverQueueDeadLetter: solverQueue?.deadLetter ?? null,
        };
    }

    @Get('tenants')
    async tenants(
        @Req() req: any,
        @Query('limit') limitRaw?: string,
        @Query('cursor') cursorRaw?: string,
        @Query('q') qRaw?: string,
    ) {
        this.assertSuperAdmin(req);
        const limit = parseBoundedListLimit(limitRaw);
        const cursor = decodeBoundedListCursor(cursorRaw);
        const search = this.parseAdminListSearch(qRaw);
        const where: Prisma.TenantWhereInput = {
            ...(search ? {
                OR: [
                    { name: { contains: search, mode: 'insensitive' } },
                    { slug: { contains: search, mode: 'insensitive' } },
                ],
            } : {}),
            ...(cursor ? {
                AND: [{
                    OR: [
                        { createdAt: { lt: cursor.timestamp } },
                        { createdAt: cursor.timestamp, id: { lt: cursor.id } },
                    ],
                }],
            } : {}),
        };

        const rows = await this.withPlatformAdmin((tx) => tx.tenant.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
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
        const page = buildBoundedListPage(rows, limit, (tenant) => tenant.createdAt, {});

        return {
            data: page.data.map((tenant: any) => ({
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
            pagination: page.pagination,
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
        if (body.usageCredits !== undefined && body.usageCredits !== 0) {
            throw new BadRequestException(
                'New tenants start with zero credits. Use the dedicated idempotent credit grant endpoint after provisioning.',
            );
        }
        const usageCredits = 0;
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
            creditDebt?: number;
            trialEndsAt?: string | null;
            gracePeriodEndsAt?: string | null;
        },
    ) {
        this.assertSuperAdmin(req);
        const protectedFields = [
            'planTier',
            'status',
            'usageCredits',
            'creditDebt',
            'stripeSubscriptionId',
            'stripeSubscriptionCurrentPeriodEnd',
        ].filter((field) =>
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

        if (body.trialEndsAt !== undefined) patch.trialEndsAt = this.parseOptionalIsoDate(body.trialEndsAt);
        if (body.gracePeriodEndsAt !== undefined) patch.gracePeriodEndsAt = this.parseOptionalIsoDate(body.gracePeriodEndsAt);
        if (Object.keys(patch).length === 0) throw new BadRequestException('No valid fields to update');
        const mutationActor = this.adminUserLifecycleActor(req);

        await this.withPlatformAdminUserMutation(async (tx) => {
            await this.rbac.authorizePlatformAdminTenantMutationInTransaction(tx, id, mutationActor);
            const lockedTenant = await tx.tenant.findUnique({ where: { id }, select: { id: true } });
            if (!lockedTenant) throw new BadRequestException('Tenant not found');
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
        const mutationActor = this.adminUserLifecycleActor(req);
        await this.withPlatformAdminUserMutation(async (tx) => {
            await this.rbac.authorizePlatformAdminTenantMutationInTransaction(tx, id, mutationActor);
            const tenant = await tx.tenant.findUnique({ where: { id }, select: { id: true } });
            if (!tenant) throw new BadRequestException('Tenant not found');
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
        const eligibility = await this.assertTenantCanBeActivated(id, 'activated');
        await this.withPlatformAdmin(async (tx) => {
            await this.lockTenantLifecycleForActivation(tx, id);
            const tenant = await this.assertTenantHasNoDeletionBarrier(tx, id, 'activated');
            this.assertTenantActivationEligibilityUnchanged(tenant, eligibility, 'activated');
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
        return this.tenantAccountLifecycle.archiveTenant(
            id,
            this.adminUserLifecycleActor(req),
        );
    }

    @Post('tenants/:id/restore')
    async restoreTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        const eligibility = await this.assertTenantCanBeActivated(id, 'restored');
        await this.withPlatformAdmin(async (tx) => {
            await this.lockTenantLifecycleForActivation(tx, id);
            const tenant = await this.assertTenantHasNoDeletionBarrier(tx, id, 'restored');
            this.assertTenantActivationEligibilityUnchanged(tenant, eligibility, 'restored');
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

    @Put('tenants/:id/retention-legal-hold')
    async placeTenantRetentionLegalHold(
        @Req() req: any,
        @Param('id') id: string,
        @Body() body: { reason?: unknown } = {},
    ) {
        this.assertSuperAdmin(req);
        return this.tenantAccountLifecycle.placeRetentionLegalHold(
            id,
            this.adminUserLifecycleActor(req),
            body,
        );
    }

    @Delete('tenants/:id/retention-legal-hold')
    async releaseTenantRetentionLegalHold(
        @Req() req: any,
        @Param('id') id: string,
        @Body() body: { reason?: unknown } = {},
    ) {
        this.assertSuperAdmin(req);
        return this.tenantAccountLifecycle.releaseRetentionLegalHold(
            id,
            this.adminUserLifecycleActor(req),
            body,
        );
    }

    private async assertTenantCanBeActivated(id: string, action: 'activated' | 'restored') {
        const tenant = await this.withPlatformAdmin((tx) =>
            this.assertTenantHasNoDeletionBarrier(tx, id, action));
        if (tenant.stripeSubscriptionId) {
            if (!this.stripeBilling) {
                throw new ServiceUnavailableException(`Stripe billing is unavailable; tenant was not ${action}.`);
            }
            await this.stripeBilling.assertTenantSubscriptionActive(id, tenant.stripeSubscriptionId);
        } else if (tenant.planTier !== PlanTier.FREE) {
            throw new BadRequestException(`Paid tenants require an active Stripe subscription before being ${action}.`);
        }
        return {
            planTier: tenant.planTier,
            stripeSubscriptionId: tenant.stripeSubscriptionId,
        };
    }

    private async lockTenantLifecycleForActivation(
        tx: Prisma.TransactionClient,
        id: string,
    ): Promise<void> {
        await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${id})`;
        await tx.$queryRaw`
            SELECT "id"
            FROM "Tenant"
            WHERE "id" = ${id}
            FOR UPDATE
        `;
    }

    private assertTenantActivationEligibilityUnchanged(
        tenant: { planTier: PlanTier; stripeSubscriptionId: string | null },
        eligibility: { planTier: PlanTier; stripeSubscriptionId: string | null },
        action: 'activated' | 'restored',
    ): void {
        if (tenant.planTier !== eligibility.planTier
            || tenant.stripeSubscriptionId !== eligibility.stripeSubscriptionId) {
            throw new ConflictException(
                `Tenant billing eligibility changed before it could be ${action}.`,
            );
        }
    }

    private async assertTenantHasNoDeletionBarrier(
        tx: Prisma.TransactionClient,
        id: string,
        action: 'activated' | 'restored',
    ) {
        const tenant = await tx.tenant.findUnique({
            where: { id },
            select: {
                id: true,
                planTier: true,
                stripeSubscriptionId: true,
                status: true,
                deletedAt: true,
                auditLogs: {
                    where: {
                        tenantId: id,
                        resource: 'Tenant',
                        resourceId: id,
                        action: {
                            in: [
                                'TENANT_DELETION_BARRIER_COMMITTED',
                                'TENANT_DELETION_REQUESTED_BY_CUSTOMER',
                            ],
                        },
                    },
                    select: { id: true, action: true },
                    take: 1,
                },
            },
        });
        if (!tenant) throw new NotFoundException('Tenant not found');
        if (tenant.status === TenantStatus.PURGED || (tenant.auditLogs?.length ?? 0) > 0) {
            throw new ConflictException(
                `Finalized or pending tenant deletion is irreversible; tenant cannot be ${action}.`,
            );
        }
        return tenant;
    }

    @Delete('tenants/:id')
    async deleteTenant(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);

        if (req?.user?.tenantId === id) {
            throw new BadRequestException('You cannot permanently delete your own tenant.');
        }

        const tenant = await this.withPlatformAdmin((tx) => tx.tenant.findUnique({
            where: { id },
            select: {
                id: true,
                slug: true,
                status: true,
                deletedAt: true,
                retentionLegalHoldAt: true,
                retentionLegalHoldReason: true,
                retentionLegalHoldByUserId: true,
            },
        }));

        if (!tenant) {
            throw new BadRequestException('Tenant not found');
        }

        if (!tenant.deletedAt) {
            throw new BadRequestException('Archive tenant before permanent deletion.');
        }
        if (tenant.retentionLegalHoldAt) {
            throw new ConflictException('Tenant retained records are under retention legal hold.');
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
        if (isRetentionService && stage === 'retained_records' && !dryRun) {
            throw new ForbiddenException('Retention service automation may only dry-run the retained_records stage.');
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

        const { candidates, passwordResetTokenRetention, sessionRetention, signupAttemptRetention, staffInvitationRetention } = await this.withPlatformAdmin(async (tx) => {
            const signupAttemptRetention = await applyOnboardingSignupAttemptRetention(tx, asOf, dryRun);
            const passwordResetTokenRetention = stage === 'application_data' && !continuation
                ? await applyPasswordResetTokenRetention(tx, asOf, dryRun)
                : null;
            const sessionRetention = stage === 'application_data' && !continuation
                ? await applyDormantSessionRetention(tx, asOf, dryRun)
                : null;
            const staffInvitationRetention = stage === 'application_data' && !continuation
                ? await applyStaffInvitationOutboxRetention(tx, asOf, dryRun)
                : null;
            const candidates = await tx.tenant.findMany({
                where,
                orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
                take: limit,
                select: {
                    id: true,
                    slug: true,
                    status: true,
                    deletedAt: true,
                    applicationDataPurgedAt: true,
                    retentionLegalHoldAt: true,
                    retentionLegalHoldReason: true,
                    retentionLegalHoldByUserId: true,
                },
            });
            return { candidates, passwordResetTokenRetention, sessionRetention, signupAttemptRetention, staffInvitationRetention };
        }, { maxWait: 2_000, timeout: 5_000 });
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
            signupAttemptRetention,
            passwordResetTokenRetention,
            sessionRetention,
            staffInvitationRetention,
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
    @Header('Cache-Control', 'private, no-store')
    @RequirePermission('account:data_export')
    @HttpCode(HttpStatus.OK)
    async exportOwnTenant(@Req() req: any) {
        return this.tenantExport.start(this.tenantLifecycleActor(req, 'account:data_export'));
    }

    @Get('account/exports')
    @Header('Cache-Control', 'private, no-store')
    @RequirePermission('account:data_export')
    async listOwnTenantExports(@Req() req: any) {
        return this.tenantExport.listRecent(this.tenantLifecycleActor(req, 'account:data_export'));
    }

    @Get('account/exports/:jobId')
    @Header('Cache-Control', 'private, no-store')
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
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        artifact.stream.pipe(res);
    }

    @Get('account/status')
    @Header('Cache-Control', 'private, no-store')
    @RequirePermission('settings:write')
    async getOwnTenantAccountStatus(@Req() req: any) {
        return this.tenantAccountLifecycle.getStatus(this.tenantLifecycleActor(req));
    }

    @Post('account/cancel')
    @Header('Cache-Control', 'private, no-store')
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
    @Header('Cache-Control', 'private, no-store')
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
    async users(
        @Req() req: any,
        @Query('limit') limitRaw?: string,
        @Query('cursor') cursorRaw?: string,
        @Query('q') qRaw?: string,
        @Query('status') statusRaw?: string,
    ) {
        this.assertSuperAdmin(req);
        const limit = parseBoundedListLimit(limitRaw);
        const cursor = decodeBoundedListCursor(cursorRaw);
        const search = this.parseAdminListSearch(qRaw);
        const status = this.parseAdminUserDirectoryStatus(statusRaw);
        const now = new Date();
        const conditions: Prisma.UserWhereInput[] = [];
        if (search) {
            conditions.push(this.buildAdminUserSearchWhere(search));
        }
        if (status !== 'ALL') {
            conditions.push(this.buildAdminUserStatusWhere(status, now));
        }
        if (cursor) {
            conditions.push({
                OR: [
                    { createdAt: { lt: cursor.timestamp } },
                    { createdAt: cursor.timestamp, publicId: { lt: cursor.id } },
                ],
            });
        }
        const where: Prisma.UserWhereInput = conditions.length > 1
            ? { AND: conditions }
            : conditions[0] ?? {};

        const rows = await this.withPlatformAdmin((tx) => tx.user.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { publicId: 'desc' }],
            include: {
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                    },
                },
            },
            take: limit + 1,
        }));
        const page = buildBoundedListPage(
            rows.map((user) => ({ ...user, id: user.publicId })),
            limit,
            (user) => user.createdAt,
            {},
        );

        return {
            data: page.data.map((user: any) => ({
                id: user.id,
                name: user.name,
                email: user.email,
                username: user.username,
                role: user.role,
                createdAt: user.createdAt,
                lastLoginAt: user.lastLoginAt,
                lockedUntil: user.lockedUntil,
                pinLockedUntil: user.pinLockedUntil,
                suspendedAt: user.suspendedAt,
                deletedAt: user.deletedAt,
                mfaEnabled: user.mfaEnabled,
                status: this.mapUserStatus(user, now),
                tenant: user.tenant,
            })),
            pagination: page.pagination,
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
        let requestedRole: UserRole | undefined;
        if (body.role !== undefined) {
            if (!this.isUserRole(body.role)) throw new BadRequestException(`Invalid role: ${body.role}`);
            requestedRole = body.role;
        }
        let requestedTenantId: string | undefined;
        if (body.tenantId !== undefined) {
            if (typeof body.tenantId !== 'string' || !body.tenantId.trim()) {
                throw new BadRequestException('tenantId must be a non-empty string');
            }
            requestedTenantId = body.tenantId.trim();
        }
        if (body.pinResetRequired !== undefined) {
            patch.pinResetRequired = Boolean(body.pinResetRequired);
        }
        if (Object.keys(patch).length === 0 && requestedRole === undefined && requestedTenantId === undefined) {
            throw new BadRequestException('No valid fields to update');
        }
        const mutationActor = this.adminUserLifecycleActor(req);

        const updated = await this.withPlatformAdminUserMutation(async (tx) => {
            const target = await this.resolveAdminUserIdentifier(tx, id);
            const targetUserId = target.id;
            const authorizedTarget = requestedRole === undefined
                ? await this.rbac.authorizePlatformAdminUserMutationInTransaction(
                    tx,
                    targetUserId,
                    mutationActor,
                )
                : null;
            const existingUser = await tx.user.findUnique({
                where: { id: targetUserId },
                select: {
                    id: true,
                    tenantId: true,
                    email: true,
                    role: true,
                    deletedAt: true,
                },
            });
            if (!existingUser) {
                throw new BadRequestException('User not found');
            }
            if (authorizedTarget && authorizedTarget.tenantId !== existingUser.tenantId) {
                throw new ConflictException('User tenant changed before authorization completed');
            }
            if (requestedTenantId !== undefined && requestedTenantId !== existingUser.tenantId) {
                throw new BadRequestException(
                    'Cross-tenant user reassignment is not supported because tenant-owned access and data cannot be migrated safely.',
                );
            }
            if (requestedTenantId !== undefined
                && requestedRole === undefined
                && Object.keys(patch).length === 0) {
                throw new BadRequestException('No valid fields to update');
            }

            const roleReplacement = requestedRole === undefined
                ? null
                : await this.rbac.replaceLegacySystemRoleForPlatformAdminActorInTransaction(
                    tx,
                    targetUserId,
                    existingUser.tenantId,
                    requestedRole,
                    mutationActor,
                );
            const emailChanged = body.email !== undefined && patch.email !== existingUser.email;
            const now = new Date();

            if (emailChanged) {
                await tx.passwordResetToken.updateMany({
                    where: {
                        tenantId: existingUser.tenantId,
                        userId: targetUserId,
                        consumedAt: null,
                    },
                    data: { consumedAt: now },
                });
                await tx.passwordResetEmailOutbox.updateMany({
                    where: {
                        tenantId: existingUser.tenantId,
                        userId: targetUserId,
                        status: { in: ['PENDING', 'SENDING', 'FAILED'] },
                    },
                    data: {
                        status: 'DEAD_LETTERED',
                        deadLetteredAt: now,
                        leaseUntil: null,
                        encryptedPayload: '',
                        encryptionKeyRef: 'erased-v1',
                        lastError: null,
                    },
                });
            }

            if (Object.keys(patch).length > 0) {
                await tx.user.update({
                    where: { id: targetUserId },
                    data: patch,
                });
            }
            if (emailChanged || roleReplacement?.changed) {
                await tx.session.updateMany({
                    where: { userId: targetUserId, revokedAt: null },
                    data: { revokedAt: now },
                });
            }

            await tx.auditLog.create({
                data: {
                    tenantId: existingUser.tenantId,
                    ...this.platformAuditData(req, existingUser.tenantId),
                    action: 'USER_UPDATED',
                    resource: 'User',
                    resourceId: targetUserId,
                    oldValue: {
                        role: roleReplacement?.previousLegacyRole ?? existingUser.role,
                        emailIdentityChanged: false,
                        ...(roleReplacement ? { roleIds: roleReplacement.previousRoleIds } : {}),
                    },
                    newValue: {
                        role: roleReplacement?.legacyRole ?? existingUser.role,
                        emailIdentityChanged: emailChanged,
                        ...(roleReplacement ? { roleIds: [roleReplacement.roleId] } : {}),
                    },
                },
            });

            return tx.user.findUniqueOrThrow({
                where: { id: targetUserId },
                include: { tenant: { select: { id: true, name: true, slug: true } } },
            });
        });

        return {
            id: updated.publicId,
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
        const actor = this.adminUserLifecycleActor(req);
        const target = await this.withPlatformAdmin((tx) => this.resolveAdminUserIdentifier(tx, id));
        const expectedConfirmation = `reset-mfa:${id}`;
        if (body?.confirmation !== expectedConfirmation) {
            throw new BadRequestException(`confirmation must exactly equal ${expectedConfirmation}`);
        }
        const result = await this.userMfaRecovery.reset({
            targetUserId: target.id,
            confirmation: `reset-mfa:${target.id}`,
            reason: body?.reason ?? '',
            actorUserId: actor.userId,
            actorTenantId: actor.tenantId,
            actorSessionId: actor.sessionId,
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
        });
        return { ...result, id: target.publicId };
    }

    @Post('users/:id/lock')
    async lockUser(@Req() req: any, @Param('id') id: string, @Body() body: { minutes?: number }) {
        this.assertSuperAdmin(req);
        const minutes = Number.isFinite(body?.minutes as number) ? Math.max(1, Math.min(60 * 24 * 30, Number(body.minutes))) : 60;
        const lockedUntil = new Date(Date.now() + minutes * 60 * 1000);
        const mutationActor = this.adminUserLifecycleActor(req);
        let publicUserId = id;
        await this.withPlatformAdminUserMutation(async (tx) => {
            const target = await this.resolveAdminUserIdentifier(tx, id);
            publicUserId = target.publicId;
            const authorizedTarget = await this.rbac.authorizePlatformAdminUserMutationInTransaction(
                tx,
                target.id,
                mutationActor,
            );
            const user = await tx.user.update({
                where: { id: authorizedTarget.id },
                data: { lockedUntil, pinLockedUntil: lockedUntil },
            });
            await tx.session.updateMany({
                where: { userId: target.id, revokedAt: null },
                data: { revokedAt: new Date() },
            });
            await tx.auditLog.create({
                data: { tenantId: user.tenantId, ...this.platformAuditData(req, user.tenantId), action: 'USER_LOCKED', resource: 'User', resourceId: target.id },
            });
        });
        return { id: publicUserId, lockedUntil };
    }

    @Post('users/:id/unlock')
    async unlockUser(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        const mutationActor = this.adminUserLifecycleActor(req);
        let publicUserId = id;
        await this.withPlatformAdminUserMutation(async (tx) => {
            const target = await this.resolveAdminUserIdentifier(tx, id);
            publicUserId = target.publicId;
            const authorizedTarget = await this.rbac.authorizePlatformAdminUserMutationInTransaction(
                tx,
                target.id,
                mutationActor,
            );
            const user = await tx.user.update({
                where: { id: authorizedTarget.id },
                data: { lockedUntil: null, pinLockedUntil: null, loginAttempts: 0, pinLoginAttempts: 0 },
            });
            await tx.auditLog.create({
                data: { tenantId: user.tenantId, ...this.platformAuditData(req, user.tenantId), action: 'USER_UNLOCKED', resource: 'User', resourceId: target.id },
            });
        });
        return { id: publicUserId, unlocked: true };
    }

    @Post('users/:id/suspend')
    async suspendUser(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        const target = await this.withPlatformAdmin((tx) => this.resolveAdminUserIdentifier(tx, id));
        const result = await this.userLifecycle.suspend(target.id, this.adminUserLifecycleActor(req));
        return { ...result, id: target.publicId };
    }

    @Post('users/:id/activate')
    async activateUser(@Req() req: any, @Param('id') id: string) {
        this.assertSuperAdmin(req);
        const target = await this.withPlatformAdmin((tx) => this.resolveAdminUserIdentifier(tx, id));
        const result = await this.userLifecycle.activate(target.id, this.adminUserLifecycleActor(req));
        return { ...result, id: target.publicId };
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
    async credits(
        @Req() req: any,
        @Query('limit') legacyHistoryLimitRaw?: string,
        @Query('tenantLimit') tenantLimitRaw?: string,
        @Query('tenantCursor') tenantCursorRaw?: string,
        @Query('q') qRaw?: string,
        @Query('historyLimit') historyLimitRaw?: string,
        @Query('historyCursor') historyCursorRaw?: string,
    ) {
        this.assertSuperAdmin(req);
        const tenantLimit = parseBoundedListLimit(tenantLimitRaw ?? '50');
        const historyLimit = parseBoundedListLimit(historyLimitRaw ?? legacyHistoryLimitRaw ?? '50');
        const tenantCursor = decodeBoundedListCursor(tenantCursorRaw);
        const historyCursor = decodeBoundedListCursor(historyCursorRaw);
        const search = this.parseAdminListSearch(qRaw);
        const tenantWhere: Prisma.TenantWhereInput = {
            deletedAt: null,
            ...(search ? {
                OR: [
                    { name: { contains: search, mode: 'insensitive' } },
                    { slug: { contains: search, mode: 'insensitive' } },
                ],
            } : {}),
            ...(tenantCursor ? {
                AND: [{
                    OR: [
                        { createdAt: { lt: tenantCursor.timestamp } },
                        { createdAt: tenantCursor.timestamp, id: { lt: tenantCursor.id } },
                    ],
                }],
            } : {}),
        };
        const historyWhere: Prisma.CreditTransactionWhereInput = historyCursor ? {
            OR: [
                { createdAt: { lt: historyCursor.timestamp } },
                { createdAt: historyCursor.timestamp, id: { lt: historyCursor.id } },
            ],
        } : {};

        const [tenants, transactions] = await this.withPlatformAdmin((tx) => Promise.all([
            tx.tenant.findMany({
                where: tenantWhere,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: tenantLimit + 1,
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    planTier: true,
                    usageCredits: true,
                    createdAt: true,
                },
            }),
            tx.creditTransaction.findMany({
                where: historyWhere,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: historyLimit + 1,
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
        const tenantPage = buildBoundedListPage(tenants, tenantLimit, (tenant) => tenant.createdAt, {});
        const historyPage = buildBoundedListPage(transactions, historyLimit, (row) => row.createdAt, {});

        return {
            tenants: tenantPage.data.map((tenant: any) => ({
                id: tenant.id,
                name: tenant.name,
                slug: tenant.slug,
                planTier: tenant.planTier,
                usageCredits: tenant.usageCredits,
            })),
            tenantPagination: tenantPage.pagination,
            history: historyPage.data.map((tx: any) => ({
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
            historyPagination: historyPage.pagination,
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

        const actor = this.adminUserLifecycleActor(req);
        const newBalance = await this.withPlatformAdminUserMutation(async (tx) => {
            await tx.$executeRaw`
                LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE
            `;
            await this.rbac.authorizePlatformAdminTenantMutationInTransaction(tx, tenantId, actor);
            const settlement = await this.meteringService.grantCreditsInTransaction(tx, {
                tenantId,
                amount,
                reason,
                idempotencyKey,
            });
            const auditId = this.creditGrantAuditId(settlement.transactionId);
            const auditValue = {
                creditTransactionId: settlement.transactionId,
                amount,
                reason,
                newBalance: settlement.newBalance,
            };

            if (settlement.replayed) {
                const existingAudit = await tx.auditLog.findUnique({
                    where: { id: auditId },
                    select: {
                        tenantId: true,
                        action: true,
                        resource: true,
                        resourceId: true,
                        newValue: true,
                    },
                });
                if (!this.creditGrantAuditMatches(existingAudit, {
                    tenantId,
                    transactionId: settlement.transactionId,
                    amount,
                    reason,
                    newBalance: settlement.newBalance,
                })) {
                    throw new ConflictException('Existing credit grant is missing its exact attributed audit record.');
                }
            } else {
                await tx.auditLog.create({
                    data: {
                        id: auditId,
                        tenantId,
                        ...this.platformAuditData(req, tenantId),
                        action: 'TENANT_CREDITS_GRANTED',
                        resource: 'CreditTransaction',
                        resourceId: settlement.transactionId,
                        newValue: auditValue,
                    },
                });
            }

            return settlement.newBalance;
        });

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
        this.assertPlanCreditInvariant(body);
        const creditQuotaLimit = null;
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
        this.assertPlanCreditInvariant(body);

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
            patch.creditQuotaLimit = null;
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
                        creditQuotaLimit: null,
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

        const solverQueue = await this.readSolverQueueTelemetry();
        const pendingQueueDepth = solverQueue === null ? null : solverQueue.ready + solverQueue.retry;

        components.push({
            label: 'Solver Queue',
            status: solverQueue === null
                ? 'unknown'
                : solverQueue.deadLetter > 0 || pendingQueueDepth! > 50
                    ? 'degraded'
                    : 'online',
            latencyMs: null,
            details: solverQueue === null
                ? 'worker broker telemetry is unavailable'
                : `${pendingQueueDepth} pending jobs (${solverQueue.ready} ready, ${solverQueue.retry} retry, ${solverQueue.deadLetter} dead-letter)`,
        });

        const hasOffline = components.some((component) => component.status === 'offline');
        const hasDegraded = components.some((component) => component.status === 'degraded');
        const hasUnknown = components.some((component) => component.status === 'unknown');
        const overall = hasOffline ? 'offline' : hasDegraded || hasUnknown ? 'degraded' : 'online';

        return { checkedAt, overall, components };
    }

    private async readSolverQueueTelemetry(): Promise<SolverQueueTelemetry | null> {
        const configuredUrl = (
            this.configService.get<string>('WORKER_METRICS_URL')
            ?? process.env.WORKER_METRICS_URL
            ?? 'http://worker:3003/metrics'
        ).trim();
        let metricsUrl: URL;
        try {
            metricsUrl = new URL(configuredUrl);
        } catch {
            return null;
        }
        if (
            !['http:', 'https:'].includes(metricsUrl.protocol)
            || metricsUrl.username
            || metricsUrl.password
        ) {
            return null;
        }

        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            AdminController.WORKER_METRICS_TIMEOUT_MS,
        );
        try {
            const response = await fetch(metricsUrl, {
                headers: { accept: 'text/plain' },
                signal: controller.signal,
            });
            if (!response.ok) return null;
            const metrics = await response.text();
            if (Buffer.byteLength(metrics, 'utf8') > AdminController.WORKER_METRICS_MAX_BYTES) {
                return null;
            }
            if (this.readPrometheusSample(
                metrics,
                'lunchlineup_solver_queue_telemetry_available',
            ) !== 1) {
                return null;
            }

            const ready = this.readPrometheusSample(
                metrics,
                'lunchlineup_solver_queue_messages',
                'ready',
            );
            const retry = this.readPrometheusSample(
                metrics,
                'lunchlineup_solver_queue_messages',
                'retry',
            );
            const deadLetter = this.readPrometheusSample(
                metrics,
                'lunchlineup_solver_queue_messages',
                'dead_letter',
            );
            if (ready === null || retry === null || deadLetter === null) {
                return null;
            }
            return { ready, retry, deadLetter };
        } catch {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    private readPrometheusSample(
        metrics: string,
        metricName: string,
        state?: string,
    ): number | null {
        const expectedIdentity = state === undefined
            ? metricName
            : `${metricName}{state="${state}"}`;
        const samples = metrics
            .split(/\r?\n/)
            .map((line) => line.trim().split(/\s+/))
            .filter(([identity, value, extra]) =>
                identity === expectedIdentity
                && value !== undefined
                && extra === undefined,
            );
        if (samples.length !== 1) return null;
        const value = Number(samples[0][1]);
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
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

    private parseAdminListSearch(value: unknown): string | undefined {
        if (value === undefined || value === null || value === '') return undefined;
        if (typeof value !== 'string') throw new BadRequestException('Invalid search query.');
        const search = value.trim();
        if (!search) return undefined;
        if (search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)) {
            throw new BadRequestException('Search query must be 100 printable characters or fewer.');
        }
        return search;
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

    private assertPlanCreditInvariant(body: {
        creditQuotaLimit?: number | null;
        creditsLimit?: number | null;
        metadata?: Prisma.InputJsonValue | null;
    }): void {
        for (const field of ['creditQuotaLimit', 'creditsLimit'] as const) {
            if (body[field] !== undefined && body[field] !== null) {
                throw new BadRequestException(
                    'Subscription plans never include usage credits. Credits must be purchased or administratively granted separately.',
                );
            }
        }

        const forbiddenMetadataKeys = new Set([
            'credits',
            'includedcredits',
            'usagecredits',
            'creditquotalimit',
            'creditslimit',
            'unlimitedcredits',
            'walletcredits',
        ]);
        const inspect = (value: unknown): void => {
            if (Array.isArray(value)) {
                value.forEach(inspect);
                return;
            }
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                if (forbiddenMetadataKeys.has(key.replace(/[_-]/g, '').toLowerCase())) {
                    throw new BadRequestException(
                        'Plan metadata cannot define included, unlimited, or wallet credits.',
                    );
                }
                inspect(child);
            }
        };
        inspect(body.metadata);
        this.assertPlanFeatureMetadata(body.metadata);
    }

    private assertPlanFeatureMetadata(metadata: Prisma.InputJsonValue | null | undefined): void {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
        if (!Object.prototype.hasOwnProperty.call(metadata, 'features')) return;

        const features = (metadata as Record<string, unknown>).features;
        if (!Array.isArray(features)) {
            throw new BadRequestException('Plan metadata features must be an array of known feature keys.');
        }
        const allowed = new Set<string>(FEATURE_KEYS);
        if (features.some((feature) => typeof feature !== 'string' || !allowed.has(feature))) {
            throw new BadRequestException(
                `Plan metadata features may only contain: ${FEATURE_KEYS.join(', ')}.`,
            );
        }
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
        const normalized = normalizePlanCode(code);
        return isTenantPlanCode(normalized) ? [...DEFAULT_PLAN_FEATURES[normalized]] : [];
    }

    private stringifyError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return 'Unknown error';
    }
}
