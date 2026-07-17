import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { ScheduleSolveOutboxPublisher } from './schedule-solve-outbox.publisher';

function publication(attempt = 1, id = 'job-1') {
    return {
        id,
        tenantId: 'tenant-1',
        status: 'QUEUED',
        publishAttempts: attempt,
        createdAt: new Date(),
        creditConsumption: { source: 'credits', consumedCredits: 1, newBalance: 0 },
        queuePayload: {
            type: 'schedule.solve' as const,
            job_id: id,
            payload: { tenant_id: 'tenant-1', schedule_id: 'schedule-1' },
        },
    };
}

function refundState(overrides: Record<string, unknown> = {}) {
    return {
        jobStatus: 'QUEUED',
        creditConsumption: { source: 'credits', consumedCredits: 1, newBalance: 0 },
        configuredAmount: 1,
        debitCount: 1,
        debitTenantId: 'tenant-1',
        debitAmount: -1,
        debitReason: 'Schedule generation (job-1)',
        debitBalanceAfter: 0,
        refundCount: 0,
        refundTenantId: null as string | null,
        refundAmount: null as number | null,
        refundReason: null as string | null,
        refundBalanceAfter: null as number | null,
        walletBalance: 0,
        executionToken: null as string | null,
        executionLeaseUntil: null as Date | null,
        walletUpdates: 0,
        ...overrides,
    };
}

type ClaimDebitFixture = {
    id: string;
    tenantId: string;
    amount: number;
    reason: string;
    balanceAfter: number | null;
};

