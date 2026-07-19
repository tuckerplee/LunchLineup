# API v2 Source

## Files

- `README.md`: this source-folder guide.
- `config.test.ts`: hardened proxy and runtime-configuration regression tests.
- `config.ts`: validated runtime configuration.
- `main.ts`: bounded process startup and shutdown.
- `server.ts`: Fastify assembly, OpenAPI, health, and module registration.
- `server.test.ts`: HTTP contract, OpenAPI, and route-level security tests.
- `application/`: explicit non-scheduling browser API routes and their API-02 compatibility ownership.
- `platform/`: database, native session identity, request-security, compatibility transport, and Problem Details boundaries.
- `scheduling/`: board query and atomic change-set domain module.
