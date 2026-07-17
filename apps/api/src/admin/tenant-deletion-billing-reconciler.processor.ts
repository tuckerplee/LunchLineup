import {
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit,
} from '@nestjs/common';
import { StripeService } from '../billing/stripe.service';
import { MetricsService } from '../common/metrics.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import {
    TenantDeletionBillingAttemptControlError,
    TenantDeletionBillingService,
    type TenantDeletionBillingBacklog,
    type ClaimedTenantDeletionBillingCandidate,
} from './tenant-deletion-billing.service';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LEASE_MS = 2 * 60_000;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 10 * 60_000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;
const DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS = 90_000;
const MIN_PROVIDER_ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_ATTEMPT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_STOP_DRAIN_TIMEOUT_MS = 10_000;
const MIN_STOP_DRAIN_TIMEOUT_MS = 100;
const MAX_STOP_DRAIN_TIMEOUT_MS = 60_000;

export type TenantDeletionBillingReconciliationOutcome =
    | 'succeeded'
    | 'failed'
    | 'claim_failed'
    | 'deadline_exceeded'
    | 'stopped';

export type TenantDeletionBillingSweepSummary = {
    claimed: number;
    succeeded: number;
    failed: number;
    backlog: number | null;
};

export interface TenantDeletionBillingReconciliationSource {
    claimEligible(
        limit: number,
        excludedTenantIds?: readonly string[],
    ): Promise<ClaimedTenantDeletionBillingCandidate[]>;
    reconcileClaimed(
        claim: ClaimedTenantDeletionBillingCandidate,
        signal?: AbortSignal,
    ): Promise<unknown>;
    readBacklog(): Promise<TenantDeletionBillingBacklog>;
}

type TenantDeletionBillingReconcilerOptions = {
    pollIntervalMs?: number;
    batchSize?: number;
    stopDrainTimeoutMs?: number;
    now?: () => Date;
    recordOutcome?: (outcome: TenantDeletionBillingReconciliationOutcome) => void;
    setBacklog?: (count: number) => void;
    setOldestPendingAgeSeconds?: (ageSeconds: number) => void;
    recordSweep?: (completedAtUnixSeconds: number, successful: boolean) => void;
    setSweepMaxStalenessSeconds?: (seconds: number) => void;
};

export class TenantDeletionBillingReconcilerProcessor {
    private readonly logger = new Logger(TenantDeletionBillingReconcilerProcessor.name);
    private readonly pollIntervalMs: number;
    private readonly batchSize: number;
    private readonly stopDrainTimeoutMs: number;
    private readonly now: () => Date;
    private readonly recordOutcome?: (outcome: TenantDeletionBillingReconciliationOutcome) => void;
    private readonly setBacklog?: (count: number) => void;
    private readonly setOldestPendingAgeSeconds?: (ageSeconds: number) => void;
    private readonly recordSweep?: (completedAtUnixSeconds: number, successful: boolean) => void;
    private timer?: NodeJS.Timeout;
    private activeSweep?: Promise<TenantDeletionBillingSweepSummary>;
    private activeSweepAbort?: AbortController;
    private stopped = false;

    constructor(
        private readonly source: TenantDeletionBillingReconciliationSource,
        options: TenantDeletionBillingReconcilerOptions = {},
    ) {
        this.pollIntervalMs = boundedInteger(
            options.pollIntervalMs ?? process.env.TENANT_DELETION_BILLING_RECONCILE_INTERVAL_MS,
            DEFAULT_POLL_INTERVAL_MS,
            MIN_POLL_INTERVAL_MS,
            MAX_POLL_INTERVAL_MS,
        );
        this.batchSize = boundedInteger(
            options.batchSize ?? process.env.TENANT_DELETION_BILLING_RECONCILE_BATCH_SIZE,
            DEFAULT_BATCH_SIZE,
            1,
            MAX_BATCH_SIZE,
        );
        this.stopDrainTimeoutMs = boundedInteger(
            options.stopDrainTimeoutMs
                ?? process.env.TENANT_DELETION_BILLING_RECONCILE_STOP_DRAIN_MS,
            DEFAULT_STOP_DRAIN_TIMEOUT_MS,
            MIN_STOP_DRAIN_TIMEOUT_MS,
            MAX_STOP_DRAIN_TIMEOUT_MS,
        );
        this.now = options.now ?? (() => new Date());
        this.recordOutcome = options.recordOutcome;
        this.setBacklog = options.setBacklog;
        this.setOldestPendingAgeSeconds = options.setOldestPendingAgeSeconds;
        this.recordSweep = options.recordSweep;
        options.setSweepMaxStalenessSeconds?.(
            Math.ceil(Math.max(60_000, this.pollIntervalMs * 3) / 1_000),
        );
    }

