# Runbook: High CPU Usage

**Trigger**: Prometheus alert `HighCpuUsage` — CPU > 85% sustained for 5 minutes on any service container.

## Severity

**P2 — Degraded Performance.** Escalate to P1 if coupled with error rate spike.

## Symptoms

- API response p99 latency exceeds 2s
- Solver jobs queuing (solver_queue_depth > 10)
- Container CPU saturation visible in Grafana "Platform Overview" dashboard

## Investigation Steps

### 1. Identify the Saturated Service

```bash
# Check CPU usage per container
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"
```

### 2. Check for Runaway Solver Jobs

```bash
# Inspect the solver queue in RabbitMQ management UI
open http://localhost:15672  # guest:guest  (internal only)

# Or query Prometheus directly
curl 'http://localhost:9090/api/v1/query?query=lunchlineup_solver_queue_depth'
```

### 3. Check for Expensive DB Queries

```bash
# Connect to Postgres and look for long-running queries
docker exec -it lunchlineup-postgres psql -U root -d lunchlineup -c \
  "SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
   FROM pg_stat_activity
   WHERE (now() - pg_stat_activity.query_start) > interval '5 seconds'
   ORDER BY duration DESC;"
```

### 4. Check Application Logs

```bash
# API logs with grep for slow markers
docker logs lunchlineup-api --tail=200 | grep -E "SLOW|ERROR|timeout"
```

## Mitigation

### Option A: Scale the Affected Service (Horizontal)

```bash
# Add more API replicas (if using Docker Swarm or Compose scale)
docker compose up -d --scale api=3
```

### Option B: Kill Runaway Job

```bash
# Kill a specific long-running Postgres query
docker exec -it lunchlineup-postgres psql -U root -d lunchlineup -c \
  "SELECT pg_terminate_backend(<pid>);"
```

### Option C: Restart the Saturated Container

```bash
docker restart lunchlineup-engine
```

### Option D: Reduce Solver Concurrency

Edit `.env` and reduce `SOLVER_MAX_CONCURRENT_JOBS` then restart the worker:

```bash
docker compose restart worker
```

## Recovery Verification

- Grafana CPU panel returns below 60%
- `lunchlineup_solver_queue_depth` drains
- API p99 latency returns to < 500ms

## Escalation

If CPU remains elevated after mitigation: page the on-call engineer and open a P1 incident in Slack `#ops-incidents`.
