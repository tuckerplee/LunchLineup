import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { pilotProducersClosed } from '../common/pilot-producer-admission';
import type { TenantPrismaService, TenantPrismaTransaction } from '../database/tenant-prisma.service';
import type { PersistentCancellationObserver } from '../billing/persistent-cancellation-observer';
import { consumePersistentCancellationObservationPermit } from './persistent-export-consumer';
import { canonicalObservation, observationDigest, type CancellationObservationSelection,
    type CancellationProcessFence } from './cancellation-observation-evidence';

type Claim = Readonly<CancellationObservationSelection & {
    operationId: string; intentSha256: string; leaseOwner: string; leaseUntil: string;
    expires: number; providerExpires: number; processFence: CancellationProcessFence;
}>;
type Tenant = { id: string; status: string; deletedAt: Date | null; stripeCustomerId: string | null;
    stripeSubscriptionId: string | null; stripeSubscriptionCurrentPeriodEnd: Date | null; selectedBillingRevision: number };
type Original = { value: Prisma.JsonValue; requestIntentSha256: string | null; operationId: string | null;
    providerIntentSha256: string | null; customerId: string | null; providerLeaseUntil: string | null;
    providerReceipt: Prisma.JsonValue | null; providerBillingRevision: number | null;
    finalizationReceipt: Prisma.JsonValue | null; terminalReceipt: Prisma.JsonValue | null };
function object(value: unknown): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Original cancellation object required.');
    return value as Record<string, any>;
}

/** Separate observation custody. It cannot call provider.apply, renew the old lease,
 * fill a historical revision, settle local billing, or delete original evidence. */
