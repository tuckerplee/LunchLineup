import { describe, expect, it, vi } from 'vitest';
import {
    TenantDeletionBillingReconcilerProcessor,
    type TenantDeletionBillingReconciliationSource,
} from './tenant-deletion-billing-reconciler.processor';

const claim = (tenantId: string) => ({
    tenantId,
    operationId: `operation-${tenantId}`,
    leaseOwner: `owner-${tenantId}`,
    leaseToken: `token-${tenantId}`,
});

describe('TenantDeletionBillingReconcilerProcessor', () => {
    it('claims just in time, excludes attempted tenants, and advances healthy work', async () => {
        const source: TenantDeletionBillingReconciliationSource = {
            claimEligible: vi.fn()
                .mockResolvedValueOnce([claim('old-failure')])
                .mockResolvedValueOnce([claim('new-healthy')]),
            reconcileClaimed: vi.fn(async (candidate) => {
                if (candidate.tenantId === 'old-failure') throw new Error('provider unavailable');
            }),
            readBacklog: vi.fn().mockResolvedValue({
                count: 1,
                oldestPendingAt: new Date('2026-07-16T11:59:00.000Z'),
            }),
        };
        const recordOutcome = vi.fn();
        const setBacklog = vi.fn();
        const setOldestPendingAgeSeconds = vi.fn();
        const recordSweep = vi.fn();
        const processor = new TenantDeletionBillingReconcilerProcessor(source, {
            batchSize: 2,
            now: () => new Date('2026-07-16T12:00:00.000Z'),
            recordOutcome,
            setBacklog,
            setOldestPendingAgeSeconds,
            recordSweep,
        });

        await expect(processor.sweepNow()).resolves.toEqual({
            claimed: 2,
            succeeded: 1,
            failed: 1,
            backlog: 1,
        });
        expect(source.reconcileClaimed).toHaveBeenCalledTimes(2);
        expect(source.claimEligible).toHaveBeenNthCalledWith(1, 1, []);
        expect(source.claimEligible).toHaveBeenNthCalledWith(2, 1, ['old-failure']);
        expect(recordOutcome).toHaveBeenNthCalledWith(1, 'failed');
        expect(recordOutcome).toHaveBeenNthCalledWith(2, 'succeeded');
        expect(setBacklog).toHaveBeenCalledWith(1);
        expect(setOldestPendingAgeSeconds).toHaveBeenCalledWith(60);
        expect(recordSweep).toHaveBeenCalledWith(1784203200, false);
    });

    it('shares one active sweep between overlapping scheduler ticks', async () => {
        let release!: () => void;
        const deferred = new Promise<void>((resolve) => { release = resolve; });
        const source: TenantDeletionBillingReconciliationSource = {
            claimEligible: vi.fn()
                .mockResolvedValueOnce([claim('tenant-1')])
                .mockResolvedValueOnce([]),
            reconcileClaimed: vi.fn(() => deferred),
            readBacklog: vi.fn().mockResolvedValue({ count: 0, oldestPendingAt: null }),
        };
        const processor = new TenantDeletionBillingReconcilerProcessor(source);

        const first = processor.sweepNow();
        const second = processor.sweepNow();
        expect(second).toBe(first);
        await vi.waitFor(() => expect(source.reconcileClaimed).toHaveBeenCalledOnce());
        release();
        await expect(first).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
        expect(source.claimEligible).toHaveBeenCalledTimes(2);
    });

    it('clamps every configured sweep to the bounded production ceiling', async () => {
        const source: TenantDeletionBillingReconciliationSource = {
            claimEligible: vi.fn(async (_limit, excludedTenantIds = []) => [
                claim(`tenant-${excludedTenantIds.length}`),
            ]),
            reconcileClaimed: vi.fn().mockResolvedValue(undefined),
            readBacklog: vi.fn().mockResolvedValue({ count: 0, oldestPendingAt: null }),
        };
        const processor = new TenantDeletionBillingReconcilerProcessor(source, { batchSize: 10_000 });

        await processor.sweepNow();

        expect(source.claimEligible).toHaveBeenCalledTimes(100);
        expect(source.reconcileClaimed).toHaveBeenCalledTimes(100);
        expect(source.claimEligible).toHaveBeenLastCalledWith(
            1,
            Array.from({ length: 99 }, (_value, index) => `tenant-${index}`),
        );
    });

    it('aborts an active provider attempt and returns after the bounded drain deadline', async () => {
        let terminateTransport!: () => void;
        let observedSignal: AbortSignal | undefined;
        const transportTerminated = new Promise<void>((resolve) => {
            terminateTransport = resolve;
        });
        const source: TenantDeletionBillingReconciliationSource = {
            claimEligible: vi.fn().mockResolvedValueOnce([claim('tenant-hung')]),
            reconcileClaimed: vi.fn((_candidate, signal) => {
                observedSignal = signal;
                return transportTerminated;
            }),
            readBacklog: vi.fn().mockResolvedValue({ count: 1, oldestPendingAt: new Date() }),
        };
        const processor = new TenantDeletionBillingReconcilerProcessor(source, {
            stopDrainTimeoutMs: 100,
        });

        const sweep = processor.sweepNow();
        await vi.waitFor(() => expect(source.reconcileClaimed).toHaveBeenCalledOnce());
        let stopCompleted = false;
        const stop = processor.stop().then(() => { stopCompleted = true; });

        await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 125));
        expect(stopCompleted).toBe(true);
        await stop;
        terminateTransport();
        await sweep;
    });
});
