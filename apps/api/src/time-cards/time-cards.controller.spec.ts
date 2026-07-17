import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { TimeCardsController } from './time-cards.controller';
import {
    timeCardClockInOperationId,
    timeCardClockInRequestHash,
} from './time-card-idempotency';

describe('TimeCardsController', () => {
    let controller: TimeCardsController;
    let prisma: any;
    let tenantDb: { withTenant: ReturnType<typeof vi.fn> };
    let featureAccess: {
        assertFeatureEnabled: ReturnType<typeof vi.fn>;
        assertFeatureEntitled: ReturnType<typeof vi.fn>;
        assertFeatureEnabledInTransaction: ReturnType<typeof vi.fn>;
        assertFeatureEntitledInTransaction: ReturnType<typeof vi.fn>;
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
        payrollPeriodId: null,
        workTimeZone: 'America/Los_Angeles',
        revision: 1,
        deletedAt: null,
        updatedAt: new Date('2026-07-08T15:00:00.000Z'),
        user: { id: 'staff-1', name: 'Jordan Shift', username: 'jordan.shift', role: 'STAFF' },
        location: { id: 'loc-1', name: 'Downtown Diner', timezone: 'America/Los_Angeles' },
        shift: null,
        breaks: [],
    };

    beforeEach(() => {
        featureAccess = {
            assertFeatureEnabled: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', reason: 'Billable', creditCost: 1 }),
            assertFeatureEntitled: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', reason: 'Entitled control', creditCost: 1 }),
            assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', reason: 'Billable', creditCost: 1 }),
            assertFeatureEntitledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', reason: 'Entitled control', creditCost: 1 }),
            recordFeatureUsageInTransaction: vi.fn().mockResolvedValue({ consumedCredits: 1, newBalance: 10 }),
        };
        prisma = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn().mockImplementation(async (query: TemplateStringsArray) => {
                const sql = Array.from(query).join(' ');
                return sql.includes('FROM "User"') ? [{ id: 'staff-1' }] : [];
            }),
            timeCard: {
                findMany: vi.fn(),
                findFirst: vi.fn(),
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn(),
                update: vi.fn(),
                updateMany: vi.fn(),
            },
            timeCardBreak: {
                deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
                createMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            payrollPeriod: {
                findFirst: vi.fn().mockResolvedValue(null),
            },
            payrollPolicyVersion: {
                findMany: vi.fn().mockResolvedValue([]),
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
            orderBy: [{ clockInAt: 'desc' }, { id: 'desc' }],
            take: 101,
        }));
        expect(result.tenantId).toBe('tenant-1');
        expect(result.data[0].id).toBe('card-1');
        expect(result.nextCursor).toBeNull();
    });

    it('paginates history with a bounded cursor query and returns the next cursor', async () => {
        prisma.timeCard.findMany.mockResolvedValue([
            { ...baseCard, id: 'card-3' },
            { ...baseCard, id: 'card-2' },
            { ...baseCard, id: 'card-1' },
        ]);

        const result = await controller.findAll(
            adminReq,
            undefined,
            undefined,
            undefined,
            undefined,
            '2',
            'card-4',
        );

        expect(prisma.timeCard.findMany).toHaveBeenCalledWith(expect.objectContaining({
            take: 3,
            cursor: { id: 'card-4' },
            skip: 1,
            orderBy: [{ clockInAt: 'desc' }, { id: 'desc' }],
        }));
        expect(result.data.map((card) => card.id)).toEqual(['card-3', 'card-2']);
        expect(result.nextCursor).toBe('card-2');
    });

    it('rejects invalid page bounds before opening a tenant transaction', async () => {
        await expect(controller.findAll(
            adminReq,
            undefined,
            undefined,
            undefined,
            undefined,
            '251',
        )).rejects.toBeInstanceOf(BadRequestException);

        expect(tenantDb.withTenant).not.toHaveBeenCalled();
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

    it('denies a cross-tenant time-card lookup without exposing the foreign record', async () => {
        prisma.timeCard.findFirst.mockResolvedValue(null);

        await expect(controller.findOne('foreign-card', adminReq)).rejects.toThrow('Time card not found');

        expect(prisma.timeCard.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'foreign-card',
                tenantId: 'tenant-1',
                deletedAt: null,
            }),
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

    it.each(['suspended', 'non-staff'])(
        'rejects a %s target before creating or charging a time card',
        async () => {
            prisma.$queryRaw.mockResolvedValueOnce([]);

            await expect(
                controller.clockIn({ userId: 'staff-1' }, adminReq, 'clock-in-ineligible'),
            ).rejects.toThrow('not available for time tracking');

            expect(prisma.timeCard.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({
                where: expect.objectContaining({ status: 'OPEN' }),
            }));
            expect(prisma.timeCard.create).not.toHaveBeenCalled();
            expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
            expect(prisma.auditLog.create).not.toHaveBeenCalled();
        },
    );

    it('creates an open time card for a manager-selected employee', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.location.findFirst.mockResolvedValue({ id: 'loc-1', timezone: 'America/Los_Angeles' });
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
                    breakIntervals: [],
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
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(closedCard);
        prisma.timeCard.updateMany.mockResolvedValue({ count: 1 });

        const result = await controller.clockOut(
            'card-1',
            { clockOutAt: '2026-07-08T23:00:00.000Z', breakMinutes: 30 },
            adminReq,
        );

        expect(tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function), {
            maxWait: 5_000,
            timeout: 10_000,
        });
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
                    breakIntervals: [],
                    status: 'OPEN',
                },
                newValue: {
                    targetUserId: 'staff-1',
                    locationId: 'loc-1',
                    shiftId: null,
                    clockInAt: '2026-07-08T15:00:00.000Z',
                    clockOutAt: '2026-07-08T23:00:00.000Z',
                    breakMinutes: 30,
                    breakIntervals: [],
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

    it('rejects clock-out after the assigned payroll period cutoff before closing the card', async () => {
        const payrollCard = { ...baseCard, payrollPeriodId: 'period-1' };
        prisma.timeCard.findFirst
            .mockResolvedValueOnce(payrollCard)
            .mockResolvedValueOnce(payrollCard);
        prisma.$queryRaw
            .mockResolvedValueOnce([{
                id: 'period-1',
                status: 'OPEN',
                startsAt: new Date('2026-07-01T00:00:00.000Z'),
                endsAt: new Date('2026-07-09T00:00:00.000Z'),
            }])
            .mockResolvedValue([]);

        await expect(controller.clockOut(
            'card-1',
            { clockOutAt: '2026-07-09T00:00:00.001Z', breakMinutes: 0 },
            adminReq,
        )).rejects.toThrow('cannot cross');

        expect(prisma.timeCard.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
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

    it('fails closed if a non-credit resolution reaches clock-in metering', async () => {
        const planResolution = { enabled: true, source: 'plan', reason: 'Included', creditCost: 1 };
        featureAccess.assertFeatureEnabledInTransaction.mockResolvedValue(planResolution);
        featureAccess.recordFeatureUsageInTransaction.mockRejectedValue(
            new ForbiddenException('Billable feature usage requires separately purchased credits.'),
        );
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findFirst.mockResolvedValue(null);
        prisma.timeCard.create.mockResolvedValue(baseCard);

        await expect(controller.clockIn(
            { userId: 'staff-1' },
            adminReq,
            'invalid-plan-clock-in',
        )).rejects.toThrow('separately purchased credits');

        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            planResolution,
            'Time card clock-in (card-1)',
            expect.any(String),
        );
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
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

    it('returns an exact committed replay after a concurrent attempt observes the open card', async () => {
        const operationId = timeCardClockInOperationId('tenant-1', 'concurrent-retry');
        const requestHash = timeCardClockInRequestHash({
            actorUserId: 'admin-1',
            targetUserId: 'staff-1',
            locationId: null,
            shiftId: null,
            clockInAt: null,
            notes: null,
        });
        const committed = {
            ...baseCard,
            clockInOperationId: operationId,
            clockInRequestHash: requestHash,
        };
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(committed);
        prisma.timeCard.findFirst.mockResolvedValue({ id: 'card-1' });

        let result: any;
        try {
            result = await controller.clockIn({ userId: 'staff-1' }, adminReq, 'concurrent-retry');
        } catch (error) {
            throw error;
        }

        expect(result.id).toBe(baseCard.id);
        expect(prisma.timeCard.create).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects reuse of a committed clock-in key with a different request', async () => {
        prisma.user.findFirst.mockResolvedValue({ id: 'staff-1' });
        prisma.timeCard.findFirst.mockResolvedValue(null);
        prisma.timeCard.create.mockImplementation(async ({ data }: any) => ({ ...baseCard, ...data }));

        await controller.clockIn({ userId: 'staff-1' }, adminReq, 'different-payload');
        const created = prisma.timeCard.create.mock.calls[0][0].data;
        prisma.timeCard.findUnique.mockResolvedValue({ ...baseCard, ...created });

        await expect(controller.clockIn(
            { userId: 'staff-1', notes: 'different' },
            adminReq,
            'different-payload',
        )).rejects.toThrow('different clock-in request');
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
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
    it('returns each card with its location timezone for browser-independent display', async () => {
        prisma.timeCard.findMany.mockResolvedValue([baseCard]);

        const result = await controller.findAll(adminReq);

        expect(result.data[0].location.timezone).toBe('America/Los_Angeles');
        expect(result.data[0].displayTimeZone).toBe('America/Los_Angeles');
        expect(prisma.timeCard.findMany).toHaveBeenCalledWith(expect.objectContaining({
            include: expect.objectContaining({
                location: { select: { id: true, name: true, timezone: true } },
            }),
        }));
    });

    it('keeps historical display on the captured work timezone after a location timezone change', async () => {
        prisma.timeCard.findMany.mockResolvedValue([{
            ...baseCard,
            workTimeZone: 'America/Los_Angeles',
            location: { ...baseCard.location, timezone: 'America/Denver' },
        }]);

        const result = await controller.findAll(adminReq);

        expect(result.data[0].displayTimeZone).toBe('America/Los_Angeles');
    });

    it('rejects staff corrections before tenant database access', async () => {
        await expect(controller.correct('card-1', {
            clockOutAt: '2026-07-08T23:00:00.000Z',
            expectedUpdatedAt: '2026-07-08T15:00:00.000Z',
            reason: 'Forgotten clock out.',
        }, staffReq)).rejects.toBeInstanceOf(ForbiddenException);

        expect(tenantDb.withTenant).not.toHaveBeenCalled();
        expect(prisma.timeCard.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('rechecks correction entitlement under the tenant lock and rolls back a PAST_DUE transition', async () => {
        featureAccess.assertFeatureEntitledInTransaction.mockRejectedValue(
            new ForbiddenException('Billable features require a current active paid subscription.'),
        );

        await expect(controller.correct('card-1', {
            clockOutAt: '2026-07-08T23:00:00.000Z',
            expectedUpdatedAt: '2026-07-08T15:00:00.000Z',
            reason: 'Forgotten clock out.',
        }, adminReq)).rejects.toThrow(/active paid subscription/i);

        expect(featureAccess.assertFeatureEntitled).not.toHaveBeenCalled();
        expect(featureAccess.assertFeatureEntitledInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            'time_cards',
        );
        expect(prisma.timeCard.findFirst).not.toHaveBeenCalled();
        expect(prisma.timeCard.updateMany).not.toHaveBeenCalled();
        expect(prisma.timeCardBreak.deleteMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('atomically corrects punches and break intervals with an immutable reason', async () => {
        const corrected = {
            ...baseCard,
            clockInAt: new Date('2026-07-08T14:00:00.000Z'),
            clockOutAt: new Date('2026-07-08T23:00:00.000Z'),
            breakMinutes: 30,
            status: 'CLOSED',
            updatedAt: new Date('2026-07-08T23:05:00.000Z'),
            breaks: [{
                id: 'break-1',
                startAt: new Date('2026-07-08T18:00:00.000Z'),
                endAt: new Date('2026-07-08T18:30:00.000Z'),
            }],
        };
        prisma.timeCard.findFirst
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(corrected);
        prisma.timeCard.updateMany.mockResolvedValue({ count: 1 });
        prisma.timeCardBreak.deleteMany.mockResolvedValue({ count: 0 });
        prisma.timeCardBreak.createMany.mockResolvedValue({ count: 1 });

        const result = await controller.correct('card-1', {
            clockInAt: '2026-07-08T14:00:00.000Z',
            clockOutAt: '2026-07-08T23:00:00.000Z',
            breakIntervals: [{
                startAt: '2026-07-08T18:00:00.000Z',
                endAt: '2026-07-08T18:30:00.000Z',
            }],
            expectedUpdatedAt: '2026-07-08T15:00:00.000Z',
            reason: ' Employee confirmed forgotten punches. ',
        }, adminReq);

        expect(featureAccess.assertFeatureEntitledInTransaction).toHaveBeenCalledWith(
            prisma,
            'tenant-1',
            'time_cards',
        );

        expect(prisma.timeCard.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
            where: expect.objectContaining({ id: 'card-1', tenantId: 'tenant-1' }),
        }));
        expect(prisma.timeCard.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'card-1',
                tenantId: 'tenant-1',
                deletedAt: null,
                updatedAt: new Date('2026-07-08T15:00:00.000Z'),
                revision: 1,
            },
            data: {
                clockInAt: new Date('2026-07-08T14:00:00.000Z'),
                clockOutAt: new Date('2026-07-08T23:00:00.000Z'),
                breakMinutes: 30,
                status: 'CLOSED',
                payrollPeriodId: null,
                workTimeZone: 'America/Los_Angeles',
                revision: { increment: 1 },
            },
        });
        expect(prisma.timeCardBreak.deleteMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', timeCardId: 'card-1' },
        });
        expect(prisma.timeCardBreak.createMany).toHaveBeenCalledWith({
            data: [{
                tenantId: 'tenant-1',
                timeCardId: 'card-1',
                startAt: new Date('2026-07-08T18:00:00.000Z'),
                endAt: new Date('2026-07-08T18:30:00.000Z'),
            }],
        });
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                tenantId: 'tenant-1',
                userId: 'admin-1',
                action: 'TIME_CARD_CORRECTED',
                resource: 'TimeCard',
                resourceId: 'card-1',
                oldValue: expect.objectContaining({
                    clockInAt: '2026-07-08T15:00:00.000Z',
                    breakIntervals: [],
                }),
                newValue: expect.objectContaining({
                    clockInAt: '2026-07-08T14:00:00.000Z',
                    clockOutAt: '2026-07-08T23:00:00.000Z',
                    breakIntervals: [{
                        startAt: '2026-07-08T18:00:00.000Z',
                        endAt: '2026-07-08T18:30:00.000Z',
                    }],
                    correctionReason: 'Employee confirmed forgotten punches.',
                }),
            }),
        });
        expect(result.workedMinutes).toBe(510);
        expect(result.displayTimeZone).toBe('America/Los_Angeles');
    });

    it('rolls back a correction whose closed card crosses its reassigned payroll cutoff', async () => {
        const payrollPeriod = {
            id: 'period-1',
            startsAt: new Date('2026-07-08T00:00:00.000Z'),
            endsAt: new Date('2026-07-09T00:00:00.000Z'),
            status: 'OPEN',
        };
        const corrected = {
            ...baseCard,
            payrollPeriodId: payrollPeriod.id,
            clockOutAt: new Date('2026-07-09T00:00:00.001Z'),
            status: 'CLOSED',
            updatedAt: new Date('2026-07-08T23:05:00.000Z'),
        };
        prisma.payrollPolicyVersion.findMany.mockResolvedValue([{
            id: 'policy-1',
            version: 1,
            timeZone: 'UTC',
            effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
        }]);
        prisma.payrollPeriod.findFirst.mockResolvedValue(payrollPeriod);
        prisma.timeCard.findFirst
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(corrected);
        prisma.timeCard.updateMany.mockResolvedValue({ count: 1 });
        prisma.$queryRaw
            .mockResolvedValueOnce([{ id: payrollPeriod.id }])
            .mockResolvedValueOnce([payrollPeriod])
            .mockResolvedValueOnce([{ id: baseCard.id }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([payrollPeriod])
            .mockResolvedValueOnce([{ id: baseCard.id }])
            .mockResolvedValueOnce([]);

        await expect(controller.correct('card-1', {
            clockOutAt: corrected.clockOutAt.toISOString(),
            expectedUpdatedAt: baseCard.updatedAt.toISOString(),
            reason: 'Corrected punch crossed the payroll cutoff.',
        }, adminReq)).rejects.toThrow('cannot cross the assigned payroll period cutoff');

        expect(prisma.timeCard.updateMany).toHaveBeenCalledOnce();
        expect(prisma.auditLog.create).toHaveBeenCalledOnce();
        expect(tenantDb.withTenant).toHaveBeenCalledOnce();
    });

    it('rejects a correction that overlaps another tenant-scoped card', async () => {
        prisma.timeCard.findFirst
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce({ id: 'card-2' });

        await expect(controller.correct('card-1', {
            clockOutAt: '2026-07-08T23:00:00.000Z',
            expectedUpdatedAt: '2026-07-08T15:00:00.000Z',
            reason: 'Forgotten clock out.',
        }, adminReq)).rejects.toThrow('cannot overlap another card');

        expect(prisma.timeCard.findFirst).toHaveBeenNthCalledWith(3, expect.objectContaining({
            where: expect.objectContaining({
                tenantId: 'tenant-1',
                userId: 'staff-1',
                id: { not: 'card-1' },
            }),
        }));
        expect(prisma.timeCard.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('maps a deferred database overlap race to a correction conflict', async () => {
        tenantDb.withTenant.mockRejectedValueOnce(
            new Error('constraint TimeCard_employee_no_overlap violated'),
        );

        await expect(controller.correct('card-1', {
            clockOutAt: '2026-07-08T23:00:00.000Z',
            expectedUpdatedAt: '2026-07-08T15:00:00.000Z',
            reason: 'Forgotten clock out.',
        }, adminReq)).rejects.toBeInstanceOf(ConflictException);
    });
    it('rejects stale correction versions without replacing breaks or auditing', async () => {
        prisma.timeCard.findFirst
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(baseCard)
            .mockResolvedValueOnce(null);
        prisma.timeCard.updateMany.mockResolvedValue({ count: 0 });

        await expect(controller.correct('card-1', {
            clockOutAt: '2026-07-08T23:00:00.000Z',
            breakIntervals: [],
            expectedUpdatedAt: '2026-07-08T15:00:00.000Z',
            reason: 'Forgotten clock out.',
        }, adminReq)).rejects.toBeInstanceOf(ConflictException);

        expect(prisma.timeCardBreak.deleteMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
});
