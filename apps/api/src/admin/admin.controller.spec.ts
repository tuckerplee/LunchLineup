import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdminController } from './admin.controller';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { encodeBoundedListCursor } from '../common/bounded-pagination';
import { isTenantReadyForApplicationDataPurge } from './tenant-account-lifecycle';

const superAdminReq = {
    ip: '203.0.113.25',
    headers: { 'user-agent': 'vitest-platform-admin' },
    user: {
        tenantId: 'platform-tenant',
        role: 'SUPER_ADMIN',
        permissions: ['admin_portal:access'],
        sub: 'admin-1',
        sessionId: 'admin-session-1',
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
function rawQueryText(query: any): string {
    if (Array.isArray(query)) return query.join(' ');
    if (Array.isArray(query?.strings)) return query.strings.join(' ');
    return String(query);
}
function addTransactionMock<T extends Record<string, any>>(prisma: T): T {
    (prisma as any).$queryRaw = vi.fn().mockImplementation(async (query: any) => {
        const queryText = rawQueryText(query);
        if (queryText.includes('pg_try_advisory_xact_lock')) return [{ claimed: true }];
        if (queryText.includes('purge_payroll_operational_time_cards')) return [{ purgedCount: 4n }];
        if (queryText.includes('purge_expired_payroll_records')) return [{ purgedCount: 33n }];
        if (queryText.includes('purge_expired_audit_logs')) return [{ purge_expired_audit_logs: 12n }];
        if (queryText.includes('redact_retained_tenant_audit_logs')) return [{ redactedCount: 25n }];
        if (queryText.includes('COUNT(*)') && queryText.includes('"Session"')) {
            return [{ eligibleCount: 5n }];
        }
        if (queryText.includes('purge_dormant_sessions')) return [{ purgedCount: 4n }];
        if (queryText.includes('COUNT(*)') && queryText.includes('PasswordResetToken')) {
            return [{ eligibleCount: 6n }];
        }
        if (queryText.includes('purge_expired_password_reset_tokens')) return [{ purgedCount: 5n }];
        if (queryText.includes('COUNT(*)') && queryText.includes('"PasswordResetToken"')) {
            return [{ eligibleCount: 6n }];
        }
        if (queryText.includes('purge_expired_password_reset_tokens')) return [{ purgedCount: 4n }];
        if (queryText.includes('COUNT(*)') && queryText.includes('OnboardingSignupAttempt')) {
            return [{ eligibleCount: 3n }];
        }
        if (queryText.includes('purge_expired_onboarding_signup_attempts')) return [{ purgedCount: 2n }];
        if (queryText.includes('COUNT(*)') && queryText.includes('StaffInvitationOutbox')) {
            return [{ eligibleCount: 7n }];
        }
        if (queryText.includes('purge_staff_invitation_outbox_diagnostics')) {
            return [{ purgedCount: 6n }];
        }
        return [{ set_current_platform_admin: null }];
    });
    (prisma as any).$executeRaw = vi.fn().mockResolvedValue(1);
    (prisma as any).$transaction = vi.fn(async (operation: (tx: T) => Promise<unknown>) => operation(prisma));
    return prisma;
}

beforeEach(() => {
    vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'unit-test-platform-admin-capability');
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

function buildController(
    prisma: any,
    meteringService: any,
    stripeBilling?: any,
    rbacService?: any,
    config: Record<string, string> = {},
    tenantAccountLifecycle?: any,
) {
    const controller = new AdminController(
        { get: vi.fn((key: string) => config[key]) } as any,
        {} as any,
        meteringService,
        new TenantPrismaService(prisma),
        stripeBilling,
        rbacService,
    );
    if (tenantAccountLifecycle) {
        (controller as any).tenantAccountLifecycle = tenantAccountLifecycle;
    }
    return controller;
}

describe('AdminController route metadata', () => {
    it('stops its manually-owned tenant export worker during Nest shutdown', () => {
        const controller = buildController(addTransactionMock({}), {});
        const stop = vi.spyOn((controller as any).tenantExport, 'onModuleDestroy');

        controller.onModuleDestroy();

        expect(stop).toHaveBeenCalledOnce();
    });

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

describe('AdminController solver queue telemetry', () => {
    function metricsText(
        available: number,
        ready = 0,
        retry = 0,
        deadLetter = 0,
    ): string {
        return [
            `lunchlineup_solver_queue_telemetry_available ${available}`,
            `lunchlineup_solver_queue_messages{state="ready"} ${ready}`,
            `lunchlineup_solver_queue_messages{state="retry"} ${retry}`,
            `lunchlineup_solver_queue_messages{state="dead_letter"} ${deadLetter}`,
            '',
        ].join('\n');
    }

    function buildStatsController() {
        return buildController(addTransactionMock({
            tenant: { count: vi.fn().mockResolvedValue(2) },
            user: { count: vi.fn().mockResolvedValue(5) },
            session: { count: vi.fn().mockResolvedValue(3) },
        }), {});
    }

    it('returns broker-backed ready, retry, DLQ, and nonzero pending counts', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue(metricsText(1, 2, 3, 1)),
        }));
        const controller = buildStatsController();

        const result = await controller.stats(superAdminReq);

        expect(result).toMatchObject({
            totalTenants: 2,
            totalUsers: 5,
            activeSessions: 3,
            solverQueue: 5,
            solverQueueReady: 2,
            solverQueueRetry: 3,
            solverQueueDeadLetter: 1,
        });
    });

    it('returns truthful null queue fields when the worker marks telemetry unavailable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue(metricsText(0, 0, 0, 0)),
        }));
        const controller = buildStatsController();

        const result = await controller.stats(superAdminReq);

        expect(result).toMatchObject({
            solverQueue: null,
            solverQueueReady: null,
            solverQueueRetry: null,
            solverQueueDeadLetter: null,
        });
    });

    it('reuses worker telemetry for health and degrades on one durable poison item', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue(metricsText(1, 0, 0, 1)),
        }));
        const controller = buildStatsController();

        const result = await controller.health(superAdminReq);
        const queue = result.components.find((component) => component.label === 'Solver Queue');

        expect(queue).toMatchObject({
            status: 'degraded',
            latencyMs: null,
            details: '0 pending jobs (0 ready, 0 retry, 1 dead-letter)',
        });
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

    it('rejects tenant provisioning credits before opening a transaction', async () => {
        await expect(controller.createTenant(superAdminReq, {
            name: 'Acme Dining',
            usageCredits: 25,
            ownerName: 'Alex Owner',
            ownerEmail: 'owner@example.com',
        })).rejects.toThrow(/start with zero credits/i);

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.tenant.create).not.toHaveBeenCalled();
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
            findUnique: vi.fn(),
            findUniqueOrThrow: vi.fn(),
            update: vi.fn(),
        },
        tenantSetting: {
            findMany: vi.fn().mockResolvedValue([]),
            findUnique: vi.fn().mockResolvedValue(null),
        },
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
        billingEvent: {
            findMany: vi.fn().mockResolvedValue([]),
            deleteMany: vi.fn(),
        },
        stripeUsageEvent: {
            findMany: vi.fn().mockResolvedValue([]),
            deleteMany: vi.fn(),
        },
        creditTransaction: {
            findMany: vi.fn().mockResolvedValue([]),
            deleteMany: vi.fn(),
        },
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
            deleteMany: vi.fn(),
        },
        session: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
    });
}

function mockDeletionReconciliationClaim(prisma: ReturnType<typeof buildTenantLifecyclePrisma>) {
    const queryRaw = (prisma as any).$queryRaw;
    const fallback = queryRaw.getMockImplementation();
    queryRaw.mockImplementation(async (query: any) => {
        const queryText = rawQueryText(query);
        if (queryText.includes('RETURNING reconciliation."operationId"')) {
            const barrierCall = prisma.auditLog.create.mock.calls.find(
                ([input]: any[]) => input.data.action === 'TENANT_DELETION_BARRIER_COMMITTED',
            );
            const barrierAuditId = barrierCall?.[0]?.data?.id;
            return barrierAuditId ? [{ operationId: `tenant-deletion-${barrierAuditId}` }] : [];
        }
        if (queryText.includes('refund_candidates AS MATERIALIZED')) {
            return [{
                candidateCount: 0,
                settledCount: 0,
                replayedCount: 0,
                lockedWebhookCount: 0,
                refundableWebhookCount: 0,
                terminalizedWebhookCount: 0,
            }];
        }
        return fallback(query);
    });
}

