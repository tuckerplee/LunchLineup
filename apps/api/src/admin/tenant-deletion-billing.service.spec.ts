import { createHash, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { TenantDeletionBillingService } from './tenant-deletion-billing.service';

function sqlText(call: readonly unknown[]): string {
    const query = call[0] as { strings?: readonly string[] } | readonly string[];
    if (Array.isArray(query)) return query.join(' ');
    return (query as { strings?: readonly string[] })?.strings?.join(' ') ?? String(query);
}

async function scheduleSettlementSql(): Promise<{
    sql: string;
    provenanceSql: string;
    executeRaw: ReturnType<typeof vi.fn>;
    queryRaw: ReturnType<typeof vi.fn>;
}> {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const queryRaw = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
            candidateCount: 0,
            insertedCount: 0,
            lockedWebhookCount: 0,
            refundableWebhookCount: 0,
            terminalizedWebhookCount: 0,
            walletUpdateCount: 0,
        }]);
    const service = new TenantDeletionBillingService({} as any, () => ({
        finalizeTenantBillingForPurge: vi.fn(),
    } as any));
    await (service as any).terminalizePaidWorkForDeletion(
        { $executeRaw: executeRaw, $queryRaw: queryRaw },
        'tenant-1',
        new Date('2026-07-16T12:00:00.000Z'),
    );
    return {
        sql: Array.from(queryRaw.mock.calls[1][0] as readonly string[]).join(' '),
        provenanceSql: Array.from(queryRaw.mock.calls[0][0] as readonly string[]).join(' '),
        executeRaw,
        queryRaw,
    };
}

