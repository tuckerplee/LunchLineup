import { readFileSync } from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { ScheduleSolveOutboxPublisher } from './schedule-solve-outbox.publisher';

function publication(attempt = 1) {
    return {
        id: 'job-1',
        tenantId: 'tenant-1',
        publishAttempts: attempt,
        createdAt: new Date(),
        queuePayload: {
            type: 'schedule.solve' as const,
            job_id: 'job-1',
            payload: { tenant_id: 'tenant-1', schedule_id: 'schedule-1' },
        },
    };
}

function harness(rows = [publication()]) {
    const events: string[] = [];
    const executions: Array<{ sql: string; values: unknown[] }> = [];
    const platformTx = {
        $queryRaw: vi.fn().mockResolvedValue(rows),
    };
    const tenantTx = {
        $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            executions.push({ sql: strings.join(''), values });
            events.push('state');
            return 1;
        }),
    };
    const tenantDb = {
        withPlatformAdmin: vi.fn(async (operation: any) => operation(platformTx)),
        withTenant: vi.fn(async (_tenantId: string, operation: any) => operation(tenantTx)),
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
    };
    const connect = vi.fn().mockResolvedValue(connection);
    const publisher = new ScheduleSolveOutboxPublisher(tenantDb as any, {
        connect: connect as any,
        pollIntervalMs: 60_000,
        leaseMs: 30_000,
        batchSize: 10,
        maxPublishAttempts: 3,
        maxPublicationAgeMs: 60_000,
    });

    return { publisher, tenantDb, platformTx, tenantTx, connect, connection, channel, events, executions };
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

        expect(h.tenantTx.$executeRaw).toHaveBeenCalledOnce();
        const sql = h.executions[0]?.sql ?? '';
        expect(sql).toContain('WITH terminalized_job AS');
        expect(sql).toContain('"status" = \'FAILED\'');
        expect(sql).toContain('"status" NOT IN (\'SUCCEEDED\', \'FAILED\', \'DEAD_LETTERED\')');
        expect(sql).toContain('INSERT INTO "CreditTransaction"');
        expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
        expect(sql).toContain('UPDATE "Tenant" tenant');
        expect(sql).toContain('FROM inserted_refund');
        expect(h.executions[0]?.values).toContain('schedule-credit-refund-job-1');
    });

    it('terminalizes an aged failed publication before it can hold the queued job lock indefinitely', async () => {
        const aged = publication(1);
        aged.createdAt = new Date(Date.now() - 60_001);
        const h = harness([aged]);
        h.channel.waitForConfirms.mockRejectedValue(new Error('broker unavailable'));

        await h.publisher.publishPendingNow('job-1');

        const sql = h.executions[0]?.sql ?? '';
        expect(sql).toContain('"status" = \'FAILED\'');
        expect(sql).toContain('"completedAt" = CURRENT_TIMESTAMP');
    });

    it('does not connect to RabbitMQ when another lease owner claimed every row', async () => {
        const h = harness([]);

        await h.publisher.publishPendingNow();

        expect(h.connect).not.toHaveBeenCalled();
        expect(h.tenantDb.withTenant).not.toHaveBeenCalled();
    });

    it('keeps the lease and compare-and-set recovery contract in source', () => {
        const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');

        expect(source).toMatch(/FOR UPDATE SKIP LOCKED/);
        expect(source).toMatch(/"publicationStatus" = 'PUBLISHING'/);
        expect(source).toMatch(/"publishLeaseUntil" <=/);
        expect(source).toMatch(/"publishAttempts" = \$\{publication\.publishAttempts\}/);
        expect(source).toMatch(/"status" NOT IN \('SUCCEEDED', 'FAILED', 'DEAD_LETTERED'\)/);
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
