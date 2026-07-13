import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdminController } from './admin.controller';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TenantPrismaService } from '../database/tenant-prisma.service';

const superAdminReq = {
    ip: '203.0.113.25',
    headers: { 'user-agent': 'vitest-platform-admin' },
    user: {
        tenantId: 'platform-tenant',
        role: 'SUPER_ADMIN',
        permissions: ['admin_portal:access'],
        sub: 'admin-1',
    },
};
const tenantAdminReq = {
    ip: '203.0.113.10',
    headers: { 'user-agent': 'vitest' },
    user: {
        tenantId: 'tenant-1',
        role: 'ADMIN',
        permissions: ['settings:write', 'account:data_export', 'tenant_account:lifecycle'],
        sub: 'user-admin-1',
    },
};
function addTransactionMock<T extends Record<string, any>>(prisma: T): T {
    (prisma as any).$queryRaw = vi.fn().mockImplementation(async (query: unknown) => (
        String(query).includes('pg_try_advisory_xact_lock')
            ? [{ claimed: true }]
            : [{ set_current_platform_admin: null }]
    ));
    (prisma as any).$executeRaw = vi.fn().mockResolvedValue(1);
    (prisma as any).$transaction = vi.fn(async (operation: (tx: T) => Promise<unknown>) => operation(prisma));
    return prisma;
}

function buildController(
    prisma: any,
    meteringService: any,
    stripeBilling?: any,
    rbacService?: any,
    config: Record<string, string> = {},
) {
    return new AdminController(
        { get: vi.fn((key: string) => config[key]) } as any,
        { solverQueueDepth: { get: vi.fn().mockResolvedValue({ values: [] }) } } as any,
        meteringService,
        new TenantPrismaService(prisma),
        stripeBilling,
        rbacService,
    );
}

describe('AdminController route metadata', () => {
    it('requires platform admin access at the controller boundary', () => {
        expect(Reflect.getMetadata('permission', AdminController)).toBe('admin_portal:access');
    });

    it('lets tenant admins reach self-service account lifecycle routes with scoped permissions', () => {
        expect(Reflect.getMetadata('permission', AdminController.prototype.exportOwnTenant)).toBe('account:data_export');
        expect(Reflect.getMetadata('permission', AdminController.prototype.listOwnTenantExports)).toBe('account:data_export');
        expect(Reflect.getMetadata('permission', AdminController.prototype.getOwnTenantExport)).toBe('account:data_export');
        expect(Reflect.getMetadata('permission', AdminController.prototype.downloadOwnTenantExport)).toBe('account:data_export');
        expect(Reflect.getMetadata('permission', AdminController.prototype.getOwnTenantAccountStatus)).toBe('settings:write');
        expect(Reflect.getMetadata('permission', AdminController.prototype.cancelOwnTenant)).toBe('tenant_account:lifecycle');
        expect(Reflect.getMetadata('permission', AdminController.prototype.requestOwnTenantDeletion)).toBe('tenant_account:lifecycle');
    });
});

describe('AdminController tenant provisioning', () => {
    let prisma: any;
    let rbacService: { provisionLegacySystemRole: ReturnType<typeof vi.fn> };
    let controller: AdminController;

    beforeEach(() => {
        prisma = addTransactionMock({
            tenant: {
                create: vi.fn().mockResolvedValue({ id: 'tenant-new', slug: 'acme-dining' }),
            },
            user: {
                create: vi.fn().mockResolvedValue({ id: 'owner-new' }),
            },
            auditLog: {
                create: vi.fn().mockResolvedValue({}),
            },
        });
        rbacService = { provisionLegacySystemRole: vi.fn().mockResolvedValue(undefined) };
        controller = buildController(prisma, { grantCredits: vi.fn() }, undefined, rbacService);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        [{ ownerEmail: 'owner@example.com' }, 'Owner name is required'],
        [{ ownerName: 'Alex Owner' }, 'Valid owner email is required'],
        [{ ownerName: 'Alex Owner', ownerEmail: 'not-an-email' }, 'Valid owner email is required'],
        [{ ownerName: 'Alex Owner', ownerEmail: 'owner<script>@example.com' }, 'Valid owner email is required'],
    ])('requires a valid owner identity before opening a tenant transaction', async (ownerFields, message) => {
        await expect(controller.createTenant(superAdminReq, {
            name: 'Acme Dining',
            ...ownerFields,
        })).rejects.toThrow(message);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it('normalizes the owner identity and provisions tenant ownership atomically', async () => {
        await expect(controller.createTenant(superAdminReq, {
            name: 'Acme Dining',
            ownerName: '  Alex Owner  ',
            ownerEmail: '  OWNER@Example.com ',
        })).resolves.toEqual({
            id: 'tenant-new',
            ownerId: 'owner-new',
            planTier: 'FREE',
            status: 'ACTIVE',
            trialEndsAt: null,
        });

        expect(prisma.tenant.create).toHaveBeenCalledWith({
            data: {
                name: 'Acme Dining',
                slug: 'acme-dining',
                planTier: 'FREE',
                status: 'ACTIVE',
                trialEndsAt: null,
                usageCredits: 0,
            },
        });

        expect(prisma.user.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-new',
                email: 'owner@example.com',
                name: 'Alex Owner',
                role: 'ADMIN',
            },
        });
        expect(rbacService.provisionLegacySystemRole).toHaveBeenCalledWith(
            prisma,
            'owner-new',
            'tenant-new',
            'ADMIN',
        );
    });

    it('creates a paid TRIAL with the default bounded 14-day end', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));

        await expect(controller.createTenant(superAdminReq, {
            name: 'Acme Dining',
            planTier: 'STARTER',
            status: 'TRIAL',
            ownerName: 'Alex Owner',
            ownerEmail: 'owner@example.com',
        })).resolves.toMatchObject({
            planTier: 'STARTER',
            status: 'TRIAL',
            trialEndsAt: new Date('2026-07-23T12:00:00.000Z'),
        });

        expect(prisma.tenant.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                planTier: 'STARTER',
                status: 'TRIAL',
                trialEndsAt: new Date('2026-07-23T12:00:00.000Z'),
            }),
        });
    });

    it('uses the configured bounded trial window', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
        controller = buildController(
            prisma,
            { grantCredits: vi.fn() },
            undefined,
            rbacService,
            { ADMIN_TENANT_TRIAL_DAYS: '7' },
        );

        await controller.createTenant(superAdminReq, {
            name: 'Acme Dining',
            planTier: 'GROWTH',
            status: 'TRIAL',
            ownerName: 'Alex Owner',
            ownerEmail: 'owner@example.com',
        });

        expect(prisma.tenant.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                trialEndsAt: new Date('2026-07-16T12:00:00.000Z'),
            }),
        });
    });

    it('rejects paid ACTIVE creation without entitlement proof', async () => {
        await expect(controller.createTenant(superAdminReq, {
            name: 'Acme Dining',
            planTier: 'ENTERPRISE',
            status: 'ACTIVE',
            ownerName: 'Alex Owner',
            ownerEmail: 'owner@example.com',
        })).rejects.toThrow(/verified Stripe or manual entitlement proof/i);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it('rejects a requested trial end outside the configured bound', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));

        await expect(controller.createTenant(superAdminReq, {
            name: 'Acme Dining',
            planTier: 'STARTER',
            status: 'TRIAL',
            trialEndsAt: '2026-07-24T12:00:00.000Z',
            ownerName: 'Alex Owner',
            ownerEmail: 'owner@example.com',
        })).rejects.toThrow(/cannot exceed the configured 14-day trial window/i);

        expect(prisma.$transaction).not.toHaveBeenCalled();
    });
});

