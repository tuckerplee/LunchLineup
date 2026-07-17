import { describe, expect, it, vi } from 'vitest';
import {
    TenantCancellationLifecycleService,
    type PreparedTenantCancellationIntent,
    type TenantCancellationCompensationOutcome,
    type TenantCancellationIntentStore,
    type TenantCancellationOutcome,
} from './tenant-cancellation-lifecycle.service';
import {
    TenantCancellationReconcilerProcessor,
    type TenantCancellationReconciliationSource,
} from './tenant-cancellation-reconciler.processor';

const scheduledOutcome: TenantCancellationOutcome = {
    action: 'scheduled',
    cancelAtPeriodEnd: true,
    currentPeriodEnd: '2027-01-15T08:00:00.000Z',
    cancelAt: null,
    canceledAt: null,
    cancellationBehavior: 'cancel_at_period_end',
};

class SharedLeaseStore implements TenantCancellationIntentStore {
    readonly events: string[] = [];
    claimCalls = 0;
    finalizeCalls = 0;
    private ownerSequence = 0;
    private clockMs = Date.parse('2026-07-16T20:00:00.000Z');
    private prepared: PreparedTenantCancellationIntent;

    constructor(state: 'PENDING_PROVIDER' | 'PROVIDER_APPLIED' = 'PENDING_PROVIDER') {
        this.prepared = {
            tenant: {
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'ACTIVE',
                deletedAt: null,
                retentionLegalHoldAt: null,
                stripeSubscriptionId: 'sub_private_123',
            },
            intent: {
                tenantId: 'tenant-1',
                kind: 'CUSTOMER_CANCELLATION',
                operationId: 'operation-1',
                state,
                actorUserId: 'user-1',
                actorTenantId: 'tenant-1',
                ipAddress: '203.0.113.10',
                userAgent: 'reconciler-test',
                reason: 'Customer requested cancellation.',
                providerSubscriptionId: 'sub_private_123',
                subscriptionFingerprint: 'fingerprint',
                providerLeaseOwner: null,
                providerLeaseExpiresAt: null,
                providerAttempts: 0,
                providerMutationOwned: state === 'PROVIDER_APPLIED' ? true : null,
                providerResult: state === 'PROVIDER_APPLIED' ? scheduledOutcome : null,
                compensationResult: null,
                terminalReason: null,
                terminalizedAt: null,
            },
            providerLeaseOwner: null,
        };
    }

    async prepare(): Promise<PreparedTenantCancellationIntent> {
        return this.prepared;
    }

    async claimRecoverable(
        limit: number,
        excludedOperationIds: readonly string[] = [],
    ): Promise<PreparedTenantCancellationIntent[]> {
        this.claimCalls += 1;
        if (
            limit < 1
            || ['FINALIZED', 'BLOCKED', 'SUPERSEDED'].includes(this.prepared.intent.state)
            || excludedOperationIds.includes(this.prepared.intent.operationId)
        ) return [];
        const expiresAt = this.prepared.intent.providerLeaseExpiresAt;
        if (
            this.prepared.providerLeaseOwner
            && expiresAt
            && expiresAt.getTime() > this.clockMs
        ) {
            return [];
        }
        const owner = `replica-owner-${++this.ownerSequence}`;
        this.prepared = {
            ...this.prepared,
            intent: {
                ...this.prepared.intent,
                providerLeaseOwner: owner,
                providerLeaseExpiresAt: new Date(this.clockMs + 60_000),
                providerAttempts: this.prepared.intent.providerAttempts + 1,
            },
            providerLeaseOwner: owner,
        };
        this.events.push('claimed');
        return [this.prepared];
    }

    async markProviderApplied(
        prepared: PreparedTenantCancellationIntent,
        outcome: TenantCancellationOutcome,
    ): Promise<PreparedTenantCancellationIntent> {
        this.events.push('provider-state-persisted');
        if (this.prepared.providerLeaseOwner !== prepared.providerLeaseOwner) {
            throw new Error('claim lost');
        }
        this.prepared = {
            ...this.prepared,
            intent: {
                ...this.prepared.intent,
                state: 'PROVIDER_APPLIED',
                providerResult: outcome,
            },
        };
        return this.prepared;
    }

