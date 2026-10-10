import type { PersistentCancellationProvider } from '../billing/persistent-cancellation-provider';
import { consumePersistentCancellationRequestPermit, consumePersistentCancellationOperationPermit, consumePersistentCancellationFinalizationPermit, consumePersistentCancellationConvergencePermit, consumePersistentObservedCancellationPermit } from './persistent-export-consumer';
import { pilotProducersClosed, requireOrdinaryProducer } from '../common/pilot-producer-admission';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, TenantStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { MFA_MARKER_TTL_SCRIPT, observeMfaVerification, type MfaSessionIdentity, type MfaSessionObserver } from '@lunchlineup/rbac';
import Redis from 'ioredis';
import { RbacService } from '../auth/rbac.service';
import { recordAccountLifecycleRequest, projectAccountLifecycleRequest } from './account-lifecycle-request';
import { withCustomerLifecycleAdmission } from './customer-lifecycle-authority';
import { capturePlatformTenantActor, withPlatformTenantLifecycleAdmission } from './platform-tenant-lifecycle-authority';
import type {
    StripeService,
    TenantSubscriptionCancellationCompensationResult,
    TenantSubscriptionCancellationResult,
} from '../billing/stripe.service';
import type {
    TenantPrismaService,
    TenantPrismaTransaction,
} from '../database/tenant-prisma.service';
import {
    assertTenantSlugConfirmation,
    normalizeTenantConfirmation,
} from './tenant-account-lifecycle';
import type {
    TenantLifecycleActor,
    TenantPlatformArchiveActor,
} from './tenant-account-lifecycle.service';

export type TenantCancellationIntentKind =
    | 'CUSTOMER_CANCELLATION'
    | 'PLATFORM_ARCHIVE';

export type TenantCancellationOutcome = Pick<
    TenantSubscriptionCancellationResult,
    | 'action'
    | 'cancelAtPeriodEnd'
    | 'currentPeriodEnd'
    | 'cancelAt'
    | 'canceledAt'
    | 'cancellationBehavior'
>;

type TenantCancellationSubject = {
    id: string;
    slug: string;
    status: TenantStatus | string;
    deletedAt: Date | null;
    retentionLegalHoldAt: Date | null;
    stripeSubscriptionId: string | null;
};

type TenantCancellationIntentRow = {
    tenantId: string;
    kind: TenantCancellationIntentKind;
    operationId: string;
    state:
        | 'PENDING_PROVIDER'
        | 'PROVIDER_APPLIED'
        | 'COMPENSATION_PENDING'
        | 'FINALIZED'
        | 'BLOCKED'
        | 'SUPERSEDED';
    actorUserId: string;
    actorTenantId: string;
    ipAddress: string | null;
    userAgent: string | null;
    reason: string | null;
    providerSubscriptionId: string | null;
    subscriptionFingerprint: string;
    providerLeaseOwner: string | null;
    providerLeaseExpiresAt: Date | null;
    providerAttempts: number;
    providerMutationOwned: boolean | null;
    providerResult: unknown;
    compensationResult: unknown;
    terminalReason: string | null;
    terminalizedAt: Date | null;
};

const TENANT_LIFECYCLE_INTENT_SETTING_PREFIX =
    'internal:tenant-lifecycle-intent:';
const TENANT_LIFECYCLE_INTENT_SETTING_KEYS = [
    `${TENANT_LIFECYCLE_INTENT_SETTING_PREFIX}customer_cancellation`,
    `${TENANT_LIFECYCLE_INTENT_SETTING_PREFIX}platform_archive`,
] as const;
type SelectedCancellationProviderClaim = Readonly<{
    tenantId: string; operationId: string; customerId: string | null; subscriptionId: string | null;
    requestIntentSha256: string; providerIntentSha256: string; providerLeaseOwner: string;
    providerLeaseUntil: string; expires: number; providerExpires: number;
}>;

const DEFAULT_PROVIDER_LEASE_MS = 2 * 60 * 1000;
const MAX_RECOVERY_BATCH_SIZE = 100;

export type PreparedTenantCancellationIntent = {
    intent: TenantCancellationIntentRow;
    tenant: TenantCancellationSubject;
    providerLeaseOwner: string | null;
};

type TenantCancellationProviderAttempt = {
    outcome: TenantCancellationOutcome;
    providerMutationOwned: boolean;
};

type PrepareIntentInput = {
    tenantId: string;
    confirmation?: string;
    reason?: string | null;
} & (
    | { kind: 'CUSTOMER_CANCELLATION'; actor: TenantLifecycleActor }
    | { kind: 'PLATFORM_ARCHIVE'; actor: TenantPlatformArchiveActor }
);

export interface TenantCancellationIntentStore {
    prepare(input: PrepareIntentInput): Promise<PreparedTenantCancellationIntent>;
    markProviderApplied(
        prepared: PreparedTenantCancellationIntent,
        outcome: TenantCancellationOutcome,
        providerMutationOwned?: boolean,
    ): Promise<PreparedTenantCancellationIntent>;
    renewProviderClaim(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent>;
    providerLeaseRenewalIntervalMs(): number;
    markCompensated(
        prepared: PreparedTenantCancellationIntent,
        outcome: TenantCancellationCompensationOutcome,
    ): Promise<PreparedTenantCancellationIntent>;
    releaseProviderClaim(prepared: PreparedTenantCancellationIntent): Promise<void>;
    finalize(prepared: PreparedTenantCancellationIntent): Promise<PreparedTenantCancellationIntent>;
}

export type TenantCancellationCompensationOutcome = Pick<
    TenantSubscriptionCancellationCompensationResult,
    'action' | 'cancelAtPeriodEnd'
>;

export class PrismaTenantCancellationIntentStore implements TenantCancellationIntentStore {
    constructor(
        private readonly tenantDb: TenantPrismaService,
        private readonly providerLeaseMs = DEFAULT_PROVIDER_LEASE_MS,
        private readonly now: () => Date = () => new Date(),
        private readonly rbac?: RbacService,
        private readonly mfaObserver?: MfaSessionObserver,
        private readonly persistentProvider?: PersistentCancellationProvider,
    ) {}

    private readonly pilotClosed = pilotProducersClosed();
    private ownerUsed = false;
    private ownerClosed = false;
    private ownerUnknown = false;
    private ownerOperation?: Promise<boolean>;
    private ownerCallback?: Promise<boolean>;
    private ownerClose?: Promise<void>;
    private ownerMfaRedis?: Redis;
    private ownerMfaConnect?: Promise<void>;
    private ownerMfaRead?: Promise<unknown>;
    private ownerMfaUsed = false;
    private readonly ownerProviderAbort = new AbortController();
    private ownerProviderClaim?: SelectedCancellationProviderClaim;

    assertPersistentOwnerReady(): void {
        if (!this.pilotClosed || this.ownerUsed || this.ownerClosed) throw new Error('Cancellation request owner is not closed and unused.');
    }

    closeAdmission(): Promise<void> {
        this.ownerClosed = true;
        this.ownerProviderAbort.abort(new Error('Selected cancellation owner closed.'));
        this.ownerMfaRedis?.disconnect(false);
        if (this.ownerClose) return this.ownerClose;
        this.ownerClose = (async () => {
            try { await this.ownerOperation; } catch { this.ownerUnknown = true; }
            try { await this.ownerCallback; } catch { this.ownerUnknown = true; }
            if (this.ownerUnknown) throw new Error('Cancellation request requires independent reconciliation.');
        })();
        return this.ownerClose;
    }

    runPersistentOwnerCancellationRequest(permit: object): Promise<boolean> {
        const selected = consumePersistentCancellationRequestPermit(this, permit);
        this.assertPersistentOwnerReady();
        this.ownerUsed = true;
        const assertOpen = () => {
            if (this.ownerClosed || !this.pilotClosed || performance.now() >= selected.expires) {
                throw new Error('Original cancellation request admission closed.');
            }
        };
        const actor = Object.freeze({ tenantId: selected.tenantId, userId: selected.request.userId,
            sessionId: selected.request.sessionId, ipAddress: null, userAgent: null });
        this.ownerOperation = Promise.resolve().then(async () => {
            try {
                assertOpen();
                const result = await withCustomerLifecycleAdmission(this.tenantDb, this.rbac, {
                    observeSessionMfa: identity => this.observeSelectedMfa(identity, selected, assertOpen),
                }, actor,
                    (tx, assertAuthority) => {
                        const callback = Promise.resolve().then(async () => {
                            const current = () => { assertOpen(); assertAuthority(); };
                            current();
                            const tenant = await this.findTenantSubject(tx, selected.tenantId);
                            current();
                            assertTenantSlugConfirmation(selected.request.confirmation, tenant.slug);
                            this.assertNoLifecycleBarrier(tenant, 'CUSTOMER_CANCELLATION');
                            const existing = await this.findIntent(tx, selected.tenantId, 'CUSTOMER_CANCELLATION');
                            current();
                            // No reuse/reset/recovery or inference from an expired provider lease.
                            if (existing) throw new Error('Selected request recording requires no prior customer cancellation intent.');
                            const history = await tx.tenantSetting.findUnique({ where: { tenantId_key: {
                                tenantId: selected.tenantId, key: `internal:account-lifecycle-request:${selected.jobId}`,
                            } }, select: { id: true } });
                            current();
                            if (history) throw new Error('Selected lifecycle request identity already exists.');
                            const intent = await this.resetIntent(tx, {
                                kind: 'CUSTOMER_CANCELLATION', tenantId: selected.tenantId, actor,
                                confirmation: selected.request.confirmation, reason: selected.request.reason,
                                operationId: selected.jobId,
                                providerSubscriptionId: tenant.stripeSubscriptionId?.trim() || null,
                                subscriptionFingerprint: this.subscriptionFingerprint(tenant.id, tenant.stripeSubscriptionId),
                            }, current);
                            current();
                            const fenced = await tx.$executeRaw`
                                UPDATE "TenantSetting"
                                SET "selectedLifecycleIntentSha256" = ${selected.intentSha256},
                                    "selectedLifecycleOperationId" = ${selected.jobId}
                                WHERE "tenantId" = ${selected.tenantId}
                                    AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
                                    AND "value"->>'operationId' = ${selected.jobId}
                                    AND "value"->>'state' = 'PENDING_PROVIDER'
                                    AND "value"->>'providerAttempts' = '0'
                                    AND "value"->>'providerLeaseOwner' IS NULL
                                    AND "value"->>'providerLeaseExpiresAt' IS NULL
                                    AND "selectedLifecycleIntentSha256" IS NULL
                                    AND "selectedLifecycleOperationId" IS NULL
                            `;
                            current();
                            if (fenced !== 1 || intent.providerAttempts !== 0 || intent.providerLeaseOwner !== null) {
                                throw new Error('Selected request fence acknowledgement differs.');
                            }
                            await tx.auditLog.create({ data: {
                                tenantId: tenant.id, userId: actor.userId, actorUserId: actor.userId,
                                actorTenantId: tenant.id, action: 'TENANT_CANCELLATION_INTENT_RECORDED_BY_CUSTOMER',
                                resource: 'Tenant', resourceId: tenant.id,
                                newValue: { operationId: selected.jobId, state: 'PENDING_PROVIDER',
                                    ...(selected.request.reason ? { reason: selected.request.reason } : {}) },
                                ipAddress: null, userAgent: null,
                            } });
                            current();
                            return true;
                        });
                        this.ownerCallback = callback;
                        return callback;
                    });
                assertOpen();
                return result;
            } catch (error) {
                this.ownerClosed = true;
                this.ownerUnknown = true;
                throw error;
            } finally {
                // The canonical MFA helper bounds observation with a race; retain its
                // actual Redis command as well as the mutation callback through failure.
                this.ownerMfaRedis?.disconnect(false);
                try { if (this.ownerCallback) await this.ownerCallback; }
                finally {
                    try { if (this.ownerMfaConnect) await this.ownerMfaConnect; }
                    finally { if (this.ownerMfaRead) await this.ownerMfaRead; }
                }
            }
        });
        return this.ownerOperation;
    }

    persistentOwnerCancellationProvider(): PersistentCancellationProvider | undefined { return this.persistentProvider; }

    persistentCancellationProviderSelection(): SelectedCancellationProviderClaim {
        const claim = this.ownerProviderClaim;
        if (!claim) throw new Error('Committed selected cancellation claim required.');
        this.assertPersistentCancellationProviderOpen(claim);
        return claim;
    }

    persistentCancellationProviderSignal(): AbortSignal { return this.ownerProviderAbort.signal; }

    assertPersistentCancellationProviderOpen(claim: SelectedCancellationProviderClaim): void {
        this.assertCancellationOwnerOpen(claim.expires);
        if (claim !== this.ownerProviderClaim || this.ownerProviderAbort.signal.aborted
            || performance.now() >= claim.providerExpires) throw new Error('Original selected cancellation handoff window closed.');
    }

    private assertCancellationOwnerOpen(expires: number): void {
        if (!this.pilotClosed || !this.ownerUsed || this.ownerClosed || performance.now() >= expires) {
            throw new Error('Original selected cancellation owner closed.');
        }
    }

