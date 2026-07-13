# Control Plane

Out-of-band operational control-plane service. The process binds to loopback by default; production requires an admin bearer token for `/api/status` and `/api/control/*`, plus a separate metrics bearer token for `/api/metrics`. Docker-backed status is disabled unless `CONTROL_PLANE_DOCKER_STATUS=enabled` and `CONTROL_PLANE_DOCKER_SOCKET_PATH` are set explicitly.

## Files

- `README.md`: this folder guide.
- `package.json`: workspace package metadata and scripts.
- `tsconfig.json`: TypeScript compiler configuration for the control-plane service.

## Folders

- `dist/`: generated JavaScript and type declarations emitted by `npm run build`.
- `src/`: TypeScript service source.
- `tests/`: Node tests for the control-plane runtime contract.
