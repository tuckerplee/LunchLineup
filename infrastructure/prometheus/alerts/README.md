# Prometheus Alerts

## Files

- `README.md`: this folder guide.
- `lunchlineup.yml`: production alert rules with checked-in runbook annotations for service health, solver ready/retry backlog plus durable DLQ/terminal transitions, staff-invitation dead letters/provider outage/not-ready/stale sweeps, other delivery workers, dependencies, saturation, backups, retention, and public availability.
- `tenant-deletion-billing.yml`: deletion-billing reconciliation rules for sustained aged backlog and successful-sweep staleness using deletion-specific metric names.

## Folders

- `tests/`: promtool-only fixture syntax kept below the non-recursive production `*.yml` rule glob.
