# API v2 People Owner

This folder owns the native API-02 People surface: tenant staff directory and profiles, access roles and assignments, PIN administration, staff deactivation, and the durable invitation-command producer. All browser-visible staff and role identifiers are stable public UUIDs; retained API-02 domains can cross the temporary anti-corruption seam only through exact `userId` and `userIds` fields.

## Files

- `README.md`: this folder guide.
- `access.ts`: transactional role/access snapshots, authorization revalidation, delegation checks, locks, and tenant-scoped ID resolution.
- `deactivation.ts`: native staff tombstone, availability-import refund/cancellation, editable-shift cleanup, credential/PII erasure, and bounded post-commit local-file cleanup.
- `deactivation.test.ts`: parity coverage for the native deactivation lifecycle and its fail-closed credit/schedule cleanup boundaries.
- `identifier-translation.ts`: narrow public/internal user-ID translation for declared retained domains only.
- `identifier-translation.test.ts`: request, response, path, and fail-closed tests for that translation seam.
- `invitation-outbox.ts`: encrypted durable invitation-command producer, retry/reissue state, and delivery response projection.
- `invitation-outbox.test.ts`: encryption and configuration fail-closed tests for invitation command production.
- `people.service.ts`: native People resource orchestration, public serialization, scheduling-profile persistence, access-role and staff-deactivation lifecycle, and PIN flows.
- `people.service.test.ts`: public-identifier, catalog, cursor, and resolver service tests.
- `routes.ts`: typed Fastify routes, HTTP-level permission checks, CSRF, and MFA boundaries for native People operations.