describe('TenantDeletionBillingService durable provider claims', () => {
    it('never enters the provider facade when the durable claim is already owned', async () => {
        const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };
        const tenantDb = {
            withPlatformAdmin: vi.fn((operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
        };
        const provider = vi.fn();
        const service = new TenantDeletionBillingService(tenantDb as any, () => ({
            finalizeTenantBillingForPurge: provider,
        } as any));

        await expect(service.reconcilePendingDeletionBillingCandidate('tenant-1')).resolves.toMatchObject({
            outcome: 'skipped',
            tenantId: 'tenant-1',
        });
        expect(provider).not.toHaveBeenCalled();
        const sql = sqlText(tx.$queryRaw.mock.calls[0]);
        expect(sql).toContain('"leaseOwner" IS NULL');
        expect(sql).toContain('"leaseExpiresAt" <=');
        expect(sql).toContain('"attemptCount" = reconciliation."attemptCount" + 1');
        expect(sql).toContain('RETURNING reconciliation."operationId"');
    });

    it('claims one bounded fair page ordered by retry time and original barrier order', async () => {
        const tx = {
            $queryRaw: vi.fn()
                .mockResolvedValueOnce([
                    { tenantId: 'old-failure' },
                    { tenantId: 'new-healthy' },
                ])
                .mockResolvedValueOnce([{ operationId: 'operation-old-failure' }])
                .mockResolvedValueOnce([{ operationId: 'operation-new-healthy' }]),
        };
        const tenantDb = {
            withPlatformAdmin: vi.fn((operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
        };
        const service = new TenantDeletionBillingService(tenantDb as any, () => ({
            finalizeTenantBillingForPurge: vi.fn(),
        } as any));

        const claims = await service.claimEligibleDeletionBillingCandidates(2);

        expect(claims.map((candidate) => candidate.tenantId)).toEqual(['old-failure', 'new-healthy']);
        expect(claims.map((candidate) => candidate.operationId)).toEqual([
            'operation-old-failure',
            'operation-new-healthy',
        ]);
        const candidateSql = sqlText(tx.$queryRaw.mock.calls[0]);
        expect(candidateSql).toContain('ORDER BY reconciliation."nextAttemptAt", reconciliation."barrierCreatedAt", reconciliation."tenantId"');
        expect(candidateSql).toContain('FOR UPDATE OF reconciliation SKIP LOCKED');
        expect((tx.$queryRaw.mock.calls[0][0] as any).values).toContain(2);
    });

    it('persists exponential backoff and releases only the exact lease owner and token', async () => {
        const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };
        const tenantDb = {
            withPlatformAdmin: vi.fn((operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
        };
        const service = new TenantDeletionBillingService(tenantDb as any, () => ({
            finalizeTenantBillingForPurge: vi.fn(),
        } as any));

        await (service as any).recordReconciliationFailure({
            tenantId: 'tenant-1',
            operationId: 'operation-1',
            leaseOwner: 'replica-1',
            leaseToken: 'fence-1',
        }, true);

        const call = tx.$executeRaw.mock.calls[0];
        const sql = sqlText(call);
        expect(sql).toContain('"nextAttemptAt"');
        expect(sql).toContain('POWER(2');
        expect(call).toContain('PROVIDER_OR_FINALIZATION_FAILED');
        expect(sql).toContain('"leaseOwner" =');
        expect(sql).toContain('"leaseToken" =');
        expect(call).toContain('replica-1');
        expect(call).toContain('fence-1');
        expect(call).toContain('operation-1');
    });

    it('revalidates the exact unexpired owner and token immediately before provider entry', async () => {
        const provider = vi.fn();
        const tx = {
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'tenant-1',
                    slug: 'tenant-1',
                    status: 'SUSPENDED',
                    deletedAt: null,
                    auditLogs: [{
                        id: 'audit-1',
                        userId: null,
                        actorUserId: null,
                        actorTenantId: null,
                        ipAddress: null,
                        userAgent: null,
                        createdAt: new Date('2026-07-16T12:00:00.000Z'),
                    }],
                }),
            },
            $executeRaw: vi.fn().mockResolvedValue(0),
        };
        const tenantDb = {
            withPlatformAdmin: vi.fn((operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
        };
        const service = new TenantDeletionBillingService(tenantDb as any, () => ({
            finalizeTenantBillingForPurge: provider,
        } as any));

        await expect(service.reconcileClaimedDeletionBillingCandidate({
            tenantId: 'tenant-1',
            operationId: 'tenant-deletion-audit-1',
            leaseOwner: 'stale-owner',
            leaseToken: 'stale-token',
        })).rejects.toThrow(/reconciliation failed/i);

        expect(provider).not.toHaveBeenCalled();
        expect(sqlText(tx.$executeRaw.mock.calls[0])).toContain('"leaseExpiresAt" >');
        expect(tx.$executeRaw.mock.calls[0]).toContain('stale-owner');
        expect(tx.$executeRaw.mock.calls[0]).toContain('stale-token');
    });

    it('rejects a claimed operation identity that does not match the active barrier', async () => {
        const provider = vi.fn();
        const tx = {
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'tenant-1',
                    slug: 'tenant-1',
                    status: 'SUSPENDED',
                    deletedAt: null,
                    auditLogs: [{
                        id: 'audit-1',
                        userId: null,
                        actorUserId: null,
                        actorTenantId: null,
                        ipAddress: null,
                        userAgent: null,
                        createdAt: new Date('2026-07-16T12:00:00.000Z'),
                    }],
                }),
            },
            $executeRaw: vi.fn().mockResolvedValue(1),
        };
        const tenantDb = {
            withPlatformAdmin: vi.fn((operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
        };
        const service = new TenantDeletionBillingService(tenantDb as any, () => ({
            finalizeTenantBillingForPurge: provider,
        } as any));

        await expect(service.reconcileClaimedDeletionBillingCandidate({
            tenantId: 'tenant-1',
            operationId: 'wrong-operation',
            leaseOwner: 'replica-1',
            leaseToken: 'fence-1',
        })).rejects.toThrow(/operation does not match/i);

        expect(provider).not.toHaveBeenCalled();
        expect(tx.$executeRaw).toHaveBeenCalledOnce();
        expect(tx.$executeRaw.mock.calls[0]).toContain('wrong-operation');
        expect(sqlText(tx.$executeRaw.mock.calls[0])).toContain('"leaseOwner" = NULL');
    });

    it('holds the lease until an aborted provider transport terminates, then records deadline backoff', async () => {
        const events: string[] = [];
        let providerContext: {
            operationId: string;
            signal: AbortSignal;
            providerDeadlineAtMs: number;
        } | undefined;
        const provider = vi.fn((_tenantId: string, context: typeof providerContext) => {
            providerContext = context;
            return new Promise((resolve) => {
                context?.signal.addEventListener('abort', () => {
                    setTimeout(() => {
                        events.push('provider-transport-terminated');
                        resolve({
                            expiredCheckoutSessionIds: [],
                            canceledSubscriptionIds: ['sub-late-success'],
                            alreadyTerminalSubscriptionIds: [],
                        });
                    }, 20);
                }, { once: true });
            });
        });
        const tx = {
            tenant: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'tenant-1',
                    slug: 'tenant-1',
                    status: 'SUSPENDED',
                    deletedAt: null,
                    auditLogs: [{
                        id: 'audit-1',
                        userId: null,
                        actorUserId: null,
                        actorTenantId: null,
                        ipAddress: null,
                        userAgent: null,
                        createdAt: new Date('2026-07-16T12:00:00.000Z'),
                    }],
                }),
            },
            $executeRaw: vi.fn(async (...call: unknown[]) => {
                if (sqlText(call).includes('"leaseOwner" = NULL')) {
                    events.push('claim-released');
                }
                return 1;
            }),
        };
        const tenantDb = {
            withPlatformAdmin: vi.fn((operation: (value: typeof tx) => Promise<unknown>) => operation(tx)),
        };
        const service = new TenantDeletionBillingService(tenantDb as any, () => ({
            finalizeTenantBillingForPurge: provider,
        } as any), {
            leaseMs: 100,
            providerAttemptTimeoutMs: 50,
            retryBaseMs: 1_000,
        });

        await expect(service.reconcileClaimedDeletionBillingCandidate({
            tenantId: 'tenant-1',
            operationId: 'tenant-deletion-audit-1',
            leaseOwner: 'replica-1',
            leaseToken: 'fence-1',
        })).rejects.toMatchObject({ outcome: 'deadline_exceeded' });

        expect(provider).toHaveBeenCalledOnce();
        expect(providerContext?.operationId).toBe('tenant-deletion-audit-1');
        expect(providerContext?.providerDeadlineAtMs).toBeGreaterThan(Date.now() - 1_000);
        expect(providerContext?.signal.aborted).toBe(true);
        expect(events).toEqual([
            'provider-transport-terminated',
            'claim-released',
        ]);
        const failureCall = tx.$executeRaw.mock.calls.find((call) => (
            call.includes('PROVIDER_ATTEMPT_DEADLINE_EXCEEDED')
        ));
        expect(failureCall).toBeDefined();
        expect(failureCall).toContain('replica-1');
        expect(failureCall).toContain('fence-1');
        expect(failureCall).toContain('tenant-deletion-audit-1');
        expect(sqlText(failureCall!)).toContain('"leaseOwner" = NULL');
        expect(sqlText(failureCall!)).toContain('"nextAttemptAt"');
    });

    it('does not finalize a deletion when provider completion arrives after stop', async () => {
        const service = new TenantDeletionBillingService({} as any, () => ({
            finalizeTenantBillingForPurge: vi.fn(),
        } as any));
        const stop = new AbortController();
        const finalize = vi.spyOn(service as any, 'finalizeDeletionBarrier');
        vi.spyOn(service as any, 'withClaimHeartbeat').mockImplementation(async () => {
            stop.abort();
            return {
                expiredCheckoutSessionIds: [],
                canceledSubscriptionIds: ['sub-late-completion'],
                alreadyTerminalSubscriptionIds: [],
            };
        });

        await expect((service as any).runClaimedDeletionBillingReconciliation(
            {
                tenantId: 'tenant-1',
                operationId: 'operation-1',
                leaseOwner: 'owner-1',
                leaseToken: 'token-1',
            },
            { tenantId: 'tenant-1' },
            true,
            stop.signal,
        )).rejects.toMatchObject({ outcome: 'stopped' });
        expect(finalize).not.toHaveBeenCalled();
    });
});

