# Docker

## Files

- `README.md`: this Docker folder guide.
- `Dockerfile.api`: NestJS API build and runtime image.
- `Dockerfile.backup`: required release image for encrypted Postgres backups, request-scoped WAL/lifecycle/PITR provider jobs, S3/rclone offsite copy, and textfile metrics.
- `Dockerfile.control`: out-of-band control plane image.
- `Dockerfile.engine`: Python scheduling engine image.
- `Dockerfile.migrations`: database migration image with Prisma tooling and `psql` for restricted application-role provisioning.
- `Dockerfile.web`: Next.js web image.
- `Dockerfile.worker`: background worker image.

## API Runtime Note

`Dockerfile.api` copies both root workspace modules and API workspace-local modules into the runtime image. Nest's HTTP driver package can be installed under the API workspace during `npm ci`, so the runtime image must merge that folder into `/app/node_modules`.

## Runtime Users

`Dockerfile.api`, `Dockerfile.web`, `Dockerfile.worker`, `Dockerfile.engine`, `Dockerfile.control`, and `Dockerfile.migrations` run their final process as a non-root image user. The API image pre-creates the tenant-export volume path for the Node user; Python images use fixed UID/GID `10001` and disable bytecode writes. The worker image also pre-creates the UID-10001 parser IPC directory; Compose reuses that image for the `pdf-parser` service with no network, no secrets, a read-only root, bounded tmpfs, and a private Unix-socket volume.

`Dockerfile.backup` remains root because the existing host-mounted node-exporter textfile directory is provisioned root-owned. Compose still applies a read-only root filesystem, `no-new-privileges`, drops all capabilities, and exposes only `/backups`, `/metrics`, and bounded `/tmp` as writable paths. Moving backup to non-root requires a coordinated host-directory ownership migration and restore/telemetry proof.

Compose stateful image entrypoints retain their image-default startup capabilities for first-run volume ownership, but run with read-only roots and `no-new-privileges`. Application, edge, control, one-shot tool, and observability services drop all capabilities; Caddy adds back only `NET_BIND_SERVICE`.

The pinned upstream Caddy image has no non-root OS user and binds ports 80/443, so the edge remains UID 0 with only `NET_BIND_SERVICE`, a read-only root, and explicit data/config volumes. A non-root edge requires a custom pinned image or an internal high-port migration with volume-ownership and routing proof. The optional `autoheal` ops profile still has root-equivalent control through the Docker socket; capability and filesystem hardening do not reduce that socket authority, so keep the profile disabled unless an operator explicitly needs it.

## Image Pinning

Every `FROM` line must use a tag plus immutable `@sha256:` digest. `scripts/verify-release-artifacts.mjs` and `tests/deploy/production-compose.test.mjs` fail if a Dockerfile uses tag-only, `latest`, or otherwise mutable base image refs.

`Dockerfile.backup` includes `pg_dump`, zstd, GPG, AWS CLI, rclone, Node.js, GNU coreutils, a digest-pinned MinIO client, and fixed UID/GID `70` for Postgres-compatible PITR staging. The same immutable image owns logical backup, base-backup, restore, request-scoped WAL upload, and lifecycle-audit jobs. CI publishes it with the application images, and the release manifest verifier requires its digest before deployment.
