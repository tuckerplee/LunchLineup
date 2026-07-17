# Grafana

## Files

- `README.md`: this Grafana provisioning guide.

## Directories

- `dashboards/`: provisioned dashboard definitions.
- `datasources/`: provisioned datasource definitions.

## Notes

Datasource UIDs are pinned so checked-in dashboards resolve Prometheus, Loki, and Tempo consistently after provisioning.
Dashboard panels use unique positive IDs and explicit per-panel query `refId` values so provisioned queries remain stable across imports and edits.

The platform overview includes rolling 30-day API and public-web availability SLO panels alongside isolated PDF parser readiness, staff-invitation dead letters/provider health/sweep freshness, latency, errors, dependencies, worker failures, logs, traces, backup freshness, and host capacity. SLO definitions and response thresholds live in `docs/runbooks/service-level-objectives.md`.