describe('TenantDeletionBillingService schedule refund settlement', () => {
    it('fails closed on missing, mismatched, malformed, or duplicate provenance before terminalization', async () => {
        const cases = ['missing', 'mismatched', 'malformed', 'duplicate'];
        for (const issue of cases) {
            const queryRaw = vi.fn().mockResolvedValue([{ jobType: 'schedule', jobId: `${issue}-job` }]);
            const executeRaw = vi.fn();
            const service = new TenantDeletionBillingService({} as any, () => ({
                finalizeTenantBillingForPurge: vi.fn(),
            } as any));

            await expect((service as any).terminalizePaidWorkForDeletion(
                { $queryRaw: queryRaw, $executeRaw: executeRaw },
                'tenant-1',
                new Date('2026-07-16T12:00:00.000Z'),
            )).rejects.toThrow(/billing provenance is invalid/i);
            expect(queryRaw).toHaveBeenCalledOnce();
            expect(executeRaw).not.toHaveBeenCalled();
        }
    });

    it('requires exactly one deterministic tenant/job debit for every paid job', async () => {
        const { sql, provenanceSql } = await scheduleSettlementSql();
        const refundable = sql.slice(
            sql.indexOf('refundable_schedule_jobs AS'),
            sql.indexOf('locked_availability_imports AS'),
        );

        expect(refundable).toContain('JOIN "CreditTransaction" debit');
        expect(refundable).not.toContain('LEFT JOIN "CreditTransaction" debit');
        expect(refundable).toContain(`debit."id" = 'schedule-credit-' || job."id"`);
        expect(refundable).toContain('debit."tenantId" = job."tenantId"');
        expect(refundable).toContain('debit."amount" < 0');
        expect(provenanceSql).toContain('provenance."debitCount" <> 1');
        expect(provenanceSql).toContain('provenance."debitTenantId" IS DISTINCT FROM provenance."tenantId"');
        expect(provenanceSql).toContain(`ledger."id" = 'schedule-credit-' || configured."id"`);
        expect(provenanceSql).toContain(`ledger."id" = 'feature-usage-availability-import:' || configured."id"`);
        expect(provenanceSql).toContain('provenance."debitBalanceAfter" IS DISTINCT FROM provenance."configuredBalance"');
        expect(provenanceSql).toContain('provenance."refundBalanceAfter" IS NULL');
    });

    it('rejects a debit amount that does not exactly match configured consumption and derives refund from the debit', async () => {
        const { sql, provenanceSql } = await scheduleSettlementSql();
        const refundable = sql.slice(
            sql.indexOf('refundable_schedule_jobs AS'),
            sql.indexOf('locked_availability_imports AS'),
        );
        const inserted = sql.slice(sql.indexOf('refund_candidates AS'));

        expect(refundable).toContain('-debit."amount" AS "amount"');
        expect(refundable).toContain(`job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'`);
        expect(refundable).toContain(`THEN -debit."amount" = (job."creditConsumption"->>'consumedCredits')::integer`);
        expect(inserted).toContain('"amount"');
        expect(inserted).toContain('FROM refundable_schedule_jobs');
        expect(inserted).not.toContain(`("creditConsumption"->>'consumedCredits')::integer`);
        expect(provenanceSql).toContain(`jsonb_typeof(job."creditConsumption") = 'object'`);
        expect(provenanceSql).toContain(`job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'`);
        expect(provenanceSql).toContain('provenance."debitAmount" IS DISTINCT FROM -provenance."configuredAmount"');
        expect(provenanceSql).toContain('provenance."refundAmount" IS DISTINCT FROM provenance."configuredAmount"');
    });

    it('enforces the exact schedule status/refund matrix before any mutation', async () => {
        const { provenanceSql } = await scheduleSettlementSql();

        expect(provenanceSql).toContain('SELECT job."id", job."tenantId", job."status", job."creditConsumption"');
        expect(provenanceSql).toContain(`provenance."status" IN ('FAILED', 'DEAD_LETTERED')`);
        expect(provenanceSql).toContain('AND provenance."refundCount" <> 1');
        expect(provenanceSql).toContain(`provenance."status" = 'SUCCEEDED'`);
        expect(provenanceSql).toContain(`provenance."status" IN ('QUEUED', 'RUNNING', 'RETRYING')`);
        expect(provenanceSql).toContain('AND provenance."refundCount" <> 0');
        expect(provenanceSql).toContain(`provenance."status" NOT IN (`);
    });

    it('preserves exactly-once concurrency by crediting only the deterministic refund insert winner', async () => {
        const { sql, executeRaw, queryRaw } = await scheduleSettlementSql();
        const inserted = sql.slice(sql.indexOf('refund_candidates AS'));

        expect(executeRaw).not.toHaveBeenCalled();
        expect(queryRaw).toHaveBeenCalledTimes(2);
        expect(sql).toContain(`"status" IN ('QUEUED', 'RUNNING', 'RETRYING')`);
        expect(inserted).toContain(`'schedule-credit-refund-' || "id"`);
        expect(inserted).toContain('ON CONFLICT ("id") DO NOTHING');
        expect(inserted).toContain('RETURNING "tenantId", "amount", "balanceAfter"');
        expect(sql).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW');
        expect(sql).toContain('"balanceAfter", "createdAt"');
        expect(sql).toContain('tenant."usageCredits" + refund_totals."amount"');
        expect(sql).toContain('COUNT(*)::integer FROM refund_candidates');
    });

    it('settles every nonterminal paid webhook before tenant-deletion dead-lettering', async () => {
        const { sql, provenanceSql } = await scheduleSettlementSql();

        expect(sql).toContain('locked_webhook_deliveries AS MATERIALIZED');
        expect(sql).toContain('refundable_webhook_deliveries AS');
        expect(sql).toContain('terminalized_webhook_deliveries AS');
        expect(sql).toContain(`debit."id" = 'feature-usage-webhook-delivery:' || delivery."id"`);
        expect(sql).toContain(`'feature-refund-webhook-delivery:' || "id"`);
        expect(sql).toContain(`'Webhook delivery refund (' || "id" || ')'`);
        expect(sql).toContain('"encryptedUrl" = \'\'');
        expect(sql).toContain('"encryptedPayload" = \'\'');
        expect(sql).toContain('"encryptionKeyRef" = \'erased-v1\'');
        expect(sql).toContain('COUNT(*)::integer FROM refundable_webhook_deliveries');
        expect(sql).toContain('COUNT(*)::integer FROM terminalized_webhook_deliveries');

        expect(provenanceSql).toContain('webhook_provenance AS');
        expect(provenanceSql).toContain(`ledger."id" = 'feature-usage-webhook-delivery:' || delivery."id"`);
        expect(provenanceSql).toContain(`ledger."id" = 'feature-refund-webhook-delivery:' || delivery."id"`);
        expect(provenanceSql).toContain(`provenance."status" = 'DEAD_LETTERED'`);
        expect(provenanceSql).toContain(`provenance."status" IN ('PENDING', 'QUEUED', 'SENDING', 'FAILED', 'DELIVERED')`);
    });
});

