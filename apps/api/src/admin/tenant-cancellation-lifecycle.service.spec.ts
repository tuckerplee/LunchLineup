import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { FeatureAccessService } from '../billing/feature-access.service';
import { StripeService } from '../billing/stripe.service';
import { TenantAccountLifecycleService } from './tenant-account-lifecycle.service';
import { TenantCancellationReconcilerProcessor } from './tenant-cancellation-reconciler.processor';
import {
    PrismaTenantCancellationIntentStore,
    TenantCancellationLifecycleService,
    type PreparedTenantCancellationIntent,
    type TenantCancellationCompensationOutcome,
    type TenantCancellationIntentStore,
    type TenantCancellationOutcome,
} from './tenant-cancellation-lifecycle.service';

const customerActor = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    ipAddress: '203.0.113.10',
    userAgent: 'vitest-customer',
};

const platformActor = {
    tenantId: 'platform-tenant',
    userId: 'platform-admin-1',
    ipAddress: '203.0.113.20',
    userAgent: 'vitest-platform',
};

const providerResult = {
    action: 'scheduled' as const,
    stripeSubscriptionId: 'sub_private_123',
    stripeStatus: 'active',
    cancelAtPeriodEnd: true,
    currentPeriodEnd: '2027-01-15T08:00:00.000Z',
    cancelAt: null,
    canceledAt: null,
    cancellationBehavior: 'cancel_at_period_end' as const,
};

class FailureInjectingStore implements TenantCancellationIntentStore {
    readonly events: string[] = [];
    readonly prepareInputs: any[] = [];
    markFailures = 0;
    finalizeFailures = 0;
    legalHoldWins = false;
    prepared?: PreparedTenantCancellationIntent;

    async prepare(input: any): Promise<PreparedTenantCancellationIntent> {
        this.events.push('intent-committed');
        this.prepareInputs.push(input);
        if (!this.prepared) {
            this.prepared = {
                tenant: {
                    id: input.tenantId,
                    slug: 'acme-dining',
                    status: 'ACTIVE',
                    deletedAt: null,
                    retentionLegalHoldAt: null,
                    stripeSubscriptionId: 'sub_private_123',
                },
                intent: {
                    tenantId: input.tenantId,
                    kind: input.kind,
                    operationId: 'operation-1',
                    state: 'PENDING_PROVIDER',
                    actorUserId: input.actor.userId,
                    actorTenantId: input.actor.tenantId,
                    ipAddress: input.actor.ipAddress,
                    userAgent: input.actor.userAgent,
                    reason: input.reason ?? null,
                    providerSubscriptionId: 'sub_private_123',
                    subscriptionFingerprint: 'fingerprint',
                    providerLeaseOwner: 'provider-owner',
                    providerLeaseExpiresAt: new Date(Date.now() + 60_000),
                    providerAttempts: 1,
                    providerMutationOwned: null,
                    providerResult: null,
                    compensationResult: null,
                    terminalReason: null,
                    terminalizedAt: null,
                },
                providerLeaseOwner: 'provider-owner',
            } as PreparedTenantCancellationIntent;
        } else if (this.prepared.intent.state !== 'FINALIZED') {
            const providerLeaseOwner = 'provider-owner-replay';
            this.prepared = {
                ...this.prepared,
                intent: {
                    ...this.prepared.intent,
                    providerLeaseOwner,
                    providerLeaseExpiresAt: new Date(Date.now() + 60_000),
                    providerAttempts: this.prepared.intent.providerAttempts + 1,
                },
                providerLeaseOwner,
            };
        }
        return this.prepared;
    }

    async markProviderApplied(
        prepared: PreparedTenantCancellationIntent,
        outcome: TenantCancellationOutcome,
        providerMutationOwnedFromAttempt = outcome.action === 'scheduled',
    ): Promise<PreparedTenantCancellationIntent> {
        this.events.push('provider-result-commit');
        if (this.markFailures > 0) {
            this.markFailures -= 1;
            throw new Error('postgresql://private-provider-write-failure');
        }
        const providerMutationOwned = prepared.intent.providerMutationOwned === true
            || providerMutationOwnedFromAttempt
            || outcome.action === 'scheduled';
        if (prepared.intent.state === 'FINALIZED') {
            this.prepared = {
                ...prepared,
                tenant: outcome.action === 'already_canceled'
                    ? {
                        ...prepared.tenant,
                        status: 'CANCELLED',
                        stripeSubscriptionId: null,
                    }
                    : prepared.tenant,
                intent: {
                    ...prepared.intent,
                    providerMutationOwned,
                    providerResult: outcome,
                    providerLeaseOwner: null,
                    providerLeaseExpiresAt: null,
                },
                providerLeaseOwner: null,
            };
            return this.prepared;
        }
        this.prepared = {
            ...prepared,
            intent: {
                ...prepared.intent,
                state: this.legalHoldWins && prepared.intent.kind === 'PLATFORM_ARCHIVE'
                    ? providerMutationOwned
                        ? 'COMPENSATION_PENDING'
                        : 'BLOCKED'
                    : 'PROVIDER_APPLIED',
                providerMutationOwned,
                providerResult: outcome,
                ...(this.legalHoldWins
                    && prepared.intent.kind === 'PLATFORM_ARCHIVE'
                    && !providerMutationOwned
                    ? {
                        terminalReason: 'LEGAL_HOLD',
                        terminalizedAt: new Date(),
                        providerLeaseOwner: null,
                        providerLeaseExpiresAt: null,
                    }
                    : {}),
            },
            ...(this.legalHoldWins
                && prepared.intent.kind === 'PLATFORM_ARCHIVE'
                && !providerMutationOwned
                ? { providerLeaseOwner: null }
                : {}),
        };
        return this.prepared;
    }

    async renewProviderClaim(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent> {
        if (this.prepared?.providerLeaseOwner !== prepared.providerLeaseOwner) {
            throw new Error('claim lost');
        }
        this.prepared = {
            ...this.prepared,
            intent: {
                ...this.prepared.intent,
                providerLeaseExpiresAt: new Date(Date.now() + 60_000),
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
                terminalizedAt: new Date(),
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
        this.events.push('provider-claim-released');
        if (
            this.prepared?.intent.operationId === prepared.intent.operationId
            && this.prepared.providerLeaseOwner === prepared.providerLeaseOwner
        ) {
            this.prepared = {
                ...this.prepared,
                intent: {
                    ...this.prepared.intent,
                    providerLeaseOwner: null,
                    providerLeaseExpiresAt: null,
                },
                providerLeaseOwner: null,
            };
        }
    }

    async finalize(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent> {
        this.events.push('local-audit-finalize');
        if (this.finalizeFailures > 0) {
            this.finalizeFailures -= 1;
            throw new Error('stripe-provider-secret=should-not-escape');
        }
        this.prepared = {
            ...prepared,
            tenant: prepared.intent.kind === 'PLATFORM_ARCHIVE'
                ? { ...prepared.tenant, status: 'CANCELLED', deletedAt: new Date() }
                : prepared.intent.providerResult
                    && (prepared.intent.providerResult as any).action === 'already_canceled'
                    ? {
                        ...prepared.tenant,
                        status: 'CANCELLED',
                        stripeSubscriptionId: null,
                    }
                    : prepared.tenant,
            intent: {
                ...prepared.intent,
                state: 'FINALIZED',
                providerLeaseOwner: null,
                providerLeaseExpiresAt: null,
            },
            providerLeaseOwner: null,
        };
        return this.prepared;
    }
}

describe('TenantCancellationLifecycleService durable provider boundary', () => {
    it('records attributed customer intent before Stripe and replays after provider-result persistence fails', async () => {
        const store = new FailureInjectingStore();
        store.markFailures = 1;
        const stripe = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn()
                .mockImplementationOnce(async () => {
                    store.events.push('stripe-called');
                    return { ...providerResult, providerMutationOwned: true };
                })
                .mockImplementationOnce(async () => {
                    store.events.push('stripe-called');
                    return {
                        ...providerResult,
                        action: 'already_scheduled' as const,
                        providerMutationOwned: true,
                    };
                }),
        };
        const service = new TenantCancellationLifecycleService(
            {} as any,
            () => stripe,
            store,
        );

        const first = service.cancelCustomer(customerActor, {
            confirmation: 'acme-dining',
            reason: 'Customer requested cancellation.',
        });
        await expect(first).rejects.toThrow('pending reconciliation');
        await expect(first).rejects.not.toThrow('private-provider-write-failure');
        expect(store.events.indexOf('intent-committed'))
            .toBeLessThan(store.events.indexOf('stripe-called'));
        expect(store.prepareInputs[0]).toMatchObject({
            kind: 'CUSTOMER_CANCELLATION',
            actor: customerActor,
            reason: 'Customer requested cancellation.',
        });

        const replay = await service.cancelCustomer(customerActor, {
            confirmation: 'acme-dining',
            reason: 'Customer requested cancellation.',
        });
        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenNthCalledWith(
            1,
            'tenant-1',
            'sub_private_123',
            'operation-1',
            { authoritativeCustomerCancellation: true },
        );
        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenNthCalledWith(
            2,
            'tenant-1',
            'sub_private_123',
            'operation-1',
            { authoritativeCustomerCancellation: true },
        );
        expect(replay).toMatchObject({
            id: 'tenant-1',
            status: 'ACTIVE',
            cancellationEffectiveAt: providerResult.currentPeriodEnd,
            billingCancellation: {
                action: 'already_scheduled',
                cancelAtPeriodEnd: true,
            },
        });
        expect(store.prepared?.intent.providerMutationOwned).toBe(true);
        expect(replay.billingCancellation).not.toHaveProperty('stripeSubscriptionId');
        expect(replay.billingCancellation).not.toHaveProperty('stripeStatus');
        await expect(service.cancelCustomer(customerActor, {
            confirmation: 'acme-dining',
            reason: 'Customer requested cancellation.',
        })).resolves.toEqual(replay);
        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
    });

    it('rereads provider state before replayed platform finalization and then remains idempotent', async () => {
        const store = new FailureInjectingStore();
        store.finalizeFailures = 1;
        const stripe = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => {
                store.events.push('stripe-called');
                return providerResult;
            }),
        };
        const service = new TenantCancellationLifecycleService(
            {} as any,
            () => stripe,
            store,
        );

        const first = service.archivePlatform(platformActor, 'tenant-1');
        await expect(first).rejects.toThrow('pending reconciliation');
        await expect(first).rejects.not.toThrow('provider-secret');
        expect(store.prepared?.tenant.status).toBe('ACTIVE');
        expect(store.prepareInputs[0]).toMatchObject({
            kind: 'PLATFORM_ARCHIVE',
            actor: platformActor,
        });

        await expect(service.archivePlatform(platformActor, 'tenant-1')).resolves.toEqual({
            id: 'tenant-1',
            archived: true,
        });
        await expect(service.archivePlatform(platformActor, 'tenant-1')).resolves.toEqual({
            id: 'tenant-1',
            archived: true,
        });
        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
        expect(store.events.indexOf('provider-result-commit'))
            .toBeLessThan(store.events.lastIndexOf('local-audit-finalize'));
    });

    it('keeps operation ownership when already-scheduled replay meets a winning legal hold', async () => {
        const store = new FailureInjectingStore();
        store.finalizeFailures = 1;
        const stripe = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn()
                .mockResolvedValueOnce({ ...providerResult, providerMutationOwned: true })
                .mockImplementationOnce(async () => {
                    store.legalHoldWins = true;
                    return {
                        ...providerResult,
                        action: 'already_scheduled' as const,
                        providerMutationOwned: true,
                    };
                }),
            compensateTenantSubscriptionCancellation: vi.fn(async () => ({
                action: 'unscheduled' as const,
                cancelAtPeriodEnd: false,
            })),
        };
        const service = new TenantCancellationLifecycleService(
            {} as any,
            () => stripe,
            store,
        );

        await expect(service.archivePlatform(platformActor, 'tenant-1'))
            .rejects.toThrow('pending reconciliation');
        expect(store.prepared?.intent).toMatchObject({
            state: 'PROVIDER_APPLIED',
            providerMutationOwned: true,
            providerResult: { action: 'scheduled' },
        });

        await expect(service.archivePlatform(platformActor, 'tenant-1')).resolves.toEqual({
            id: 'tenant-1',
            archived: false,
        });
        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
        expect(stripe.compensateTenantSubscriptionCancellation).toHaveBeenCalledOnce();
        expect(store.prepared?.intent).toMatchObject({
            state: 'BLOCKED',
            providerMutationOwned: true,
            providerResult: { action: 'already_scheduled' },
            terminalReason: 'LEGAL_HOLD',
        });
    });

    it('uses readback-only recovery before compensating an uncertain provider success behind a hold', async () => {
        const store = new FailureInjectingStore();
        store.markFailures = 1;
        const stripe = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn()
                .mockResolvedValueOnce({ ...providerResult, providerMutationOwned: true })
                .mockResolvedValueOnce({
                    ...providerResult,
                    action: 'already_scheduled' as const,
                    providerMutationOwned: true,
                }),
            compensateTenantSubscriptionCancellation: vi.fn(async () => ({
                action: 'unscheduled' as const,
                cancelAtPeriodEnd: false,
            })),
        };
        const service = new TenantCancellationLifecycleService(
            {} as any,
            () => stripe,
            store,
        );

        await expect(service.archivePlatform(platformActor, 'tenant-1'))
            .rejects.toThrow('pending reconciliation');
        store.legalHoldWins = true;
        store.prepared = {
            ...store.prepared!,
            tenant: {
                ...store.prepared!.tenant,
                retentionLegalHoldAt: new Date(),
            },
        };

        await expect(service.archivePlatform(platformActor, 'tenant-1')).resolves.toEqual({
            id: 'tenant-1',
            archived: false,
        });
        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenNthCalledWith(
            2,
            'tenant-1',
            'sub_private_123',
            'operation-1',
            { providerReadbackOnly: true },
        );
        expect(stripe.compensateTenantSubscriptionCancellation).toHaveBeenCalledOnce();
        expect(store.prepared?.intent).toMatchObject({
            state: 'BLOCKED',
            providerMutationOwned: true,
            providerResult: { action: 'already_scheduled' },
            compensationResult: { action: 'unscheduled' },
        });
    });

