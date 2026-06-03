# Docker

## Files

- `README.md`: this Docker folder guide.
- `Dockerfile.api`: NestJS API build and runtime image.
- `Dockerfile.backup`: backup job image.
- `Dockerfile.control`: out-of-band control plane image.
- `Dockerfile.engine`: Python scheduling engine image.
- `Dockerfile.migrations`: database migration image.
- `Dockerfile.web`: Next.js web image.
- `Dockerfile.worker`: background worker image.

## API Runtime Note

`Dockerfile.api` copies both root workspace modules and API workspace-local modules into the runtime image. Nest's HTTP driver package can be installed under the API workspace during `npm ci`, so the runtime image must merge that folder into `/app/node_modules`.