function mockPendingDeletionBarrierRead(
    prisma: ReturnType<typeof buildTenantLifecyclePrisma>,
    requestedAt: Date,
) {
    const barrier = prisma.auditLog.create.mock.calls.find(
        ([input]: any[]) => input.data.action === 'TENANT_DELETION_BARRIER_COMMITTED',
    )?.[0].data;
    if (!barrier?.id) throw new Error('Expected the phase-one deletion barrier audit.');
    prisma.tenant.findUnique.mockResolvedValue({
        id: 'tenant-1',
        slug: 'acme-dining',
        status: 'SUSPENDED',
        deletedAt: null,
        auditLogs: [{
            id: barrier.id,
            userId: barrier.userId,
            actorUserId: barrier.actorUserId,
            actorTenantId: barrier.actorTenantId,
            ipAddress: barrier.ipAddress,
            userAgent: barrier.userAgent,
            createdAt: requestedAt,
        }],
    });
    return `tenant-deletion-${barrier.id}`;
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
        onboardingSignupAttempt: { deleteMany: deleteManyMock(26) },
        tenantExportJob: { deleteMany: deleteManyMock(27) },
        availabilityImportJob: { deleteMany: deleteManyMock(28) },
        notificationOutbox: { deleteMany: deleteManyMock(29) },
        staffInvitationOutbox: { deleteMany: deleteManyMock(32) },
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
        billingEvent: {
            deleteMany: deleteManyMock(9),
            updateMany: vi.fn().mockResolvedValue({ count: 30 }),
        },
        stripeUsageEvent: {
            deleteMany: deleteManyMock(18),
            updateMany: vi.fn().mockResolvedValue({ count: 31 }),
        },
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
    it('streams exports with private no-store headers and requester attribution', async () => {
        const pipe = vi.fn();
        const openDownload = vi.fn().mockResolvedValue({
            filename: 'acme-account-export-2026-07-14.ndjson',
            bytes: 42,
            stream: { pipe },
        });
        (controller as any).tenantExport = { openDownload };
        const response = { setHeader: vi.fn() };

        await controller.downloadOwnTenantExport(tenantAdminReq, 'export-1', response);

        expect(openDownload).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1',
            userId: 'user-admin-1',
            ipAddress: '203.0.113.10',
            userAgent: 'vitest',
        }), 'export-1');
        expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
        expect(response.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
        expect(response.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
        expect(response.setHeader).toHaveBeenCalledWith(
            'Content-Disposition',
            'attachment; filename="acme-account-export-2026-07-14.ndjson"',
        );
        expect(pipe).toHaveBeenCalledWith(response);
    });

    it('schedules cancellation without revoking the caller tenant before period end', async () => {
        const lifecycleResult = {
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'ACTIVE',
            cancellationEffectiveAt: null,
            billingCancellation: {
                action: 'none',
                cancelAtPeriodEnd: false,
                currentPeriodEnd: null,
                cancelAt: null,
                canceledAt: null,
                cancellationBehavior: 'cancel_at_period_end',
            },
        };
        const cancelTenant = vi.spyOn(
            (controller as any).tenantAccountLifecycle,
            'cancelTenant',
        ).mockResolvedValue(lifecycleResult);
        const result = await controller.cancelOwnTenant(tenantAdminReq, {
            confirmation: 'Acme-Dining',
            reason: 'closing account',
        });

        expect(cancelTenant).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: 'tenant-1',
                userId: 'user-admin-1',
            }),
            { confirmation: 'Acme-Dining', reason: 'closing account' },
        );
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(result).toEqual(lifecycleResult);
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
            select: {
                id: true,
                slug: true,
                status: true,
                deletedAt: true,
                applicationDataPurgedAt: true,
                retentionLegalHoldAt: true,
            },
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
            retainedRecords: ['billingEvents', 'stripeUsageEvents', 'creditTransactions', 'payrollRecords', 'auditLogs', 'databaseBackups', 'securityLogs'],
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

    it('returns the existing deletion receipt idempotently when deletion was already finalized', async () => {
        const requestedAt = new Date('2026-07-08T12:00:00.000Z');
        prisma.tenant.findUniqueOrThrow.mockResolvedValue({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'PURGED',
            deletedAt: requestedAt,
        });

        const result = await controller.requestOwnTenantDeletion(
            tenantAdminReq,
            { confirmation: 'acme-dining' },
        );

        expect(result).toMatchObject({
            status: 'PURGED',
            deletionState: 'FINALIZED',
            billingCleanupPending: false,
            deletionRequestedAt: requestedAt,
        });
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(stripeBilling.finalizeTenantBillingForPurge).not.toHaveBeenCalled();
    });
    it('marks the tenant as purge requested without deleting retained records', async () => {
        const requestedAt = new Date('2026-07-09T12:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(requestedAt);
        mockDeletionReconciliationClaim(prisma);
        stripeBilling.finalizeTenantBillingForPurge
            .mockRejectedValueOnce(new Error('temporary Stripe outage'))
            .mockResolvedValueOnce(billingPurge);
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

        const phaseOneReceipt = await controller.requestOwnTenantDeletion(
            tenantAdminReq,
            { confirmation: 'acme-dining' },
        );

        expect(prisma.tenant.update).toHaveBeenNthCalledWith(1, {
            where: { id: 'tenant-1' },
            data: { status: 'SUSPENDED', deletedAt: null },
            select: { id: true, slug: true, status: true, deletedAt: true },
        });
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { user: { tenantId: 'tenant-1' }, revokedAt: null },
            data: { revokedAt: requestedAt },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
        expect(prisma.auditLog.create).toHaveBeenNthCalledWith(1, {
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                userId: 'user-admin-1',
                actorUserId: 'user-admin-1',
                actorTenantId: 'tenant-1',
                action: 'TENANT_DELETION_BARRIER_COMMITTED',
                resource: 'Tenant',
                resourceId: 'tenant-1',
                createdAt: requestedAt,
            }),
        });
        expect(phaseOneReceipt).toMatchObject({
            id: 'tenant-1',
            slug: 'acme-dining',
            status: 'SUSPENDED',
            deletionState: 'PENDING_BILLING_CLEANUP',
            billingCleanupPending: true,
            deletionRequestedAt: requestedAt,
            retention: {
                deletionRequestedAt: '2026-07-09T12:00:00.000Z',
                fullDatabasePurgeEligibleAt: '2033-07-09T12:00:00.000Z',
            },
            retainedRecords: ['billingEvents', 'stripeUsageEvents', 'creditTransactions', 'payrollRecords', 'auditLogs', 'databaseBackups', 'securityLogs'],
        });
        expect(prisma.billingEvent.deleteMany).not.toHaveBeenCalled();
        expect(prisma.stripeUsageEvent.deleteMany).not.toHaveBeenCalled();
        expect(prisma.creditTransaction.deleteMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();

        const operationId = mockPendingDeletionBarrierRead(prisma, requestedAt);
        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenNthCalledWith(1, 'tenant-1', {
            operationId,
            providerDeadlineAtMs: expect.any(Number),
            signal: expect.any(AbortSignal),
        });

        const reconciliation = await (controller as any).tenantAccountLifecycle
            .reconcilePendingDeletionBillingCandidate('tenant-1');

        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenNthCalledWith(2, 'tenant-1', {
            operationId,
            providerDeadlineAtMs: expect.any(Number),
            signal: expect.any(AbortSignal),
        });
        expect(prisma.tenant.update).toHaveBeenNthCalledWith(2, {
            where: { id: 'tenant-1' },
            data: { status: 'PURGED', deletedAt: requestedAt, stripeSubscriptionId: null },
            select: { id: true, slug: true, status: true, deletedAt: true },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
        expect(prisma.auditLog.create).toHaveBeenNthCalledWith(2, {
            data: {
                tenantId: 'tenant-1',
                userId: 'user-admin-1',
                actorUserId: 'user-admin-1',
                actorTenantId: 'tenant-1',
                action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER',
                resource: 'Tenant',
                resourceId: 'tenant-1',
                newValue: {
                    retention: 'Application access disabled immediately; retained billing, audit, log, and backup records follow the retention runbook.',
                    retentionSchedule: expect.objectContaining({
                        deletionRequestedAt: '2026-07-09T12:00:00.000Z',
                        fullDatabasePurgeEligibleAt: '2033-07-09T12:00:00.000Z',
                    }),
                    retainedRecords: ['billingEvents', 'stripeUsageEvents', 'creditTransactions', 'payrollRecords', 'auditLogs', 'databaseBackups', 'securityLogs'],
                    billingPurge,
                },
                ipAddress: '203.0.113.10',
                userAgent: 'vitest',
            },
        });
        expect(reconciliation).toMatchObject({
            outcome: 'processed',
            tenantId: 'tenant-1',
            result: {
                status: 'PURGED',
                deletionState: 'FINALIZED',
                billingCleanupPending: false,
                deletionRequestedAt: requestedAt,
            },
        });
    });

    it('starts the retention clock at deletion request time for previously cancelled tenants', async () => {
        const cancelledAt = new Date('2026-01-09T12:00:00.000Z');
        const requestedAt = new Date('2026-07-09T12:00:00.000Z');
        vi.useFakeTimers();
        vi.setSystemTime(requestedAt);
        mockDeletionReconciliationClaim(prisma);
        stripeBilling.finalizeTenantBillingForPurge
            .mockRejectedValueOnce(new Error('temporary Stripe outage'))
            .mockResolvedValueOnce(billingPurge);
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

        const phaseOneReceipt = await controller.requestOwnTenantDeletion(
            tenantAdminReq,
            { confirmation: 'acme-dining' },
        );

        expect(prisma.tenant.update).toHaveBeenNthCalledWith(1, {
            where: { id: 'tenant-1' },
            data: { status: 'SUSPENDED', deletedAt: null },
            select: { id: true, slug: true, status: true, deletedAt: true },
        });
        expect(phaseOneReceipt).toMatchObject({
            status: 'SUSPENDED',
            deletionState: 'PENDING_BILLING_CLEANUP',
            billingCleanupPending: true,
            deletionRequestedAt: requestedAt,
            retention: {
                deletionRequestedAt: '2026-07-09T12:00:00.000Z',
                fullDatabasePurgeEligibleAt: '2033-07-09T12:00:00.000Z',
            },
        });
        expect(phaseOneReceipt.deletionRequestedAt).not.toEqual(cancelledAt);

        const operationId = mockPendingDeletionBarrierRead(prisma, requestedAt);
        const reconciliation = await (controller as any).tenantAccountLifecycle
            .reconcilePendingDeletionBillingCandidate('tenant-1');

        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenCalledTimes(2);
        expect(stripeBilling.finalizeTenantBillingForPurge).toHaveBeenLastCalledWith('tenant-1', {
            operationId,
            providerDeadlineAtMs: expect.any(Number),
            signal: expect.any(AbortSignal),
        });
        expect(prisma.tenant.update).toHaveBeenNthCalledWith(2, {
            where: { id: 'tenant-1' },
            data: { status: 'PURGED', deletedAt: requestedAt, stripeSubscriptionId: null },
            select: { id: true, slug: true, status: true, deletedAt: true },
        });
        expect(reconciliation).toMatchObject({
            outcome: 'processed',
            result: {
                status: 'PURGED',
                deletionState: 'FINALIZED',
                deletionRequestedAt: requestedAt,
                retention: {
                    deletionRequestedAt: '2026-07-09T12:00:00.000Z',
                },
            },
        });
    });
});

