# API v2 Platform Boundaries

## Files

- `README.md`: this platform-folder guide.
- `contract-check.ts`: runtime schema checking with local TypeBox UUID and UTC-instant formats.
- `database.ts`: tenant-RLS transaction boundary and readiness probe.
- `identity.ts`: temporary, bounded v1 session-validation adapter.
- `problem.ts`: RFC 9457 errors and Fastify error normalization.
- `request-security.ts`: same-origin and double-submit CSRF enforcement for unsafe cookie requests.
