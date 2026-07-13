# Infrastructure

## Files

- `README.md`: this infrastructure folder guide.

## Directories

- `alertmanager/`: private Alertmanager routing configuration.
- `caddy/`: Caddy reverse proxy configuration for the Docker Compose edge service.
- `control/`: host-side bounded public edge probe and control observability scripts.
- `docker/`: Dockerfiles for application service images.
- `grafana/`: Grafana provisioning configuration.
- `loki/`: Loki log storage configuration.
- `otel-collector/`: internal OTLP receiver, buffering, and Tempo export configuration.
- `pgbouncer/`: database connection pooler configuration.
- `postgres/`: Postgres runtime configuration.
- `prometheus/`: Prometheus scrape configuration.
- `promtail/`: read-only Docker JSON log shipping to Loki.
- `rabbitmq/`: RabbitMQ broker configuration.
- `redis/`: Redis cache/session configuration.
- `systemd/`: host-level units for encrypted backup, public edge availability, and safe retained-record scheduler installation.
- `tempo/`: Tempo tracing configuration.
- `terraform/`: infrastructure-as-code material.

## Deploy Notes

The Compose edge proxy reads `caddy/Caddyfile`. For VM107 dev deploys, keep the hostnames aligned with the private routes documented in the LunchLineup dev host docs.

Docker base images and non-application Compose service images are pinned with `@sha256:` digests. Update the tag and digest together, then run `node --test tests/deploy/production-compose.test.mjs` before release.