describe('AdminController platform billing lifecycle', () => {
    function buildPlatformPrisma(tenant: any): any {
        return addTransactionMock({
            tenant: {
                findUnique: vi.fn().mockResolvedValue(tenant),
                update: vi.fn().mockResolvedValue({}),
            },
            session: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        });
    }

    it('delegates platform archive to the durable attributed lifecycle owner', async () => {
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
        const archiveTenant = vi.spyOn(
            (controller as any).tenantAccountLifecycle,
            'archiveTenant',
        ).mockResolvedValue({ id: 'tenant-1', archived: true });

        await expect(controller.archiveTenant(superAdminReq, 'tenant-1')).resolves.toEqual({
            id: 'tenant-1',
            archived: true,
        });

        expect(archiveTenant).toHaveBeenCalledWith('tenant-1', {
            tenantId: 'platform-tenant',
            userId: 'admin-1',
            sessionId: 'admin-session-1',
            ipAddress: '203.0.113.25',
            userAgent: 'vitest-platform-admin',
        });
        expect(stripeBilling.cancelTenantSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
        expect(prisma.tenant.update).not.toHaveBeenCalled();
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

    it.each(['activate', 'restore'] as const)(
        'keeps finalized deletion irreversible through tenant %s',
        async (action) => {
            const deletedAt = new Date('2026-06-01T00:00:00.000Z');
            const tenant = {
                id: 'tenant-deleted',
                planTier: 'FREE',
                stripeSubscriptionId: null,
                status: 'PURGED',
                deletedAt,
                applicationDataPurgedAt: null,
                auditLogs: [{ id: 'finalized-receipt', action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER' }],
            };
            const prisma = buildPlatformPrisma(tenant);
            const stripeBilling = { assertTenantSubscriptionActive: vi.fn() };
            const controller = buildController(prisma, { grantCredits: vi.fn() }, stripeBilling);

            const request = action === 'activate'
                ? controller.activateTenant(superAdminReq, tenant.id)
                : controller.restoreTenant(superAdminReq, tenant.id);
            await expect(request).rejects.toThrow(/deletion is irreversible/i);

            expect(prisma.tenant.update).not.toHaveBeenCalled();
            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
            expect(stripeBilling.assertTenantSubscriptionActive).not.toHaveBeenCalled();
            expect(tenant).toMatchObject({ status: 'PURGED', deletedAt });
            expect(isTenantReadyForApplicationDataPurge(
                tenant as any,
                new Date('2026-07-16T00:00:00.000Z'),
            )).toBe(true);
        },
    );

    it.each(['activate', 'restore'] as const)(
        'keeps a pending tenant deletion barrier intact through tenant %s',
        async (action) => {
            const tenant = {
                id: 'tenant-pending-deletion',
                planTier: 'FREE',
                stripeSubscriptionId: null,
                status: 'SUSPENDED',
                deletedAt: null,
                auditLogs: [{ id: 'barrier-1', action: 'TENANT_DELETION_BARRIER_COMMITTED' }],
            };
            const prisma = buildPlatformPrisma(tenant);
            const controller = buildController(prisma, { grantCredits: vi.fn() });

            const request = action === 'activate'
                ? controller.activateTenant(superAdminReq, tenant.id)
                : controller.restoreTenant(superAdminReq, tenant.id);
            await expect(request).rejects.toThrow(/deletion is irreversible/i);

            expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
                where: { id: tenant.id },
                select: expect.objectContaining({
                    auditLogs: expect.objectContaining({
                        where: expect.objectContaining({
                            tenantId: tenant.id,
                            resourceId: tenant.id,
                        }),
                    }),
                }),
            });
            expect(prisma.tenant.update).not.toHaveBeenCalled();
            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
            expect(tenant).toMatchObject({ status: 'SUSPENDED', deletedAt: null });
        },
    );

    it('treats a durable finalization receipt as irreversible even if tenant status drifted', async () => {
        const tenant = {
            id: 'tenant-finalized-receipt',
            planTier: 'FREE',
            stripeSubscriptionId: null,
            status: 'CANCELLED',
            deletedAt: new Date('2026-06-01T00:00:00.000Z'),
            auditLogs: [{ id: 'finalized-receipt', action: 'TENANT_DELETION_REQUESTED_BY_CUSTOMER' }],
        };
        const prisma = buildPlatformPrisma(tenant);
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await expect(controller.restoreTenant(superAdminReq, tenant.id))
            .rejects.toThrow(/deletion is irreversible/i);

        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rechecks the deletion barrier inside restore so a concurrent request cannot reactivate', async () => {
        const ordinarySuspension = {
            id: 'tenant-race',
            planTier: 'FREE',
            stripeSubscriptionId: null,
            status: 'SUSPENDED',
            deletedAt: null,
            auditLogs: [],
        };
        const pendingDeletion = {
            ...ordinarySuspension,
            auditLogs: [{ id: 'barrier-race', action: 'TENANT_DELETION_BARRIER_COMMITTED' }],
        };
        const prisma = buildPlatformPrisma(ordinarySuspension);
        prisma.tenant.findUnique
            .mockResolvedValueOnce(ordinarySuspension)
            .mockResolvedValueOnce(pendingDeletion);
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await expect(controller.restoreTenant(superAdminReq, ordinarySuspension.id))
            .rejects.toThrow(/deletion is irreversible/i);

        expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(2);
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('restores an ordinary non-deletion suspension when no durable barrier exists', async () => {
        const prisma = buildPlatformPrisma({
            id: 'tenant-ordinary-suspension',
            planTier: 'FREE',
            stripeSubscriptionId: null,
            status: 'SUSPENDED',
            deletedAt: null,
            auditLogs: [],
        });
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await expect(controller.restoreTenant(superAdminReq, 'tenant-ordinary-suspension'))
            .resolves.toEqual({ id: 'tenant-ordinary-suspension', restored: true });

        expect(prisma.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-ordinary-suspension' },
            data: { deletedAt: null, status: 'ACTIVE' },
        });
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
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
        expect(prisma.$executeRaw.mock.calls.some((call: any[]) =>
            rawQueryText(call[0]).includes('public.lock_tenant_lifecycle'))).toBe(true);
        expect(prisma.$queryRaw.mock.calls.some((call: any[]) => {
            const sql = rawQueryText(call[0]);
            return sql.includes('FROM "Tenant"') && sql.includes('FOR UPDATE');
        })).toBe(true);
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
        expect(prisma.$executeRaw.mock.calls.some((call: any[]) =>
            rawQueryText(call[0]).includes('public.lock_tenant_lifecycle'))).toBe(true);
        expect(prisma.$queryRaw.mock.calls.some((call: any[]) => {
            const sql = rawQueryText(call[0]);
            return sql.includes('FROM "Tenant"') && sql.includes('FOR UPDATE');
        })).toBe(true);
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
                retentionLegalHoldAt: null,
            },
            orderBy: [{ deletedAt: 'asc' }, { id: 'asc' }],
            take: 25,
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
        expect(result.dryRun).toBe(true);
        expect(result.signupAttemptRetention).toEqual({
            retentionHours: 24,
            eligibleCount: 3,
            purgedCount: 0,
        });
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
                retentionLegalHoldAt: null,
            },
        }));
        expect(result.asOf).toBe('2026-07-10T12:00:00.000Z');
        expect(result.dryRun).toBe(true);
        expect(result.passwordResetTokenRetention).toMatchObject({
            terminalGraceHours: 24,
            batchLimit: 5_000,
            terminalBefore: '2026-07-09T12:00:00.000Z',
            eligibleCount: 6,
            purgedCount: 0,
        });
    });

    it('lets retention service automation discover seven-year candidates using server time', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2033-07-10T12:00:00.000Z'));
        prisma.tenant.findMany.mockResolvedValue([{
            id: 'tenant-retained-expired',
            slug: 'retained-expired',
            status: 'PURGED',
            deletedAt: new Date('2026-07-09T00:00:00.000Z'),
            applicationDataPurgedAt: new Date('2026-08-09T00:00:00.000Z'),
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
            asOf: '2099-01-01T00:00:00.000Z',
            dryRun: true,
            stage: 'retained_records',
        });

        expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                status: 'PURGED',
                deletedAt: { lte: new Date('2026-07-10T12:00:00.000Z') },
                retentionLegalHoldAt: null,
            },
        }));
        expect(result.asOf).toBe('2033-07-10T12:00:00.000Z');
        expect(result.dryRun).toBe(true);
        expect(result.candidates).toEqual([
            expect.objectContaining({ id: 'tenant-retained-expired', eligibleForDatabasePurge: true }),
        ]);
        expect(prisma.tenant.delete).not.toHaveBeenCalled();
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
        })).rejects.toThrow(/may only dry-run the retained_records stage/i);

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

        expect(prisma.billingEvent.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-expired' },
            data: { metadata: Prisma.DbNull },
        });
        expect(prisma.stripeUsageEvent.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-expired' },
            data: { metadata: Prisma.DbNull, lastError: null },
        });
        expect(result.passwordResetTokenRetention).toMatchObject({
            terminalGraceHours: 24,
            batchLimit: 5_000,
            terminalBefore: '2026-07-09T12:00:00.000Z',
            eligibleCount: 6,
            purgedCount: 5,
        });
        expect(result.sessionRetention).toMatchObject({
            expiredGraceHours: 24,
            revokedRetentionDays: 30,
            eligibleCount: 5,
            purgedCount: 4,
        });
        expect(result.staffInvitationRetention).toMatchObject({
            retentionDays: 30,
            batchLimit: 5_000,
            eligibleCount: 7,
            purgedCount: 6,
        });
        expect(prisma.user.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 'tenant-expired' } });
        expect(prisma.timeCard.deleteMany).not.toHaveBeenCalled();
        const payrollOperationalPurgeCallIndex = (prisma as any).$queryRaw.mock.calls.findIndex(([query]: [any]) => (
            rawQueryText(query).includes('purge_payroll_operational_time_cards')
        ));
        expect(payrollOperationalPurgeCallIndex).toBeGreaterThanOrEqual(0);
        expect((prisma as any).$queryRaw.mock.invocationCallOrder[payrollOperationalPurgeCallIndex]).toBeLessThan(
            prisma.user.deleteMany.mock.invocationCallOrder[0],
        );
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
            signupAttemptRetention: {
                retentionHours: 24,
                eligibleCount: 2,
                purgedCount: 2,
            },
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
        const auditPurgeCallIndex = (prisma as any).$queryRaw.mock.calls.findIndex(([query]: [any]) => (
            rawQueryText(query).includes('purge_expired_audit_logs')
        ));
        const payrollPurgeCallIndex = (prisma as any).$queryRaw.mock.calls.findIndex(([query]: [any]) => (
            rawQueryText(query).includes('purge_expired_payroll_records')
        ));
        expect(payrollPurgeCallIndex).toBeGreaterThanOrEqual(0);
        expect((prisma as any).$queryRaw.mock.invocationCallOrder[payrollPurgeCallIndex]).toBeLessThan(
            prisma.timeCard.deleteMany.mock.invocationCallOrder[0],
        );
        expect(auditPurgeCallIndex).toBeGreaterThanOrEqual(0);
        expect((prisma as any).$queryRaw.mock.invocationCallOrder[auditPurgeCallIndex]).toBeLessThan(
            prisma.user.deleteMany.mock.invocationCallOrder[0],
        );
        expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
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
                payrollRecords: 33,
                timeCards: 4,
                onboardingSignupAttempts: 26,
                tenantExportJobs: 27,
                availabilityImportJobs: 28,
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
        expect(result.failedTenants).toEqual([{ id: 'tenant-12', error: 'Tenant purge failed.' }]);
        expect(JSON.stringify(result.failedTenants)).not.toContain('simulated statement timeout');
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

    it('rejects platform hard delete while an expired tenant remains under legal hold', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2033-07-10T00:00:00.000Z'));
        prisma.tenant.findUnique.mockResolvedValue({
            id: 'tenant-held',
            slug: 'acme-dining',
            status: 'PURGED',
            deletedAt: new Date('2026-07-09T00:00:00.000Z'),
            retentionLegalHoldAt: new Date('2032-01-01T00:00:00.000Z'),
            retentionLegalHoldReason: 'Active litigation preservation.',
            retentionLegalHoldByUserId: 'platform-admin-1',
        });

        await expect(controller.deleteTenant(superAdminReq, 'tenant-held'))
            .rejects.toThrow(/under retention legal hold/i);
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

        expect((prisma as any).$queryRaw.mock.calls.some(([query]: [any]) => (
            rawQueryText(query).includes('purge_expired_audit_logs')
        ))).toBe(true);
        expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
        expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: 'tenant-expired' } });
        expect(result).toMatchObject({
            id: 'tenant-expired',
            deleted: true,
            retention: {
                deletionRequestedAt: '2026-07-09T00:00:00.000Z',
                fullDatabasePurgeEligibleAt: '2033-07-09T00:00:00.000Z',
            },
            deletedRecordCounts: {
                payrollRecords: 33,
                billingEvents: 9,
                onboardingSignupAttempts: 26,
                tenantExportJobs: 27,
                availabilityImportJobs: 28,
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

describe('AdminController user directory pagination', () => {
    let controller: AdminController;
    let prisma: any;

    const makeUser = (index: number, overrides: Record<string, unknown> = {}) => ({
        id: 'user-' + String(index).padStart(3, '0'),
        publicId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        name: 'User ' + index,
        email: 'user' + index + '@example.com',
        username: 'user' + index,
        role: 'STAFF',
        createdAt: new Date(Date.UTC(2026, 6, 15, 12, 0, 0) - index * 1_000),
        lastLoginAt: null,
        lockedUntil: null,
        pinLockedUntil: null,
        suspendedAt: null,
        deletedAt: null,
        mfaEnabled: false,
        tenant: {
            id: 'tenant-' + index,
            name: 'Tenant ' + index,
            slug: 'tenant-' + index,
        },
        ...overrides,
    });

    beforeEach(() => {
        prisma = addTransactionMock({
            user: { findMany: vi.fn() },
        });
        controller = buildController(prisma, { grantCredits: vi.fn() });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reaches users beyond the former 200-row cap through stable cursor pages', async () => {
        const allUsers = Array.from({ length: 205 }, (_, index) => makeUser(index));
        prisma.user.findMany
            .mockResolvedValueOnce(allUsers.slice(0, 201))
            .mockResolvedValueOnce(allUsers.slice(200));

        const firstPage = await controller.users(superAdminReq, '200');
        const secondPage = await controller.users(
            superAdminReq,
            '200',
            firstPage.pagination.nextCursor ?? undefined,
        );

        expect(prisma.user.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: {},
            orderBy: [{ createdAt: 'desc' }, { publicId: 'desc' }],
            take: 201,
        }));
        expect(prisma.user.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: {
                OR: [
                    { createdAt: { lt: allUsers[199].createdAt } },
                    { createdAt: allUsers[199].createdAt, publicId: { lt: allUsers[199].publicId } },
                ],
            },
            take: 201,
        }));
        expect([...firstPage.data, ...secondPage.data]).toHaveLength(205);
        expect(new Set([...firstPage.data, ...secondPage.data].map((user) => user.id)).size).toBe(205);
        expect(firstPage.data[0].id).toBe(allUsers[0].publicId);
        const cursorPayload = JSON.parse(Buffer.from(firstPage.pagination.nextCursor ?? '', 'base64url').toString('utf8'));
        expect(cursorPayload.id).toBe(allUsers[199].publicId);
        expect(firstPage.pagination).toMatchObject({ returned: 200, hasMore: true });
        expect(secondPage.pagination).toMatchObject({ returned: 5, hasMore: false, nextCursor: null });
    });

    it('binds search and status filters to Prisma with mapUserStatus lock semantics', async () => {
        vi.useFakeTimers();
        const now = new Date('2026-07-15T12:00:00.000Z');
        vi.setSystemTime(now);
        const expiredLock = makeUser(1, {
            role: 'ADMIN',
            lockedUntil: new Date('2026-07-15T11:59:59.000Z'),
            pinLockedUntil: new Date('2026-07-15T11:00:00.000Z'),
        });
        const futureLock = makeUser(2, {
            lockedUntil: new Date('2026-07-15T12:01:00.000Z'),
        });
        prisma.user.findMany
            .mockResolvedValueOnce([expiredLock])
            .mockResolvedValueOnce([futureLock])
            .mockResolvedValue([]);

        const activeResult = await controller.users(superAdminReq, '25', undefined, ' admin ', 'ACTIVE');
        const activeWhere = prisma.user.findMany.mock.calls[0][0].where;
        expect(activeWhere.AND[0].OR).toEqual(expect.arrayContaining([
            { name: { contains: 'admin', mode: 'insensitive' } },
            { email: { contains: 'admin', mode: 'insensitive' } },
            { username: { contains: 'admin', mode: 'insensitive' } },
            { tenant: { is: { name: { contains: 'admin', mode: 'insensitive' } } } },
            { tenant: { is: { slug: { contains: 'admin', mode: 'insensitive' } } } },
            { role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
        ]));
        expect(activeWhere.AND[1]).toEqual({
            deletedAt: null,
            suspendedAt: null,
            AND: [
                { OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
                { OR: [{ pinLockedUntil: null }, { pinLockedUntil: { lte: now } }] },
            ],
        });
        expect(activeResult.data[0].status).toBe('ACTIVE');

        const lockedResult = await controller.users(superAdminReq, '25', undefined, undefined, 'LOCKED');
        expect(prisma.user.findMany.mock.calls[1][0].where).toEqual({
            deletedAt: null,
            suspendedAt: null,
            OR: [
                { lockedUntil: { gt: now } },
                { pinLockedUntil: { gt: now } },
            ],
        });
        expect(lockedResult.data[0].status).toBe('LOCKED');

        await controller.users(superAdminReq, '25', undefined, undefined, 'SUSPENDED');
        expect(prisma.user.findMany.mock.calls[2][0].where).toEqual({
            deletedAt: null,
            suspendedAt: { not: null },
        });
        await controller.users(superAdminReq, '25', undefined, undefined, 'DELETED');
        expect(prisma.user.findMany.mock.calls[3][0].where).toEqual({
            deletedAt: { not: null },
        });
    });

    it('rejects malformed directory controls before querying users', async () => {
        await expect(controller.users(superAdminReq, '0')).rejects.toThrow(/Invalid limit/i);
        await expect(controller.users(superAdminReq, '25', 'not-a-cursor')).rejects.toThrow(/Invalid cursor/i);
        await expect(controller.users(superAdminReq, '25', undefined, undefined, 'disabled')).rejects.toThrow(/Invalid status filter/i);
        await expect(controller.users(superAdminReq, '25', undefined, 'x'.repeat(101))).rejects.toThrow(/100 printable/i);
        expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
});
describe('AdminController tenant list pagination', () => {
    let controller: AdminController;
    let prisma: any;

    beforeEach(() => {
        prisma = addTransactionMock({
            tenant: { findMany: vi.fn() },
        });
        controller = buildController(prisma, { grantCredits: vi.fn() });
    });

    it('returns a stable limit-plus-one page with bounded name and slug search', async () => {
        prisma.tenant.findMany.mockResolvedValue([
            {
                id: 'tenant-2',
                name: 'Acme West',
                slug: 'acme-west',
                planTier: 'STARTER',
                status: 'ACTIVE',
                usageCredits: 50,
                createdAt: new Date('2026-07-14T12:00:00.000Z'),
                trialEndsAt: null,
                gracePeriodEndsAt: null,
                deletedAt: null,
                _count: { users: 3, locations: 2 },
            },
            {
                id: 'tenant-1',
                name: 'Acme East',
                slug: 'acme-east',
                planTier: 'FREE',
                status: 'ACTIVE',
                usageCredits: 0,
                createdAt: new Date('2026-07-13T12:00:00.000Z'),
                trialEndsAt: null,
                gracePeriodEndsAt: null,
                deletedAt: null,
                _count: { users: 1, locations: 1 },
            },
        ]);

        const result = await controller.tenants(superAdminReq, '1', undefined, ' acme ');

        expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                OR: [
                    { name: { contains: 'acme', mode: 'insensitive' } },
                    { slug: { contains: 'acme', mode: 'insensitive' } },
                ],
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 2,
        }));
        expect(result.data).toHaveLength(1);
        expect(result.pagination).toMatchObject({
            limit: 1,
            returned: 1,
            hasMore: true,
        });
        expect(result.pagination.nextCursor).toEqual(expect.any(String));
    });

    it('applies a descending createdAt and id cursor and rejects malformed controls', async () => {
        prisma.tenant.findMany.mockResolvedValue([]);
        const timestamp = new Date('2026-07-14T12:00:00.000Z');
        const cursor = encodeBoundedListCursor(timestamp, 'tenant-2');

        await controller.tenants(superAdminReq, '25', cursor);

        expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                AND: [{
                    OR: [
                        { createdAt: { lt: timestamp } },
                        { createdAt: timestamp, id: { lt: 'tenant-2' } },
                    ],
                }],
            },
            take: 26,
        }));
        await expect(controller.tenants(superAdminReq, '0')).rejects.toThrow(/Invalid limit/i);
        await expect(controller.tenants(superAdminReq, '25', 'not-a-cursor')).rejects.toThrow(/Invalid cursor/i);
        await expect(controller.tenants(superAdminReq, '25', undefined, 'x'.repeat(101))).rejects.toThrow(/100 printable/i);
    });

    it('reaches more than 100 tenants through bounded continuation pages', async () => {
        const allTenants = Array.from({ length: 105 }, (_, index) => ({
            id: 'tenant-' + String(index).padStart(3, '0'),
            name: 'Tenant ' + index,
            slug: 'tenant-' + index,
            planTier: 'FREE',
            status: 'ACTIVE',
            usageCredits: 0,
            createdAt: new Date(Date.UTC(2026, 6, 15, 12, 0, 0) - index * 1_000),
            trialEndsAt: null,
            gracePeriodEndsAt: null,
            deletedAt: null,
            _count: { users: 1, locations: 1 },
        }));
        prisma.tenant.findMany
            .mockResolvedValueOnce(allTenants.slice(0, 101))
            .mockResolvedValueOnce(allTenants.slice(100));

        const firstPage = await controller.tenants(superAdminReq, '100');
        const secondPage = await controller.tenants(
            superAdminReq,
            '100',
            firstPage.pagination.nextCursor ?? undefined,
        );

        expect(prisma.tenant.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ take: 101 }));
        expect(prisma.tenant.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: {
                AND: [{
                    OR: [
                        { createdAt: { lt: allTenants[99].createdAt } },
                        { createdAt: allTenants[99].createdAt, id: { lt: allTenants[99].id } },
                    ],
                }],
            },
            take: 101,
        }));
        expect([...firstPage.data, ...secondPage.data]).toHaveLength(105);
        expect(new Set([...firstPage.data, ...secondPage.data].map((tenant) => tenant.id)).size).toBe(105);
        expect(firstPage.pagination).toMatchObject({ returned: 100, hasMore: true });
        expect(secondPage.pagination).toMatchObject({ returned: 5, hasMore: false });
    });});

