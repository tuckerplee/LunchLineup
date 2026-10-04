import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationType } from '@prisma/client';
import { NotificationOutboxProcessor } from './notification-outbox.processor';

describe('NotificationOutboxProcessor', () => {
    let tx: any;
    let tenantDb: any;
    let fanOut: any;

    const claimed = (attempts = 1) => ({
        id: 'outbox-1',
        tenantId: 'tenant-1',
        userId: 'user-1',
        dedupeKey: 'schedule-published:schedule-1:user-1',
        notificationType: NotificationType.SCHEDULE_PUBLISHED,
        title: 'Schedule published',
        body: 'Downtown: Jul 14, 2026 to Jul 20, 2026',
        attempts,
        failureCount: Math.max(0, attempts - 1),
        createdAt: new Date('2026-07-14T08:00:00.000Z'),
        leaseUntil: new Date(Date.now() + 30_000),
    });

    beforeEach(() => {
        tx = {
            // Limited composition seam: closed delegate shape; stateful ownership proof is in ownership.spec.
            $queryRaw: vi.fn(async (query: any, ...values: any[]) => {
                const sql = (query.strings ?? query).join('?');
                if (sql.includes('WITH candidates AS')) return tx.claims.shift() ?? [];
                if (sql.includes('FROM "Tenant"')) return [{ id: 'tenant-1', status: 'ACTIVE', deletedAt: null }];
                if (sql.includes('FROM "User"')) {
                    const selected = await tx.user.findFirst({ where: { id: 'user-1', tenantId: 'tenant-1', role: { in: ['MANAGER', 'STAFF'] }, deletedAt: null, suspendedAt: null }, select: { id: true, email: true } });
                    return selected ? [{ ...selected, role: 'STAFF', deletedAt: null, suspendedAt: null, emailDeliverySuppressedAt: null }] : [];
                }
                if (sql.includes('statement_timestamp()')) return [{ now: new Date() }];
                if (sql.includes('FROM "NotificationOutbox"')) return [{ ...claimed(tx.activeAttempt ?? 1), status: 'PROCESSING', leaseUntil: tx.activeLease }];
                throw new Error('Unexpected composition SQL');
            }),
            $executeRaw: vi.fn(async (query: any, ...values: any[]) => {
                if ((query.strings ?? query).join('?').includes('UPDATE "NotificationOutbox" SET "leaseUntil"')) tx.activeLease = new Date(values[0]);
                return 1;
            }),
            activeLease: undefined,
            activeAttempt: 1,
            claims: [],
            tenant: {
                findFirst: vi.fn().mockResolvedValue({ status: 'ACTIVE' }),
            },
            user: {
                findFirst: vi.fn().mockResolvedValue({ id: 'user-1', email: 'staff@example.test' }),
            },
            notification: {
                upsert: vi.fn().mockResolvedValue({
                    id: 'outbox-1',
                    tenantId: 'tenant-1',
                    userId: 'user-1',
                    type: NotificationType.SCHEDULE_PUBLISHED,
                    title: 'Schedule published',
                    body: 'Downtown: Jul 14, 2026 to Jul 20, 2026',
                    readAt: null,
                    createdAt: new Date('2026-07-14T08:00:00.000Z'),
                }),
            },
            notificationOutbox: {
                createMany: vi.fn().mockResolvedValue({ count: 1 }),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                count: vi.fn().mockResolvedValue(0),
                findMany: vi.fn().mockResolvedValue([
                    {
                        dedupeKey: 'schedule-published:schedule-1:user-1',
                        status: 'DELIVERED',
                    },
                ]),
            },
        };
        const runCompositionCallback = async (operation: (client: any) => Promise<unknown>) => {
            const originalLease = tx.activeLease;
            try {
                const result: any = await operation(tx);
                if (Array.isArray(result) && result[0]?.dedupeKey) { tx.activeLease = result[0].leaseUntil; tx.activeAttempt = result[0].attempts; }
                return result;
            } catch (error) { tx.activeLease = originalLease; throw error; }
        };
        tenantDb = {
            withTenant: vi.fn(async (_tenantId: string, operation: (client: any) => Promise<unknown>) => runCompositionCallback(operation)),
            withPlatformAdmin: vi.fn(async (operation: (client: any) => Promise<unknown>) => runCompositionCallback(operation)),
        };
        fanOut = vi.fn().mockResolvedValue(undefined);
    });

    it('enqueues one tenant-scoped intent per recipient with database deduplication', async () => {
        const processor = new NotificationOutboxProcessor(tenantDb, { fanOut });
        const entry = {
            tenantId: 'tenant-1',
            userId: 'user-1',
            dedupeKey: 'schedule-published:schedule-1:user-1',
            type: NotificationType.SCHEDULE_PUBLISHED,
            title: 'Schedule published',
            body: 'Downtown: Jul 14, 2026 to Jul 20, 2026',
        };

        await expect(processor.enqueueInTransaction(tx, [entry, entry])).resolves.toBe(1);

        expect(tx.notificationOutbox.createMany).toHaveBeenCalledWith({
            data: [
                expect.objectContaining({ dedupeKey: entry.dedupeKey, tenantId: 'tenant-1' }),
                expect.objectContaining({ dedupeKey: entry.dedupeKey, tenantId: 'tenant-1' }),
            ],
            skipDuplicates: true,
        });
    });

    it('atomically creates the durable notification before post-commit fan-out', async () => {
        tx.claims.push([claimed()]);
        const processor = new NotificationOutboxProcessor(tenantDb, { fanOut });

        await expect(
            processor.deliverPendingNow('tenant-1', ['schedule-published:schedule-1:user-1']),
        ).resolves.toEqual({ status: 'DELIVERED', delivered: 1, pending: 0, failed: 0 });

        expect(tx.user.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'user-1',
                tenantId: 'tenant-1',
                role: { in: ['MANAGER', 'STAFF'] },
                deletedAt: null,
                suspendedAt: null,
            },
            select: { id: true, email: true },
        });
        expect(tx.notification.upsert).toHaveBeenCalledWith({
            where: { id: 'outbox-1' },
            create: expect.objectContaining({
                id: 'outbox-1',
                tenantId: 'tenant-1',
                userId: 'user-1',
            }),
            update: {},
        });
        expect(tx.notificationOutbox.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 'outbox-1',
                    tenantId: 'tenant-1',
                    status: 'PROCESSING',
                    attempts: 1,
                }),
                data: expect.objectContaining({ status: 'DELIVERED', title: '', body: '' }),
            }),
        );
        expect(tx.notificationOutbox.updateMany.mock.invocationCallOrder[0])
            .toBeLessThan(fanOut.mock.invocationCallOrder[0]);
        expect(fanOut).toHaveBeenCalledWith(expect.objectContaining({ id: 'outbox-1' }));
    });

    it('recovers a committed pending intent after a process crash through the platform sweep', async () => {
        tx.claims.push([claimed()]);
        const processor = new NotificationOutboxProcessor(tenantDb, { fanOut });

        await (processor as any).sweep();

        expect(tenantDb.withPlatformAdmin).toHaveBeenCalledOnce();
        expect(tx.notification.upsert).toHaveBeenCalledOnce();
        expect(fanOut).toHaveBeenCalledOnce();
        const sql = tx.$queryRaw.mock.calls[0][0].strings.join(' ');
        expect(sql).toContain('FOR UPDATE SKIP LOCKED');
        expect(sql).toContain('outbox."leaseUntil" <=');
    });

    it('retries a transient failure with the same notification identity and no duplicate fan-out', async () => {
        tx.claims.push([claimed(1)], [claimed(2)]);
        tx.notification.upsert
            .mockRejectedValueOnce(new Error('database unavailable'))
            .mockResolvedValueOnce({
                id: 'outbox-1',
                tenantId: 'tenant-1',
                userId: 'user-1',
                type: NotificationType.SCHEDULE_PUBLISHED,
            });
        tx.notificationOutbox.findMany
            .mockResolvedValueOnce([{ dedupeKey: claimed().dedupeKey, status: 'FAILED' }])
            .mockResolvedValueOnce([{ dedupeKey: claimed().dedupeKey, status: 'DELIVERED' }]);
        const processor = new NotificationOutboxProcessor(tenantDb, { fanOut, maxAttempts: 3 });

        await expect(
            processor.deliverPendingNow('tenant-1', [claimed().dedupeKey]),
        ).resolves.toEqual({ status: 'PENDING', delivered: 0, pending: 1, failed: 0 });
        expect(fanOut).not.toHaveBeenCalled();

        await expect(
            processor.deliverPendingNow('tenant-1', [claimed().dedupeKey]),
        ).resolves.toEqual({ status: 'DELIVERED', delivered: 1, pending: 0, failed: 0 });

        expect(tx.notification.upsert).toHaveBeenCalledTimes(2);
        expect(tx.notification.upsert.mock.calls[0][0].where)
            .toEqual(tx.notification.upsert.mock.calls[1][0].where);
        expect(tx.notificationOutbox.updateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'FAILED',
                    nextAttemptAt: expect.any(Date),
                    leaseUntil: null,
                }),
            }),
        );
        expect(fanOut).toHaveBeenCalledOnce();
    });

    it('retries schedule email with one stable outbox identity before marking delivery complete', async () => {
        tx.claims.push([claimed(1)], [claimed(2)]);
        tx.notificationOutbox.findMany
            .mockResolvedValueOnce([{ dedupeKey: claimed().dedupeKey, status: 'FAILED' }])
            .mockResolvedValueOnce([{ dedupeKey: claimed().dedupeKey, status: 'DELIVERED' }]);
        const deliverExternal = vi.fn()
            .mockRejectedValueOnce(new Error('provider response contained recipient@example.test'))
            .mockResolvedValueOnce('accepted');
        const processor = new NotificationOutboxProcessor(tenantDb, {
            fanOut,
            deliverExternal,
            maxAttempts: 3,
        });

        await expect(
            processor.deliverPendingNow('tenant-1', [claimed().dedupeKey]),
        ).resolves.toEqual({ status: 'PENDING', delivered: 0, pending: 1, failed: 0 });
        expect(fanOut).not.toHaveBeenCalled();

        await expect(
            processor.deliverPendingNow('tenant-1', [claimed().dedupeKey]),
        ).resolves.toEqual({ status: 'DELIVERED', delivered: 1, pending: 0, failed: 0 });

        expect(deliverExternal).toHaveBeenCalledTimes(2);
        expect(deliverExternal.mock.calls.map(([intent]: any[]) => intent.id))
            .toEqual(['outbox-1', 'outbox-1']);
        expect(deliverExternal.mock.calls[0][1]).toBe('staff@example.test');
        expect(tx.notification.upsert).toHaveBeenCalledTimes(2);
        expect(fanOut).toHaveBeenCalledOnce();
        expect(tx.notificationOutbox.updateMany).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'FAILED',
                    lastError: 'category=unknown class=Error',
                }),
            }),
        );
    });

    it('persists and logs terminal failure after bounded attempts', async () => {
        tx.claims.push([claimed(2)]);
        tx.notification.upsert.mockRejectedValueOnce(
            new Error('password=secret database unavailable'),
        );
        tx.notificationOutbox.findMany.mockResolvedValueOnce([
            { dedupeKey: claimed().dedupeKey, status: 'DEAD_LETTERED' },
        ]);
        const processor = new NotificationOutboxProcessor(tenantDb, { fanOut, maxAttempts: 2 });
        const terminalLog = vi.spyOn((processor as any).logger, 'error').mockImplementation(() => undefined);

        await expect(
            processor.deliverPendingNow('tenant-1', [claimed().dedupeKey]),
        ).resolves.toEqual({ status: 'FAILED', delivered: 0, pending: 0, failed: 1 });

        expect(tx.notificationOutbox.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 'outbox-1',
                    tenantId: 'tenant-1',
                    attempts: 2,
                }),
                data: expect.objectContaining({
                    status: 'DEAD_LETTERED',
                    nextAttemptAt: null,
                    leaseUntil: null,
                    title: '',
                    body: '',
                    lastError: null,
                }),
            }),
        );
        expect(terminalLog).toHaveBeenCalledWith(
            'Notification outbox terminal failure attempts=2 category=unknown class=Error',
        );
        const serializedLog = JSON.stringify(terminalLog.mock.calls);
        expect(serializedLog).not.toContain('tenant-1');
        expect(serializedLog).not.toContain('outbox-1');
        expect(serializedLog).not.toContain('secret');
    });

    it('reports delivery outcomes and terminal backlog without payload labels', async () => {
        tx.claims.push([claimed()]);
        tx.notificationOutbox.count.mockResolvedValueOnce(3);
        const recordOutcome = vi.fn();
        const setDeadLetteredCount = vi.fn();
        const processor = new NotificationOutboxProcessor(tenantDb, {
            fanOut,
            recordOutcome,
            setDeadLetteredCount,
        });

        await (processor as any).sweep();

        expect(recordOutcome).toHaveBeenCalledWith('delivered');
        expect(setDeadLetteredCount).toHaveBeenCalledWith(3);
        expect(recordOutcome).toHaveBeenCalledWith(expect.not.stringContaining('schedule'));
    });

    it('reports retryable and unclaimed intents as pending instead of failed', async () => {
        tx.claims.push([]);
        tx.notificationOutbox.findMany.mockResolvedValueOnce([
            { dedupeKey: 'delivered', status: 'DELIVERED' },
            { dedupeKey: 'retrying', status: 'FAILED' },
            { dedupeKey: 'terminal', status: 'DEAD_LETTERED' },
        ]);
        const processor = new NotificationOutboxProcessor(tenantDb, { fanOut });

        await expect(processor.deliverPendingNow('tenant-1', [
            'delivered',
            'retrying',
            'terminal',
            'not-yet-visible',
        ])).resolves.toEqual({
            status: 'PARTIAL',
            delivered: 1,
            pending: 2,
            failed: 1,
        });
    });

    it('dead-letters an intent when its tenant or recipient is no longer eligible', async () => {
        tx.claims.push([claimed()]);
        tx.user.findFirst.mockResolvedValueOnce(null);
        tx.notificationOutbox.findMany.mockResolvedValueOnce([
            { dedupeKey: claimed().dedupeKey, status: 'DEAD_LETTERED' },
        ]);
        const processor = new NotificationOutboxProcessor(tenantDb, { fanOut });

        await processor.deliverPendingNow('tenant-1', [claimed().dedupeKey]);

        expect(tx.notification.upsert).not.toHaveBeenCalled();
        expect(tx.notificationOutbox.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'DEAD_LETTERED',
                    title: '',
                    body: '',
                    lastError: null,
                }),
            }),
        );
        expect(fanOut).not.toHaveBeenCalled();
    });
});