    private async readSelectedObservation(
        tx: TenantPrismaTransaction,
        selected: ReturnType<typeof consumePersistentObservedCancellationPermit>,
    ) {
        const guard = () => this.assertCancellationOwnerOpen(selected.expires);
        const digest = (value: unknown) => createHash('sha256').update(canonicalCancellationReceipt(value)).digest('hex');
        guard(); await this.lockTenantLifecycle(tx, selected.tenantId); guard();
        const billingLock = await tx.$queryRaw<Array<{ acquired: boolean }>>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${`billing-checkout:${selected.tenantId}`}, 0)) AS "acquired"
        `; guard();
        if (billingLock.length !== 1 || billingLock[0].acquired !== true) throw new Error('Observation settlement billing lock is busy.');
        const cursorLock = await tx.$queryRaw<Array<{ acquired: boolean }>>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${selected.subscriptionId}, 0)) AS "acquired"
        `; guard();
        if (cursorLock.length !== 1 || cursorLock[0].acquired !== true) throw new Error('Observation settlement subscription cursor is busy.');
        type Tenant = TenantCancellationSubject & { stripeCustomerId: string | null;
            stripeSubscriptionCurrentPeriodEnd: Date | null; selectedBillingRevision: number };
        type Setting = { original: Prisma.JsonValue; selectedLifecycleObservationFinalizationIntentSha256: string | null;
            selectedLifecycleObservationFinalizationReceipt: Prisma.JsonValue | null;
            selectedLifecycleObservationTerminalIntentSha256: string | null; selectedLifecycleObservationTerminalReceipt: Prisma.JsonValue | null };
        const tenants = await tx.$queryRaw<Tenant[]>`
            SELECT "id", "slug", "status", "deletedAt", "retentionLegalHoldAt", "stripeCustomerId",
                "stripeSubscriptionId", "stripeSubscriptionCurrentPeriodEnd", "selectedBillingRevision"
            FROM "Tenant" WHERE "id" = ${selected.tenantId} FOR UPDATE NOWAIT
        `; guard();
        const settings = await tx.$queryRaw<Setting[]>`
            SELECT jsonb_build_object('value', "value", 'requestIntentSha256', "selectedLifecycleIntentSha256",
                'operationId', "selectedLifecycleOperationId", 'providerIntentSha256', "selectedLifecycleProviderIntentSha256",
                'customerId', "selectedLifecycleProviderCustomerId",
                'providerLeaseUntil', to_char("selectedLifecycleProviderLeaseUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'providerReceipt', "selectedLifecycleProviderReceipt", 'providerBillingRevision', "selectedLifecycleProviderBillingRevision",
                'finalizationReceipt', "selectedLifecycleFinalizationReceipt", 'terminalReceipt', "selectedLifecycleTerminalReceipt") AS "original",
                "selectedLifecycleObservationFinalizationIntentSha256", "selectedLifecycleObservationFinalizationReceipt",
                "selectedLifecycleObservationTerminalIntentSha256", "selectedLifecycleObservationTerminalReceipt"
            FROM "TenantSetting" WHERE "tenantId" = ${selected.tenantId}
                AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation' FOR UPDATE NOWAIT
        `; guard();
        const tenant = tenants[0]; const row = settings[0];
        if (tenants.length !== 1 || !tenant || settings.length !== 1 || !row) throw new Error('Original observation settlement rows are absent.');
        const original = cancellationObject(row.original);
        if (original.requestIntentSha256 !== selected.predecessorIntentSha256 || original.operationId !== selected.jobId
            || original.providerIntentSha256 !== selected.providerIntentSha256 || original.customerId !== selected.customerId
            || (original.providerReceipt === null ? null : digest(original.providerReceipt)) !== selected.priorReceiptSha256
            || (original.finalizationReceipt === null ? null : digest(original.finalizationReceipt)) !== selected.predecessorFinalizationSha256
            || original.terminalReceipt !== null) throw new Error('Original provider/local receipt custody differs; completed terminal chain is separate.');
        const intent = parseIntentSetting(original.value as Prisma.JsonValue);
        if (intent.tenantId !== selected.tenantId || intent.kind !== 'CUSTOMER_CANCELLATION' || intent.operationId !== selected.jobId
            || intent.providerSubscriptionId !== selected.subscriptionId || intent.providerAttempts !== 1
            || !intent.providerLeaseOwner || !intent.providerLeaseExpiresAt || intent.compensationResult !== null) {
            throw new Error('Exact original consumed cancellation intent required.');
        }
        const histories = await tx.$queryRaw<Array<{ value: Prisma.JsonValue }>>`
            SELECT "value" FROM "TenantSetting" WHERE "tenantId" = ${selected.tenantId}
                AND "key" = ${`internal:account-lifecycle-request:${selected.jobId}`} FOR UPDATE NOWAIT
        `; guard();
        const history = projectAccountLifecycleRequest(histories[0]?.value);
        if (histories.length !== 1 || !history || history.requestId !== selected.jobId || history.kind !== 'CANCELLATION') {
            throw new Error('Original cancellation history is absent; never recreate its timestamp.');
        }
        const observations = await tx.$queryRaw<Array<{ id: string; operationId: string; requestIntentSha256: string;
            providerIntentSha256: string; observationIntentSha256: string; customerId: string; subscriptionId: string;
            priorReceiptSha256: string | null; original: Prisma.JsonValue; receipt: Prisma.JsonValue | null;
            billingRevision: number | null; attempts: number; completedAt: Date | null }>>`
            SELECT "id", "operationId", "requestIntentSha256", "providerIntentSha256", "observationIntentSha256", "customerId",
                "subscriptionId", "priorReceiptSha256", "original", "receipt", "billingRevision", "attempts", "completedAt"
            FROM "TenantCancellationObservation" WHERE "id" = ${selected.observationId} AND "tenantId" = ${selected.tenantId} FOR UPDATE NOWAIT
        `; guard();
        const observation = observations[0];
        if (observations.length !== 1 || !observation || observation.receipt === null || observation.completedAt === null
            || observation.attempts !== 1 || observation.billingRevision === null
            || observation.operationId !== selected.jobId || observation.requestIntentSha256 !== selected.predecessorIntentSha256
            || observation.providerIntentSha256 !== selected.providerIntentSha256 || observation.observationIntentSha256 !== selected.observationIntentSha256
            || observation.customerId !== selected.customerId || observation.subscriptionId !== selected.subscriptionId
            || observation.priorReceiptSha256 !== selected.priorReceiptSha256 || digest(observation.receipt) !== selected.observationReceiptSha256) {
            throw new Error('Exact completed observation receipt is unavailable.');
        }
        const receipt = cancellationObject(observation.receipt); const provider = cancellationObject(receipt.provider);
        const providerOutcome = cancellationObject(provider.outcome); const snapshot = cancellationObject(receipt.snapshot);
        const processFence = cancellationObject(receipt.processFence);
        if (receipt.version !== 1 || receipt.tenantId !== selected.tenantId || receipt.operationId !== selected.jobId
            || receipt.observationId !== selected.observationId || receipt.observationIntentSha256 !== selected.observationIntentSha256
            || receipt.requestIntentSha256 !== selected.predecessorIntentSha256 || receipt.providerIntentSha256 !== selected.providerIntentSha256
            || receipt.priorReceiptSha256 !== selected.priorReceiptSha256 || receipt.originalSha256 !== digest(observation.original)
            || receipt.backendSettlementProved !== false || receipt.retryAllowed !== false
            || processFence.applicationProcessSettled !== true || processFence.backendSettlementProved !== false || processFence.retryAllowed !== false
            || provider.tenantId !== selected.tenantId || provider.operationId !== selected.jobId || provider.customerId !== selected.customerId
            || provider.disposition !== 'OBSERVED_OWNED_CANCELLATION' || provider.backendSettlementProved !== false || provider.retryAllowed !== false
            || typeof provider.providerRequestId !== 'string' || provider.providerRequestId.length < 1 || provider.providerRequestId.length > 255
            || providerOutcome.stripeSubscriptionId !== selected.subscriptionId || providerOutcome.providerMutationOwned !== true
            || providerOutcome.cancellationBehavior !== 'cancel_at_period_end'
            || !Number.isSafeInteger(snapshot.billingRevision) || snapshot.billingRevision !== observation.billingRevision) {
            throw new Error('Positive operation-owned observation correspondence required; unknown POST remains unknown.');
        }
        const outcome = parseCancellationOutcome(providerOutcome);
        if (!['already_scheduled', 'already_canceled'].includes(outcome.action)
            || (outcome.action === 'already_canceled' ? providerOutcome.stripeStatus !== 'canceled'
                : providerOutcome.stripeStatus === 'canceled' || !outcome.cancelAtPeriodEnd || !outcome.currentPeriodEnd)) {
            throw new Error('Scheduled/terminal observation required.');
        }
        for (const value of [outcome.currentPeriodEnd, outcome.cancelAt, outcome.canceledAt]) {
            if (value !== null && (!Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString() !== value)) {
                throw new Error('Canonical observation timestamps required.');
            }
        }
        return { tenant, row, original, intent, history, observation, receipt, snapshot, outcome };
    }

    private async readObservedTerminalApplication(
        tx: TenantPrismaTransaction, selected: ReturnType<typeof consumePersistentObservedCancellationPermit>,
        tenant: TenantCancellationSubject & { stripeCustomerId: string | null; stripeSubscriptionCurrentPeriodEnd: Date | null; selectedBillingRevision: number },
        predecessorBillingRevision: number,
    ) {
        const guard = () => this.assertCancellationOwnerOpen(selected.expires);
        const digest = (value: unknown) => createHash('sha256').update(canonicalCancellationReceipt(value)).digest('hex');
        if (typeof selected.terminalEventId !== 'string' || typeof selected.terminalEventSha256 !== 'string'
            || tenant.status !== 'CANCELLED' || tenant.deletedAt !== null || tenant.stripeCustomerId !== selected.customerId
            || tenant.stripeSubscriptionId !== null || tenant.stripeSubscriptionCurrentPeriodEnd !== null) {
            throw new Error('Exact observed terminal application identity/projection required.');
        }
        // Lock the parent event before its invalidatable application receipt; both refuse contention.
        const events = await tx.$queryRaw<Array<{ id: string; stripeEventId: string | null; type: string; metadata: Prisma.JsonValue | null }>>`
            SELECT "id", "stripeEventId", "type", "metadata" FROM "BillingEvent"
            WHERE "id" = ${selected.terminalEventId} AND "tenantId" = ${selected.tenantId} FOR UPDATE NOWAIT
        `; guard();
        const applications = await tx.$queryRaw<Array<{ eventId: string; tenantId: string; receipt: Prisma.JsonValue }>>`
            SELECT "eventId", "tenantId", "receipt" FROM "TenantCancellationTerminalEvent"
            WHERE "eventId" = ${selected.terminalEventId} AND "tenantId" = ${selected.tenantId} FOR UPDATE NOWAIT
        `; guard();
        const event = events[0]; const application = applications[0];
        if (events.length !== 1 || !event || applications.length !== 1 || !application
            || event.type !== 'customer.subscription.deleted' || !event.stripeEventId
            || digest(application) !== selected.terminalEventSha256) throw new Error('Exact authenticated application receipt is unavailable.');
        const proof = cancellationObject(application.receipt);
        const post = cancellationObject(proof.postState);
        const metadata = cancellationObject(event.metadata);
        if (proof.version !== 1 || proof.provenance !== 'verified-stripe-terminal-webhook-v1'
            || proof.providerEventId !== event.stripeEventId || proof.tenantId !== selected.tenantId
            || proof.operationId !== selected.jobId || proof.customerId !== selected.customerId
            || proof.subscriptionId !== selected.subscriptionId || proof.livemode !== false || proof.accountMode !== 'direct'
            || proof.apiVersion !== '2024-04-10' || !Number.isSafeInteger(proof.providerEventCreated) || Number(proof.providerEventCreated) <= 0
            || typeof proof.endpointId !== 'string' || !/^we_[A-Za-z0-9]{1,251}$/.test(proof.endpointId)
            || typeof proof.accountId !== 'string' || !/^acct_[A-Za-z0-9]{1,249}$/.test(proof.accountId)
            || !['rawBodySha256', 'signatureSha256', 'webhookKeySha256'].every(key => typeof proof[key] === 'string' && /^[a-f0-9]{64}$/.test(proof[key] as string))
            || metadata.sideEffectDisposition !== 'applied' || metadata.cancellationOperationId !== selected.jobId
            || metadata.subscriptionId !== selected.subscriptionId || metadata.customerId !== selected.customerId
            || metadata.stripeEventLivemode !== false || metadata.status !== 'canceled'
            || post.status !== 'CANCELLED' || post.deletedAt !== null || post.customerId !== selected.customerId
            || post.subscriptionId !== null || post.currentPeriodEnd !== null
            || !Number.isSafeInteger(post.billingRevision) || post.billingRevision !== tenant.selectedBillingRevision
            || Number(post.billingRevision) <= predecessorBillingRevision) {
            throw new Error('Authenticated post-effect chronology/resources differ or later history intervened.');
        }
        const outcome = parseCancellationOutcome(proof.outcome);
        if (outcome.action !== 'already_canceled') throw new Error('Terminal application outcome required.');
        for (const value of [outcome.currentPeriodEnd, outcome.cancelAt, outcome.canceledAt]) {
            if (value !== null && (!Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString() !== value)) {
                throw new Error('Canonical terminal application timestamp required.');
            }
        }
        return application;
    }

    runPersistentOwnerObservedCancellation(permit: object): Promise<boolean> {
        const selected = consumePersistentObservedCancellationPermit(this, permit);
        this.assertPersistentOwnerReady(); this.ownerUsed = true;
        this.ownerOperation = Promise.resolve().then(() => this.settleSelectedObservation(selected))
            .catch(error => { this.ownerUnknown = true; throw error; });
        return this.ownerOperation;
    }

    private async settleSelectedObservation(selected: ReturnType<typeof consumePersistentObservedCancellationPermit>): Promise<boolean> {
        const guard = () => this.assertCancellationOwnerOpen(selected.expires);
        const digest = (value: unknown) => createHash('sha256').update(canonicalCancellationReceipt(value)).digest('hex');
        const same = (a: unknown, b: unknown) => canonicalCancellationReceipt(a) === canonicalCancellationReceipt(b);
        const isTerminalEvent = selected.effect === 'converge-exact-observed-cancellation';
        const matchesReceipt = (value: Record<string, unknown>) => value.version === 1 && value.tenantId === selected.tenantId
            && value.operationId === selected.jobId && value.requestIntentSha256 === selected.predecessorIntentSha256
            && value.providerIntentSha256 === selected.providerIntentSha256 && value.priorReceiptSha256 === selected.priorReceiptSha256
            && value.predecessorFinalizationSha256 === selected.predecessorFinalizationSha256
            && value.observationId === selected.observationId && value.observationIntentSha256 === selected.observationIntentSha256
            && value.observationReceiptSha256 === selected.observationReceiptSha256 && value.state === 'FINALIZED'
            && value.backendSettlementProved === false && value.retryAllowed === false;
        try {
            guard();
            const result = await this.tenantDb.withTenant(selected.tenantId, tx => {
                this.ownerCallback = Promise.resolve().then(async () => {
                    const context = await this.readSelectedObservation(tx, selected); guard();
                    const { tenant, row, original, intent, history, observation, snapshot } = context;
                    const prior = row.selectedLifecycleObservationFinalizationReceipt === null ? null
                        : cancellationObject(row.selectedLifecycleObservationFinalizationReceipt);
                    const priorTerminal = row.selectedLifecycleObservationTerminalReceipt === null ? null
                        : cancellationObject(row.selectedLifecycleObservationTerminalReceipt);
                    // Exact completion replay precedes all current billing/snapshot comparisons.
                    if (prior) {
                        if (!row.selectedLifecycleObservationFinalizationIntentSha256 || !matchesReceipt(prior)
                            || prior.source !== 'provider-observation' || intent.state !== 'FINALIZED' || history.state !== 'COMPLETED'
                            || intent.providerMutationOwned !== true) throw new Error('Prior observation completion differs.');
                        if (priorTerminal) {
                            if (!row.selectedLifecycleObservationTerminalIntentSha256 || !matchesReceipt(priorTerminal)
                                || priorTerminal.source !== 'verified-terminal-event'
                                || priorTerminal.observationFinalizationSha256 !== digest(prior)
                                || typeof priorTerminal.applicationReceiptSha256 !== 'string'
                                || digest(priorTerminal.applicationReceipt) !== priorTerminal.applicationReceiptSha256
                                || !same(priorTerminal.outcome, cancellationObject(cancellationObject(priorTerminal.applicationReceipt).receipt).outcome)
                                || !same(priorTerminal.outcome, intent.providerResult)) throw new Error('Prior observed terminal chain differs.');
                        } else if (!same(prior.outcome, intent.providerResult)) throw new Error('Prior observation projection differs.');
                        if (!isTerminalEvent) {
                            if (parseCancellationOutcome(prior.outcome).action !== selected.expectedAction) throw new Error('Prior observation action differs.');
                            return true;
                        }
                        if (digest(prior) !== selected.observationFinalizationSha256) throw new Error('Exact observation-finalization predecessor differs.');
                        if (priorTerminal) {
                            if (priorTerminal.eventId !== selected.terminalEventId || priorTerminal.applicationReceiptSha256 !== selected.terminalEventSha256
                                || parseCancellationOutcome(priorTerminal.outcome).action !== 'already_canceled') throw new Error('Recorded observed terminal event differs.');
                            return true;
                        }
                    } else if (isTerminalEvent || row.selectedLifecycleObservationFinalizationIntentSha256 !== null
                        || priorTerminal !== null || row.selectedLifecycleObservationTerminalIntentSha256 !== null) {
                        throw new Error('Exact observation completion predecessor is required.');
                    }
                    this.assertNoLifecycleBarrier(tenant, 'CUSTOMER_CANCELLATION');
                    if (tenant.deletedAt !== null || tenant.stripeCustomerId !== selected.customerId) throw new Error('Current observed customer binding changed.');
                    const platform = await tx.tenantSetting.findUnique({ where: { tenantId_key: {
                        tenantId: selected.tenantId, key: this.intentSettingKey('PLATFORM_ARCHIVE') } }, select: { id: true } }); guard();
                    if (platform) throw new Error('Platform observation settlement needs separate authority.');
                    let outcome = context.outcome;
                    let application: { eventId: string; tenantId: string; receipt: Prisma.JsonValue } | undefined;
                    if (isTerminalEvent) {
                        if (!prior || parseCancellationOutcome(prior.outcome).action !== 'already_scheduled'
                            || context.outcome.action !== 'already_scheduled' || row.selectedLifecycleObservationTerminalIntentSha256 !== null
                            || !Number.isSafeInteger(prior.billingRevisionAfter)
                            || !same({ ...original, value: cancellationObject(observation.original).value }, observation.original)) {
                            throw new Error('Exact observation-finalized scheduled predecessor required.');
                        }
                        const originalValue = cancellationObject(cancellationObject(observation.original).value);
                        const currentValue = cancellationObject(original.value);
                        const stable = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
                            .filter(([key]) => !['state', 'providerResult', 'providerMutationOwned'].includes(key)));
                        if (!same(stable(originalValue), stable(currentValue))) throw new Error('Original observation intent custody changed.');
                        application = await this.readObservedTerminalApplication(tx, selected, tenant, Number(prior.billingRevisionAfter)); guard();
                        outcome = parseCancellationOutcome(cancellationObject(application.receipt).outcome);
                    } else {
                        if (!same(original, observation.original) || outcome.action !== selected.expectedAction
                            || (original.finalizationReceipt === null
                                ? intent.state !== 'PENDING_PROVIDER' || history.state !== 'PENDING' || intent.providerResult !== null
                                : intent.state !== 'FINALIZED' || history.state !== 'COMPLETED'
                                    || !['scheduled', 'already_scheduled'].includes(parseCancellationOutcome(intent.providerResult).action))
                            || tenant.selectedBillingRevision !== observation.billingRevision
                            || !same(snapshot, { status: tenant.status, customerId: tenant.stripeCustomerId,
                                subscriptionId: tenant.stripeSubscriptionId,
                                currentPeriodEnd: tenant.stripeSubscriptionCurrentPeriodEnd?.toISOString() ?? null,
                                billingRevision: tenant.selectedBillingRevision })) {
                            throw new Error('Observation snapshot or original completion advanced; no stale settlement.');
                        }
                        if (outcome.action === 'already_scheduled'
                            ? tenant.status === 'CANCELLED' || tenant.stripeSubscriptionId !== selected.subscriptionId
                            : !(tenant.stripeSubscriptionId === selected.subscriptionId || (tenant.status === 'CANCELLED'
                                && tenant.stripeSubscriptionId === null && tenant.stripeSubscriptionCurrentPeriodEnd === null))) {
                            throw new Error('Observation cannot replace, resurrect or clear another subscription.');
                        }
                    }
                    const terminal = outcome.action === 'already_canceled';
                    const paidThrough = terminal ? null : new Date(outcome.currentPeriodEnd!);
                    if (!terminal && (!paidThrough || !Number.isFinite(paidThrough.getTime())
                        || (tenant.stripeSubscriptionCurrentPeriodEnd && paidThrough < tenant.stripeSubscriptionCurrentPeriodEnd))) {
                        throw new Error('Observed paid-through cannot shorten a newer local boundary.');
                    }
                    const changesBilling = !isTerminalEvent && (terminal
                        ? tenant.status !== 'CANCELLED' || tenant.stripeSubscriptionId !== null || tenant.stripeSubscriptionCurrentPeriodEnd !== null
                        : tenant.stripeSubscriptionCurrentPeriodEnd?.getTime() !== paidThrough!.getTime());
                    if (intent.actorTenantId === tenant.id) {
                        const actors = await tx.$queryRaw<Array<{ id: string }>>`
                            SELECT "id" FROM "User" WHERE "id" = ${intent.actorUserId} AND "tenantId" = ${tenant.id} FOR KEY SHARE NOWAIT
                        `; guard();
                        if (actors.length !== 1) throw new Error('Original reconciliation audit actor is unavailable.');
                    }
                    if (terminal && changesBilling) {
                        await tx.$queryRaw`
                            WITH locked AS (SELECT "id" FROM "StaffInvitationOutbox" WHERE "tenantId" = ${tenant.id}
                                ORDER BY "id" FOR UPDATE NOWAIT) SELECT count(*) FROM locked
                        `; guard();
                    }
                    const localReceipt = { version: 1, tenantId: selected.tenantId, operationId: selected.jobId,
                        requestIntentSha256: selected.predecessorIntentSha256, providerIntentSha256: selected.providerIntentSha256,
                        priorReceiptSha256: selected.priorReceiptSha256, predecessorFinalizationSha256: selected.predecessorFinalizationSha256,
                        observationId: selected.observationId, observationIntentSha256: selected.observationIntentSha256,
                        observationReceiptSha256: selected.observationReceiptSha256,
                        source: isTerminalEvent ? 'verified-terminal-event' : 'provider-observation',
                        ...(isTerminalEvent ? { observationFinalizationSha256: selected.observationFinalizationSha256,
                            eventId: selected.terminalEventId, applicationReceiptSha256: selected.terminalEventSha256,
                            applicationReceipt: application } : {}),
                        outcome, state: 'FINALIZED', observationBillingRevision: observation.billingRevision,
                        postState: { status: terminal ? 'CANCELLED' : tenant.status, deletedAt: null, customerId: selected.customerId,
                            subscriptionId: terminal ? null : selected.subscriptionId, currentPeriodEnd: paidThrough?.toISOString() ?? null,
                            billingRevision: tenant.selectedBillingRevision + (changesBilling ? 1 : 0) },
                        billingRevisionBefore: tenant.selectedBillingRevision,
                        billingRevisionAfter: tenant.selectedBillingRevision + (changesBilling ? 1 : 0),
                        backendSettlementProved: false, retryAllowed: false };
                    const finalized: TenantCancellationIntentRow = { ...intent, state: 'FINALIZED', providerResult: outcome, providerMutationOwned: true };
                    // Only fixed source-selected identifiers enter this fragment; no caller SQL.
                    const intentColumn = Prisma.raw(isTerminalEvent ? '"selectedLifecycleObservationTerminalIntentSha256"' : '"selectedLifecycleObservationFinalizationIntentSha256"');
                    const receiptColumn = Prisma.raw(isTerminalEvent ? '"selectedLifecycleObservationTerminalReceipt"' : '"selectedLifecycleObservationFinalizationReceipt"');
                    const changed = await tx.$executeRaw`
                        UPDATE "TenantSetting" SET "value" = CAST(${JSON.stringify(serializeIntentSetting(finalized))} AS jsonb),
                            ${intentColumn} = ${selected.intentSha256}, ${receiptColumn} = CAST(${JSON.stringify(localReceipt)} AS jsonb), "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "tenantId" = ${selected.tenantId} AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
                            AND "selectedLifecycleIntentSha256" = ${selected.predecessorIntentSha256}
                            AND "selectedLifecycleOperationId" = ${selected.jobId} AND "selectedLifecycleProviderIntentSha256" = ${selected.providerIntentSha256}
                            AND "value" = CAST(${JSON.stringify(original.value)} AS jsonb) AND ${intentColumn} IS NULL AND ${receiptColumn} IS NULL
                    `; guard();
                    if (changed !== 1) throw new Error('Exact observation local receipt was not recorded.');
                    if (changesBilling) {
                        const changedTenant = await tx.tenant.updateMany({ where: { id: selected.tenantId,
                            selectedBillingRevision: tenant.selectedBillingRevision, stripeCustomerId: selected.customerId,
                            stripeSubscriptionId: tenant.stripeSubscriptionId, deletedAt: null },
                            data: terminal ? { status: TenantStatus.CANCELLED, stripeSubscriptionId: null, stripeSubscriptionCurrentPeriodEnd: null }
                                : { stripeSubscriptionCurrentPeriodEnd: paidThrough } }); guard();
                        if (changedTenant.count !== 1) throw new Error('Exact observed billing transition was not recorded.');
                    }
                    const billing = await tx.tenant.findUnique({ where: { id: selected.tenantId }, select: {
                        status: true, deletedAt: true, stripeCustomerId: true, stripeSubscriptionId: true,
                        stripeSubscriptionCurrentPeriodEnd: true, selectedBillingRevision: true } }); guard();
                    if (!billing || !same(localReceipt.postState, { status: billing.status, deletedAt: billing.deletedAt,
                            customerId: billing.stripeCustomerId, subscriptionId: billing.stripeSubscriptionId,
                            currentPeriodEnd: billing.stripeSubscriptionCurrentPeriodEnd?.toISOString() ?? null,
                            billingRevision: billing.selectedBillingRevision })
                        || billing.deletedAt !== null || billing.stripeCustomerId !== selected.customerId
                        || billing.status !== (terminal ? 'CANCELLED' : tenant.status)
                        || billing.stripeSubscriptionId !== (terminal ? null : selected.subscriptionId)
                        || billing.selectedBillingRevision !== localReceipt.billingRevisionAfter
                        || (billing.stripeSubscriptionCurrentPeriodEnd?.getTime() ?? null) !== (paidThrough?.getTime() ?? null)) {
                        throw new Error('Atomic observation billing readback differs.');
                    }
                    await tx.auditLog.create({ data: { tenantId: tenant.id,
                        userId: intent.actorTenantId === tenant.id ? intent.actorUserId : null,
                        actorUserId: intent.actorUserId, actorTenantId: intent.actorTenantId,
                        action: 'TENANT_CANCELLATION_RECONCILED_BY_CUSTOMER', resource: 'Tenant', resourceId: tenant.id,
                        newValue: { operationId: intent.operationId, observationId: selected.observationId,
                            source: localReceipt.source, billingCancellation: outcome, backendSettlementProved: false, retryAllowed: false,
                            ...(intent.reason ? { reason: intent.reason } : {}) }, ipAddress: intent.ipAddress, userAgent: intent.userAgent } }); guard();
                    await recordAccountLifecycleRequest(tx, { tenantId: selected.tenantId, requestId: selected.jobId,
                        kind: 'CANCELLATION', state: 'COMPLETED' }, guard); guard();
                    const readback = await tx.$queryRaw<Array<{ value: Prisma.JsonValue; intentSha256: string; receipt: Prisma.JsonValue }>>`
                        SELECT "value", ${intentColumn} AS "intentSha256", ${receiptColumn} AS "receipt"
                        FROM "TenantSetting" WHERE "tenantId" = ${selected.tenantId} AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
                    `; guard();
                    if (readback.length !== 1 || readback[0].intentSha256 !== selected.intentSha256 || !same(readback[0].receipt, localReceipt)
                        || !same(readback[0].value, serializeIntentSetting(finalized))) throw new Error('Exact observed local completion readback differs.');
                    return true;
                });
                return this.ownerCallback;
            }, { maxWait: 5000, timeout: 60000 }); guard(); return result;
        } catch (error) { this.ownerClosed = true; this.ownerUnknown = true; throw error; }
        finally { if (this.ownerCallback) await this.ownerCallback; }
    }

    runPersistentOwnerCancellationConvergence(permit: object): Promise<boolean> {
        const selected = consumePersistentCancellationConvergencePermit(this, permit);
        this.assertPersistentOwnerReady(); this.ownerUsed = true;
        this.ownerOperation = Promise.resolve().then(() => this.convergeSelectedTerminalEvent(selected))
            .catch(error => { this.ownerUnknown = true; throw error; });
        return this.ownerOperation;
    }

    private async convergeSelectedTerminalEvent(selected: ReturnType<typeof consumePersistentCancellationConvergencePermit>): Promise<boolean> {
        const guard = () => this.assertCancellationOwnerOpen(selected.expires);
        const digest = (value: unknown) => createHash('sha256').update(canonicalCancellationReceipt(value)).digest('hex');
        type Tenant = TenantCancellationSubject & { stripeCustomerId: string | null;
            stripeSubscriptionCurrentPeriodEnd: Date | null; selectedBillingRevision: number };
        type Setting = { value: Prisma.JsonValue; selectedLifecycleIntentSha256: string | null;
            selectedLifecycleOperationId: string | null; selectedLifecycleProviderIntentSha256: string | null;
            selectedLifecycleProviderCustomerId: string | null; selectedLifecycleProviderReceipt: Prisma.JsonValue | null;
            selectedLifecycleProviderBillingRevision: number | null; selectedLifecycleFinalizationReceipt: Prisma.JsonValue | null;
            selectedLifecycleTerminalIntentSha256: string | null; selectedLifecycleTerminalReceipt: Prisma.JsonValue | null };
        try {
            guard();
            const result = await this.tenantDb.withTenant(selected.tenantId, tx => {
                this.ownerCallback = Promise.resolve().then(async () => {
                    guard(); await this.lockTenantLifecycle(tx, selected.tenantId); guard();
                    const billingLock = await tx.$queryRaw<Array<{ acquired: boolean }>>`
                        SELECT pg_try_advisory_xact_lock(hashtextextended(${`billing-checkout:${selected.tenantId}`}, 0)) AS "acquired"
                    `; guard();
                    if (billingLock.length !== 1 || billingLock[0]?.acquired !== true) throw new Error('Terminal billing lock is busy.');
                    const subscriptionLock = await tx.$queryRaw<Array<{ acquired: boolean }>>`
                        SELECT pg_try_advisory_xact_lock(hashtextextended(${selected.subscriptionId}, 0)) AS "acquired"
                    `; guard();
                    if (subscriptionLock.length !== 1 || subscriptionLock[0]?.acquired !== true) throw new Error('Terminal subscription cursor is busy.');
                    const tenants = await tx.$queryRaw<Tenant[]>`
                        SELECT "id", "slug", "status", "deletedAt", "retentionLegalHoldAt", "stripeCustomerId",
                            "stripeSubscriptionId", "stripeSubscriptionCurrentPeriodEnd", "selectedBillingRevision"
                        FROM "Tenant" WHERE "id" = ${selected.tenantId} FOR UPDATE NOWAIT
                    `; guard();
                    const rows = await tx.$queryRaw<Setting[]>`
                        SELECT "value", "selectedLifecycleIntentSha256", "selectedLifecycleOperationId",
                            "selectedLifecycleProviderIntentSha256", "selectedLifecycleProviderCustomerId", "selectedLifecycleProviderReceipt",
                            "selectedLifecycleProviderBillingRevision", "selectedLifecycleFinalizationReceipt",
                            "selectedLifecycleTerminalIntentSha256", "selectedLifecycleTerminalReceipt"
                        FROM "TenantSetting" WHERE "tenantId" = ${selected.tenantId}
                            AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation' FOR UPDATE NOWAIT
                    `; guard();
                    const tenant = tenants[0]; const row = rows[0];
                    if (tenants.length !== 1 || !tenant || rows.length !== 1 || !row
                        || row.selectedLifecycleIntentSha256 !== selected.predecessorIntentSha256
                        || row.selectedLifecycleOperationId !== selected.jobId
                        || row.selectedLifecycleProviderIntentSha256 !== selected.providerIntentSha256
                        || row.selectedLifecycleProviderCustomerId !== selected.customerId
                        || !row.selectedLifecycleProviderReceipt || digest(row.selectedLifecycleProviderReceipt) !== selected.receiptSha256
                        || (row.selectedLifecycleFinalizationReceipt === null ? null : digest(row.selectedLifecycleFinalizationReceipt)) !== selected.predecessorFinalizationSha256) {
                        throw new Error('Exact original cancellation/provider/local receipts differ.');
                    }
                    const intent = parseIntentSetting(row.value);
                    const originalReceipt = cancellationObject(row.selectedLifecycleProviderReceipt);
                    const originalOutcome = cancellationObject(originalReceipt.outcome);
                    if (intent.tenantId !== selected.tenantId || intent.kind !== 'CUSTOMER_CANCELLATION'
                        || intent.operationId !== selected.jobId || intent.providerSubscriptionId !== selected.subscriptionId
                        || intent.providerAttempts !== 1 || originalReceipt.tenantId !== selected.tenantId
                        || originalReceipt.operationId !== selected.jobId || originalReceipt.customerId !== selected.customerId
                        || originalOutcome.stripeSubscriptionId !== selected.subscriptionId || originalOutcome.providerMutationOwned !== true
                        || !['scheduled', 'already_scheduled'].includes(String(originalOutcome.action)) || originalOutcome.cancelAtPeriodEnd !== true) {
                        throw new Error('Original operation-owned scheduled cancellation is required.');
                    }
                    const historyRows = await tx.$queryRaw<Array<{ value: Prisma.JsonValue }>>`
                        SELECT "value" FROM "TenantSetting" WHERE "tenantId" = ${selected.tenantId}
                            AND "key" = ${`internal:account-lifecycle-request:${selected.jobId}`} FOR UPDATE NOWAIT
                    `; guard();
                    const history = projectAccountLifecycleRequest(historyRows[0]?.value);
                    if (historyRows.length !== 1 || !history || history.requestId !== selected.jobId || history.kind !== 'CANCELLATION') {
                        throw new Error('Original cancellation history is missing.');
                    }
                    if (row.selectedLifecycleTerminalReceipt !== null) {
                        const prior = cancellationObject(row.selectedLifecycleTerminalReceipt);
                        if (!row.selectedLifecycleTerminalIntentSha256 || intent.state !== 'FINALIZED' || history.state !== 'COMPLETED'
                            || prior.tenantId !== selected.tenantId || prior.operationId !== selected.jobId
                            || prior.requestIntentSha256 !== selected.predecessorIntentSha256 || prior.providerIntentSha256 !== selected.providerIntentSha256
                            || prior.providerReceiptSha256 !== selected.receiptSha256 || prior.eventId !== selected.terminalEventId
                            || prior.applicationReceiptSha256 !== selected.terminalEventSha256
                            || prior.predecessorFinalizationSha256 !== selected.predecessorFinalizationSha256
                            || canonicalCancellationReceipt(intent.providerResult) !== canonicalCancellationReceipt(prior.outcome)) {
                            throw new Error('Recorded terminal convergence differs.');
                        }
                        return true;
                    }
                    if (row.selectedLifecycleTerminalIntentSha256 !== null
                        || (selected.predecessorFinalizationSha256 === null
                            ? intent.state !== 'PENDING_PROVIDER' || history.state !== 'PENDING' || intent.providerResult !== null
                            : intent.state !== 'FINALIZED' || history.state !== 'COMPLETED'
                                || canonicalCancellationReceipt(intent.providerResult) !== canonicalCancellationReceipt(parseCancellationOutcome(originalOutcome)))) {
                        throw new Error('Explicit local predecessor state differs.');
                    }
                    this.assertNoLifecycleBarrier(tenant, 'CUSTOMER_CANCELLATION');
                    if (tenant.status !== 'CANCELLED' || tenant.deletedAt !== null || tenant.stripeCustomerId !== selected.customerId
                        || tenant.stripeSubscriptionId !== null || tenant.stripeSubscriptionCurrentPeriodEnd !== null) {
                        throw new Error('Current exact terminal tenant projection is unavailable.');
                    }
                    const platform = await tx.tenantSetting.findUnique({ where: { tenantId_key: {
                        tenantId: selected.tenantId, key: this.intentSettingKey('PLATFORM_ARCHIVE') } }, select: { id: true } }); guard();
                    if (platform) throw new Error('Platform reconciliation requires distinct authority.');
                    // Lock the parent event before its invalidatable application receipt; both refuse contention.
                    const events = await tx.$queryRaw<Array<{ id: string; stripeEventId: string | null; type: string; metadata: Prisma.JsonValue | null }>>`
                        SELECT "id", "stripeEventId", "type", "metadata" FROM "BillingEvent"
                        WHERE "id" = ${selected.terminalEventId} AND "tenantId" = ${selected.tenantId} FOR UPDATE NOWAIT
                    `; guard();
                    const applications = await tx.$queryRaw<Array<{ eventId: string; tenantId: string; receipt: Prisma.JsonValue }>>`
                        SELECT "eventId", "tenantId", "receipt" FROM "TenantCancellationTerminalEvent"
                        WHERE "eventId" = ${selected.terminalEventId} AND "tenantId" = ${selected.tenantId} FOR UPDATE NOWAIT
                    `; guard();
                    const event = events[0]; const application = applications[0];
                    if (events.length !== 1 || !event || applications.length !== 1 || !application
                        || event.type !== 'customer.subscription.deleted' || !event.stripeEventId
                        || digest(application) !== selected.terminalEventSha256) throw new Error('Exact authenticated application receipt is unavailable.');
                    const proof = cancellationObject(application.receipt);
                    const post = cancellationObject(proof.postState);
                    const metadata = cancellationObject(event.metadata);
                    if (proof.version !== 1 || proof.provenance !== 'verified-stripe-terminal-webhook-v1'
                        || proof.providerEventId !== event.stripeEventId || proof.tenantId !== selected.tenantId
                        || proof.operationId !== selected.jobId || proof.customerId !== selected.customerId
                        || proof.subscriptionId !== selected.subscriptionId || proof.livemode !== false || proof.accountMode !== 'direct'
                        || proof.apiVersion !== '2024-04-10' || !Number.isSafeInteger(proof.providerEventCreated) || Number(proof.providerEventCreated) <= 0
                        || typeof proof.endpointId !== 'string' || !/^we_[A-Za-z0-9]{1,251}$/.test(proof.endpointId)
                        || typeof proof.accountId !== 'string' || !/^acct_[A-Za-z0-9]{1,249}$/.test(proof.accountId)
                        || !['rawBodySha256', 'signatureSha256', 'webhookKeySha256'].every(key => typeof proof[key] === 'string' && /^[a-f0-9]{64}$/.test(proof[key] as string))
                        || metadata.sideEffectDisposition !== 'applied' || metadata.cancellationOperationId !== selected.jobId
                        || metadata.subscriptionId !== selected.subscriptionId || metadata.customerId !== selected.customerId
                        || metadata.stripeEventLivemode !== false || metadata.status !== 'canceled'
                        || post.status !== 'CANCELLED' || post.deletedAt !== null || post.customerId !== selected.customerId
                        || post.subscriptionId !== null || post.currentPeriodEnd !== null
                        || !Number.isSafeInteger(post.billingRevision) || post.billingRevision !== tenant.selectedBillingRevision
                        || row.selectedLifecycleProviderBillingRevision === null
                        || Number(post.billingRevision) <= row.selectedLifecycleProviderBillingRevision) {
                        throw new Error('Authenticated post-effect chronology/resources differ or later history intervened.');
                    }
                    const outcome = parseCancellationOutcome(proof.outcome);
                    if (outcome.action !== 'already_canceled') throw new Error('Terminal application outcome required.');
                    for (const value of [outcome.currentPeriodEnd, outcome.cancelAt, outcome.canceledAt]) {
                        if (value !== null && (!Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString() !== value)) {
                            throw new Error('Canonical terminal application timestamp required.');
                        }
                    }
                    if (intent.actorTenantId === tenant.id) {
                        const actors = await tx.$queryRaw<Array<{ id: string }>>`
                            SELECT "id" FROM "User" WHERE "id" = ${intent.actorUserId} AND "tenantId" = ${tenant.id} FOR KEY SHARE NOWAIT
                        `; guard();
                        if (actors.length !== 1) throw new Error('Original terminal audit actor is unavailable.');
                    }
                    const receipt = { tenantId: selected.tenantId, operationId: selected.jobId,
                        requestIntentSha256: selected.predecessorIntentSha256, providerIntentSha256: selected.providerIntentSha256,
                        providerReceiptSha256: selected.receiptSha256, predecessorFinalizationSha256: selected.predecessorFinalizationSha256,
                        eventId: selected.terminalEventId, applicationReceiptSha256: selected.terminalEventSha256,
                        applicationReceipt: application, outcome, state: 'FINALIZED' };
                    const finalized: TenantCancellationIntentRow = { ...intent, state: 'FINALIZED', providerResult: outcome, providerMutationOwned: true };
                    const changed = await tx.$executeRaw`
                        UPDATE "TenantSetting" SET "value" = CAST(${JSON.stringify(serializeIntentSetting(finalized))} AS jsonb),
                            "selectedLifecycleTerminalIntentSha256" = ${selected.intentSha256},
                            "selectedLifecycleTerminalReceipt" = CAST(${JSON.stringify(receipt)} AS jsonb), "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "tenantId" = ${selected.tenantId} AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
                            AND "selectedLifecycleOperationId" = ${selected.jobId} AND "selectedLifecycleIntentSha256" = ${selected.predecessorIntentSha256}
                            AND "selectedLifecycleProviderIntentSha256" = ${selected.providerIntentSha256}
                            AND "selectedLifecycleProviderReceipt" = CAST(${JSON.stringify(originalReceipt)} AS jsonb)
                            AND "selectedLifecycleTerminalIntentSha256" IS NULL AND "selectedLifecycleTerminalReceipt" IS NULL
                    `; guard();
                    if (changed !== 1) throw new Error('Exact terminal convergence was not recorded.');
                    await this.recordFinalizedAudit(tx, intent, tenant, outcome); guard();
                    await recordAccountLifecycleRequest(tx, { tenantId: selected.tenantId, requestId: selected.jobId,
                        kind: 'CANCELLATION', state: 'COMPLETED' }, guard); guard();
                    const readback = await tx.tenantSetting.findUnique({ where: { tenantId_key: {
                        tenantId: selected.tenantId, key: this.intentSettingKey('CUSTOMER_CANCELLATION') } },
                        select: { value: true, selectedLifecycleTerminalIntentSha256: true, selectedLifecycleTerminalReceipt: true } }); guard();
                    if (!readback || readback.selectedLifecycleTerminalIntentSha256 !== selected.intentSha256
                        || canonicalCancellationReceipt(readback.selectedLifecycleTerminalReceipt) !== canonicalCancellationReceipt(receipt)
                        || canonicalCancellationReceipt(readback.value) !== canonicalCancellationReceipt(serializeIntentSetting(finalized))) {
                        throw new Error('Exact terminal receipt readback differs.');
                    }
                    return true;
                });
                return this.ownerCallback;
            }, { maxWait: 5000, timeout: 60000 });
            guard(); return result;
        } catch (error) { this.ownerClosed = true; this.ownerUnknown = true; throw error; }
        finally { if (this.ownerCallback) await this.ownerCallback; }
    }

    runPersistentOwnerCancellationFinalization(permit: object): Promise<boolean> {
        const selected = consumePersistentCancellationFinalizationPermit(this, permit);
        this.assertPersistentOwnerReady();
        this.ownerUsed = true;
        this.ownerOperation = Promise.resolve().then(() => this.finalizeSelectedCancellationReceipt(selected))
            .catch(error => { this.ownerUnknown = true; throw error; });
        return this.ownerOperation;
    }

    private async finalizeSelectedCancellationReceipt(
        selected: ReturnType<typeof consumePersistentCancellationFinalizationPermit>,
    ): Promise<boolean> {
        const guard = () => this.assertCancellationOwnerOpen(selected.expires);
        type Tenant = TenantCancellationSubject & { stripeCustomerId: string | null;
            stripeSubscriptionCurrentPeriodEnd: Date | null; selectedBillingRevision: number };
        type Setting = { value: Prisma.JsonValue; selectedLifecycleIntentSha256: string | null;
            selectedLifecycleOperationId: string | null; selectedLifecycleProviderIntentSha256: string | null;
            selectedLifecycleProviderCustomerId: string | null; selectedLifecycleProviderReceipt: Prisma.JsonValue | null;
            selectedLifecycleProviderBillingRevision: number | null; selectedLifecycleFinalizationIntentSha256: string | null;
            selectedLifecycleFinalizationReceipt: Prisma.JsonValue | null; selectedLifecycleTerminalIntentSha256: string | null;
            selectedLifecycleTerminalReceipt: Prisma.JsonValue | null;
            selectedLifecycleObservationFinalizationReceipt: Prisma.JsonValue | null; selectedLifecycleObservationTerminalReceipt: Prisma.JsonValue | null };
        const digest = (value: unknown) => createHash('sha256').update(canonicalCancellationReceipt(value)).digest('hex');
        try {
            guard();
            const result = await this.tenantDb.withTenant(selected.tenantId, tx => {
                // Register the actual callback before its body; wrapper rejection cannot abandon it.
                this.ownerCallback = Promise.resolve().then(async () => {
                    guard();
                    await this.lockTenantLifecycle(tx, selected.tenantId); guard();
                    const billingLock = await tx.$queryRaw<Array<{ acquired: boolean }>>`
                        SELECT pg_try_advisory_xact_lock(hashtextextended(${`billing-checkout:${selected.tenantId}`}, 0)) AS "acquired"
                    `; guard();
                    if (billingLock.length !== 1 || billingLock[0]?.acquired !== true) throw new Error('Selected billing lock is busy; no wait or retry.');
                    const tenants = await tx.$queryRaw<Tenant[]>`
                        SELECT "id", "slug", "status", "deletedAt", "retentionLegalHoldAt", "stripeCustomerId",
                            "stripeSubscriptionId", "stripeSubscriptionCurrentPeriodEnd", "selectedBillingRevision"
                        FROM "Tenant" WHERE "id" = ${selected.tenantId} FOR UPDATE NOWAIT
                    `; guard();
                    const rows = await tx.$queryRaw<Setting[]>`
                        SELECT "value", "selectedLifecycleIntentSha256", "selectedLifecycleOperationId",
                            "selectedLifecycleProviderIntentSha256", "selectedLifecycleProviderCustomerId",
                            "selectedLifecycleProviderReceipt", "selectedLifecycleProviderBillingRevision",
                            "selectedLifecycleFinalizationIntentSha256", "selectedLifecycleFinalizationReceipt",
                            "selectedLifecycleTerminalIntentSha256", "selectedLifecycleTerminalReceipt",
                            "selectedLifecycleObservationFinalizationReceipt", "selectedLifecycleObservationTerminalReceipt"
                        FROM "TenantSetting" WHERE "tenantId" = ${selected.tenantId}
                            AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation' FOR UPDATE NOWAIT
                    `; guard();
                    const tenant = tenants[0]; const row = rows[0];
                    if (tenants.length !== 1 || !tenant || rows.length !== 1 || !row
                        || row.selectedLifecycleIntentSha256 !== selected.predecessorIntentSha256
                        || row.selectedLifecycleOperationId !== selected.jobId
                        || row.selectedLifecycleProviderIntentSha256 !== selected.providerIntentSha256
                        || row.selectedLifecycleProviderCustomerId !== selected.customerId
                        || !row.selectedLifecycleProviderReceipt || digest(row.selectedLifecycleProviderReceipt) !== selected.receiptSha256) {
                        throw new Error('Exact immutable cancellation receipt/predecessor is absent or differs.');
                    }
                    const intent = parseIntentSetting(row.value);
                    const receipt = row.selectedLifecycleProviderReceipt as Record<string, Prisma.JsonValue>;
                    const rawOutcome = receipt.outcome;
                    if (!rawOutcome || typeof rawOutcome !== 'object' || Array.isArray(rawOutcome)) throw new Error('Projected provider outcome required.');
                    const providerOutcome = rawOutcome as Record<string, Prisma.JsonValue>;
                    const outcome = parseCancellationOutcome(providerOutcome);
                    if (intent.kind !== 'CUSTOMER_CANCELLATION' || intent.tenantId !== selected.tenantId
                        || intent.operationId !== selected.jobId || intent.providerAttempts !== 1
                        || intent.providerSubscriptionId !== selected.subscriptionId
                        || receipt.tenantId !== selected.tenantId || receipt.operationId !== selected.jobId
                        || receipt.customerId !== selected.customerId || providerOutcome.stripeSubscriptionId !== selected.subscriptionId
                        || outcome.action !== selected.expectedAction || providerOutcome.cancellationBehavior !== 'cancel_at_period_end'
                        || typeof providerOutcome.providerMutationOwned !== 'boolean') throw new Error('Selected local cancellation transition differs.');
                    const historyRows = await tx.$queryRaw<Array<{ value: Prisma.JsonValue }>>`
                        SELECT "value" FROM "TenantSetting" WHERE "tenantId" = ${selected.tenantId}
                            AND "key" = ${`internal:account-lifecycle-request:${selected.jobId}`} FOR UPDATE NOWAIT
                    `; guard();
                    const history = projectAccountLifecycleRequest(historyRows[0]?.value);
                    if (historyRows.length !== 1 || !history || history.requestId !== selected.jobId || history.kind !== 'CANCELLATION'
                        || history.state !== (row.selectedLifecycleFinalizationReceipt === null ? 'PENDING' : 'COMPLETED')) {
                        throw new Error('Original customer request history is absent or differs; no replacement timestamp permitted.');
                    }
                    // A completed exact receipt is read back before current billing comparisons: later webhooks are not undone.
                    if (row.selectedLifecycleFinalizationReceipt !== null) {
                        const prior = row.selectedLifecycleFinalizationReceipt as Record<string, Prisma.JsonValue>;
                        const terminal = row.selectedLifecycleTerminalReceipt === null ? null : cancellationObject(row.selectedLifecycleTerminalReceipt);
                        const compatibleTerminal = Boolean(row.selectedLifecycleTerminalIntentSha256 && terminal
                            && terminal.tenantId === selected.tenantId && terminal.operationId === selected.jobId
                            && terminal.requestIntentSha256 === selected.predecessorIntentSha256
                            && terminal.providerIntentSha256 === selected.providerIntentSha256
                            && terminal.providerReceiptSha256 === selected.receiptSha256
                            && terminal.predecessorFinalizationSha256 === digest(row.selectedLifecycleFinalizationReceipt)
                            && canonicalCancellationReceipt(terminal.outcome) === canonicalCancellationReceipt(intent.providerResult));
                        const observed = row.selectedLifecycleObservationFinalizationReceipt === null ? null
                            : cancellationObject(row.selectedLifecycleObservationFinalizationReceipt);
                        const observedTerminal = row.selectedLifecycleObservationTerminalReceipt === null ? null
                            : cancellationObject(row.selectedLifecycleObservationTerminalReceipt);
                        const compatibleObserved = Boolean(observed && observed.source === 'provider-observation'
                            && observed.tenantId === selected.tenantId && observed.operationId === selected.jobId
                            && observed.requestIntentSha256 === selected.predecessorIntentSha256
                            && observed.providerIntentSha256 === selected.providerIntentSha256 && observed.priorReceiptSha256 === selected.receiptSha256
                            && observed.predecessorFinalizationSha256 === digest(row.selectedLifecycleFinalizationReceipt)
                            && (canonicalCancellationReceipt(observed.outcome) === canonicalCancellationReceipt(intent.providerResult)
                                || (observedTerminal && observedTerminal.observationFinalizationSha256 === digest(observed)
                                    && observedTerminal.source === 'verified-terminal-event'
                                    && observedTerminal.tenantId === selected.tenantId && observedTerminal.operationId === selected.jobId
                                    && observedTerminal.requestIntentSha256 === selected.predecessorIntentSha256
                                    && observedTerminal.providerIntentSha256 === selected.providerIntentSha256
                                    && observedTerminal.priorReceiptSha256 === selected.receiptSha256
                                    && observedTerminal.predecessorFinalizationSha256 === digest(row.selectedLifecycleFinalizationReceipt)
                                    && observedTerminal.observationId === observed.observationId
                                    && observedTerminal.observationIntentSha256 === observed.observationIntentSha256
                                    && observedTerminal.observationReceiptSha256 === observed.observationReceiptSha256
                                    && canonicalCancellationReceipt(observedTerminal.outcome) === canonicalCancellationReceipt(intent.providerResult))));
                        if (intent.state !== 'FINALIZED' || !row.selectedLifecycleFinalizationIntentSha256
                            || prior.providerReceiptSha256 !== selected.receiptSha256
                            || prior.requestIntentSha256 !== selected.predecessorIntentSha256
                            || prior.providerIntentSha256 !== selected.providerIntentSha256
                            || prior.operationId !== selected.jobId || prior.tenantId !== selected.tenantId
                            || prior.action !== selected.expectedAction
                            || (!compatibleTerminal && !compatibleObserved && canonicalCancellationReceipt(intent.providerResult) !== canonicalCancellationReceipt(outcome))) {
                            throw new Error('Durable prior local finalization differs.');
                        }
                        return true;
                    }
                    if (intent.state !== 'PENDING_PROVIDER' || intent.providerResult !== null
                        || row.selectedLifecycleFinalizationIntentSha256 !== null
                        || row.selectedLifecycleProviderBillingRevision === null
                        || row.selectedLifecycleProviderBillingRevision !== tenant.selectedBillingRevision) {
                        throw new Error('Newer or uncaptured billing state requires separate reconciliation.');
                    }
                    const platformIntent = await tx.tenantSetting.findUnique({ where: { tenantId_key: {
                        tenantId: selected.tenantId, key: this.intentSettingKey('PLATFORM_ARCHIVE') } }, select: { id: true } }); guard();
                    if (platformIntent) throw new Error('Competing platform lifecycle history requires distinct reconciliation.');
                    this.assertNoLifecycleBarrier(tenant, 'CUSTOMER_CANCELLATION');
                    if (tenant.deletedAt !== null || tenant.stripeCustomerId !== selected.customerId
                        || tenant.stripeSubscriptionId !== selected.subscriptionId) throw new Error('Cancellation tenant/resource binding changed.');
                    this.assertSubscriptionUnchanged(intent, tenant);
                    const terminal = outcome.action === 'already_canceled';
                    const none = outcome.action === 'none';
                    if (none ? selected.subscriptionId !== null || receipt.disposition !== 'NO_SUBSCRIPTION'
                        : selected.subscriptionId === null || !['READBACK', 'MUTATION_ACCEPTED'].includes(String(receipt.disposition))) {
                        throw new Error('Cancellation provider disposition differs.');
                    }
                    let paidThrough: Date | null = null;
                    if (!none && !terminal) {
                        if (!outcome.cancelAtPeriodEnd || !outcome.currentPeriodEnd) throw new Error('Scheduled cancellation needs a paid-through boundary.');
                        paidThrough = new Date(outcome.currentPeriodEnd);
                        if (!Number.isFinite(paidThrough.getTime()) || paidThrough.toISOString() !== outcome.currentPeriodEnd) throw new Error('Canonical paid-through timestamp required.');
                        if (tenant.stripeSubscriptionCurrentPeriodEnd && paidThrough < tenant.stripeSubscriptionCurrentPeriodEnd) {
                            throw new Error('Receipt cannot shorten a newer local paid-through boundary.');
                        }
                    }
                    // Preclaim late FK/trigger dependencies without adding a waiting reverse lock edge.
                    if (intent.actorTenantId === tenant.id) {
                        const actors = await tx.$queryRaw<Array<{ id: string }>>`
                            SELECT "id" FROM "User" WHERE "id" = ${intent.actorUserId} AND "tenantId" = ${tenant.id}
                            FOR KEY SHARE NOWAIT
                        `; guard();
                        if (actors.length !== 1) throw new Error('Retained original audit actor is unavailable.');
                    }
                    if (terminal) {
                        await tx.$queryRaw`
                            WITH locked AS (SELECT "id" FROM "StaffInvitationOutbox"
                                WHERE "tenantId" = ${tenant.id}
                                ORDER BY "id" FOR UPDATE NOWAIT)
                            SELECT count(*) FROM locked
                        `; guard();
                    }
                    const finalReceipt = { tenantId: selected.tenantId, operationId: selected.jobId,
                        requestIntentSha256: selected.predecessorIntentSha256, providerIntentSha256: selected.providerIntentSha256,
                        providerReceiptSha256: selected.receiptSha256, action: outcome.action,
                        billingRevision: tenant.selectedBillingRevision.toString(), state: 'FINALIZED' };
                    const finalized: TenantCancellationIntentRow = { ...intent, state: 'FINALIZED',
                        providerResult: outcome, providerMutationOwned: providerOutcome.providerMutationOwned };
                    // Preserve original provider attempt and lease as immutable custody evidence; no renewal/release.
                    guard();
                    const changed = await tx.$executeRaw`
                        UPDATE "TenantSetting" SET "value" = CAST(${JSON.stringify(serializeIntentSetting(finalized))} AS jsonb),
                            "selectedLifecycleFinalizationIntentSha256" = ${selected.intentSha256},
                            "selectedLifecycleFinalizationReceipt" = CAST(${JSON.stringify(finalReceipt)} AS jsonb), "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "tenantId" = ${selected.tenantId} AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
                            AND "selectedLifecycleIntentSha256" = ${selected.predecessorIntentSha256}
                            AND "selectedLifecycleOperationId" = ${selected.jobId}
                            AND "selectedLifecycleProviderIntentSha256" = ${selected.providerIntentSha256}
                            AND "selectedLifecycleProviderReceipt" = CAST(${JSON.stringify(receipt)} AS jsonb)
                            AND "selectedLifecycleProviderBillingRevision" = ${tenant.selectedBillingRevision}
                            AND "selectedLifecycleFinalizationIntentSha256" IS NULL AND "selectedLifecycleFinalizationReceipt" IS NULL
                    `; guard();
                    if (changed !== 1) throw new Error('Exact cancellation receipt consumption was not recorded.');
                    if (!none) {
                        const updated = await tx.tenant.updateMany({ where: { id: selected.tenantId,
                            selectedBillingRevision: tenant.selectedBillingRevision, stripeCustomerId: selected.customerId,
                            stripeSubscriptionId: selected.subscriptionId, deletedAt: null },
                            data: terminal ? { status: TenantStatus.CANCELLED, stripeSubscriptionId: null,
                                stripeSubscriptionCurrentPeriodEnd: null } : { stripeSubscriptionCurrentPeriodEnd: paidThrough } }); guard();
                        if (updated.count !== 1) throw new Error('Exact cancellation billing transition was not recorded.');
                    }
                    const billingReadback = await tx.tenant.findUnique({ where: { id: selected.tenantId },
                        select: { stripeCustomerId: true, stripeSubscriptionId: true, stripeSubscriptionCurrentPeriodEnd: true,
                            status: true, deletedAt: true, selectedBillingRevision: true } }); guard();
                    const expectedPeriod = none ? tenant.stripeSubscriptionCurrentPeriodEnd : paidThrough;
                    if (!billingReadback || billingReadback.stripeCustomerId !== selected.customerId
                        || billingReadback.stripeSubscriptionId !== (terminal ? null : selected.subscriptionId)
                        || billingReadback.status !== (terminal ? TenantStatus.CANCELLED : tenant.status)
                        || billingReadback.deletedAt !== null
                        || billingReadback.selectedBillingRevision !== tenant.selectedBillingRevision + (none ? 0 : 1)
                        || (billingReadback.stripeSubscriptionCurrentPeriodEnd?.getTime() ?? null) !== (expectedPeriod?.getTime() ?? null)) {
                        throw new Error('Atomic local billing readback differs.');
                    }
                    await this.recordFinalizedAudit(tx, intent, tenant, outcome); guard();
                    await recordAccountLifecycleRequest(tx, { tenantId: selected.tenantId, requestId: selected.jobId,
                        kind: 'CANCELLATION', state: 'COMPLETED' }, guard); guard();
                    const readback = await tx.tenantSetting.findUnique({ where: { tenantId_key: {
                        tenantId: selected.tenantId, key: this.intentSettingKey('CUSTOMER_CANCELLATION') } },
                        select: { selectedLifecycleFinalizationIntentSha256: true, selectedLifecycleFinalizationReceipt: true, value: true } }); guard();
                    if (!readback || readback.selectedLifecycleFinalizationIntentSha256 !== selected.intentSha256
                        || canonicalCancellationReceipt(readback.selectedLifecycleFinalizationReceipt) !== canonicalCancellationReceipt(finalReceipt)
                        || canonicalCancellationReceipt(readback.value) !== canonicalCancellationReceipt(serializeIntentSetting(finalized))) {
                        throw new Error('Exact local cancellation receipt readback differs.');
                    }
                    return true;
                });
                return this.ownerCallback;
            }, { maxWait: 5000, timeout: 60000 });
            guard();
            return result;
        } catch (error) {
            this.ownerClosed = true; this.ownerUnknown = true;
            throw error;
        } finally { if (this.ownerCallback) await this.ownerCallback; }
    }

    runPersistentOwnerCancellationProvider(permit: object): Promise<boolean> {
        const selected = consumePersistentCancellationOperationPermit(this, permit);
        this.assertPersistentOwnerReady();
        this.ownerUsed = true;
        this.ownerOperation = Promise.resolve().then(() => this.applySelectedCancellationProvider(selected, permit))
            .catch(error => { this.ownerUnknown = true; throw error; });
        return this.ownerOperation;
    }

    private async applySelectedCancellationProvider(
        selected: ReturnType<typeof consumePersistentCancellationOperationPermit>, permit: object,
    ): Promise<boolean> {
        this.assertCancellationOwnerOpen(selected.expires);
        const provider = this.persistentProvider;
        if (!provider) throw new Error('Fixed selected cancellation provider required.');
        const started = performance.now();
        if (selected.expires - started <= provider.timeoutMs + 8000) throw new Error('Original provider/bookkeeping budget is insufficient.');
        const providerExpires = Math.min(selected.expires - 8000, started + provider.timeoutMs);
        const leaseUntil = new Date(Date.now() + Math.ceil(selected.expires - started));
        const leaseOwner = randomUUID();
        const timer = setTimeout(() => this.ownerProviderAbort.abort(new Error('Selected cancellation provider deadline exceeded.')),
            Math.max(0, Math.ceil(providerExpires - performance.now())));
        type Setting = { value: Prisma.JsonValue; selectedLifecycleIntentSha256: string | null;
            selectedLifecycleOperationId: string | null; selectedLifecycleProviderIntentSha256: string | null;
            selectedLifecycleProviderLeaseUntil: Date | null; selectedLifecycleProviderCustomerId: string | null; selectedLifecycleProviderReceipt: Prisma.JsonValue | null };
        type Tenant = TenantCancellationSubject & { stripeCustomerId: string | null };
        const readLocked = async (tx: TenantPrismaTransaction) => {
            this.assertCancellationOwnerOpen(selected.expires);
            await this.lockTenantLifecycle(tx, selected.tenantId);
            this.assertCancellationOwnerOpen(selected.expires);
            const tenants = await tx.$queryRaw<Tenant[]>`
                SELECT "id", "slug", "status", "deletedAt", "retentionLegalHoldAt", "stripeSubscriptionId", "stripeCustomerId"
                FROM "Tenant" WHERE "id" = ${selected.tenantId} FOR UPDATE NOWAIT
            `;
            this.assertCancellationOwnerOpen(selected.expires);
            const rows = await tx.$queryRaw<Setting[]>`
                SELECT "value", "selectedLifecycleIntentSha256", "selectedLifecycleOperationId",
                    "selectedLifecycleProviderIntentSha256", "selectedLifecycleProviderLeaseUntil", "selectedLifecycleProviderCustomerId", "selectedLifecycleProviderReceipt"
                FROM "TenantSetting" WHERE "tenantId" = ${selected.tenantId}
                    AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation' FOR UPDATE NOWAIT
            `;
            this.assertCancellationOwnerOpen(selected.expires);
            const tenant = tenants[0]; const row = rows[0];
            if (tenants.length !== 1 || !tenant || tenant.id !== selected.tenantId || tenant.deletedAt !== null
                || tenant.status === 'PURGED' || tenant.status === 'SUSPENDED'
                || tenant.stripeCustomerId !== selected.customerId || tenant.stripeSubscriptionId !== selected.subscriptionId
                || rows.length !== 1 || !row || row.selectedLifecycleIntentSha256 !== selected.predecessorIntentSha256
                || row.selectedLifecycleOperationId !== selected.jobId) throw new Error('Exact recorded cancellation predecessor differs.');
            const intent = parseIntentSetting(row.value);
            if (intent.tenantId !== selected.tenantId || intent.operationId !== selected.jobId || intent.kind !== 'CUSTOMER_CANCELLATION'
                || intent.state !== 'PENDING_PROVIDER' || intent.providerResult !== null
                || intent.providerSubscriptionId !== selected.subscriptionId
                || intent.subscriptionFingerprint !== this.subscriptionFingerprint(tenant.id, tenant.stripeSubscriptionId)) {
                throw new Error('Recorded cancellation identity/resource binding changed.');
            }
            return { tenant, row, intent };
        };
        const custody: { claim?: Promise<void>; delivery?: Promise<boolean> } = {};
        try {
            await this.tenantDb.withTenant(selected.tenantId, tx => {
                const callback = Promise.resolve().then(async () => {
                    const { row, intent } = await readLocked(tx);
                    this.assertCancellationOwnerOpen(selected.expires);
                    if (intent.providerAttempts !== 0 || intent.providerLeaseOwner !== null || intent.providerLeaseExpiresAt !== null
                        || row.selectedLifecycleProviderIntentSha256 !== null || row.selectedLifecycleProviderLeaseUntil !== null
                        || row.selectedLifecycleProviderCustomerId !== null || row.selectedLifecycleProviderReceipt !== null) throw new Error('Selected cancellation predecessor is already consumed.');
                    const changed = await tx.$executeRaw`
                        UPDATE "TenantSetting" SET "value" = "value" || jsonb_build_object(
                            'providerAttempts', 1, 'providerLeaseOwner', ${leaseOwner},
                            'providerLeaseExpiresAt', ${leaseUntil.toISOString()}),
                            "selectedLifecycleProviderIntentSha256" = ${selected.intentSha256},
                            "selectedLifecycleProviderCustomerId" = ${selected.customerId},
                            "selectedLifecycleProviderLeaseUntil" = ${leaseUntil}, "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "tenantId" = ${selected.tenantId} AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
                            AND "selectedLifecycleIntentSha256" = ${selected.predecessorIntentSha256}
                            AND "selectedLifecycleOperationId" = ${selected.jobId} AND "value"->>'operationId' = ${selected.jobId}
                            AND "value"->>'state' = 'PENDING_PROVIDER' AND "value"->>'providerAttempts' = '0'
                            AND "value"->>'providerLeaseOwner' IS NULL AND "value"->>'providerLeaseExpiresAt' IS NULL
                            AND "selectedLifecycleProviderIntentSha256" IS NULL
                            AND "selectedLifecycleProviderLeaseUntil" IS NULL AND "selectedLifecycleProviderReceipt" IS NULL
                    `;
                    this.assertCancellationOwnerOpen(selected.expires);
                    if (changed !== 1) throw new Error('Exact cancellation provider claim acknowledgement lost ownership.');
                });
                custody.claim = callback;
                return callback;
            }, { maxWait: 5000, timeout: 60000 });
            this.assertCancellationOwnerOpen(selected.expires);
            this.ownerProviderClaim = Object.freeze({ tenantId: selected.tenantId, operationId: selected.jobId,
                customerId: selected.customerId, subscriptionId: selected.subscriptionId,
                requestIntentSha256: selected.predecessorIntentSha256, providerIntentSha256: selected.intentSha256,
                providerLeaseOwner: leaseOwner, providerLeaseUntil: leaseUntil.toISOString(), expires: selected.expires, providerExpires });
            this.assertPersistentCancellationProviderOpen(this.ownerProviderClaim);
            const result = await this.tenantDb.withTenant(selected.tenantId, tx => {
                const callback = Promise.resolve().then(async () => {
                    const { row, intent } = await readLocked(tx);
                    this.assertCancellationOwnerOpen(selected.expires);
                    if (intent.providerAttempts !== 1 || intent.providerLeaseOwner !== leaseOwner
                        || intent.providerLeaseExpiresAt?.getTime() !== leaseUntil.getTime()
                        || row.selectedLifecycleProviderIntentSha256 !== selected.intentSha256
                        || row.selectedLifecycleProviderLeaseUntil?.getTime() !== leaseUntil.getTime()
                        || row.selectedLifecycleProviderCustomerId !== selected.customerId
                        || row.selectedLifecycleProviderReceipt !== null) throw new Error('Original cancellation provider generation differs.');
                    const live = await tx.$queryRaw<Array<{ live: boolean }>>`
                        SELECT ("selectedLifecycleProviderLeaseUntil" > clock_timestamp()) AS "live" FROM "TenantSetting"
                        WHERE "tenantId" = ${selected.tenantId} AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
                            AND "selectedLifecycleProviderIntentSha256" = ${selected.intentSha256}
                    `;
                    this.assertPersistentCancellationProviderOpen(this.ownerProviderClaim!);
                    if (live.length !== 1 || live[0].live !== true) throw new Error('Original selected cancellation lease expired.');
                    const receipt = await provider.apply(permit);
                    // Provider evidence only; no paid-through synchronization or lifecycle finalization here.
                    this.assertCancellationOwnerOpen(selected.expires);
                    const changed = await tx.$executeRaw`
                        UPDATE "TenantSetting" SET "selectedLifecycleProviderReceipt" = CAST(${JSON.stringify(receipt)} AS jsonb),
                            "selectedLifecycleProviderRequestId" = ${receipt.providerRequestId},
                            "selectedLifecycleProviderCompletedAt" = clock_timestamp(), "updatedAt" = CURRENT_TIMESTAMP
                        WHERE "tenantId" = ${selected.tenantId} AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation'
                            AND "selectedLifecycleIntentSha256" = ${selected.predecessorIntentSha256}
                            AND "selectedLifecycleOperationId" = ${selected.jobId}
                            AND "selectedLifecycleProviderIntentSha256" = ${selected.intentSha256}
                            AND "selectedLifecycleProviderLeaseUntil" = ${leaseUntil}
                            AND "selectedLifecycleProviderLeaseUntil" > clock_timestamp()
                            AND "value"->>'operationId' = ${selected.jobId} AND "value"->>'providerAttempts' = '1'
                            AND "value"->>'providerLeaseOwner' = ${leaseOwner}
                            AND "value"->>'providerLeaseExpiresAt' = ${leaseUntil.toISOString()}
                            AND "selectedLifecycleProviderReceipt" IS NULL
                            AND "selectedLifecycleProviderRequestId" IS NULL AND "selectedLifecycleProviderCompletedAt" IS NULL
                    `;
                    this.assertCancellationOwnerOpen(selected.expires);
                    if (changed !== 1) throw new Error('Exact provider receipt acknowledgement lost ownership.');
                    return true;
                });
                custody.delivery = callback;
                return callback;
            }, { maxWait: 5000, timeout: 60000 });
            this.assertCancellationOwnerOpen(selected.expires);
            return result;
        } catch (error) {
            this.ownerClosed = true;
            this.ownerUnknown = true;
            this.ownerProviderAbort.abort(error);
            throw error;
        } finally {
            try { if (custody.claim) await custody.claim; }
            finally {
                try { if (custody.delivery) await custody.delivery; }
                finally { clearTimeout(timer); this.ownerProviderAbort.abort(new Error('Selected cancellation provider phase finished.')); }
            }
        }
    }

    private async observeSelectedMfa(
        identity: MfaSessionIdentity,
        selected: ReturnType<typeof consumePersistentCancellationRequestPermit>,
        assertOpen: () => void,
    ) {
        assertOpen();
        if (this.ownerMfaUsed || identity.sub !== selected.request.userId
            || identity.tenantId !== selected.tenantId || identity.sessionId !== selected.request.sessionId) {
            throw new Error('Exact single originating-session MFA observation required.');
        }
        this.ownerMfaUsed = true;
        const url = process.env.REDIS_URL;
        if (!url) throw new Error('Explicit admitted MFA Redis endpoint required.');
        // Same closed connection policy as accepted Redis354; URL query options
        // must never override no-reconnect/no-replay options in ioredis.
        const endpoint = new URL(url);
        const path = endpoint.pathname;
        const host = endpoint.hostname.startsWith('[') ? endpoint.hostname.slice(1, -1) : endpoint.hostname;
        const db = path === '' || path === '/' ? 0 : Number(path.slice(1));
        const port = endpoint.port === '' ? 6379 : Number(endpoint.port);
        if (!['redis:', 'rediss:'].includes(endpoint.protocol) || !host || url.includes('?') || url.includes('#')
            || (path !== '' && path !== '/' && !/^\/[0-9]+$/.test(path))
            || !Number.isSafeInteger(db) || db < 0 || db > 2147483647
            || !Number.isSafeInteger(port) || port < 1 || port > 65535
            || (!endpoint.hostname.startsWith('[') && !/^[A-Za-z0-9.-]+$/.test(host))) {
            throw new Error('Selected MFA Redis endpoint must be a network URL without query options.');
        }
        const username = endpoint.username ? decodeURIComponent(endpoint.username) : undefined;
        const password = endpoint.password ? decodeURIComponent(endpoint.password) : undefined;
        assertOpen();
        const redis = new Redis({ host, port, db, username, password,
            tls: endpoint.protocol === 'rediss:' ? {} : undefined,
            lazyConnect: true, enableOfflineQueue: false, enableReadyCheck: false,
            enableAutoPipelining: false, reconnectOnError: () => false,
            maxRetriesPerRequest: 0, retryStrategy: () => null,
            autoResendUnfulfilledCommands: false, autoResubscribe: false,
        });
        this.ownerMfaRedis = redis;
        let failed = false;
        redis.on('error', () => { failed = true; });
        this.ownerMfaConnect = redis.connect();
        await this.ownerMfaConnect;
        assertOpen();
        if (failed || redis.status !== 'ready') throw new Error('Selected MFA observation is unavailable.');
        const timeout = Math.min(5000, Math.floor(selected.expires - performance.now()));
        if (timeout < 250) throw new Error('Original owner budget cannot cover MFA observation.');
        const observation = await observeMfaVerification(identity, (script, key) => {
            assertOpen();
            if (failed || redis.status !== 'ready' || script !== MFA_MARKER_TTL_SCRIPT
                || key !== `session_mfa:${selected.request.sessionId}` || this.ownerMfaRead) {
                throw new Error('Exact bounded MFA marker read required.');
            }
            this.ownerMfaRead = redis.eval(script, 1, key);
            return this.ownerMfaRead;
        }, timeout);
        assertOpen();
        if (failed) throw new Error('Selected MFA observation failed.');
        return observation;
    }

    async prepare(input: PrepareIntentInput): Promise<PreparedTenantCancellationIntent> {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        input = Object.freeze({ ...input, actor: Object.freeze({ ...input.actor }) }) as PrepareIntentInput;
        // Capture request authority before any lock wait; recovery methods never
        // enter this admission wrapper or depend on the originating session.
        if (input.kind === 'PLATFORM_ARCHIVE') {
            input = { ...input, actor: capturePlatformTenantActor(input.actor) };
        }
        const prepare = async (tx: TenantPrismaTransaction, assertCurrent: () => void) => {
            if (input.kind === 'CUSTOMER_CANCELLATION') await this.lockTenantLifecycle(tx, input.tenantId);
            const tenant = await this.findTenantSubject(tx, input.tenantId);
            if (input.confirmation !== undefined) {
                assertTenantSlugConfirmation(input.confirmation, tenant.slug);
            }
            this.assertNoLifecycleBarrier(tenant, input.kind);

            const fingerprint = this.subscriptionFingerprint(
                tenant.id,
                tenant.stripeSubscriptionId,
            );
            let intent = await this.findIntent(tx, tenant.id, input.kind);
            const now = this.now();
            if (
                intent
                && this.isFinalizedCustomerWebhookConvergence(intent, tenant)
            ) {
                const priorOutcome = parseCancellationOutcome(intent.providerResult);
                const outcome = terminalizeCancellationOutcome(priorOutcome);
                assertCurrent();
                await this.recordFinalizedAudit(tx, intent, tenant, outcome);
                intent = {
                    ...intent,
                    providerResult: outcome,
                    providerLeaseOwner: null,
                    providerLeaseExpiresAt: null,
                };
                assertCurrent();
                await this.writeIntent(tx, intent);
                return { intent, tenant, providerLeaseOwner: null };
            }
            const finalStillApplies = intent?.state === 'FINALIZED'
                && (
                    intent.subscriptionFingerprint === fingerprint
                    || (
                        input.kind === 'CUSTOMER_CANCELLATION'
                        && isTerminalCancellationOutcome(intent.providerResult)
                        && tenant.status === TenantStatus.CANCELLED
                        && tenant.stripeSubscriptionId === null
                    )
                )
                && (
                    input.kind === 'CUSTOMER_CANCELLATION'
                    || (tenant.status === TenantStatus.CANCELLED && tenant.deletedAt !== null)
                );
            const finalizedProviderReadbackDue = Boolean(
                finalStillApplies
                && intent
                && isFinalizedProviderReadbackDue(intent, now),
            );
            if (finalStillApplies && intent) {
                if (!finalizedProviderReadbackDue) {
                    return { intent, tenant, providerLeaseOwner: null };
                }
            }

            const reusePending = intent
                && (
                    isRecoverableIntentState(intent.state)
                    || finalizedProviderReadbackDue
                )
                && intent.subscriptionFingerprint === fingerprint;
            if (!reusePending) {
                if (intent?.kind === 'CUSTOMER_CANCELLATION' && isRecoverableIntentState(intent.state)) {
                    assertCurrent();
                    await recordAccountLifecycleRequest(tx, { tenantId: intent.tenantId,
                        requestId: intent.operationId, kind: 'CANCELLATION', state: 'SUPERSEDED' });
                }
                const operationId = randomUUID();
                intent = await this.resetIntent(tx, {
                    ...input,
                    operationId,
                    providerSubscriptionId: tenant.stripeSubscriptionId?.trim() || null,
                    subscriptionFingerprint: fingerprint,
                }, assertCurrent);
                assertCurrent();
                await tx.auditLog.create({
                    data: {
                        tenantId: tenant.id,
                        userId: input.actor.tenantId === tenant.id
                            ? input.actor.userId
                            : null,
                        actorUserId: input.actor.userId,
                        actorTenantId: input.actor.tenantId,
                        action: input.kind === 'CUSTOMER_CANCELLATION'
                            ? 'TENANT_CANCELLATION_INTENT_RECORDED_BY_CUSTOMER'
                            : 'TENANT_ARCHIVE_INTENT_RECORDED_BY_PLATFORM',
                        resource: 'Tenant',
                        resourceId: tenant.id,
                        newValue: {
                            operationId,
                            state: 'PENDING_PROVIDER',
                            ...(input.reason ? { reason: input.reason } : {}),
                        },
                        ipAddress: input.actor.ipAddress,
                        userAgent: input.actor.userAgent,
                    },
                });
            }
            if (!intent) {
                throw new Error('Tenant lifecycle intent is unavailable.');
            }

            if (intent.state === 'FINALIZED' && !finalizedProviderReadbackDue) {
                return { intent, tenant, providerLeaseOwner: null };
            }
            if (
                intent.providerLeaseOwner
                && intent.providerLeaseExpiresAt
                && intent.providerLeaseExpiresAt.getTime() > now.getTime()
            ) {
                return { intent, tenant, providerLeaseOwner: null };
            }

            const providerLeaseOwner = randomUUID();
            const leaseExpiresAt = new Date(now.getTime() + this.providerLeaseMs);
            const claimed: TenantCancellationIntentRow = {
                ...intent,
                providerLeaseOwner,
                providerLeaseExpiresAt: leaseExpiresAt,
                providerAttempts: intent.providerAttempts + 1,
            };
            assertCurrent();
            await this.writeIntent(tx, claimed);
            return {
                intent: claimed,
                tenant,
                providerLeaseOwner,
            };
        };
        return input.kind === 'PLATFORM_ARCHIVE'
            ? withPlatformTenantLifecycleAdmission(this.rbac ?? new RbacService(this.tenantDb), input.tenantId, input.actor,
                this.mfaObserver, (tx, _actor, assertCurrent) => prepare(tx, assertCurrent))
            : withCustomerLifecycleAdmission(this.tenantDb, this.rbac, this.mfaObserver, input.actor, prepare);
    }

    async markProviderApplied(
        prepared: PreparedTenantCancellationIntent,
        outcome: TenantCancellationOutcome,
        providerMutationOwnedFromAttempt = outcome.action === 'scheduled',
    ): Promise<PreparedTenantCancellationIntent> {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        const owner = prepared.providerLeaseOwner;
        if (!owner) throw new Error('Provider cancellation claim is unavailable.');
        return this.withIntentScope(
            prepared.intent.kind,
            prepared.tenant.id,
            async (tx) => {
                await this.lockTenantLifecycle(tx, prepared.tenant.id);
                const current = await this.findIntent(
                    tx,
                    prepared.tenant.id,
                    prepared.intent.kind,
                );
                if (
                    !current
                    || current.operationId !== prepared.intent.operationId
                    || (
                        current.state === 'FINALIZED'
                        && prepared.intent.state !== 'FINALIZED'
                    )
                    || current.providerLeaseOwner !== owner
                ) {
                    throw new Error('Provider cancellation claim was lost.');
                }
                let tenant = await this.findTenantSubject(tx, prepared.tenant.id);
                const providerMutationOwned = current.providerMutationOwned === true
                    || providerMutationOwnedFromAttempt
                    || outcome.action === 'scheduled';
                if (current.state === 'FINALIZED') {
                    if (current.kind !== 'CUSTOMER_CANCELLATION') {
                        throw new Error('Finalized provider readback is unavailable.');
                    }
                    const priorOutcome = parseCancellationOutcome(current.providerResult);
                    const localTerminalConverged = this.isFinalizedCustomerWebhookConvergence(
                        current,
                        tenant,
                    );
                    const effectiveOutcome = localTerminalConverged
                        ? terminalizeCancellationOutcome(outcome)
                        : outcome;
                    if (!localTerminalConverged) {
                        this.assertSubscriptionUnchanged(current, tenant);
                    }
                    this.assertNoLifecycleBarrier(tenant, current.kind);
                    if (isTerminalCancellationOutcome(effectiveOutcome) && !localTerminalConverged) {
                        tenant = await tx.tenant.update({
                            where: { id: tenant.id },
                            data: {
                                status: TenantStatus.CANCELLED,
                                stripeSubscriptionId: null,
                                stripeSubscriptionCurrentPeriodEnd: null,
                            },
                            select: {
                                id: true,
                                slug: true,
                                status: true,
                                deletedAt: true,
                                retentionLegalHoldAt: true,
                                stripeSubscriptionId: true,
                            },
                        }) as TenantCancellationSubject;
                    }
                    if (
                        !isTerminalCancellationOutcome(priorOutcome)
                        && isTerminalCancellationOutcome(effectiveOutcome)
                    ) {
                        await this.recordFinalizedAudit(
                            tx,
                            current,
                            tenant,
                            effectiveOutcome,
                        );
                    }
                    const reconciled: TenantCancellationIntentRow = {
                        ...current,
                        providerMutationOwned,
                        providerResult: effectiveOutcome,
                        providerLeaseOwner: null,
                        providerLeaseExpiresAt: null,
                    };
                    await this.writeIntent(tx, reconciled);
                    return {
                        intent: reconciled,
                        tenant,
                        providerLeaseOwner: null,
                    };
                }
                const terminalWebhookConverged = this.isCustomerTerminalProviderConvergence(
                    current,
                    outcome,
                    tenant,
                );
                if (!terminalWebhookConverged) {
                    this.assertSubscriptionUnchanged(current, tenant);
                }
                const holdWonPlatformArchive = current.kind === 'PLATFORM_ARCHIVE'
                    && tenant.retentionLegalHoldAt !== null;
                if (!holdWonPlatformArchive) {
                    this.assertNoLifecycleBarrier(tenant, current.kind);
                }
                if (terminalWebhookConverged) {
                    const finalized: TenantCancellationIntentRow = {
                        ...current,
                        state: 'FINALIZED',
                        providerMutationOwned,
                        providerResult: outcome,
                        providerLeaseOwner: null,
                        providerLeaseExpiresAt: null,
                    };
                    await this.recordFinalizedAudit(tx, finalized, tenant, outcome);
                    await this.writeIntent(tx, finalized);
                    return {
                        intent: finalized,
                        tenant,
                        providerLeaseOwner: null,
                    };
                }
                if (holdWonPlatformArchive && !providerMutationOwned) {
                    let blockedTenant = tenant;
                    if (outcome.action === 'already_canceled') {
                        blockedTenant = await tx.tenant.update({
                            where: { id: tenant.id },
                            data: {
                                status: TenantStatus.PAST_DUE,
                                stripeSubscriptionId: null,
                                stripeSubscriptionCurrentPeriodEnd: null,
                            },
                            select: {
                                id: true,
                                slug: true,
                                status: true,
                                deletedAt: true,
                                retentionLegalHoldAt: true,
                                stripeSubscriptionId: true,
                            },
                        }) as TenantCancellationSubject;
                    }
                    await this.recordLegalHoldBlockedAudit(tx, current, blockedTenant, {
                        providerCancellation: outcome,
                        providerMutationOwned,
                    });
                    const blocked: TenantCancellationIntentRow = {
                        ...current,
                        state: 'BLOCKED',
                        providerMutationOwned,
                        providerResult: outcome,
                        terminalReason: 'LEGAL_HOLD',
                        terminalizedAt: this.now(),
                        providerLeaseOwner: null,
                        providerLeaseExpiresAt: null,
                    };
                    await this.writeIntent(tx, blocked);
                    return {
                        intent: blocked,
                        tenant: blockedTenant,
                        providerLeaseOwner: null,
                    };
                }
                const applied: TenantCancellationIntentRow = {
                    ...current,
                    state: holdWonPlatformArchive
                        ? 'COMPENSATION_PENDING'
                        : 'PROVIDER_APPLIED',
                    providerMutationOwned,
                    providerResult: outcome,
                };
                await this.writeIntent(tx, applied);
                return { ...prepared, intent: applied };
            },
        );
    }

    async renewProviderClaim(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent> {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        const owner = prepared.providerLeaseOwner;
        if (!owner) throw new Error('Provider cancellation claim is unavailable.');
        return this.withIntentScope(
            prepared.intent.kind,
            prepared.tenant.id,
            async (tx) => {
                await this.lockTenantLifecycle(tx, prepared.tenant.id);
                const current = await this.findIntent(
                    tx,
                    prepared.tenant.id,
                    prepared.intent.kind,
                );
                if (
                    !current
                    || current.operationId !== prepared.intent.operationId
                    || (
                        !isRecoverableIntentState(current.state)
                        && !isFinalizedProviderReadbackDue(current, this.now())
                    )
                    || current.providerLeaseOwner !== owner
                ) {
                    throw new Error('Provider cancellation claim was lost.');
                }
                const renewed: TenantCancellationIntentRow = {
                    ...current,
                    providerLeaseExpiresAt: new Date(
                        this.now().getTime() + this.providerLeaseMs,
                    ),
                };
                await this.writeIntent(tx, renewed);
                return { ...prepared, intent: renewed };
            },
        );
    }

    providerLeaseRenewalIntervalMs(): number {
        return Math.max(10, Math.min(30_000, Math.floor(this.providerLeaseMs / 3)));
    }

    async markCompensated(
        prepared: PreparedTenantCancellationIntent,
        outcome: TenantCancellationCompensationOutcome,
    ): Promise<PreparedTenantCancellationIntent> {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        const owner = prepared.providerLeaseOwner;
        if (!owner) throw new Error('Provider cancellation claim is unavailable.');
        return this.withIntentScope('PLATFORM_ARCHIVE', prepared.tenant.id, async (tx) => {
            await this.lockTenantLifecycle(tx, prepared.tenant.id);
            const current = await this.findIntent(
                tx,
                prepared.tenant.id,
                'PLATFORM_ARCHIVE',
            );
            if (
                !current
                || current.operationId !== prepared.intent.operationId
                || current.state !== 'COMPENSATION_PENDING'
                || current.providerMutationOwned !== true
                || current.providerLeaseOwner !== owner
            ) {
                throw new Error('Provider cancellation compensation claim was lost.');
            }
            let tenant = await this.findTenantSubject(tx, prepared.tenant.id);
            const customerIntent = await this.findIntent(
                tx,
                prepared.tenant.id,
                'CUSTOMER_CANCELLATION',
            );
            const effectiveOutcome = outcome.action === 'already_terminal'
                && customerIntent
                && this.isFinalizedCustomerTerminalWinner(
                    customerIntent,
                    tenant,
                    current.providerSubscriptionId,
                )
                ? {
                    action: 'not_owned' as const,
                    cancelAtPeriodEnd: false,
                }
                : outcome;
            if (effectiveOutcome.action === 'already_terminal') {
                tenant = await tx.tenant.update({
                    where: { id: tenant.id },
                    data: {
                        status: TenantStatus.PAST_DUE,
                        stripeSubscriptionId: null,
                        stripeSubscriptionCurrentPeriodEnd: null,
                    },
                    select: {
                        id: true,
                        slug: true,
                        status: true,
                        deletedAt: true,
                        retentionLegalHoldAt: true,
                        stripeSubscriptionId: true,
                    },
                }) as TenantCancellationSubject;
            }
            await this.recordLegalHoldBlockedAudit(tx, current, tenant, {
                providerCancellationCompensation: effectiveOutcome,
            });
            const blocked: TenantCancellationIntentRow = {
                ...current,
                state: 'BLOCKED',
                compensationResult: effectiveOutcome,
                terminalReason: 'LEGAL_HOLD',
                terminalizedAt: this.now(),
                providerLeaseOwner: null,
                providerLeaseExpiresAt: null,
            };
            await this.writeIntent(tx, blocked);
            return {
                intent: blocked,
                tenant,
                providerLeaseOwner: null,
            };
        });
    }

    async releaseProviderClaim(prepared: PreparedTenantCancellationIntent): Promise<void> {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        if (!prepared.providerLeaseOwner) return;
        await this.withIntentScope(
            prepared.intent.kind,
            prepared.tenant.id,
            async (tx) => {
                await this.lockTenantLifecycle(tx, prepared.tenant.id);
                const current = await this.findIntent(
                    tx,
                    prepared.tenant.id,
                    prepared.intent.kind,
                );
                if (
                    current
                    && current.operationId === prepared.intent.operationId
                    && current.providerLeaseOwner === prepared.providerLeaseOwner
                ) {
                    await this.writeIntent(tx, {
                        ...current,
                        providerLeaseOwner: null,
                        providerLeaseExpiresAt: null,
                    });
                }
            },
        );
    }

    async finalize(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent> {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        return this.withIntentScope(
            prepared.intent.kind,
            prepared.tenant.id,
            async (tx) => {
                await this.lockTenantLifecycle(tx, prepared.tenant.id);
                const intent = await this.findIntent(
                    tx,
                    prepared.tenant.id,
                    prepared.intent.kind,
                );
                if (!intent || intent.operationId !== prepared.intent.operationId) {
                    throw new Error('Tenant lifecycle intent changed before finalization.');
                }
                if (intent.state === 'FINALIZED') {
                    return { ...prepared, intent, providerLeaseOwner: null };
                }
                if (
                    !prepared.providerLeaseOwner
                    || intent.providerLeaseOwner !== prepared.providerLeaseOwner
                ) {
                    throw new Error('Tenant lifecycle reconciliation claim was lost.');
                }
                if (intent.state !== 'PROVIDER_APPLIED') {
                    throw new Error('Provider cancellation is not durably applied.');
                }
                const outcome = parseCancellationOutcome(intent.providerResult);
                let tenant = await this.findTenantSubject(tx, prepared.tenant.id);
                const terminalWebhookConverged = this.isCustomerTerminalProviderConvergence(
                    intent,
                    outcome,
                    tenant,
                );
                if (!terminalWebhookConverged) {
                    this.assertSubscriptionUnchanged(intent, tenant);
                }
                this.assertNoLifecycleBarrier(tenant, intent.kind);

                if (intent.kind === 'PLATFORM_ARCHIVE') {
                    const archivedAt = tenant.deletedAt ?? new Date();
                    tenant = await tx.tenant.update({
                        where: { id: tenant.id },
                        data: { deletedAt: archivedAt, status: TenantStatus.CANCELLED },
                        select: {
                            id: true,
                            slug: true,
                            status: true,
                            deletedAt: true,
                            retentionLegalHoldAt: true,
                            stripeSubscriptionId: true,
                        },
                    }) as TenantCancellationSubject;
                    await tx.session.updateMany({
                        where: { user: { tenantId: tenant.id }, revokedAt: null },
                        data: { revokedAt: archivedAt },
                    });
                } else if (isTerminalCancellationOutcome(outcome) && !terminalWebhookConverged) {
                    tenant = await tx.tenant.update({
                        where: { id: tenant.id },
                        data: {
                            status: TenantStatus.CANCELLED,
                            stripeSubscriptionId: null,
                            stripeSubscriptionCurrentPeriodEnd: null,
                        },
                        select: {
                            id: true,
                            slug: true,
                            status: true,
                            deletedAt: true,
                            retentionLegalHoldAt: true,
                            stripeSubscriptionId: true,
                        },
                    }) as TenantCancellationSubject;
                }

                await this.recordFinalizedAudit(tx, intent, tenant, outcome);
                const finalized: TenantCancellationIntentRow = {
                    ...intent,
                    state: 'FINALIZED',
                    providerLeaseOwner: null,
                    providerLeaseExpiresAt: null,
                };
                await this.writeIntent(tx, finalized);
                return {
                    intent: finalized,
                    tenant,
                    providerLeaseOwner: null,
                };
            },
        );
    }

    async claimRecoverable(
        limit: number,
        excludedOperationIds: readonly string[] = [],
    ): Promise<PreparedTenantCancellationIntent[]> {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 1;
        const batchLimit = Math.max(
            1,
            Math.min(MAX_RECOVERY_BATCH_SIZE, normalizedLimit),
        );
        const now = this.now();
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            await this.terminalizeStaleIntents(tx, now);
            const exclusion = excludedOperationIds.length > 0
                ? Prisma.sql`AND setting."value"->>'operationId' NOT IN (${Prisma.join(excludedOperationIds)})`
                : Prisma.empty;
            const candidates = await tx.$queryRaw<Array<{
                id: string;
                tenantId: string;
                key: string;
            }>>(Prisma.sql`
                SELECT setting."id", setting."tenantId", setting."key"
                FROM "TenantSetting" setting
                JOIN "Tenant" tenant ON tenant."id" = setting."tenantId"
                WHERE setting."key" IN (${Prisma.join(TENANT_LIFECYCLE_INTENT_SETTING_KEYS)})
                  AND (
                      setting."value"->>'state' IN (
                          'PENDING_PROVIDER',
                          'PROVIDER_APPLIED',
                          'COMPENSATION_PENDING'
                      )
                      OR (
                          setting."value"->>'state' = 'FINALIZED'
                          AND setting."value"->>'kind' = 'CUSTOMER_CANCELLATION'
                          AND setting."value"->'providerResult'->>'action' IN (
                              'scheduled',
                              'already_scheduled'
                          )
                          AND setting."value"->'providerResult'->>'currentPeriodEnd'
                              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                          AND (setting."value"->'providerResult'->>'currentPeriodEnd')::timestamptz
                              <= ${now}
                      )
                  )
                  AND tenant."status"::text NOT IN ('PURGED', 'SUSPENDED')
                  AND setting."value"->>'subscriptionFingerprint' = encode(
                      public.digest(
                          convert_to(tenant."id", 'UTF8')
                              || decode('00', 'hex')
                              || convert_to(COALESCE(NULLIF(btrim(tenant."stripeSubscriptionId"), ''), 'none'), 'UTF8'),
                          'sha256'
                      ),
                      'hex'
                  )
                  AND (
                      (
                          setting."value"->>'state' = 'COMPENSATION_PENDING'
                          AND (
                              setting."value"->>'providerMutationOwned' = 'true'
                              OR setting."value"->'providerResult'->>'action' = 'scheduled'
                          )
                      )
                      OR setting."value"->>'kind' = 'CUSTOMER_CANCELLATION'
                      OR tenant."retentionLegalHoldAt" IS NULL
                      OR setting."value"->>'state' = 'PENDING_PROVIDER'
                  )
                  AND (
                      setting."value"->>'providerLeaseOwner' IS NULL
                      OR CASE
                          WHEN setting."value"->>'providerLeaseExpiresAt'
                              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                          THEN (setting."value"->>'providerLeaseExpiresAt')::timestamptz
                          ELSE 'infinity'::timestamptz
                      END <= ${now}
                  )
                  ${exclusion}
                ORDER BY setting."updatedAt" ASC, setting."id" ASC
                LIMIT ${batchLimit}
            `);
            const claimed: PreparedTenantCancellationIntent[] = [];

            for (const candidate of candidates) {
                await this.lockTenantLifecycle(tx, candidate.tenantId);
                const lockedRows = await tx.$queryRaw<Array<{
                    value: Prisma.JsonValue;
                }>>(Prisma.sql`
                    SELECT setting."value"
                    FROM "TenantSetting" setting
                    WHERE setting."id" = ${candidate.id}
                      AND setting."tenantId" = ${candidate.tenantId}
                      AND setting."key" = ${candidate.key}
                       AND (
                           setting."value"->>'state' IN (
                               'PENDING_PROVIDER',
                               'PROVIDER_APPLIED',
                               'COMPENSATION_PENDING'
                           )
                           OR (
                               setting."value"->>'state' = 'FINALIZED'
                               AND setting."value"->>'kind' = 'CUSTOMER_CANCELLATION'
                               AND setting."value"->'providerResult'->>'action' IN (
                                   'scheduled',
                                   'already_scheduled'
                               )
                               AND setting."value"->'providerResult'->>'currentPeriodEnd'
                                   ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                               AND (setting."value"->'providerResult'->>'currentPeriodEnd')::timestamptz
                                   <= ${now}
                           )
                       )
                      AND (
                          setting."value"->>'providerLeaseOwner' IS NULL
                          OR CASE
                              WHEN setting."value"->>'providerLeaseExpiresAt'
                                  ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                              THEN (setting."value"->>'providerLeaseExpiresAt')::timestamptz
                              ELSE 'infinity'::timestamptz
                          END <= ${now}
                      )
                    FOR UPDATE
                `);
                if (!lockedRows[0]) continue;

                let intent: TenantCancellationIntentRow;
                try {
                    intent = parseIntentSetting(lockedRows[0].value);
                } catch {
                    continue;
                }
                if (
                    intent.tenantId !== candidate.tenantId
                    || this.intentSettingKey(intent.kind) !== candidate.key
                ) continue;

                const tenant = await this.findTenantSubject(tx, candidate.tenantId);
                if (tenant.status === TenantStatus.PURGED || tenant.status === TenantStatus.SUSPENDED) {
                    continue;
                }
                if (
                    intent.state === 'COMPENSATION_PENDING'
                    && intent.providerMutationOwned !== true
                ) continue;
                if (
                    intent.state !== 'COMPENSATION_PENDING'
                    && intent.state !== 'PENDING_PROVIDER'
                    && intent.kind === 'PLATFORM_ARCHIVE'
                    && tenant.retentionLegalHoldAt
                ) continue;
                if (
                    intent.subscriptionFingerprint
                    !== this.subscriptionFingerprint(tenant.id, tenant.stripeSubscriptionId)
                ) {
                    continue;
                }
                if (
                    intent.state === 'FINALIZED'
                    && !isFinalizedProviderReadbackDue(intent, now)
                ) continue;

                const providerLeaseOwner = randomUUID();
                const providerLeaseExpiresAt = new Date(
                    now.getTime() + this.providerLeaseMs,
                );
                const updatedRows = await tx.$queryRaw<Array<{
                    value: Prisma.JsonValue;
                }>>(Prisma.sql`
                    UPDATE "TenantSetting" setting
                    SET "value" = setting."value" || jsonb_build_object(
                            'providerLeaseOwner', ${providerLeaseOwner},
                            'providerLeaseExpiresAt', ${providerLeaseExpiresAt.toISOString()},
                            'providerAttempts', ${intent.providerAttempts + 1}
                        ),
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE setting."id" = ${candidate.id}
                      AND setting."tenantId" = ${candidate.tenantId}
                      AND setting."key" = ${candidate.key}
                      AND setting."value"->>'operationId' = ${intent.operationId}
                      AND setting."value"->>'state' = ${intent.state}
                      AND setting."value"->>'providerAttempts' = ${String(intent.providerAttempts)}
                      AND setting."value"->>'providerLeaseOwner'
                          IS NOT DISTINCT FROM CAST(${intent.providerLeaseOwner} AS TEXT)
                      AND setting."value"->>'providerLeaseExpiresAt'
                          IS NOT DISTINCT FROM CAST(${intent.providerLeaseExpiresAt?.toISOString() ?? null} AS TEXT)
                    RETURNING setting."value"
                `);
                if (!updatedRows[0]) continue;

                const claimedIntent = parseIntentSetting(updatedRows[0].value);
                claimed.push({
                    intent: claimedIntent,
                    tenant,
                    providerLeaseOwner,
                });
            }

            return claimed;
        });
    }

    async countBacklog(): Promise<number> {
        return this.tenantDb.withPlatformAdmin(async (tx) => {
            const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
                SELECT COUNT(*)::integer AS "count"
                FROM "TenantSetting" setting
                JOIN "Tenant" tenant ON tenant."id" = setting."tenantId"
                WHERE setting."key" IN (${Prisma.join(TENANT_LIFECYCLE_INTENT_SETTING_KEYS)})
                  AND (
                      setting."value"->>'state' IN (
                          'PENDING_PROVIDER',
                          'PROVIDER_APPLIED',
                          'COMPENSATION_PENDING'
                      )
                      OR (
                          setting."value"->>'state' = 'FINALIZED'
                          AND setting."value"->>'kind' = 'CUSTOMER_CANCELLATION'
                          AND setting."value"->'providerResult'->>'action' IN (
                              'scheduled',
                              'already_scheduled'
                          )
                          AND setting."value"->'providerResult'->>'currentPeriodEnd'
                              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                          AND (setting."value"->'providerResult'->>'currentPeriodEnd')::timestamptz
                              <= ${this.now()}
                      )
                  )
                  AND tenant."status"::text NOT IN ('PURGED', 'SUSPENDED')
                  AND setting."value"->>'subscriptionFingerprint' = encode(
                      public.digest(
                          convert_to(tenant."id", 'UTF8')
                              || decode('00', 'hex')
                              || convert_to(COALESCE(NULLIF(btrim(tenant."stripeSubscriptionId"), ''), 'none'), 'UTF8'),
                          'sha256'
                      ),
                      'hex'
                  )
                  AND (
                      (
                          setting."value"->>'state' = 'COMPENSATION_PENDING'
                          AND (
                              setting."value"->>'providerMutationOwned' = 'true'
                              OR setting."value"->'providerResult'->>'action' = 'scheduled'
                          )
                      )
                      OR setting."value"->>'kind' = 'CUSTOMER_CANCELLATION'
                      OR tenant."retentionLegalHoldAt" IS NULL
                      OR setting."value"->>'state' = 'PENDING_PROVIDER'
                  )
            `);
            return Number(rows[0]?.count ?? 0);
        });
    }

    private async terminalizeStaleIntents(
        tx: TenantPrismaTransaction,
        now: Date,
    ): Promise<void> {
        await tx.$executeRaw(Prisma.sql`
            WITH stale AS (
                SELECT
                    setting."id",
                    CASE
                        WHEN tenant."status"::text IN ('PURGED', 'SUSPENDED') THEN 'BLOCKED'
                        WHEN setting."value"->>'subscriptionFingerprint' IS DISTINCT FROM encode(
                            public.digest(
                                convert_to(tenant."id", 'UTF8')
                                    || decode('00', 'hex')
                                    || convert_to(COALESCE(NULLIF(btrim(tenant."stripeSubscriptionId"), ''), 'none'), 'UTF8'),
                                'sha256'
                            ),
                            'hex'
                        ) THEN 'SUPERSEDED'
                        WHEN setting."value"->>'kind' = 'PLATFORM_ARCHIVE'
                          AND tenant."retentionLegalHoldAt" IS NOT NULL
                          AND (
                              setting."value"->>'providerMutationOwned' = 'true'
                              OR setting."value"->'providerResult'->>'action' = 'scheduled'
                          ) THEN 'COMPENSATION_PENDING'
                        ELSE 'BLOCKED'
                    END AS "nextState",
                    CASE
                        WHEN tenant."status"::text IN ('PURGED', 'SUSPENDED') THEN 'LIFECYCLE_BARRIER'
                        WHEN setting."value"->>'subscriptionFingerprint' IS DISTINCT FROM encode(
                            public.digest(
                                convert_to(tenant."id", 'UTF8')
                                    || decode('00', 'hex')
                                    || convert_to(COALESCE(NULLIF(btrim(tenant."stripeSubscriptionId"), ''), 'none'), 'UTF8'),
                                'sha256'
                            ),
                            'hex'
                        ) THEN 'SUBSCRIPTION_CHANGED'
                        WHEN setting."value"->>'kind' = 'PLATFORM_ARCHIVE'
                          AND tenant."retentionLegalHoldAt" IS NOT NULL THEN 'LEGAL_HOLD'
                        ELSE 'LIFECYCLE_BARRIER'
                    END AS "terminalReason"
                FROM "TenantSetting" setting
                JOIN "Tenant" tenant ON tenant."id" = setting."tenantId"
                WHERE setting."key" IN (${Prisma.join(TENANT_LIFECYCLE_INTENT_SETTING_KEYS)})
                  AND setting."value"->>'state' IN (
                      'PENDING_PROVIDER',
                      'PROVIDER_APPLIED',
                      'COMPENSATION_PENDING'
                  )
                  AND (
                      setting."value"->>'providerLeaseOwner' IS NULL
                      OR CASE
                          WHEN setting."value"->>'providerLeaseExpiresAt'
                              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
                          THEN (setting."value"->>'providerLeaseExpiresAt')::timestamptz
                          ELSE 'infinity'::timestamptz
                      END <= ${now}
                  )
                  AND (
                      tenant."status"::text IN ('PURGED', 'SUSPENDED')
                      OR setting."value"->>'subscriptionFingerprint' IS DISTINCT FROM encode(
                          public.digest(
                              convert_to(tenant."id", 'UTF8')
                                  || decode('00', 'hex')
                                  || convert_to(COALESCE(NULLIF(btrim(tenant."stripeSubscriptionId"), ''), 'none'), 'UTF8'),
                              'sha256'
                          ),
                          'hex'
                      )
                      OR (
                          setting."value"->>'kind' = 'PLATFORM_ARCHIVE'
                          AND tenant."retentionLegalHoldAt" IS NOT NULL
                          AND NOT (
                              setting."value"->>'state' = 'PENDING_PROVIDER'
                              AND setting."value"->'providerResult' = 'null'::jsonb
                          )
                      )
                  )
            ), updated AS (
            UPDATE "TenantSetting" setting
            SET "value" = (
                    setting."value"
                    - 'providerLeaseOwner'
                    - 'providerLeaseExpiresAt'
                    - 'terminalReason'
                    - 'terminalizedAt'
                ) || jsonb_build_object(
                    'state', stale."nextState",
                    'providerLeaseOwner', NULL,
                    'providerLeaseExpiresAt', NULL,
                    'terminalReason', CASE
                        WHEN stale."nextState" = 'COMPENSATION_PENDING' THEN NULL
                        ELSE stale."terminalReason"
                    END,
                    'terminalizedAt', CASE
                        WHEN stale."nextState" = 'COMPENSATION_PENDING' THEN NULL
                        ELSE ${now.toISOString()}
                    END
                ),
                "updatedAt" = CURRENT_TIMESTAMP
            FROM stale
            WHERE setting."id" = stale."id"
            RETURNING setting."tenantId", setting."value"
            )
            UPDATE "TenantSetting" receipt
            SET "value" = receipt."value" || jsonb_build_object(
                    'state', CASE WHEN updated."value"->>'state' = 'SUPERSEDED'
                        THEN 'SUPERSEDED' ELSE 'BLOCKED' END,
                    'updatedAt', ${now.toISOString()}
                ), "updatedAt" = CURRENT_TIMESTAMP
            FROM updated
            WHERE updated."value"->>'kind' = 'CUSTOMER_CANCELLATION'
              AND receipt."tenantId" = updated."tenantId"
              AND receipt."key" = 'internal:account-lifecycle-request:' || (updated."value"->>'operationId')
        `);
    }

    private async resetIntent(
        tx: TenantPrismaTransaction,
        input: PrepareIntentInput & {
            operationId: string;
            providerSubscriptionId: string | null;
            subscriptionFingerprint: string;
        },
        assertCurrent: () => void,
    ): Promise<TenantCancellationIntentRow> {
        const actorUserId = input.actor.userId?.trim();
        if (!actorUserId) {
            throw new BadRequestException('Tenant lifecycle actor is required.');
        }
        const intent: TenantCancellationIntentRow = {
            tenantId: input.tenantId,
            kind: input.kind,
            operationId: input.operationId,
            state: 'PENDING_PROVIDER',
            actorUserId,
            actorTenantId: input.actor.tenantId,
            ipAddress: stringOrNull(input.actor.ipAddress),
            userAgent: stringOrNull(input.actor.userAgent),
            reason: input.reason ?? null,
            providerSubscriptionId: input.providerSubscriptionId,
            subscriptionFingerprint: input.subscriptionFingerprint,
            providerLeaseOwner: null,
            providerLeaseExpiresAt: null,
            providerAttempts: 0,
            providerMutationOwned: null,
            providerResult: null,
            compensationResult: null,
            terminalReason: null,
            terminalizedAt: null,
        };
        assertCurrent();
        await this.writeIntent(tx, intent, assertCurrent);
        assertCurrent();
        return intent;
    }

    private async findIntent(
        tx: TenantPrismaTransaction,
        tenantId: string,
        kind: TenantCancellationIntentKind,
    ): Promise<TenantCancellationIntentRow | null> {
        const setting = await tx.tenantSetting.findUnique({
            where: {
                tenantId_key: {
                    tenantId,
                    key: this.intentSettingKey(kind),
                },
            },
            select: { value: true },
        });
        return setting ? parseIntentSetting(setting.value) : null;
    }

    private async findTenantSubject(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ): Promise<TenantCancellationSubject> {
        return tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: {
                id: true,
                slug: true,
                status: true,
                deletedAt: true,
                retentionLegalHoldAt: true,
                stripeSubscriptionId: true,
            },
        }) as Promise<TenantCancellationSubject>;
    }

    private async writeIntent(
        tx: TenantPrismaTransaction,
        intent: TenantCancellationIntentRow,
        assertCurrent: () => void = () => undefined,
    ): Promise<void> {
        assertCurrent();
        const value = serializeIntentSetting(intent);
        await tx.tenantSetting.upsert({
            where: {
                tenantId_key: {
                    tenantId: intent.tenantId,
                    key: this.intentSettingKey(intent.kind),
                },
            },
            create: {
                tenantId: intent.tenantId,
                key: this.intentSettingKey(intent.kind),
                value,
            },
            update: { value },
        });
        assertCurrent();
        if (intent.kind === 'CUSTOMER_CANCELLATION') {
            await recordAccountLifecycleRequest(tx, {
                tenantId: intent.tenantId, requestId: intent.operationId, kind: 'CANCELLATION',
                state: intent.state === 'FINALIZED' ? 'COMPLETED'
                    : intent.state === 'BLOCKED' ? 'BLOCKED'
                        : intent.state === 'SUPERSEDED' ? 'SUPERSEDED' : 'PENDING',
            }, assertCurrent);
            assertCurrent();
        }
    }

    private async recordLegalHoldBlockedAudit(
        tx: TenantPrismaTransaction,
        intent: TenantCancellationIntentRow,
        tenant: TenantCancellationSubject,
        result: Prisma.InputJsonObject,
    ): Promise<void> {
        await tx.auditLog.create({
            data: {
                tenantId: tenant.id,
                userId: intent.actorTenantId === tenant.id
                    ? intent.actorUserId
                    : null,
                actorUserId: intent.actorUserId,
                actorTenantId: intent.actorTenantId,
                action: 'TENANT_ARCHIVE_BLOCKED_BY_LEGAL_HOLD',
                resource: 'Tenant',
                resourceId: tenant.id,
                newValue: {
                    operationId: intent.operationId,
                    ...result,
                },
                ipAddress: intent.ipAddress,
                userAgent: intent.userAgent,
            },
        });
    }

    private async recordFinalizedAudit(
        tx: TenantPrismaTransaction,
        intent: TenantCancellationIntentRow,
        tenant: TenantCancellationSubject,
        outcome: TenantCancellationOutcome,
    ): Promise<void> {
        await tx.auditLog.create({
            data: {
                tenantId: tenant.id,
                userId: intent.actorTenantId === tenant.id
                    ? intent.actorUserId
                    : null,
                actorUserId: intent.actorUserId,
                actorTenantId: intent.actorTenantId,
                action: intent.kind === 'CUSTOMER_CANCELLATION'
                    ? isTerminalCancellationOutcome(outcome)
                        ? 'TENANT_CANCELLATION_COMPLETED_BY_CUSTOMER'
                        : 'TENANT_CANCELLATION_SCHEDULED_BY_CUSTOMER'
                    : 'TENANT_ARCHIVED',
                resource: 'Tenant',
                resourceId: tenant.id,
                newValue: {
                    operationId: intent.operationId,
                    ...(intent.reason ? { reason: intent.reason } : {}),
                    billingCancellation: outcome,
                },
                ipAddress: intent.ipAddress,
                userAgent: intent.userAgent,
            },
        });
    }

    private intentSettingKey(kind: TenantCancellationIntentKind): string {
        return `${TENANT_LIFECYCLE_INTENT_SETTING_PREFIX}${kind.toLowerCase()}`;
    }

    private async lockTenantLifecycle(
        tx: TenantPrismaTransaction,
        tenantId: string,
    ): Promise<void> {
        await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${tenantId})`;
    }

    private assertNoLifecycleBarrier(
        tenant: TenantCancellationSubject,
        kind: TenantCancellationIntentKind,
    ): void {
        if (tenant.status === TenantStatus.PURGED) {
            throw new BadRequestException('Tenant deletion has already been requested.');
        }
        if (tenant.status === TenantStatus.SUSPENDED) {
            throw new BadRequestException(
                'Tenant deletion billing cleanup is already pending.',
            );
        }
        if (kind === 'PLATFORM_ARCHIVE' && tenant.retentionLegalHoldAt) {
            throw new BadRequestException(
                'Tenant archive is blocked by an active retention legal hold.',
            );
        }
    }

    private assertSubscriptionUnchanged(
        intent: TenantCancellationIntentRow,
        tenant: TenantCancellationSubject,
    ): void {
        if (
            intent.subscriptionFingerprint
            !== this.subscriptionFingerprint(tenant.id, tenant.stripeSubscriptionId)
        ) {
            throw new Error('Tenant billing subscription changed during reconciliation.');
        }
    }

    private isCustomerTerminalProviderConvergence(
        intent: TenantCancellationIntentRow,
        outcome: TenantCancellationOutcome,
        tenant: TenantCancellationSubject,
    ): boolean {
        return intent.kind === 'CUSTOMER_CANCELLATION'
            && outcome.action === 'already_canceled'
            && intent.providerSubscriptionId !== null
            && tenant.status === TenantStatus.CANCELLED
            && tenant.deletedAt === null
            && tenant.stripeSubscriptionId === null;
    }

    private isFinalizedCustomerWebhookConvergence(
        intent: TenantCancellationIntentRow,
        tenant: TenantCancellationSubject,
    ): boolean {
        return intent.state === 'FINALIZED'
            && intent.kind === 'CUSTOMER_CANCELLATION'
            && intent.providerSubscriptionId !== null
            && isScheduledCancellationOutcome(intent.providerResult)
            && tenant.status === TenantStatus.CANCELLED
            && tenant.deletedAt === null
            && tenant.stripeSubscriptionId === null;
    }

    private isFinalizedCustomerTerminalWinner(
        intent: TenantCancellationIntentRow,
        tenant: TenantCancellationSubject,
        subscriptionId: string | null,
    ): boolean {
        return intent.state === 'FINALIZED'
            && intent.kind === 'CUSTOMER_CANCELLATION'
            && subscriptionId !== null
            && intent.providerSubscriptionId === subscriptionId
            && (
                isScheduledCancellationOutcome(intent.providerResult)
                || isTerminalCancellationOutcome(intent.providerResult)
            )
            && tenant.status === TenantStatus.CANCELLED
            && tenant.deletedAt === null
            && tenant.stripeSubscriptionId === null;
    }

    private withIntentScope<T>(
        kind: TenantCancellationIntentKind,
        tenantId: string,
        operation: (tx: TenantPrismaTransaction) => Promise<T>,
    ): Promise<T> {
        return kind === 'PLATFORM_ARCHIVE'
            ? this.tenantDb.withPlatformAdmin(operation)
            : this.tenantDb.withTenant(tenantId, operation);
    }

    private subscriptionFingerprint(
        tenantId: string,
        subscriptionId: string | null,
    ): string {
        return createHash('sha256')
            .update(`${tenantId}\0${subscriptionId?.trim() || 'none'}`)
            .digest('hex');
    }
}

function serializeIntentSetting(
    intent: TenantCancellationIntentRow,
): Prisma.InputJsonObject {
    return {
        tenantId: intent.tenantId,
        kind: intent.kind,
        operationId: intent.operationId,
        state: intent.state,
        actorUserId: intent.actorUserId,
        actorTenantId: intent.actorTenantId,
        ipAddress: intent.ipAddress,
        userAgent: intent.userAgent,
        reason: intent.reason,
        providerSubscriptionId: intent.providerSubscriptionId,
        subscriptionFingerprint: intent.subscriptionFingerprint,
        providerLeaseOwner: intent.providerLeaseOwner,
        providerLeaseExpiresAt: intent.providerLeaseExpiresAt?.toISOString() ?? null,
        providerAttempts: intent.providerAttempts,
        providerMutationOwned: intent.providerMutationOwned,
        providerResult: intent.providerResult as Prisma.InputJsonValue | null,
        compensationResult: intent.compensationResult as Prisma.InputJsonValue | null,
        terminalReason: intent.terminalReason,
        terminalizedAt: intent.terminalizedAt?.toISOString() ?? null,
    };
}

function parseIntentSetting(value: Prisma.JsonValue): TenantCancellationIntentRow {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Tenant lifecycle intent is malformed.');
    }
    const record = value as Record<string, unknown>;
    const kinds: TenantCancellationIntentKind[] = [
        'CUSTOMER_CANCELLATION',
        'PLATFORM_ARCHIVE',
    ];
    const states: TenantCancellationIntentRow['state'][] = [
        'PENDING_PROVIDER',
        'PROVIDER_APPLIED',
        'COMPENSATION_PENDING',
        'FINALIZED',
        'BLOCKED',
        'SUPERSEDED',
    ];
    if (!kinds.includes(record.kind as TenantCancellationIntentKind)) {
        throw new Error('Tenant lifecycle intent kind is malformed.');
    }
    if (!states.includes(record.state as TenantCancellationIntentRow['state'])) {
        throw new Error('Tenant lifecycle intent state is malformed.');
    }
    const providerAttempts = record.providerAttempts;
    if (!Number.isInteger(providerAttempts) || Number(providerAttempts) < 0) {
        throw new Error('Tenant lifecycle intent attempts are malformed.');
    }
    const lease = nullableDate(record.providerLeaseExpiresAt);
    const intent: TenantCancellationIntentRow = {
        tenantId: requiredString(record.tenantId),
        kind: record.kind as TenantCancellationIntentKind,
        operationId: requiredString(record.operationId),
        state: record.state as TenantCancellationIntentRow['state'],
        actorUserId: requiredString(record.actorUserId),
        actorTenantId: requiredString(record.actorTenantId),
        ipAddress: stringOrNull(record.ipAddress),
        userAgent: stringOrNull(record.userAgent),
        reason: stringOrNull(record.reason),
        providerSubscriptionId: stringOrNull(record.providerSubscriptionId),
        subscriptionFingerprint: requiredString(record.subscriptionFingerprint),
        providerLeaseOwner: stringOrNull(record.providerLeaseOwner),
        providerLeaseExpiresAt: lease,
        providerAttempts: Number(providerAttempts),
        providerMutationOwned: parseProviderMutationOwnership(
            record.providerMutationOwned,
            record.providerResult,
        ),
        providerResult: record.providerResult ?? null,
        compensationResult: record.compensationResult ?? null,
        terminalReason: stringOrNull(record.terminalReason),
        terminalizedAt: nullableDate(record.terminalizedAt),
    };
    if (
        (intent.providerLeaseOwner === null) !==
        (intent.providerLeaseExpiresAt === null)
    ) {
        throw new Error('Tenant lifecycle provider lease is malformed.');
    }
    if (
        intent.state === 'PENDING_PROVIDER'
        && intent.providerResult !== null
    ) {
        throw new Error('Tenant lifecycle provider state is malformed.');
    }
    if (
        ['PROVIDER_APPLIED', 'FINALIZED'].includes(intent.state)
        && intent.providerResult === null
    ) {
        throw new Error('Tenant lifecycle provider state is malformed.');
    }
    return intent;
}

