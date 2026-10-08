# API v2 Platform Boundaries

## Files

- `credit-capacity-refusal.test.ts`: Retained credit-capacity refusal mapping to an actionable native error without a successful grant acknowledgement.

- `README.md`: this platform-folder guide.
- `contract-check.ts`: runtime schema checking with local TypeBox UUID and UTC-instant formats.
- `database.ts`: tenant-RLS transaction boundary and readiness probe.
- `feature-entitlement.ts`: native paid-feature authorization plus beta-host-only, expiring scheduling grants that require exact positive-credit ledger and attributed audit proof, tenant locking, and immutable credit-ledger settlement shared by API-v2 domains.
- `identity.ts`: narrow native session-identity interface and permission helpers.
- `native-identity.test.ts`: direct JWT/session/RBAC/MFA/policy validation and no-retained-fetch regression proof.
- `native-identity.ts`: native v2 session validation, cookie rotation, and bounded Redis MFA-marker store.
- `problem.ts`: RFC 9457 errors and Fastify error normalization, including Prisma/PostgreSQL concurrent-write conflict mapping.
- `request-security.ts`: same-origin and double-submit CSRF enforcement for unsafe cookie requests.
- `retained-application.bridge.ts`: bounded, exact-route API-02 compatibility transport that replaces spoofable forwarding headers with Fastify's trusted client address and the canonical host/protocol derived from validated `APP_ORIGIN`; declared retained browser domains receive tenant-scoped location public/internal identifier translation only.
- `retained-application.bridge.test.ts`: upstream-target, native-identity-bound location translation, error-translation, traversal, and response-bound regression tests.
- `retained-operator.bridge.ts`: a narrow bearer-only API-03 operator adapter for the scheduled retention purge; it forwards neither browser cookies nor caller-provided upstream targets.
- `retained-operator.bridge.test.ts`: bearer-only target, response-bound, and no-cookie-forwarding regression tests for the operator adapter.
- `metrics-token.test.ts`: startup token selection and bounded secret-file reader regressions using synthetic readers.
- `metrics-token.ts`: explicit native metrics credential selection and bounded regular-file token reading.
- `metrics.test.ts`: bounded private metrics hook and loopback HTTP regressions for request outcomes and registry isolation.
- `metrics.ts`: authenticated native metrics exposition with bounded route labels and instance-owned request collectors.
- `native-quota-owners.ts`: server-owned operation-to-retained-handler keys for native quota compatibility.
- `native-quota-storage-availability-http.test.ts`: quota storage unavailability classification through actual loopback HTTP with controlled Redis and tenant lookups.
- `native-quota-storage.test.ts`: quota Redis protocol, finite transport and owned-client cleanup regressions with a fake client.
- `native-quota-storage.ts`: Redis sliding-window quota storage with finite operations, readiness probes and owned-client cleanup.
- `native-quota.test.ts`: plan quota key, principal/tenant charging, readiness and refusal regressions.
- `native-quota.ts`: current plan resolution and principal/tenant quota charging for server-owned operations.
