# Onboarding Route

Public SaaS signup route for creating a tenant workspace from an email OTP.

## Files

- `README.md`: this onboarding route guide.
- `TurnstileChallenge.tsx`: compact Cloudflare Turnstile loader with token, reset, and script-unavailable fallback handling for open signup.
- `challenge.ts`: pure signup mode and OTP payload helpers, including explicit Terms/Privacy assent and opaque durable onboarding challenge fields, used by the onboarding page and focused tests.
- `first-location-recovery.ts`: session-scoped, non-secret first-location retry contract with a stable idempotency key, expiry, and success cleanup helpers.
- `page.tsx`: client-side onboarding flow that collects account, legal assent, invite code when required, organization, first location, and email verification details; it retains the opaque server challenge in memory for verification/session retries, while first-location provisioning resumes after MFA or transient failures.

## Notes

Production always normalizes public signup to closed beta while the checked-in Terms are not counsel-approved and versioned. Environment values cannot enable production invite-only or open signup. Outside production, missing mode defaults to open so invite and Turnstile flows remain testable; open signup uses Cloudflare Turnstile when a public site key is configured.

The generated workspace slug is saved in browser local storage and included in a 30-minute, session-scoped first-location recovery record. The recovery record contains only a random idempotency key, slug, organization, location, timezone, and creation time; OTPs and session tokens remain out of browser storage. The same key is sent on every location retry, and the record is cleared only after location creation succeeds or the record expires. The completion view displays the slug before the owner enters the dashboard.
