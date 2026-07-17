# Web lib

Shared helpers for the Next.js web app.

## Files

- `README.md`: this web lib folder guide.
- `bounded-pagination.ts`: guarded multi-page continuation helper for bounded schedule, shift, roster, and lunch-break reads.
- `user-directory-pagination.ts`: fixed-size user-directory request and cursor-validation helpers.
- `client-api.ts`: browser-side authenticated and public API fetch helper with bounded deadlines/bodies, coalesced session refresh, rotated CSRF headers, safe error normalization, same-origin/no-follow enforcement, and idempotency-gated unsafe replay.
- `http-safety.ts`: shared request-deadline and bounded response-body primitives for browser, proxy, route, and server probes.
- `latest-request.ts`: generation-based gate for discarding superseded client request completions.
- `location-timezone.ts`: location-local date/range, wall-clock conversion, unambiguous DST persistence, and display formatting helpers.
- `permissions.ts`: shared workspace permission capability matrix for read/write-aware UI, including complete scheduling and lunch/location read prerequisites.
- `safe-navigation.ts`: shared same-origin return-path scrubbing and approved application-origin validation for browser and proxy redirects.
- `server-auth.ts`: server-only auth helpers for App Router pages with non-sensitive debug metadata.
- `utils.ts`: small shared utility helpers.
- `workspace-slug.ts`: canonical workspace slug persistence used by onboarding and login prefill.
