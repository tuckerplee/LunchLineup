# Runbook: High CPU Usage

## Trigger

Prometheus alert `HighCpuUsage`, `SolverQueueBacklog`, or correlated API latency indicates CPU saturation or solver backlog.

## Severity

P2 degraded performance. Escalate to P1 if coupled with a critical error-rate alert or failed scheduling workflow.

## Symptoms

- API p99 latency exceeds 2 seconds.
- Solver jobs are queued for more than 5 minutes.
- Container CPU saturation is visible in the Grafana Platform Overview dashboard.

## Investigation

Identify the saturated service:

```bash
docker compose ps
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
```

Check solver and worker pressure:

```bash
docker compose exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=lunchlineup_solver_queue_depth'
docker compose exec prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=sum(rate(lunchlineup_worker_jobs_total{status=~"failed|non_retryable"}[5m]))'
```

Check long-running database queries:

```bash
docker compose exec postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c \
  "SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
   FROM pg_stat_activity
   WHERE (now() - pg_stat_activity.query_start) > interval '5 seconds'
   ORDER BY duration DESC;"
```

Check application logs:

```bash
docker compose logs --tail=200 api worker engine | grep -E "SLOW|ERROR|timeout"
```

## Mitigation

Scale the affected service if capacity is the issue:

```bash
docker compose up -d --scale api=3
```

Terminate a confirmed runaway database query:

```bash
docker compose exec postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c \
  "SELECT pg_terminate_backend(<pid>);"
```

Restart only the saturated service if it is wedged:

```bash
docker compose restart engine
```

Reduce solver concurrency if backlog is harming interactive traffic:

```bash
docker compose restart worker
```

Record the temporary concurrency setting and revert after the incident.

## Recovery Verification

- Grafana CPU panels return below 60%.
- `lunchlineup_solver_queue_depth` drains.
- API p99 latency returns below 500 ms.
- No `HighApiErrorRate` or `WorkerJobFailures` alert is firing.

## Escalation

If CPU remains elevated after mitigation, page the production on-call route defined in Terraform `alert_targets` and open a P1 incident record.