function buildTenantLifecyclePrisma() {
    return addTransactionMock({
        tenant: {
            findUniqueOrThrow: vi.fn(),
            update: vi.fn(),
        },
        tenantSetting: { findMany: vi.fn().mockResolvedValue([]) },
        location: { findMany: vi.fn().mockResolvedValue([]) },
        user: { findMany: vi.fn().mockResolvedValue([]) },
        staffAvailability: { findMany: vi.fn().mockResolvedValue([]) },
        staffSkill: { findMany: vi.fn().mockResolvedValue([]) },
        schedule: { findMany: vi.fn().mockResolvedValue([]) },
        scheduleDemandWindow: { findMany: vi.fn().mockResolvedValue([]) },
        shift: { findMany: vi.fn().mockResolvedValue([]) },
        break: { findMany: vi.fn().mockResolvedValue([]) },
        timeCard: { findMany: vi.fn().mockResolvedValue([]) },
        scheduleSolveJob: { findMany: vi.fn().mockResolvedValue([]) },
        billingEvent: { findMany: vi.fn().mockResolvedValue([]) },
        stripeUsageEvent: { findMany: vi.fn().mockResolvedValue([]) },
        creditTransaction: { findMany: vi.fn().mockResolvedValue([]) },
        webhookEndpoint: {
            findMany: vi.fn().mockResolvedValue([]),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        webhookDelivery: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        notification: { findMany: vi.fn().mockResolvedValue([]) },
        auditLog: {
            findFirst: vi.fn().mockResolvedValue(null),
            findMany: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue({}),
        },
        session: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
    });
}

function deleteManyMock(count = 0) {
    return vi.fn().mockResolvedValue({ count });
}

function buildRetentionPrisma() {
    return addTransactionMock({
        tenant: {
            findMany: vi.fn(),
            findUnique: vi.fn().mockResolvedValue({
                id: 'tenant-expired',
                slug: 'acme-dining',
                status: 'PURGED',
                deletedAt: new Date('2026-06-01T00:00:00.000Z'),
                applicationDataPurgedAt: null,
            }),
            update: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
        },
        session: { deleteMany: deleteManyMock(1) },
        passwordResetToken: { deleteMany: deleteManyMock(24) },
        notification: { deleteMany: deleteManyMock(2) },
        break: { deleteMany: deleteManyMock(3) },
        timeCard: { deleteMany: deleteManyMock(4) },
        scheduleSolveJob: { deleteMany: deleteManyMock(17) },
        scheduleDemandWindow: { deleteMany: deleteManyMock(19) },
        shift: { deleteMany: deleteManyMock(5) },
        staffAvailability: { deleteMany: deleteManyMock(20) },
        staffSkill: { deleteMany: deleteManyMock(21) },
        schedule: { deleteMany: deleteManyMock(6) },
        location: { deleteMany: deleteManyMock(7) },
        tenantSetting: { deleteMany: deleteManyMock(8) },
        billingEvent: { deleteMany: deleteManyMock(9) },
        stripeUsageEvent: { deleteMany: deleteManyMock(18) },
        lunchBreakGenerationRequest: { deleteMany: deleteManyMock(22) },
        webhookDelivery: { deleteMany: deleteManyMock(23) },
        webhookEndpoint: { deleteMany: deleteManyMock(10) },
        creditTransaction: { deleteMany: deleteManyMock(11) },
        auditLog: { deleteMany: deleteManyMock(12), updateMany: deleteManyMock(25) },
        roleAssignment: { deleteMany: deleteManyMock(13) },
        rolePermission: { deleteMany: deleteManyMock(14) },
        role: { deleteMany: deleteManyMock(15) },
        user: { deleteMany: deleteManyMock(16) },
    });
}

describe('AdminController tenant account lifecycle', () => {
    const billingPurge = {
        expiredCheckoutSessionIds: [],
        canceledSubscriptionIds: [],
        alreadyTerminalSubscriptionIds: [],
    };
    let controller: AdminController;
    let prisma: ReturnType<typeof buildTenantLifecyclePrisma>;
    let stripeBilling: any;

    beforeEach(() => {
        prisma = buildTenantLifecyclePrisma();
        stripeBilling = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn(),
            finalizeTenantBillingForPurge: vi.fn().mockResolvedValue(billingPurge),
        };
        controller = buildController(prisma, { grantCredits: vi.fn() } as any, stripeBilling);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts the tenant-authorized asynchronous export contract', async () => {
        const createdAt = new Date('2026-07-09T12:00:00.000Z');
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            name: 'Acme Dining',
            slug: 'acme-dining',
            planTier: 'STARTER',
            status: 'ACTIVE',
            trialEndsAt: null,
            gracePeriodEndsAt: null,
            usageCredits: 25,
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
        });
        prisma.user.findMany.mockResolvedValue([
            {
                id: 'user-1',
                name: 'Jordan Admin',
                email: 'jordan@example.com',
                username: null,
                phone: null,
                role: 'ADMIN',
                mfaEnabled: true,
                pinSetAt: null,
                pinResetRequired: false,
                lastLoginAt: createdAt,
                lockedUntil: null,
                pinLockedUntil: null,
                createdAt,
                updatedAt: createdAt,
                deletedAt: null,
                roleAssignments: [
                    {
                        role: {
                            id: 'role-admin',
                            name: 'Admin',
                            slug: 'admin',
                            legacyRole: 'ADMIN',
                            isSystem: true,
                            isDefault: true,
                            rolePermissions: [
                                { permission: { key: 'settings:write', label: 'Manage settings', category: 'SETTINGS' } },
                            ],
                        },
                    },
                ],
            },
        ]);
        prisma.staffAvailability.findMany.mockResolvedValue([
            {
                id: 'availability-1',
                userId: 'user-1',
                locationId: 'location-1',
                dayOfWeek: 1,
                startTimeMinutes: 540,
                endTimeMinutes: 1020,
                createdAt,
                updatedAt: createdAt,
            },
        ]);
        prisma.staffSkill.findMany.mockResolvedValue([
            {
                id: 'skill-1',
                userId: 'user-1',
                skill: 'prep',
                createdAt,
                updatedAt: createdAt,
            },
        ]);
        prisma.scheduleDemandWindow.findMany.mockResolvedValue([
            {
                id: 'demand-1',
                scheduleId: 'schedule-1',
                locationId: 'location-1',
                startTime: createdAt,
                endTime: createdAt,
                requiredStaff: 2,
                skill: 'prep',
                createdAt,
                updatedAt: createdAt,
            },
        ]);
        prisma.webhookEndpoint.findMany.mockResolvedValue([
            {
                id: 'webhook-1',
                url: 'https://example.test/webhook',
                events: ['schedule.published'],
                active: true,
                createdAt,
                updatedAt: createdAt,
            },
        ]);
        prisma.scheduleSolveJob.findMany.mockResolvedValue([
            {
                id: 'solve-1',
                scheduleId: 'schedule-1',
                locationId: 'location-1',
                status: 'SUCCEEDED',
                statusReason: null,
                retryCount: 0,
                resultShiftCount: 5,
                requestedConstraints: { min_floor_coverage: 2 },
                creditConsumption: null,
                startedAt: createdAt,
                completedAt: createdAt,
                createdAt,
                updatedAt: createdAt,
            },
        ]);
        prisma.stripeUsageEvent.findMany.mockResolvedValue([
            {
                id: 'usage-1',
                metric: 'ACTIVE_STAFF',
                periodStart: createdAt,
                periodEnd: createdAt,
                quantity: 7,
                eventName: 'll.active_staff',
                identifier: 'll_active_staff_20260709_abc',
                status: 'SENT',
                attempts: 1,
                sentAt: createdAt,
                stripeObjectId: 'mtr_evt_123',
                stripeRequestId: 'req_123',
                lastError: null,
                metadata: null,
                createdAt,
                updatedAt: createdAt,
            },
        ]);
        prisma.billingEvent.findMany.mockResolvedValue([
            {
                id: 'billing-1',
                type: 'invoice.paid',
                stripeEventId: 'evt_paid',
                amount: 9900,
                currency: 'usd',
                metadata: {
                    object: 'invoice',
                    id: 'in_123',
                    subscription: 'sub_123',
                    customer: 'cus_123',
                    customer_email: 'owner@example.com',
                    customer_details: {
                        email: 'owner@example.com',
                    },
                    subscription_details: {
                        metadata: { tenantId: 'tenant-1', planCode: 'STARTER' },
                    },
                    lines: {
                        data: [
                            { price: { id: 'price_123', nickname: 'Starter' } },
                        ],
                    },
                    amount_paid: 9900,
                    currency: 'usd',
                },
                createdAt,
            },
        ]);

        const start = vi.fn().mockResolvedValue({
            id: 'export-1',
            state: 'queued',
            statusPath: '/admin/account/exports/export-1',
            downloadPath: null,
        });
        (controller as any).tenantExport = { start };

        await expect(controller.exportOwnTenant(tenantAdminReq)).resolves.toMatchObject({
            id: 'export-1',
            state: 'queued',
        });
        expect(start).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            userId: 'user-admin-1',
        }));
    });

    it('recovers recent exports for the exact tenant requester', async () => {
        const listRecent = vi.fn().mockResolvedValue({
            jobs: [{ id: 'export-1', state: 'running' }],
        });
        (controller as any).tenantExport = { listRecent };

        await expect(controller.listOwnTenantExports(tenantAdminReq)).resolves.toEqual({
            jobs: [{ id: 'export-1', state: 'running' }],
        });
        expect(listRecent).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            userId: 'user-admin-1',
        }));
    });
    it('schedules cancellation without revoking the caller tenant before period end', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'ACTIVE',
            deletedAt: null,
            stripeSubscriptionId: null,
        });
        const result = await controller.cancelOwnTenant(tenantAdminReq, {
            confirmation: 'Acme-Dining',
            reason: 'closing account',
        });

        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'user-admin-1',
                action: 'TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER',
                resource: 'Tenant',
                resourceId: 'tenant-1',
                newValue: {
                    reason: 'closing account',
                    billingCancellation: {
                        action: 'none',
                        stripeSubscriptionId: null,
                        stripeStatus: null,
                        cancelAtPeriodEnd: false,
                        currentPeriodEnd: null,
                        cancelAt: null,
                        canceledAt: null,
                        cancellationBehavior: 'cancel_at_period_end',
                    },
                },
                ipAddress: '203.0.113.10',
                userAgent: 'vitest',
            },
        });
        expect(result).toEqual({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'ACTIVE',
            cancellationEffectiveAt: null,
            billingCancellation: {
                action: 'none',
                stripeSubscriptionId: null,
                stripeStatus: null,
                cancelAtPeriodEnd: false,
                currentPeriodEnd: null,
                cancelAt: null,
                canceledAt: null,
                cancellationBehavior: 'cancel_at_period_end',
            },
        });
    });

    it('requires the lifecycle permission inside cancellation handlers', async () => {
        const settingsOnlyReq = {
            ...tenantAdminReq,
            user: { ...tenantAdminReq.user, permissions: ['settings:write'] },
        };

        await expect(controller.cancelOwnTenant(settingsOnlyReq, { confirmation: 'acme-dining' }))
            .rejects.toBeInstanceOf(ForbiddenException);
        await expect(controller.requestOwnTenantDeletion(settingsOnlyReq, { confirmation: 'acme-dining' }))
            .rejects.toBeInstanceOf(ForbiddenException);
    });

    it('does not treat settings write access as tenant data export authority', async () => {
        const settingsOnlyReq = {
            ...tenantAdminReq,
            user: { ...tenantAdminReq.user, permissions: ['settings:write'] },
        };

        await expect(controller.exportOwnTenant(settingsOnlyReq))
            .rejects.toThrow(/account:data_export/);
        expect(prisma.tenant.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('reports tenant lifecycle status with retention schedule for deletion requests', async () => {
        const requestedAt = new Date('2026-07-09T12:00:00.000Z');
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'PURGED',
            deletedAt: requestedAt,
            stripeSubscriptionId: null,
        });

        const result = await controller.getOwnTenantAccountStatus(tenantAdminReq);

        expect(prisma.tenant.findUniqueOrThrow).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: { id: true, slug: true, status: true, deletedAt: true, applicationDataPurgedAt: true },
        });
        expect(result).toMatchObject({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'PURGED',
            lifecycleStatus: 'DELETION_REQUESTED',
            deletionRequestedAt: requestedAt,
            retention: {
                deletionRequestedAt: '2026-07-09T12:00:00.000Z',
                fullDatabasePurgeEligibleAt: '2033-07-09T12:00:00.000Z',
            },
            retainedRecords: ['billingEvents', 'stripeUsageEvents', 'creditTransactions', 'auditLogs', 'databaseBackups', 'securityLogs'],
        });
    });

    it('rejects destructive lifecycle operations without tenant lifecycle permission', async () => {
        await expect(
            controller.cancelOwnTenant(
                { user: { tenantId: 'tenant-1', permissions: ['settings:read'], sub: 'user-1' } },
                { confirmation: 'acme-dining' },
            ),
        ).rejects.toThrow(/tenant_account:lifecycle/);
        expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('rejects deletion when tenant deletion was already requested', async () => {
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'PURGED',
            deletedAt: new Date('2026-07-08T12:00:00.000Z'),
        });

        await expect(
            controller.requestOwnTenantDeletion(tenantAdminReq, { confirmation: 'acme-dining' }),
        ).rejects.toThrow(/already been requested/);
        expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('marks the tenant as purge requested without deleting retained records', async () => {
        const requestedAt = new Date('2026-07-09T12:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(requestedAt);
        prisma.tenant.findUniqueOrThrow
            .mockResolvedValueOnce({
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'ACTIVE',
                deletedAt: null,
                stripeSubscriptionId: null,
            })
            .mockResolvedValueOnce({
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'SUSPENDED',
                deletedAt: null,
            });
        prisma.tenant.update
            .mockResolvedValueOnce({
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'SUSPENDED',
                deletedAt: null,
            })
            .mockResolvedValueOnce({
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'PURGED',
                deletedAt: requestedAt,
            });

        const result = await controller.requestOwnTenantDeletion(tenantAdminReq, { confirmation: 'acme-dining' });

        expect(prisma.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { status: 'PURGED', deletedAt: requestedAt, stripeSubscriptionId: null },
            select: { id: true, slug: true, status: true, deletedAt: true },
        });
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { user: { tenantId: 'tenant-1' }, revokedAt: null },
            data: { revokedAt: requestedAt },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'user-admin-1',
                action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER',
                resource: 'Tenant',
                resourceId: 'tenant-1',
                newValue: {
                    retention: 'Application access disabled immediately; retained billing, audit, log, and backup records follow the retention runbook.',
                    retentionSchedule: expect.objectContaining({
                        deletionRequestedAt: '2026-07-09T12:00:00.000Z',
                        fullDatabasePurgeEligibleAt: '2033-07-09T12:00:00.000Z',
                    }),
                    retainedRecords: ['billingEvents', 'stripeUsageEvents', 'creditTransactions', 'auditLogs', 'databaseBackups', 'securityLogs'],
                    billingPurge,
                },
                ipAddress: '203.0.113.10',
                userAgent: 'vitest',
            },
        });
        expect(result).toMatchObject({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'PURGED',
            deletionRequestedAt: requestedAt,
            retention: {
                deletionRequestedAt: '2026-07-09T12:00:00.000Z',
                fullDatabasePurgeEligibleAt: '2033-07-09T12:00:00.000Z',
            },
            retainedRecords: ['billingEvents', 'stripeUsageEvents', 'creditTransactions', 'auditLogs', 'databaseBackups', 'securityLogs'],
        });
    });

    it('starts the retention clock at deletion request time for previously cancelled tenants', async () => {
        const cancelledAt = new Date('2026-01-09T12:00:00.000Z');
        const requestedAt = new Date('2026-07-09T12:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(requestedAt);
        prisma.tenant.findUniqueOrThrow
            .mockResolvedValueOnce({
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'CANCELLED',
                deletedAt: cancelledAt,
                stripeSubscriptionId: null,
            })
            .mockResolvedValueOnce({
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'SUSPENDED',
                deletedAt: null,
            });
        prisma.tenant.update
            .mockResolvedValueOnce({
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'SUSPENDED',
                deletedAt: null,
            })
            .mockResolvedValueOnce({
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'PURGED',
                deletedAt: requestedAt,
            });

        const result = await controller.requestOwnTenantDeletion(tenantAdminReq, { confirmation: 'acme-dining' });

        expect(prisma.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { status: 'PURGED', deletedAt: requestedAt, stripeSubscriptionId: null },
            select: { id: true, slug: true, status: true, deletedAt: true },
        });
        expect(result.deletionRequestedAt).toEqual(requestedAt);
        expect(result.retention.deletionRequestedAt).toBe('2026-07-09T12:00:00.000Z');
    });
});

