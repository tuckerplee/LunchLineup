import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { TimeCardsController } from './time-cards.controller';

describe('TimeCardsController', () => {
    let controller: TimeCardsController;
    let prisma: any;
    let tenantDb: { withTenant: ReturnType<typeof vi.fn> };
    let featureAccess: {
        assertFeatureEnabled: ReturnType<typeof vi.fn>;
        assertFeatureEnabledInTransaction: ReturnType<typeof vi.fn>;
        recordFeatureUsageInTransaction: ReturnType<typeof vi.fn>;
    };

    const adminReq = { user: { tenantId: 'tenant-1', sub: 'admin-1', permissions: ['users:read', 'shifts:read'] } };
    const staffReq = { user: { tenantId: 'tenant-1', sub: 'staff-1', permissions: [] } };
    const baseCard = {
        id: 'card-1',
        tenantId: 'tenant-1',
        userId: 'staff-1',
        locationId: 'loc-1',
        shiftId: null,
        clockInAt: new Date('2026-07-08T15:00:00.000Z'),
        clockOutAt: null,
        breakMinutes: 0,
        status: 'OPEN',
        notes: null,
        deletedAt: null,
        user: { id: 'staff-1', name: 'Jordan Shift', username: 'jordan.shift', role: 'STAFF' },
        location: { id: 'loc-1', name: 'Downtown Diner' },
        shift: null,
    };

    beforeEach(() => {
        featureAccess = {
            assertFeatureEnabled: vi.fn().mockResolvedValue({ enabled: true, source: 'plan', reason: 'Included', creditCost: 1 }),
            assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', reason: 'Billable', creditCost: 1 }),
            recordFeatureUsageInTransaction: vi.fn().mockResolvedValue({ consumedCredits: 1, newBalance: 10 }),
        };
        prisma = {
            timeCard: {
                findMany: vi.fn(),
                findFirst: vi.fn(),
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
                update: vi.fn(),
                updateMany: vi.fn(),
            },
            user: {
                findFirst: vi.fn(),
            },
            location: {
                findFirst: vi.fn(),
            },
            shift: {
                findFirst: vi.fn(),
            },
            auditLog: {
                create: vi.fn().mockResolvedValue({}),
            },
        };
        tenantDb = {
            withTenant: vi.fn(async (_tenantId: string, operation: (tx: any) => Promise<unknown>) => operation(prisma)),
        };
        controller = new TimeCardsController(featureAccess as any, tenantDb as any);
    });

    it('checks time card feature access before clock-in writes', async () => {
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(new ForbiddenException('Time cards are disabled.'));

        await expect(controller.clockIn({ userId: 'staff-1' }, adminReq, 'clock-in-1')).rejects.toBeInstanceOf(ForbiddenException);

        expect(featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledWith(prisma, 'tenant-1', 'time_cards');
        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.timeCard.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('prevents staff from clocking in another employee', async () => {
        await expect(controller.clockIn({ userId: 'other-user' }, staffReq, 'clock-in-other')).rejects.toBeInstanceOf(ForbiddenException);
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.timeCard.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('prevents staff self-service clock-in backdating before tenant database work', async () => {
        await expect(controller.clockIn(
            { clockInAt: '2026-07-08T14:00:00.000Z' },
            staffReq,
            'clock-in-staff-backdate',
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(featureAccess.assertFeatureEnabled).not.toHaveBeenCalled();
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(prisma.timeCard.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('lists time cards inside tenant context', async () => {
        prisma.timeCard.findMany.mockResolvedValue([baseCard]);

        const result = await controller.findAll(adminReq);

        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
        expect(prisma.timeCard.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                tenantId: 'tenant-1',
                deletedAt: null,
            }),
            orderBy: { clockInAt: 'desc' },
        }));
        expect(result.tenantId).toBe('tenant-1');
        expect(result.data[0].id).toBe('card-1');
    });

    it('keeps active-card recovery available after entitlement is lost', async () => {
        featureAccess.assertFeatureEnabled.mockRejectedValue(new ForbiddenException('Time cards are no longer entitled.'));
        prisma.timeCard.findFirst.mockResolvedValue(baseCard);

        const result = await controller.active(adminReq, 'staff-1');

        expect(result.data?.id).toBe('card-1');
        expect(featureAccess.assertFeatureEnabled).not.toHaveBeenCalled();
        expect(prisma.timeCard.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ tenantId: 'tenant-1', userId: 'staff-1', status: 'OPEN' }),
        }));
    });

    it('grants team reads to a custom role with the effective team permissions', async () => {
        prisma.timeCard.findMany.mockResolvedValue([baseCard]);

        await controller.findAll({
            user: {
                tenantId: 'tenant-1',
                sub: 'payroll-supervisor-1',
                role: 'Payroll Supervisor',
                permissions: ['time_cards:read', 'time_cards:write', 'users:read', 'shifts:read'],
            },
        }, 'staff-1');

        expect(prisma.timeCard.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ userId: 'staff-1' }),
        }));
    });

    it('does not grant team reads from a legacy role name after permissions are removed', async () => {
        prisma.timeCard.findMany.mockResolvedValue([baseCard]);

        await controller.findAll({
            user: { tenantId: 'tenant-1', sub: 'manager-1', role: 'MANAGER', permissions: ['time_cards:read'] },
        }, 'staff-1');

        expect(prisma.timeCard.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ userId: 'manager-1' }),
        }));
    });

    it('rejects duplicate open time cards for an employee', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findFirst.mockResolvedValue({ id: 'open-card' });

        await expect(controller.clockIn({ userId: 'staff-1' }, adminReq, 'clock-in-1')).rejects.toBeInstanceOf(BadRequestException);
        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
        expect(prisma.timeCard.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('creates an open time card for a manager-selected employee', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.location.findFirst.mockResolvedValue({ id: 'loc-1' });
        prisma.timeCard.findFirst.mockResolvedValue(null);
        prisma.timeCard.create.mockResolvedValue(baseCard);

        const result = await controller.clockIn(
            {
                userId: 'staff-1',
                locationId: 'loc-1',
                clockInAt: '2026-07-08T15:00:00.000Z',
            },
            adminReq,
            'clock-in-create',
        );

        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
        expect(prisma.timeCard.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                userId: 'staff-1',
                locationId: 'loc-1',
                status: 'OPEN',
            }),
        }));
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'admin-1',
                action: 'TIME_CARD_CLOCKED_IN',
                resource: 'TimeCard',
                resourceId: 'card-1',
                newValue: {
                    targetUserId: 'staff-1',
                    locationId: 'loc-1',
                    shiftId: null,
                    clockInAt: '2026-07-08T15:00:00.000Z',
                    clockOutAt: null,
                    breakMinutes: 0,
                    status: 'OPEN',
                },
            },
        });
        expect(result.status).toBe('OPEN');
        expect(result.workedMinutes).toBeGreaterThanOrEqual(0);
        expect(featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledWith(prisma, 'tenant-1', 'time_cards');
    });

    it('rejects ambiguous clock-in timestamps before tenant database work', async () => {
        await expect(controller.clockIn(
            {
                userId: 'staff-1',
                clockInAt: '07/08/2026 08:00',
            },
            adminReq,
            'clock-in-invalid-date',
        )).rejects.toThrow('Invalid clockInAt');

        expect(featureAccess.assertFeatureEnabled).not.toHaveBeenCalled();
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(prisma.timeCard.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects invalid calendar clock-out timestamps before tenant database work', async () => {
        await expect(controller.clockOut(
            'card-1',
            { clockOutAt: '2026-02-30T23:00:00.000Z', breakMinutes: 0 },
            adminReq,
        )).rejects.toThrow('Invalid clockOutAt');

        expect(featureAccess.assertFeatureEnabled).not.toHaveBeenCalled();
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(prisma.timeCard.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('prevents staff self-service clock-out timestamp overrides before tenant database work', async () => {
        await expect(controller.clockOut(
            'card-1',
            { clockOutAt: '2026-07-08T23:00:00.000Z', breakMinutes: 0 },
            staffReq,
        )).rejects.toBeInstanceOf(ForbiddenException);

        expect(featureAccess.assertFeatureEnabled).not.toHaveBeenCalled();
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(prisma.timeCard.update).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects clock-in when selected location does not match selected shift', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findFirst.mockResolvedValue(null);
        prisma.shift.findFirst.mockResolvedValue({ id: 'shift-1', locationId: 'loc-shift', userId: 'staff-1' });

        await expect(controller.clockIn(
            {
                userId: 'staff-1',
                shiftId: 'shift-1',
                locationId: 'loc-other',
            },
            adminReq,
            'clock-in-location-mismatch',
        )).rejects.toThrow('Time card location must match the selected shift location.');

        expect(prisma.location.findFirst).not.toHaveBeenCalled();
        expect(prisma.timeCard.create).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    });

    it('closes an open time card with break minutes', async () => {
        const closedCard = {
            ...baseCard,
            clockOutAt: new Date('2026-07-08T23:00:00.000Z'),
            breakMinutes: 30,
            status: 'CLOSED',
        };
        prisma.timeCard.findFirst
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(closedCard);
        prisma.timeCard.updateMany.mockResolvedValue({ count: 1 });

        const result = await controller.clockOut(
            'card-1',
            { clockOutAt: '2026-07-08T23:00:00.000Z', breakMinutes: 30 },
            adminReq,
        );

        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
        expect(prisma.timeCard.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'card-1',
                tenantId: 'tenant-1',
                status: 'OPEN',
                clockOutAt: null,
            }),
            data: expect.objectContaining({
                breakMinutes: 30,
                status: 'CLOSED',
            }),
        }));
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-1',
                userId: 'admin-1',
                action: 'TIME_CARD_CLOCKED_OUT',
                resource: 'TimeCard',
                resourceId: 'card-1',
                oldValue: {
                    targetUserId: 'staff-1',
                    locationId: 'loc-1',
                    shiftId: null,
                    clockInAt: '2026-07-08T15:00:00.000Z',
                    clockOutAt: null,
                    breakMinutes: 0,
                    status: 'OPEN',
                },
                newValue: {
                    targetUserId: 'staff-1',
                    locationId: 'loc-1',
                    shiftId: null,
                    clockInAt: '2026-07-08T15:00:00.000Z',
                    clockOutAt: '2026-07-08T23:00:00.000Z',
                    breakMinutes: 30,
                    status: 'CLOSED',
                },
            },
        });
        expect(result.status).toBe('CLOSED');
        expect(result.workedMinutes).toBe(450);
    });

    it('allows zero break minutes when clock-out happens inside the first worked minute', async () => {
        const closedCard = {
            ...baseCard,
            clockOutAt: new Date('2026-07-08T15:00:30.000Z'),
            breakMinutes: 0,
            status: 'CLOSED',
        };
        prisma.timeCard.findFirst
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(closedCard);
        prisma.timeCard.updateMany.mockResolvedValue({ count: 1 });

        const result = await controller.clockOut(
            'card-1',
            { clockOutAt: '2026-07-08T15:00:30.000Z', breakMinutes: 0 },
            adminReq,
        );

        expect(prisma.timeCard.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                breakMinutes: 0,
                status: 'CLOSED',
            }),
        }));
        expect(result.status).toBe('CLOSED');
        expect(result.workedMinutes).toBe(0);
    });

    it('rejects a losing concurrent clock-out without overwriting or auditing', async () => {
        prisma.timeCard.findFirst.mockResolvedValue(baseCard);
        prisma.timeCard.updateMany.mockResolvedValue({ count: 0 });

        await expect(controller.clockOut(
            'card-1',
            { clockOutAt: '2026-07-08T23:00:00.000Z', breakMinutes: 30 },
            adminReq,
        )).rejects.toBeInstanceOf(ConflictException);

        expect(prisma.timeCard.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'card-1',
                tenantId: 'tenant-1',
                status: 'OPEN',
                clockOutAt: null,
            }),
        }));
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('commits one authoritative outcome for simultaneous clock-outs', async () => {
        let storedCard: any = { ...baseCard };
        prisma.timeCard.findFirst.mockImplementation(async () => ({ ...storedCard }));
        prisma.timeCard.updateMany.mockImplementation(async ({ data }: any) => {
            if (storedCard.status !== 'OPEN' || storedCard.clockOutAt !== null) {
                return { count: 0 };
            }
            storedCard = { ...storedCard, ...data };
            return { count: 1 };
        });

        const outcomes = await Promise.allSettled([
            controller.clockOut(
                'card-1',
                { clockOutAt: '2026-07-08T22:00:00.000Z', breakMinutes: 15 },
                adminReq,
            ),
            controller.clockOut(
                'card-1',
                { clockOutAt: '2026-07-08T23:00:00.000Z', breakMinutes: 30 },
                adminReq,
            ),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
        expect(storedCard.status).toBe('CLOSED');
        expect([
            '2026-07-08T22:00:00.000Z',
            '2026-07-08T23:00:00.000Z',
        ]).toContain(storedCard.clockOutAt?.toISOString());
    });

    it('requires an Idempotency-Key before entitlement or database work', async () => {
        await expect(controller.clockIn({ userId: 'staff-1' }, adminReq)).rejects.toThrow(
            'Idempotency-Key header is required',
        );

        expect(featureAccess.assertFeatureEnabled).not.toHaveBeenCalled();
        expect(tenantDb.withTenant).not.toHaveBeenCalled();
    });

    it('records one credit-backed unit in the clock-in transaction', async () => {
        const creditResolution = { enabled: true, source: 'credits', reason: 'Credits', creditCost: 1 };
        featureAccess.assertFeatureEnabledInTransaction.mockResolvedValue(creditResolution);
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findFirst.mockResolvedValue(null);
        prisma.timeCard.create.mockResolvedValue(baseCard);

        await controller.clockIn({ userId: 'staff-1' }, adminReq, 'credit-clock-in');

        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            creditResolution,
            'Time card clock-in (card-1)',
            expect.stringMatching(/^[a-f0-9]{64}$/),
        );
    });

    it('records included usage once for a subscription-backed clock-in', async () => {
        const planResolution = { enabled: true, source: 'plan', reason: 'Included', creditCost: 1 };
        featureAccess.assertFeatureEnabledInTransaction.mockResolvedValue(planResolution);
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findFirst.mockResolvedValue(null);
        prisma.timeCard.create.mockResolvedValue(baseCard);

        await controller.clockIn({ userId: 'staff-1' }, adminReq, 'included-clock-in');

        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            planResolution,
            'Time card clock-in (card-1)',
            expect.any(String),
        );
    });

    it('replays a committed clock-in without creating or charging twice', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findFirst.mockResolvedValue(null);
        prisma.timeCard.create.mockImplementation(async ({ data }: any) => ({ ...baseCard, ...data }));

        const first = await controller.clockIn({ userId: 'staff-1' }, adminReq, 'retry-clock-in');
        const created = prisma.timeCard.create.mock.calls[0][0].data;
        prisma.timeCard.findUnique.mockResolvedValue({ ...baseCard, ...created });
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(
            new ForbiddenException('Insufficient usage credits.'),
        );

        const replay = await controller.clockIn({ userId: 'staff-1' }, adminReq, 'retry-clock-in');

        expect(replay.id).toBe(first.id);
        expect(featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledOnce();
        expect(prisma.timeCard.create).toHaveBeenCalledOnce();
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('allows only one concurrent clock-in across distinct request keys', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findFirst.mockResolvedValue(null);
        prisma.timeCard.create
            .mockResolvedValueOnce(baseCard)
            .mockRejectedValueOnce({ code: 'P2002' });

        const outcomes = await Promise.allSettled([
            controller.clockIn({ userId: 'staff-1' }, adminReq, 'concurrent-a'),
            controller.clockIn({ userId: 'staff-1' }, adminReq, 'concurrent-b'),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    });

    it('fails the clock-in transaction before audit when usage recording fails', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findFirst.mockResolvedValue(null);
        prisma.timeCard.create.mockResolvedValue(baseCard);
        featureAccess.recordFeatureUsageInTransaction.mockRejectedValue(
            new ForbiddenException('Insufficient usage credits balance.'),
        );

        await expect(
            controller.clockIn({ userId: 'staff-1' }, adminReq, 'rollback-clock-in'),
        ).rejects.toThrow('Insufficient usage credits balance.');

        expect(prisma.timeCard.create).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('does not record another billable unit at clock-out', async () => {
        const closedCard = {
            ...baseCard,
            clockOutAt: new Date('2026-07-08T23:00:00.000Z'),
            status: 'CLOSED',
        };
        prisma.timeCard.findFirst
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(closedCard);
        prisma.timeCard.updateMany.mockResolvedValue({ count: 1 });

        await controller.clockOut(
            'card-1',
            { clockOutAt: '2026-07-08T23:00:00.000Z' },
            adminReq,
        );

        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
    });

    it('allows the paid clock-out completion after entitlement is lost', async () => {
        let credits = 1;
        let storedCard: any = null;
        const entitlement = { enabled: true, source: 'credits', reason: 'Entitled', creditCost: 1 };
        featureAccess.assertFeatureEnabled.mockResolvedValue(entitlement);
        featureAccess.assertFeatureEnabledInTransaction.mockResolvedValue(entitlement);
        featureAccess.recordFeatureUsageInTransaction.mockImplementation(async () => {
            if (credits < 1) throw new ForbiddenException('Insufficient usage credits balance.');
            credits -= 1;
            return { consumedCredits: 1, newBalance: credits };
        });
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findUnique.mockResolvedValue(null);
        prisma.timeCard.findFirst.mockImplementation(async () => storedCard ? { ...storedCard } : null);
        prisma.timeCard.create.mockImplementation(async ({ data }: any) => {
            storedCard = { ...baseCard, ...data };
            return { ...storedCard };
        });
        prisma.timeCard.updateMany.mockImplementation(async ({ data }: any) => {
            if (!storedCard || storedCard.status !== 'OPEN') return { count: 0 };
            storedCard = { ...storedCard, ...data };
            return { count: 1 };
        });

        const opened = await controller.clockIn({ userId: 'staff-1' }, adminReq, 'final-credit-clock-in');
        featureAccess.assertFeatureEnabled.mockRejectedValue(
            new ForbiddenException('Time cards are no longer entitled.'),
        );
        const clockOutAt = new Date(opened.clockInAt.getTime() + 60_000).toISOString();
        const closed = await controller.clockOut(
            opened.id,
            { clockOutAt },
            adminReq,
        );

        expect(credits).toBe(0);
        expect(closed.status).toBe('CLOSED');
        expect(featureAccess.assertFeatureEnabled).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
    });
});