    it('readbacks a due finalized schedule without entering provider mutation or finalization again', async () => {
        const store = new FailureInjectingStore();
        const prepared = await store.prepare({
            kind: 'CUSTOMER_CANCELLATION',
            tenantId: 'tenant-1',
            actor: customerActor,
        });
        store.prepared = {
            ...prepared,
            intent: {
                ...prepared.intent,
                state: 'FINALIZED',
                providerResult,
            },
        };
        const stripe = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => ({
                ...providerResult,
                action: 'already_canceled' as const,
                cancelAtPeriodEnd: false,
            })),
        };
        const service = new TenantCancellationLifecycleService(
            {} as any,
            () => stripe,
            store,
        );

        const reconciled = await service.reconcilePrepared(store.prepared);

        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledWith(
            'tenant-1',
            'sub_private_123',
            'operation-1',
            { providerReadbackOnly: true },
        );
        expect(reconciled.intent).toMatchObject({
            state: 'FINALIZED',
            operationId: 'operation-1',
            providerResult: { action: 'already_canceled' },
        });
        expect(reconciled.tenant).toMatchObject({
            status: 'CANCELLED',
            stripeSubscriptionId: null,
        });
        expect(store.events).not.toContain('local-audit-finalize');
    });

    it('compensates a platform cancellation when a legal hold wins after provider entry', async () => {
        const store = new FailureInjectingStore();
        store.legalHoldWins = true;
        const stripe = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => providerResult),
            compensateTenantSubscriptionCancellation: vi.fn(async () => ({
                action: 'unscheduled' as const,
                cancelAtPeriodEnd: false,
            })),
        };
        const service = new TenantCancellationLifecycleService(
            {} as any,
            () => stripe,
            store,
        );

        await expect(service.archivePlatform(platformActor, 'tenant-1')).resolves.toEqual({
            id: 'tenant-1',
            archived: false,
        });

        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledWith(
            'tenant-1',
            'sub_private_123',
            'operation-1',
        );
        expect(stripe.compensateTenantSubscriptionCancellation).toHaveBeenCalledWith(
            'tenant-1',
            'sub_private_123',
            'operation-1',
        );
        expect(store.prepared?.intent).toMatchObject({
            state: 'BLOCKED',
            terminalReason: 'LEGAL_HOLD',
            compensationResult: {
                action: 'unscheduled',
                cancelAtPeriodEnd: false,
            },
        });
        expect(store.events).not.toContain('local-audit-finalize');
    });

    it('does not compensate an already-scheduled cancellation owned by the customer', async () => {
        const store = new FailureInjectingStore();
        store.legalHoldWins = true;
        const stripe = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => ({
                ...providerResult,
                action: 'already_scheduled' as const,
            })),
            compensateTenantSubscriptionCancellation: vi.fn(),
        };
        const service = new TenantCancellationLifecycleService(
            {} as any,
            () => stripe,
            store,
        );

        await expect(service.archivePlatform(platformActor, 'tenant-1')).resolves.toEqual({
            id: 'tenant-1',
            archived: false,
        });

        expect(stripe.compensateTenantSubscriptionCancellation).not.toHaveBeenCalled();
        expect(store.prepared?.intent).toMatchObject({
            state: 'BLOCKED',
            providerMutationOwned: false,
            providerResult: { action: 'already_scheduled', cancelAtPeriodEnd: true },
            terminalReason: 'LEGAL_HOLD',
        });
        expect(store.events).not.toContain('local-audit-finalize');
    });

    it('projects authoritative terminal customer cancellation before finalizing exact replay', async () => {
        const store = new FailureInjectingStore();
        const stripe = {
            cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => ({
                ...providerResult,
                action: 'already_canceled' as const,
                cancelAtPeriodEnd: false,
                canceledAt: '2027-01-10T08:00:00.000Z',
            })),
        };
        const service = new TenantCancellationLifecycleService(
            {} as any,
            () => stripe,
            store,
        );

        const result = await service.cancelCustomer(customerActor, {
            confirmation: 'acme-dining',
        });
        expect(result).toMatchObject({
            status: 'CANCELLED',
            billingCancellation: { action: 'already_canceled' },
        });
        expect(store.prepared?.tenant).toMatchObject({
            status: 'CANCELLED',
            stripeSubscriptionId: null,
        });
        await expect(service.cancelCustomer(customerActor, {
            confirmation: 'acme-dining',
        })).resolves.toEqual(result);
        expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();
    });
});

describe('PrismaTenantCancellationIntentStore lifecycle barriers', () => {
    function barrierHarness(overrides: Record<string, unknown>) {
        const tx = {
            $executeRaw: vi.fn().mockResolvedValue(undefined),
            tenant: {
                findUniqueOrThrow: vi.fn().mockResolvedValue({
                    id: 'tenant-1',
                    slug: 'acme-dining',
                    status: 'ACTIVE',
                    deletedAt: null,
                    retentionLegalHoldAt: null,
                    stripeSubscriptionId: 'sub_private_123',
                    ...overrides,
                }),
                update: vi.fn(),
            },
            tenantSetting: {
                findUnique: vi.fn(),
                upsert: vi.fn(),
            },
            auditLog: { create: vi.fn() },
        };
        const tenantDb = {
            withTenant: vi.fn(async (_tenantId: string, operation: (scoped: any) => any) =>
                operation(tx)),
            withPlatformAdmin: vi.fn(async (operation: (scoped: any) => any) =>
                operation(tx)),
        };
        return {
            store: new PrismaTenantCancellationIntentStore(tenantDb as any),
            tx,
        };
    }

    it('does not let customer recovery replace a suspended deletion barrier', async () => {
        const { store, tx } = barrierHarness({ status: 'SUSPENDED' });

        await expect(store.prepare({
            kind: 'CUSTOMER_CANCELLATION',
            tenantId: 'tenant-1',
            actor: customerActor,
            confirmation: 'acme-dining',
        })).rejects.toThrow('deletion billing cleanup is already pending');
        expect(tx.tenantSetting.findUnique).not.toHaveBeenCalled();
        expect(tx.tenantSetting.upsert).not.toHaveBeenCalled();
    });

    it('does not let autonomous platform archive recovery bypass a legal hold', async () => {
        const { store, tx } = barrierHarness({
            retentionLegalHoldAt: new Date('2026-07-16T19:00:00.000Z'),
        });

        await expect(store.prepare({
            kind: 'PLATFORM_ARCHIVE',
            tenantId: 'tenant-1',
            actor: platformActor,
        })).rejects.toThrow('blocked by an active retention legal hold');
        expect(tx.tenantSetting.findUnique).not.toHaveBeenCalled();
        expect(tx.tenantSetting.upsert).not.toHaveBeenCalled();
    });

    it('does not downgrade a customer-finalized terminal winner when stale platform compensation is marked', async () => {
        const { store, tx } = barrierHarness({
            status: 'CANCELLED',
            stripeSubscriptionId: null,
            retentionLegalHoldAt: new Date('2026-07-16T19:00:00.000Z'),
        });
        const leaseExpiresAt = new Date(Date.now() + 60_000);
        const baseIntent = {
            tenantId: 'tenant-1',
            actorUserId: 'platform-admin-1',
            actorTenantId: 'platform-tenant',
            ipAddress: null,
            userAgent: null,
            reason: null,
            providerSubscriptionId: 'sub_private_123',
            subscriptionFingerprint: 'fingerprint',
            providerAttempts: 1,
            compensationResult: null,
            terminalReason: null,
            terminalizedAt: null,
        };
        const platformIntent = {
            ...baseIntent,
            kind: 'PLATFORM_ARCHIVE' as const,
            operationId: 'platform-operation-a',
            state: 'COMPENSATION_PENDING' as const,
            providerLeaseOwner: 'platform-owner',
            providerLeaseExpiresAt: leaseExpiresAt,
            providerMutationOwned: true,
            providerResult,
        };
        const customerIntent = {
            ...baseIntent,
            kind: 'CUSTOMER_CANCELLATION' as const,
            operationId: 'customer-operation-b',
            state: 'FINALIZED' as const,
            actorUserId: 'user-1',
            actorTenantId: 'tenant-1',
            providerLeaseOwner: null,
            providerLeaseExpiresAt: null,
            providerMutationOwned: true,
            providerResult: {
                ...providerResult,
                action: 'already_canceled',
                cancelAtPeriodEnd: false,
            },
        };
        tx.tenantSetting.findUnique.mockImplementation(async ({ where }: any) => ({
            value: where.tenantId_key.key.endsWith('platform_archive')
                ? {
                    ...platformIntent,
                    providerLeaseExpiresAt: leaseExpiresAt.toISOString(),
                }
                : customerIntent,
        }));
        tx.tenantSetting.upsert.mockResolvedValue({});

        const result = await store.markCompensated({
            tenant: {
                id: 'tenant-1',
                slug: 'acme-dining',
                status: 'CANCELLED',
                deletedAt: null,
                retentionLegalHoldAt: new Date('2026-07-16T19:00:00.000Z'),
                stripeSubscriptionId: null,
            },
            intent: platformIntent,
            providerLeaseOwner: 'platform-owner',
        } as PreparedTenantCancellationIntent, {
            action: 'already_terminal',
            cancelAtPeriodEnd: false,
        });

        expect(tx.tenant.update).not.toHaveBeenCalled();
        expect(result.tenant).toMatchObject({
            status: 'CANCELLED',
            stripeSubscriptionId: null,
        });
        expect(result.intent).toMatchObject({
            state: 'BLOCKED',
            compensationResult: {
                action: 'not_owned',
                cancelAtPeriodEnd: false,
            },
        });
        expect(tx.auditLog.create).toHaveBeenCalledOnce();
    });
});

const postgresRestrictedUrl = process.env.DATABASE_URL;
const postgresOwnerUrl = process.env.MIGRATION_DATABASE_URL;
const postgresCapability = process.env.TENANT_DATA_GOVERNANCE_TEST_CAPABILITY
    ?? process.env.PLATFORM_ADMIN_DB_CONTEXT_SECRET;
const testTenantCancellationPrefixes = [
    'tenant-cancellation-intent-',
    'tenant-cancellation-recovery-',
] as const;
const testLifecycleIntentSettingKeys = [
    'internal:tenant-lifecycle-intent:customer_cancellation',
    'internal:tenant-lifecycle-intent:platform_archive',
] as const;

async function deleteStaleTenantCancellationIntentSettings(
    owner: PrismaClient,
): Promise<void> {
    await owner.$executeRaw`
        DELETE FROM "TenantSetting"
        WHERE (
            starts_with("tenantId", ${testTenantCancellationPrefixes[0]})
            OR starts_with("tenantId", ${testTenantCancellationPrefixes[1]})
        )
          AND "key" IN (
              ${testLifecycleIntentSettingKeys[0]},
              ${testLifecycleIntentSettingKeys[1]}
          )
    `;
}

async function deleteTenantCancellationIntentSettings(
    owner: PrismaClient,
    tenantId: string,
): Promise<void> {
    await owner.$executeRaw`
        DELETE FROM "TenantSetting"
        WHERE "tenantId" = ${tenantId}
          AND "key" IN (
              ${testLifecycleIntentSettingKeys[0]},
              ${testLifecycleIntentSettingKeys[1]}
          )
    `;
}

