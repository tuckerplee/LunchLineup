import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { LunchBreaksService } from './lunch-breaks.service';

function buildPrismaMock() {
    const generationRequests = new Map<string, any>();
    const creditTransactions = new Map<string, any>();
    const state = { usageCredits: 100 };
    const requestKey = (where: any) => {
        const identity = where?.tenantId_requestKeyHash;
        return identity ? `${identity.tenantId}:${identity.requestKeyHash}` : '';
    };
    const requestEntryById = (id: string) => Array.from(generationRequests.entries())
        .find(([, request]) => request.id === id);
    const matchesGenerationRequest = (request: any, where: any) => {
        if (where.id !== undefined && request.id !== where.id) return false;
        if (where.tenantId !== undefined && request.tenantId !== where.tenantId) return false;
        if (where.requestHash !== undefined && request.requestHash !== where.requestHash) return false;
        if (where.status !== undefined && request.status !== where.status) return false;
        if (where.claimToken !== undefined && request.claimToken !== where.claimToken) return false;
        if (where.OR) {
            return where.OR.some((condition: any) => {
                if (condition.claimExpiresAt === null) return request.claimExpiresAt === null;
                if (condition.claimExpiresAt?.lte) {
                    return request.claimExpiresAt instanceof Date
                        && request.claimExpiresAt <= condition.claimExpiresAt.lte;
                }
                return false;
            });
        }
        return true;
    };
    const applyData = (request: any, data: any) => ({
        ...request,
        ...data,
        attempts: data.attempts?.increment !== undefined
            ? request.attempts + data.attempts.increment
            : data.attempts ?? request.attempts,
        updatedAt: new Date(),
    });
    const cloneMap = (source: Map<string, any>) => new Map(
        Array.from(source.entries(), ([key, value]) => [key, structuredClone(value)]),
    );
    const restoreMap = (target: Map<string, any>, snapshot: Map<string, any>) => {
        target.clear();
        for (const [key, value] of snapshot) target.set(key, value);
    };
    const sqlText = (query: any) => Array.isArray(query)
        ? query.join(' ')
        : Array.isArray(query?.strings)
            ? query.strings.join(' ')
            : String(query);
    const tx = {
        $queryRaw: vi.fn(async (query: any, ...values: any[]): Promise<any[]> => {
            if (sqlText(query).includes('UPDATE "Tenant"')) {
                const cost = Number(values[0]);
                if (state.usageCredits < cost) return [];
                state.usageCredits -= cost;
                return [{ usageCredits: state.usageCredits }];
            }
            return [];
        }),
        tenantSetting: {
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
        },
        schedule: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        shift: {
            findFirst: vi.fn().mockResolvedValue(null),
            findMany: vi.fn().mockResolvedValue([]),
            count: vi.fn(async ({ where }: any) => where?.id?.in?.length ?? 0),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            create: vi.fn().mockResolvedValue({ id: 'created-shift-1' }),
        },
        location: {
            findFirst: vi.fn().mockResolvedValue({ id: 'location-1' }),
        },
        user: {
            findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }),
        },
        break: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        lunchBreakGenerationRequest: {
            findUnique: vi.fn(async ({ where }: any) => generationRequests.get(requestKey(where)) ?? null),
            upsert: vi.fn(async ({ where, create }: any) => {
                const key = requestKey(where);
                const existing = generationRequests.get(key);
                if (existing) return existing;
                const created = {
                    creditConsumption: null,
                    response: null,
                    failureStatus: null,
                    failureMessage: null,
                    completedAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...create,
                };
                generationRequests.set(key, created);
                return created;
            }),
            update: vi.fn(async ({ where, data }: any) => {
                const entry = requestEntryById(where.id);
                if (!entry) throw new Error('generation request not found');
                const [key, request] = entry;
                const updated = applyData(request, data);
                generationRequests.set(key, updated);
                return updated;
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
                const entry = requestEntryById(where.id);
                if (!entry || !matchesGenerationRequest(entry[1], where)) return { count: 0 };
                generationRequests.set(entry[0], applyData(entry[1], data));
                return { count: 1 };
            }),
        },
        creditTransaction: {
            create: vi.fn(async ({ data }: any) => {
                if (creditTransactions.has(data.id)) throw new Error('duplicate credit transaction');
                creditTransactions.set(data.id, structuredClone(data));
                return data;
            }),
        },
    };

    return {
        $transaction: vi.fn(async (fn: any) => {
            const requestSnapshot = cloneMap(generationRequests);
            const creditSnapshot = cloneMap(creditTransactions);
            const balanceSnapshot = state.usageCredits;
            try {
                return await fn(tx);
            } catch (error) {
                restoreMap(generationRequests, requestSnapshot);
                restoreMap(creditTransactions, creditSnapshot);
                state.usageCredits = balanceSnapshot;
                throw error;
            }
        }),
        tenantSetting: {
            findUnique: vi.fn(),
            upsert: vi.fn(),
        },
        schedule: {
            updateMany: vi.fn(),
        },
        shift: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
            count: vi.fn(),
            updateMany: vi.fn(),
            create: vi.fn(),
        },
        location: {
            findFirst: vi.fn(),
        },
        user: {
            findFirst: vi.fn(),
        },
        break: {
            deleteMany: vi.fn(),
            createMany: vi.fn(),
        },
        lunchBreakGenerationRequest: {
            findUnique: vi.fn(),
            upsert: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
        creditTransaction: {
            create: vi.fn(),
        },
        generationRequests,
        creditTransactions,
        state,
        tx,
    };
}

