# Estate systems contract

LunchLineup does not run its own monitoring, alerting, dashboard, log, tracing or backup stack. One universal estate system serves each job for every app on Proxmox1; this repository only exposes what those systems consume and ships files for estate-infra to copy.

| Job | Estate system | What the app provides |
| --- | --- | --- |
| Metrics | Estate Prometheus (`prometheus.int.tuckerl.ee:9090`) | Token-protected `/metrics` endpoints behind a scrape gateway on the VM (below), plus `lunchlineup-targets.yml` |
| Alerting | Estate Alertmanager (`alertmanager.int.tuckerl.ee:9093`) owns routing and mail. No Slack or PagerDuty webhooks. | `lunchlineup-rules.yml` (rules only; nothing here routes or sends) |
| Dashboards | Estate Grafana | `dashboards/*.json` reference copies |
| Logs | Alloy on the VM (estate-infra `log_shipper` role) pushing to estate Loki | Containers log to the Docker `json-file` driver; Alloy picks up the container logs |
| Tracing | None | Nothing is added; the OTLP exporters stay dormant because no endpoint is configured |
| Postgres PITR | pgBackRest, repository on the NAS over SFTP | A configurable WAL archive hook that is off by default (`infrastructure/postgres/README.md`) |
| File backups | Host restic online backup | Nothing |
| Transactional end-user email (Resend) | Product functionality, unchanged | Unchanged |

There is no S3 offsite target and no in-container dump anywhere in this repository.

## Files

- `README.md`: this estate contract.
- `lunchlineup-targets.yml`: estate Prometheus scrape job for VM107.
- `lunchlineup-rules.yml`: estate Prometheus alert rules.
- `tests/`: `promtool test rules` fixtures for the rules.
- `dashboards/`: Grafana dashboard reference copies.

## Files for estate-infra

Copy these; estate-infra owns everything after the copy. Do not edit the estate-infra repository from here.

- `lunchlineup-targets.yml`: the one `lunchlineup` scrape job (use it as a `scrape_config_files` entry or paste it into `prometheus.yml`).
- `lunchlineup-rules.yml`: alert rules for the estate Prometheus `rule_files`. Application series use `job="lunchlineup"` with a `service` label; host series use `job="node"` with instance `10.231.10.108:<port>`. Rules about the removed in-stack components (backup, base backup and WAL archive freshness) are dropped.
- `tests/*.test.yml`: `promtool test rules` fixtures for the rules (`promtool test rules docs/estate/tests/*.test.yml`).
- `dashboards/platform-overview.json`, `dashboards/tenant-deletion-billing.json`: Grafana dashboards. They use datasource UIDs `prometheus` and `loki`; map them to the estate datasource UIDs on import. The "Application Logs" panel queries `{job="lunchlineup"}`; adjust the label to whatever the Alloy `log_shipper` role attaches.

## Metrics scrape details (VM107, 10.231.10.108)

The application containers sit on internal Docker networks, so the VM publishes one token-protected gateway, served by the existing `proxy` container (Caddy) and bound to the VM private IP only:

```
http://10.231.10.108:9180/metrics/<service>
```

| Path | Service | Upstream endpoint inside the stack |
| --- | --- | --- |
| `/metrics/api` | retained v1 API | `api:3000/metrics` |
| `/metrics/api-v2` | native API | `api-v2:3002/metrics` |
| `/metrics/worker` | background worker | `worker:3003/metrics` |
| `/metrics/engine` | scheduling engine | `engine:8000/metrics` |
| `/metrics/webhook-replay` | webhook replay worker | `webhook-replay:3004/metrics` |
| `/metrics/control` | control plane | `control:3001/api/metrics` |

