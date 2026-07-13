# Docker

## Files

- `README.md`: this Docker folder guide.
- `Dockerfile.api`: NestJS API build and runtime image.
- `Dockerfile.backup`: required release image for encrypted Postgres backups, S3/rclone offsite copy, and textfile metrics.
- `Dockerfile.control`: out-of-band control plane image.
- `Dockerfile.engine`: Python scheduling engine image.
- `Dockerfile.migrations`: database migration image with Prisma tooling and `psql` for restricted application-role provisioning.
- `Dockerfile.web`: Next.js web image.
- `Dockerfile.worker`: background worker image.

## API Runtime Note

`Dockerfile.api` copies both root workspace modules and API workspace-local modules into the runtime image. Nest's HTTP driver package can be installed under the API workspace during `npm ci`, so the runtime image must merge that folder into `/app/node_modules`.

## Image Pinning

Every `FROM` line must use a tag plus immutable `@sha256:` digest. `scripts/verify-release-artifacts.mjs` and `tests/deploy/production-compose.test.mjs` fail if a Dockerfile uses tag-only, `latest`, or otherwise mutable base image refs.

`Dockerfile.backup` includes `pg_dump`, zstd, GPG, AWS CLI, and rclone so the same image can execute the complete one-shot backup contract. CI publishes it with the application images, and the release manifest verifier requires its digest before deployment.