function harness(
    rows = [publication()],
    state = refundState(),
    claimDebits: ClaimDebitFixture[] = [{
        id: 'schedule-credit-job-1',
        tenantId: 'tenant-1',
        amount: -1,
        reason: 'Schedule generation (job-1)',
        balanceAfter: 0,
    }],
    publisherOptions: { transportDeadlineMs?: number } = {},
) {
    const events: string[] = [];
    const executions: Array<{ sql: string; values: unknown[] }> = [];
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const quarantines: Array<{ sql: string; values: unknown[] }> = [];
    const platformTx = {
        $queryRaw: vi.fn(async (query: { sql?: string; values?: unknown[] }) => {
            const sql = query.sql ?? '';
            if (sql.includes('FROM "CreditTransaction"')) return claimDebits;
            if (sql.includes('UPDATE "ScheduleSolveJob" AS job')) {
                return rows.filter((row) => (query.values ?? []).includes(row.id));
            }
            return rows;
        }),
        $executeRaw: vi.fn(async (query: { sql?: string; values?: unknown[] }) => {
            quarantines.push({ sql: query.sql ?? '', values: query.values ?? [] });
            return 1;
        }),
    };
    const tenantTx = {
        $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            executions.push({ sql: strings.join(''), values });
            events.push('state');
            return 1;
        }),
        $queryRaw: vi.fn(async (query: { sql?: string; values?: unknown[] }) => {
            const sql = query.sql ?? '';
            const values = query.values ?? [];
            queries.push({ sql, values });
            if (sql.includes('FROM "Tenant"')) return [{ id: 'tenant-1' }];
            const liveExecutionLease = state.executionToken !== null
                && state.executionLeaseUntil instanceof Date
                && state.executionLeaseUntil.getTime() > Date.now();
            if (sql.includes('AS "hasLiveExecutionLease"')) {
                return [{ hasLiveExecutionLease: liveExecutionLease }];
            }

            const initialStatus = String(state.jobStatus);
            const metadata = state.creditConsumption as Record<string, unknown>;
            const metadataIsExact = metadata?.source === 'credits'
                && metadata?.consumedCredits === 1
                && metadata?.newBalance === 0
                && Object.keys(metadata).length === 3;
            const debitIsExact = metadataIsExact
                && state.configuredAmount === 1
                && state.debitCount === 1
                && state.debitTenantId === 'tenant-1'
                && state.debitAmount === -1
                && state.debitReason === 'Schedule generation (job-1)'
                && state.debitBalanceAfter === metadata.newBalance;
            const canSettle = !['SUCCEEDED', 'FAILED', 'DEAD_LETTERED'].includes(initialStatus)
                && debitIsExact
                && state.refundCount === 0
                && !liveExecutionLease;
            const outcome = {
                jobStatus: initialStatus,
                liveExecutionLease,
                creditConsumption: state.creditConsumption,
                configuredAmount: state.configuredAmount,
                debitCount: state.debitCount,
                debitTenantId: state.debitTenantId,
                debitAmount: state.debitAmount,
                debitReason: state.debitReason,
                debitBalanceAfter: state.debitBalanceAfter,
                refundCount: state.refundCount,
                refundTenantId: state.refundTenantId,
                refundAmount: state.refundAmount,
                refundReason: state.refundReason,
                refundBalanceAfter: state.refundBalanceAfter,
                terminalizedCount: canSettle ? 1 : 0,
                insertedRefundCount: canSettle ? 1 : 0,
                insertedRefundBalanceAfter: canSettle
                    ? Number(state.walletBalance) - Number(state.debitAmount)
                    : null,
                walletUpdateCount: canSettle ? 1 : 0,
            };
            if (canSettle) {
                state.walletBalance = Number(outcome.insertedRefundBalanceAfter);
                state.jobStatus = 'FAILED';
                state.refundCount = 1;
                state.refundTenantId = 'tenant-1';
                state.refundAmount = 1;
                state.refundReason = 'Schedule generation refund (job-1)';
                state.refundBalanceAfter = state.walletBalance;
                state.executionToken = null;
                state.executionLeaseUntil = null;
                state.walletUpdates += 1;
            }
            return [outcome];
        }),
    };
    let tenantTail: Promise<unknown> = Promise.resolve();
    const tenantDb = {
        withPlatformAdmin: vi.fn(async (operation: any) => operation(platformTx)),
        withTenant: vi.fn((_tenantId: string, operation: any) => {
            const run = tenantTail.then(() => operation(tenantTx));
            tenantTail = run.then(() => undefined, () => undefined);
            return run;
        }),
    };
    const channel = {
        assertQueue: vi.fn().mockResolvedValue(undefined),
        sendToQueue: vi.fn(() => {
            events.push('send');
            return true;
        }),
        waitForConfirms: vi.fn(async () => {
            events.push('confirm');
        }),
        close: vi.fn().mockResolvedValue(undefined),
    };
    const connection = {
        createConfirmChannel: vi.fn().mockResolvedValue(channel),
        close: vi.fn().mockResolvedValue(undefined),
        connection: { stream: { destroy: vi.fn() } },
    };
    const connect = vi.fn().mockResolvedValue(connection);
    const publisher = new ScheduleSolveOutboxPublisher(tenantDb as any, {
        connect: connect as any,
        pollIntervalMs: 60_000,
        leaseMs: 30_000,
        batchSize: 10,
        maxPublishAttempts: 3,
        maxPublicationAgeMs: 60_000,
        ...publisherOptions,
    });

    return {
        publisher,
        tenantDb,
        platformTx,
        tenantTx,
        connect,
        connection,
        channel,
        events,
        executions,
        queries,
        quarantines,
        refundState: state,
    };
}