function expectTenantContextUsed(prisma: ReturnType<typeof buildPrismaMock>) {
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.tx.$queryRaw).toHaveBeenCalled();
}

function expectNoDirectTenantPrismaCalls(prisma: ReturnType<typeof buildPrismaMock>) {
    for (const delegate of [
        prisma.tenantSetting.findUnique,
        prisma.tenantSetting.upsert,
        prisma.schedule.updateMany,
        prisma.shift.findFirst,
        prisma.shift.findMany,
        prisma.shift.count,
        prisma.shift.updateMany,
        prisma.shift.create,
        prisma.location.findFirst,
        prisma.user.findFirst,
        prisma.break.deleteMany,
        prisma.break.createMany,
        prisma.lunchBreakGenerationRequest.findUnique,
        prisma.lunchBreakGenerationRequest.upsert,
        prisma.lunchBreakGenerationRequest.update,
        prisma.lunchBreakGenerationRequest.updateMany,
        prisma.creditTransaction.create,
    ]) {
        expect(delegate).not.toHaveBeenCalled();
    }
}

describe('LunchBreaksService', () => {
    let prisma: ReturnType<typeof buildPrismaMock>;
    let featureAccess: {
        assertFeatureEnabled: ReturnType<typeof vi.fn>;
        resolveTenantFeatures: ReturnType<typeof vi.fn>;
        assertFeatureEnabledInTransaction: ReturnType<typeof vi.fn>;
        consumeCreditsForFeature: ReturnType<typeof vi.fn>;
    };
    let service: LunchBreaksService;

    beforeEach(() => {
        prisma = buildPrismaMock();
        featureAccess = {
            assertFeatureEnabled: vi.fn().mockResolvedValue({ enabled: true }),
            assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', creditCost: 2, reason: 'Billable' }),
            resolveTenantFeatures: vi.fn().mockResolvedValue({
                features: { lunch_breaks: { enabled: true, source: 'credits', creditCost: 2 } },
                usageCredits: 100,
            }),
            consumeCreditsForFeature: vi.fn().mockResolvedValue({
                consumedCredits: 2,
                newBalance: 98,
                feature: { enabled: true },
            }),
        };
        service = new LunchBreaksService(
            featureAccess as any,
            new TenantPrismaService(prisma as any),
        );
    });

    afterEach(() => {
        expectNoDirectTenantPrismaCalls(prisma);
    });

    it('updates policy inside tenant-scoped Prisma context', async () => {
        prisma.tx.tenantSetting.findUnique.mockResolvedValue({
            value: {
                lunchDurationMinutes: 45,
            },
        });

        const result = await service.updatePolicy('tenant-1', {
            break1DurationMinutes: 15,
        });

        expect(result.lunchDurationMinutes).toBe(45);
        expect(result.break1DurationMinutes).toBe(15);
        expect(prisma.tx.tenantSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                tenantId_key: {
                    tenantId: 'tenant-1',
                    key: 'lunch_break_policy',
                },
            },
        }));
        expectTenantContextUsed(prisma);
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
        }, 'standalone-attempt-1');

        expect(result.source).toBe('standalone');
        expect(result.persisted).toBe(false);
        expect(result.data).toHaveLength(2);
        expect(result.data[0].breaks).toHaveLength(3);
        expect(result.data[0].breaks[1].type).toBe('lunch');
        expect(prisma.tx.location.findFirst).not.toHaveBeenCalled();
        expect(prisma.tx.shift.count).not.toHaveBeenCalled();
        expect(prisma.tx.shift.findMany).not.toHaveBeenCalled();
        expectTenantContextUsed(prisma);
    });

    it('returns only feasible in-window breaks for short shifts', async () => {
        const result = await service.generateLunchBreaks('tenant-1', {
            shifts: [
                {
                    startTime: '2026-03-05T09:00:00.000Z',
                    endTime: '2026-03-05T09:45:00.000Z',
                    employeeName: 'Alex',
                },
                {
                    startTime: '2026-03-05T10:00:00.000Z',
                    endTime: '2026-03-05T10:20:00.000Z',
                    employeeName: 'Blair',
                },
            ],
        }, 'short-shift-attempt-1');

        expect(result.data[0].breaks).toHaveLength(1);
        expect(result.data[0].breaks[0].type).toBe('break1');
        expect(new Date(result.data[0].breaks[0].startTime).getTime())
            .toBeGreaterThanOrEqual(new Date(result.data[0].startTime).getTime());
        expect(new Date(result.data[0].breaks[0].endTime).getTime())
            .toBeLessThanOrEqual(new Date(result.data[0].endTime).getTime());
        expect(result.data[1].breaks).toEqual([]);
        expect(result.creditConsumption).toEqual({ consumedCredits: 2, newBalance: 98, source: 'credits' });
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);
        expect(featureAccess.consumeCreditsForFeature).not.toHaveBeenCalled();
    });

    it('rejects reuse of an attempt key with a different generation request', async () => {
        await service.generateLunchBreaks('tenant-1', {
            shifts: [{
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T13:00:00.000Z',
                employeeName: 'Alex',
            }],
        }, 'conflicting-attempt-1');

        await expect(service.generateLunchBreaks('tenant-1', {
            shifts: [{
                startTime: '2026-03-05T10:00:00.000Z',
                endTime: '2026-03-05T14:00:00.000Z',
                employeeName: 'Alex',
            }],
        }, 'conflicting-attempt-1')).rejects.toThrow('already used with a different');
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);
    });

    it('rejects a duplicate request while its claim lease is active', async () => {
        let releasePolicy!: () => void;
        const policyGate = new Promise<void>((resolve) => {
            releasePolicy = resolve;
        });
        prisma.tx.tenantSetting.findUnique.mockImplementationOnce(async () => {
            await policyGate;
            return null;
        });
        const input = {
            shifts: [{
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
                employeeName: 'Alex',
            }],
        };

        const first = service.generateLunchBreaks('tenant-1', input, 'active-lease-attempt');
        await vi.waitFor(() => expect(prisma.generationRequests.size).toBe(1));

        await expect(service.generateLunchBreaks('tenant-1', input, 'active-lease-attempt'))
            .rejects
            .toThrow('already in progress');

        releasePolicy();
        await expect(first).resolves.toEqual(expect.objectContaining({ reused: false }));
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);
    });

    it('reclaims an expired claim lease and lets the original caller reuse the committed result', async () => {
        let releasePolicy!: () => void;
        const policyGate = new Promise<void>((resolve) => {
            releasePolicy = resolve;
        });
        prisma.tx.tenantSetting.findUnique.mockImplementationOnce(async () => {
            await policyGate;
            return null;
        });
        const input = {
            shifts: [{
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
                employeeName: 'Alex',
            }],
        };

        const original = service.generateLunchBreaks('tenant-1', input, 'expired-lease-attempt');
        await vi.waitFor(() => expect(prisma.generationRequests.size).toBe(1));
        const pending = Array.from(prisma.generationRequests.values())[0];
        pending.claimExpiresAt = new Date(Date.now() - 1);

        const reclaimed = await service.generateLunchBreaks('tenant-1', input, 'expired-lease-attempt');
        expect(reclaimed.reused).toBe(false);

        releasePolicy();
        await expect(original).resolves.toEqual(expect.objectContaining({ reused: true }));
        expect(Array.from(prisma.generationRequests.values())[0].attempts).toBe(2);
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);
    });

    it('rejects backward shift windows before charging', async () => {
        await expect(service.generateLunchBreaks('tenant-1', {
            shifts: [{
                startTime: '2026-03-05T17:00:00.000Z',
                endTime: '2026-03-05T09:00:00.000Z',
            }],
        }, 'backward-attempt-1')).rejects.toThrow('Shift end time must be after start time.');

        expect(featureAccess.consumeCreditsForFeature).not.toHaveBeenCalled();
    });

    it('rejects an empty generation before charging', async () => {
        await expect(service.generateLunchBreaks('tenant-1', { shifts: [] }, 'empty-attempt-1'))
            .rejects
            .toThrow('Add at least one valid shift');

        expect(featureAccess.consumeCreditsForFeature).not.toHaveBeenCalled();
    });

    it('rejects persisted generation without a location before claiming or charging', async () => {
        await expect(service.generateLunchBreaks('tenant-1', {
            shiftIds: ['shift-1'],
            persist: true,
        }, 'missing-location-attempt')).rejects.toThrow('locationId is required');

        expect(prisma.generationRequests.size).toBe(0);
        expect(featureAccess.resolveTenantFeatures).not.toHaveBeenCalled();
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects selected shifts outside the persisted location before charging or persistence', async () => {
        prisma.tx.shift.count.mockResolvedValueOnce(1);

        await expect(service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            shiftIds: ['shift-1', 'shift-other-location'],
            persist: true,
        }, 'mixed-location-attempt')).rejects.toThrow('Every selected shift must belong');

        expect(featureAccess.resolveTenantFeatures).not.toHaveBeenCalled();
        expect(prisma.state.usageCredits).toBe(100);
        expect(prisma.generationRequests.size).toBe(0);
        expect(prisma.tx.shift.findMany).not.toHaveBeenCalled();
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects a persisted generation location outside the tenant before charging or persistence', async () => {
        prisma.tx.location.findFirst.mockResolvedValueOnce(null);

        await expect(service.generateLunchBreaks('tenant-1', {
            locationId: 'other-tenant-location',
            persist: true,
        }, 'foreign-location-attempt')).rejects.toThrow('active location in this tenant');

        expect(featureAccess.resolveTenantFeatures).not.toHaveBeenCalled();
        expect(prisma.state.usageCredits).toBe(100);
        expect(prisma.tx.shift.findMany).not.toHaveBeenCalled();
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
    });

    it('persists generated breaks when using shared schedule shifts', async () => {
        prisma.tx.shift.findMany
            .mockResolvedValueOnce([
                {
                    id: 'shift-1',
                    userId: 'user-1',
                    scheduleId: 'schedule-1',
                    startTime: new Date('2026-03-05T09:00:00.000Z'),
                    endTime: new Date('2026-03-05T17:00:00.000Z'),
                    updatedAt: new Date('2026-03-05T08:00:00.000Z'),
                    user: { id: 'user-1', name: 'Alex' },
                },
                {
                    id: 'shift-2',
                    userId: 'user-2',
                    scheduleId: 'schedule-1',
                    startTime: new Date('2026-03-05T09:30:00.000Z'),
                    endTime: new Date('2026-03-05T17:30:00.000Z'),
                    updatedAt: new Date('2026-03-05T08:05:00.000Z'),
                    user: { id: 'user-2', name: 'Blair' },
                },
            ])
            .mockResolvedValueOnce([
                { id: 'shift-1', scheduleId: 'schedule-1', startTime: new Date('2026-03-05T09:00:00.000Z'), endTime: new Date('2026-03-05T17:00:00.000Z'), updatedAt: new Date('2026-03-05T08:00:00.000Z'), schedule: { status: 'DRAFT' } },
                { id: 'shift-2', scheduleId: 'schedule-1', startTime: new Date('2026-03-05T09:30:00.000Z'), endTime: new Date('2026-03-05T17:30:00.000Z'), updatedAt: new Date('2026-03-05T08:05:00.000Z'), schedule: { status: 'DRAFT' } },
            ])
            .mockResolvedValueOnce([
                { id: 'shift-1', scheduleId: 'schedule-1', startTime: new Date('2026-03-05T09:00:00.000Z'), endTime: new Date('2026-03-05T17:00:00.000Z'), updatedAt: new Date('2026-03-05T08:00:00.000Z'), schedule: { status: 'DRAFT' } },
                { id: 'shift-2', scheduleId: 'schedule-1', startTime: new Date('2026-03-05T09:30:00.000Z'), endTime: new Date('2026-03-05T17:30:00.000Z'), updatedAt: new Date('2026-03-05T08:05:00.000Z'), schedule: { status: 'DRAFT' } },
            ]);

        const result = await service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            persist: true,
        }, 'persist-attempt-1');

        expect(result.source).toBe('shared_schedule');
        expect(result.persisted).toBe(true);
        expect(result.reused).toBe(false);
        expect(prisma.tx.break.deleteMany).toHaveBeenCalled();
        expect(prisma.tx.break.createMany).toHaveBeenCalledWith({
            data: expect.arrayContaining([
                expect.objectContaining({ type: 'BREAK1', paid: true }),
                expect.objectContaining({ type: 'LUNCH', paid: false }),
                expect.objectContaining({ type: 'BREAK2', paid: true }),
            ]),
        });
        expect(prisma.tx.shift.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                locationId: 'location-1',
                AND: expect.arrayContaining([
                    {
                        OR: [
                            { userId: null },
                            { user: { is: { role: { in: ['MANAGER', 'STAFF'] }, deletedAt: null } } },
                        ],
                    },
                ]),
            }),
        }));
        expect(prisma.tx.creditTransaction.create.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.tx.break.deleteMany.mock.invocationCallOrder[0]);
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);

        const replay = await service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            persist: true,
        }, 'persist-attempt-1');
        expect(replay.reused).toBe(true);
        expect(replay.data).toEqual(result.data);
        expect(featureAccess.consumeCreditsForFeature).not.toHaveBeenCalled();
        expect(prisma.tx.break.deleteMany).toHaveBeenCalledOnce();
        expectTenantContextUsed(prisma);
    });

    it('maps persisted break records by paid/unpaid semantics', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([
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
        expect(result.data[0].breaks.map((entry: any) => entry.type)).toEqual(['break1', 'lunch', 'break2']);
        expect(prisma.tx.shift.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                AND: expect.arrayContaining([
                    {
                        OR: [
                            { userId: null },
                            { user: { is: { role: { in: ['MANAGER', 'STAFF'] }, deletedAt: null } } },
                        ],
                    },
                ]),
            }),
        }));
        expectTenantContextUsed(prisma);
    });

    it('preserves persisted break identity over paid/order fallback', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                userId: 'user-1',
                startTime: new Date('2026-03-05T09:00:00.000Z'),
                endTime: new Date('2026-03-05T17:00:00.000Z'),
                user: { id: 'user-1', name: 'Alex' },
                breaks: [
                    {
                        type: 'BREAK2',
                        startTime: new Date('2026-03-05T15:15:00.000Z'),
                        endTime: new Date('2026-03-05T15:25:00.000Z'),
                        paid: true,
                    },
                ],
            },
        ]);

        const result = await service.listLunchBreaks('tenant-1', {});

        expect(result.data[0].breaks).toEqual([
            expect.objectContaining({ type: 'break2' }),
        ]);
        expectTenantContextUsed(prisma);
    });

    it('lists shared schedule shifts before breaks have been generated', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                userId: 'user-1',
                startTime: new Date('2026-03-05T09:00:00.000Z'),
                endTime: new Date('2026-03-05T17:00:00.000Z'),
                user: { id: 'user-1', name: 'Alex' },
                breaks: [],
            },
        ]);

        const result = await service.listLunchBreaks('tenant-1', {
            startDate: '2026-03-05T00:00:00.000Z',
            endDate: '2026-03-06T00:00:00.000Z',
        });

        expect(result.data).toEqual([
            expect.objectContaining({
                shiftId: 'shift-1',
                userId: 'user-1',
                employeeName: 'Alex',
                breaks: [],
            }),
        ]);
        expectTenantContextUsed(prisma);
    });

    it('scopes staff lunch-break reads to their own assigned shifts', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([]);

        await service.listLunchBreaks('tenant-1', {}, {
            sub: 'staff-1',
            legacyRole: 'STAFF',
        });

        expect(prisma.tx.shift.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                tenantId: 'tenant-1',
                deletedAt: null,
                userId: 'staff-1',
                AND: expect.arrayContaining([
                    { schedule: { is: { status: 'PUBLISHED' } } },
                ]),
            }),
        }));
        expectTenantContextUsed(prisma);
    });

    it('hides draft lunch-break rows for refreshed staff sessions', async () => {
        await service.listLunchBreaks('tenant-1', {}, {
            sub: 'staff-1',
            role: 'Staff',
        });

        expect(prisma.tx.shift.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                userId: 'staff-1',
                AND: expect.arrayContaining([
                    { schedule: { is: { status: 'PUBLISHED' } } },
                ]),
            }),
        }));
    });

    it('updates a shift with manual break edits', async () => {
        prisma.tx.shift.findFirst
            .mockResolvedValueOnce({
                id: 'shift-1',
                userId: 'user-1',
                startTime: new Date('2026-03-05T09:00:00.000Z'),
                endTime: new Date('2026-03-05T17:00:00.000Z'),
                user: { id: 'user-1', name: 'Alex' },
                schedule: { id: 'schedule-1', status: 'DRAFT' },
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
        const result = await service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-1',
            breaks: [
                { type: 'break1', startTime: '2026-03-05T11:00:00.000Z', durationMinutes: 10 },
                { type: 'lunch', startTime: '2026-03-05T13:30:00.000Z', durationMinutes: 30 },
                { type: 'break2', skip: true },
            ],
        });

        expect(prisma.tx.break.deleteMany).toHaveBeenCalledWith({ where: { shiftId: 'shift-1' } });
        expect(prisma.tx.break.createMany).toHaveBeenCalledWith({
            data: expect.arrayContaining([
                expect.objectContaining({ type: 'BREAK1', paid: true }),
                expect.objectContaining({ type: 'LUNCH', paid: false }),
            ]),
        });
        expect(prisma.tx.schedule.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', id: { in: ['schedule-1'] }, status: 'DRAFT', deletedAt: null },
            data: { revision: { increment: 1 } },
        });
        expect(result.breaks.map((entry: any) => entry.type)).toEqual(['break1', 'lunch']);
        expectTenantContextUsed(prisma);
    });

    it('rejects overlapping manual break edits before replacing persisted breaks', async () => {
        prisma.tx.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            schedule: { status: 'DRAFT' },
            user: { id: 'user-1', name: 'Alex' },
            breaks: [],
        });

        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-1',
            breaks: [
                { type: 'break1', startTime: '2026-03-05T11:30:00.000Z', durationMinutes: 60 },
                { type: 'lunch', startTime: '2026-03-05T12:00:00.000Z', durationMinutes: 30 },
            ],
        })).rejects.toThrow('Break windows cannot overlap.');

        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expect(prisma.tx.break.createMany).not.toHaveBeenCalled();
        expectTenantContextUsed(prisma);
    });

    it('rejects ambiguous manual break timestamps before replacing persisted breaks', async () => {
        prisma.tx.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            schedule: { status: 'DRAFT' },
            user: { id: 'user-1', name: 'Alex' },
            breaks: [],
        });

        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-1',
            breaks: [
                { type: 'lunch', startTime: '03/05/2026 13:30', durationMinutes: 30 },
            ],
        })).rejects.toThrow('Invalid lunch startTime');

        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expect(prisma.tx.break.createMany).not.toHaveBeenCalled();
        expectTenantContextUsed(prisma);
    });

    it('persists setup shifts inside tenant-scoped Prisma context', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([
            { id: 'shift-1', locationId: 'location-1', schedule: { status: 'DRAFT' } },
        ]);

        const result = await service.persistSetupShifts('tenant-1', {
            locationId: 'location-1',
            rows: [
                {
                    shiftId: 'shift-1',
                    userId: 'user-1',
                    employeeName: 'Alex',
                    startTime: '2026-03-05T09:00:00.000Z',
                    endTime: '2026-03-05T17:00:00.000Z',
                },
            ],
        });

        expect(result.shiftIds).toEqual(['shift-1']);
        expect(prisma.tx.user.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'user-1',
                tenantId: 'tenant-1',
                deletedAt: null,
                role: { in: ['MANAGER', 'STAFF'] },
            },
            select: { id: true },
        });
        expect(prisma.tx.shift.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'shift-1', tenantId: 'tenant-1', deletedAt: null },
        }));
        expectTenantContextUsed(prisma);
    });

    it('creates setup shifts only at the explicitly selected tenant location', async () => {
        prisma.tx.location.findFirst.mockResolvedValue({ id: 'location-2' });

        const result = await service.persistSetupShifts('tenant-1', {
            locationId: 'location-2',
            rows: [{
                userId: 'user-1',
                startTime: '2026-03-05T17:00:00.000Z',
                endTime: '2026-03-06T01:00:00.000Z',
            }],
        });

        expect(result.shiftIds).toEqual(['created-shift-1']);
        expect(prisma.tx.location.findFirst).toHaveBeenCalledWith({
            where: { id: 'location-2', tenantId: 'tenant-1', deletedAt: null },
            select: { id: true },
        });
        expect(prisma.tx.shift.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ tenantId: 'tenant-1', locationId: 'location-2' }),
            select: { id: true },
        });
    });

    it('rejects setup shift updates from a different location', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([
            { id: 'shift-1', locationId: 'location-1', scheduleId: null, schedule: null },
        ]);

        await expect(service.persistSetupShifts('tenant-1', {
            locationId: 'location-2',
            rows: [{
                shiftId: 'shift-1',
                startTime: '2026-03-05T17:00:00.000Z',
                endTime: '2026-03-06T01:00:00.000Z',
            }],
        })).rejects.toThrow('Setup shifts must belong to the selected location');

        expect(prisma.tx.shift.updateMany).not.toHaveBeenCalled();
    });

    it('requires an explicit location instead of selecting the tenant first location', async () => {
        await expect(service.persistSetupShifts('tenant-1', {
            rows: [{
                startTime: '2026-03-05T17:00:00.000Z',
                endTime: '2026-03-06T01:00:00.000Z',
            }],
        })).rejects.toThrow('A location is required');

        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects manual break edits on published schedule shifts', async () => {
        prisma.tx.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            schedule: { status: 'PUBLISHED' },
            user: { id: 'user-1', name: 'Alex' },
            breaks: [],
        });

        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-1',
            breaks: [{ type: 'lunch', startTime: '2026-03-05T13:30:00.000Z', durationMinutes: 30 }],
        })).rejects.toThrow('Published schedules are locked');

        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expectTenantContextUsed(prisma);
    });

    it('rejects break edits when publish wins before the schedule row lock', async () => {
        prisma.tx.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            schedule: { id: 'schedule-1', status: 'DRAFT' },
            user: { id: 'user-1', name: 'Alex' },
            breaks: [],
        });
        prisma.tx.$queryRaw.mockImplementation(async (query: any) => {
            const sql = Array.isArray(query) ? query.join(' ') : String(query);
            return sql.includes('FROM "Schedule"') && sql.includes('FOR UPDATE')
                ? [{ id: 'schedule-1', status: 'PUBLISHED' }]
                : [];
        });

        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-1',
            breaks: [{ type: 'lunch', startTime: '2026-03-05T13:30:00.000Z', durationMinutes: 30 }],
        })).rejects.toThrow('Published schedules are locked');
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects persisting generated breaks on published schedule shifts', async () => {
        prisma.tx.shift.findMany
            .mockResolvedValueOnce([
                {
                    id: 'shift-1',
                    userId: 'user-1',
                    startTime: new Date('2026-03-05T09:00:00.000Z'),
                    endTime: new Date('2026-03-05T17:00:00.000Z'),
                    user: { id: 'user-1', name: 'Alex' },
                },
            ])
            .mockResolvedValueOnce([
                { id: 'shift-1', schedule: { status: 'PUBLISHED' } },
            ]);

        await expect(service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            persist: true,
        }, 'published-attempt-1')).rejects.toThrow('Published schedules are locked');

        expect(featureAccess.consumeCreditsForFeature).not.toHaveBeenCalled();
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expectTenantContextUsed(prisma);
    });

    it('requires the selected location and rejects a shift outside it before persistence', async () => {
        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            breaks: [],
        })).rejects.toThrow('locationId is required');
        expect(prisma.$transaction).not.toHaveBeenCalled();

        prisma.tx.shift.findFirst.mockResolvedValue(null);
        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-2',
            breaks: [],
        })).rejects.toThrow('Shift not found for the selected location');

        expect(prisma.tx.shift.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'shift-1',
                tenantId: 'tenant-1',
                locationId: 'location-2',
            }),
        }));
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
    });

    it('rejects a stale shift snapshot before debiting credits or replacing breaks', async () => {
        const startTime = new Date('2026-03-05T09:00:00.000Z');
        const endTime = new Date('2026-03-05T17:00:00.000Z');
        const calculatedAt = new Date('2026-03-05T08:00:00.000Z');
        prisma.tx.shift.findMany
            .mockResolvedValueOnce([{
                id: 'shift-1',
                userId: 'user-1',
                scheduleId: 'schedule-1',
                startTime,
                endTime,
                updatedAt: calculatedAt,
                user: { id: 'user-1', name: 'Alex' },
            }])
            .mockResolvedValueOnce([{
                id: 'shift-1',
                scheduleId: 'schedule-1',
                startTime,
                endTime,
                updatedAt: calculatedAt,
                schedule: { status: 'DRAFT' },
            }])
            .mockResolvedValueOnce([{
                id: 'shift-1',
                scheduleId: 'schedule-1',
                startTime,
                endTime,
                updatedAt: new Date('2026-03-05T08:01:00.000Z'),
                schedule: { status: 'DRAFT' },
            }]);

        await expect(service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            persist: true,
        }, 'stale-snapshot-attempt'))
            .rejects
            .toThrow('changed after break calculation');

        expect(prisma.state.usageCredits).toBe(100);
        expect(prisma.creditTransactions.size).toBe(0);
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expect(Array.from(prisma.generationRequests.values())[0]).toEqual(expect.objectContaining({
            status: 'FAILED',
            claimToken: null,
            claimExpiresAt: null,
        }));
    });

    it('rolls back an atomic wallet debit and reuses the failed outcome when persistence fails', async () => {
        const startTime = new Date('2026-03-05T09:00:00.000Z');
        const endTime = new Date('2026-03-05T17:00:00.000Z');
        const updatedAt = new Date('2026-03-05T08:00:00.000Z');
        prisma.tx.shift.findMany
            .mockResolvedValueOnce([{
                id: 'shift-1',
                userId: 'user-1',
                scheduleId: 'schedule-1',
                startTime,
                endTime,
                updatedAt,
                user: { id: 'user-1', name: 'Alex' },
            }])
            .mockResolvedValueOnce([{
                id: 'shift-1',
                scheduleId: 'schedule-1',
                startTime,
                endTime,
                updatedAt,
                schedule: { status: 'DRAFT' },
            }])
            .mockResolvedValueOnce([{
                id: 'shift-1',
                scheduleId: 'schedule-1',
                startTime,
                endTime,
                updatedAt,
                schedule: { status: 'DRAFT' },
            }]);
        prisma.tx.break.createMany.mockRejectedValue(new Error('database write failed'));

        await expect(service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            persist: true,
        }, 'failed-attempt-1'))
            .rejects
            .toThrow('database write failed');

        expect(prisma.tx.break.deleteMany).toHaveBeenCalledOnce();
        expect(prisma.tx.creditTransaction.create).toHaveBeenCalledOnce();
        expect(prisma.state.usageCredits).toBe(100);
        expect(prisma.creditTransactions.size).toBe(0);
        expect(featureAccess.consumeCreditsForFeature).not.toHaveBeenCalled();
        expect(Array.from(prisma.generationRequests.values())[0]).toEqual(expect.objectContaining({
            status: 'FAILED',
            failureMessage: 'database write failed',
            claimToken: null,
            claimExpiresAt: null,
        }));

        await expect(service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            persist: true,
        }, 'failed-attempt-1'))
            .rejects
            .toThrow('database write failed');
        expect(featureAccess.consumeCreditsForFeature).not.toHaveBeenCalled();
        expect(prisma.tx.break.deleteMany).toHaveBeenCalledOnce();
        expect(prisma.tx.creditTransaction.create).toHaveBeenCalledOnce();
        expect(prisma.state.usageCredits).toBe(100);
        expect(prisma.creditTransactions.size).toBe(0);
    });
});