describe('AdminController platform billing lifecycle', () => {
    function buildPlatformPrisma(tenant: any) {
        return addTransactionMock({
            tenant: {
                findUnique: vi.fn().mockResolvedValue(tenant),
                update: vi.fn().mockResolvedValue({}),
            },
            session: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        });
    }

    it('schedules paid subscription cancellation before archiving a tenant', async () => {
        const prisma = buildPlatformPrisma({
            id: 'tenant-1',
            planTier: 'STARTER',
            stripeSubscriptionId: 'sub_123',
        });
        const stripeBilling = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn().mockResolvedValue({ action: 'scheduled' }),
            assertTenantSubscriptionActive: vi.fn(),
        };
        const controller = buildController(prisma, { grantCredits: vi.fn() }, stripeBilling);

        await controller.archiveTenant(superAdminReq, 'tenant-1');

        expect(stripeBilling.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledWith('tenant-1', 'sub_123');
        expect(stripeBilling.cancelTenantSubscriptionAtPeriodEnd.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.tenant.update.mock.invocationCallOrder[0]);
    });

    it('does not restore a paid tenant when Stripe says the subscription is inactive', async () => {
        const prisma = buildPlatformPrisma({
            id: 'tenant-1',
            planTier: 'STARTER',
            stripeSubscriptionId: 'sub_123',
        });
        const stripeBilling = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn(),
            assertTenantSubscriptionActive: vi.fn().mockRejectedValue(new BadRequestException('inactive')),
        };
        const controller = buildController(prisma, { grantCredits: vi.fn() }, stripeBilling);

        await expect(controller.restoreTenant(superAdminReq, 'tenant-1'))
            .rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('does not activate a paid tenant when Stripe says the subscription is ineligible', async () => {
        const prisma = buildPlatformPrisma({
            id: 'tenant-1',
            planTier: 'STARTER',
            stripeSubscriptionId: 'sub_123',
        });
        const stripeBilling = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn(),
            assertTenantSubscriptionActive: vi.fn().mockRejectedValue(new BadRequestException('scheduled cancellation')),
        };
        const controller = buildController(prisma, { grantCredits: vi.fn() }, stripeBilling);

        await expect(controller.activateTenant(superAdminReq, 'tenant-1'))
            .rejects.toBeInstanceOf(BadRequestException);

        expect(stripeBilling.assertTenantSubscriptionActive).toHaveBeenCalledWith('tenant-1', 'sub_123');
        expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('requires a Stripe subscription before platform activation of a paid tenant', async () => {
        const prisma = buildPlatformPrisma({
            id: 'tenant-1',
            planTier: 'GROWTH',
            stripeSubscriptionId: null,
        });
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await expect(controller.activateTenant(superAdminReq, 'tenant-1'))
            .rejects.toBeInstanceOf(BadRequestException);

        expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('allows platform activation of an explicitly free tenant without Stripe', async () => {
        const prisma = buildPlatformPrisma({
            id: 'tenant-1',
            planTier: 'FREE',
            stripeSubscriptionId: null,
        });
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await expect(controller.activateTenant(superAdminReq, 'tenant-1'))
            .resolves.toEqual({ id: 'tenant-1', status: 'ACTIVE' });

        expect(prisma.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { status: 'ACTIVE', deletedAt: null },
        });
    });

    it('allows an explicitly free tenant to be restored without Stripe', async () => {
        const prisma = buildPlatformPrisma({
            id: 'tenant-1',
            planTier: 'FREE',
            stripeSubscriptionId: null,
        });
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await expect(controller.restoreTenant(superAdminReq, 'tenant-1'))
            .resolves.toEqual({ id: 'tenant-1', restored: true });

        expect(prisma.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { deletedAt: null, status: 'ACTIVE' },
        });
    });
});

describe('AdminController retained-record expiry', () => {
    let controller: AdminController;
    let prisma: ReturnType<typeof buildRetentionPrisma>;

    beforeEach(() => {
        prisma = buildRetentionPrisma();
        controller = buildController(prisma, { grantCredits: vi.fn() } as any);
        vi.spyOn((controller as any).tenantAccountLifecycle, 'listPendingDeletionBillingCandidates').mockResolvedValue([]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('dry-runs expired retained-record candidates by default', async () => {
        const deletionRequestedAt = new Date('2026-07-09T00:00:00.000Z');
        const asOf = '2033-07-10T00:00:00.000Z';
        prisma.tenant.findMany.mockResolvedValue([
            {
                id: 'tenant-expired',
                slug: 'acme-dining',
                status: 'PURGED',
                deletedAt: deletionRequestedAt,
            },
        ]);

        const result = await controller.purgeExpiredRetentionRecords(superAdminReq, { asOf });

        expect(prisma.tenant.findMany).toHaveBeenCalledWith({
            where: {
                status: 'PURGED',
                deletedAt: { lte: new Date('2026-07-10T00:00:00.000Z') },
            },
            orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
            take: 25,
            select: { id: true, slug: true, status: true, deletedAt: true, applicationDataPurgedAt: true },
        });
        expect(result.dryRun).toBe(true);
        expect(result.purgedTenants).toEqual([]);
        expect(result.candidates[0]).toMatchObject({
            id: 'tenant-expired',
            slug: 'acme-dining',
            eligibleForDatabasePurge: true,
            retention: {
                deletionRequestedAt: '2026-07-09T00:00:00.000Z',
                fullDatabasePurgeEligibleAt: '2033-07-09T00:00:00.000Z',
            },
        });
        expect(prisma.tenant.delete).not.toHaveBeenCalled();
        expect(prisma.timeCard.deleteMany).not.toHaveBeenCalled();
    });

    it('uses stable keyset continuation so old failures cannot pin newer due tenants', async () => {
        const cursorDeletedAt = new Date('2026-01-01T00:00:00.000Z');
        prisma.tenant.findMany.mockResolvedValue([{
            id: 'tenant-newer',
            slug: 'newer',
            status: 'PURGED',
            deletedAt: new Date('2026-02-01T00:00:00.000Z'),
            applicationDataPurgedAt: null,
        }]);

        const result = await controller.purgeExpiredRetentionRecords(superAdminReq, {
            asOf: '2026-08-01T00:00:00.000Z',
            stage: 'application_data',
            limit: 1,
            continuation: { deletedAt: cursorDeletedAt.toISOString(), id: 'tenant-old' },
        });

        expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                AND: [
                    expect.objectContaining({ status: 'PURGED', applicationDataPurgedAt: null }),
                    {
                        OR: [
                            { deletedAt: { gt: cursorDeletedAt } },
                            { deletedAt: cursorDeletedAt, id: { gt: 'tenant-old' } },
                        ],
                    },
                ],
            },
            orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
            take: 1,
        }));
        expect(result.nextContinuation).toEqual({
            deletedAt: '2026-02-01T00:00:00.000Z',
            id: 'tenant-newer',
        });
    });

    it('forces retention service dry-runs to use server time instead of caller asOf', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
        prisma.tenant.findMany.mockResolvedValue([]);
        const serviceReq = {
            user: {
                tenantId: '__platform__',
                permissions: ['admin_portal:access'],
                sub: 'service:retention-purge',
                service: 'retention-purge',
            },
        };

        const result = await controller.purgeExpiredRetentionRecords(serviceReq, {
            asOf: '2099-01-01T00:00:00.000Z',
            dryRun: true,
            stage: 'application_data',
        });

        expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                status: 'PURGED',
                deletedAt: { lte: new Date('2026-06-10T12:00:00.000Z') },
                applicationDataPurgedAt: null,
            },
        }));
        expect(result.asOf).toBe('2026-07-10T12:00:00.000Z');
        expect(result.dryRun).toBe(true);
    });

    it('rejects final retained-record execution by retention service automation', async () => {
        const serviceReq = {
            user: {
                tenantId: '__platform__',
                permissions: ['admin_portal:access'],
                sub: 'service:retention-purge',
                service: 'retention-purge',
            },
        };

        await expect(controller.purgeExpiredRetentionRecords(serviceReq, {
            asOf: '2099-01-01T00:00:00.000Z',
            dryRun: false,
            executeConfirmation: 'purge-expired-retained-records',
        })).rejects.toThrow(/restricted to the application_data stage/i);

        expect(prisma.tenant.findMany).not.toHaveBeenCalled();
        expect(prisma.tenant.delete).not.toHaveBeenCalled();
    });

    it('lets the retention service execute only the confirmed 30-day application-data stage', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-10T12:00:00.000Z'));
        const deletionRequestedAt = new Date('2026-06-01T00:00:00.000Z');
        prisma.tenant.findMany.mockResolvedValue([{
            id: 'tenant-expired',
            slug: 'acme-dining',
            status: 'PURGED',
            deletedAt: deletionRequestedAt,
            applicationDataPurgedAt: null,
        }]);
        const serviceReq = {
            user: {
                tenantId: '__platform__',
                permissions: ['admin_portal:access'],
                sub: 'service:retention-purge',
                service: 'retention-purge',
            },
        };

        const result = await controller.purgeExpiredRetentionRecords(serviceReq, {
            dryRun: false,
            stage: 'application_data',
            executeConfirmation: 'purge-expired-application-data',
        });

        expect(prisma.auditLog.updateMany).toHaveBeenCalledWith({
            where: { user: { is: { tenantId: 'tenant-expired' } } },
            data: { userId: null },
        });
        expect(prisma.user.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-expired' } });
        expect(prisma.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-expired' },
            data: {
                name: 'Deleted tenant tenant-expired',
                slug: 'deleted-tenant-expired',
                applicationDataPurgedAt: new Date('2026-07-10T12:00:00.000Z'),
            },
        });
        expect(prisma.billingEvent.deleteMany).not.toHaveBeenCalled();
        expect(prisma.stripeUsageEvent.deleteMany).not.toHaveBeenCalled();
        expect(prisma.creditTransaction.deleteMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
        expect(prisma.tenant.delete).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            stage: 'application_data',
            applicationDataPurgedTenants: [{
                id: 'tenant-expired',
                applicationDataPurgedAt: '2026-07-10T12:00:00.000Z',
            }],
            purgedTenants: [],
        });
    });

    it('reconciles pending deletion billing and folds failures into scheduler accounting', async () => {
        const deletionRequestedAt = new Date('2026-07-08T12:00:00.000Z');
        prisma.tenant.findMany.mockResolvedValue([]);
        const lifecycle = (controller as any).tenantAccountLifecycle;
        lifecycle.listPendingDeletionBillingCandidates.mockResolvedValue([
            { id: 'tenant-recovered', deletionRequestedAt },
            { id: 'tenant-stripe-failed', deletionRequestedAt },
        ]);
        lifecycle.reconcilePendingDeletionBillingCandidate = vi.fn(async (tenantId: string) => (
            tenantId === 'tenant-recovered'
                ? {
                    outcome: 'processed',
                    tenantId,
                    result: { id: tenantId, status: 'PURGED', deletionRequestedAt },
                }
                : { outcome: 'failed', tenantId, error: 'Stripe unavailable' }
        ));

        const result = await controller.purgeExpiredRetentionRecords(superAdminReq, {
            asOf: '2026-07-10T12:00:00.000Z',
            dryRun: false,
            stage: 'application_data',
            executeConfirmation: 'purge-expired-application-data',
        });

        expect(lifecycle.reconcilePendingDeletionBillingCandidate).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            processedTenantCount: 1,
            failedTenantCount: 1,
            skippedTenantCount: 0,
            failedTenants: [{ id: 'tenant-stripe-failed', error: 'Stripe unavailable' }],
            reconciledDeletionTenants: [{
                id: 'tenant-recovered',
                status: 'PURGED',
                deletionRequestedAt,
            }],
            pendingDeletionBillingCandidates: [
                { id: 'tenant-recovered', deletionRequestedAt: deletionRequestedAt.toISOString() },
                { id: 'tenant-stripe-failed', deletionRequestedAt: deletionRequestedAt.toISOString() },
            ],
        });
    });

    it('reports pending deletion billing in dry-run without calling Stripe reconciliation', async () => {
        const deletionRequestedAt = new Date('2026-07-08T12:00:00.000Z');
        prisma.tenant.findMany.mockResolvedValue([]);
        const lifecycle = (controller as any).tenantAccountLifecycle;
        lifecycle.listPendingDeletionBillingCandidates.mockResolvedValue([
            { id: 'tenant-pending', deletionRequestedAt },
        ]);
        lifecycle.reconcilePendingDeletionBillingCandidate = vi.fn();

        const result = await controller.purgeExpiredRetentionRecords(superAdminReq, {
            asOf: '2026-07-10T12:00:00.000Z',
            dryRun: true,
            stage: 'application_data',
        });

        expect(lifecycle.reconcilePendingDeletionBillingCandidate).not.toHaveBeenCalled();
        expect(result.pendingDeletionBillingCandidates).toEqual([
            { id: 'tenant-pending', deletionRequestedAt: deletionRequestedAt.toISOString() },
        ]);
        expect(result.processedTenantCount).toBe(0);
    });
    it('executes the expired retained-record purge in dependency order', async () => {
        prisma.tenant.findMany.mockResolvedValue([
            {
                id: 'tenant-expired',
                slug: 'acme-dining',
                status: 'PURGED',
                deletedAt: new Date('2026-07-09T00:00:00.000Z'),
            },
        ]);

        const result = await controller.purgeExpiredRetentionRecords(superAdminReq, {
            asOf: '2033-07-10T00:00:00.000Z',
            dryRun: false,
            executeConfirmation: 'purge-expired-retained-records',
            limit: 1,
        });

        expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
        expect(prisma.timeCard.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-expired' } });
        expect(prisma.scheduleSolveJob.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-expired' } });
        expect(prisma.scheduleDemandWindow.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-expired' } });
        expect(prisma.staffAvailability.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-expired' } });
        expect(prisma.staffSkill.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-expired' } });
        expect(prisma.stripeUsageEvent.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-expired' } });
        expect(prisma.roleAssignment.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-expired' },
        });
        expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: 'tenant-expired' } });
        expect(prisma.timeCard.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.scheduleSolveJob.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.scheduleSolveJob.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.shift.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.scheduleDemandWindow.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.schedule.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.scheduleDemandWindow.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.location.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.staffAvailability.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.user.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.staffAvailability.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.location.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.staffSkill.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.user.deleteMany.mock.invocationCallOrder[0],
        );
        expect((prisma as any).$executeRaw).toHaveBeenCalledWith(expect.arrayContaining([
            expect.stringContaining('app.allow_audit_log_delete'),
            expect.stringContaining('retention_expired'),
        ]));
        expect((prisma as any).$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.user.deleteMany.mock.invocationCallOrder[0],
        );
        expect((prisma as any).$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.auditLog.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.auditLog.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.user.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.rolePermission.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.role.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.user.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.tenant.delete.mock.invocationCallOrder[0],
        );
        expect(result.purgedTenants[0]).toMatchObject({
            id: 'tenant-expired',
            deleted: true,
            deletedRecordCounts: {
                timeCards: 4,
                scheduleSolveJobs: 17,
                scheduleDemandWindows: 19,
                staffAvailabilities: 20,
                staffSkills: 21,
                stripeUsageEvents: 18,
                auditLogs: 12,
                roles: 15,
                users: 16,
            },
        });
    });

    it('isolates 25 tenant purges so one large-tenant failure is reported without rolling back the batch', async () => {
        const candidates = Array.from({ length: 25 }, (_, index) => ({
            id: `tenant-${index}`,
            slug: `tenant-${index}`,
            status: 'PURGED',
            deletedAt: new Date('2026-01-01T00:00:00.000Z'),
            applicationDataPurgedAt: new Date('2026-02-01T00:00:00.000Z'),
        }));
        prisma.tenant.findMany.mockResolvedValue(candidates);
        prisma.tenant.findUnique.mockImplementation(async ({ where }: any) => candidates.find((tenant) => tenant.id === where.id));
        prisma.tenant.delete.mockImplementation(async ({ where }: any) => {
            if (where.id === 'tenant-12') throw new Error('simulated statement timeout');
            return {};
        });

        const result = await controller.purgeExpiredRetentionRecords(superAdminReq, {
            asOf: '2033-07-10T00:00:00.000Z',
            dryRun: false,
            executeConfirmation: 'purge-expired-retained-records',
            limit: 25,
        });

        expect(result.purgedTenants).toHaveLength(24);
        expect(result.failedTenants).toEqual([{ id: 'tenant-12', error: 'simulated statement timeout' }]);
        expect(result).toMatchObject({ processedTenantCount: 24, failedTenantCount: 1, skippedTenantCount: 0 });
        expect(prisma.tenant.delete).toHaveBeenCalledTimes(25);
        expect((prisma as any).$transaction).toHaveBeenCalledTimes(26);
        expect((prisma as any).$transaction.mock.calls.slice(1).every((call: any[]) => (
            call[1]?.maxWait === 5_000 && call[1]?.timeout === 60_000
        ))).toBe(true);
    });

    it('rejects retained-record purge execution without confirmation', async () => {
        await expect(controller.purgeExpiredRetentionRecords(superAdminReq, {
            asOf: '2033-07-10T00:00:00.000Z',
            dryRun: false,
        })).rejects.toThrow(/executeConfirmation must equal purge-expired-retained-records/);

        expect(prisma.tenant.findMany).not.toHaveBeenCalled();
        expect(prisma.tenant.delete).not.toHaveBeenCalled();
    });

    it('does not purge the caller tenant through the expiry endpoint', async () => {
        prisma.tenant.findMany.mockResolvedValue([
            {
                id: 'tenant-self',
                slug: 'platform-home',
                status: 'PURGED',
                deletedAt: new Date('2026-07-09T00:00:00.000Z'),
            },
        ]);

        const result = await controller.purgeExpiredRetentionRecords(
            {
                user: {
                    tenantId: 'tenant-self',
                    permissions: ['admin_portal:access'],
                    sub: 'admin-1',
                },
            },
            {
                asOf: '2033-07-10T00:00:00.000Z',
                dryRun: false,
                executeConfirmation: 'purge-expired-retained-records',
            },
        );

        expect(result.blockedTenants).toEqual([
            {
                id: 'tenant-self',
                reason: 'Refusing to purge the caller tenant.',
            },
        ]);
        expect(result.purgedTenants).toEqual([]);
        expect(prisma.tenant.delete).not.toHaveBeenCalled();
    });

    it('blocks platform hard delete before retained database records expire', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-pending',
            slug: 'acme-dining',
            status: 'PURGED',
            deletedAt: new Date('2026-07-09T00:00:00.000Z'),
        });

        await expect(controller.deleteTenant(superAdminReq, 'tenant-pending')).rejects.toThrow(/retained records are not expired/i);
        expect(prisma.tenant.delete).not.toHaveBeenCalled();
        expect(prisma.billingEvent.deleteMany).not.toHaveBeenCalled();
    });

    it('allows platform hard delete after retained database records expire', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2033-07-10T00:00:00.000Z'));
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-expired',
            slug: 'acme-dining',
            status: 'PURGED',
            deletedAt: new Date('2026-07-09T00:00:00.000Z'),
        });

        const result = await controller.deleteTenant(superAdminReq, 'tenant-expired');

        expect((prisma as any).$executeRaw).toHaveBeenCalledWith(expect.arrayContaining([
            expect.stringContaining('app.allow_audit_log_delete'),
            expect.stringContaining('retention_expired'),
        ]));
        expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: 'tenant-expired' } });
        expect(result).toMatchObject({
            id: 'tenant-expired',
            deleted: true,
            retention: {
                deletionRequestedAt: '2026-07-09T00:00:00.000Z',
                fullDatabasePurgeEligibleAt: '2033-07-09T00:00:00.000Z',
            },
            deletedRecordCounts: {
                billingEvents: 9,
                stripeUsageEvents: 18,
                scheduleDemandWindows: 19,
                staffAvailabilities: 20,
                staffSkills: 21,
                creditTransactions: 11,
                auditLogs: 12,
            },
        });
    });
});

