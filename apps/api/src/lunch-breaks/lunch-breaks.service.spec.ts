import { ForbiddenException } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeBoundedListCursor } from '../common/bounded-pagination';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { LunchBreaksService } from './lunch-breaks.service';
import { setupShiftsRequestHash } from './setup-shifts-idempotency';

function buildPrismaMock() {
    const generationRequests = new Map<string, any>();
    const creditTransactions = new Map<string, any>();
    const auditLogs: any[] = [];
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
        if (where.failureStatus !== undefined && request.failureStatus !== where.failureStatus) return false;
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
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn(async (query: any, ...values: any[]): Promise<any[]> => {
            if (sqlText(query).includes('FROM "User"')) {
                return [{ id: 'user-1' }];
            }
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
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
        auditLog: {
            findFirst: vi.fn(async ({ where }: any) => auditLogs.find((entry) => (
                entry.tenantId === where.tenantId
                && entry.action === where.action
                && entry.resource === where.resource
                && entry.resourceId === where.resourceId
            )) ? { newValue: auditLogs.find((entry) => (
                entry.tenantId === where.tenantId
                && entry.action === where.action
                && entry.resource === where.resource
                && entry.resourceId === where.resourceId
            )).newValue } : null),
            create: vi.fn(async ({ data }: any) => {
                auditLogs.push(structuredClone(data));
                return data;
            }),
        },
    };

    return {
        $transaction: vi.fn(async (fn: any) => {
            const requestSnapshot = cloneMap(generationRequests);
            const creditSnapshot = cloneMap(creditTransactions);
            const auditSnapshot = structuredClone(auditLogs);
            const balanceSnapshot = state.usageCredits;
            try {
                return await fn(tx);
            } catch (error) {
                restoreMap(generationRequests, requestSnapshot);
                restoreMap(creditTransactions, creditSnapshot);
                auditLogs.splice(0, auditLogs.length, ...auditSnapshot);
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
            updateMany: vi.fn(),
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
        auditLog: {
            findFirst: vi.fn(),
            create: vi.fn(),
        },
        generationRequests,
        creditTransactions,
        auditLogs,
        state,
        tx,
    };
}

function expectTenantContextUsed(prisma: ReturnType<typeof buildPrismaMock>) {
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.tx.$executeRaw).toHaveBeenCalled();
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
        prisma.break.updateMany,
        prisma.lunchBreakGenerationRequest.findUnique,
        prisma.lunchBreakGenerationRequest.upsert,
        prisma.lunchBreakGenerationRequest.update,
        prisma.lunchBreakGenerationRequest.updateMany,
        prisma.creditTransaction.create,
        prisma.auditLog.findFirst,
        prisma.auditLog.create,
    ]) {
        expect(delegate).not.toHaveBeenCalled();
    }
}

describe('LunchBreaksService', () => {
    let prisma: ReturnType<typeof buildPrismaMock>;
    let featureAccess: {
        assertFeatureEnabled: ReturnType<typeof vi.fn>;
        assertFeatureEntitled: ReturnType<typeof vi.fn>;
        resolveTenantFeatures: ReturnType<typeof vi.fn>;
        lockTenantInTransaction: ReturnType<typeof vi.fn>;
        assertFeatureEnabledInTransaction: ReturnType<typeof vi.fn>;
        assertFeatureEntitledInTransaction: ReturnType<typeof vi.fn>;
        recordFeatureUsageInTransaction: ReturnType<typeof vi.fn>;
    };
    let service: LunchBreaksService;

    beforeEach(() => {
        prisma = buildPrismaMock();
        featureAccess = {
            assertFeatureEnabled: vi.fn().mockResolvedValue({ enabled: true }),
            assertFeatureEntitled: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', creditCost: 2 }),
            lockTenantInTransaction: vi.fn().mockResolvedValue(undefined),
            assertFeatureEnabledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', creditCost: 2, reason: 'Billable' }),
            assertFeatureEntitledInTransaction: vi.fn().mockResolvedValue({ enabled: true, source: 'credits', creditCost: 2, reason: 'Entitled' }),
            recordFeatureUsageInTransaction: vi.fn(async (
                tx: any,
                tenantId: string,
                resolution: { creditCost: number },
                reason: string,
                _operationId: string,
                transactionId?: string,
            ) => {
                const cost = Number(resolution.creditCost);
                if (!transactionId?.startsWith('lunch-break-credit-')) {
                    return { consumedCredits: cost, newBalance: 98 };
                }
                if (prisma.state.usageCredits < cost) {
                    throw new ForbiddenException('Insufficient usage credits balance.');
                }
                prisma.state.usageCredits -= cost;
                await tx.creditTransaction.create({
                    data: {
                        id: transactionId,
                        tenantId,
                        amount: -cost,
                        debtAmount: 0,
                        reason,
                        balanceAfter: prisma.state.usageCredits,
                        debtAfter: 0,
                    },
                });
                return { consumedCredits: cost, newBalance: prisma.state.usageCredits };
            }),
            resolveTenantFeatures: vi.fn().mockResolvedValue({
                features: { lunch_breaks: { enabled: true, source: 'credits', creditCost: 2 } },
                usageCredits: 100,
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

    it('allows zero-credit active paid tenants to read policy and lunch rows without ledger mutation', async () => {
        featureAccess.assertFeatureEnabled.mockRejectedValue(new ForbiddenException('Positive wallet required'));
        prisma.tx.shift.findMany.mockResolvedValue([]);

        await expect(service.getPolicy('tenant-1')).resolves.toEqual(expect.objectContaining({
            lunchDurationMinutes: 30,
        }));
        await expect(service.listLunchBreaks('tenant-1', {})).resolves.toEqual(expect.objectContaining({
            data: [],
        }));

        expect(featureAccess.assertFeatureEntitled).toHaveBeenCalledTimes(2);
        expect(featureAccess.assertFeatureEntitled).toHaveBeenCalledWith('tenant-1', 'lunch_breaks');
        expect(featureAccess.assertFeatureEnabled).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it('allows a zero-credit active paid tenant to update policy without ledger mutation', async () => {
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(
            new ForbiddenException('Positive wallet required'),
        );

        await expect(service.updatePolicy('tenant-1', { lunchDurationMinutes: 45 }))
            .resolves.toEqual(expect.objectContaining({ lunchDurationMinutes: 45 }));

        expect(featureAccess.assertFeatureEntitledInTransaction).toHaveBeenCalledWith(
            prisma.tx,
            'tenant-1',
            'lunch_breaks',
        );
        expect(featureAccess.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'setup shift persistence',
            feature: 'scheduling',
            transactions: 3,
            mutate: () => service.persistSetupShifts('tenant-1', {
                locationId: 'location-1',
                rows: [{
                    startTime: '2026-03-05T09:00:00.000Z',
                    endTime: '2026-03-05T17:00:00.000Z',
                }],
            }, 'setup-entitlement-loss'),
        },
    ])('denies $name from inside its write transaction when entitlement changes', async ({ mutate, feature, transactions }) => {
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(
            new ForbiddenException('Subscription inactive or credits exhausted'),
        );

        await expect(mutate()).rejects.toBeInstanceOf(ForbiddenException);

        expect(featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledWith(
            prisma.tx,
            'tenant-1',
            feature,
        );
        expect(prisma.$transaction).toHaveBeenCalledTimes(transactions);
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.tx.tenantSetting.upsert).not.toHaveBeenCalled();
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expect(prisma.tx.shift.create).not.toHaveBeenCalled();
        expect(prisma.tx.shift.updateMany).not.toHaveBeenCalled();
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
        expect(Array.from(prisma.creditTransactions.values())[0]).toEqual(expect.objectContaining({
            amount: -2,
            reason: expect.stringMatching(/^Lunch\/Break generation \(.+\)$/),
            balanceAfter: 98,
        }));
    });

    it.each([
        { label: 'plan entitlement', source: 'plan', creditCost: 2 },
        { label: 'Stripe entitlement', source: 'stripe', creditCost: 2 },
        { label: 'zero-cost credit entitlement', source: 'credits', creditCost: 0 },
        { label: 'missing-cost credit entitlement', source: 'credits', creditCost: null },
    ])('rejects $label without a debit or successful generation', async ({ source, creditCost }) => {
        featureAccess.assertFeatureEnabledInTransaction.mockResolvedValue({
            enabled: true,
            source,
            creditCost,
            reason: 'Legacy included usage',
        });

        await expect(service.generateLunchBreaks('tenant-1', {
            shifts: [{
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
                employeeName: 'Alex',
            }],
        }, 'invalid-credit-entitlement')).rejects.toThrow(
            'Lunch/break generation requires an active paid subscription and separately purchased usage credits.',
        );

        expect(prisma.state.usageCredits).toBe(100);
        expect(prisma.creditTransactions.size).toBe(0);
        expect(prisma.tx.creditTransaction.create).not.toHaveBeenCalled();
        expect(Array.from(prisma.generationRequests.values())[0]).toEqual(expect.objectContaining({
            status: 'FAILED',
            response: null,
            creditConsumption: null,
        }));
    });

    it('retries the identical generation intent after a paid subscription is restored', async () => {
        const input = {
            shifts: [{
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
                employeeName: 'Alex',
            }],
        };
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValueOnce(
            new ForbiddenException('Paid subscription is inactive.'),
        );

        await expect(service.generateLunchBreaks('tenant-1', input, 'subscription-restored-intent'))
            .rejects.toThrow('Paid subscription is inactive.');
        expect(Array.from(prisma.generationRequests.values())[0]).toEqual(expect.objectContaining({
            status: 'FAILED',
            failureStatus: 403,
            attempts: 1,
        }));

        const recovered = await service.generateLunchBreaks('tenant-1', input, 'subscription-restored-intent');

        expect(recovered).toEqual(expect.objectContaining({ reused: false }));
        expect(Array.from(prisma.generationRequests.values())[0]).toEqual(expect.objectContaining({
            status: 'SUCCEEDED',
            attempts: 2,
            failureStatus: null,
        }));
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);
    });

    it('retries the identical generation intent after separately purchased credits are restored', async () => {
        const input = {
            shifts: [{
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
                employeeName: 'Alex',
            }],
        };
        prisma.state.usageCredits = 0;

        await expect(service.generateLunchBreaks('tenant-1', input, 'credits-restored-intent'))
            .rejects.toThrow('Insufficient usage credits balance.');
        expect(prisma.creditTransactions.size).toBe(0);
        expect(Array.from(prisma.generationRequests.values())[0]).toEqual(expect.objectContaining({
            status: 'FAILED',
            failureStatus: 403,
            attempts: 1,
        }));

        prisma.state.usageCredits = 100;
        const recovered = await service.generateLunchBreaks('tenant-1', input, 'credits-restored-intent');

        expect(recovered).toEqual(expect.objectContaining({ reused: false }));
        expect(Array.from(prisma.generationRequests.values())[0]).toEqual(expect.objectContaining({
            status: 'SUCCEEDED',
            attempts: 2,
        }));
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);
    });

    it('allows only one caller to reclaim a recoverable failed generation intent', async () => {
        const input = {
            shifts: [{
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
                employeeName: 'Alex',
            }],
        };
        prisma.state.usageCredits = 0;
        await expect(service.generateLunchBreaks('tenant-1', input, 'failed-two-tab-intent'))
            .rejects.toThrow('Insufficient usage credits balance.');

        prisma.state.usageCredits = 100;
        let releasePolicy!: () => void;
        const policyGate = new Promise<void>((resolve) => {
            releasePolicy = resolve;
        });
        prisma.tx.tenantSetting.findUnique.mockImplementationOnce(async () => {
            await policyGate;
            return null;
        });

        const winner = service.generateLunchBreaks('tenant-1', input, 'failed-two-tab-intent');
        await vi.waitFor(() => expect(Array.from(prisma.generationRequests.values())[0]).toEqual(
            expect.objectContaining({ status: 'PENDING', attempts: 2 }),
        ));
        await expect(service.generateLunchBreaks('tenant-1', input, 'failed-two-tab-intent'))
            .rejects.toThrow('already in progress');

        releasePolicy();
        await expect(winner).resolves.toEqual(expect.objectContaining({ reused: false }));
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);
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

    });

    it('rejects an empty generation before charging', async () => {
        await expect(service.generateLunchBreaks('tenant-1', { shifts: [] }, 'empty-attempt-1'))
            .rejects
            .toThrow('Add at least one valid shift');

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
                            { user: { is: { role: { in: ['MANAGER', 'STAFF'] }, deletedAt: null, suspendedAt: null } } },
                        ],
                    },
                ]),
            }),
        }));
        expect(prisma.tx.creditTransaction.create.mock.invocationCallOrder[0])
            .toBeLessThan(prisma.tx.break.deleteMany.mock.invocationCallOrder[0]);
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);

        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(
            new Error('Subscription is no longer active'),
        );
        const replay = await service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            persist: true,
        }, 'persist-attempt-1');
        expect(replay.reused).toBe(true);
        expect(replay.data).toEqual(result.data);
        expect(featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledOnce();
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
                            { user: { is: { role: { in: ['MANAGER', 'STAFF'] }, deletedAt: null, suspendedAt: null } } },
                        ],
                    },
                ]),
            }),
        }));
        expectTenantContextUsed(prisma);
    });

    it('bounds lunch-break rows and applies an ascending continuation cursor', async () => {
        prisma.tx.shift.findMany
            .mockResolvedValueOnce([
                {
                    id: 'shift-1',
                    userId: 'user-1',
                    startTime: new Date('2026-03-05T09:00:00.000Z'),
                    endTime: new Date('2026-03-05T17:00:00.000Z'),
                    user: { id: 'user-1', name: 'Alex' },
                    breaks: [],
                },
                {
                    id: 'shift-2',
                    userId: 'user-2',
                    startTime: new Date('2026-03-05T09:00:00.000Z'),
                    endTime: new Date('2026-03-05T17:00:00.000Z'),
                    user: { id: 'user-2', name: 'Blair' },
                    breaks: [],
                },
                {
                    id: 'shift-3',
                    userId: 'user-3',
                    startTime: new Date('2026-03-05T10:00:00.000Z'),
                    endTime: new Date('2026-03-05T18:00:00.000Z'),
                    user: { id: 'user-3', name: 'Casey' },
                    breaks: [],
                },
            ])
            .mockResolvedValueOnce([]);

        const firstPage = await service.listLunchBreaks('tenant-1', {
            startDate: '2026-03-05T00:00:00.000Z',
            endDate: '2026-03-06T00:00:00.000Z',
            limit: '2',
        });
        const cursor = decodeBoundedListCursor(firstPage.pagination.nextCursor);

        expect(firstPage.data.map((row: any) => row.shiftId)).toEqual(['shift-1', 'shift-2']);
        expect(firstPage.pagination).toMatchObject({
            limit: 2,
            returned: 2,
            hasMore: true,
            window: {
                startDate: '2026-03-05T00:00:00.000Z',
                endDate: '2026-03-06T00:00:00.000Z',
            },
        });
        expect(cursor).toEqual({
            timestamp: new Date('2026-03-05T09:00:00.000Z'),
            id: 'shift-2',
        });
        expect(prisma.tx.shift.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
            orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
            take: 3,
        }));

        await service.listLunchBreaks('tenant-1', {
            startDate: '2026-03-05T00:00:00.000Z',
            endDate: '2026-03-06T00:00:00.000Z',
            limit: '2',
            cursor: firstPage.pagination.nextCursor,
        });

        expect(prisma.tx.shift.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({
                AND: expect.arrayContaining([{
                    OR: [
                        { startTime: { gt: new Date('2026-03-05T09:00:00.000Z') } },
                        { startTime: new Date('2026-03-05T09:00:00.000Z'), id: { gt: 'shift-2' } },
                    ],
                }]),
            }),
            orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
            take: 3,
        }));
    });

    it('rejects invalid lunch-break pagination before querying shifts', async () => {
        await expect(service.listLunchBreaks('tenant-1', {
            limit: '201',
        })).rejects.toThrow('Invalid limit');

        await expect(service.listLunchBreaks('tenant-1', {
            startDate: '2026-03-06T00:00:00.000Z',
            endDate: '2026-03-05T00:00:00.000Z',
        })).rejects.toThrow('endDate must be after startDate');

        expect(prisma.tx.shift.findMany).not.toHaveBeenCalled();
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
        const entitlement = { enabled: true, source: 'credits', creditCost: 2, reason: 'Billable' };
        featureAccess.assertFeatureEnabledInTransaction.mockResolvedValue(entitlement);
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
        }, 'shift-break-update-1', { sub: 'manager-1' });

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
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledWith(
            prisma.tx,
            'tenant-1',
            entitlement,
            expect.stringMatching(/^Lunch\/break shift replacement \([a-f0-9]{64}\)$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
        );
        expect(prisma.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                userId: 'manager-1',
                action: 'LUNCH_BREAK_SHIFT_REPLACED',
                resource: 'LunchBreakShiftUpdateRequest',
            }),
        }));
        expect(result.breaks.map((entry: any) => entry.type)).toEqual(['break1', 'lunch']);
        expectTenantContextUsed(prisma);
    });

    it('replays a lost manual-break response without another debit, write, or revision', async () => {
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
                breaks: [{
                    id: 'break-1',
                    type: 'LUNCH',
                    startTime: new Date('2026-03-05T13:30:00.000Z'),
                    endTime: new Date('2026-03-05T14:00:00.000Z'),
                    paid: false,
                }],
            });
        const body = {
            locationId: 'location-1',
            breaks: [{ type: 'lunch' as const, startTime: '2026-03-05T13:30:00.000Z', durationMinutes: 30 }],
        };

        const first = await service.updateShiftBreaks('tenant-1', 'shift-1', body, 'break-replay-1');
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(new ForbiddenException('Credits exhausted'));
        const replay = await service.updateShiftBreaks('tenant-1', 'shift-1', body, 'break-replay-1');

        expect(replay).toEqual(first);
        expect(featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledOnce();
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.tx.break.deleteMany).toHaveBeenCalledOnce();
        expect(prisma.tx.schedule.updateMany).toHaveBeenCalledOnce();
        expect(prisma.tx.auditLog.create).toHaveBeenCalledOnce();
    });

    it('rejects manual-break request drift on a used key without another debit or write', async () => {
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
                breaks: [{
                    id: 'break-1',
                    type: 'LUNCH',
                    startTime: new Date('2026-03-05T13:30:00.000Z'),
                    endTime: new Date('2026-03-05T14:00:00.000Z'),
                    paid: false,
                }],
            });
        const body = {
            locationId: 'location-1',
            breaks: [{ type: 'lunch' as const, startTime: '2026-03-05T13:30:00.000Z', durationMinutes: 30 }],
        };
        await service.updateShiftBreaks('tenant-1', 'shift-1', body, 'break-drift-1');

        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            ...body,
            breaks: [{ ...body.breaks[0], durationMinutes: 45 }],
        }, 'break-drift-1')).rejects.toThrow('different shift lunch/break request');

        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.tx.break.deleteMany).toHaveBeenCalledOnce();
        expect(prisma.tx.schedule.updateMany).toHaveBeenCalledOnce();
        expect(prisma.tx.auditLog.create).toHaveBeenCalledOnce();
    });

    it('returns a semantic no-op without entitlement, debit, write, reservation, or revision', async () => {
        prisma.tx.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            user: { id: 'user-1', name: 'Alex' },
            schedule: { id: 'schedule-1', status: 'DRAFT' },
            breaks: [{
                id: 'break-1',
                type: 'LUNCH',
                startTime: new Date('2026-03-05T13:30:00.000Z'),
                endTime: new Date('2026-03-05T14:00:00.000Z'),
                paid: false,
            }],
        });
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(new ForbiddenException('No credits'));

        const result = await service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-1',
            breaks: [{ type: 'lunch', startTime: '2026-03-05T13:30:00.000Z', durationMinutes: 30 }],
        }, 'break-no-op-1');

        expect(result.breaks).toEqual([expect.objectContaining({ type: 'lunch', durationMinutes: 30 })]);
        expect(featureAccess.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expect(prisma.tx.break.createMany).not.toHaveBeenCalled();
        expect(prisma.tx.schedule.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects a distinct manual-break value change at zero credits before any write or audit', async () => {
        prisma.tx.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            user: { id: 'user-1', name: 'Alex' },
            schedule: { id: 'schedule-1', status: 'DRAFT' },
            breaks: [],
        });
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(new ForbiddenException('Insufficient usage credits'));

        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-1',
            breaks: [{ type: 'lunch', startTime: '2026-03-05T13:30:00.000Z', durationMinutes: 30 }],
        }, 'break-zero-credit-1')).rejects.toMatchObject({
            status: 403,
            response: expect.objectContaining({ code: 'SHIFT_BREAKS_ENTITLEMENT_REQUIRED' }),
        });

        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expect(prisma.tx.schedule.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('rolls back the manual-break debit when domain persistence fails', async () => {
        prisma.state.usageCredits = 2;
        featureAccess.recordFeatureUsageInTransaction.mockImplementation(async () => {
            prisma.state.usageCredits -= 2;
            return { consumedCredits: 2, newBalance: prisma.state.usageCredits };
        });
        prisma.tx.shift.findFirst.mockResolvedValue({
            id: 'shift-1',
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            user: { id: 'user-1', name: 'Alex' },
            schedule: { id: 'schedule-1', status: 'DRAFT' },
            breaks: [],
        });
        prisma.tx.break.createMany.mockRejectedValue(new Error('break write failed'));

        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-1',
            breaks: [{ type: 'lunch', startTime: '2026-03-05T13:30:00.000Z', durationMinutes: 30 }],
        }, 'break-rollback-1')).rejects.toThrow('break write failed');

        expect(prisma.state.usageCredits).toBe(2);
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.tx.schedule.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.auditLog.create).not.toHaveBeenCalled();
        expect(prisma.auditLogs).toHaveLength(0);
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
        }, 'shift-break-overlap')).rejects.toThrow('Break windows cannot overlap.');

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
        }, 'shift-break-invalid-time')).rejects.toThrow('Invalid lunch startTime');

        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expect(prisma.tx.break.createMany).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('persists setup shifts inside tenant-scoped Prisma context', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                locationId: 'location-1',
                scheduleId: 'schedule-1',
                userId: 'user-1',
                startTime: new Date('2026-03-05T08:00:00.000Z'),
                endTime: new Date('2026-03-05T16:00:00.000Z'),
                schedule: {
                    status: 'DRAFT',
                    startDate: new Date('2026-03-05T00:00:00.000Z'),
                    endDate: new Date('2026-03-06T00:00:00.000Z'),
                },
            },
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
        }, 'setup-update-1');

        expect(result.shiftIds).toEqual(['shift-1']);
        const schedulableUserQuery = prisma.tx.$queryRaw.mock.calls.find(([query]: any[]) => (
            Array.from(query as ArrayLike<unknown>).join(' ').includes('FROM "User"')
        ));
        expect(schedulableUserQuery).toBeDefined();
        expect(Array.from(schedulableUserQuery?.[0] as ArrayLike<unknown>).join(' '))
            .toContain('"suspendedAt" IS NULL');
        expect(Array.from(schedulableUserQuery?.[0] as ArrayLike<unknown>).join(' '))
            .toContain('FOR UPDATE');
        expect(prisma.tx.shift.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: 'shift-1',
                tenantId: 'tenant-1',
                locationId: 'location-1',
                scheduleId: 'schedule-1',
                userId: 'user-1',
                startTime: new Date('2026-03-05T08:00:00.000Z'),
                endTime: new Date('2026-03-05T16:00:00.000Z'),
                deletedAt: null,
            }),
        }));
        const schedulingLockCall = prisma.tx.$executeRaw.mock.calls.findIndex((call: any[]) => (
            Array.from(call[0] as ArrayLike<unknown>).join(' ').includes('pg_advisory_xact_lock')
        ));
        expect(schedulingLockCall).toBeGreaterThanOrEqual(0);
        expect(featureAccess.lockTenantInTransaction.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.tx.$executeRaw.mock.invocationCallOrder[schedulingLockCall],
        );
        expect(prisma.tx.schedule.updateMany).toHaveBeenCalledWith({
            where: {
                tenantId: 'tenant-1',
                id: { in: ['schedule-1'] },
                status: 'DRAFT',
                deletedAt: null,
            },
            data: { revision: { increment: 1 } },
        });
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
        }, 'setup-create-1');

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

    it('requires a non-empty bounded setup batch before opening a transaction', async () => {
        await expect(service.persistSetupShifts('tenant-1', {
            locationId: 'location-1',
            rows: [],
        }, 'setup-empty')).rejects.toThrow('At least one setup shift row is required');

        await expect(service.persistSetupShifts('tenant-1', {
            locationId: 'location-1',
            rows: Array.from({ length: 201 }, (_, index) => ({
                startTime: new Date(Date.UTC(2026, 2, 5 + index, 9)).toISOString(),
                endTime: new Date(Date.UTC(2026, 2, 5 + index, 17)).toISOString(),
            })),
        }, 'setup-too-large')).rejects.toThrow('at most 200 rows');

        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects setup shifts outside their schedule before debit, write, or audit', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([{
            id: 'shift-1',
            locationId: 'location-1',
            scheduleId: 'schedule-1',
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            schedule: {
                status: 'DRAFT',
                startDate: new Date('2026-03-05T00:00:00.000Z'),
                endDate: new Date('2026-03-06T00:00:00.000Z'),
            },
        }]);

        await expect(service.persistSetupShifts('tenant-1', {
            locationId: 'location-1',
            rows: [{
                shiftId: 'shift-1',
                startTime: '2026-03-04T23:30:00.000Z',
                endTime: '2026-03-05T08:00:00.000Z',
            }],
        }, 'setup-schedule-bounds')).rejects.toThrow('schedule window');

        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.tx.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('rejects setup batch and stored-shift overlaps before debit, write, or audit', async () => {
        const overlappingRows = {
            locationId: 'location-1',
            rows: [
                {
                    userId: 'user-1',
                    startTime: '2026-03-05T09:00:00.000Z',
                    endTime: '2026-03-05T17:00:00.000Z',
                },
                {
                    userId: 'user-1',
                    startTime: '2026-03-05T16:00:00.000Z',
                    endTime: '2026-03-05T20:00:00.000Z',
                },
            ],
        };
        await expect(service.persistSetupShifts('tenant-1', overlappingRows, 'setup-batch-overlap'))
            .rejects.toThrow('cannot overlap');

        prisma.tx.shift.count.mockResolvedValueOnce(1);
        await expect(service.persistSetupShifts('tenant-1', {
            locationId: 'location-1',
            rows: [overlappingRows.rows[0]],
        }, 'setup-stored-overlap')).rejects.toThrow('already has a shift');

        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.tx.shift.create).not.toHaveBeenCalled();
        expect(prisma.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('translates dependent breaks before one debit and saves both windows atomically', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([{
            id: 'shift-1',
            locationId: 'location-1',
            scheduleId: null,
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            schedule: null,
        }]);
        prisma.tx.$queryRaw.mockImplementation(async (query: any) => {
            const sql = Array.isArray(query)
                ? query.join(' ')
                : Array.isArray(query?.strings)
                    ? query.strings.join(' ')
                    : String(query);
            return sql.includes('FROM "Break"')
                ? [{
                    id: 'break-1',
                    startTime: new Date('2026-03-05T12:00:00.000Z'),
                    endTime: new Date('2026-03-05T12:30:00.000Z'),
                }]
                : [];
        });

        await service.persistSetupShifts('tenant-1', {
            locationId: 'location-1',
            rows: [{
                shiftId: 'shift-1',
                startTime: '2026-03-05T10:00:00.000Z',
                endTime: '2026-03-05T18:00:00.000Z',
            }],
        }, 'setup-translate-breaks');

        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.tx.shift.updateMany).toHaveBeenCalledOnce();
        expect(prisma.tx.break.updateMany).toHaveBeenCalledWith({
            where: { id: 'break-1', shiftId: 'shift-1' },
            data: {
                startTime: new Date('2026-03-05T13:00:00.000Z'),
                endTime: new Date('2026-03-05T13:30:00.000Z'),
            },
        });
        expect(prisma.tx.auditLog.create).toHaveBeenCalledOnce();
    });

    it('rejects an unsafe break resize before debit, shift write, or audit', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([{
            id: 'shift-1',
            locationId: 'location-1',
            scheduleId: null,
            userId: 'user-1',
            startTime: new Date('2026-03-05T09:00:00.000Z'),
            endTime: new Date('2026-03-05T17:00:00.000Z'),
            schedule: null,
        }]);
        prisma.tx.$queryRaw.mockImplementation(async (query: any) => {
            const sql = Array.isArray(query)
                ? query.join(' ')
                : Array.isArray(query?.strings)
                    ? query.strings.join(' ')
                    : String(query);
            return sql.includes('FROM "Break"')
                ? [{
                    id: 'break-1',
                    startTime: new Date('2026-03-05T16:30:00.000Z'),
                    endTime: new Date('2026-03-05T17:00:00.000Z'),
                }]
                : [];
        });

        await expect(service.persistSetupShifts('tenant-1', {
            locationId: 'location-1',
            rows: [{
                shiftId: 'shift-1',
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T16:00:00.000Z',
            }],
        }, 'setup-unsafe-resize')).rejects.toThrow('existing lunch/break outside');

        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.tx.shift.updateMany).not.toHaveBeenCalled();
        expect(prisma.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('charges setup shift persistence once per operation rather than per row', async () => {
        prisma.tx.shift.create
            .mockResolvedValueOnce({ id: 'created-shift-1' })
            .mockResolvedValueOnce({ id: 'created-shift-2' });
        const entitlement = { enabled: true, source: 'credits', creditCost: 3, reason: 'Billable' };
        featureAccess.assertFeatureEnabledInTransaction.mockResolvedValue(entitlement);

        const result = await service.persistSetupShifts('tenant-1', {
            locationId: 'location-1',
            rows: [
                {
                    userId: 'user-1',
                    startTime: '2026-03-05T09:00:00.000Z',
                    endTime: '2026-03-05T17:00:00.000Z',
                },
                {
                    userId: 'user-1',
                    startTime: '2026-03-06T09:00:00.000Z',
                    endTime: '2026-03-06T17:00:00.000Z',
                },
            ],
        }, 'setup-two-rows-1');

        expect(result.shiftIds).toEqual(['created-shift-1', 'created-shift-2']);
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledWith(
            prisma.tx,
            'tenant-1',
            entitlement,
            expect.stringMatching(/^Lunch\/break setup shift persistence \([a-f0-9]{64}\)$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
        );
        expect(prisma.tx.shift.create).toHaveBeenCalledTimes(2);
        expect(prisma.tx.auditLog.create).toHaveBeenCalledOnce();
    });

    it('replays setup shift persistence after subscription loss without another debit or write', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                locationId: 'location-1',
                scheduleId: null,
                userId: null,
                startTime: new Date('2026-03-05T08:00:00.000Z'),
                endTime: new Date('2026-03-05T16:00:00.000Z'),
                schedule: null,
            },
        ]);
        const body = {
            locationId: 'location-1',
            rows: [{
                shiftId: 'shift-1',
                userId: 'user-1',
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
            }],
        };

        const first = await service.persistSetupShifts('tenant-1', body, 'setup-replay-1');
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(new ForbiddenException('Subscription inactive'));
        const replay = await service.persistSetupShifts('tenant-1', body, 'setup-replay-1');

        expect(replay).toEqual(first);
        expect(featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledOnce();
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.tx.shift.updateMany).toHaveBeenCalledOnce();
        expect(prisma.tx.auditLog.create).toHaveBeenCalledOnce();
    });

    it('semantically replays omitted-userId setup creation under a different key without a second shift or debit', async () => {
        prisma.state.usageCredits = 4;
        featureAccess.recordFeatureUsageInTransaction.mockImplementation(async () => {
            prisma.state.usageCredits -= 2;
            return { consumedCredits: 2, newBalance: prisma.state.usageCredits };
        });
        const body = {
            locationId: 'location-1',
            rows: [{
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
            }],
        };

        const first = await service.persistSetupShifts('tenant-1', body, 'setup-unassigned-replay-1');
        featureAccess.assertFeatureEnabledInTransaction.mockRejectedValue(new ForbiddenException('Subscription inactive'));
        const replay = await service.persistSetupShifts('tenant-1', {
            ...body,
            rows: [{ ...body.rows[0], userId: null }],
        }, 'setup-unassigned-replay-2');

        expect(first).toEqual({ shiftIds: ['created-shift-1'] });
        expect(replay).toEqual(first);
        expect(prisma.state.usageCredits).toBe(2);
        expect(featureAccess.assertFeatureEnabledInTransaction).toHaveBeenCalledOnce();
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.tx.shift.create).toHaveBeenCalledOnce();
        expect(prisma.tx.shift.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ userId: null }),
            select: { id: true },
        });
        expect(prisma.tx.auditLog.create).toHaveBeenCalledTimes(2);
        expect(prisma.auditLogs.map((entry) => entry.resource)).toEqual([
            'LunchBreakSetupShiftsRequest',
            'LunchBreakSetupShiftsSemanticRequest',
        ]);
    });

    it('rejects setup shift request drift without charging or writing', async () => {
        prisma.tx.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                locationId: 'location-1',
                scheduleId: null,
                userId: null,
                startTime: new Date('2026-03-05T08:00:00.000Z'),
                endTime: new Date('2026-03-05T16:00:00.000Z'),
                schedule: null,
            },
        ]);
        const firstBody = {
            locationId: 'location-1',
            rows: [{
                shiftId: 'shift-1',
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
            }],
        };
        await service.persistSetupShifts('tenant-1', firstBody, 'setup-drift-1');

        await expect(service.persistSetupShifts('tenant-1', {
            ...firstBody,
            rows: [{ ...firstBody.rows[0], endTime: '2026-03-05T18:00:00.000Z' }],
        }, 'setup-drift-1')).rejects.toThrow('different setup shift request');

        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.tx.shift.updateMany).toHaveBeenCalledOnce();
        expect(prisma.tx.auditLog.create).toHaveBeenCalledOnce();
    });

    it('uses a concurrent setup winner found after the scheduling lock before charging', async () => {
        const normalizedRequest = {
            locationId: 'location-1',
            rows: [{
                userId: 'user-1',
                startTime: '2026-03-05T09:00:00.000Z',
                endTime: '2026-03-05T17:00:00.000Z',
            }],
        };
        const requestHash = setupShiftsRequestHash(normalizedRequest);
        const response = { shiftIds: ['created-by-winner'] };
        prisma.tx.auditLog.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ newValue: { requestHash, response } });

        const result = await service.persistSetupShifts(
            'tenant-1',
            normalizedRequest,
            'setup-concurrent-1',
        );

        expect(result).toEqual(response);
        expect(featureAccess.assertFeatureEnabledInTransaction).not.toHaveBeenCalled();
        expect(featureAccess.recordFeatureUsageInTransaction).not.toHaveBeenCalled();
        expect(prisma.tx.shift.create).not.toHaveBeenCalled();
        expect(prisma.tx.shift.updateMany).not.toHaveBeenCalled();
    });

    it('rolls the setup debit back when any row write fails', async () => {
        prisma.state.usageCredits = 2;
        featureAccess.recordFeatureUsageInTransaction.mockImplementation(async () => {
            prisma.state.usageCredits -= 2;
            return { consumedCredits: 2, newBalance: prisma.state.usageCredits };
        });
        prisma.tx.shift.findMany.mockResolvedValue([
            {
                id: 'shift-1',
                locationId: 'location-1',
                scheduleId: null,
                userId: null,
                startTime: new Date('2026-03-05T08:00:00.000Z'),
                endTime: new Date('2026-03-05T16:00:00.000Z'),
                schedule: null,
            },
            {
                id: 'shift-2',
                locationId: 'location-1',
                scheduleId: null,
                userId: null,
                startTime: new Date('2026-03-06T08:00:00.000Z'),
                endTime: new Date('2026-03-06T16:00:00.000Z'),
                schedule: null,
            },
        ]);
        prisma.tx.shift.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });

        await expect(service.persistSetupShifts('tenant-1', {
            locationId: 'location-1',
            rows: [
                {
                    shiftId: 'shift-1',
                    startTime: '2026-03-05T09:00:00.000Z',
                    endTime: '2026-03-05T17:00:00.000Z',
                },
                {
                    shiftId: 'shift-2',
                    startTime: '2026-03-06T09:00:00.000Z',
                    endTime: '2026-03-06T17:00:00.000Z',
                },
            ],
        }, 'setup-rollback-1')).rejects.toThrow('changed while it was being saved');

        expect(prisma.state.usageCredits).toBe(2);
        expect(featureAccess.recordFeatureUsageInTransaction).toHaveBeenCalledOnce();
        expect(prisma.tx.auditLog.create).not.toHaveBeenCalled();
        expect(prisma.auditLogs).toHaveLength(0);
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
        }, 'setup-location-mismatch')).rejects.toThrow('Setup shifts must belong to the selected location');

        expect(prisma.tx.shift.updateMany).not.toHaveBeenCalled();
    });

    it('requires an explicit location instead of selecting the tenant first location', async () => {
        await expect(service.persistSetupShifts('tenant-1', {
            rows: [{
                startTime: '2026-03-05T17:00:00.000Z',
                endTime: '2026-03-06T01:00:00.000Z',
            }],
        }, 'setup-missing-location')).rejects.toThrow('A location is required');

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
        }, 'shift-break-published')).rejects.toThrow('Published schedules are locked');

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
        }, 'shift-break-publish-race')).rejects.toThrow('Published schedules are locked');
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

        expect(prisma.tx.break.deleteMany).not.toHaveBeenCalled();
        expectTenantContextUsed(prisma);
    });

    it('requires the selected location and rejects a shift outside it before persistence', async () => {
        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            breaks: [],
        }, 'shift-break-missing-location')).rejects.toThrow('locationId is required');
        expect(prisma.$transaction).not.toHaveBeenCalled();

        prisma.tx.shift.findFirst.mockResolvedValue(null);
        await expect(service.updateShiftBreaks('tenant-1', 'shift-1', {
            locationId: 'location-2',
            breaks: [],
        }, 'shift-break-location-mismatch')).rejects.toThrow('Shift not found for the selected location');

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
            failureStatus: 409,
            claimToken: null,
            claimExpiresAt: null,
        }));

        await expect(service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            persist: true,
        }, 'stale-snapshot-attempt')).rejects.toThrow('changed after break calculation');
        expect(prisma.tx.shift.findMany).toHaveBeenCalledTimes(3);
    });

    it('rolls back an atomic wallet debit and retries the identical intent after transient persistence failure', async () => {
        const startTime = new Date('2026-03-05T09:00:00.000Z');
        const endTime = new Date('2026-03-05T17:00:00.000Z');
        const updatedAt = new Date('2026-03-05T08:00:00.000Z');
        prisma.tx.shift.findMany.mockResolvedValue([{
            id: 'shift-1',
            userId: 'user-1',
            scheduleId: 'schedule-1',
            startTime,
            endTime,
            updatedAt,
            user: { id: 'user-1', name: 'Alex' },
            schedule: { status: 'DRAFT' },
        }]);
        prisma.tx.break.createMany.mockRejectedValueOnce(new Error('database write failed with sk_live_do_not_store'));

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
        expect(Array.from(prisma.generationRequests.values())[0]).toEqual(expect.objectContaining({
            status: 'FAILED',
            failureStatus: 503,
            failureMessage: 'Lunch/break generation failed.',
            claimToken: null,
            claimExpiresAt: null,
        }));

        const recovered = await service.generateLunchBreaks('tenant-1', {
            locationId: 'location-1',
            persist: true,
        }, 'failed-attempt-1');

        expect(recovered).toEqual(expect.objectContaining({ persisted: true, reused: false }));
        expect(JSON.stringify(Array.from(prisma.generationRequests.values()))).not.toContain('sk_live_do_not_store');
        expect(prisma.tx.break.deleteMany).toHaveBeenCalledTimes(2);
        expect(prisma.tx.creditTransaction.create).toHaveBeenCalledTimes(2);
        expect(prisma.state.usageCredits).toBe(98);
        expect(prisma.creditTransactions.size).toBe(1);
        expect(Array.from(prisma.generationRequests.values())[0]).toEqual(expect.objectContaining({
            status: 'SUCCEEDED',
            attempts: 2,
            failureStatus: null,
        }));
    });
});