    async renewProviderClaim(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent> {
        if (this.prepared.providerLeaseOwner !== prepared.providerLeaseOwner) {
            throw new Error('claim lost');
        }
        this.prepared = {
            ...this.prepared,
            intent: {
                ...this.prepared.intent,
                providerLeaseExpiresAt: new Date(this.clockMs + 60_000),
            },
        };
        return this.prepared;
    }

    providerLeaseRenewalIntervalMs(): number {
        return 20_000;
    }

    async markCompensated(
        prepared: PreparedTenantCancellationIntent,
        outcome: TenantCancellationCompensationOutcome,
    ): Promise<PreparedTenantCancellationIntent> {
        this.prepared = {
            ...prepared,
            intent: {
                ...prepared.intent,
                state: 'BLOCKED',
                compensationResult: outcome,
                terminalReason: 'LEGAL_HOLD',
                terminalizedAt: new Date(this.clockMs),
                providerLeaseOwner: null,
                providerLeaseExpiresAt: null,
            },
            providerLeaseOwner: null,
        };
        return this.prepared;
    }

    async releaseProviderClaim(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<void> {
        if (this.prepared.providerLeaseOwner !== prepared.providerLeaseOwner) return;
        this.prepared = {
            ...this.prepared,
            intent: {
                ...this.prepared.intent,
                providerLeaseOwner: null,
                providerLeaseExpiresAt: null,
            },
            providerLeaseOwner: null,
        };
        this.events.push('claim-released');
    }

    async finalize(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent> {
        if (this.prepared.providerLeaseOwner !== prepared.providerLeaseOwner) {
            throw new Error('claim lost');
        }
        this.finalizeCalls += 1;
        this.events.push('local-finalized');
        this.prepared = {
            ...this.prepared,
            intent: {
                ...this.prepared.intent,
                state: 'FINALIZED',
                providerLeaseOwner: null,
                providerLeaseExpiresAt: null,
            },
            providerLeaseOwner: null,
        };
        return this.prepared;
    }

    async countBacklog(): Promise<number> {
        return ['FINALIZED', 'BLOCKED', 'SUPERSEDED'].includes(this.prepared.intent.state)
            ? 0
            : 1;
    }

    crashWithLease(leaseMs: number): void {
        const owner = `crashed-owner-${++this.ownerSequence}`;
        this.prepared = {
            ...this.prepared,
            intent: {
                ...this.prepared.intent,
                providerLeaseOwner: owner,
                providerLeaseExpiresAt: new Date(this.clockMs + leaseMs),
                providerAttempts: this.prepared.intent.providerAttempts + 1,
            },
            providerLeaseOwner: owner,
        };
    }

    advance(ms: number): void {
        this.clockMs += ms;
    }
}

function reconciliationHarness(
    store: SharedLeaseStore,
    provider: (
        tenantId: string,
        stripeSubscriptionId?: string | null,
    ) => Promise<any>,
): TenantCancellationReconciliationSource {
    const lifecycle = new TenantCancellationLifecycleService(
        {} as any,
        () => ({ cancelTenantSubscriptionAtPeriodEnd: provider }),
        store,
    );
    return {
        claimRecoverable: (limit, excludedOperationIds) =>
            store.claimRecoverable(limit, excludedOperationIds),
        reconcilePrepared: async (prepared) => {
            store.events.push('provider-read-started');
            return lifecycle.reconcilePrepared(prepared);
        },
        countBacklog: () => store.countBacklog(),
    };
}

describe('TenantCancellationReconcilerProcessor', () => {
    it('lets only one API replica claim and apply a shared intent', async () => {
        const store = new SharedLeaseStore();
        const provider = vi.fn(async () => scheduledOutcome);
        const source = reconciliationHarness(store, provider);
        const first = new TenantCancellationReconcilerProcessor(source);
        const second = new TenantCancellationReconcilerProcessor(source);

        const summaries = await Promise.all([first.sweepNow(), second.sweepNow()]);

        expect(summaries.reduce((total, summary) => total + summary.claimed, 0)).toBe(1);
        expect(summaries.reduce((total, summary) => total + summary.succeeded, 0)).toBe(1);
        expect(provider).toHaveBeenCalledOnce();
        expect(store.finalizeCalls).toBe(1);
    });

    it('recovers a crashed owner only after its lease expires', async () => {
        const store = new SharedLeaseStore();
        store.crashWithLease(60_000);
        const provider = vi.fn(async () => scheduledOutcome);
        const processor = new TenantCancellationReconcilerProcessor(
            reconciliationHarness(store, provider),
        );

        await expect(processor.sweepNow()).resolves.toMatchObject({ claimed: 0, backlog: 1 });
        expect(provider).not.toHaveBeenCalled();

        store.advance(60_001);
        await expect(processor.sweepNow()).resolves.toMatchObject({
            claimed: 1,
            succeeded: 1,
            backlog: 0,
        });
        expect(provider).toHaveBeenCalledOnce();
    });

    it('fails closed and preserves backlog when the provider is unavailable', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const store = new SharedLeaseStore();
        const provider = vi.fn(async () => {
            throw new Error('STRIPE_SECRET_KEY=must-not-escape');
        });
        const outcomes: string[] = [];
        const processor = new TenantCancellationReconcilerProcessor(
            reconciliationHarness(store, provider),
            { recordOutcome: (outcome) => outcomes.push(outcome) },
        );

        await expect(processor.sweepNow()).resolves.toMatchObject({
            claimed: 1,
            succeeded: 0,
            failed: 1,
            backlog: 1,
        });
        expect(store.finalizeCalls).toBe(0);
        expect(store.events).toContain('claim-released');
        expect(outcomes).toEqual(['failed']);
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain('must-not-escape');
        consoleError.mockRestore();
    });

    it('rereads already-terminal provider state before local finalization', async () => {
        const store = new SharedLeaseStore('PROVIDER_APPLIED');
        const provider = vi.fn(async () => ({
            ...scheduledOutcome,
            action: 'already_canceled',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            canceledAt: '2026-07-16T19:00:00.000Z',
        } as const));
        const processor = new TenantCancellationReconcilerProcessor(
            reconciliationHarness(store, provider),
        );

        await expect(processor.sweepNow()).resolves.toMatchObject({ succeeded: 1 });
        expect(store.events).toEqual([
            'claimed',
            'provider-read-started',
            'provider-state-persisted',
            'local-finalized',
        ]);
        expect(provider).toHaveBeenCalledOnce();
    });

    it('waits for the active sweep on shutdown and never overlaps it', async () => {
        let resolveProvider!: (value: TenantCancellationOutcome) => void;
        const provider = vi.fn(() => new Promise<TenantCancellationOutcome>((resolve) => {
            resolveProvider = resolve;
        }));
        const store = new SharedLeaseStore();
        const processor = new TenantCancellationReconcilerProcessor(
            reconciliationHarness(store, provider),
        );

        processor.start();
        await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
        const overlapping = processor.sweepNow();
        const stopping = processor.stop();
        let stopped = false;
        void stopping.then(() => { stopped = true; });
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(store.claimCalls).toBe(1);

        resolveProvider(scheduledOutcome);
        await expect(overlapping).resolves.toMatchObject({ succeeded: 1 });
        await stopping;
        await expect(processor.sweepNow()).resolves.toMatchObject({ claimed: 0 });
        expect(store.claimCalls).toBe(2);
    });

    it('makes finalized replay idempotent and exports success plus backlog observations', async () => {
        const store = new SharedLeaseStore();
        const provider = vi.fn(async () => scheduledOutcome);
        const outcomes: string[] = [];
        const backlogs: number[] = [];
        const processor = new TenantCancellationReconcilerProcessor(
            reconciliationHarness(store, provider),
            {
                recordOutcome: (outcome) => outcomes.push(outcome),
                setBacklog: (count) => backlogs.push(count),
            },
        );

        await processor.sweepNow();
        await processor.sweepNow();

        expect(provider).toHaveBeenCalledOnce();
        expect(store.finalizeCalls).toBe(1);
        expect(outcomes).toEqual(['succeeded']);
        expect(backlogs).toEqual([0, 0]);
    });

    it('claims each configured sweep one intent at a time', async () => {
        const claimRecoverable = vi.fn().mockResolvedValue([]);
        const processor = new TenantCancellationReconcilerProcessor({
            claimRecoverable,
            reconcilePrepared: vi.fn(),
            countBacklog: vi.fn().mockResolvedValue(0),
        }, { batchSize: 10_000 });

        await processor.sweepNow();

        expect(claimRecoverable).toHaveBeenCalledWith(1, []);
    });
});
