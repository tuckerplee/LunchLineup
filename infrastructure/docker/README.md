# Docker

## Files

- `README.md`: this Docker folder guide.
- `Dockerfile.api`: NestJS API build and runtime image.
- `Dockerfile.api-v2`: contract-first Fastify tenant API image with generated contract and Prisma runtime artifacts.
- `Dockerfile.backup`: required release image for encrypted Postgres backups, request-scoped WAL/lifecycle/PITR provider jobs, S3/rclone offsite copy, and textfile metrics.
- `Dockerfile.control`: out-of-band control plane image.
- `Dockerfile.engine`: Python scheduling engine image.
- `Dockerfile.grafana`: Grafana runtime rebuilt with the fixed Tempo dependency, an application-only static-root assembly, and unused vulnerable bundled data-source executables removed.
- `Dockerfile.loki`: exact Loki release source rebuilt with the patched Go toolchain.
- `Dockerfile.migrations`: database migration image with Prisma tooling and `psql` for restricted application-role provisioning.
- `Dockerfile.node-exporter`: exact node-exporter release source rebuilt with the patched Go toolchain.
- `Dockerfile.pgbouncer`: PgBouncer runtime with current Alpine security packages.
- `Dockerfile.postgres`: Postgres 16 runtime with current Alpine packages and `su-exec` replacing the vulnerable `gosu` helper.
- `Dockerfile.proxy`: exact Caddy release source rebuilt with patched Go dependencies and current Alpine security packages.
- `Dockerfile.tempo`: exact Tempo release source rebuilt with the patched Go toolchain.
- `Dockerfile.web`: Next.js web image.
- `Dockerfile.worker`: background worker image.
- `grafana-healthcheck.go`: static loopback health probe used by the shell-free Grafana runtime.

## API Runtime Note

`Dockerfile.api` copies both root workspace modules and API workspace-local modules into the runtime image. Nest's HTTP driver package can be installed under the API workspace during `npm ci`, so the runtime image must merge that folder into `/app/node_modules`. It also carries the Resend readiness probe and its env parser so disposable browser-beta bootstrap can execute the exact candidate through the image's pinned Node runtime before database or service startup.

## Runtime Users

`Dockerfile.api`, `Dockerfile.api-v2`, `Dockerfile.web`, `Dockerfile.worker`, `Dockerfile.engine`, `Dockerfile.control`, and `Dockerfile.migrations` run their final process as a non-root image user. The API image pre-creates the tenant-export volume path for the Node user; the Python runtimes use Chainguard's numeric non-root identity and disable bytecode writes. The worker image also pre-creates the parser IPC directory; Compose reuses that image for the `pdf-parser` service with no network, no secrets, a read-only root, bounded tmpfs, and a private Unix-socket volume.

`Dockerfile.backup` remains root because the existing host-mounted node-exporter textfile directory is provisioned root-owned. Compose still applies a read-only root filesystem, `no-new-privileges`, drops all capabilities, and exposes only `/backups`, `/metrics`, and bounded `/tmp` as writable paths. Moving backup to non-root requires a coordinated host-directory ownership migration and restore/telemetry proof.

Compose stateful image entrypoints retain their image-default startup capabilities for first-run volume ownership, but run with read-only roots and `no-new-privileges`. Application, edge, control, one-shot tool, and observability services drop all capabilities; Caddy adds back only `NET_BIND_SERVICE`.

The release-built Caddy image retains upstream's UID-0 entrypoint so existing named-volume ownership and ports 80/443 remain compatible; Compose grants only `NET_BIND_SERVICE`, uses a read-only root, and mounts explicit data/config volumes. The optional `autoheal` ops profile still has root-equivalent control through the Docker socket; capability and filesystem hardening do not reduce that socket authority, so keep the profile disabled unless an operator explicitly needs it.

## Image Pinning

Every `FROM` line must use a tag plus immutable `@sha256:` digest. `scripts/verify-release-artifacts.mjs` and `tests/deploy/production-compose.test.mjs` fail if a Dockerfile uses tag-only, `latest`, or otherwise mutable base image refs.

Release-built vendor images fetch exact upstream Git commits, compile with the digest-pinned patched toolchain, and enter the same signed manifest, SBOM, and fail-closed Trivy gates as application images. This keeps service configuration compatible while avoiding mutable vendor tags or vulnerability exceptions.

`Dockerfile.backup` includes `pg_dump`, zstd, GPG, AWS CLI, rclone, Node.js, GNU coreutils, and a client built from the pinned MinIO source revision with a digest-pinned current Go builder. Fixed UID/GID `70` is retained for Postgres-compatible PITR staging. The same immutable image owns logical backup, base-backup, restore, request-scoped WAL upload, and lifecycle-audit jobs. CI publishes it with the application images, and the release manifest verifier requires its digest before deployment.
