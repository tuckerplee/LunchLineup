import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RbacService } from '../auth/rbac.service';
import { resolveFallbackPlanDefinition } from '../billing/plan-definitions';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { AdminUserLifecycleService, type AdminUserLifecycleActor } from './admin-user-lifecycle.service';

type LifecycleFixtureRow = {
    id: string;
    tenantId: string;
    role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
    suspendedAt: Date | null;
    deletedAt: Date | null;
};

describe('AdminUserLifecycleService', () => {
    let prisma: any;
    let service: AdminUserLifecycleService;
    let actorRow: LifecycleFixtureRow;
    let targetRow: LifecycleFixtureRow;
    let assignmentRows: Array<{ tenantId: string; userId: string; roleId: string }>;
    const actor: AdminUserLifecycleActor = {
        userId: 'platform-admin-1',
        tenantId: 'platform-tenant',
        sessionId: 'platform-session-1',
        ipAddress: '203.0.113.10',
        userAgent: 'vitest',
    };
    const activeTarget: LifecycleFixtureRow = {
        id: 'user-1',
        tenantId: 'tenant-1',
        role: 'STAFF',
        suspendedAt: null,
        deletedAt: null,
    };

    beforeEach(() => {
        vi.stubEnv('PLATFORM_ADMIN_DB_CONTEXT_SECRET', 'test-capability');
        actorRow = {
            id: actor.userId,
            tenantId: actor.tenantId,
            role: 'SUPER_ADMIN',
            suspendedAt: null,
            deletedAt: null,
        };
        targetRow = activeTarget;
        assignmentRows = [{
            tenantId: actor.tenantId,
            userId: actor.userId,
            roleId: 'platform-admin-role',
        }];
        prisma = {
            $queryRaw: vi.fn().mockImplementation(async (query: TemplateStringsArray) => {
                const sql = String(query);
                if (sql.includes('FROM "User"')) return [actorRow, targetRow];
                if (sql.includes('FROM "Session"')) {
                    return [{
                        id: actor.sessionId,
                        userId: actor.userId,
                        expiresAt: new Date(Date.now() + 60_000),
                        revokedAt: null,
                    }];
                }
                if (sql.includes('FROM "RoleAssignment"')) return assignmentRows;
                return [];
            }),
            $executeRaw: vi.fn().mockResolvedValue(1),
            $transaction: vi.fn(async (operation: any) => operation(prisma)),
            user: {
                findUnique: vi.fn(async () => ({ tenantId: targetRow.tenantId })),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                count: vi.fn().mockResolvedValue(2),
            },
            session: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
            shift: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
            schedule: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    planTier: 'FREE',
                    status: 'ACTIVE',
                    stripeSubscriptionId: null,
                    trialEndsAt: null,
                }),
            },
            planDefinition: {
                findUnique: vi.fn(async ({ where }: any) => resolveFallbackPlanDefinition(where.code)),
            },
            role: {
                findMany: vi.fn().mockResolvedValue([{
                    id: 'platform-admin-role',
                    tenantId: actor.tenantId,
                    name: 'Platform admin',
                    description: null,
                    isSystem: false,
                    legacyRole: null,
                    deletedAt: null,
                    rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
                }]),
            },
            auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        const tenantDb = new TenantPrismaService(prisma);
        service = new AdminUserLifecycleService(tenantDb, new RbacService(tenantDb));
    });

    it('suspends under a row lock, revokes sessions, and preserves deletion and credentials', async () => {
        const result = await service.suspend('user-1', actor);

        expect(result).toMatchObject({
            id: 'user-1',
            tenantId: 'tenant-1',
            status: 'SUSPENDED',
            changed: true,
            sessionsRevoked: 3,
        });
        const tenantLockIndex = prisma.$queryRaw.mock.calls.findIndex(
            (call: any[]) => String(call[0]).includes('FROM "Tenant"'),
        );
        const userLockIndex = prisma.$queryRaw.mock.calls.findIndex(
            (call: any[]) => String(call[0]).includes('FROM "User"'),
        );
        const sessionLockIndex = prisma.$queryRaw.mock.calls.findIndex(
            (call: any[]) => String(call[0]).includes('FROM "Session"'),
        );
        const tenantLock = prisma.$queryRaw.mock.calls[tenantLockIndex];
        const userLock = prisma.$queryRaw.mock.calls[userLockIndex];
        expect(String(tenantLock?.[0])).toMatch(/ORDER BY "id"[\s\S]*FOR KEY SHARE/);
        expect(tenantLock?.[1].values).toEqual([actor.tenantId, 'tenant-1'].sort());
        expect(tenantLockIndex).toBeLessThan(userLockIndex);
        expect(prisma.$executeRaw.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[userLockIndex]);
        expect(userLockIndex).toBeLessThan(sessionLockIndex);
        expect(String(userLock?.[0])).toMatch(/ORDER BY "id"[\s\S]*FOR UPDATE/);
        expect(userLock?.[1].values).toEqual([actor.userId, 'user-1'].sort());
        expect(prisma.$transaction).toHaveBeenCalledWith(
            expect.any(Function),
            { isolationLevel: 'Serializable' },
        );
        expect(prisma.role.findMany).toHaveBeenCalled();
        expect(prisma.session.updateMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: 'user-1', tenantId: 'tenant-1', deletedAt: null, suspendedAt: null },
            data: { suspendedAt: expect.any(Date) },
        });
        expect(prisma.user.updateMany.mock.calls[0][0].data).not.toHaveProperty('deletedAt');
        expect(prisma.user.updateMany.mock.calls[0][0].data).not.toHaveProperty('passwordHash');
        expect(prisma.session.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.user.updateMany.mock.invocationCallOrder[0]);
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                userId: null,
                actorUserId: actor.userId,
                actorTenantId: actor.tenantId,
                action: 'USER_SUSPENDED',
                oldValue: { suspendedAt: null },
                newValue: {
                    suspendedAt: expect.any(String),
                    shiftsUnassigned: 0,
                },
            }),
        });
    });

    it('clears editable draft assignments and advances the draft revision during suspension', async () => {
        prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
            const sql = Array.isArray((query as any).strings)
                ? (query as any).strings.join('?')
                : Array.from(query).join('?');
            if (sql.includes('FROM "Schedule" schedule_row')) return [];
            if (sql.includes('FROM "Shift" shift_row')) {
                return [{
                    id: 'shift-1',
                    scheduleId: 'schedule-1',
                    scheduleTenantId: 'tenant-1',
                    scheduleStatus: 'DRAFT',
                    scheduleDeletedAt: null,
                }];
            }
            if (sql.includes('FROM "User"')) return [actorRow, targetRow];
            if (sql.includes('FROM "Session"')) {
                return [{
                    id: actor.sessionId,
                    userId: actor.userId,
                    expiresAt: new Date(Date.now() + 60_000),
                    revokedAt: null,
                }];
            }
            if (sql.includes('FROM "RoleAssignment"')) return assignmentRows;
            return [];
        });

        await service.suspend('user-1', actor);

        expect(prisma.shift.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['shift-1'] },
                tenantId: 'tenant-1',
                userId: 'user-1',
                deletedAt: null,
            },
            data: { userId: null },
        });
        expect(prisma.schedule.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['schedule-1'] },
                tenantId: 'tenant-1',
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: 'USER_SUSPENDED',
                newValue: {
                    suspendedAt: expect.any(String),
                    shiftsUnassigned: 1,
                },
            }),
        });
    });

    it('keeps repeated suspension idempotent while revoking any stray active session', async () => {
        const suspendedAt = new Date('2026-07-15T12:00:00.000Z');
        targetRow = { ...activeTarget, suspendedAt };

        await expect(service.suspend('user-1', actor)).resolves.toEqual({
            id: 'user-1',
            tenantId: 'tenant-1',
            status: 'SUSPENDED',
            suspendedAt,
            changed: false,
            sessionsRevoked: 3,
        });
        expect(prisma.session.updateMany).toHaveBeenCalledOnce();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('reactivates only suspendedAt after capacity validation', async () => {
        const suspendedAt = new Date('2026-07-15T12:00:00.000Z');
        targetRow = { ...activeTarget, suspendedAt };

        await expect(service.activate('user-1', actor)).resolves.toMatchObject({
            id: 'user-1',
            tenantId: 'tenant-1',
            status: 'ACTIVE',
            suspendedAt: null,
            changed: true,
        });
        expect(prisma.user.count).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', deletedAt: null, suspendedAt: null },
        });
        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: 'user-1', tenantId: 'tenant-1', deletedAt: null, suspendedAt },
            data: { suspendedAt: null },
        });
        expect(prisma.user.updateMany.mock.calls[0][0].data).toEqual({ suspendedAt: null });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                actorUserId: actor.userId,
                action: 'USER_ACTIVATED',
                oldValue: { suspendedAt: suspendedAt.toISOString() },
                newValue: { suspendedAt: null },
            }),
        });
    });

    it('keeps repeated activation idempotent and does not consume capacity', async () => {
        await expect(service.activate('user-1', actor)).resolves.toEqual({
            id: 'user-1',
            tenantId: 'tenant-1',
            status: 'ACTIVE',
            suspendedAt: null,
            changed: false,
        });
        expect(prisma.user.count).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects self-suspension, self-activation, and irreversible deleted users', async () => {
        await expect(service.suspend(actor.userId, actor)).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.activate(actor.userId, actor)).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();

        targetRow = { ...activeTarget, deletedAt: new Date() };
        await expect(service.suspend('user-1', actor)).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.activate('user-1', actor)).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it.each(['suspend', 'activate'] as const)(
        'denies %s when the guard-authorized actor is suspended before the transaction',
        async (operation) => {
            actorRow = { ...actorRow, suspendedAt: new Date('2026-07-16T12:00:00.000Z') };

            await expect(service[operation]('user-1', actor)).rejects.toBeInstanceOf(ForbiddenException);
            expect(prisma.role.findMany).not.toHaveBeenCalled();
            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(prisma.user.count).not.toHaveBeenCalled();
            expect(prisma.user.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );

    it.each(['suspend', 'activate'] as const)(
        'denies %s when the guard-authorized actor is deleted before the transaction',
        async (operation) => {
            actorRow = { ...actorRow, deletedAt: new Date('2026-07-16T12:00:00.000Z') };

            await expect(service[operation]('user-1', actor)).rejects.toBeInstanceOf(ForbiddenException);
            expect(prisma.role.findMany).not.toHaveBeenCalled();
            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(prisma.user.count).not.toHaveBeenCalled();
            expect(prisma.user.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );

    it.each(['suspend', 'activate'] as const)(
        'denies %s when the guard-authorized actor session was revoked before the transaction',
        async (operation) => {
            prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
                const sql = String(query);
                if (sql.includes('FROM "User"')) return [actorRow, targetRow];
                if (sql.includes('FROM "Session"')) {
                    return [{
                        id: actor.sessionId,
                        userId: actor.userId,
                        expiresAt: new Date(Date.now() + 60_000),
                        revokedAt: new Date(),
                    }];
                }
                if (sql.includes('FROM "RoleAssignment"')) return assignmentRows;
                return [];
            });

            await expect(service[operation]('user-1', actor)).rejects.toBeInstanceOf(ForbiddenException);
            expect(prisma.role.findMany).not.toHaveBeenCalled();
            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(prisma.user.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );

    it.each(['suspend', 'activate'] as const)(
        'denies delegated platform %s of a dual-source system admin with zero effects',
        async (operation) => {
            targetRow = { ...activeTarget, role: 'SUPER_ADMIN', suspendedAt: operation === 'activate' ? new Date() : null };
            assignmentRows = [
                {
                    tenantId: actor.tenantId,
                    userId: actor.userId,
                    roleId: 'platform-admin-role',
                },
                {
                    tenantId: targetRow.tenantId,
                    userId: targetRow.id,
                    roleId: 'target-super-role',
                },
            ];
            prisma.role.findMany.mockResolvedValue([
                {
                    id: 'platform-admin-role',
                    tenantId: actor.tenantId,
                    name: 'Delegated platform admin',
                    description: null,
                    isSystem: false,
                    legacyRole: null,
                    deletedAt: null,
                    rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
                },
                {
                    id: 'target-super-role',
                    tenantId: targetRow.tenantId,
                    name: 'System admin',
                    description: null,
                    isSystem: true,
                    legacyRole: 'SUPER_ADMIN',
                    deletedAt: null,
                    rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
                },
            ]);

            await expect(service[operation](targetRow.id, actor))
                .rejects.toThrow('Only system admins can administer system admins');

            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(prisma.user.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );

    it('allows a dual-source platform system admin to suspend a dual-source system admin target', async () => {
        targetRow = { ...activeTarget, role: 'SUPER_ADMIN' };
        assignmentRows = [
            {
                tenantId: actor.tenantId,
                userId: actor.userId,
                roleId: 'platform-super-role',
            },
            {
                tenantId: targetRow.tenantId,
                userId: targetRow.id,
                roleId: 'target-super-role',
            },
        ];
        prisma.role.findMany.mockResolvedValue([
            {
                id: 'platform-super-role',
                tenantId: actor.tenantId,
                name: 'System admin',
                description: null,
                isSystem: true,
                legacyRole: 'SUPER_ADMIN',
                deletedAt: null,
                rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
            },
            {
                id: 'target-super-role',
                tenantId: targetRow.tenantId,
                name: 'System admin',
                description: null,
                isSystem: true,
                legacyRole: 'SUPER_ADMIN',
                deletedAt: null,
                rolePermissions: [{ permission: { key: 'admin_portal:access' } }],
            },
        ]);

        await expect(service.suspend(targetRow.id, actor)).resolves.toMatchObject({
            id: targetRow.id,
            status: 'SUSPENDED',
            changed: true,
        });

        expect(prisma.user.updateMany).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it.each(['suspend', 'activate'] as const)(
        'denies %s when live platform-admin RBAC authority was revoked after guard authorization',
        async (operation) => {
            assignmentRows = [];

            await expect(service[operation]('user-1', actor)).rejects.toBeInstanceOf(ForbiddenException);
            expect(prisma.session.updateMany).not.toHaveBeenCalled();
            expect(prisma.user.count).not.toHaveBeenCalled();
            expect(prisma.user.updateMany).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );

    it('fails closed when lifecycle state changes after the row lock', async () => {
        prisma.user.updateMany.mockResolvedValue({ count: 0 });
        await expect(service.suspend('user-1', actor)).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it.each(['suspend', 'activate'] as const)(
        'retries one %s transaction conflict and maps two conflicts without duplicate audit',
        async (operation) => {
            if (operation === 'activate') {
                targetRow = { ...activeTarget, suspendedAt: new Date('2026-07-15T12:00:00.000Z') };
            }
            prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });

            await expect(service[operation]('user-1', actor)).resolves.toBeDefined();
            expect(prisma.$transaction).toHaveBeenCalledTimes(2);
            expect(prisma.auditLog.create).toHaveBeenCalledOnce();

            vi.clearAllMocks();
            prisma.$transaction
                .mockRejectedValueOnce({ code: 'P2034' })
                .mockRejectedValueOnce({ code: 'P2034' });
            await expect(service[operation]('user-1', actor)).rejects.toBeInstanceOf(ConflictException);
            expect(prisma.$transaction).toHaveBeenCalledTimes(2);
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );
});
