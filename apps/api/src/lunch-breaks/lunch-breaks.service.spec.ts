import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LunchBreaksService } from './lunch-breaks.service';

function buildPrismaMock(overrides: Record<string, any> = {}) {
    const tx = {
        shift: {
            count: vi.fn().mockResolvedValue(0),
        },
        break: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
    };

    return {
        tenantSetting: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
        },
        shift: {
            findFirst: vi.fn().mockResolvedValue(null),
            findMany: vi.fn().mockResolvedValue([]),
        },
        $transaction: vi.fn(async (fn: any) => fn(tx)),
        tx,
        ...overrides,
    };
}

describe('LunchBreaksService', () => {
    let prisma: ReturnType<typeof buildPrismaMock>;
    let featureAccess: {
        assertFeatureEnabled: ReturnType<typeof vi.fn>;
        consumeCreditsForFeature: ReturnType<typeof vi.fn>;
    };
    let service: LunchBreaksService;

    beforeEach(() => {
        prisma = buildPrismaMock();
        featureAccess = {
            assertFeatureEnabled: vi.fn().mockResolvedValue({ enabled: true }),
            consumeCreditsForFeature: vi.fn().mockResolvedValue({
                consumedCredits: 2,
                newBalance: 98,
                feature: { enabled: true },
            }),
        };

        service = new LunchBreaksService(featureAccess as any, prisma as any);
    });

    it('generates standalone lunch/breaks from explicit shift payload', async () => {
        const result = await service.generateLunchBreaks('tenant-1', {
            shifts: [
                {
                    startTime: '2026-03-05T09:00:00.000Z',
                    endTime: '2026-03-05T17:00:00.000Z',
                    employeeName: 'Alex',
                },
                {
                    startTime: '2026-03-05T10:00:00.000Z',
                    endTime: '2026-03-05T18:00:00.000Z',
                    employeeName: 'Blair',
                },
            ],
        });

        expect(result.source).toBe('standalone');
        expect(result.persisted).toBe(false);
        expect(result.data).toHaveLength(2);
        expect(result.data[0].breaks).toHaveLength(3);
        expect(result.data[0].breaks[1].type).toBe('lunch');
        expect(prisma.shift.findMany).not.toHaveBeenCalled();
    });

    it('persists generated breaks when using shared schedule shifts', async () => {
        prisma.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                userId: 'user-1',
                startTime: new Date('2026-03-05T09:00:00.000Z'),
                endTime: new Date('2026-03-05T17:00:00.000Z'),
                user: { id: 'user-1', name: 'Alex' },
            },
            {
                id: 'shift-2',
                userId: 'user-2',
                startTime: new Date('2026-03-05T09:30:00.000Z'),
                endTime: new Date('2026-03-05T17:30:00.000Z'),
                user: { id: 'user-2', name: 'Blair' },
            },
        ]);
        prisma.tx.shift.count.mockResolvedValue(2);

        const result = await service.generateLunchBreaks('tenant-1', {
            persist: true,
        });

        expect(result.source).toBe('shared_schedule');
        expect(result.persisted).toBe(true);
        expect(prisma.tx.break.deleteMany).toHaveBeenCalled();
        expect(prisma.tx.break.createMany).toHaveBeenCalled();
    });

    it('maps persisted break records by paid/unpaid semantics', async () => {
        prisma.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                userId: 'user-1',
                startTime: new Date('2026-03-05T09:00:00.000Z'),
                endTime: new Date('2026-03-05T17:00:00.000Z'),
                user: { id: 'user-1', name: 'Alex' },
                breaks: [
                    {
                        startTime: new Date('2026-03-05T11:00:00.000Z'),
                        endTime: new Date('2026-03-05T11:10:00.000Z'),
                        paid: true,
                    },
                    {
                        startTime: new Date('2026-03-05T13:30:00.000Z'),
                        endTime: new Date('2026-03-05T14:00:00.000Z'),
                        paid: false,
                    },
                    {
                        startTime: new Date('2026-03-05T15:15:00.000Z'),
                        endTime: new Date('2026-03-05T15:25:00.000Z'),
                        paid: true,
                    },
                ],
            },
        ]);

        const result = await service.listLunchBreaks('tenant-1', {});
        expect(result.data).toHaveLength(1);
        expect(result.data[0].breaks.map((entry) => entry.type)).toEqual(['break1', 'lunch', 'break2']);
    });

    it('updates a shift with manual break edits', async () => {
        prisma.shift.findFirst
            .mockResolvedValueOnce({
                id: 'shift-1',
                userId: 'user-1',
                startTime: new Date('2026-03-05T09:00:00.000Z'),
                endTime: new Date('2026-03-05T17:00:00.000Z'),
                user: { id: 'user-1', name: 'Alex' },
                breaks: [],
            })
            .mockResolvedValueOnce({
                id: 'shift-1',
                userId: 'user-1',
                startTime: new Date('2026-03-05T09:00:00.000Z'),
                endTime: new Date('2026-03-05T17:00:00.000Z'),
                user: { id: 'user-1', name: 'Alex' },
                breaks: [
                    {
                        startTime: new Date('2026-03-05T11:00:00.000Z'),
                        endTime: new Date('2026-03-05T11:10:00.000Z'),
                        paid: true,
                    },
                    {
                        startTime: new Date('2026-03-05T13:30:00.000Z'),
                        endTime: new Date('2026-03-05T14:00:00.000Z'),
                        paid: false,
                    },
                ],
            });
        prisma.tx.shift.count.mockResolvedValue(1);

        const result = await service.updateShiftBreaks('tenant-1', 'shift-1', {
            breaks: [
                { type: 'break1', startTime: '2026-03-05T11:00:00.000Z', durationMinutes: 10 },
                { type: 'lunch', startTime: '2026-03-05T13:30:00.000Z', durationMinutes: 30 },
                { type: 'break2', skip: true },
            ],
        });

        expect(prisma.tx.break.deleteMany).toHaveBeenCalledWith({ where: { shiftId: 'shift-1' } });
        expect(prisma.tx.break.createMany).toHaveBeenCalled();
        expect(result.breaks.map((entry) => entry.type)).toEqual(['break1', 'lunch']);
    });
});
