# Runbook: Service Level Objectives

## Public Launch Objectives

LunchLineup measures two rolling 30-day availability objectives:

- Public web availability: 99.9% of one-minute external probes must return the canonical HTTPS application, expected release header, and rendered Next.js markers.
- API availability: 99.9% of non-health application requests must avoid HTTP 5xx responses. Client errors are excluded because they do not represent service unavailability.

The objectives are operational reliability targets, not contractual customer commitments. Revisit them after enough production traffic exists to establish stable baselines.

## Error Budget Alerts

Prometheus evaluates paired multi-window burn rates from `infrastructure/prometheus/alerts/lunchlineup.yml`:

- Fast burn: both five-minute and one-hour windows exceed 14.4 times the monthly error budget. Treat this as a critical incident.
- Slow burn: both 30-minute and six-hour windows exceed 6 times the monthly error budget. Investigate immediately and assign an owner.
- `PublicWebProbeStale` remains critical because missing probe data cannot be treated as successful availability.
- `RequiredApiDependencyUnavailable` pages when database, Redis, or RabbitMQ health is zero or absent.

A short-window breach alone must not page; paired windows reduce noise without hiding sustained customer impact.

## Dashboard

Use the provisioned **LunchLineup Platform Overview** dashboard. The 30-day API and public web availability panels are the authoritative error-budget overview. Correlate them with API p99 latency, route-level request rates, dependency state, worker failures, logs, and traces.

Metric and trace labels must never contain raw unmatched paths, query strings, credentials, email addresses, or customer-provided identifiers.

## Response

1. Open an incident using `incident-response.md` and record the firing alert, start time, affected SLI, current burn rate, and suspected release.
2. Check the public probe, `/health`, Prometheus targets, dependency gauges, and the exact deployed SHA.
3. Mitigate customer impact before optimizing the remaining budget. Use the rollback runbook when the current release is causal.
4. Publish status updates on the incident cadence. Do not expose tenant identifiers, credentials, payloads, or internal topology.
5. Resolve only after both alert windows recover, the relevant probe or dependency is current, and the paging target receives the resolved event.

## Launch Evidence

Before launch, retain:

- a successful critical Alertmanager delivery and resolved-delivery receipt in the launch-proof `alertRoute` artifact;
- screenshots or exported query evidence for both 30-day SLO panels;
- a status-page health check from `LUNCHLINEUP_STATUS_HEALTH_URL`;
- an incident drill showing ownership, customer-safe updates, rollback decision, and closure timestamps.

Provider delivery receipts, status-page write access, on-call acknowledgements, and the production drill are external evidence. Local configuration and tests cannot substitute for them.
