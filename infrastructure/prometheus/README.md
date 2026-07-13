# Prometheus

## Files

- `README.md`: this Prometheus configuration guide.
- `prometheus.yml`: scrape configuration for Prometheus, API, engine, worker, webhook replay, control-plane, and node-exporter metrics.

## Directories

- `alerts/`: Prometheus alerting rules loaded by the Compose Prometheus service.

## Notes

The API metrics scrape uses the Docker secret mounted at `/run/secrets/metrics_token`. Compose mounts `alerts/` read-only at `/etc/prometheus/alerts` so `rule_files` resolve in the container. Targets use Compose service DNS names (`api`, `engine`, `worker`, `webhook-replay`, `control`, and `node-exporter`) so multiple stacks can run with different `COMPOSE_PROJECT_NAME` values without fixed-container-name collisions. The Compose config uses literal external labels because `prom/prometheus:v2.51.2` does not support `--config.expand-env`.

Every alert in `alerts/lunchlineup.yml` must include a `runbook` annotation pointing at an existing `docs/runbooks/*.md` file. API scrapes run the bounded dependency checks before rendering metrics. `RabbitMQDependencyUnavailable` fires when `lunchlineup_dependency_up{dependency="rabbitmq"}` is zero or absent, so a reachable API process cannot produce a false-green broker state. Production readiness also requires backup freshness telemetry through `lunchlineup_backup_last_success_timestamp_seconds`, retained-record expiry telemetry through `lunchlineup_retention_purge_last_attempt_timestamp_seconds`, and public edge telemetry through `lunchlineup_public_web_probe_success` plus `lunchlineup_public_web_probe_last_attempt_timestamp_seconds`; absence of these metrics is a critical alert, not a silent gap.

`infrastructure/control/public-web-probe.sh` runs from the host every minute and writes `lunchlineup_public_web.prom` to the same node-exporter textfile collector. `PublicWebUnavailable` pages after bounded HTTPS failures, including timeouts and Caddy `502` responses. `PublicWebProbeStale` pages when the timer or metric path stops reporting. The probe verifies the canonical public HTTPS root, deployed release header, and rendered Next.js page without granting any Compose service new egress.

The Compose `backup` service writes `lunchlineup_backup_last_success_timestamp_seconds` and `lunchlineup_backup_last_success_size_bytes` to `/metrics/lunchlineup_backup.prom`. Its writable `/metrics` bind and node-exporter's read-only `/textfile_collector` bind resolve from the same `${NODE_EXPORTER_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}` host path. `lunchlineup-backup.service` must therefore produce `/var/lib/node_exporter/textfile_collector/lunchlineup_backup.prom` on its first one-shot run before the timer is enabled. Production Terraform requires `backup_metrics_collector` to be either `node-exporter-textfile:/absolute/path/lunchlineup_backup.prom` or `authenticated-metrics:https://...`; do not launch with backup freshness only written to a local file that Prometheus cannot scrape.

Platform on-call owns `BackupMissingTelemetry`, `BackupStale`, `PitrBaseBackupTelemetryMissing`, `PitrBaseBackupStale`, `PitrWalArchiveFailure`, and `PitrWalArchiveStale`. The PITR base-backup job writes `lunchlineup_pitr.prom`; PostgreSQL's archive command writes `lunchlineup_pitr_wal.prom` after each remotely verified success or failed attempt. Validate the relevant timer or archive command, exact remote object, textfile mtime/content, node-exporter scrape, and Prometheus rule state before resolving an alert. Use `docs/runbooks/postgres-pitr-recovery.md` for PITR alerts.

`scripts/invoke-retained-record-purge.mjs` writes `lunchlineup_retention_purge_last_attempt_timestamp_seconds`, `lunchlineup_retention_purge_last_success`, `lunchlineup_retention_purge_last_candidate_tenants`, and `lunchlineup_retention_purge_last_deleted_records` when `RETENTION_PURGE_METRICS_FILE` points at the production collector path. Compose mounts `${NODE_EXPORTER_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}` read-only into node-exporter and enables `--collector.textfile.directory=/textfile_collector`; the systemd scheduler must write the same host path. Treat `RetentionPurgeCandidatesReady` as an operator-review ticket; execution remains a reviewed action with the confirmation string documented in `docs/runbooks/data-retention-delete-export.md`.