describe('TenantDeletionBillingService availability-import settlement', () => {
    it('atomically refunds active imports once, terminalizes non-success jobs, and erases every result/source', async () => {
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(1),
            $queryRaw: vi.fn()
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([{
                    candidateCount: 0,
                    insertedCount: 0,
                    lockedWebhookCount: 0,
                    refundableWebhookCount: 0,
                    terminalizedWebhookCount: 0,
                    walletUpdateCount: 0,
                }]),
        };
        const service = new TenantDeletionBillingService({} as any, () => ({
            finalizeTenantBillingForPurge: vi.fn(),
        } as any));

        await (service as any).terminalizePaidWorkForDeletion(
            tx,
            'tenant-1',
            new Date('2026-07-16T12:00:00.000Z'),
        );

        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(tx.$executeRaw).not.toHaveBeenCalled();
        const sql = Array.from(tx.$queryRaw.mock.calls[1][0] as readonly string[]).join(' ');
        expect(sql).toContain('locked_availability_imports AS MATERIALIZED');
        expect(sql).toContain('FOR UPDATE OF job');
        expect(sql).toContain(`import_job."status" IN ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')`);
        expect(sql).toContain(`'feature-usage-availability-import:' || import_job."id"`);
        expect(sql).toContain(`'feature-refund-availability-import:' || "id"`);
        expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
        expect(sql).toContain('cancelled_availability_imports AS');
        expect(sql).toContain('erased_successful_availability_imports AS');
        expect(sql).toContain('"encryptedSourcePayload" = NULL');
        expect(sql).toContain('"parsedAvailability" = NULL');
        expect(sql).toContain(`"status" = 'CANCELLED'::"AvailabilityImportStatus"`);
        expect(sql).toContain(`"failureCode" = 'TENANT_DELETED'`);
        expect(sql.indexOf('"encryptedSourcePayload" = NULL')).toBeLessThan(
            sql.indexOf('"status" = \'CANCELLED\'::"AvailabilityImportStatus"'),
        );
        const successfulErasure = sql.slice(sql.indexOf('erased_successful_availability_imports AS'));
        expect(successfulErasure).toContain(`import_job."status" = 'SUCCEEDED'`);
        expect(successfulErasure).not.toContain(`"status" = 'CANCELLED'`);
        expect(sql).toContain('refund_candidates AS MATERIALIZED');
        expect(sql).toContain('settled_refunds AS MATERIALIZED');
        expect(sql).toContain('inserted_refunds AS');
        expect(sql).toContain('tenant."usageCredits" + refund_totals."amount"');
    });

    it('enforces the exact import status/refund matrix before any mutation', async () => {
        const { provenanceSql } = await scheduleSettlementSql();

        expect(provenanceSql).toContain('job."status"::text AS "status"');
        expect(provenanceSql).toContain(`provenance."status" IN ('FAILED', 'DEAD_LETTERED', 'CANCELLED')`);
        expect(provenanceSql).toContain('AND provenance."refundCount" <> 1');
        expect(provenanceSql).toContain(`provenance."status" = 'SUCCEEDED'`);
        expect(provenanceSql).toContain(`provenance."status" IN ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')`);
        expect(provenanceSql).toContain('AND provenance."refundCount" <> 0');
    });
});

