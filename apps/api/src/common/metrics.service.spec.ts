import { describe, expect, it } from 'vitest';
import { MetricsService } from './metrics.service';

describe('MetricsService delivery metrics', () => {
  it('exports bounded notification and tenant-cancellation outcomes plus backlog', async () => {
    const metrics = new MetricsService();
    metrics.notificationOutboxDeliveriesTotal.inc({ status: 'dead_lettered' });
    metrics.notificationOutboxDeadLettered.set(2);
    metrics.tenantCancellationReconciliationsTotal.inc({ outcome: 'failed' });
    metrics.tenantCancellationReconciliationBacklog.set(3);

    const output = await metrics.getMetrics();

    expect(output).toContain('lunchlineup_notification_outbox_total{status="dead_lettered",app="lunchlineup-api"} 1');
    expect(output).toContain('lunchlineup_notification_outbox_dead_lettered{app="lunchlineup-api"} 2');
    expect(output).toContain('lunchlineup_tenant_cancellation_reconciliations_total{outcome="failed",app="lunchlineup-api"} 1');
    expect(output).toContain('lunchlineup_tenant_cancellation_reconciliation_backlog{app="lunchlineup-api"} 3');
    expect(output).not.toContain('lunchlineup_solver_queue_depth');
    expect(output).not.toContain('title=');
    expect(output).not.toContain('body=');
    expect(output).not.toContain('recipient=');
  });

  it('exports deletion-billing outcomes, backlog age, and sweep freshness without cancellation-name collisions', async () => {
    const metrics = new MetricsService();
    metrics.tenantDeletionBillingReconciliationsTotal.inc({ outcome: 'deadline_exceeded' });
    metrics.tenantDeletionBillingReconciliationBacklog.set(4);
    metrics.tenantDeletionBillingReconciliationOldestPendingAgeSeconds.set(900);
    metrics.tenantDeletionBillingReconciliationLastSweepTimestampSeconds.set(1_784_203_200);
    metrics.tenantDeletionBillingReconciliationLastSuccessTimestampSeconds.set(1_784_203_100);
    metrics.tenantDeletionBillingReconciliationSweepMaxStalenessSeconds.set(90);

    const output = await metrics.getMetrics();

    expect(output).toContain('lunchlineup_tenant_deletion_billing_reconciliations_total{outcome="deadline_exceeded",app="lunchlineup-api"} 1');
    expect(output).toContain('lunchlineup_tenant_deletion_billing_reconciliation_backlog{app="lunchlineup-api"} 4');
    expect(output).toContain('lunchlineup_tenant_deletion_billing_reconciliation_oldest_pending_age_seconds{app="lunchlineup-api"} 900');
    expect(output).toContain('lunchlineup_tenant_deletion_billing_reconciliation_last_sweep_timestamp_seconds{app="lunchlineup-api"} 1784203200');
    expect(output).toContain('lunchlineup_tenant_deletion_billing_reconciliation_last_success_timestamp_seconds{app="lunchlineup-api"} 1784203100');
    expect(output).toContain('lunchlineup_tenant_deletion_billing_reconciliation_sweep_max_staleness_seconds{app="lunchlineup-api"} 90');
    expect(output).not.toContain('tenant_cancellation_reconciliations_total{outcome="deadline_exceeded"');
  });
});
