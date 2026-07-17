# Onboarding Route

Public SaaS signup route for creating a tenant workspace from an email OTP.

## Files

- `README.md`: this onboarding route guide.
- `TurnstileChallenge.tsx`: compact Cloudflare Turnstile loader with token, reset, and script-unavailable fallback handling for open signup.
- `challenge.ts`: pure signup mode, OTP payload, structured API-error, and network-recovery helpers, including explicit Terms/Privacy assent and opaque durable onboarding challenge fields.
- `first-location-recovery.ts`: session-scoped, non-secret first-location retry contract with a stable idempotency key, expiry, and success cleanup helpers.
- `first-location-transport.ts`: authenticated first-location POST using bounded single-flight session refresh and idempotency-gated replay.
- `page.tsx`: semantic, Enter-submittable client onboarding form with focused live errors and status updates; production closed beta renders a clear access state instead of a disabled form, while enabled modes retain the opaque server challenge in memory and resume workspace-bound first-location provisioning after MFA, lost responses, or transient failures.

## Notes

Production always normalizes public signup to closed beta while the checked-in Terms are not counsel-approved and versioned. Environment values cannot enable production invite-only or open signup. Outside production, missing mode defaults to open so invite and Turnstile flows remain testable; open signup uses Cloudflare Turnstile when a public site key is configured.

The generated workspace slug is saved in browser local storage and included in a 30-minute, session-scoped first-location recovery record. The recovery record contains only a random idempotency key, slug, organization, location, timezone, and creation time; OTPs and session tokens remain out of browser storage. Every retry sends the same key and verified workspace slug. An expired access token triggers one bounded, coalesced session refresh, then replays only that keyed location POST with the same body and key; rejected refreshes redirect to sign-in without replaying the write. The single-use OTP verification remains on the public, non-refreshing transport and is never part of location recovery. The API rejects a changed-session workspace and permits organization-name handoff only while creating the first active location. The record is cleared only after location creation succeeds or expires, and the completion view displays the slug before dashboard entry.
