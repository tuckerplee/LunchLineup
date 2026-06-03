# Infrastructure

## Files

- `README.md`: this infrastructure folder guide.

## Directories

- `caddy/`: Caddy reverse proxy configuration for the Docker Compose edge service.
- `docker/`: Dockerfiles for application service images.
- `grafana/`: Grafana provisioning configuration.
- `loki/`: Loki log storage configuration.
- `pgbouncer/`: database connection pooler configuration.
- `postgres/`: Postgres runtime configuration.
- `prometheus/`: Prometheus scrape configuration.
- `rabbitmq/`: RabbitMQ broker configuration.
- `redis/`: Redis cache/session configuration.
- `tempo/`: Tempo tracing configuration.
- `terraform/`: infrastructure-as-code material.

## Deploy Notes

The Compose edge proxy reads `caddy/Caddyfile`. For VM107 dev deploys, keep the hostnames aligned with the private routes documented in the LunchLineup dev host docs.