async function createCancellationProofTenant(
    owner: PrismaClient,
    tenantId: string,
    slug: string,
    subscriptionId: string,
    customerId: string | null = null,
): Promise<void> {
    await owner.$executeRaw`
        INSERT INTO "Tenant"
            ("id", "name", "slug", "stripeCustomerId", "stripeSubscriptionId", "planTier", "status", "usageCredits", "createdAt", "updatedAt")
        VALUES
            (${tenantId}, 'Cancellation Reconciliation Proof', ${slug}, ${customerId}, ${subscriptionId},
             'STARTER'::"PlanTier", 'ACTIVE'::"TenantStatus", 100, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
}

async function createCancellationProofUserSession(
    owner: PrismaClient,
    tenantId: string,
    userId: string,
    sessionId: string,
    suffix: string,
): Promise<void> {
    await owner.$executeRaw`
        INSERT INTO "User"
            ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
        VALUES
            (${userId}, ${tenantId}, 'Cancellation Proof Owner', ${`cancellation-proof-${suffix}`},
             'ADMIN'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;
    await owner.$executeRaw`
        INSERT INTO "Session"
            ("id", "userId", "selectorHash", "refreshToken", "ipAddress", "userAgent", "expiresAt", "createdAt")
        VALUES
            (${sessionId}, ${userId}, ${`selector-${suffix}`}, ${`refresh-${suffix}`},
             '203.0.113.41', 'cancellation-proof', CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP)
    `;
}

async function cleanupCancellationProofTenants(
    owner: PrismaClient,
    tenantIds: readonly string[],
    capability: string,
): Promise<void> {
    for (const tenantId of tenantIds) {
        await owner.$executeRaw`DELETE FROM "BillingEvent" WHERE "tenantId" = ${tenantId}`
            .catch(() => undefined);
        await deleteTenantCancellationIntentSettings(owner, tenantId).catch(() => undefined);
        await owner.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_current_platform_admin(true, ${capability})`;
            await tx.$executeRaw`
                UPDATE "Tenant"
                SET "status" = 'PURGED'::"TenantStatus",
                    "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
                    "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
                    "retentionLegalHoldAt" = NULL,
                    "retentionLegalHoldReason" = NULL,
                    "retentionLegalHoldByUserId" = NULL,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = ${tenantId}
            `;
            await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
        }).catch(() => undefined);
        await owner.$executeRaw`
            DELETE FROM "Session"
            WHERE "userId" IN (
                SELECT "id" FROM "User" WHERE "tenantId" = ${tenantId}
            )
        `.catch(() => undefined);
        await owner.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${tenantId}`
            .catch(() => undefined);
        await owner.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`
            .catch(() => undefined);
    }
}

async function bounded<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error('Timed out waiting for cancellation race barrier.')),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

if (postgresRestrictedUrl && postgresOwnerUrl && postgresCapability) {
    describe('TenantCancellationLifecycleService restricted-role Postgres intent', () => {
        it('persists attributed pre-provider intent and replays both customer and platform outcomes', async () => {
            const restricted = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-intent-${suffix}`;
            const userId = `user-cancellation-intent-${suffix}`;
            const subscriptionId = `sub-cancellation-intent-${suffix}`;
            const reassertedProviderResult = {
                ...providerResult,
                currentPeriodEnd: '2027-02-15T08:00:00.000Z',
            };
            const stripe = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn()
                    .mockResolvedValueOnce({ ...providerResult, stripeSubscriptionId: subscriptionId })
                    .mockResolvedValueOnce({ ...reassertedProviderResult, stripeSubscriptionId: subscriptionId })
                    .mockResolvedValue({ ...providerResult, stripeSubscriptionId: subscriptionId }),
            };
            const durableStore = new PrismaTenantCancellationIntentStore(
                new TenantPrismaService(restricted),
            );
            const finalizeFailures = new Map([
                ['CUSTOMER_CANCELLATION', 1],
                ['PLATFORM_ARCHIVE', 1],
            ]);
            const failureInjectingStore: TenantCancellationIntentStore = {
                prepare: (input) => durableStore.prepare(input),
                markProviderApplied: (prepared, outcome) =>
                    durableStore.markProviderApplied(prepared, outcome),
                renewProviderClaim: (prepared) =>
                    durableStore.renewProviderClaim(prepared),
                providerLeaseRenewalIntervalMs: () =>
                    durableStore.providerLeaseRenewalIntervalMs(),
                markCompensated: (prepared, outcome) =>
                    durableStore.markCompensated(prepared, outcome),
                releaseProviderClaim: (prepared) =>
                    durableStore.releaseProviderClaim(prepared),
                finalize: async (prepared) => {
                    const remaining = finalizeFailures.get(prepared.intent.kind) ?? 0;
                    if (remaining > 0) {
                        finalizeFailures.set(prepared.intent.kind, remaining - 1);
                        throw new Error('injected finalization failure');
                    }
                    return durableStore.finalize(prepared);
                },
            };
            const service = new TenantCancellationLifecycleService(
                new TenantPrismaService(restricted),
                () => stripe,
                failureInjectingStore,
            );
            const customer = { ...customerActor, tenantId, userId };
            const platform = { ...platformActor };

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await owner.$executeRaw`
                    INSERT INTO "Tenant"
                        ("id", "name", "slug", "stripeSubscriptionId", "status", "usageCredits", "createdAt", "updatedAt")
                    VALUES
                        (${tenantId}, 'Cancellation Intent Proof', ${`intent-${suffix}`}, ${subscriptionId},
                         'ACTIVE'::"TenantStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await owner.$executeRaw`
                    INSERT INTO "User"
                        ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
                    VALUES
                        (${userId}, ${tenantId}, 'Intent Administrator', ${`intent-admin-${suffix}`},
                         'ADMIN'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;

                await expect(service.cancelCustomer(customer, {
                    confirmation: `intent-${suffix}`,
                    reason: 'Customer requested durable cancellation proof.',
                })).rejects.toThrow('Tenant billing lifecycle is pending reconciliation.');
                await expect(service.cancelCustomer(customer, {
                    confirmation: `intent-${suffix}`,
                    reason: 'Customer requested durable cancellation proof.',
                })).resolves.toMatchObject({
                    id: tenantId,
                    status: 'ACTIVE',
                    billingCancellation: { action: 'scheduled' },
                });
                await expect(service.cancelCustomer(customer, {
                    confirmation: `intent-${suffix}`,
                    reason: 'Customer requested durable cancellation proof.',
                })).resolves.toMatchObject({
                    id: tenantId,
                    status: 'ACTIVE',
                    cancellationEffectiveAt: reassertedProviderResult.currentPeriodEnd,
                    billingCancellation: {
                        action: 'scheduled',
                        cancelAtPeriodEnd: true,
                    },
                });
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenNthCalledWith(
                    2,
                    tenantId,
                    subscriptionId,
                    expect.any(String),
                );

                await expect(service.archivePlatform(platform, tenantId)).rejects.toThrow(
                    'Tenant billing lifecycle is pending reconciliation.',
                );
                await expect(service.archivePlatform(platform, tenantId)).resolves.toEqual({
                    id: tenantId,
                    archived: true,
                });
                await expect(service.archivePlatform(platform, tenantId)).resolves.toEqual({
                    id: tenantId,
                    archived: true,
                });
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(4);
                await expect(owner.$queryRaw`
                    SELECT "value"->>'kind' AS "kind",
                           "value"->>'state' AS "state",
                           "value"->>'actorUserId' AS "actorUserId",
                           "value"->>'actorTenantId' AS "actorTenantId",
                           "value"->>'providerLeaseOwner' AS "providerLeaseOwner",
                           "value"->'providerResult'->>'currentPeriodEnd' AS "currentPeriodEnd",
                           ("value"->'providerResult') ? 'stripeSubscriptionId' AS "leaksProviderId"
                    FROM "TenantSetting"
                    WHERE "tenantId" = ${tenantId}
                      AND "key" LIKE 'internal:tenant-lifecycle-intent:%'
                    ORDER BY "value"->>'kind'
                `).resolves.toEqual([
                    expect.objectContaining({
                        kind: 'CUSTOMER_CANCELLATION',
                        state: 'FINALIZED',
                        actorUserId: userId,
                        actorTenantId: tenantId,
                        providerLeaseOwner: null,
                        currentPeriodEnd: reassertedProviderResult.currentPeriodEnd,
                        leaksProviderId: false,
                    }),
                    expect.objectContaining({
                        kind: 'PLATFORM_ARCHIVE',
                        state: 'FINALIZED',
                        actorUserId: platform.userId,
                        actorTenantId: platform.tenantId,
                        providerLeaseOwner: null,
                        leaksProviderId: false,
                    }),
                ]);
            } finally {
                try {
                    await deleteTenantCancellationIntentSettings(owner, tenantId);
                    await owner.$transaction(async (tx) => {
                        await tx.$executeRaw`SELECT set_current_platform_admin(true, ${postgresCapability})`;
                        await tx.$executeRaw`
                            UPDATE "Tenant"
                            SET "status" = 'PURGED'::"TenantStatus",
                                "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
                                "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
                                "retentionLegalHoldAt" = NULL,
                                "retentionLegalHoldReason" = NULL,
                                "retentionLegalHoldByUserId" = NULL,
                                "updatedAt" = CURRENT_TIMESTAMP
                            WHERE "id" = ${tenantId}
                        `;
                        await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
                    }).catch(() => undefined);
                    await owner.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${tenantId}`.catch(() => undefined);
                    await owner.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`.catch(() => undefined);
                } finally {
                    await restricted.$disconnect();
                    await owner.$disconnect();
                }
            }
        }, 20_000);

        it('claims one expired lease across restricted-role replicas and preserves lifecycle barriers', async () => {
            const restrictedA = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const restrictedB = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-${suffix}`;
            const userId = `user-cancellation-recovery-${suffix}`;
            const subscriptionId = `sub-cancellation-recovery-${suffix}`;
            let nowMs = Date.parse('2026-07-16T20:00:00.000Z');
            const clock = () => new Date(nowMs);
            const tenantDbA = new TenantPrismaService(restrictedA);
            const storeA = new PrismaTenantCancellationIntentStore(
                tenantDbA,
                60_000,
                clock,
            );
            const storeB = new PrismaTenantCancellationIntentStore(
                new TenantPrismaService(restrictedB),
                60_000,
                clock,
            );
            const stripe = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async (
                    _tenantId: string,
                    _subscriptionId: string,
                    _operationId: string,
                    options?: { providerReadbackOnly?: boolean },
                ) => options?.providerReadbackOnly
                    ? {
                        ...providerResult,
                        action: 'none' as const,
                        stripeSubscriptionId: subscriptionId,
                        cancelAtPeriodEnd: false,
                        providerMutationOwned: false,
                    }
                    : {
                        ...providerResult,
                        stripeSubscriptionId: subscriptionId,
                    }),
                compensateTenantSubscriptionCancellation: vi.fn(),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDbA,
                () => stripe,
                storeA,
            );
            const actor = { ...customerActor, tenantId, userId };

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await owner.$executeRaw`
                    INSERT INTO "Tenant"
                        ("id", "name", "slug", "stripeSubscriptionId", "status", "usageCredits", "createdAt", "updatedAt")
                    VALUES
                        (${tenantId}, 'Cancellation Recovery Proof', ${`recovery-${suffix}`}, ${subscriptionId},
                         'ACTIVE'::"TenantStatus", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await owner.$executeRaw`
                    INSERT INTO "User"
                        ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
                    VALUES
                        (${userId}, ${tenantId}, 'Recovery Administrator', ${`recovery-admin-${suffix}`},
                         'ADMIN'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;

                const crashed = await storeA.prepare({
                    kind: 'CUSTOMER_CANCELLATION',
                    tenantId,
                    actor,
                    confirmation: `recovery-${suffix}`,
                    reason: 'Crash recovery proof.',
                });
                expect(crashed.providerLeaseOwner).toBeTruthy();
                const beforeExpiry = await Promise.all([
                    storeA.claimRecoverable(10),
                    storeB.claimRecoverable(10),
                ]);
                expect(beforeExpiry.flat()).toHaveLength(0);

                nowMs += 60_001;
                const recovered = await Promise.all([
                    storeA.claimRecoverable(10),
                    storeB.claimRecoverable(10),
                ]);
                const claimed = recovered.flat();
                expect(claimed).toHaveLength(1);
                await lifecycle.reconcilePrepared(claimed[0]);
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();
                expect((await Promise.all([
                    storeA.claimRecoverable(10),
                    storeB.claimRecoverable(10),
                ])).flat()).toHaveLength(0);
                await expect(owner.$queryRaw<Array<{
                    action: string;
                    actorUserId: string | null;
                    actorTenantId: string | null;
                }>>`
                    SELECT "action", "actorUserId", "actorTenantId"
                    FROM "AuditLog"
                    WHERE "tenantId" = ${tenantId}
                      AND "action" = 'TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER'
                `).resolves.toEqual([{
                    action: 'TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER',
                    actorUserId: userId,
                    actorTenantId: tenantId,
                }]);

                const archive = await storeA.prepare({
                    kind: 'PLATFORM_ARCHIVE',
                    tenantId,
                    actor: platformActor,
                });
                expect(archive.providerLeaseOwner).toBeTruthy();
                await owner.$transaction(async (tx) => {
                    await tx.$executeRaw`
                        SELECT set_current_platform_admin(true, ${postgresCapability})
                    `;
                    await tx.$executeRaw`
                        UPDATE "Tenant"
                        SET "retentionLegalHoldAt" = CURRENT_TIMESTAMP,
                            "retentionLegalHoldReason" = 'Recovery test hold',
                            "retentionLegalHoldByUserId" = ${platformActor.userId},
                            "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "id" = ${tenantId}
                    `;
                });
                nowMs += 60_001;
                const heldRecovery = await storeA.claimRecoverable(10);
                expect(heldRecovery).toHaveLength(1);
                await lifecycle.reconcilePrepared(heldRecovery[0]);
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenNthCalledWith(
                    2,
                    tenantId,
                    subscriptionId,
                    archive.intent.operationId,
                    { providerReadbackOnly: true },
                );
                expect(stripe.compensateTenantSubscriptionCancellation).not.toHaveBeenCalled();
                await expect(owner.$queryRaw<Array<{
                    state: string;
                    attempts: string;
                    providerMutationOwned: string | null;
                    providerResult: unknown;
                }>>`
                    SELECT "value"->>'state' AS "state",
                           "value"->>'providerAttempts' AS "attempts",
                           "value"->>'providerMutationOwned' AS "providerMutationOwned",
                           "value"->'providerResult' AS "providerResult"
                    FROM "TenantSetting"
                    WHERE "tenantId" = ${tenantId}
                      AND "key" = ${testLifecycleIntentSettingKeys[1]}
                `).resolves.toEqual([{
                    state: 'BLOCKED',
                    attempts: '2',
                    providerMutationOwned: 'false',
                    providerResult: expect.objectContaining({ action: 'none' }),
                }]);
                await owner.$transaction(async (tx) => {
                    await tx.$executeRaw`
                        SELECT set_current_platform_admin(true, ${postgresCapability})
                    `;
                    await tx.$executeRaw`
                        UPDATE "Tenant"
                        SET "retentionLegalHoldAt" = NULL,
                            "retentionLegalHoldReason" = NULL,
                            "retentionLegalHoldByUserId" = NULL,
                            "status" = 'SUSPENDED'::"TenantStatus",
                            "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "id" = ${tenantId}
                    `;
                });
                expect(await storeB.claimRecoverable(10)).toHaveLength(0);
                expect(await storeA.countBacklog()).toBe(0);
            } finally {
                try {
                    await deleteTenantCancellationIntentSettings(owner, tenantId);
                    await owner.$transaction(async (tx) => {
                        await tx.$executeRaw`SELECT set_current_platform_admin(true, ${postgresCapability})`;
                        await tx.$executeRaw`
                            UPDATE "Tenant"
                            SET "status" = 'PURGED'::"TenantStatus",
                                "deletedAt" = CURRENT_TIMESTAMP - INTERVAL '8 years',
                                "applicationDataPurgedAt" = CURRENT_TIMESTAMP,
                                "retentionLegalHoldAt" = NULL,
                                "retentionLegalHoldReason" = NULL,
                                "retentionLegalHoldByUserId" = NULL,
                                "updatedAt" = CURRENT_TIMESTAMP
                            WHERE "id" = ${tenantId}
                        `;
                        await tx.$queryRaw`SELECT public.purge_expired_audit_logs(${tenantId})`;
                    }).catch(() => undefined);
                    await owner.$executeRaw`DELETE FROM "User" WHERE "tenantId" = ${tenantId}`.catch(() => undefined);
                    await owner.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`.catch(() => undefined);
                } finally {
                    await restrictedA.$disconnect();
                    await restrictedB.$disconnect();
                    await owner.$disconnect();
                }
            }
        }, 30_000);

        it('terminalizes twenty older barriers before LIMIT so a newer recoverable intent runs', async () => {
            const restricted = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantIds = Array.from(
                { length: 21 },
                (_value, index) => `tenant-cancellation-recovery-starvation-${index}-${suffix}`,
            );
            const tenantDb = new TenantPrismaService(restricted);
            const store = new PrismaTenantCancellationIntentStore(tenantDb, 5_000);
            const stripe = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => providerResult),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDb,
                () => stripe,
                store,
            );

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                for (const [index, tenantId] of tenantIds.entries()) {
                    await createCancellationProofTenant(
                        owner,
                        tenantId,
                        `cancellation-starvation-${index}-${suffix}`,
                        `sub-cancellation-starvation-${index}-${suffix}`,
                    );
                    const prepared = await store.prepare({
                        kind: 'PLATFORM_ARCHIVE',
                        tenantId,
                        actor: platformActor,
                    });
                    await store.releaseProviderClaim(prepared);
                    if (index < 20) {
                        await owner.$executeRaw`
                            UPDATE "Tenant"
                            SET "status" = 'SUSPENDED'::"TenantStatus",
                                "updatedAt" = CURRENT_TIMESTAMP
                            WHERE "id" = ${tenantId}
                        `;
                        await owner.$executeRaw`
                            UPDATE "TenantSetting"
                            SET "updatedAt" = CURRENT_TIMESTAMP - INTERVAL '1 day'
                            WHERE "tenantId" = ${tenantId}
                              AND "key" = ${testLifecycleIntentSettingKeys[1]}
                        `;
                    }
                }

                const [claimed] = await store.claimRecoverable(1);
                expect(claimed?.tenant.id).toBe(tenantIds[20]);
                expect(await store.countBacklog()).toBe(1);
                await lifecycle.reconcilePrepared(claimed);
                expect(await store.countBacklog()).toBe(0);
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();

                const terminalized = await owner.$queryRaw<Array<{
                    state: string;
                    count: number;
                }>>`
                    SELECT "value"->>'state' AS "state", COUNT(*)::integer AS "count"
                    FROM "TenantSetting"
                    WHERE "tenantId" LIKE ${`tenant-cancellation-recovery-starvation-%-${suffix}`}
                      AND "key" = ${testLifecycleIntentSettingKeys[1]}
                      AND "tenantId" <> ${tenantIds[20]}
                    GROUP BY "value"->>'state'
                `;
                expect(terminalized).toEqual([{ state: 'BLOCKED', count: 20 }]);
            } finally {
                await cleanupCancellationProofTenants(owner, tenantIds, postgresCapability);
                await restricted.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('renews just-in-time claims so two replicas never enter the same slow provider mutation', async () => {
            const restrictedA = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const restrictedB = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantIds = Array.from(
                { length: 3 },
                (_value, index) => `tenant-cancellation-recovery-lease-${index}-${suffix}`,
            );
            const storeA = new PrismaTenantCancellationIntentStore(
                new TenantPrismaService(restrictedA),
                120,
            );
            const storeB = new PrismaTenantCancellationIntentStore(
                new TenantPrismaService(restrictedB),
                120,
            );
            let firstEnteredResolve!: () => void;
            const firstEntered = new Promise<void>((resolve) => {
                firstEnteredResolve = resolve;
            });
            let releaseFirstResolve!: () => void;
            const releaseFirst = new Promise<void>((resolve) => {
                releaseFirstResolve = resolve;
            });
            const activeOperations = new Set<string>();
            const duplicateEntries = new Set<string>();
            let providerCalls = 0;
            const provider = vi.fn(async (
                _tenantId: string,
                _subscriptionId: string | null | undefined,
                operationId: string,
            ) => {
                if (activeOperations.has(operationId)) duplicateEntries.add(operationId);
                activeOperations.add(operationId);
                providerCalls += 1;
                if (providerCalls === 1) {
                    firstEnteredResolve();
                    await releaseFirst;
                }
                activeOperations.delete(operationId);
                return providerResult;
            });
            const lifecycleA = new TenantCancellationLifecycleService(
                new TenantPrismaService(restrictedA),
                () => ({ cancelTenantSubscriptionAtPeriodEnd: provider }),
                storeA,
            );
            const lifecycleB = new TenantCancellationLifecycleService(
                new TenantPrismaService(restrictedB),
                () => ({ cancelTenantSubscriptionAtPeriodEnd: provider }),
                storeB,
            );
            const processorA = new TenantCancellationReconcilerProcessor({
                claimRecoverable: (limit, excluded) => storeA.claimRecoverable(limit, excluded),
                reconcilePrepared: (prepared) => lifecycleA.reconcilePrepared(prepared),
                countBacklog: () => storeA.countBacklog(),
            }, { batchSize: 3 });
            const processorB = new TenantCancellationReconcilerProcessor({
                claimRecoverable: (limit, excluded) => storeB.claimRecoverable(limit, excluded),
                reconcilePrepared: (prepared) => lifecycleB.reconcilePrepared(prepared),
                countBacklog: () => storeB.countBacklog(),
            }, { batchSize: 3 });

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                for (const [index, tenantId] of tenantIds.entries()) {
                    await createCancellationProofTenant(
                        owner,
                        tenantId,
                        `cancellation-lease-${index}-${suffix}`,
                        `sub-cancellation-lease-${index}-${suffix}`,
                    );
                    const prepared = await storeA.prepare({
                        kind: 'PLATFORM_ARCHIVE',
                        tenantId,
                        actor: platformActor,
                    });
                    await storeA.releaseProviderClaim(prepared);
                }

                const firstSweep = processorA.sweepNow();
                await bounded(firstEntered);
                await new Promise((resolve) => setTimeout(resolve, 260));
                const secondSweep = processorB.sweepNow();
                await bounded(secondSweep);
                releaseFirstResolve();
                await bounded(firstSweep);

                expect(duplicateEntries).toEqual(new Set());
                expect(provider).toHaveBeenCalledTimes(3);
                expect(new Set(provider.mock.calls.map((call) => call[2])).size).toBe(3);
                expect(await storeA.countBacklog()).toBe(0);
            } finally {
                releaseFirstResolve?.();
                await cleanupCancellationProofTenants(owner, tenantIds, postgresCapability);
                await restrictedA.$disconnect();
                await restrictedB.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('gives a committed legal hold the safe winner and compensates outside the transaction', async () => {
            const restrictedArchive = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const restrictedHold = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-hold-${suffix}`;
            const subscriptionId = `sub-cancellation-hold-${suffix}`;
            const tenantDb = new TenantPrismaService(restrictedArchive);
            const store = new PrismaTenantCancellationIntentStore(tenantDb, 500);
            let providerEnteredResolve!: () => void;
            const providerEntered = new Promise<void>((resolve) => {
                providerEnteredResolve = resolve;
            });
            let releaseProviderResolve!: () => void;
            const releaseProvider = new Promise<void>((resolve) => {
                releaseProviderResolve = resolve;
            });
            const stripe = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => {
                    providerEnteredResolve();
                    await releaseProvider;
                    return { ...providerResult, stripeSubscriptionId: subscriptionId };
                }),
                compensateTenantSubscriptionCancellation: vi.fn(async () => ({
                    action: 'unscheduled' as const,
                    cancelAtPeriodEnd: false,
                })),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDb,
                () => stripe,
                store,
            );
            const holdOwner = new TenantAccountLifecycleService(
                new TenantPrismaService(restrictedHold),
                {
                    cancelTenantSubscriptionAtPeriodEnd: stripe.cancelTenantSubscriptionAtPeriodEnd,
                    finalizeTenantBillingForPurge: vi.fn(),
                } as any,
            );

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await createCancellationProofTenant(
                    owner,
                    tenantId,
                    `cancellation-hold-${suffix}`,
                    subscriptionId,
                );

                const archive = lifecycle.archivePlatform(platformActor, tenantId);
                await bounded(providerEntered);
                await holdOwner.placeRetentionLegalHold(
                    tenantId,
                    platformActor,
                    { reason: 'Two-connection cancellation race proof.' },
                );
                releaseProviderResolve();

                await expect(bounded(archive)).resolves.toEqual({
                    id: tenantId,
                    archived: false,
                });
                expect(stripe.compensateTenantSubscriptionCancellation).toHaveBeenCalledOnce();
                const [state] = await owner.$queryRaw<Array<{
                    status: string;
                    deletedAt: Date | null;
                    holdAt: Date | null;
                    intentState: string;
                    terminalReason: string;
                    blockedAuditCount: number;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."deletedAt" AS "deletedAt",
                           tenant."retentionLegalHoldAt" AS "holdAt",
                           setting."value"->>'state' AS "intentState",
                           setting."value"->>'terminalReason' AS "terminalReason",
                           COUNT(audit."id")::integer AS "blockedAuditCount"
                    FROM "Tenant" tenant
                    JOIN "TenantSetting" setting
                      ON setting."tenantId" = tenant."id"
                     AND setting."key" = ${testLifecycleIntentSettingKeys[1]}
                    LEFT JOIN "AuditLog" audit
                      ON audit."tenantId" = tenant."id"
                     AND audit."action" = 'TENANT_ARCHIVE_BLOCKED_BY_LEGAL_HOLD'
                    WHERE tenant."id" = ${tenantId}
                    GROUP BY tenant."status", tenant."deletedAt", tenant."retentionLegalHoldAt", setting."value"
                `;
                expect(state).toMatchObject({
                    status: 'ACTIVE',
                    deletedAt: null,
                    intentState: 'BLOCKED',
                    terminalReason: 'LEGAL_HOLD',
                    blockedAuditCount: 1,
                });
                expect(state.holdAt).toBeInstanceOf(Date);
            } finally {
                releaseProviderResolve?.();
                await cleanupCancellationProofTenants(owner, [tenantId], postgresCapability);
                await restrictedArchive.$disconnect();
                await restrictedHold.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('readbacks uncertain provider success after a hold and reverses it exactly once', async () => {
            const restrictedRecovery = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const restrictedHold = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-hold-readback-${suffix}`;
            const userId = `user-cancellation-recovery-hold-readback-${suffix}`;
            const sessionId = `session-cancellation-recovery-hold-readback-${suffix}`;
            const subscriptionId = `sub-cancellation-hold-readback-${suffix}`;
            const tenantDb = new TenantPrismaService(restrictedRecovery);
            const durableStore = new PrismaTenantCancellationIntentStore(tenantDb, 250);
            let markFailures = 1;
            const failureStore: TenantCancellationIntentStore = {
                prepare: (input) => durableStore.prepare(input),
                markProviderApplied: async (prepared, outcome, providerMutationOwned) => {
                    if (markFailures > 0) {
                        markFailures -= 1;
                        throw new Error('injected provider-result persistence failure');
                    }
                    return durableStore.markProviderApplied(
                        prepared,
                        outcome,
                        providerMutationOwned,
                    );
                },
                renewProviderClaim: (prepared) => durableStore.renewProviderClaim(prepared),
                providerLeaseRenewalIntervalMs: () =>
                    durableStore.providerLeaseRenewalIntervalMs(),
                markCompensated: (prepared, outcome) =>
                    durableStore.markCompensated(prepared, outcome),
                releaseProviderClaim: (prepared) => durableStore.releaseProviderClaim(prepared),
                finalize: (prepared) => durableStore.finalize(prepared),
            };
            let remoteScheduled = false;
            let remoteOperationId: string | null = null;
            let providerMutations = 0;
            const stripe = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async (
                    _tenantId: string,
                    _subscriptionId: string,
                    operationId: string,
                    options?: { providerReadbackOnly?: boolean },
                ) => {
                    if (!remoteScheduled && !options?.providerReadbackOnly) {
                        remoteScheduled = true;
                        remoteOperationId = operationId;
                        providerMutations += 1;
                        return {
                            ...providerResult,
                            stripeSubscriptionId: subscriptionId,
                            providerMutationOwned: true,
                        };
                    }
                    expect(options).toEqual({ providerReadbackOnly: true });
                    return {
                        ...providerResult,
                        action: remoteScheduled ? 'already_scheduled' as const : 'none' as const,
                        stripeSubscriptionId: subscriptionId,
                        cancelAtPeriodEnd: remoteScheduled,
                        providerMutationOwned: remoteOperationId === operationId,
                    };
                }),
                compensateTenantSubscriptionCancellation: vi.fn(async (
                    _tenantId: string,
                    _subscriptionId: string,
                    operationId: string,
                ) => {
                    expect(operationId).toBe(remoteOperationId);
                    expect(remoteScheduled).toBe(true);
                    remoteScheduled = false;
                    return {
                        action: 'unscheduled' as const,
                        cancelAtPeriodEnd: false,
                    };
                }),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDb,
                () => stripe,
                failureStore,
            );
            const holdOwner = new TenantAccountLifecycleService(
                new TenantPrismaService(restrictedHold),
                {
                    cancelTenantSubscriptionAtPeriodEnd: stripe.cancelTenantSubscriptionAtPeriodEnd,
                    finalizeTenantBillingForPurge: vi.fn(),
                } as any,
            );

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await createCancellationProofTenant(
                    owner,
                    tenantId,
                    `cancellation-hold-readback-${suffix}`,
                    subscriptionId,
                );
                await createCancellationProofUserSession(
                    owner,
                    tenantId,
                    userId,
                    sessionId,
                    suffix,
                );

                await expect(lifecycle.archivePlatform(platformActor, tenantId))
                    .rejects.toThrow('pending reconciliation');
                expect(remoteScheduled).toBe(true);
                expect(providerMutations).toBe(1);
                await holdOwner.placeRetentionLegalHold(
                    tenantId,
                    platformActor,
                    { reason: 'Post-provider uncertainty readback proof.' },
                );

                await new Promise((resolve) => setTimeout(resolve, 350));
                const [recovered] = await durableStore.claimRecoverable(1);
                expect(recovered).toBeDefined();
                expect(recovered.intent).toMatchObject({
                    state: 'PENDING_PROVIDER',
                    providerMutationOwned: null,
                    providerResult: null,
                });
                expect(recovered.tenant.retentionLegalHoldAt).toBeInstanceOf(Date);
                await lifecycle.reconcilePrepared(recovered);

                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenNthCalledWith(
                    2,
                    tenantId,
                    subscriptionId,
                    remoteOperationId,
                    { providerReadbackOnly: true },
                );
                expect(providerMutations).toBe(1);
                expect(stripe.compensateTenantSubscriptionCancellation).toHaveBeenCalledOnce();
                expect(remoteScheduled).toBe(false);

                await expect(owner.$queryRaw<Array<{
                    status: string;
                    subscriptionId: string | null;
                    credits: number;
                    sessionRevokedAt: Date | null;
                    intentState: string;
                    providerMutationOwned: string;
                    providerAction: string;
                    compensationAction: string;
                    blockedAuditCount: number;
                    archivedAuditCount: number;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."stripeSubscriptionId" AS "subscriptionId",
                           tenant."usageCredits" AS "credits",
                           session."revokedAt" AS "sessionRevokedAt",
                           setting."value"->>'state' AS "intentState",
                           setting."value"->>'providerMutationOwned' AS "providerMutationOwned",
                           setting."value"->'providerResult'->>'action' AS "providerAction",
                           setting."value"->'compensationResult'->>'action' AS "compensationAction",
                           (SELECT COUNT(*)::integer FROM "AuditLog" audit
                             WHERE audit."tenantId" = tenant."id"
                               AND audit."action" = 'TENANT_ARCHIVE_BLOCKED_BY_LEGAL_HOLD') AS "blockedAuditCount",
                           (SELECT COUNT(*)::integer FROM "AuditLog" audit
                             WHERE audit."tenantId" = tenant."id"
                               AND audit."action" = 'TENANT_ARCHIVED') AS "archivedAuditCount"
                    FROM "Tenant" tenant
                    JOIN "TenantSetting" setting
                      ON setting."tenantId" = tenant."id"
                     AND setting."key" = ${testLifecycleIntentSettingKeys[1]}
                    JOIN "Session" session ON session."id" = ${sessionId}
                    WHERE tenant."id" = ${tenantId}
                `).resolves.toEqual([{
                    status: 'ACTIVE',
                    subscriptionId,
                    credits: 100,
                    sessionRevokedAt: null,
                    intentState: 'BLOCKED',
                    providerMutationOwned: 'true',
                    providerAction: 'already_scheduled',
                    compensationAction: 'unscheduled',
                    blockedAuditCount: 1,
                    archivedAuditCount: 0,
                }]);
            } finally {
                await cleanupCancellationProofTenants(owner, [tenantId], postgresCapability);
                await restrictedRecovery.$disconnect();
                await restrictedHold.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('recovers operation ownership after provider uncertainty and compensates when a later hold wins', async () => {
            const restrictedArchive = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const restrictedHold = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-ownership-${suffix}`;
            const subscriptionId = `sub-cancellation-ownership-${suffix}`;
            const tenantDb = new TenantPrismaService(restrictedArchive);
            const durableStore = new PrismaTenantCancellationIntentStore(tenantDb, 300);
            let markAttempt = 0;
            let finalizeFailures = 1;
            let thirdMarkEnteredResolve!: () => void;
            const thirdMarkEntered = new Promise<void>((resolve) => {
                thirdMarkEnteredResolve = resolve;
            });
            let releaseThirdMarkResolve!: () => void;
            const releaseThirdMark = new Promise<void>((resolve) => {
                releaseThirdMarkResolve = resolve;
            });
            const failureInjectingStore: TenantCancellationIntentStore = {
                prepare: (input) => durableStore.prepare(input),
                markProviderApplied: async (prepared, outcome, providerMutationOwned) => {
                    markAttempt += 1;
                    if (markAttempt === 1) {
                        throw new Error('injected post-provider persistence crash');
                    }
                    if (markAttempt === 3) {
                        thirdMarkEnteredResolve();
                        await releaseThirdMark;
                    }
                    return durableStore.markProviderApplied(
                        prepared,
                        outcome,
                        providerMutationOwned,
                    );
                },
                renewProviderClaim: (prepared) => durableStore.renewProviderClaim(prepared),
                providerLeaseRenewalIntervalMs: () =>
                    durableStore.providerLeaseRenewalIntervalMs(),
                markCompensated: (prepared, outcome) =>
                    durableStore.markCompensated(prepared, outcome),
                releaseProviderClaim: (prepared) => durableStore.releaseProviderClaim(prepared),
                finalize: async (prepared) => {
                    if (finalizeFailures > 0) {
                        finalizeFailures -= 1;
                        throw new Error('injected finalization failure');
                    }
                    return durableStore.finalize(prepared);
                },
            };
            let remoteScheduled = false;
            let remoteOperationId: string | null = null;
            const stripe = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async (
                    _tenantId: string,
                    _subscriptionId: string,
                    operationId: string,
                ) => {
                    const action = remoteScheduled
                        ? 'already_scheduled' as const
                        : 'scheduled' as const;
                    if (!remoteScheduled) {
                        remoteScheduled = true;
                        remoteOperationId = operationId;
                    }
                    return {
                        ...providerResult,
                        action,
                        stripeSubscriptionId: subscriptionId,
                        providerMutationOwned: remoteOperationId === operationId,
                    };
                }),
                compensateTenantSubscriptionCancellation: vi.fn(async (
                    _tenantId: string,
                    _subscriptionId: string,
                    operationId: string,
                ) => {
                    expect(operationId).toBe(remoteOperationId);
                    remoteScheduled = false;
                    return {
                        action: 'unscheduled' as const,
                        cancelAtPeriodEnd: false,
                    };
                }),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDb,
                () => stripe,
                failureInjectingStore,
            );
            const holdOwner = new TenantAccountLifecycleService(
                new TenantPrismaService(restrictedHold),
                {
                    cancelTenantSubscriptionAtPeriodEnd: stripe.cancelTenantSubscriptionAtPeriodEnd,
                    finalizeTenantBillingForPurge: vi.fn(),
                } as any,
            );

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await createCancellationProofTenant(
                    owner,
                    tenantId,
                    `cancellation-ownership-${suffix}`,
                    subscriptionId,
                );

                await expect(lifecycle.archivePlatform(platformActor, tenantId))
                    .rejects.toThrow('pending reconciliation');
                expect(remoteScheduled).toBe(true);
                await expect(owner.$queryRaw<Array<{
                    state: string;
                    providerMutationOwned: string | null;
                }>>`
                    SELECT "value"->>'state' AS "state",
                           "value"->>'providerMutationOwned' AS "providerMutationOwned"
                    FROM "TenantSetting"
                    WHERE "tenantId" = ${tenantId}
                      AND "key" = ${testLifecycleIntentSettingKeys[1]}
                `).resolves.toEqual([{
                    state: 'PENDING_PROVIDER',
                    providerMutationOwned: null,
                }]);

                await new Promise((resolve) => setTimeout(resolve, 450));
                await expect(lifecycle.archivePlatform(platformActor, tenantId))
                    .rejects.toThrow('pending reconciliation');
                await expect(owner.$queryRaw<Array<{
                    state: string;
                    providerMutationOwned: string;
                    providerAction: string;
                }>>`
                    SELECT "value"->>'state' AS "state",
                           "value"->>'providerMutationOwned' AS "providerMutationOwned",
                           "value"->'providerResult'->>'action' AS "providerAction"
                    FROM "TenantSetting"
                    WHERE "tenantId" = ${tenantId}
                      AND "key" = ${testLifecycleIntentSettingKeys[1]}
                `).resolves.toEqual([{
                    state: 'PROVIDER_APPLIED',
                    providerMutationOwned: 'true',
                    providerAction: 'already_scheduled',
                }]);

                const heldArchive = lifecycle.archivePlatform(platformActor, tenantId);
                await bounded(thirdMarkEntered);
                await holdOwner.placeRetentionLegalHold(
                    tenantId,
                    platformActor,
                    { reason: 'Ownership replay legal-hold race proof.' },
                );
                releaseThirdMarkResolve();

                await expect(bounded(heldArchive)).resolves.toEqual({
                    id: tenantId,
                    archived: false,
                });
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(3);
                expect(stripe.compensateTenantSubscriptionCancellation).toHaveBeenCalledOnce();
                expect(remoteScheduled).toBe(false);
                await expect(owner.$queryRaw<Array<{
                    status: string;
                    deletedAt: Date | null;
                    holdAt: Date | null;
                    state: string;
                    providerMutationOwned: string;
                    providerAction: string;
                    compensationAction: string;
                    blockedAuditCount: number;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."deletedAt" AS "deletedAt",
                           tenant."retentionLegalHoldAt" AS "holdAt",
                           setting."value"->>'state' AS "state",
                           setting."value"->>'providerMutationOwned' AS "providerMutationOwned",
                           setting."value"->'providerResult'->>'action' AS "providerAction",
                           setting."value"->'compensationResult'->>'action' AS "compensationAction",
                           COUNT(audit."id")::integer AS "blockedAuditCount"
                    FROM "Tenant" tenant
                    JOIN "TenantSetting" setting
                      ON setting."tenantId" = tenant."id"
                     AND setting."key" = ${testLifecycleIntentSettingKeys[1]}
                    LEFT JOIN "AuditLog" audit
                      ON audit."tenantId" = tenant."id"
                     AND audit."action" = 'TENANT_ARCHIVE_BLOCKED_BY_LEGAL_HOLD'
                    WHERE tenant."id" = ${tenantId}
                    GROUP BY tenant."status", tenant."deletedAt", tenant."retentionLegalHoldAt", setting."value"
                `).resolves.toEqual([{
                    status: 'ACTIVE',
                    deletedAt: null,
                    holdAt: expect.any(Date),
                    state: 'BLOCKED',
                    providerMutationOwned: 'true',
                    providerAction: 'already_scheduled',
                    compensationAction: 'unscheduled',
                    blockedAuditCount: 1,
                }]);
            } finally {
                releaseThirdMarkResolve?.();
                await cleanupCancellationProofTenants(owner, [tenantId], postgresCapability);
                await restrictedArchive.$disconnect();
                await restrictedHold.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('never compensates an already-scheduled customer cancellation across a legal-hold race and retry', async () => {
            const restrictedArchive = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const restrictedHold = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-owned-${suffix}`;
            const userId = `user-cancellation-recovery-owned-${suffix}`;
            const subscriptionId = `sub-cancellation-owned-${suffix}`;
            const tenantDb = new TenantPrismaService(restrictedArchive);
            const store = new PrismaTenantCancellationIntentStore(tenantDb, 500);
            let providerEnteredResolve!: () => void;
            const providerEntered = new Promise<void>((resolve) => {
                providerEnteredResolve = resolve;
            });
            let releaseProviderResolve!: () => void;
            const releaseProvider = new Promise<void>((resolve) => {
                releaseProviderResolve = resolve;
            });
            let cancellationStillScheduled = true;
            let providerCalls = 0;
            const stripe = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async (
                    _tenantId: string,
                    _subscriptionId: string,
                    _operationId: string,
                    options?: { authoritativeCustomerCancellation?: boolean },
                ) => {
                    providerCalls += 1;
                    if (providerCalls === 1) {
                        providerEnteredResolve();
                        await releaseProvider;
                    }
                    return {
                        ...providerResult,
                        action: 'already_scheduled' as const,
                        stripeSubscriptionId: subscriptionId,
                        cancelAtPeriodEnd: cancellationStillScheduled,
                        providerMutationOwned:
                            options?.authoritativeCustomerCancellation === true,
                    };
                }),
                compensateTenantSubscriptionCancellation: vi.fn(async () => {
                    cancellationStillScheduled = false;
                    return {
                        action: 'unscheduled' as const,
                        cancelAtPeriodEnd: false,
                    };
                }),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDb,
                () => stripe,
                store,
            );
            const holdOwner = new TenantAccountLifecycleService(
                new TenantPrismaService(restrictedHold),
                {
                    cancelTenantSubscriptionAtPeriodEnd: stripe.cancelTenantSubscriptionAtPeriodEnd,
                    finalizeTenantBillingForPurge: vi.fn(),
                } as any,
            );

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await createCancellationProofTenant(
                    owner,
                    tenantId,
                    `cancellation-owned-${suffix}`,
                    subscriptionId,
                );
                await owner.$executeRaw`
                    INSERT INTO "User"
                        ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
                    VALUES
                        (${userId}, ${tenantId}, 'Cancellation Owner', ${`cancellation-owner-${suffix}`},
                         'ADMIN'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;

                const archive = lifecycle.archivePlatform(platformActor, tenantId);
                await bounded(providerEntered);
                await holdOwner.placeRetentionLegalHold(
                    tenantId,
                    platformActor,
                    { reason: 'Customer-owned cancellation compensation proof.' },
                );
                releaseProviderResolve();

                await expect(bounded(archive)).resolves.toEqual({
                    id: tenantId,
                    archived: false,
                });
                expect(stripe.compensateTenantSubscriptionCancellation).not.toHaveBeenCalled();
                expect(cancellationStillScheduled).toBe(true);

                const customer = await lifecycle.cancelCustomer(
                    { ...customerActor, tenantId, userId },
                    { confirmation: `cancellation-owned-${suffix}` },
                );
                expect(customer).toMatchObject({
                    status: 'ACTIVE',
                    billingCancellation: {
                        action: 'already_scheduled',
                        cancelAtPeriodEnd: true,
                    },
                });
                expect(cancellationStillScheduled).toBe(true);
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
                expect(stripe.compensateTenantSubscriptionCancellation).not.toHaveBeenCalled();

                await expect(owner.$queryRaw<Array<{
                    kind: string;
                    state: string;
                    providerMutationOwned: string;
                    providerAction: string;
                }>>`
                    SELECT "value"->>'kind' AS "kind",
                           "value"->>'state' AS "state",
                           "value"->>'providerMutationOwned' AS "providerMutationOwned",
                           "value"->'providerResult'->>'action' AS "providerAction"
                    FROM "TenantSetting"
                    WHERE "tenantId" = ${tenantId}
                      AND "key" IN (${testLifecycleIntentSettingKeys[0]}, ${testLifecycleIntentSettingKeys[1]})
                    ORDER BY "value"->>'kind'
                `).resolves.toEqual([
                    {
                        kind: 'CUSTOMER_CANCELLATION',
                        state: 'FINALIZED',
                        providerMutationOwned: 'true',
                        providerAction: 'already_scheduled',
                    },
                    {
                        kind: 'PLATFORM_ARCHIVE',
                        state: 'BLOCKED',
                        providerMutationOwned: 'false',
                        providerAction: 'already_scheduled',
                    },
                ]);
            } finally {
                releaseProviderResolve?.();
                await cleanupCancellationProofTenants(owner, [tenantId], postgresCapability);
                await restrictedArchive.$disconnect();
                await restrictedHold.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('revalidates deleted subscription A after resolution when finalization binds replacement B', async () => {
            const restrictedLifecycle = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const restrictedWebhook = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-binding-${suffix}`;
            const userId = `user-cancellation-recovery-binding-${suffix}`;
            const sessionId = `session-cancellation-recovery-binding-${suffix}`;
            const customerId = `cus-cancellation-recovery-binding-${suffix}`;
            const subscriptionA = `sub-cancellation-recovery-a-${suffix}`;
            const subscriptionB = `sub-cancellation-recovery-b-${suffix}`;
            const eventId = `evt-cancellation-recovery-a-${suffix}`;
            const lifecycleDb = new TenantPrismaService(restrictedLifecycle);
            const provider = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => ({
                    ...providerResult,
                    action: 'already_canceled' as const,
                    stripeSubscriptionId: subscriptionA,
                    cancelAtPeriodEnd: false,
                    canceledAt: '2027-01-10T08:00:00.000Z',
                })),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                lifecycleDb,
                () => provider,
            );
            const deletedEvent = {
                id: eventId,
                created: 1_800_000_200,
                type: 'customer.subscription.deleted',
                data: {
                    object: {
                        object: 'subscription',
                        id: subscriptionA,
                        customer: customerId,
                        status: 'canceled',
                        cancel_at_period_end: false,
                        metadata: { tenantId },
                    },
                },
            };
            const retrieveSubscription = vi.fn();
            const webhook = new StripeService({
                get: (key: string) => ({
                    STRIPE_SECRET_KEY: 'sk_test_binding_race',
                    STRIPE_WEBHOOK_SECRET: 'whsec_binding_race',
                } as Record<string, string>)[key],
            } as any, new TenantPrismaService(restrictedWebhook), {} as any);
            (webhook as any).stripe = {
                webhooks: { constructEvent: vi.fn(() => deletedEvent) },
                subscriptions: { retrieve: retrieveSubscription },
            };
            (webhook as any).logger = {
                log: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            };
            const resolveTenantContext = (webhook as any).resolveTenantContext.bind(webhook);
            let subscriptionResolvedResolve!: () => void;
            const subscriptionResolved = new Promise<void>((resolve) => {
                subscriptionResolvedResolve = resolve;
            });
            let releaseResolutionResolve!: () => void;
            const releaseResolution = new Promise<void>((resolve) => {
                releaseResolutionResolve = resolve;
            });
            (webhook as any).resolveTenantContext = async (...args: any[]) => {
                const context = await resolveTenantContext(...args);
                expect(context).toMatchObject({
                    tenantId,
                    subscriptionId: subscriptionA,
                });
                expect(context.finalizedCancellationIntent).toBeUndefined();
                subscriptionResolvedResolve();
                await releaseResolution;
                return context;
            };
            const actor = { ...customerActor, tenantId, userId };

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await createCancellationProofTenant(
                    owner,
                    tenantId,
                    `cancellation-binding-${suffix}`,
                    subscriptionA,
                    customerId,
                );
                await createCancellationProofUserSession(
                    owner,
                    tenantId,
                    userId,
                    sessionId,
                    suffix,
                );

                const handling = webhook.handleWebhook(Buffer.from('{}'), 'sig_binding_race');
                await bounded(subscriptionResolved);
                await lifecycle.cancelCustomer(actor, {
                    confirmation: `cancellation-binding-${suffix}`,
                });
                await owner.$executeRaw`
                    UPDATE "Tenant"
                    SET "status" = 'ACTIVE'::"TenantStatus",
                        "stripeSubscriptionId" = ${subscriptionB},
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = ${tenantId}
                `;
                releaseResolutionResolve();
                await bounded(handling);

                expect(provider.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();
                expect(retrieveSubscription).not.toHaveBeenCalled();
                await expect(owner.$queryRaw<Array<{
                    status: string;
                    subscriptionId: string | null;
                    credits: number;
                    sessionRevokedAt: Date | null;
                    disposition: string;
                    eventCount: number;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."stripeSubscriptionId" AS "subscriptionId",
                           tenant."usageCredits" AS "credits",
                           session."revokedAt" AS "sessionRevokedAt",
                           event."metadata"->>'sideEffectDisposition' AS "disposition",
                           (SELECT COUNT(*)::integer FROM "BillingEvent" counted
                             WHERE counted."tenantId" = tenant."id"
                               AND counted."stripeEventId" = ${eventId}) AS "eventCount"
                    FROM "Tenant" tenant
                    JOIN "Session" session ON session."id" = ${sessionId}
                    JOIN "BillingEvent" event
                      ON event."tenantId" = tenant."id"
                     AND event."stripeEventId" = ${eventId}
                    WHERE tenant."id" = ${tenantId}
                `).resolves.toEqual([{
                    status: 'ACTIVE',
                    subscriptionId: subscriptionB,
                    credits: 100,
                    sessionRevokedAt: null,
                    disposition: 'skipped_unverified_subscription',
                    eventCount: 1,
                }]);
            } finally {
                releaseResolutionResolve?.();
                await cleanupCancellationProofTenants(owner, [tenantId], postgresCapability);
                await restrictedLifecycle.$disconnect();
                await restrictedWebhook.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('projects already-canceled provider truth locally without a webhook and idempotently accepts its late replay', async () => {
            const restricted = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-terminal-${suffix}`;
            const userId = `user-cancellation-recovery-terminal-${suffix}`;
            const customerId = `cus-cancellation-terminal-${suffix}`;
            const subscriptionId = `sub-cancellation-terminal-${suffix}`;
            const tenantDb = new TenantPrismaService(restricted);
            const stripe = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => ({
                    ...providerResult,
                    action: 'already_canceled' as const,
                    stripeSubscriptionId: subscriptionId,
                    cancelAtPeriodEnd: false,
                    canceledAt: '2027-01-10T08:00:00.000Z',
                })),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDb,
                () => stripe,
            );
            const customerActorForTenant = { ...customerActor, tenantId, userId };

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await createCancellationProofTenant(
                    owner,
                    tenantId,
                    `cancellation-terminal-${suffix}`,
                    subscriptionId,
                    customerId,
                );
                await owner.$executeRaw`
                    INSERT INTO "User"
                        ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
                    VALUES
                        (${userId}, ${tenantId}, 'Terminal Cancellation Owner', ${`terminal-cancellation-${suffix}`},
                         'ADMIN'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;

                const cancellation = await lifecycle.cancelCustomer(
                    customerActorForTenant,
                    { confirmation: `cancellation-terminal-${suffix}` },
                );
                expect(cancellation).toMatchObject({
                    status: 'CANCELLED',
                    billingCancellation: { action: 'already_canceled' },
                });
                await expect(owner.$queryRaw<Array<{
                    status: string;
                    subscriptionId: string | null;
                    deletedAt: Date | null;
                    action: string;
                    providerMutationOwned: string;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."stripeSubscriptionId" AS "subscriptionId",
                           tenant."deletedAt" AS "deletedAt",
                           setting."value"->'providerResult'->>'action' AS "action",
                           setting."value"->>'providerMutationOwned' AS "providerMutationOwned"
                    FROM "Tenant" tenant
                    JOIN "TenantSetting" setting
                      ON setting."tenantId" = tenant."id"
                     AND setting."key" = ${testLifecycleIntentSettingKeys[0]}
                    WHERE tenant."id" = ${tenantId}
                `).resolves.toEqual([{
                    status: 'CANCELLED',
                    subscriptionId: null,
                    deletedAt: null,
                    action: 'already_canceled',
                    providerMutationOwned: 'false',
                }]);

                const features = await new FeatureAccessService({} as any, tenantDb)
                    .getFeatureMatrix(tenantId);
                expect(features).toMatchObject({
                    status: 'CANCELLED',
                    stripeSubscriptionActive: false,
                    stripeSubscriptionPresent: false,
                });
                expect(Object.values(features.features).every((feature) => !feature.enabled)).toBe(true);

                const eventId = `evt-cancellation-terminal-${suffix}`;
                const terminalEvent = {
                    id: eventId,
                    created: 1_800_000_000,
                    type: 'customer.subscription.deleted',
                    data: {
                        object: {
                            object: 'subscription',
                            id: subscriptionId,
                            customer: customerId,
                            status: 'canceled',
                            cancel_at_period_end: false,
                            metadata: { tenantId },
                        },
                    },
                };
                let constructedEvent = terminalEvent;
                const retrieveSubscription = vi.fn();
                const webhook = new StripeService({
                    get: (key: string) => ({
                        STRIPE_SECRET_KEY: 'sk_test_terminal_replay',
                        STRIPE_WEBHOOK_SECRET: 'whsec_terminal_replay',
                    } as Record<string, string>)[key],
                } as any, tenantDb, {} as any);
                (webhook as any).stripe = {
                    webhooks: { constructEvent: vi.fn(() => constructedEvent) },
                    subscriptions: { retrieve: retrieveSubscription },
                };
                (webhook as any).logger = {
                    log: vi.fn(),
                    warn: vi.fn(),
                    error: vi.fn(),
                    debug: vi.fn(),
                };

                await webhook.handleWebhook(Buffer.from('{}'), 'sig_terminal_replay');
                await webhook.handleWebhook(Buffer.from('{}'), 'sig_terminal_replay');
                await expect(owner.$queryRaw<Array<{
                    status: string;
                    subscriptionId: string | null;
                    eventCount: number;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."stripeSubscriptionId" AS "subscriptionId",
                           COUNT(event."id")::integer AS "eventCount"
                    FROM "Tenant" tenant
                    LEFT JOIN "BillingEvent" event
                      ON event."tenantId" = tenant."id"
                     AND event."stripeEventId" = ${eventId}
                    WHERE tenant."id" = ${tenantId}
                    GROUP BY tenant."status", tenant."stripeSubscriptionId"
                `).resolves.toEqual([{
                    status: 'CANCELLED',
                    subscriptionId: null,
                    eventCount: 1,
                }]);

                await expect(lifecycle.cancelCustomer(
                    customerActorForTenant,
                    { confirmation: `cancellation-terminal-${suffix}` },
                )).resolves.toEqual(cancellation);
                expect(stripe.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();

                const replacementSubscriptionId = `sub-cancellation-replacement-${suffix}`;
                const pausedEventId = `evt-cancellation-paused-old-${suffix}`;
                constructedEvent = {
                    id: pausedEventId,
                    created: 1_800_000_001,
                    type: 'customer.subscription.paused',
                    data: {
                        object: {
                            object: 'subscription',
                            id: subscriptionId,
                            customer: customerId,
                            status: 'paused',
                            cancel_at_period_end: false,
                            metadata: { tenantId },
                        },
                    },
                };
                const resolveTenantContext = (webhook as any).resolveTenantContext.bind(webhook);
                let oldSubscriptionResolvedResolve!: () => void;
                const oldSubscriptionResolved = new Promise<void>((resolve) => {
                    oldSubscriptionResolvedResolve = resolve;
                });
                let releaseOldSubscriptionResolve!: () => void;
                const releaseOldSubscription = new Promise<void>((resolve) => {
                    releaseOldSubscriptionResolve = resolve;
                });
                (webhook as any).resolveTenantContext = async (...args: any[]) => {
                    const context = await resolveTenantContext(...args);
                    if (args[0] === 'customer.subscription.paused') {
                        oldSubscriptionResolvedResolve();
                        await releaseOldSubscription;
                    }
                    return context;
                };

                const pausedReplay = webhook.handleWebhook(Buffer.from('{}'), 'sig_paused_old');
                await bounded(oldSubscriptionResolved);
                await owner.$executeRaw`
                    UPDATE "Tenant"
                    SET "status" = 'ACTIVE'::"TenantStatus",
                        "stripeSubscriptionId" = ${replacementSubscriptionId},
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = ${tenantId}
                `;
                releaseOldSubscriptionResolve();
                await bounded(pausedReplay);

                await expect(owner.$queryRaw<Array<{
                    status: string;
                    subscriptionId: string | null;
                    disposition: string;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."stripeSubscriptionId" AS "subscriptionId",
                           event."metadata"->>'sideEffectDisposition' AS "disposition"
                    FROM "Tenant" tenant
                    JOIN "BillingEvent" event
                      ON event."tenantId" = tenant."id"
                     AND event."stripeEventId" = ${pausedEventId}
                    WHERE tenant."id" = ${tenantId}
                `).resolves.toEqual([{
                    status: 'ACTIVE',
                    subscriptionId: replacementSubscriptionId,
                    disposition: 'skipped_unverified_subscription',
                }]);
                expect(retrieveSubscription).not.toHaveBeenCalled();
            } finally {
                await cleanupCancellationProofTenants(owner, [tenantId], postgresCapability);
                await restricted.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('self-converges a due finalized schedule when the period-end webhook is missed', async () => {
            const restricted = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-missed-webhook-${suffix}`;
            const userId = `user-cancellation-recovery-missed-webhook-${suffix}`;
            const sessionId = `session-cancellation-recovery-missed-webhook-${suffix}`;
            const subscriptionId = `sub-cancellation-recovery-missed-webhook-${suffix}`;
            const effectiveAt = new Date(Date.now() - 60_000).toISOString();
            const tenantDb = new TenantPrismaService(restricted);
            const store = new PrismaTenantCancellationIntentStore(tenantDb, 5_000);
            let providerMutations = 0;
            let providerTerminal = false;
            const provider = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async (
                    _tenantId: string,
                    _subscriptionId: string,
                    _operationId: string,
                    options?: { providerReadbackOnly?: boolean },
                ) => {
                    if (options?.providerReadbackOnly) {
                        return {
                            ...providerResult,
                            action: providerTerminal
                                ? 'already_canceled' as const
                                : 'already_scheduled' as const,
                            stripeSubscriptionId: subscriptionId,
                            cancelAtPeriodEnd: !providerTerminal,
                            currentPeriodEnd: effectiveAt,
                            providerMutationOwned: true,
                        };
                    }
                    providerMutations += 1;
                    return {
                        ...providerResult,
                        stripeSubscriptionId: subscriptionId,
                        currentPeriodEnd: effectiveAt,
                        providerMutationOwned: true,
                    };
                }),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDb,
                () => provider,
                store,
            );
            const actor = { ...customerActor, tenantId, userId };

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await createCancellationProofTenant(
                    owner,
                    tenantId,
                    `cancellation-missed-webhook-${suffix}`,
                    subscriptionId,
                );
                await createCancellationProofUserSession(
                    owner,
                    tenantId,
                    userId,
                    sessionId,
                    suffix,
                );

                await lifecycle.cancelCustomer(actor, {
                    confirmation: `cancellation-missed-webhook-${suffix}`,
                });
                const [before] = await owner.$queryRaw<Array<{
                    operationId: string;
                    fingerprint: string;
                }>>`
                    SELECT "value"->>'operationId' AS "operationId",
                           "value"->>'subscriptionFingerprint' AS "fingerprint"
                    FROM "TenantSetting"
                    WHERE "tenantId" = ${tenantId}
                      AND "key" = ${testLifecycleIntentSettingKeys[0]}
                `;
                providerTerminal = true;

                const [due] = await store.claimRecoverable(1);
                expect(due?.intent).toMatchObject({
                    state: 'FINALIZED',
                    operationId: before.operationId,
                });
                await lifecycle.reconcilePrepared(due);
                expect(await store.countBacklog()).toBe(0);
                await expect(lifecycle.cancelCustomer(actor, {
                    confirmation: `cancellation-missed-webhook-${suffix}`,
                })).resolves.toMatchObject({
                    status: 'CANCELLED',
                    billingCancellation: { action: 'already_canceled' },
                });

                expect(provider.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledTimes(2);
                expect(provider.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenNthCalledWith(
                    2,
                    tenantId,
                    subscriptionId,
                    before.operationId,
                    { providerReadbackOnly: true },
                );
                expect(providerMutations).toBe(1);
                await expect(owner.$queryRaw<Array<{
                    status: string;
                    subscriptionId: string | null;
                    credits: number;
                    sessionRevokedAt: Date | null;
                    operationId: string;
                    fingerprint: string;
                    providerAction: string;
                    intentAuditCount: number;
                    scheduledAuditCount: number;
                    completedAuditCount: number;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."stripeSubscriptionId" AS "subscriptionId",
                           tenant."usageCredits" AS "credits",
                           session."revokedAt" AS "sessionRevokedAt",
                           setting."value"->>'operationId' AS "operationId",
                           setting."value"->>'subscriptionFingerprint' AS "fingerprint",
                           setting."value"->'providerResult'->>'action' AS "providerAction",
                           (SELECT COUNT(*)::integer FROM "AuditLog" audit
                             WHERE audit."tenantId" = tenant."id"
                               AND audit."action" = 'TENANT_CANCELLATION_INTENT_RECORDED_BY_CUSTOMER') AS "intentAuditCount",
                           (SELECT COUNT(*)::integer FROM "AuditLog" audit
                             WHERE audit."tenantId" = tenant."id"
                               AND audit."action" = 'TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER') AS "scheduledAuditCount",
                           (SELECT COUNT(*)::integer FROM "AuditLog" audit
                             WHERE audit."tenantId" = tenant."id"
                               AND audit."action" = 'TENANT_CANCELLATION_COMPLETED_BY_CUSTOMER') AS "completedAuditCount"
                    FROM "Tenant" tenant
                    JOIN "TenantSetting" setting
                      ON setting."tenantId" = tenant."id"
                     AND setting."key" = ${testLifecycleIntentSettingKeys[0]}
                    JOIN "Session" session ON session."id" = ${sessionId}
                    WHERE tenant."id" = ${tenantId}
                `).resolves.toEqual([{
                    status: 'CANCELLED',
                    subscriptionId: null,
                    credits: 100,
                    sessionRevokedAt: null,
                    operationId: before.operationId,
                    fingerprint: before.fingerprint,
                    providerAction: 'already_canceled',
                    intentAuditCount: 1,
                    scheduledAuditCount: 1,
                    completedAuditCount: 1,
                }]);
            } finally {
                await cleanupCancellationProofTenants(owner, [tenantId], postgresCapability);
                await restricted.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('converges a finalized schedule after deleted webhook before API replay without provider mutation', async () => {
            const restrictedLifecycle = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const restrictedWebhook = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-scheduled-webhook-${suffix}`;
            const userId = `user-cancellation-recovery-scheduled-webhook-${suffix}`;
            const sessionId = `session-cancellation-recovery-scheduled-webhook-${suffix}`;
            const customerId = `cus-cancellation-recovery-scheduled-webhook-${suffix}`;
            const subscriptionId = `sub-cancellation-recovery-scheduled-webhook-${suffix}`;
            const eventId = `evt-cancellation-recovery-scheduled-webhook-${suffix}`;
            const tenantDb = new TenantPrismaService(restrictedLifecycle);
            let providerMutations = 0;
            const provider = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => {
                    providerMutations += 1;
                    return {
                        ...providerResult,
                        stripeSubscriptionId: subscriptionId,
                        currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString(),
                        providerMutationOwned: true,
                    };
                }),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDb,
                () => provider,
            );
            const terminalEvent = {
                id: eventId,
                created: 1_800_000_300,
                type: 'customer.subscription.deleted',
                data: {
                    object: {
                        object: 'subscription',
                        id: subscriptionId,
                        customer: customerId,
                        status: 'canceled',
                        cancel_at_period_end: false,
                        metadata: { tenantId },
                    },
                },
            };
            const webhook = new StripeService({
                get: (key: string) => ({
                    STRIPE_SECRET_KEY: 'sk_test_scheduled_webhook',
                    STRIPE_WEBHOOK_SECRET: 'whsec_scheduled_webhook',
                } as Record<string, string>)[key],
            } as any, new TenantPrismaService(restrictedWebhook), {} as any);
            (webhook as any).stripe = {
                webhooks: { constructEvent: vi.fn(() => terminalEvent) },
            };
            (webhook as any).logger = {
                log: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            };
            const actor = { ...customerActor, tenantId, userId };

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await createCancellationProofTenant(
                    owner,
                    tenantId,
                    `cancellation-scheduled-webhook-${suffix}`,
                    subscriptionId,
                    customerId,
                );
                await createCancellationProofUserSession(
                    owner,
                    tenantId,
                    userId,
                    sessionId,
                    suffix,
                );

                await lifecycle.cancelCustomer(actor, {
                    confirmation: `cancellation-scheduled-webhook-${suffix}`,
                });
                const [before] = await owner.$queryRaw<Array<{
                    operationId: string;
                    fingerprint: string;
                }>>`
                    SELECT "value"->>'operationId' AS "operationId",
                           "value"->>'subscriptionFingerprint' AS "fingerprint"
                    FROM "TenantSetting"
                    WHERE "tenantId" = ${tenantId}
                      AND "key" = ${testLifecycleIntentSettingKeys[0]}
                `;

                await webhook.handleWebhook(Buffer.from('{}'), 'sig_scheduled_webhook');
                await expect(lifecycle.cancelCustomer(actor, {
                    confirmation: `cancellation-scheduled-webhook-${suffix}`,
                })).resolves.toMatchObject({
                    status: 'CANCELLED',
                    billingCancellation: { action: 'already_canceled' },
                });
                await expect(lifecycle.cancelCustomer(actor, {
                    confirmation: `cancellation-scheduled-webhook-${suffix}`,
                })).resolves.toMatchObject({
                    status: 'CANCELLED',
                    billingCancellation: { action: 'already_canceled' },
                });
                await webhook.handleWebhook(Buffer.from('{}'), 'sig_scheduled_webhook');

                expect(provider.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();
                expect(providerMutations).toBe(1);
                await expect(owner.$queryRaw<Array<{
                    status: string;
                    subscriptionId: string | null;
                    credits: number;
                    sessionRevokedAt: Date | null;
                    operationId: string;
                    fingerprint: string;
                    providerAction: string;
                    intentAuditCount: number;
                    scheduledAuditCount: number;
                    completedAuditCount: number;
                    billingEventCount: number;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."stripeSubscriptionId" AS "subscriptionId",
                           tenant."usageCredits" AS "credits",
                           session."revokedAt" AS "sessionRevokedAt",
                           setting."value"->>'operationId' AS "operationId",
                           setting."value"->>'subscriptionFingerprint' AS "fingerprint",
                           setting."value"->'providerResult'->>'action' AS "providerAction",
                           (SELECT COUNT(*)::integer FROM "AuditLog" audit
                             WHERE audit."tenantId" = tenant."id"
                               AND audit."action" = 'TENANT_CANCELLATION_INTENT_RECORDED_BY_CUSTOMER') AS "intentAuditCount",
                           (SELECT COUNT(*)::integer FROM "AuditLog" audit
                             WHERE audit."tenantId" = tenant."id"
                               AND audit."action" = 'TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER') AS "scheduledAuditCount",
                           (SELECT COUNT(*)::integer FROM "AuditLog" audit
                             WHERE audit."tenantId" = tenant."id"
                               AND audit."action" = 'TENANT_CANCELLATION_COMPLETED_BY_CUSTOMER') AS "completedAuditCount",
                           (SELECT COUNT(*)::integer FROM "BillingEvent" event
                             WHERE event."tenantId" = tenant."id"
                               AND event."stripeEventId" = ${eventId}) AS "billingEventCount"
                    FROM "Tenant" tenant
                    JOIN "TenantSetting" setting
                      ON setting."tenantId" = tenant."id"
                     AND setting."key" = ${testLifecycleIntentSettingKeys[0]}
                    JOIN "Session" session ON session."id" = ${sessionId}
                    WHERE tenant."id" = ${tenantId}
                `).resolves.toEqual([{
                    status: 'CANCELLED',
                    subscriptionId: null,
                    credits: 100,
                    sessionRevokedAt: null,
                    operationId: before.operationId,
                    fingerprint: before.fingerprint,
                    providerAction: 'already_canceled',
                    intentAuditCount: 1,
                    scheduledAuditCount: 1,
                    completedAuditCount: 1,
                    billingEventCount: 1,
                }]);
            } finally {
                await cleanupCancellationProofTenants(owner, [tenantId], postgresCapability);
                await restrictedLifecycle.$disconnect();
                await restrictedWebhook.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);

        it('finalizes the original intent when a terminal webhook wins after provider return', async () => {
            const restrictedLifecycle = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const restrictedWebhook = new PrismaClient({
                datasources: { db: { url: postgresRestrictedUrl } },
            });
            const owner = new PrismaClient({
                datasources: { db: { url: postgresOwnerUrl } },
            });
            const suffix = randomUUID();
            const tenantId = `tenant-cancellation-recovery-webhook-${suffix}`;
            const userId = `user-cancellation-recovery-webhook-${suffix}`;
            const sessionId = `session-cancellation-recovery-webhook-${suffix}`;
            const customerId = `cus-cancellation-recovery-webhook-${suffix}`;
            const subscriptionId = `sub-cancellation-recovery-webhook-${suffix}`;
            const eventId = `evt-cancellation-recovery-webhook-${suffix}`;
            const tenantDb = new TenantPrismaService(restrictedLifecycle);
            const durableStore = new PrismaTenantCancellationIntentStore(tenantDb, 5_000);
            let markEnteredResolve!: () => void;
            const markEntered = new Promise<void>((resolve) => {
                markEnteredResolve = resolve;
            });
            let releaseMarkResolve!: () => void;
            const releaseMark = new Promise<void>((resolve) => {
                releaseMarkResolve = resolve;
            });
            const finalize = vi.fn((prepared: PreparedTenantCancellationIntent) =>
                durableStore.finalize(prepared));
            const barrierStore: TenantCancellationIntentStore = {
                prepare: (input) => durableStore.prepare(input),
                markProviderApplied: async (prepared, outcome, providerMutationOwned) => {
                    markEnteredResolve();
                    await releaseMark;
                    return durableStore.markProviderApplied(
                        prepared,
                        outcome,
                        providerMutationOwned,
                    );
                },
                renewProviderClaim: (prepared) => durableStore.renewProviderClaim(prepared),
                providerLeaseRenewalIntervalMs: () =>
                    durableStore.providerLeaseRenewalIntervalMs(),
                markCompensated: (prepared, outcome) =>
                    durableStore.markCompensated(prepared, outcome),
                releaseProviderClaim: (prepared) => durableStore.releaseProviderClaim(prepared),
                finalize,
            };
            const provider = {
                cancelTenantSubscriptionAtPeriodEnd: vi.fn(async () => ({
                    ...providerResult,
                    action: 'already_canceled' as const,
                    stripeSubscriptionId: subscriptionId,
                    cancelAtPeriodEnd: false,
                    canceledAt: '2027-01-10T08:00:00.000Z',
                    providerMutationOwned: false,
                })),
            };
            const lifecycle = new TenantCancellationLifecycleService(
                tenantDb,
                () => provider,
                barrierStore,
            );
            const terminalEvent = {
                id: eventId,
                created: 1_800_000_100,
                type: 'customer.subscription.deleted',
                data: {
                    object: {
                        object: 'subscription',
                        id: subscriptionId,
                        customer: customerId,
                        status: 'canceled',
                        cancel_at_period_end: false,
                        metadata: { tenantId },
                    },
                },
            };
            const webhook = new StripeService({
                get: (key: string) => ({
                    STRIPE_SECRET_KEY: 'sk_test_terminal_interleaving',
                    STRIPE_WEBHOOK_SECRET: 'whsec_terminal_interleaving',
                } as Record<string, string>)[key],
            } as any, new TenantPrismaService(restrictedWebhook), {} as any);
            (webhook as any).stripe = {
                webhooks: { constructEvent: vi.fn(() => terminalEvent) },
            };
            (webhook as any).logger = {
                log: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            };
            const actor = { ...customerActor, tenantId, userId };

            try {
                await deleteStaleTenantCancellationIntentSettings(owner);
                await createCancellationProofTenant(
                    owner,
                    tenantId,
                    `cancellation-webhook-${suffix}`,
                    subscriptionId,
                    customerId,
                );
                await owner.$executeRaw`
                    INSERT INTO "User"
                        ("id", "tenantId", "name", "username", "role", "mfaEnabled", "mfaBackupCodes", "createdAt", "updatedAt")
                    VALUES
                        (${userId}, ${tenantId}, 'Webhook Race Owner', ${`webhook-race-${suffix}`},
                         'ADMIN'::"UserRole", FALSE, ARRAY[]::TEXT[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `;
                await owner.$executeRaw`
                    INSERT INTO "Session"
                        ("id", "userId", "selectorHash", "refreshToken", "ipAddress", "userAgent", "expiresAt", "createdAt")
                    VALUES
                        (${sessionId}, ${userId}, ${`selector-${suffix}`}, ${`refresh-${suffix}`},
                         '203.0.113.40', 'cancellation-webhook-race', CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP)
                `;

                const cancellation = lifecycle.cancelCustomer(actor, {
                    confirmation: `cancellation-webhook-${suffix}`,
                });
                await bounded(markEntered);
                await webhook.handleWebhook(Buffer.from('{}'), 'sig_terminal_interleaving');
                await expect(owner.$queryRaw<Array<{
                    status: string;
                    subscriptionId: string | null;
                    intentState: string;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."stripeSubscriptionId" AS "subscriptionId",
                           setting."value"->>'state' AS "intentState"
                    FROM "Tenant" tenant
                    JOIN "TenantSetting" setting
                      ON setting."tenantId" = tenant."id"
                     AND setting."key" = ${testLifecycleIntentSettingKeys[0]}
                    WHERE tenant."id" = ${tenantId}
                `).resolves.toEqual([{
                    status: 'CANCELLED',
                    subscriptionId: null,
                    intentState: 'PENDING_PROVIDER',
                }]);
                releaseMarkResolve();

                await expect(bounded(cancellation)).resolves.toMatchObject({
                    id: tenantId,
                    status: 'CANCELLED',
                    billingCancellation: { action: 'already_canceled' },
                });
                await expect(lifecycle.cancelCustomer(actor, {
                    confirmation: `cancellation-webhook-${suffix}`,
                })).resolves.toMatchObject({
                    id: tenantId,
                    status: 'CANCELLED',
                    billingCancellation: { action: 'already_canceled' },
                });
                expect(provider.cancelTenantSubscriptionAtPeriodEnd).toHaveBeenCalledOnce();
                expect(finalize).not.toHaveBeenCalled();

                await expect(owner.$queryRaw<Array<{
                    status: string;
                    subscriptionId: string | null;
                    intentState: string;
                    providerAction: string;
                    completedAuditCount: number;
                    billingEventCount: number;
                    sessionRevokedAt: Date | null;
                    usageCredits: number;
                }>>`
                    SELECT tenant."status"::text AS "status",
                           tenant."stripeSubscriptionId" AS "subscriptionId",
                           setting."value"->>'state' AS "intentState",
                           setting."value"->'providerResult'->>'action' AS "providerAction",
                           (SELECT COUNT(*)::integer
                              FROM "AuditLog" audit
                             WHERE audit."tenantId" = tenant."id"
                               AND audit."action" = 'TENANT_CANCELLATION_COMPLETED_BY_CUSTOMER') AS "completedAuditCount",
                           (SELECT COUNT(*)::integer
                              FROM "BillingEvent" event
                             WHERE event."tenantId" = tenant."id"
                               AND event."stripeEventId" = ${eventId}) AS "billingEventCount",
                           session."revokedAt" AS "sessionRevokedAt",
                           tenant."usageCredits" AS "usageCredits"
                    FROM "Tenant" tenant
                    JOIN "TenantSetting" setting
                      ON setting."tenantId" = tenant."id"
                     AND setting."key" = ${testLifecycleIntentSettingKeys[0]}
                    JOIN "User" account ON account."tenantId" = tenant."id"
                                      AND account."id" = ${userId}
                    JOIN "Session" session ON session."userId" = account."id"
                                          AND session."id" = ${sessionId}
                    WHERE tenant."id" = ${tenantId}
                `).resolves.toEqual([{
                    status: 'CANCELLED',
                    subscriptionId: null,
                    intentState: 'FINALIZED',
                    providerAction: 'already_canceled',
                    completedAuditCount: 1,
                    billingEventCount: 1,
                    sessionRevokedAt: null,
                    usageCredits: 100,
                }]);
            } finally {
                releaseMarkResolve?.();
                await cleanupCancellationProofTenants(owner, [tenantId], postgresCapability);
                await restrictedLifecycle.$disconnect();
                await restrictedWebhook.$disconnect();
                await owner.$disconnect();
            }
        }, 60_000);
    });
}