Authentication: every request must send `Authorization: Bearer <token>`, where `<token>` is the content of the app's `metrics_token` secret, the file named by `METRICS_TOKEN_FILE` in the VM's runtime env (`/opt/lunchlineup-secrets/secrets/metrics_token` on VM107). The gateway returns `401` without it and `404` for any other path. `api`, `api-v2` and `control` additionally verify the same token themselves; `worker`, `engine` and `webhook-replay` expose unauthenticated exporters on the internal network, so the gateway check is their only protection and they must never be published directly. Put a copy of the token bytes at `/etc/prometheus/secrets/lunchlineup_metrics_token` (mode 0640, readable by the prometheus user) so the scrape job's `authorization.credentials_file` resolves; rotate by changing the secret file on the VM, recreating `proxy`, `api`, `api-v2` and `control`, and updating the estate copy.

Network: the gateway is published only by `infrastructure/development-admission/compose.private-proxy.yml` (bound to `10.231.10.108`) and `infrastructure/production/compose.production-proxy.yml` (bound to `PROXY_HTTP_BIND`, the production VM private IP). The base `docker-compose.yml` and the local Caddyfile publish nothing. CT940 nginx forwards only VM port 80, so port 9180 is not reachable from outside the private network; the estate Prometheus host needs a route/firewall allow to `10.231.10.108:9180`.

Labels produced by `lunchlineup-targets.yml`: `job="lunchlineup"`, `service=<api|api-v2|worker|engine|webhook-replay|control>`, `instance="10.231.10.108:9180"`. Scrape interval 15s, timeout 10s, body limit 8 MB.

Host metrics (disk space, the public web probe, retention-purge timers) are not part of this job. They come from the VM's own node_exporter textfile collector (`/var/lib/node_exporter/textfile_collector`, written by the systemd timers in `infrastructure/systemd/`), which the estate scrapes with its normal node job; the rules expect that job to be named `node` with instance `10.231.10.108:<port>`. Adjust those two selectors if the estate node job is named differently.

## Alert delivery

Alerts reach people only through the estate Alertmanager. The checked-in rules carry `severity` (`critical` or `warning`) and `team` labels for routing and a `runbook` annotation pointing into `docs/runbooks/`. The application has no webhook, no receiver config and no mail path for alerts. Prove a route by firing a test alert at the estate Alertmanager; record that evidence under `LAUNCH_PROOF_ALERT_ROUTE_URL` (`docs/launch/OWNER-CHECKLIST.md`).

## Logs

Compose keeps every service on the `json-file` logging driver with size-capped rotation (`x-locked-runtime`). Alloy tails `/var/lib/docker/containers/*/*-json.log` on the VM and pushes to the estate Loki; nothing in this repository ships logs. Structured fields and redaction are unchanged.

## Backups and recovery

- Postgres: pgBackRest with its repository on the NAS over SFTP, configured outside the app by estate-infra. Attach it by setting `POSTGRES_ARCHIVE_MODE=on` and `POSTGRES_ARCHIVE_COMMAND` in the runtime env (see `infrastructure/postgres/README.md`); both are off/fail-closed by default and Postgres runs normally without them. Restores follow `docs/runbooks/postgres-pitr-recovery.md`.
- Files: host restic online backup (uploads volume, runtime env and secret files).
- The estate drill evidence replaces the former in-stack `backup`/`pitr-*` drills.

## What was removed from this repository

Compose services `prometheus`, `alertmanager`, `grafana`, `loki`, `promtail`, `tempo`, `otel-collector`, `node-exporter`, `backup`, `pitr-base-backup`, `pitr-restore`, `pitr-wal-provider` and `pitr-lifecycle-audit`; their volumes, networks and secrets; the matching Dockerfiles and config directories; the S3 PITR and logical-backup scripts; and the runtime env keys `BACKUP_OFFSITE_*`, `BACKUP_ENCRYPTION_KEY_SECRET_FILE`, `BACKUP_METRICS_FILE`, `PITR_*`, `ALERTMANAGER_WEBHOOK_URL_FILE`, `GRAFANA_USER`, `GRAFANA_PASSWORD` and `OTEL_EXPORTER_OTLP_ENDPOINT`.
