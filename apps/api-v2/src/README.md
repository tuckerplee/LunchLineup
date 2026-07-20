# API v2 Source

## Files

- `README.md`: this source-folder guide.
- `config.test.ts`: hardened proxy and runtime-configuration regression tests.
- `config.ts`: validated runtime configuration.
- `main.ts`: bounded process startup and shutdown.
- `server.ts`: Fastify assembly, OpenAPI, health, and module registration.
- `server.test.ts`: HTTP contract, OpenAPI, and route-level security tests.
- `application/`: explicit non-scheduling browser API routes and their API-02 compatibility ownership.
- `locations/`: native API-02 tenant-location lifecycle and public-ID boundary.
- `notifications/`: native tenant notification feed and read-state boundary with opaque public IDs.
- `operations/`: native operational read models and lunch/break planning persistence.
- `platform/`: database, native session identity, request-security, compatibility transport, and Problem Details boundaries.
- `scheduling/`: board query and atomic change-set domain module.
- `settings/`: native tenant workspace-settings aggregate and security-policy audit boundary.
- `time/`: native public time-card lifecycle, payroll lock, idempotency, and correction module.