    start(): void {
        if (this.timer) return;
        this.stopped = false;
        this.timer = setInterval(() => void this.sweepNow(), this.pollIntervalMs);
        this.timer.unref();
        void this.sweepNow();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.activeSweepAbort?.abort();
        const active = this.activeSweep;
        if (!active) return;

        let drainTimer: NodeJS.Timeout | undefined;
        const drainDeadline = new Promise<false>((resolve) => {
            drainTimer = setTimeout(() => resolve(false), this.stopDrainTimeoutMs);
            drainTimer.unref();
        });
        const drained = await Promise.race([
            active.then(() => true as const),
            drainDeadline,
        ]);
        if (drainTimer) clearTimeout(drainTimer);
        if (!drained) {
            this.logger.warn(
                'Tenant deletion billing shutdown drain deadline elapsed; the process watchdog remains the final provider-transport backstop.',
            );
            void active.catch(() => undefined);
        }
    }

    sweepNow(): Promise<TenantDeletionBillingSweepSummary> {
        if (this.stopped) return Promise.resolve(emptySweepSummary());
        if (this.activeSweep) return this.activeSweep;

        const abort = new AbortController();
        let active!: Promise<TenantDeletionBillingSweepSummary>;
        active = this.performSweep(abort.signal).finally(() => {
            if (this.activeSweep === active) {
                this.activeSweep = undefined;
                this.activeSweepAbort = undefined;
            }
        });
        this.activeSweepAbort = abort;
        this.activeSweep = active;
        return active;
    }

    private async performSweep(signal: AbortSignal): Promise<TenantDeletionBillingSweepSummary> {
        let claimed = 0;
        let succeeded = 0;
        let failed = 0;
        let sweepSuccessful = true;
        const attemptedTenantIds: string[] = [];
        while (claimed < this.batchSize && !signal.aborted && !this.stopped) {
            let claim: ClaimedTenantDeletionBillingCandidate | undefined;
            try {
                [claim] = await this.source.claimEligible(1, [...attemptedTenantIds]);
            } catch {
                failed += 1;
                sweepSuccessful = false;
                this.recordOutcome?.('claim_failed');
                this.logger.error('Tenant deletion billing reconciliation claim failed.');
                break;
            }
            if (!claim) break;

            claimed += 1;
            attemptedTenantIds.push(claim.tenantId);
            try {
                await this.source.reconcileClaimed(claim, signal);
                succeeded += 1;
                this.recordOutcome?.('succeeded');
            } catch (error) {
                failed += 1;
                sweepSuccessful = false;
                const outcome = error instanceof TenantDeletionBillingAttemptControlError
                    ? error.outcome
                    : 'failed';
                this.recordOutcome?.(outcome);
                this.logger.error('Tenant deletion billing reconciliation attempt failed.');
                if (outcome === 'stopped') {
                    break;
                }
            }
        }
        const backlog = await this.refreshBacklog();
        if (backlog === null) sweepSuccessful = false;
        const completedAtUnixSeconds = Math.floor(this.now().getTime() / 1_000);
        this.recordSweep?.(completedAtUnixSeconds, sweepSuccessful);
        return {
            claimed,
            succeeded,
            failed,
            backlog,
        };
    }