describe('ScheduleSolveOutboxPublisher', () => {
    it('publishes a persistent stable job id and marks published only after broker confirm', async () => {
        const h = harness();

        await h.publisher.publishPendingNow('job-1');

        expect(h.channel.assertQueue).toHaveBeenNthCalledWith(1, 'lunchlineup.jobs.dlq', { durable: true });
        expect(h.channel.assertQueue).toHaveBeenNthCalledWith(2, 'lunchlineup.jobs', {
            durable: true,
            arguments: {
                'x-dead-letter-exchange': '',
                'x-dead-letter-routing-key': 'lunchlineup.jobs.dlq',
            },
        });
        expect(h.channel.sendToQueue).toHaveBeenCalledWith(
            'lunchlineup.jobs',
            expect.any(Buffer),
            expect.objectContaining({
                persistent: true,
                messageId: 'job-1',
                contentType: 'application/json',
                type: 'schedule.solve',
            }),
        );
        expect(h.events).toEqual(['send', 'confirm', 'state']);
    });

    it('records a retryable failed publication without losing the outbox row', async () => {
        const h = harness();
        h.channel.waitForConfirms.mockRejectedValue(new Error('broker confirm timeout'));

        await h.publisher.publishPendingNow('job-1');

        expect(h.tenantDb.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
        expect(h.tenantTx.$executeRaw).toHaveBeenCalledOnce();
        expect(h.events).toEqual(['send', 'state']);
    });

    it('does not terminalize a broker-confirmed publication when only the database acknowledgement fails', async () => {
        const h = harness([publication(3)]);
        h.tenantTx.$executeRaw.mockRejectedValueOnce(new Error('database unavailable'));

        await h.publisher.publishPendingNow('job-1');

        expect(h.events).toEqual(['send', 'confirm']);
        expect(h.tenantTx.$executeRaw).toHaveBeenCalledOnce();
        const call = h.tenantTx.$executeRaw.mock.calls[0] as unknown[] | undefined;
        const sql = (call?.[0] as TemplateStringsArray | undefined)?.join('') ?? '';
        expect(sql).toContain('"publicationStatus" = \'PUBLISHED\'');
        expect(sql).not.toContain('WITH terminalized_job AS');
    });

    it('atomically terminalizes and refunds once after the configured attempt bound', async () => {
        const h = harness([publication(3)]);
        h.channel.waitForConfirms.mockRejectedValue(new Error('broker confirm timeout'));

        await h.publisher.publishPendingNow('job-1');

        expect(h.tenantTx.$queryRaw).toHaveBeenCalledTimes(3);
        const query = h.queries.find((entry) => entry.sql.includes('WITH locked_job AS'));
        const sql = query?.sql ?? '';
        expect(sql).toContain('WITH locked_job AS MATERIALIZED');
        expect(sql).toContain('"status" = \'FAILED\'');
        expect(sql).toContain('"status" NOT IN (\'SUCCEEDED\', \'FAILED\', \'DEAD_LETTERED\')');
        expect(sql).toContain('debit."amount" = -job."configuredAmount"');
        expect(sql).toContain('-provenance."debitAmount"');
        expect(sql).toContain('INSERT INTO "CreditTransaction"');
        expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
        expect(sql).toContain('UPDATE "Tenant" tenant');
        expect(sql).toContain('FROM updated_wallet wallet');
        expect(sql).toContain('"balanceAfter"');
        expect(query?.values).toContain('schedule-credit-refund-job-1');
        expect(h.refundState.walletUpdates).toBe(1);
    });

    it('preserves a live worker claim after confirm timeout, then refunds once after lease expiry', async () => {
        const state = refundState();
        const h = harness([publication(3)], state);
        h.channel.waitForConfirms.mockImplementation(async () => {
            state.jobStatus = 'RUNNING';
            state.executionToken = 'a'.repeat(32);
            state.executionLeaseUntil = new Date(Date.now() + 60_000);
            throw new Error('broker confirm timeout');
        });

        await h.publisher.publishPendingNow('job-1');

        expect(state.jobStatus).toBe('RUNNING');
        expect(state.executionToken).toBe('a'.repeat(32));
        expect(state.refundCount).toBe(0);
        expect(state.walletUpdates).toBe(0);
        expect(h.queries.some((entry) => entry.sql.includes('WITH locked_job AS'))).toBe(false);

        state.executionLeaseUntil = new Date(Date.now() - 1);
        await Promise.all([
            (h.publisher as any).markFailed(publication(3), new Error('expired lease recovery')),
            (h.publisher as any).markFailed(publication(3), new Error('expired lease replay')),
        ]);

        expect(state.jobStatus).toBe('FAILED');
        expect(state.executionToken).toBeNull();
        expect(state.refundCount).toBe(1);
        expect(state.walletUpdates).toBe(1);
    });

    it('terminalizes an aged failed publication before it can hold the queued job lock indefinitely', async () => {
        const aged = publication(1);
        aged.createdAt = new Date(Date.now() - 60_001);
        const h = harness([aged]);
        h.channel.waitForConfirms.mockRejectedValue(new Error('broker unavailable'));

        await h.publisher.publishPendingNow('job-1');

        const sql = h.queries.find((entry) => entry.sql.includes('WITH locked_job AS'))?.sql ?? '';
        expect(sql).toContain('"status" = \'FAILED\'');
        expect(sql).toContain('"completedAt" = CURRENT_TIMESTAMP');
    });

    it.each([
        ['missing', { debitCount: 0, debitTenantId: null, debitAmount: null, debitReason: null }],
        ['mismatched', { debitAmount: -2 }],
        ['duplicate', { debitCount: 2 }],
        ['wrong-reason', { debitReason: 'Schedule generation' }],
        ['missing-balance', { debitBalanceAfter: null }],
    ])('fails closed for a %s exact debit before terminal state or wallet mutation', async (_label, overrides) => {
        const state = refundState(overrides);
        const h = harness([publication(3)], state);

        await expect((h.publisher as any).terminalizeFailedPublication(
            publication(3),
            'category=unknown class=Error',
        )).rejects.toThrow(/debit provenance|debit settlement balance/);

        expect(state.jobStatus).toBe('QUEUED');
        expect(state.refundCount).toBe(0);
        expect(state.walletUpdates).toBe(0);
    });

    it('rejects malformed balance metadata before terminal state or wallet mutation', async () => {
        const state = refundState({
            creditConsumption: { source: 'credits', consumedCredits: 1, newBalance: -1 },
            configuredAmount: null,
        });
        const h = harness([publication(3)], state);

        await expect((h.publisher as any).terminalizeFailedPublication(
            publication(3),
            'category=unknown class=Error',
        )).rejects.toThrow(/metadata/i);

        expect(state.jobStatus).toBe('QUEUED');
        expect(state.refundCount).toBe(0);
        expect(state.walletUpdates).toBe(0);
    });

    it('serializes concurrent terminal retries so the refund and wallet increment happen once', async () => {
        const state = refundState();
        const h = harness([publication(3)], state);

        await Promise.all([
            (h.publisher as any).terminalizeFailedPublication(publication(3), 'first'),
            (h.publisher as any).terminalizeFailedPublication(publication(3), 'second'),
        ]);

        expect(state.jobStatus).toBe('FAILED');
        expect(state.refundCount).toBe(1);
        expect(state.refundAmount).toBe(1);
        expect(state.refundBalanceAfter).toBe(1);
        expect(state.walletUpdates).toBe(1);
    });

    it('stores the refund settlement reached after intervening wallet activity', async () => {
        const state = refundState({ walletBalance: 7 });
        const h = harness([publication(3)], state);

        await (h.publisher as any).terminalizeFailedPublication(publication(3), 'retry');

        expect(state.refundAmount).toBe(1);
        expect(state.refundBalanceAfter).toBe(8);
        expect(state.walletBalance).toBe(8);
        expect(state.walletUpdates).toBe(1);
    });

    it('does not connect to RabbitMQ when another lease owner claimed every row', async () => {
        const h = harness([]);

        await h.publisher.publishPendingNow();

        expect(h.connect).not.toHaveBeenCalled();
        expect(h.tenantDb.withTenant).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', []],
        ['mismatched', [{
            id: 'schedule-credit-job-1',
            tenantId: 'tenant-1',
            amount: -2,
            reason: 'Schedule generation (job-1)',
            balanceAfter: 0,
        }]],
        ['duplicate', [{
            id: 'schedule-credit-job-1',
            tenantId: 'tenant-1',
            amount: -1,
            reason: 'Schedule generation (job-1)',
            balanceAfter: 0,
        }, {
            id: 'schedule-credit-job-1',
            tenantId: 'tenant-1',
            amount: -1,
            reason: 'Schedule generation (job-1)',
            balanceAfter: 0,
        }]],
        ['wrong-reason', [{
            id: 'schedule-credit-job-1',
            tenantId: 'tenant-1',
            amount: -1,
            reason: 'Schedule generation',
            balanceAfter: 0,
        }]],
        ['missing-balance', [{
            id: 'schedule-credit-job-1',
            tenantId: 'tenant-1',
            amount: -1,
            reason: 'Schedule generation (job-1)',
            balanceAfter: null,
        }]],
        ['debit-refund-coexistence', [{
            id: 'schedule-credit-job-1',
            tenantId: 'tenant-1',
            amount: -1,
            reason: 'Schedule generation (job-1)',
            balanceAfter: 0,
        }, {
            id: 'schedule-credit-refund-job-1',
            tenantId: 'tenant-1',
            amount: 1,
            reason: 'Schedule generation refund (job-1)',
            balanceAfter: 1,
        }]],
    ])('quarantines a publication with %s paid provenance', async (_label, debits) => {
        const h = harness([publication()], refundState(), debits);

        await expect(h.publisher.publishPendingNow('job-1')).resolves.toBeUndefined();

        expect(h.connect).not.toHaveBeenCalled();
        expect(h.platformTx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(h.platformTx.$executeRaw).toHaveBeenCalledOnce();
        expect(h.quarantines[0].sql).toContain('"status" = \'DEAD_LETTERED\'');
        expect(h.quarantines[0].sql).not.toContain('UPDATE "Tenant"');
        expect(h.quarantines[0].sql).not.toContain('CreditTransaction');
    });

    it('quarantines a corrupt oldest item and publishes the next valid item in the same batch', async () => {
        const invalid = publication(1, 'job-invalid');
        const valid = publication(1, 'job-valid');
        const h = harness([invalid, valid], refundState(), [{
            id: 'schedule-credit-job-valid',
            tenantId: 'tenant-1',
            amount: -1,
            reason: 'Schedule generation (job-valid)',
            balanceAfter: 0,
        }]);

        await h.publisher.publishPendingNow();

        expect(h.platformTx.$executeRaw).toHaveBeenCalledOnce();
        expect(h.quarantines[0].values).toContain('job-invalid');
        expect(h.channel.sendToQueue).toHaveBeenCalledOnce();
        expect(h.channel.sendToQueue).toHaveBeenCalledWith(
            'lunchlineup.jobs',
            expect.any(Buffer),
            expect.objectContaining({ messageId: 'job-valid' }),
        );
    });

    it('accepts an exact terminal replay but rejects invalid terminal provenance', async () => {
        const settled = refundState({
            jobStatus: 'FAILED',
            refundCount: 1,
            refundTenantId: 'tenant-1',
            refundAmount: 1,
            refundReason: 'Schedule generation refund (job-1)',
            refundBalanceAfter: 1,
        });
        const valid = harness([publication(3)], settled);
        await expect((valid.publisher as any).terminalizeFailedPublication(
            publication(3),
            'retry',
        )).resolves.toBeUndefined();

        const invalid = harness([publication(3)], refundState({
            jobStatus: 'FAILED',
            refundCount: 1,
            refundTenantId: 'tenant-1',
            refundAmount: 1,
            refundReason: 'Wrong refund reason',
            refundBalanceAfter: 1,
        }));
        await expect((invalid.publisher as any).terminalizeFailedPublication(
            publication(3),
            'retry',
        )).rejects.toThrow(/refund provenance/i);
    });

    it('redacts and bounds secret-bearing errors across persistence and logging paths', async () => {
        const secret = 'top-secret-value';
        const retry = harness();
        retry.channel.waitForConfirms.mockRejectedValueOnce(new Error(
            'broker_transport_failure password=' + secret
            + ' authorization=Bearer bearer-secret detail=' + 'x'.repeat(1_500),
        ));

        await retry.publisher.publishPendingNow('job-1');

        const persisted = retry.executions[0]?.values.find(
            (value) => value === 'category=unknown class=Error',
        );
        expect(persisted).toBe('category=unknown class=Error');
        expect(persisted).not.toEqual(expect.stringContaining('broker_transport_failure'));
        expect(persisted).not.toEqual(expect.stringContaining(secret));
        expect(persisted).not.toEqual(expect.stringContaining('bearer-secret'));

        const acknowledgement = harness([publication(3)]);
        const acknowledgementLog = vi.spyOn((acknowledgement.publisher as any).logger, 'error')
            .mockImplementation(() => undefined);
        acknowledgement.tenantTx.$executeRaw.mockRejectedValueOnce(
            new Error('ack_failure token=ack-secret'),
        );

        await acknowledgement.publisher.publishPendingNow('job-1');

        const acknowledgementMessage = acknowledgementLog.mock.calls.flat().join(' ');
        expect(acknowledgementMessage).toContain('category=unknown class=Error');
        expect(acknowledgementMessage).not.toContain('ack_failure');
        expect(acknowledgementMessage).not.toContain('ack-secret');

        const sweep = harness();
        const sweepLog = vi.spyOn((sweep.publisher as any).logger, 'error')
            .mockImplementation(() => undefined);
        sweep.platformTx.$queryRaw.mockRejectedValueOnce(
            new Error('claim_failure DATABASE_URL=postgresql://worker:db-secret@db/app'),
        );

        (sweep.publisher as any).kick();
        await (sweep.publisher as any).activeSweep;

        const sweepMessage = sweepLog.mock.calls.flat().join(' ');
        expect(sweepMessage).toContain('category=unknown class=Error');
        expect(sweepMessage).not.toContain('claim_failure');
        expect(sweepMessage).not.toContain('db-secret');
    });

    it('returns from shutdown when RabbitMQ connect never resolves', async () => {
        const h = harness(
            [publication()],
            refundState(),
            undefined,
            { transportDeadlineMs: 100 },
        );
        h.connect.mockReturnValue(new Promise(() => undefined) as any);

        (h.publisher as any).kick();
        await vi.waitFor(() => expect(h.connect).toHaveBeenCalledOnce());
        const startedAt = Date.now();

        await h.publisher.stop();

        expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it('destroys the RabbitMQ socket and returns when publisher confirms never resolve', async () => {
        const h = harness(
            [publication()],
            refundState(),
            undefined,
            { transportDeadlineMs: 100 },
        );
        h.channel.waitForConfirms.mockReturnValue(new Promise(() => undefined));

        (h.publisher as any).kick();
        await vi.waitFor(() => expect(h.channel.waitForConfirms).toHaveBeenCalledOnce());
        const startedAt = Date.now();

        await h.publisher.stop();

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(h.connection.connection.stream.destroy).toHaveBeenCalled();
    });

    it('bounds a never-resolving RabbitMQ close and forces socket cleanup', async () => {
        const h = harness(
            [publication()],
            refundState(),
            undefined,
            { transportDeadlineMs: 100 },
        );
        h.channel.close.mockReturnValue(new Promise(() => undefined));
        const startedAt = Date.now();

        await h.publisher.publishPendingNow('job-1');

        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(h.connection.connection.stream.destroy).toHaveBeenCalled();
    });

    it('keeps the lease and compare-and-set recovery contract in source', () => {
        const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');

        expect(source).toMatch(/FOR UPDATE OF job SKIP LOCKED/);
        expect(source).toMatch(/"publicationStatus" = 'PUBLISHING'/);
        expect(source).toMatch(/"publishLeaseUntil" <=/);
        expect(source).toMatch(/"publishAttempts" = \$\{publication\.publishAttempts\}/);
        expect(source).toMatch(/"status" NOT IN \('SUCCEEDED', 'FAILED', 'DEAD_LETTERED'\)/);
        expect(source).toMatch(/job\."executionToken",\s*job\."executionLeaseUntil",/);
        expect(source).toMatch(/"executionToken" IS NOT NULL[\s\S]*"executionLeaseUntil" > CURRENT_TIMESTAMP/);
        expect(source).toMatch(/"executionToken" IS NULL[\s\S]*"executionLeaseUntil" <= CURRENT_TIMESTAMP/);
        expect(source).toMatch(/job\."creditConsumption" = jsonb_build_object\(/);
        expect(source).not.toContain('jsonb_object_length');
    });

    it('reclaims aged confirmed incomplete jobs and refreshes confirmation age', () => {
        const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');

        expect(source).toMatch(/SCHEDULE_OUTBOX_CONFIRMED_RECOVERY_AGE_MS/);
        expect(source).toMatch(/"publicationStatus" = 'PUBLISHED'/);
        expect(source).toMatch(/"status" IN \('QUEUED', 'RETRYING'\)/);
        expect(source).toMatch(/"status" = 'RUNNING'/);
        expect(source).toMatch(/"publishedAt" = CURRENT_TIMESTAMP/);
        expect(source).toMatch(/jsonb_set\(job\."queuePayload", '\{retry_count\}'/);
    });
});