describe('AdminController credits', () => {
    let controller: AdminController;
    let prisma: any;
    let meteringService: { grantCreditsInTransaction: ReturnType<typeof vi.fn> };
    let authorizePlatformAdminTenantMutationInTransaction: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        prisma = addTransactionMock({
            tenant: {
                findMany: vi.fn(),
            },
            creditTransaction: {
                findMany: vi.fn(),
            },
            auditLog: {
                findUnique: vi.fn(),
                create: vi.fn().mockResolvedValue({}),
            },
        });

        meteringService = {
            grantCreditsInTransaction: vi.fn(),
        };
        authorizePlatformAdminTenantMutationInTransaction = vi.fn().mockResolvedValue(undefined);

        controller = buildController(
            prisma,
            meteringService as any,
            undefined,
            { authorizePlatformAdminTenantMutationInTransaction } as any,
        );
    });

    it('lists live tenant balances and credit history', async () => {
        prisma.tenant.findMany.mockResolvedValue([
            {
                id: 'tenant-1',
                name: 'Acme Dining',
                slug: 'acme-dining',
                planTier: 'STARTER',
                usageCredits: 125,
                createdAt: new Date('2026-03-21T09:00:00.000Z'),
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
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 51,
            select: {
                id: true,
                name: true,
                slug: true,
                planTier: true,
                usageCredits: true,
                createdAt: true,
            },
        });
        expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith({
            where: {},
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 26,
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
        expect(result.tenantPagination).toMatchObject({ limit: 50, returned: 1, hasMore: false });
        expect(result.historyPagination).toMatchObject({ limit: 25, returned: 1, hasMore: false });
    });

    it('bounds and independently continues tenant balances and ledger history', async () => {
        prisma.tenant.findMany.mockResolvedValue([]);
        prisma.creditTransaction.findMany.mockResolvedValue([]);
        const tenantTimestamp = new Date('2026-07-14T12:00:00.000Z');
        const historyTimestamp = new Date('2026-07-14T11:00:00.000Z');

        await controller.credits(
            superAdminReq,
            undefined,
            '10',
            encodeBoundedListCursor(tenantTimestamp, 'tenant-2'),
            'acme',
            '20',
            encodeBoundedListCursor(historyTimestamp, 'tx-2'),
        );

        expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                deletedAt: null,
                OR: [
                    { name: { contains: 'acme', mode: 'insensitive' } },
                    { slug: { contains: 'acme', mode: 'insensitive' } },
                ],
                AND: [{
                    OR: [
                        { createdAt: { lt: tenantTimestamp } },
                        { createdAt: tenantTimestamp, id: { lt: 'tenant-2' } },
                    ],
                }],
            },
            take: 11,
        }));
        expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                OR: [
                    { createdAt: { lt: historyTimestamp } },
                    { createdAt: historyTimestamp, id: { lt: 'tx-2' } },
                ],
            },
            take: 21,
        }));
    });

    it('rejects malformed credit list controls before querying', async () => {
        await expect(controller.credits(superAdminReq, undefined, '201')).rejects.toThrow(/Invalid limit/i);
        await expect(controller.credits(
            superAdminReq,
            undefined,
            '50',
            undefined,
            undefined,
            '50',
            'invalid',
        )).rejects.toThrow(/Invalid cursor/i);
        expect(prisma.tenant.findMany).not.toHaveBeenCalled();
        expect(prisma.creditTransaction.findMany).not.toHaveBeenCalled();
    });

    it('authorizes, grants, and attributes one audit in the same Serializable transaction', async () => {
        const transactionId = `admin-credit-grant-${'a'.repeat(64)}`;
        meteringService.grantCreditsInTransaction.mockResolvedValue({
            transactionId,
            newBalance: 175,
            replayed: false,
        });

        const result = await controller.grantCredits(
            superAdminReq,
            { tenantId: 'tenant-1', amount: 50, reason: 'Correction grant' },
            ' credit-grant-1 ',
        );

        expect(authorizePlatformAdminTenantMutationInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            expect.objectContaining({
                userId: 'admin-1',
                tenantId: 'platform-tenant',
                sessionId: 'admin-session-1',
            }),
        );
        expect(meteringService.grantCreditsInTransaction).toHaveBeenCalledWith(prisma, {
            tenantId: 'tenant-1',
            amount: 50,
            reason: 'Correction grant',
            idempotencyKey: 'credit-grant-1',
        });
        const lockCall = prisma.$executeRaw.mock.calls.find((call: any[]) => (
            rawQueryText(call[0]).includes('LOCK TABLE "Tenant", "CreditTransaction"')
        ));
        expect(lockCall).toBeDefined();
        expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
            authorizePlatformAdminTenantMutationInTransaction.mock.invocationCallOrder[0],
        );
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                id: `${transactionId}-audit`,
                tenantId: 'tenant-1',
                userId: null,
                actorUserId: 'admin-1',
                actorTenantId: 'platform-tenant',
                ipAddress: '203.0.113.25',
                userAgent: 'vitest-platform-admin',
                action: 'TENANT_CREDITS_GRANTED',
                resource: 'CreditTransaction',
                resourceId: transactionId,
                newValue: {
                    creditTransactionId: transactionId,
                    amount: 50,
                    reason: 'Correction grant',
                    newBalance: 175,
                },
            },
        });
        expect(prisma.$transaction).toHaveBeenCalledWith(
            expect.any(Function),
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        expect(result).toEqual({
            success: true,
            newBalance: 175,
        });
    });

    it('replays the original result without another grant or audit', async () => {
        const transactionId = `admin-credit-grant-${'b'.repeat(64)}`;
        meteringService.grantCreditsInTransaction.mockResolvedValue({
            transactionId,
            newBalance: 175,
            replayed: true,
        });
        prisma.auditLog.findUnique.mockResolvedValue({
            tenantId: 'tenant-1',
            action: 'TENANT_CREDITS_GRANTED',
            resource: 'CreditTransaction',
            resourceId: transactionId,
            newValue: {
                creditTransactionId: transactionId,
                amount: 50,
                reason: 'Correction grant',
                newBalance: 175,
            },
        });

        await expect(controller.grantCredits(
            superAdminReq,
            { tenantId: 'tenant-1', amount: 50, reason: 'Correction grant' },
            'credit-grant-1',
        )).resolves.toEqual({ success: true, newBalance: 175 });

        expect(meteringService.grantCreditsInTransaction).toHaveBeenCalledOnce();
        expect(prisma.auditLog.findUnique).toHaveBeenCalledWith({
            where: { id: `${transactionId}-audit` },
            select: {
                tenantId: true,
                action: true,
                resource: true,
                resourceId: true,
                newValue: true,
            },
        });
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('fails closed when replay audit provenance is missing or malformed', async () => {
        meteringService.grantCreditsInTransaction.mockResolvedValue({
            transactionId: `admin-credit-grant-${'c'.repeat(64)}`,
            newBalance: 175,
            replayed: true,
        });
        prisma.auditLog.findUnique.mockResolvedValue(null);

        await expect(controller.grantCredits(
            superAdminReq,
            { tenantId: 'tenant-1', amount: 50, reason: 'Correction grant' },
            'credit-grant-1',
        )).rejects.toThrow(/exact attributed audit record/i);

        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('does not touch wallet, ledger, or audit when live actor authority fails', async () => {
        authorizePlatformAdminTenantMutationInTransaction.mockRejectedValue(
            new ForbiddenException('Platform administrator session is no longer active'),
        );

        await expect(controller.grantCredits(
            superAdminReq,
            { tenantId: 'tenant-1', amount: 50, reason: 'Correction grant' },
            'credit-grant-1',
        )).rejects.toThrow('Platform administrator session is no longer active');

        expect(meteringService.grantCreditsInTransaction).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('propagates audit failure from the transaction owner', async () => {
        meteringService.grantCreditsInTransaction.mockResolvedValue({
            transactionId: `admin-credit-grant-${'d'.repeat(64)}`,
            newBalance: 175,
            replayed: false,
        });
        prisma.auditLog.create.mockRejectedValue(new Error('audit insert failed'));

        await expect(controller.grantCredits(
            superAdminReq,
            { tenantId: 'tenant-1', amount: 50, reason: 'Correction grant' },
            'credit-grant-1',
        )).rejects.toThrow('audit insert failed');
    });

    it('requires an idempotency key before calling the metering service', async () => {
        await expect(controller.grantCredits(
            superAdminReq,
            { tenantId: 'tenant-1', amount: 50, reason: 'Correction grant' },
        )).rejects.toThrow('Idempotency-Key header is required');

        expect(meteringService.grantCreditsInTransaction).not.toHaveBeenCalled();
    });
});

describe('AdminController platform user identity and access updates', () => {
    function userRecord(overrides: Record<string, unknown> = {}) {
        return {
            id: 'user-1',
            tenantId: 'tenant-1',
            name: 'Admin User',
            email: 'admin@example.com',
            username: 'admin-user',
            role: 'ADMIN',
            lockedUntil: null,
            pinLockedUntil: null,
            suspendedAt: null,
            deletedAt: null,
            tenant: { id: 'tenant-1', name: 'Tenant One', slug: 'tenant-one' },
            ...overrides,
        };
    }

    function buildUserMutationPrisma(existing = userRecord(), updated = existing) {
        return addTransactionMock({
            user: {
                findUnique: vi.fn().mockResolvedValue(existing),
                findUniqueOrThrow: vi.fn().mockResolvedValue(updated),
                update: vi.fn().mockResolvedValue(updated),
            },
            passwordResetToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
            passwordResetEmailOutbox: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
            session: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        });
    }

    it('reconciles ADMIN to STAFF permissions and revokes the old session in one transaction', async () => {
        const updated = userRecord({ role: 'STAFF' });
        const prisma = buildUserMutationPrisma(userRecord(), updated);
        const replaceLegacySystemRoleForPlatformAdminActorInTransaction = vi.fn().mockResolvedValue({
            legacyRole: 'STAFF',
            assignedRoles: [{
                id: 'role-staff',
                name: 'Staff',
                description: null,
                isSystem: true,
                legacyRole: 'STAFF',
                permissions: ['dashboard:access', 'schedules:read'],
            }],
            changed: true,
            previousLegacyRole: 'ADMIN',
            previousRoleIds: ['role-admin'],
            roleId: 'role-staff',
        });
        const controller = buildController(
            prisma,
            { grantCredits: vi.fn() },
            undefined,
            { replaceLegacySystemRoleForPlatformAdminActorInTransaction } as any,
        );

        const result = await controller.updateUser(superAdminReq, 'user-1', { role: 'STAFF' });

        expect(replaceLegacySystemRoleForPlatformAdminActorInTransaction).toHaveBeenCalledWith(
            prisma,
            'user-1',
            'tenant-1',
            'STAFF',
            {
                userId: 'admin-1',
                tenantId: 'platform-tenant',
                sessionId: 'admin-session-1',
                ipAddress: '203.0.113.25',
                userAgent: 'vitest-platform-admin',
            },
        );
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(prisma.passwordResetToken.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                action: 'USER_UPDATED',
                resourceId: 'user-1',
                oldValue: expect.objectContaining({ role: 'ADMIN', roleIds: ['role-admin'] }),
                newValue: expect.objectContaining({ role: 'STAFF', roleIds: ['role-staff'] }),
            }),
        });
        expect(result.role).toBe('STAFF');
    });

    it.each([
        { code: 'P2034' },
        { code: 'P2010', meta: { code: '40P01' } },
    ])('maps platform user transaction conflict $code to a controlled conflict', async (error) => {
        const prisma = buildUserMutationPrisma();
        (prisma as any).$transaction.mockRejectedValue(error);
        const controller = buildController(
            prisma,
            { grantCredits: vi.fn() },
            undefined,
            { replaceLegacySystemRoleForPlatformAdminActorInTransaction: vi.fn() } as any,
        );

        await expect(controller.updateUser(
            superAdminReq,
            'user-1',
            { role: 'STAFF' },
        )).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('retries one Serializable user conflict as a fresh fully authorized transaction', async () => {
        const updated = userRecord({ role: 'STAFF' });
        const prisma = buildUserMutationPrisma(userRecord(), updated);
        (prisma as any).$transaction.mockRejectedValueOnce({ code: 'P2034' });
        const replacement = vi.fn().mockResolvedValue({
            legacyRole: 'STAFF',
            assignedRoles: [],
            changed: true,
            previousLegacyRole: 'ADMIN',
            previousRoleIds: ['role-admin'],
            roleId: 'role-staff',
        });
        const controller = buildController(
            prisma,
            { grantCredits: vi.fn() },
            undefined,
            { replaceLegacySystemRoleForPlatformAdminActorInTransaction: replacement } as any,
        );

        await expect(controller.updateUser(
            superAdminReq,
            'user-1',
            { role: 'STAFF' },
        )).resolves.toMatchObject({ role: 'STAFF' });
        expect((prisma as any).$transaction).toHaveBeenCalledTimes(2);
        expect(replacement).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('consumes old reset links, erases pending delivery, and revokes sessions on email change', async () => {
        const existing = userRecord();
        const updated = userRecord({ email: 'new-admin@example.com' });
        const prisma = buildUserMutationPrisma(existing, updated);
        const liveReset = { consumedAt: null as Date | null };
        const pendingDelivery = {
            status: 'PENDING',
            encryptedPayload: 'encrypted-old-link',
            encryptionKeyRef: 'reset-key-v1',
        };
        prisma.passwordResetToken.updateMany.mockImplementation(async ({ data }: any) => {
            liveReset.consumedAt = data.consumedAt;
            return { count: 1 };
        });
        prisma.passwordResetEmailOutbox.updateMany.mockImplementation(async ({ data }: any) => {
            Object.assign(pendingDelivery, data);
            return { count: 1 };
        });
        const authorizePlatformAdminUserMutationInTransaction = vi.fn().mockResolvedValue({
            id: 'user-1',
            tenantId: 'tenant-1',
            role: 'ADMIN',
            suspendedAt: null,
            deletedAt: null,
        });
        const controller = buildController(
            prisma,
            { grantCredits: vi.fn() },
            undefined,
            { authorizePlatformAdminUserMutationInTransaction } as any,
        );

        await controller.updateUser(superAdminReq, 'user-1', { email: ' NEW-ADMIN@example.com ' });

        expect(authorizePlatformAdminUserMutationInTransaction).toHaveBeenCalledWith(
            prisma,
            'user-1',
            {
                userId: 'admin-1',
                tenantId: 'platform-tenant',
                sessionId: 'admin-session-1',
                ipAddress: '203.0.113.25',
                userAgent: 'vitest-platform-admin',
            },
        );
        expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', userId: 'user-1', consumedAt: null },
            data: { consumedAt: expect.any(Date) },
        });
        expect(liveReset.consumedAt).toEqual(expect.any(Date));
        expect(prisma.passwordResetEmailOutbox.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                userId: 'user-1',
                status: { in: ['PENDING', 'SENDING', 'FAILED'] },
            },
            data: {
                status: 'DEAD_LETTERED',
                deadLetteredAt: expect.any(Date),
                leaseUntil: null,
                encryptedPayload: '',
                encryptionKeyRef: 'erased-v1',
                lastError: null,
            },
        });
        expect(pendingDelivery).toMatchObject({
            status: 'DEAD_LETTERED',
            encryptedPayload: '',
            encryptionKeyRef: 'erased-v1',
        });
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: { email: 'new-admin@example.com' },
        });
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
    });

    it('rolls back a non-role patch when exact live platform authorization is no longer valid', async () => {
        const prisma = buildUserMutationPrisma();
        const authorizePlatformAdminUserMutationInTransaction = vi.fn().mockRejectedValue(
            new ForbiddenException('Platform administrator session is no longer active'),
        );
        const controller = buildController(
            prisma,
            { grantCredits: vi.fn() },
            undefined,
            { authorizePlatformAdminUserMutationInTransaction } as any,
        );

        await expect(controller.updateUser(superAdminReq, 'user-1', {
            name: 'Denied Name',
            pinResetRequired: true,
        })).rejects.toThrow('Platform administrator session is no longer active');

        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.passwordResetToken.updateMany).not.toHaveBeenCalled();
        expect(prisma.passwordResetEmailOutbox.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rolls back a dual-source system-admin profile mutation denied to a delegated platform actor', async () => {
        const prisma = buildUserMutationPrisma(userRecord({ role: 'SUPER_ADMIN' }));
        const authorizePlatformAdminUserMutationInTransaction = vi.fn().mockRejectedValue(
            new ForbiddenException('Only system admins can administer system admins'),
        );
        const controller = buildController(
            prisma,
            { grantCredits: vi.fn() },
            undefined,
            { authorizePlatformAdminUserMutationInTransaction } as any,
        );

        await expect(controller.updateUser(superAdminReq, 'user-1', {
            email: 'changed@example.com',
            pinResetRequired: true,
        })).rejects.toThrow('Only system admins can administer system admins');

        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.passwordResetToken.updateMany).not.toHaveBeenCalled();
        expect(prisma.passwordResetEmailOutbox.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it.each(['lock', 'unlock'] as const)(
        'denies platform user %s after exact in-transaction authorization with zero effects',
        async (operation) => {
            const prisma = buildUserMutationPrisma();
            const authorizePlatformAdminUserMutationInTransaction = vi.fn().mockRejectedValue(
                new ForbiddenException('Platform administrator session is no longer active'),
            );
            const controller = buildController(
                prisma,
                { grantCredits: vi.fn() },
                undefined,
                { authorizePlatformAdminUserMutationInTransaction } as any,
            );

            const mutation = operation === 'lock'
                ? controller.lockUser(superAdminReq, 'user-1', { minutes: 30 })
                : controller.unlockUser(superAdminReq, 'user-1');
            await expect(mutation).rejects.toThrow('Platform administrator session is no longer active');

            expect(authorizePlatformAdminUserMutationInTransaction).toHaveBeenCalledWith(
                prisma,
                'user-1',
                expect.objectContaining({
                    userId: 'admin-1',
                    tenantId: 'platform-tenant',
                    sessionId: 'admin-session-1',
                }),
            );
            expect(prisma.user.update).not.toHaveBeenCalled();
            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );
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
                updateMany: vi.fn(),
            },
            passwordResetToken: { updateMany: vi.fn() },
            passwordResetEmailOutbox: { updateMany: vi.fn() },
            session: { updateMany: vi.fn() },
            auditLog: { create: vi.fn() },
        });

        meteringService = {
            grantCredits: vi.fn(),
        };

        controller = buildController(prisma, meteringService as any);
    });

    it('rejects reactivating a user when the tenant is already at the active user limit', async () => {
        const target = {
            id: 'user-1',
            tenantId: 'tenant-1',
            suspendedAt: new Date('2026-03-21T10:00:00.000Z'),
            deletedAt: null,
        };
        prisma.user.findUnique.mockResolvedValue({ tenantId: target.tenantId });
        prisma.roleAssignment = {
            findFirst: vi.fn().mockResolvedValue({ roleId: 'platform-admin-role' }),
        };
        prisma.$queryRaw.mockImplementation(async (query: any) => {
            const queryText = rawQueryText(query);
            if (queryText.includes('FROM "User"')) {
                return [{
                    id: superAdminReq.user.sub,
                    tenantId: superAdminReq.user.tenantId,
                    suspendedAt: null,
                    deletedAt: null,
                }, target];
            }
            if (queryText.includes('FROM "Session"')) {
                return [{
                    id: superAdminReq.user.sessionId,
                    userId: superAdminReq.user.sub,
                    expiresAt: new Date(Date.now() + 60_000),
                    revokedAt: null,
                }];
            }
            if (queryText.includes('FROM "RoleAssignment"')) {
                return [{ userId: superAdminReq.user.sub, roleId: 'platform-admin-role' }];
            }
            return [];
        });
        prisma.user.count.mockResolvedValue(10);
        controller = buildController(
            prisma,
            meteringService as any,
            undefined,
            {
                authorizePlatformAdminUserMutationInTransaction: vi.fn().mockResolvedValue(target),
            } as any,
        );

        await expect(controller.activateUser(superAdminReq, 'user-1')).rejects.toThrow(/User limit reached/i);
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('rejects cross-tenant reassignment before capacity or user state can mutate', async () => {
        const authorizePlatformAdminUserMutationInTransaction = vi.fn().mockResolvedValue({
            id: 'user-1',
            tenantId: 'tenant-source',
            role: 'STAFF',
            suspendedAt: null,
            deletedAt: null,
        });
        controller = buildController(
            prisma,
            meteringService as any,
            undefined,
            { authorizePlatformAdminUserMutationInTransaction } as any,
        );
        prisma.user.findUnique.mockResolvedValue({
            tenantId: 'tenant-source',
            email: 'user@example.com',
            role: 'STAFF',
            deletedAt: null,
        });
        prisma.user.count.mockResolvedValue(10);

        await expect(
            controller.updateUser(
                superAdminReq,
                'user-1',
                { tenantId: 'tenant-target' },
            ),
        ).rejects.toThrow(/Cross-tenant user reassignment is not supported/i);

        expect(prisma.user.count).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.passwordResetToken.updateMany).not.toHaveBeenCalled();
        expect(prisma.passwordResetEmailOutbox.updateMany).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('AdminController tenant updates', () => {
    let controller: AdminController;
    let prisma: any;
    let authorizePlatformAdminTenantMutationInTransaction: ReturnType<typeof vi.fn>;

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

        authorizePlatformAdminTenantMutationInTransaction = vi.fn().mockResolvedValue(undefined);
        controller = buildController(
            prisma,
            { grantCredits: vi.fn() } as any,
            undefined,
            { authorizePlatformAdminTenantMutationInTransaction } as any,
        );
    });

    it('updates generic tenant profile fields', async () => {
        prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', deletedAt: null });

        const result = await controller.updateTenant(
            superAdminReq,
            'tenant-1',
            { name: 'Acme Dining', slug: 'Acme Dining West' },
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
            data: { name: 'Acme Dining', slug: 'acme-dining-west' },
        });
        expect(authorizePlatformAdminTenantMutationInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            expect.objectContaining({
                userId: 'admin-1',
                tenantId: 'platform-tenant',
                sessionId: 'admin-session-1',
            }),
        );
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

    it('denies tenant suspension when exact live platform authorization is revoked', async () => {
        prisma.session = { updateMany: vi.fn() };
        authorizePlatformAdminTenantMutationInTransaction.mockRejectedValueOnce(
            new ForbiddenException('Platform administrator session is no longer active'),
        );

        await expect(controller.suspendTenant(superAdminReq, 'tenant-1'))
            .rejects.toThrow('Platform administrator session is no longer active');

        expect(authorizePlatformAdminTenantMutationInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            expect.objectContaining({
                userId: 'admin-1',
                tenantId: 'platform-tenant',
                sessionId: 'admin-session-1',
            }),
        );
        expect(prisma.tenant.update).not.toHaveBeenCalled();
        expect(prisma.session.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it.each([
        ['planTier', { planTier: 'STARTER' }],
        ['status', { status: 'SUSPENDED' }],
        ['usageCredits', { usageCredits: 25 }],
        ['creditDebt', { creditDebt: 25 }],
        ['stripeSubscriptionId', { stripeSubscriptionId: 'sub_admin_forbidden' }],
        ['stripeSubscriptionCurrentPeriodEnd', {
            stripeSubscriptionCurrentPeriodEnd: '2099-01-01T00:00:00.000Z',
        }],
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

describe('AdminController plan credit policy', () => {
    it.each([
        { creditQuotaLimit: 100 },
        { creditsLimit: 0 },
        { metadata: { includedCredits: 25 } },
        { metadata: { billing: { unlimitedCredits: true } } },
    ])('rejects plan-owned credit configuration %#', async (creditFields) => {
        const prisma = addTransactionMock({
            planDefinition: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
            },
            auditLog: { create: vi.fn() },
        });
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await expect(controller.createPlan(superAdminReq, {
            code: 'CUSTOM_PLAN',
            name: 'Custom plan',
            monthlyPriceCents: 9900,
            locationLimit: 10,
            userLimit: 100,
            ...creditFields,
        })).rejects.toThrow(/credits|credit/i);
        expect(prisma.planDefinition.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('preserves an explicit empty GROWTH feature set at the admin mutation boundary', async () => {
        const now = new Date('2026-07-16T00:00:00.000Z');
        const create = vi.fn().mockImplementation(async ({ data }: any) => ({
            id: 'plan-growth',
            ...data,
            createdAt: now,
            updatedAt: now,
        }));
        const prisma = addTransactionMock({
            planDefinition: {
                findUnique: vi.fn().mockResolvedValue(null),
                create,
            },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        });
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await controller.createPlan(superAdminReq, {
            code: 'GROWTH',
            name: 'Growth',
            monthlyPriceCents: 7900,
            locationLimit: 25,
            userLimit: 250,
            metadata: { features: [] },
        });

        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                code: 'GROWTH',
                metadata: { features: [] },
            }),
        });
    });

    it.each([
        { features: ['scheduling', 'unknown_feature'] },
        { features: ['scheduling', 42] },
        { features: 'scheduling' },
    ])('rejects malformed or unknown feature metadata on plan creation %#', async (metadata) => {
        const prisma = addTransactionMock({
            planDefinition: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
            },
            auditLog: { create: vi.fn() },
        });
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await expect(controller.createPlan(superAdminReq, {
            code: 'GROWTH',
            name: 'Growth',
            monthlyPriceCents: 7900,
            locationLimit: 25,
            userLimit: 250,
            metadata: metadata as any,
        })).rejects.toThrow(/features/i);

        expect(prisma.planDefinition.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects unknown feature metadata on plan update before loading or mutating the plan', async () => {
        const prisma = addTransactionMock({
            planDefinition: {
                findUnique: vi.fn(),
                update: vi.fn(),
            },
            auditLog: { create: vi.fn() },
        });
        const controller = buildController(prisma, { grantCredits: vi.fn() });

        await expect(controller.updatePlan(superAdminReq, 'GROWTH', {
            metadata: { features: ['scheduling', 'unknown_feature'] },
        })).rejects.toThrow(/features/i);

        expect(prisma.planDefinition.findUnique).not.toHaveBeenCalled();
        expect(prisma.planDefinition.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
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
            actorSessionId: 'admin-session-1',
            confirmation: 'reset-mfa:user-1',
        }));
    });

    it('resolves a public user UUID while keeping the storage ID inside the retained service', async () => {
        const publicUserId = '20000000-0000-4000-8000-000000000104';
        const prisma = addTransactionMock({
            user: {
                findUnique: vi.fn().mockResolvedValue({ id: 'user-1', publicId: publicUserId }),
            },
        } as any);
        const controller = buildController(prisma, {} as any);
        const reset = vi.fn().mockResolvedValue({ id: 'user-1', mfaEnabled: false, sessionsRevoked: 2 });
        (controller as any).userMfaRecovery = { reset };

        await expect(controller.resetUserMfa(superAdminReq, publicUserId, {
            confirmation: `reset-mfa:${publicUserId}`,
            reason: 'Lost all registered MFA factors',
        })).resolves.toEqual({ id: publicUserId, mfaEnabled: false, sessionsRevoked: 2 });
        expect(prisma.user.findUnique).toHaveBeenCalledWith({
            where: { publicId: publicUserId },
            select: { id: true, publicId: true },
        });
        expect(reset).toHaveBeenCalledWith(expect.objectContaining({
            targetUserId: 'user-1',
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
