# Control Observability

## Files

- `README.md`: this host-side control and observability guide.
- `public-web-probe.sh`: bounded HTTPS probe that compares the public release header with `/opt/lunchlineup/current/DEPLOYED_GIT_SHA` and publishes public edge availability through the node-exporter textfile collector.

## Public Web Probe

The probe runs outside the application Compose networks so it exercises public DNS, TLS, Caddy, and the Next.js root page. It accepts only a canonical public HTTPS root URL, disables redirects, limits connection and total request time, caps response bytes, and verifies `X-LunchLineUp-Release`, the LunchLineup heading, and a Next.js static asset marker. It writes metrics atomically and exits nonzero on every failed check.

Install and schedule it with the files in `infrastructure/systemd/`. Prometheus receives the metrics through the existing node-exporter textfile collector; no additional container or public port is required.
