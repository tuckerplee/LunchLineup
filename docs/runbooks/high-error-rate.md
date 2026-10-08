# Runbook: High Error Rate

## Current scope

Production VM4014 is protected from all access and probes. VM107 remains stopped and launch-held; VM218 runtime admission remains disabled. This source runbook applies to an owner-admitted private candidate only after incident clearance. Historical public recovery probes do not authorize current execution.

## Symptom and ownership

HighNativeApiErrorRate and HighNativeApiLatency describe completed native front-door application responses. Native latency is seconds, with a two-second p99 threshold. ApiAvailabilityBudgetFastBurn and ApiAvailabilityBudgetSlowBurn require their paired windows.

HighApiErrorRate and HighApiLatency remain retained API diagnostics; retained latency is milliseconds. WorkerJobFailures and SolverErrors retain separate worker/solver ownership. NativeApiMetricsMissing, NativeApiHttpInstrumentationUnavailable and ServiceDown mean availability evidence is unavailable and need their own investigation.

## Diagnostics after private admission

Use the approved private Prometheus or Grafana interface. Do not invoke wget inside the distroless Prometheus image. Keep retained downstream traffic separate when examining one delegated browser response.

Native failures by route:

~~~promql
sum by (job, route) (rate(lunchlineup_api_v2_http_requests_total{job="api-v2",scope="application",status_class="5xx"}[5m]))
~~~

Native p99 in seconds:

~~~promql
histogram_quantile(0.99, sum by (le, job, route) (rate(lunchlineup_api_v2_http_request_duration_seconds_bucket{job="api-v2",scope="application"}[5m])))
~~~

Retained and worker diagnostics:

~~~promql
sum by (job, route) (rate(http_requests_total{job="api",status=~"5.."}[5m]))
sum by (type) (rate(lunchlineup_worker_jobs_total{status=~"failed|non_retryable"}[5m]))
rate(lunchlineup_solver_errors_total[5m])
~~~

Check the current native scrape and initialized marker, then admitted /v2/ready and retained dependency gauges. Metrics scraping deliberately does not call readiness. Genuine quota429 and quota-storage 503 are distinct. Abort diagnostics are separate from completed responses; a missing denominator is unknown, not success.

Use bounded private logs/traces and exact deployed identity to locate the route and downstream dependency. Do not expose credentials, tenant identifiers, driver/provider messages or raw stack traces in evidence or browser responses. A silent test logger does not qualify production log privacy.

## Resolution

Follow database-failover.md for database failures, high-cpu.md for solver saturation, the admitted private rollback procedure for a causal candidate, and security-incident.md for suspected unauthorized access. Coordinate all resource and infrastructure changes with their owners; application diagnostics cannot lift the launch hold or authorize shared-storage changes.

## Recovery verification

After owner admission, verify the exact private deployed SHA, authenticated scrape/marker, native readiness, retained dependencies and relevant route results. Confirm paired burn windows and high-error/latency alerts recover and the paging target receives the resolved event. Retain at least 15 minutes without a new worker/solver failure for the immediate incident check.

This recovery check does not qualify a rolling 30-day SLO, every user action, provider delivery, restore, or the required months of private testing. Those release gates remain independently open until actual evidence proves them.
