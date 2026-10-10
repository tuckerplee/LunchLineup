import type { PersistentCancellationProvider } from '../billing/persistent-cancellation-provider';
import { consumePersistentCancellationRequestPermit, consumePersistentCancellationOperationPermit } from './persistent-export-consumer';
import { pilotProducersClosed, requireOrdinaryProducer } from '../common/pilot-producer-admission';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, TenantStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { MFA_MARKER_TTL_SCRIPT, observeMfaVerification, type MfaSessionIdentity, type MfaSessionObserver } from '@lunchlineup/rbac';
import Redis from 'ioredis';
import { RbacService } from '../auth/rbac.service';
import { recordAccountLifecycleRequest } from './account-lifecycle-request';
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
