import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, TenantStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
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
    TenantRetentionLegalHoldActor,
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
    kind: TenantCancellationIntentKind;
    tenantId: string;
    actor: TenantLifecycleActor | TenantRetentionLegalHoldActor;
    confirmation?: string;
    reason?: string | null;
};

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
    ) {}

    async prepare(input: PrepareIntentInput): Promise<PreparedTenantCancellationIntent> {
        return this.withIntentScope(input.kind, input.tenantId, async (tx) => {
            await this.lockTenantLifecycle(tx, input.tenantId);
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
                await this.recordFinalizedAudit(tx, intent, tenant, outcome);
                intent = {
                    ...intent,
                    providerResult: outcome,
                    providerLeaseOwner: null,
                    providerLeaseExpiresAt: null,
                };
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
                const operationId = randomUUID();
                intent = await this.resetIntent(tx, {
                    ...input,
                    operationId,
                    providerSubscriptionId: tenant.stripeSubscriptionId?.trim() || null,
                    subscriptionFingerprint: fingerprint,
                });
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
            await this.writeIntent(tx, claimed);
            return {
                intent: claimed,
                tenant,
                providerLeaseOwner,
            };
        });
    }

    async markProviderApplied(
        prepared: PreparedTenantCancellationIntent,
        outcome: TenantCancellationOutcome,
        providerMutationOwnedFromAttempt = outcome.action === 'scheduled',
    ): Promise<PreparedTenantCancellationIntent> {
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
            )
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
        `);
    }

    private async resetIntent(
        tx: TenantPrismaTransaction,
        input: PrepareIntentInput & {
            operationId: string;
            providerSubscriptionId: string | null;
            subscriptionFingerprint: string;
        },
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
        await this.writeIntent(tx, intent);
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
    ): Promise<void> {
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
    constructor(
        tenantDb: TenantPrismaService,
        private readonly stripeBilling: () => Pick<
            StripeService,
            'cancelTenantSubscriptionAtPeriodEnd'
        > & Partial<Pick<StripeService, 'compensateTenantSubscriptionCancellation'>>,
        private readonly store: TenantCancellationIntentStore =
            new PrismaTenantCancellationIntentStore(tenantDb),
    ) {}

    async cancelCustomer(
        actor: TenantLifecycleActor,
        body: { confirmation?: unknown; reason?: unknown },
    ) {
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
            billingCancellation: outcome,
        };
    }

    async archivePlatform(
        actor: TenantRetentionLegalHoldActor,
        tenantId: string,
    ) {
        const prepared = await this.store.prepare({
            kind: 'PLATFORM_ARCHIVE',
            tenantId,
            actor,
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