export class PersistentCancellationObservationStore {
    private readonly pilotClosed = pilotProducersClosed();
    private used = false; private closed = false; private unknown = false;
    private operation?: Promise<boolean>; private closing?: Promise<void>;
    private readonly abort = new AbortController();
    private claim?: Claim;
    constructor(private readonly tenantDb: TenantPrismaService, private readonly observer: PersistentCancellationObserver) {}
    assertPersistentOwnerReady(): void {
        if (!this.pilotClosed || this.used || this.closed) throw new Error('Unused closed observation owner required.');
    }
    closeAdmission(): Promise<void> {
        this.closed = true; this.abort.abort(new Error('Observation owner closed.'));
        if (!this.closing) this.closing = (async () => {
            try { await this.operation; } catch { this.unknown = true; }
            if (this.unknown) throw new Error('Observation custody requires independent reconciliation.');
        })();
        return this.closing;
    }
    persistentOwnerCancellationObserver(): PersistentCancellationObserver { return this.observer; }
    persistentCancellationObservationSignal(): AbortSignal { return this.abort.signal; }
    persistentCancellationObservationSelection(): Claim {
        if (!this.claim) throw new Error('Committed observation claim required.');
        this.assertPersistentCancellationObservationOpen(this.claim); return this.claim;
    }
    assertPersistentCancellationObservationOpen(claim: Claim): void {
        this.guard(claim.expires);
        if (claim !== this.claim || this.abort.signal.aborted || performance.now() >= claim.providerExpires) {
            throw new Error('Original observation handoff budget closed.');
        }
    }
    private guard(expires: number): void {
        if (!this.pilotClosed || !this.used || this.closed || performance.now() >= expires) throw new Error('Original observation owner closed.');
    }
    runPersistentOwnerCancellationObservation(permit: object): Promise<boolean> {
        const selected = consumePersistentCancellationObservationPermit(this, permit);
        this.assertPersistentOwnerReady(); this.used = true;
        this.operation = Promise.resolve().then(() => this.observe(selected, permit))
            .catch(error => { this.unknown = true; throw error; });
        return this.operation;
    }
    private async observe(selected: ReturnType<typeof consumePersistentCancellationObservationPermit>, permit: object): Promise<boolean> {
        const guard = () => this.guard(selected.expires);
        const started = performance.now(); guard();
        if (selected.expires - started <= this.observer.timeoutMs + 8000) throw new Error('Original observation budget is insufficient.');
        const providerExpires = Math.min(selected.expires - 8000, started + this.observer.timeoutMs);
        const leaseUntil = new Date(Date.now() + Math.ceil(selected.expires - started));
        const leaseOwner = randomUUID();
        const timer = setTimeout(() => this.abort.abort(new Error('Original observation deadline exceeded.')),
            Math.max(0, Math.ceil(providerExpires - performance.now())));
        const readLocked = async (tx: TenantPrismaTransaction) => {
            guard(); await tx.$executeRaw`SELECT public.lock_tenant_lifecycle(${selected.tenantId})`; guard();
            const tenants = await tx.$queryRaw<Tenant[]>`
                SELECT "id", "status", "deletedAt", "stripeCustomerId", "stripeSubscriptionId",
                    "stripeSubscriptionCurrentPeriodEnd", "selectedBillingRevision"
                FROM "Tenant" WHERE "id" = ${selected.tenantId} FOR UPDATE NOWAIT
            `; guard();
            const settings = await tx.$queryRaw<Array<{ original: Original }>>`
                SELECT jsonb_build_object('value', "value", 'requestIntentSha256', "selectedLifecycleIntentSha256",
                    'operationId', "selectedLifecycleOperationId", 'providerIntentSha256', "selectedLifecycleProviderIntentSha256",
                    'customerId', "selectedLifecycleProviderCustomerId",
                    'providerLeaseUntil', to_char("selectedLifecycleProviderLeaseUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                    'providerReceipt', "selectedLifecycleProviderReceipt", 'providerBillingRevision', "selectedLifecycleProviderBillingRevision",
                    'finalizationReceipt', "selectedLifecycleFinalizationReceipt", 'terminalReceipt', "selectedLifecycleTerminalReceipt") AS "original"
                FROM "TenantSetting" WHERE "tenantId" = ${selected.tenantId}
                    AND "key" = 'internal:tenant-lifecycle-intent:customer_cancellation' FOR UPDATE NOWAIT
            `; guard();
            const tenant = tenants[0]; const original = settings[0]?.original;
            if (tenants.length !== 1 || !tenant || tenant.deletedAt !== null || ['PURGED', 'SUSPENDED'].includes(tenant.status)
                || tenant.stripeCustomerId !== selected.customerId
                || !(tenant.stripeSubscriptionId === selected.subscriptionId || (tenant.status === 'CANCELLED'
                    && tenant.stripeSubscriptionId === null && tenant.stripeSubscriptionCurrentPeriodEnd === null))
                || settings.length !== 1 || !original || original.requestIntentSha256 !== selected.predecessorIntentSha256
                || original.operationId !== selected.jobId || original.providerIntentSha256 !== selected.providerIntentSha256
                || original.customerId !== selected.customerId || original.providerLeaseUntil === null
                || (original.providerReceipt === null ? null : observationDigest(original.providerReceipt)) !== selected.priorReceiptSha256) {
                throw new Error('Exact original cancellation/resource custody differs.');
            }
            const intent = object(original.value);
            if (intent.tenantId !== selected.tenantId || intent.operationId !== selected.jobId || intent.kind !== 'CUSTOMER_CANCELLATION'
                || !['PENDING_PROVIDER', 'FINALIZED'].includes(intent.state) || intent.providerAttempts !== 1
                || typeof intent.providerLeaseOwner !== 'string' || intent.providerLeaseOwner.length === 0
                || typeof intent.providerLeaseExpiresAt !== 'string'
                || new Date(intent.providerLeaseExpiresAt).getTime() !== new Date(original.providerLeaseUntil).getTime()
                || intent.providerSubscriptionId !== selected.subscriptionId || intent.compensationResult !== null
                || (intent.state === 'PENDING_PROVIDER' && intent.providerResult !== null)) throw new Error('Original consumed provider claim differs.');
            const platform = await tx.tenantSetting.findUnique({ where: { tenantId_key: {
                tenantId: selected.tenantId, key: 'internal:tenant-lifecycle-intent:platform_archive' } }, select: { id: true } }); guard();
            if (platform) throw new Error('Platform recovery requires separate authority.');
            return { tenant, original };
        };
        const custody: { claim?: Promise<Original>; observation?: Promise<boolean> } = {};
        try {
            const original = await this.tenantDb.withTenant(selected.tenantId, tx => {
                const callback = Promise.resolve().then(async () => {
                    const { original } = await readLocked(tx); guard();
                    // Unique tenant/provider intent and immutable attempt=1 survive unknown
                    // dispatch/commit. A new observation ID cannot reset the consumed slot.
                    await tx.$executeRaw`
                        INSERT INTO "TenantCancellationObservation" ("id", "tenantId", "operationId", "requestIntentSha256",
                            "providerIntentSha256", "observationIntentSha256", "customerId", "subscriptionId", "priorReceiptSha256",
                            "processFence", "original", "leaseOwner", "leaseUntil", "attempts")
                        VALUES (${selected.observationId}, ${selected.tenantId}, ${selected.jobId}, ${selected.predecessorIntentSha256},
                            ${selected.providerIntentSha256}, ${selected.intentSha256}, ${selected.customerId}, ${selected.subscriptionId},
                            ${selected.priorReceiptSha256}, CAST(${JSON.stringify(selected.processFence)} AS jsonb),
                            CAST(${JSON.stringify(original)} AS jsonb), ${leaseOwner}, ${leaseUntil}, 1)
                    `; guard(); return original;
                });
                custody.claim = callback; return callback;
            }, { maxWait: 5000, timeout: 60000 }); guard();
            this.claim = Object.freeze({ ...selected, operationId: selected.jobId, leaseOwner,
                leaseUntil: leaseUntil.toISOString(), providerExpires });
            this.assertPersistentCancellationObservationOpen(this.claim);
            const result = await this.tenantDb.withTenant(selected.tenantId, tx => {
                const callback = Promise.resolve().then(async () => {
                    const current = await readLocked(tx); guard();
                    if (canonicalObservation(current.original) !== canonicalObservation(original)) throw new Error('Original custody changed after claim.');
                    const claims = await tx.$queryRaw<Array<{ live: boolean; original: Prisma.JsonValue; processFence: Prisma.JsonValue }>>`
                        SELECT ("leaseUntil" > clock_timestamp()) AS "live", "original", "processFence"
                        FROM "TenantCancellationObservation" WHERE "id" = ${selected.observationId} AND "tenantId" = ${selected.tenantId}
                            AND "operationId" = ${selected.jobId} AND "observationIntentSha256" = ${selected.intentSha256}
                            AND "leaseOwner" = ${leaseOwner} AND "leaseUntil" = ${leaseUntil} AND "attempts" = 1
                            AND "receipt" IS NULL AND "completedAt" IS NULL AND "billingRevision" IS NULL FOR UPDATE NOWAIT
                    `; this.assertPersistentCancellationObservationOpen(this.claim!);
                    if (claims.length !== 1 || claims[0].live !== true
                        || canonicalObservation(claims[0].original) !== canonicalObservation(original)
                        || canonicalObservation(claims[0].processFence) !== canonicalObservation(selected.processFence)) throw new Error('Original observation generation differs.');
                    // Tenant stays locked from before GET until the observation receipt and
                    // newly captured revision commit. This does not settle the prior POST.
                    const provider = await this.observer.observe(permit); guard();
                    const receipt = { version: 1, tenantId: selected.tenantId, operationId: selected.jobId,
                        observationId: selected.observationId, observationIntentSha256: selected.intentSha256,
                        requestIntentSha256: selected.predecessorIntentSha256, providerIntentSha256: selected.providerIntentSha256,
                        priorReceiptSha256: selected.priorReceiptSha256, originalSha256: observationDigest(original),
                        processFence: selected.processFence, provider, snapshot: { status: current.tenant.status,
                            customerId: current.tenant.stripeCustomerId, subscriptionId: current.tenant.stripeSubscriptionId,
                            currentPeriodEnd: current.tenant.stripeSubscriptionCurrentPeriodEnd?.toISOString() ?? null,
                            billingRevision: current.tenant.selectedBillingRevision }, backendSettlementProved: false, retryAllowed: false };
                    const changed = await tx.$executeRaw`
                        UPDATE "TenantCancellationObservation" SET "receipt" = CAST(${JSON.stringify(receipt)} AS jsonb),
                            "billingRevision" = ${current.tenant.selectedBillingRevision}, "completedAt" = clock_timestamp()
                        WHERE "id" = ${selected.observationId} AND "tenantId" = ${selected.tenantId}
                            AND "observationIntentSha256" = ${selected.intentSha256} AND "leaseOwner" = ${leaseOwner}
                            AND "leaseUntil" = ${leaseUntil} AND "leaseUntil" > clock_timestamp() AND "attempts" = 1
                            AND "receipt" IS NULL AND "completedAt" IS NULL AND "billingRevision" IS NULL
                    `; guard();
                    if (changed !== 1) throw new Error('Exact observation receipt acknowledgement lost ownership.');
                    const readback = await tx.$queryRaw<Array<{ receipt: Prisma.JsonValue }>>`
                        SELECT "receipt" FROM "TenantCancellationObservation" WHERE "id" = ${selected.observationId}
                            AND "tenantId" = ${selected.tenantId} AND "observationIntentSha256" = ${selected.intentSha256}
                    `; guard();
                    if (readback.length !== 1 || canonicalObservation(readback[0].receipt) !== canonicalObservation(receipt)) {
                        throw new Error('Exact observation receipt readback differs.');
                    }
                    return true;
                });
                custody.observation = callback; return callback;
            }, { maxWait: 5000, timeout: 60000 }); guard(); return result;
        } catch (error) {
            this.closed = true; this.unknown = true; this.abort.abort(error); throw error;
        } finally {
            try { if (custody.claim) await custody.claim; }
            finally {
                try { if (custody.observation) await custody.observation; }
                finally { clearTimeout(timer); this.abort.abort(new Error('Observation phase finished.')); }
            }
        }
    }
}
