# Runbook: High Error Rate

## Symptom

Prometheus alerts `HighApiErrorRate`, `HighApiLatency`, `WorkerJobFailures`, or `SolverErrors` fire, or users report failed scheduling workflows.

## Diagnostics

Check service health and recent logs:

```bash
docker compose ps
docker compose logs --tail=200 api worker engine
```

Check Prometheus for the failing surface:

```bash
docker compose exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=sum by (job, route) (rate(http_requests_total{status=~"5.."}[5m]))'
docker compose exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=sum by (type) (rate(lunchlineup_worker_jobs_total{status=~"failed|non_retryable"}[5m]))'
docker compose exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=rate(lunchlineup_solver_errors_total[5m])'
```

Use Loki and Tempo to identify the failing route, tenant boundary, and downstream dependency. Do not expose raw stack traces to browsers while diagnosing.

## Resolution

- If database-related, follow `database-failover.md`.
- If CPU or solver backlog is involved, follow `high-cpu.md`.
- If the latest deploy caused the issue, follow `deployment-rollback.md`.
- If credential compromise or unauthorized access is suspected, follow `security-incident.md`.

## Recovery Verification

```bash
curl -fsS https://lunchlineup.com/health
curl -fsS https://lunchlineup.com/api/v2/ready
docker compose logs --tail=100 api worker engine | grep -E "ERROR|timeout" || true
```

Expected result: health checks pass, error-rate alerts clear, and no new worker or solver failures appear for 15 minutes.