describe('AdminController credits', () => {
    let controller: AdminController;
    let prisma: any;
    let meteringService: { grantCredits: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        prisma = addTransactionMock({
            tenant: {
                findMany: vi.fn(),
            },
            creditTransaction: {
                findMany: vi.fn(),
            },
        });

        meteringService = {
            grantCredits: vi.fn(),
        };

        controller = buildController(prisma, meteringService as any);
    });

    it('lists live tenant balances and credit history', async () => {
        prisma.tenant.findMany.mockResolvedValue([
            {
                id: 'tenant-1',
                name: 'Acme Dining',
                slug: 'acme-dining',
                planTier: 'STARTER',
                usageCredits: 125,
            },
        ]);
        prisma.creditTransaction.findMany.mockResolvedValue([
            {
                id: 'tx-1',
                amount: 100,
                reason: 'Seed grant',
                createdAt: new Date('2026-03-21T10:00:00.000Z'),
                tenant: {
                    id: 'tenant-1',
                    name: 'Acme Dining',
                    slug: 'acme-dining',
                },
            },
        ]);

        const result = await controller.credits(superAdminReq, '25');

        expect(prisma.tenant.findMany).toHaveBeenCalledWith({
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                name: true,
                slug: true,
                planTier: true,
                usageCredits: true,
            },
        });
        expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith({
            orderBy: { createdAt: 'desc' },
            take: 25,
            include: {
                tenant: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                    },
                },
            },
        });
        expect(result.tenants).toEqual([
            {
                id: 'tenant-1',
                name: 'Acme Dining',
                slug: 'acme-dining',
                planTier: 'STARTER',
                usageCredits: 125,
            },
        ]);
        expect(result.history).toEqual([
            {
                id: 'tx-1',
                amount: 100,
                reason: 'Seed grant',
                createdAt: new Date('2026-03-21T10:00:00.000Z'),
                tenant: {
                    id: 'tenant-1',
                    name: 'Acme Dining',
                    slug: 'acme-dining',
                },
            },
        ]);
    });

    it('grants credits through the metering service and returns the new balance', async () => {
        meteringService.grantCredits.mockResolvedValue(175);

        const result = await controller.grantCredits(
            superAdminReq,
            { tenantId: 'tenant-1', amount: 50, reason: 'Correction grant' },
            ' credit-grant-1 ',
        );

        expect(meteringService.grantCredits).toHaveBeenCalledWith('tenant-1', 50, 'Correction grant', 'credit-grant-1');
        expect(result).toEqual({
            success: true,
            newBalance: 175,
        });
    });

    it('requires an idempotency key before calling the metering service', async () => {
        await expect(controller.grantCredits(
            superAdminReq,
            { tenantId: 'tenant-1', amount: 50, reason: 'Correction grant' },
        )).rejects.toThrow('Idempotency-Key header is required');

        expect(meteringService.grantCredits).not.toHaveBeenCalled();
    });
});

