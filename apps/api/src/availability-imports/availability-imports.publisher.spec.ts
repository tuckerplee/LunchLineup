import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AvailabilityImportPublisher } from './availability-imports.publisher';

const claim = (token = 'publish-token-1') => ({
    id: 'import-1',
    tenantId: 'tenant-1',
    publishToken: token,
    publishAttempts: 1,
    attempts: 0,
});

describe('AvailabilityImportPublisher', () => {
    let tenantDb: any;
    let tx: any;

    beforeEach(() => {
        tx = {
            $executeRaw: vi.fn().mockResolvedValue(0),
            $queryRaw: vi.fn().mockResolvedValue([]),
            availabilityImportJob: {
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
        };
        tenantDb = {
            withTenant: vi.fn(async (_tenantId: string, operation: (client: any) => Promise<unknown>) => operation(tx)),
            withPlatformAdmin: vi.fn(async (operation: (client: any) => Promise<unknown>) => operation(tx)),
        };
    });

    it('never overwrites a fast worker processing transition after broker confirmation', async () => {
        const publisher = new AvailabilityImportPublisher(tenantDb);
        vi.spyOn(publisher as any, 'publishMessage').mockResolvedValue(undefined);

        await (publisher as any).publishClaim(claim());

        const mutation = tx.availabilityImportJob.updateMany.mock.calls[0][0];
        expect(mutation.where).toMatchObject({
            id: 'import-1',
            publicationStatus: 'PUBLISHING',
            publishToken: 'publish-token-1',
        });
        expect(mutation.data).toMatchObject({
            publicationStatus: 'PUBLISHED',
            publicationAmbiguous: false,
        });
        expect(mutation.data).not.toHaveProperty('status');
        expect(mutation.data).not.toHaveProperty('completedAt');
    });

    it('leaves a confirmed publish leased and republishes after a database crash', async () => {
        const publisher = new AvailabilityImportPublisher(tenantDb);
        const publish = vi.spyOn(publisher as any, 'publishMessage').mockResolvedValue(undefined);
        vi.spyOn((publisher as any).logger, 'warn').mockImplementation(() => undefined);
        tenantDb.withTenant
            .mockRejectedValueOnce(new Error('database unavailable after confirm'))
            .mockImplementationOnce(async (_tenantId: string, operation: (client: any) => Promise<unknown>) => operation(tx));

        await (publisher as any).publishClaim(claim('publish-token-1'));
        expect(tx.availabilityImportJob.updateMany).not.toHaveBeenCalled();

        await (publisher as any).publishClaim({
            ...claim('publish-token-2'),
            publishAttempts: 2,
        });

        expect(publish).toHaveBeenCalledTimes(2);
        expect(tx.availabilityImportJob.updateMany).toHaveBeenCalledOnce();
        expect(tx.availabilityImportJob.updateMany.mock.calls[0][0].where.publishToken)
            .toBe('publish-token-2');
    });

    it('reclaims expired leases and reconciles worker-accepted ambiguous publishes', async () => {
        const publisher = new AvailabilityImportPublisher(tenantDb);

        await (publisher as any).publishPending();

        const claimSql = tx.$queryRaw.mock.calls[0][0].strings.join(' ');
        expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
        expect(claimSql).toContain('job."publishLeaseUntil" <=');
        expect(claimSql).toContain('job."status" = \'PENDING\'');
        const reconcileSql = tx.$executeRaw.mock.calls[0][0].strings.join(' ');
        expect(reconcileSql).toContain('"attempts" > 0');
        expect(reconcileSql).toContain('"startedAt" IS NOT NULL');
        expect(reconcileSql).toContain('"status" <> \'PENDING\'');
        const recoverySql = tx.$executeRaw.mock.calls[1][0].strings.join(' ');
        expect(recoverySql).toContain('job."status" = \'RUNNING\'');
        expect(recoverySql).toContain('job."executionLeaseUntil" <= CURRENT_TIMESTAMP');
        expect(recoverySql).toContain('job."expiresAt" > CURRENT_TIMESTAMP');
        expect(recoverySql).toContain('FOR UPDATE SKIP LOCKED');
        expect(recoverySql).toContain('"executionToken" = NULL');
        expect(recoverySql).toContain('"publicationStatus" = \'PENDING\'');
        expect(recoverySql).toContain('job."executionLeaseUntil" IS NULL');
        expect(recoverySql).toContain('job."status" = \'RETRYING\'');
        expect(recoverySql).toContain('job."executionToken" IS NULL');
        expect(recoverySql).toContain('job."updatedAt" <=');
    });

    it('preserves durable execution budget on recovery publication and caps only the wire envelope', async () => {
        const publisher = new AvailabilityImportPublisher(tenantDb);
        const publish = vi.spyOn(publisher as any, 'publishMessage').mockResolvedValue(undefined);
        vi.stubEnv('WORKER_MAX_RETRIES', '2');
        try {
            for (const attempts of [0, 1, 2, 3]) {
                await (publisher as any).publishClaim({ ...claim(), attempts });
                expect(publish).toHaveBeenLastCalledWith('tenant-1', 'import-1', Math.min(attempts, 2));
                expect(tx.availabilityImportJob.updateMany.mock.calls.at(-1)[0].data).not.toHaveProperty('attempts');
            }
        } finally { vi.unstubAllEnvs(); }
    });

    it('waits beyond the configured longest broker retry delay before recovering ownership-free RETRYING', async () => {
        const publisher = new AvailabilityImportPublisher(tenantDb);
        vi.stubEnv('WORKER_RETRY_BACKOFF_3_SECONDS', '3600');
        try {
            await (publisher as any).recoverExpiredExecutions();
            expect(tx.$executeRaw.mock.calls[0][0].values).toContain(3660);
        } finally { vi.unstubAllEnvs(); }
    });

    it('binds API recovery and worker execution to identical Compose retry policy values', () => {
        const source = readFileSync(resolve(__dirname, '../../../../docker-compose.yml'), 'utf8');
        const api = source.split('\n  api:')[1].split(/\n  \S/)[0];
        const worker = source.split('\n  worker:')[1].split(/\n  \S/)[0];
        for (const [name, fallback] of [['WORKER_MAX_RETRIES', '3'], ['WORKER_RETRY_BACKOFF_1_SECONDS', '5'],
            ['WORKER_RETRY_BACKOFF_2_SECONDS', '30'], ['WORKER_RETRY_BACKOFF_3_SECONDS', '120']]) {
            const binding = `${name}=\u0024{${name}:-${fallback}}`;
            expect(api).toContain(binding);
            expect(worker).toContain(binding);
        }
    });

    it('fails closed without claiming or sending when execution recovery fails', async () => {
        const publisher = new AvailabilityImportPublisher(tenantDb);
        const publish = vi.spyOn(publisher as any, 'publishMessage').mockResolvedValue(undefined);
        tx.$executeRaw.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('database unavailable'));

        await expect((publisher as any).publishPending()).rejects.toThrow('database unavailable');

        expect(tx.$queryRaw).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it('records broker failure only in publication metadata', async () => {
        const publisher = new AvailabilityImportPublisher(tenantDb);
        vi.spyOn(publisher as any, 'publishMessage').mockRejectedValue(new Error('broker unavailable'));

        await (publisher as any).publishClaim(claim());

        const mutation = tx.availabilityImportJob.updateMany.mock.calls[0][0];
        expect(mutation.data).toMatchObject({
            publicationStatus: 'FAILED',
            publishToken: null,
            publishLeaseUntil: null,
            publicationAmbiguous: true,
            publishLastError: 'Error',
        });
        expect(mutation.data.nextPublishAt).toBeInstanceOf(Date);
        expect(mutation.data).not.toHaveProperty('status');
    });

    it('fails readiness before draining and never starts another sweep during shutdown', async () => {
        const publisher = new AvailabilityImportPublisher(tenantDb);
        let releaseSweep!: () => void;
        const pendingSweep = new Promise<void>((resolve) => {
            releaseSweep = resolve;
        });
        const publishPending = vi.spyOn(publisher as any, 'publishPending')
            .mockReturnValue(pendingSweep);

        publisher.onModuleInit();
        expect(publisher.isReady()).toBe(true);
        expect(publishPending).toHaveBeenCalledOnce();

        const shutdown = publisher.onModuleDestroy();
        expect(publisher.isReady()).toBe(false);
        publisher.kick();
        expect(publishPending).toHaveBeenCalledOnce();

        releaseSweep();
        await shutdown;
        expect(publisher.isReady()).toBe(false);
    });

    it('bounds shutdown and force-destroys active RabbitMQ transports', async () => {
        vi.useFakeTimers();
        try {
            const publisher = new AvailabilityImportPublisher(tenantDb);
            const destroy = vi.fn();
            (publisher as any).lifecycle = 'ready';
            (publisher as any).activeSweep = new Promise<void>(() => undefined);
            (publisher as any).activeConnections.add({
                connection: { stream: { destroy } },
            });

            const shutdown = publisher.onModuleDestroy();
            await vi.advanceTimersByTimeAsync(15_000);
            await shutdown;

            expect(destroy).toHaveBeenCalledOnce();
            expect(publisher.isReady()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