    private async refreshBacklog(): Promise<number | null> {
        try {
            const backlog = await this.source.readBacklog();
            this.setBacklog?.(backlog.count);
            const oldestPendingAgeSeconds = backlog.oldestPendingAt
                ? Math.max(0, (this.now().getTime() - backlog.oldestPendingAt.getTime()) / 1_000)
                : 0;
            this.setOldestPendingAgeSeconds?.(oldestPendingAgeSeconds);
            return backlog.count;
        } catch {
            this.logger.error('Tenant deletion billing reconciliation backlog refresh failed.');
            return null;
        }
    }
}

@Injectable()
export class TenantDeletionBillingReconcilerService
implements OnModuleInit, OnModuleDestroy {
    private readonly processor: TenantDeletionBillingReconcilerProcessor;

    constructor(
        tenantDb: TenantPrismaService,
        stripeBilling: StripeService,
        metrics: MetricsService,
    ) {
        const pollIntervalMs = boundedInteger(
            process.env.TENANT_DELETION_BILLING_RECONCILE_INTERVAL_MS,
            DEFAULT_POLL_INTERVAL_MS,
            MIN_POLL_INTERVAL_MS,
            MAX_POLL_INTERVAL_MS,
        );
        const lifecycle = new TenantDeletionBillingService(
            tenantDb,
            () => stripeBilling,
            {
                leaseMs: boundedInteger(
                    process.env.TENANT_DELETION_BILLING_RECONCILE_LEASE_MS,
                    DEFAULT_LEASE_MS,
                    MIN_LEASE_MS,
                    MAX_LEASE_MS,
                ),
                providerAttemptTimeoutMs: boundedInteger(
                    process.env.TENANT_DELETION_BILLING_RECONCILE_ATTEMPT_TIMEOUT_MS,
                    DEFAULT_PROVIDER_ATTEMPT_TIMEOUT_MS,
                    MIN_PROVIDER_ATTEMPT_TIMEOUT_MS,
                    MAX_PROVIDER_ATTEMPT_TIMEOUT_MS,
                ),
            },
        );
        this.processor = new TenantDeletionBillingReconcilerProcessor({
            claimEligible: (limit, excludedTenantIds) =>
                lifecycle.claimEligibleDeletionBillingCandidates(limit, excludedTenantIds),
            reconcileClaimed: (claim, signal) =>
                lifecycle.reconcileClaimedDeletionBillingCandidate(claim, signal),
            readBacklog: () => lifecycle.readPendingDeletionBillingBacklog(),
        }, {
            pollIntervalMs,
            recordOutcome: (outcome) => {
                metrics.tenantDeletionBillingReconciliationsTotal.inc({ outcome });
            },
            setBacklog: (count) => {
                metrics.tenantDeletionBillingReconciliationBacklog.set(count);
            },
            setOldestPendingAgeSeconds: (ageSeconds) => {
                metrics.tenantDeletionBillingReconciliationOldestPendingAgeSeconds.set(ageSeconds);
            },
            recordSweep: (completedAtUnixSeconds, successful) => {
                metrics.tenantDeletionBillingReconciliationLastSweepTimestampSeconds
                    .set(completedAtUnixSeconds);
                if (successful) {
                    metrics.tenantDeletionBillingReconciliationLastSuccessTimestampSeconds
                        .set(completedAtUnixSeconds);
                }
            },
            setSweepMaxStalenessSeconds: (seconds) => {
                metrics.tenantDeletionBillingReconciliationSweepMaxStalenessSeconds.set(seconds);
            },
        });
    }

    onModuleInit(): void {
        this.processor.start();
    }

    async onModuleDestroy(): Promise<void> {
        await this.processor.stop();
    }
}

function boundedInteger(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
}

function emptySweepSummary(): TenantDeletionBillingSweepSummary {
    return { claimed: 0, succeeded: 0, failed: 0, backlog: null };
}
