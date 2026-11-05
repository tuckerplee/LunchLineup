# Infrastructure

## Files

- `README.md`: this infrastructure folder guide.

## Directories

- `caddy/`: Caddy reverse proxy configuration for the Docker Compose edge service, including the token-protected estate metrics gateway (`:9180`) in the private and production variants.
- `ci/`: local-CI runtime service inventory used for exact release qualification.
- `control/`: host-side bounded public edge probe and control observability scripts.
- `custom-ci/`: reviewed external receipt-signing helper, policy, and installation contract.
- `docker/`: Dockerfiles for application service images.
- `pgbouncer/`: database connection pooler configuration.
- `postgres/`: Postgres runtime configuration.
- `rabbitmq/`: RabbitMQ broker configuration.
- `redis/`: Redis cache/session configuration.
- `systemd/`: host-level units for public edge availability and safe retained-record scheduler installation.
- `terraform/`: infrastructure-as-code material.
- `production/`: production runtime env template (`runtime.env.example`, no secrets) validated by `scripts/check-production-env.mjs`.

## Deploy Notes

The Compose edge proxy reads `caddy/Caddyfile`. For VM107 dev deploys, keep the hostnames aligned with the private routes documented in the LunchLineup dev host docs.

Alerting, metrics storage, dashboards, logs, tracing and backups are estate systems (`docs/estate/README.md`); this folder holds no configuration for them.

Docker base images and non-application Compose service images are pinned with `@sha256:` digests. Update the tag and digest together, then run `node --test tests/deploy/production-compose.test.mjs` before release.
