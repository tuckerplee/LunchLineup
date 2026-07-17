import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  collectDefaultMetrics,
  Registry,
  Counter,
  Histogram,
  Gauge,
} from "prom-client";

/**
 * Prometheus Metrics Service — Architecture Part X
 * Exposes default Node.js runtime metrics plus custom LunchLineup metrics.
 * The /metrics endpoint is registered in main.ts.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  public readonly registry: Registry;

  // Custom metrics
  public readonly httpRequestsTotal: Counter<string>;
  public readonly httpRequestDurationMs: Histogram<string>;
  public readonly activeTenants: Gauge<string>;
  public readonly solverDurationSeconds: Histogram<string>;
  public readonly dependencyUp: Gauge<"dependency">;
  public readonly retentionPurgeTenantsTotal: Counter<"stage" | "outcome">;
  public readonly tenantExportsTotal: Counter<"outcome">;
  public readonly notificationOutboxDeliveriesTotal: Counter<"status">;
  public readonly notificationOutboxDeadLettered: Gauge<string>;
  public readonly tenantCancellationReconciliationsTotal: Counter<"outcome">;
  public readonly tenantCancellationReconciliationBacklog: Gauge<string>;
  public readonly tenantDeletionBillingReconciliationsTotal: Counter<"outcome">;
  public readonly tenantDeletionBillingReconciliationBacklog: Gauge<string>;
  public readonly tenantDeletionBillingReconciliationOldestPendingAgeSeconds: Gauge<string>;
  public readonly tenantDeletionBillingReconciliationLastSweepTimestampSeconds: Gauge<string>;
  public readonly tenantDeletionBillingReconciliationLastSuccessTimestampSeconds: Gauge<string>;
  public readonly tenantDeletionBillingReconciliationSweepMaxStalenessSeconds: Gauge<string>;

  constructor() {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ app: "lunchlineup-api" });

    // Default Node.js process and heap metrics
    collectDefaultMetrics({ register: this.registry });

    // HTTP metrics
    this.httpRequestsTotal = new Counter({
      name: "http_requests_total",
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status"],
      registers: [this.registry],
    });

    this.httpRequestDurationMs = new Histogram({
      name: "http_request_duration_ms",
      help: "HTTP request duration in milliseconds",
      labelNames: ["method", "route", "status"],
      buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [this.registry],
    });

    // Business metrics
    this.activeTenants = new Gauge({
      name: "lunchlineup_active_tenants_total",
      help: "Number of active tenant accounts",
      registers: [this.registry],
    });

    this.solverDurationSeconds = new Histogram({
      name: "lunchlineup_solver_duration_seconds",
      help: "Time taken by the scheduling solver in seconds",
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    this.dependencyUp = new Gauge({
      name: "lunchlineup_dependency_up",
      help: "Whether a required API dependency passed its latest bounded health check",
      labelNames: ["dependency"],
      registers: [this.registry],
    });

    this.retentionPurgeTenantsTotal = new Counter({
      name: "lunchlineup_retention_purge_tenants_total",
      help: "Tenant retention purge attempts by stage and outcome",
      labelNames: ["stage", "outcome"],
      registers: [this.registry],
    });

    this.tenantExportsTotal = new Counter({
      name: "lunchlineup_tenant_exports_total",
      help: "Tenant export artifact jobs by outcome",
      labelNames: ["outcome"],
      registers: [this.registry],
    });

    this.notificationOutboxDeliveriesTotal = new Counter({
      name: "lunchlineup_notification_outbox_total",
      help: "Notification outbox delivery transitions by outcome",
      labelNames: ["status"],
      registers: [this.registry],
    });

    this.notificationOutboxDeadLettered = new Gauge({
      name: "lunchlineup_notification_outbox_dead_lettered",
      help: "Notification outbox rows requiring operator attention",
      registers: [this.registry],
    });

    this.tenantCancellationReconciliationsTotal = new Counter({
      name: "lunchlineup_tenant_cancellation_reconciliations_total",
      help: "Tenant cancellation reconciliation attempts by bounded outcome",
      labelNames: ["outcome"],
      registers: [this.registry],
    });

    this.tenantCancellationReconciliationBacklog = new Gauge({
      name: "lunchlineup_tenant_cancellation_reconciliation_backlog",
      help: "Nonterminal tenant cancellation intents awaiting reconciliation",
      registers: [this.registry],
    });

    this.tenantDeletionBillingReconciliationsTotal = new Counter({
      name: "lunchlineup_tenant_deletion_billing_reconciliations_total",
      help: "Tenant deletion billing reconciliation attempts by bounded outcome",
      labelNames: ["outcome"],
      registers: [this.registry],
    });

    this.tenantDeletionBillingReconciliationBacklog = new Gauge({
      name: "lunchlineup_tenant_deletion_billing_reconciliation_backlog",
      help: "Pending tenant deletion billing barriers awaiting reconciliation",
      registers: [this.registry],
    });

    this.tenantDeletionBillingReconciliationOldestPendingAgeSeconds = new Gauge({
      name: "lunchlineup_tenant_deletion_billing_reconciliation_oldest_pending_age_seconds",
      help: "Age in seconds of the oldest pending tenant deletion billing barrier",
      registers: [this.registry],
    });

    this.tenantDeletionBillingReconciliationLastSweepTimestampSeconds = new Gauge({
      name: "lunchlineup_tenant_deletion_billing_reconciliation_last_sweep_timestamp_seconds",
      help: "Unix timestamp of the latest completed tenant deletion billing reconciliation sweep",
      registers: [this.registry],
    });

    this.tenantDeletionBillingReconciliationLastSuccessTimestampSeconds = new Gauge({
      name: "lunchlineup_tenant_deletion_billing_reconciliation_last_success_timestamp_seconds",
      help: "Unix timestamp of the latest healthy tenant deletion billing reconciliation sweep",
      registers: [this.registry],
    });

    this.tenantDeletionBillingReconciliationSweepMaxStalenessSeconds = new Gauge({
      name: "lunchlineup_tenant_deletion_billing_reconciliation_sweep_max_staleness_seconds",
      help: "Maximum expected age in seconds of tenant deletion billing reconciliation sweep telemetry",
      registers: [this.registry],
    });
  }

  onModuleInit() {
    // Nothing to init — metrics are ready at construction time
  }

  /**
   * Record an HTTP request for Prometheus tracking.
   * Call this from a global interceptor or post-middleware hook.
   */
  recordHttpRequest(
    method: string,
    route: string,
    status: number,
    durationMs: number,
  ) {
    const labels = { method, route, status: String(status) };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDurationMs.observe(labels, durationMs);
  }

  recordDependencyStatus(dependency: string, online: boolean): void {
    this.dependencyUp.set({ dependency }, online ? 1 : 0);
  }

  /**
   * Returns the Prometheus metrics text output.
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
