import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AvailabilityImportPublisher } from './availability-imports.publisher';

const claim = (token = 'publish-token-1') => ({
    id: 'import-1',
    tenantId: 'tenant-1',
    publishToken: token,
    publishAttempts: 1,
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