describe('AdminController user limits', () => {
    let controller: AdminController;
    let prisma: any;
    let meteringService: { grantCredits: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        prisma = addTransactionMock({
            tenant: {
                findMany: vi.fn(),
                findUnique: vi.fn().mockResolvedValue({ planTier: 'FREE' }),
            },
            creditTransaction: {
                findMany: vi.fn(),
            },
            user: {
                findUnique: vi.fn(),
                count: vi.fn().mockResolvedValue(0),
                update: vi.fn(),
            },
        });

        meteringService = {
            grantCredits: vi.fn(),
        };

        controller = buildController(prisma, meteringService as any);
    });

    it('rejects reactivating a user when the tenant is already at the active user limit', async () => {
        prisma.user.findUnique.mockResolvedValue({
            tenantId: 'tenant-1',
            deletedAt: new Date('2026-03-21T10:00:00.000Z'),
        });
        prisma.user.count.mockResolvedValue(10);

        await expect(controller.activateUser(superAdminReq, 'user-1')).rejects.toThrow(/User limit reached/i);
        expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects moving an active user into a tenant that is already full', async () => {
        prisma.user.findUnique.mockResolvedValue({
            tenantId: 'tenant-source',
            deletedAt: null,
        });
        prisma.user.count.mockResolvedValue(10);

        await expect(
            controller.updateUser(
                superAdminReq,
                'user-1',
                { tenantId: 'tenant-target' },
            ),
        ).rejects.toThrow(/User limit reached/i);

        expect(prisma.user.update).not.toHaveBeenCalled();
    });
});