function isRecoverableIntentState(
    state: TenantCancellationIntentRow['state'],
): boolean {
    return [
        'PENDING_PROVIDER',
        'PROVIDER_APPLIED',
        'COMPENSATION_PENDING',
    ].includes(state);
}

function nullableDate(value: unknown): Date | null {
    const text = stringOrNull(value);
    if (text === null) return null;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
        throw new Error('Tenant lifecycle provider lease is malformed.');
    }
    return date;
}

function requiredString(value: unknown): string {
    const text = stringOrNull(value);
    if (!text) throw new Error('Tenant lifecycle intent is malformed.');
    return text;
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseProviderMutationOwnership(
    value: unknown,
    providerResult: unknown,
): boolean | null {
    if (value === true) return true;
    if (
        providerResult
        && typeof providerResult === 'object'
        && !Array.isArray(providerResult)
        && (providerResult as Record<string, unknown>).action === 'scheduled'
    ) {
        return true;
    }
    if (value === false) return false;
    if (!providerResult || typeof providerResult !== 'object' || Array.isArray(providerResult)) {
        return null;
    }
    return false;
}

export class TenantCancellationLifecycleService {
    private readonly store: TenantCancellationIntentStore;

    constructor(
        tenantDb: TenantPrismaService,
        private readonly stripeBilling: () => Pick<
            StripeService,
            'cancelTenantSubscriptionAtPeriodEnd'
        > & Partial<Pick<StripeService, 'compensateTenantSubscriptionCancellation'>>,
        store?: TenantCancellationIntentStore,
        rbac?: RbacService,
        mfaObserver?: MfaSessionObserver,
    ) {
        this.store = store ?? new PrismaTenantCancellationIntentStore(tenantDb, undefined, undefined, rbac, mfaObserver);
    }

    async cancelCustomer(
        actor: TenantLifecycleActor,
        body: { confirmation?: unknown; reason?: unknown },
    ) {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        const confirmation = normalizeTenantConfirmation(body?.confirmation);
        const reason = typeof body?.reason === 'string' && body.reason.trim()
            ? body.reason.trim().slice(0, 500)
            : null;
        const prepared = await this.store.prepare({
            kind: 'CUSTOMER_CANCELLATION',
            tenantId: actor.tenantId,
            actor,
            confirmation,
            reason,
        });
        const finalized = await this.reconcilePrepared(prepared);
        const outcome = parseCancellationOutcome(finalized.intent.providerResult);
        return {
            id: finalized.tenant.id,
            slug: finalized.tenant.slug,
            status: finalized.tenant.status,
            cancellationEffectiveAt: outcome.currentPeriodEnd,
            requestId: finalized.intent.operationId,
            billingCancellation: outcome,
        };
    }

    async archivePlatform(
        actor: TenantPlatformArchiveActor,
        tenantId: string,
    ) {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        const capturedActor = capturePlatformTenantActor(actor);
        const prepared = await this.store.prepare({
            kind: 'PLATFORM_ARCHIVE',
            tenantId,
            actor: capturedActor,
        });
        const finalized = await this.reconcilePrepared(prepared);
        return {
            id: finalized.tenant.id,
            archived: finalized.tenant.status === TenantStatus.CANCELLED
                && finalized.tenant.deletedAt !== null,
        };
    }

    async reconcilePrepared(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent> {
        requireOrdinaryProducer('unadmitted lifecycle or provider effect');
        let current = prepared;
        if (['BLOCKED', 'SUPERSEDED'].includes(current.intent.state)) {
            return current;
        }
        if (current.intent.state === 'FINALIZED') {
            if (!current.providerLeaseOwner) return current;
            return this.reconcileFinalizedProviderReadback(current);
        }
        if (!current.providerLeaseOwner) {
            throw this.pendingReconciliation();
        }
        if (current.intent.state === 'COMPENSATION_PENDING') {
            return this.compensatePrepared(current);
        }
        if (
            current.intent.state === 'PROVIDER_APPLIED'
            && isTerminalCancellationOutcome(current.intent.providerResult)
        ) {
            try {
                return await this.store.finalize(current);
            } catch {
                await this.store.releaseProviderClaim(current).catch(() => undefined);
                throw this.pendingReconciliation();
            }
        }
        let attempt: TenantCancellationProviderAttempt;
        try {
            const provider = await this.withProviderClaimHeartbeat(
                current,
                (renewed) => this.cancelAtPeriodEnd(renewed),
            );
            current = provider.prepared;
            attempt = provider.value;
        } catch {
            await this.store.releaseProviderClaim(current).catch(() => undefined);
            throw this.pendingReconciliation();
        }
        try {
            current = await this.store.markProviderApplied(
                current,
                attempt.outcome,
                attempt.providerMutationOwned,
            );
        } catch {
            throw this.pendingReconciliation();
        }
        if (['FINALIZED', 'BLOCKED', 'SUPERSEDED'].includes(current.intent.state)) {
            return current;
        }
        if (current.intent.state === 'COMPENSATION_PENDING') {
            return this.compensatePrepared(current);
        }
        try {
            return await this.store.finalize(current);
        } catch {
            await this.store.releaseProviderClaim(current).catch(() => undefined);
            throw this.pendingReconciliation();
        }
    }

    private async cancelAtPeriodEnd(
        prepared: PreparedTenantCancellationIntent,
        providerReadbackOnly = false,
    ): Promise<TenantCancellationProviderAttempt> {
        const subscriptionId = prepared.intent.providerSubscriptionId
            ?? prepared.tenant.stripeSubscriptionId?.trim()
            ?? null;
        if (!subscriptionId) {
            return {
                outcome: {
                    action: 'none',
                    cancelAtPeriodEnd: false,
                    currentPeriodEnd: null,
                    cancelAt: null,
                    canceledAt: null,
                    cancellationBehavior: 'cancel_at_period_end',
                },
                providerMutationOwned: false,
            };
        }
        const readbackOnly = providerReadbackOnly || (
            prepared.intent.kind === 'PLATFORM_ARCHIVE'
            && prepared.tenant.retentionLegalHoldAt !== null
        );
        const billing = this.stripeBilling();
        let result: TenantSubscriptionCancellationResult;
        if (readbackOnly) {
            result = await billing.cancelTenantSubscriptionAtPeriodEnd(
                prepared.tenant.id,
                subscriptionId,
                prepared.intent.operationId,
                { providerReadbackOnly: true },
            );
        } else if (prepared.intent.kind === 'CUSTOMER_CANCELLATION') {
            result = await billing.cancelTenantSubscriptionAtPeriodEnd(
                prepared.tenant.id,
                subscriptionId,
                prepared.intent.operationId,
                { authoritativeCustomerCancellation: true },
            );
        } else {
            result = await billing.cancelTenantSubscriptionAtPeriodEnd(
                prepared.tenant.id,
                subscriptionId,
                prepared.intent.operationId,
            );
        }
        return {
            outcome: sanitizeCancellationOutcome(result),
            providerMutationOwned: result.providerMutationOwned === true
                || result.action === 'scheduled',
        };
    }

    private async reconcileFinalizedProviderReadback(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent> {
        let current = prepared;
        try {
            const provider = await this.withProviderClaimHeartbeat(
                current,
                (renewed) => this.cancelAtPeriodEnd(renewed, true),
            );
            current = provider.prepared;
            return await this.store.markProviderApplied(
                current,
                provider.value.outcome,
                provider.value.providerMutationOwned,
            );
        } catch {
            await this.store.releaseProviderClaim(current).catch(() => undefined);
            throw this.pendingReconciliation();
        }
    }

    private async compensatePrepared(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent> {
        let current = prepared;
        try {
            const provider = await this.withProviderClaimHeartbeat(
                current,
                async (renewed) => {
                    const subscriptionId = renewed.intent.providerSubscriptionId;
                    if (!subscriptionId) {
                        return {
                            action: 'none',
                            cancelAtPeriodEnd: false,
                        } as TenantCancellationCompensationOutcome;
                    }
                    const billing = this.stripeBilling();
                    const compensation = billing.compensateTenantSubscriptionCancellation;
                    if (!compensation) {
                        throw new Error('Tenant cancellation compensation provider is unavailable.');
                    }
                    const result = await compensation.call(
                        billing,
                            renewed.tenant.id,
                            subscriptionId,
                            renewed.intent.operationId,
                    );
                    return sanitizeCompensationOutcome(result);
                },
            );
            current = provider.prepared;
            return await this.store.markCompensated(current, provider.value);
        } catch {
            await this.store.releaseProviderClaim(current).catch(() => undefined);
            throw this.pendingReconciliation();
        }
    }

    private async withProviderClaimHeartbeat<T>(
        prepared: PreparedTenantCancellationIntent,
        operation: (renewed: PreparedTenantCancellationIntent) => Promise<T>,
    ): Promise<{ prepared: PreparedTenantCancellationIntent; value: T }> {
        let current = await this.store.renewProviderClaim(prepared);
        const intervalMs = this.store.providerLeaseRenewalIntervalMs();
        let stopped = false;
        let timer: NodeJS.Timeout | undefined;
        let renewalFailure: unknown;
        let renewalInFlight: Promise<void> = Promise.resolve();

        const scheduleRenewal = () => {
            timer = setTimeout(() => {
                renewalInFlight = this.store.renewProviderClaim(current)
                    .then((renewed) => {
                        current = renewed;
                    })
                    .catch((error) => {
                        renewalFailure = error;
                    })
                    .finally(() => {
                        if (!stopped && !renewalFailure) scheduleRenewal();
                    });
                renewalInFlight.catch(() => undefined);
            }, intervalMs);
            timer.unref();
        };

        scheduleRenewal();
        try {
            const value = await operation(current);
            stopped = true;
            if (timer) clearTimeout(timer);
            await renewalInFlight;
            if (renewalFailure) throw renewalFailure;
            current = await this.store.renewProviderClaim(current);
            return { prepared: current, value };
        } finally {
            stopped = true;
            if (timer) clearTimeout(timer);
            await renewalInFlight.catch(() => undefined);
        }
    }

    private pendingReconciliation(): ServiceUnavailableException {
        return new ServiceUnavailableException(
            'Tenant billing lifecycle is pending reconciliation.',
        );
    }
}

function sanitizeCancellationOutcome(
    value: TenantSubscriptionCancellationResult,
): TenantCancellationOutcome {
    return parseCancellationOutcome(value);
}

function sanitizeCompensationOutcome(
    value: TenantSubscriptionCancellationCompensationResult,
): TenantCancellationCompensationOutcome {
    if (!value || typeof value !== 'object') {
        throw new Error('Tenant cancellation compensation outcome is unavailable.');
    }
    const actions = [
        'none',
        'already_unscheduled',
        'not_owned',
        'unscheduled',
        'already_terminal',
    ] as const;
    if (!actions.includes(value.action as typeof actions[number])) {
        throw new Error('Tenant cancellation compensation action is invalid.');
    }
    if (typeof value.cancelAtPeriodEnd !== 'boolean') {
        throw new Error('Tenant cancellation compensation state is invalid.');
    }
    return {
        action: value.action,
        cancelAtPeriodEnd: value.cancelAtPeriodEnd,
    };
}

function parseCancellationOutcome(value: unknown): TenantCancellationOutcome {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Tenant cancellation outcome is unavailable.');
    }
    const result = value as Record<string, unknown>;
    const actions = ['none', 'already_canceled', 'already_scheduled', 'scheduled'] as const;
    if (!actions.includes(result.action as typeof actions[number])) {
        throw new Error('Tenant cancellation outcome action is invalid.');
    }
    if (typeof result.cancelAtPeriodEnd !== 'boolean') {
        throw new Error('Tenant cancellation outcome state is invalid.');
    }
    return {
        action: result.action as TenantCancellationOutcome['action'],
        cancelAtPeriodEnd: result.cancelAtPeriodEnd,
        currentPeriodEnd: nullableString(result.currentPeriodEnd),
        cancelAt: nullableString(result.cancelAt),
        canceledAt: nullableString(result.canceledAt),
        cancellationBehavior: 'cancel_at_period_end',
    };
}

function isTerminalCancellationOutcome(value: unknown): boolean {
    try {
        return parseCancellationOutcome(value).action === 'already_canceled';
    } catch {
        return false;
    }
}

function isScheduledCancellationOutcome(value: unknown): boolean {
    try {
        return ['scheduled', 'already_scheduled'].includes(
            parseCancellationOutcome(value).action,
        );
    } catch {
        return false;
    }
}

function terminalizeCancellationOutcome(
    outcome: TenantCancellationOutcome,
): TenantCancellationOutcome {
    return {
        ...outcome,
        action: 'already_canceled',
        cancelAtPeriodEnd: false,
    };
}

function isFinalizedProviderReadbackDue(
    intent: TenantCancellationIntentRow,
    now: Date,
): boolean {
    if (
        intent.state !== 'FINALIZED'
        || intent.kind !== 'CUSTOMER_CANCELLATION'
        || !isScheduledCancellationOutcome(intent.providerResult)
    ) return false;
    const outcome = parseCancellationOutcome(intent.providerResult);
    if (!outcome.currentPeriodEnd) return false;
    const effectiveAt = new Date(outcome.currentPeriodEnd);
    return !Number.isNaN(effectiveAt.getTime())
        && effectiveAt.getTime() <= now.getTime();
}

function nullableString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
        throw new Error('Tenant cancellation outcome timestamp is invalid.');
    }
    return value;
}

// Same canonical JSON encoding as the signed owner protocol; hashes identify projected receipts only.
function canonicalCancellationReceipt(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalCancellationReceipt).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const fields = value as Record<string, unknown>;
        return `{${Object.keys(fields).sort().map(key => `${JSON.stringify(key)}:${canonicalCancellationReceipt(fields[key])}`).join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Canonical cancellation receipt value required.');
    return encoded;
}

function cancellationObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cancellation evidence object required.');
    return value as Record<string, unknown>;
}
