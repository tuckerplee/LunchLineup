# Web lib

Shared helpers for the Next.js web app.

## Files

- `README.md`: this web lib folder guide.
- `client-api.ts`: browser-side API fetch helper with coalesced session refresh, rotated CSRF replay headers, same-origin enforcement, and canonical idempotent-attempt keys preserved through retries.
- `latest-request.ts`: generation-based gate for discarding superseded client request completions.
- `location-timezone.ts`: location-local date/range, wall-clock conversion, and display formatting helpers.
- `permissions.ts`: shared workspace permission capability matrix for read/write-aware UI, including complete scheduling and lunch/location read prerequisites.
- `server-auth.ts`: server-only auth helpers for App Router pages.
- `utils.ts`: small shared utility helpers.
- `workspace-slug.ts`: canonical workspace slug persistence used by onboarding and login prefill.
