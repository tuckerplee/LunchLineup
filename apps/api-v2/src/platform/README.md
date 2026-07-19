# API v2 Platform Boundaries

## Files

- `README.md`: this platform-folder guide.
- `contract-check.ts`: runtime schema checking with local TypeBox UUID and UTC-instant formats.
- `database.ts`: tenant-RLS transaction boundary and readiness probe.
- `identity.ts`: narrow native session-identity interface and permission helpers.
- `native-identity.test.ts`: direct JWT/session/RBAC/MFA/policy validation and no-retained-fetch regression proof.
- `native-identity.ts`: native v2 session validation, cookie rotation, and bounded Redis MFA-marker store.
- `problem.ts`: RFC 9457 errors and Fastify error normalization.
- `request-security.ts`: same-origin and double-submit CSRF enforcement for unsafe cookie requests.
- `retained-application.bridge.ts`: bounded, exact-route API-02 compatibility transport that replaces spoofable forwarding headers with Fastify's trusted client address and the canonical host/protocol derived from validated `APP_ORIGIN`; declared retained browser domains receive tenant-scoped location public/internal identifier translation only.
- `retained-application.bridge.test.ts`: upstream-target, native-identity-bound location translation, error-translation, traversal, and response-bound regression tests.