if (process.env.MIGRATION_DATABASE_URL) {
    describe('TenantDeletionBillingService availability-import Postgres settlement', () => {
        it('refunds every charged non-success once, never refunds success, and erases all import state', async () => {
            const prisma = new PrismaClient({
                datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-deletion-${suffix}`;
            const userId = `user-deletion-${suffix}`;
            const pendingId = `import-pending-${suffix}`;
            const failedId = `import-failed-${suffix}`;
            const succeededId = `import-succeeded-${suffix}`;
            const locationId = `location-deletion-${suffix}`;
            const scheduleId = `schedule-deletion-${suffix}`;
            const activeSolveId = `solve-active-${suffix}`;
            const failedSolveId = `solve-failed-${suffix}`;
            const succeededSolveId = `solve-succeeded-${suffix}`;
            const deletedAt = new Date('2026-07-16T13:00:00.000Z');
            const succeededAt = new Date('2026-07-16T12:00:00.000Z');
            const username = `staff-${suffix}`;
            const digest = (value: string) => createHash('sha256').update(value).digest('hex');
            const importValues = [
                { id: pendingId, key: digest(`pending-${suffix}`), amount: 2 },
                { id: failedId, key: digest(`failed-${suffix}`), amount: 3 },
                { id: succeededId, key: digest(`succeeded-${suffix}`), amount: 5 },
            ];

            try {
                await prisma.$executeRaw`
                    INSERT INTO "Tenant"
                        ("id", "name", "slug", "status", "stripeSubscriptionId", "usageCredits", "createdAt", "updatedAt")
                    VALUES
                        (${tenantId}, 'Tenant Deletion Proof', ${`tenant-deletion-${suffix}`},
                         'ACTIVE'::"TenantStatus", ${`sub-tenant-deletion-${suffix}`}, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await prisma.$executeRaw`
                    INSERT INTO "User"
                        ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
                    VALUES
                        (${userId}, ${tenantId}, 'Deletion Staff', ${username},
                         'STAFF'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await prisma.$executeRaw`
                    INSERT INTO "Location" ("id", "tenantId", "name", "timezone", "createdAt", "updatedAt")
                    VALUES (${locationId}, ${tenantId}, 'Deletion Location', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await prisma.$executeRaw`
                    INSERT INTO "Schedule"
                        ("id", "tenantId", "locationId", "startDate", "endDate", "status", "createdAt", "updatedAt")
                    VALUES (${scheduleId}, ${tenantId}, ${locationId}, CURRENT_TIMESTAMP,
                            CURRENT_TIMESTAMP + INTERVAL '7 days', 'DRAFT'::"ScheduleStatus",
                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                for (const solve of [
                    { id: activeSolveId, status: 'QUEUED', amount: 4 },
                    { id: failedSolveId, status: 'FAILED', amount: 7 },
                    { id: succeededSolveId, status: 'SUCCEEDED', amount: 9 },
                ]) {
                    await prisma.$executeRaw`
                        INSERT INTO "CreditTransaction" (
                            "id", "tenantId", "amount", "reason", "balanceAfter", "createdAt"
                        )
                        VALUES (${`schedule-credit-${solve.id}`}, ${tenantId}, ${-solve.amount},
                                ${`Schedule generation (${solve.id})`}, 0, CURRENT_TIMESTAMP)
                    `;
                    await prisma.$executeRaw`
                        INSERT INTO "ScheduleSolveJob"
                            ("id", "tenantId", "scheduleId", "locationId", "requestKeyHash", "requestHash",
                             "status", "creditConsumption", "createdAt", "updatedAt")
                        VALUES (${solve.id}, ${tenantId}, ${scheduleId}, ${locationId},
                                ${digest(`key-${solve.id}`)}, ${digest(`request-${solve.id}`)}, ${solve.status},
                                ${JSON.stringify({ source: 'credits', consumedCredits: solve.amount, newBalance: 0 })}::jsonb,
                                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    `;
                }
                for (const value of importValues) {
                    await prisma.$executeRaw`
                        INSERT INTO "CreditTransaction" (
                            "id", "tenantId", "amount", "reason", "balanceAfter", "createdAt"
                        )
                        VALUES (${`feature-usage-availability-import:${value.id}`}, ${tenantId}, ${-value.amount},
                                ${`Availability PDF import (${value.id})`}, 0, CURRENT_TIMESTAMP)
                    `;
                }
                await prisma.$executeRaw`
                    INSERT INTO "AvailabilityImportJob"
                        ("id", "tenantId", "userId", "requestKeyHash", "requestHash", "targetIdentityHash",
                         "storageKey", "encryptedSourcePayload", "fileSha256", "fileSize", "creditConsumption",
                         "expiresAt", "createdAt", "updatedAt")
                    VALUES
                        (${pendingId}, ${tenantId}, ${userId}, ${importValues[0].key}, ${digest('visible-pending')}, ${digest(username)},
                         ${`${randomUUID()}.pdf`}, ${Buffer.concat([Buffer.from('LLAI\x03', 'binary'), Buffer.alloc(29, 0x31)])},
                         ${digest('pending-file')}, 9, ${JSON.stringify({ source: 'credits', consumedCredits: 2, newBalance: 0 })}::jsonb,
                         CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await prisma.$executeRaw`
                    INSERT INTO "AvailabilityImportJob"
                        ("id", "tenantId", "userId", "requestKeyHash", "requestHash", "targetIdentityHash",
                         "status", "publicationStatus", "fileSha256", "fileSize", "parsedAvailability", "resultErasedAt",
                         "failureCode", "creditConsumption", "completedAt", "expiresAt", "createdAt", "updatedAt")
                    VALUES
                        (${failedId}, ${tenantId}, ${userId}, ${importValues[1].key}, ${digest('visible-failed')}, ${digest(username)},
                         'FAILED'::"AvailabilityImportStatus", 'FAILED'::"AvailabilityImportPublicationStatus",
                         ${digest('failed-file')}, 9, NULL, ${succeededAt}, 'INVALID_DOCUMENT',
                         ${JSON.stringify({ source: 'credits', consumedCredits: 3, newBalance: 0 })}::jsonb, ${succeededAt},
                         CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                        (${succeededId}, ${tenantId}, ${userId}, ${importValues[2].key}, ${digest('visible-success')}, ${digest(username)},
                         'SUCCEEDED'::"AvailabilityImportStatus", 'PUBLISHED'::"AvailabilityImportPublicationStatus",
                         ${digest('succeeded-file')}, 9,
                         ${JSON.stringify([{ dayOfWeek: 1, startTimeMinutes: 540, endTimeMinutes: 1020 }])}::jsonb,
                         NULL, NULL, ${JSON.stringify({ source: 'credits', consumedCredits: 5, newBalance: 0 })}::jsonb, ${succeededAt},
                         CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await prisma.tenant.update({
                    where: { id: tenantId },
                    data: { status: 'SUSPENDED' },
                });

                const service = new TenantDeletionBillingService({} as any, () => ({
                    finalizeTenantBillingForPurge: vi.fn(),
                } as any));
                const settle = () => prisma.$transaction((tx) => (
                    (service as any).terminalizePaidWorkForDeletion(tx, tenantId, deletedAt)
                ));
                await expect(settle()).rejects.toThrow(/billing provenance is invalid/i);
                await expect(prisma.$queryRaw<Array<{ status: string }>>`
                    SELECT "status"::text AS "status"
                    FROM "AvailabilityImportJob"
                    WHERE "id" = ${pendingId}
                `).resolves.toEqual([{ status: 'PENDING' }]);
                await expect(prisma.$queryRaw<Array<{ status: string }>>`
                    SELECT "status" FROM "ScheduleSolveJob" WHERE "id" = ${activeSolveId}
                `).resolves.toEqual([{ status: 'QUEUED' }]);
                await expect(prisma.$queryRaw<Array<{ count: bigint }>>`
                    SELECT COUNT(*) AS "count"
                    FROM "CreditTransaction"
                    WHERE "tenantId" = ${tenantId}
                      AND "id" LIKE 'feature-refund-availability-import:%'
                `).resolves.toEqual([{ count: 0n }]);

                await prisma.$transaction(async (tx) => {
                    await tx.$executeRaw`
                        INSERT INTO "CreditTransaction" (
                            "id", "tenantId", "amount", "reason", "balanceAfter", "createdAt"
                        )
                        VALUES (${`feature-refund-availability-import:${failedId}`}, ${tenantId}, 3,
                                ${`Availability PDF import refund (${failedId})`}, 3, CURRENT_TIMESTAMP)
                    `;
                    await tx.$executeRaw`
                        INSERT INTO "CreditTransaction" (
                            "id", "tenantId", "amount", "reason", "balanceAfter", "createdAt"
                        )
                        VALUES (${`schedule-credit-refund-${failedSolveId}`}, ${tenantId}, 7,
                                ${`Schedule generation refund (${failedSolveId})`}, 10, CURRENT_TIMESTAMP)
                    `;
                    await tx.tenant.update({
                        where: { id: tenantId },
                        data: { usageCredits: { increment: 10 } },
                    });
                });
                await Promise.all([settle(), settle()]);

                const jobs = await prisma.$queryRaw<Array<{
                    id: string;
                    status: string;
                    storageKey: string | null;
                    encryptedSourcePayload: Buffer | null;
                    parsedAvailability: unknown;
                    resultErasedAt: Date | null;
                    failureCode: string | null;
                    executionToken: string | null;
                    executionLeaseUntil: Date | null;
                }>>`
                    SELECT "id", "status"::text AS "status", "storageKey", "encryptedSourcePayload",
                           "parsedAvailability", "resultErasedAt", "failureCode", "executionToken", "executionLeaseUntil"
                    FROM "AvailabilityImportJob"
                    WHERE "tenantId" = ${tenantId}
                    ORDER BY "id"
                `;
                for (const job of jobs) {
                    expect(job.storageKey).toBeNull();
                    expect(job.encryptedSourcePayload).toBeNull();
                    expect(job.parsedAvailability).toBeNull();
                    expect(job.resultErasedAt).toEqual(deletedAt);
                    expect(job.executionToken).toBeNull();
                    expect(job.executionLeaseUntil).toBeNull();
                    if (job.id === succeededId) {
                        expect(job.status).toBe('SUCCEEDED');
                        expect(job.failureCode).toBeNull();
                    } else {
                        expect(job.status).toBe('CANCELLED');
                        expect(job.failureCode).toBe('TENANT_DELETED');
                    }
                }

                const refunds = await prisma.$queryRaw<Array<{ id: string; amount: number; balanceAfter: number }>>`
                    SELECT "id", "amount", "balanceAfter"
                    FROM "CreditTransaction"
                    WHERE "tenantId" = ${tenantId}
                      AND "id" LIKE 'feature-refund-availability-import:%'
                    ORDER BY "id"
                `;
                expect(refunds).toEqual([
                    { id: `feature-refund-availability-import:${failedId}`, amount: 3, balanceAfter: 3 },
                    { id: `feature-refund-availability-import:${pendingId}`, amount: 2, balanceAfter: 12 },
                ]);
                const solveJobs = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
                    SELECT "id", "status"
                    FROM "ScheduleSolveJob"
                    WHERE "tenantId" = ${tenantId}
                    ORDER BY "id"
                `;
                expect(solveJobs).toEqual([
                    { id: activeSolveId, status: 'DEAD_LETTERED' },
                    { id: failedSolveId, status: 'FAILED' },
                    { id: succeededSolveId, status: 'SUCCEEDED' },
                ]);
                await expect(prisma.$queryRaw<Array<{ id: string; amount: number; balanceAfter: number }>>`
                    SELECT "id", "amount", "balanceAfter"
                    FROM "CreditTransaction"
                    WHERE "tenantId" = ${tenantId}
                      AND "id" LIKE 'schedule-credit-refund-%'
                    ORDER BY "id"
                `).resolves.toEqual([
                    { id: `schedule-credit-refund-${activeSolveId}`, amount: 4, balanceAfter: 16 },
                    { id: `schedule-credit-refund-${failedSolveId}`, amount: 7, balanceAfter: 10 },
                ]);
                await expect(prisma.tenant.findUnique({
                    where: { id: tenantId },
                    select: { usageCredits: true },
                })).resolves.toEqual({ usageCredits: 16 });
            } finally {
                await prisma.$executeRaw`DELETE FROM "ScheduleSolveJob" WHERE "tenantId" = ${tenantId}`.catch(() => undefined);
                await prisma.$executeRaw`DELETE FROM "Schedule" WHERE "tenantId" = ${tenantId}`.catch(() => undefined);
                await prisma.$executeRaw`DELETE FROM "Location" WHERE "tenantId" = ${tenantId}`.catch(() => undefined);
                await prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`.catch(() => undefined);
                await prisma.$disconnect();
            }
        }, 20_000);
    });
}
