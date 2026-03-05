import { Injectable, OnModuleInit } from '@nestjs/common';
import {
    collectDefaultMetrics,
    Registry,
    Counter,
    Histogram,
    Gauge,
} from 'prom-client';

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
    public readonly solverQueueDepth: Gauge<string>;
    public readonly solverDurationSeconds: Histogram<string>;

    constructor() {
        this.registry = new Registry();
        this.registry.setDefaultLabels({ app: 'lunchlineup-api' });

        // Default Node.js process and heap metrics
        collectDefaultMetrics({ register: this.registry });

        // HTTP metrics
        this.httpRequestsTotal = new Counter({
            name: 'http_requests_total',
            help: 'Total number of HTTP requests',
            labelNames: ['method', 'route', 'status'],
            registers: [this.registry],
        });

        this.httpRequestDurationMs = new Histogram({
            name: 'http_request_duration_ms',
            help: 'HTTP request duration in milliseconds',
            labelNames: ['method', 'route', 'status'],
            buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
            registers: [this.registry],
        });

        // Business metrics
        this.activeTenants = new Gauge({
            name: 'lunchlineup_active_tenants_total',
            help: 'Number of active tenant accounts',
            registers: [this.registry],
        });

        this.solverQueueDepth = new Gauge({
            name: 'lunchlineup_solver_queue_depth',
            help: 'Number of pending schedule solve requests in queue',
            registers: [this.registry],
        });

        this.solverDurationSeconds = new Histogram({
            name: 'lunchlineup_solver_duration_seconds',
            help: 'Time taken by the scheduling solver in seconds',
            buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
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
    recordHttpRequest(method: string, route: string, status: number, durationMs: number) {
        const labels = { method, route, status: String(status) };
        this.httpRequestsTotal.inc(labels);
        this.httpRequestDurationMs.observe(labels, durationMs);
    }

    /**
     * Returns the Prometheus metrics text output.
     */
    async getMetrics(): Promise<string> {
        return this.registry.metrics();
    }
}