describe('AdminController tenant updates', () => {
    let controller: AdminController;
    let prisma: any;

    beforeEach(() => {
        prisma = addTransactionMock({
            tenant: {
                findUnique: vi.fn(),
                update: vi.fn(),
            },
            auditLog: {
                create: vi.fn(),
            },
        });

        controller = buildController(prisma, { grantCredits: vi.fn() } as any);
    });

    it('updates generic tenant profile fields', async () => {
        prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', deletedAt: null });

        const result = await controller.updateTenant(
            superAdminReq,
            'tenant-1',
            { name: 'Acme Dining', slug: 'Acme Dining West', usageCredits: 25 },
        );

        expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            select: {
                id: true,
                deletedAt: true,
            },
        });
        expect(prisma.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { name: 'Acme Dining', slug: 'acme-dining-west', usageCredits: 25 },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: null,
                actorUserId: 'admin-1',
                actorTenantId: 'platform-tenant',
                ipAddress: '203.0.113.25',
                userAgent: 'vitest-platform-admin',
                action: 'TENANT_UPDATED',
                resource: 'Tenant',
                resourceId: 'tenant-1',
            },
        });
        expect(result).toEqual({ id: 'tenant-1', updated: true });
    });

    it.each([
        ['planTier', { planTier: 'STARTER' }],
        ['status', { status: 'SUSPENDED' }],
    ])('rejects %s before opening a transaction or mutating tenant state', async (field, body) => {
        await expect(
            controller.updateTenant(superAdminReq, 'tenant-1', body as any),
        ).rejects.toThrow(new RegExp(`${field} cannot be updated through generic tenant edit`, 'i'));

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects plan and status together instead of silently ignoring either field', async () => {
        await expect(
            controller.updateTenant(superAdminReq, 'tenant-1', {
                name: 'Changed name',
                planTier: 'GROWTH',
                status: 'ACTIVE',
            } as any),
        ).rejects.toThrow(/planTier and status cannot be updated through generic tenant edit/i);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('returns Tenant not found when tenant id does not exist', async () => {
        prisma.tenant.findUnique.mockResolvedValue(null);

        await expect(
            controller.updateTenant(
                superAdminReq,
                'missing-tenant',
                { name: 'Missing tenant' },
            ),
        ).rejects.toThrow(new BadRequestException('Tenant not found'));
        expect(prisma.tenant.update).not.toHaveBeenCalled();
    });
});
describe('AdminController MFA recovery', () => {
    it('delegates target-bound recovery details after platform-admin authorization', async () => {
        const controller = buildController(addTransactionMock({} as any), {} as any);
        const reset = vi.fn().mockResolvedValue({ id: 'user-1', mfaEnabled: false, sessionsRevoked: 2 });
        (controller as any).userMfaRecovery = { reset };

        await expect(controller.resetUserMfa(superAdminReq, 'user-1', {
            confirmation: 'reset-mfa:user-1',
            reason: 'Lost all registered MFA factors',
        })).resolves.toEqual({ id: 'user-1', mfaEnabled: false, sessionsRevoked: 2 });
        expect(reset).toHaveBeenCalledWith(expect.objectContaining({
            targetUserId: 'user-1',
            actorUserId: 'admin-1',
            actorTenantId: 'platform-tenant',
            confirmation: 'reset-mfa:user-1',
        }));
    });

    it('rejects tenant administrators before recovery delegation', async () => {
        const controller = buildController(addTransactionMock({} as any), {} as any);
        const reset = vi.fn();
        (controller as any).userMfaRecovery = { reset };

        await expect(controller.resetUserMfa(tenantAdminReq, 'user-1', {
            confirmation: 'reset-mfa:user-1',
            reason: 'Lost all registered MFA factors',
        })).rejects.toBeInstanceOf(ForbiddenException);
        expect(reset).not.toHaveBeenCalled();
    });
});