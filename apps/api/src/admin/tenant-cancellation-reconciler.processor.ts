import {
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit,
} from '@nestjs/common';
import { StripeService } from '../billing/stripe.service';
import { MetricsService } from '../common/metrics.service';
import { runtimeErrorText } from '../common/runtime-error-diagnostic';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import {
    PrismaTenantCancellationIntentStore,
    TenantCancellationLifecycleService,
    type PreparedTenantCancellationIntent,
} from './tenant-cancellation-lifecycle.service';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LEASE_MS = 2 * 60_000;
const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 10 * 60_000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;

export type TenantCancellationReconciliationOutcome = 'succeeded' | 'failed';

export type TenantCancellationSweepSummary = {
    claimed: number;
    succeeded: number;
    failed: number;
    backlog: number | null;
};

export interface TenantCancellationReconciliationSource {
    claimRecoverable(
        limit: number,
        excludedOperationIds?: readonly string[],
    ): Promise<PreparedTenantCancellationIntent[]>;
    reconcilePrepared(
        prepared: PreparedTenantCancellationIntent,
    ): Promise<PreparedTenantCancellationIntent>;
    countBacklog(): Promise<number>;
}

type TenantCancellationReconcilerOptions = {
    pollIntervalMs?: number;
    batchSize?: number;
    recordOutcome?: (outcome: TenantCancellationReconciliationOutcome) => void;
    setBacklog?: (count: number) => void;
};

export class TenantCancellationReconcilerProcessor {
    private readonly logger = new Logger(TenantCancellationReconcilerProcessor.name);
    private readonly pollIntervalMs: number;
    private readonly batchSize: number;
    private readonly recordOutcome?: (
        outcome: TenantCancellationReconciliationOutcome,
    ) => void;
    private readonly setBacklog?: (count: number) => void;
    private timer?: NodeJS.Timeout;
    private activeSweep?: Promise<TenantCancellationSweepSummary>;
    private stopped = false;

    constructor(
        private readonly source: TenantCancellationReconciliationSource,
        options: TenantCancellationReconcilerOptions = {},
    ) {
        this.pollIntervalMs = boundedInteger(
            options.pollIntervalMs ?? process.env.TENANT_CANCELLATION_RECONCILE_INTERVAL_MS,
            DEFAULT_POLL_INTERVAL_MS,
            MIN_POLL_INTERVAL_MS,
            MAX_POLL_INTERVAL_MS,
        );
        this.batchSize = boundedInteger(
            options.batchSize ?? process.env.TENANT_CANCELLATION_RECONCILE_BATCH_SIZE,
            DEFAULT_BATCH_SIZE,
            1,
            MAX_BATCH_SIZE,
        );
        this.recordOutcome = options.recordOutcome;
        this.setBacklog = options.setBacklog;
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
        await this.activeSweep;
    }

    sweepNow(): Promise<TenantCancellationSweepSummary> {
        if (this.stopped) {
            return Promise.resolve(emptySweepSummary());
        }
        if (this.activeSweep) return this.activeSweep;

        let active!: Promise<TenantCancellationSweepSummary>;
        active = this.performSweep().finally(() => {
            if (this.activeSweep === active) this.activeSweep = undefined;
        });
        this.activeSweep = active;
        return active;
    }

    private async performSweep(): Promise<TenantCancellationSweepSummary> {
        let claimed = 0;
        let succeeded = 0;
        let failed = 0;
        const attemptedOperationIds: string[] = [];
        while (claimed < this.batchSize) {
            let prepared: PreparedTenantCancellationIntent | undefined;
            try {
                [prepared] = await this.source.claimRecoverable(
                    1,
                    attemptedOperationIds,
                );
            } catch (error) {
                failed += 1;
                this.recordFailure(error, 'claim');
                break;
            }
            if (!prepared) break;

            claimed += 1;
            attemptedOperationIds.push(prepared.intent.operationId);
            try {
                await this.source.reconcilePrepared(prepared);
                succeeded += 1;
                this.recordOutcome?.('succeeded');
            } catch (error) {
                failed += 1;
                this.recordFailure(error, 'intent');
            }
        }

        return {
            claimed,
            succeeded,
            failed,
            backlog: await this.refreshBacklog(),
        };
    }

    private async refreshBacklog(): Promise<number | null> {
        try {
            const backlog = await this.source.countBacklog();
            this.setBacklog?.(backlog);
            return backlog;
        } catch (error) {
            this.logger.error(
                `Tenant cancellation backlog refresh failed ${runtimeErrorText(error)}`,
            );
            return null;
        }
    }

    private recordFailure(error: unknown, stage: 'claim' | 'intent'): void {
        this.recordOutcome?.('failed');
        this.logger.error(
            `Tenant cancellation reconciliation failed stage=${stage} ${runtimeErrorText(error)}`,
        );
    }
}

@Injectable()
export class TenantCancellationReconcilerService
implements OnModuleInit, OnModuleDestroy {
    private readonly processor: TenantCancellationReconcilerProcessor;

    constructor(
        tenantDb: TenantPrismaService,
        stripeBilling: StripeService,
        metrics: MetricsService,
    ) {
        const leaseMs = boundedInteger(
            process.env.TENANT_CANCELLATION_RECONCILE_LEASE_MS,
            DEFAULT_LEASE_MS,
            MIN_LEASE_MS,
            MAX_LEASE_MS,
        );
        const store = new PrismaTenantCancellationIntentStore(tenantDb, leaseMs);
        const lifecycle = new TenantCancellationLifecycleService(
            tenantDb,
            () => stripeBilling,
            store,
        );
        this.processor = new TenantCancellationReconcilerProcessor({
            claimRecoverable: (limit, excludedOperationIds) =>
                store.claimRecoverable(limit, excludedOperationIds),
            reconcilePrepared: (prepared) => lifecycle.reconcilePrepared(prepared),
            countBacklog: () => store.countBacklog(),
        }, {
            recordOutcome: (outcome) => {
                metrics.tenantCancellationReconciliationsTotal.inc({ outcome });
            },
            setBacklog: (count) => metrics.tenantCancellationReconciliationBacklog.set(count),
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

function emptySweepSummary(): TenantCancellationSweepSummary {
    return { claimed: 0, succeeded: 0, failed: 0, backlog: null };
}
