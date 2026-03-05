# Runbook: High Error Rate (alertErrorRatePercent > 2%)

## Symptom
The system is experiencing more than 2% errors in outgoing API responses.

## Diagnostics
1. Check Grafana dashboard "API Health" for specific endpoints with high error rates.
2. Query Loki logs for `level="error"` to identify the root cause stack traces.
3. Inspect Tempo for traces with `status.code=ERROR` to see where in the distributed chain the failure is happening.

## Resolution
- If database-related, check Postgres logs and lock contention.
- If engine-related, verify gRPC connectivity and RabbitMQ queue health.
- If external integration (e.g. Stripe) is failing, check status.stripe.com.
