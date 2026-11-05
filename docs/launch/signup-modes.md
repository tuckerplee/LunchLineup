# Public signup modes

LunchLineup has one signup switch pair. Both values must be identical:

| Variable | Read by | When it takes effect |
| --- | --- | --- |
| `PUBLIC_SIGNUP_MODE` | API (`apps/api`, `AuthService.getPublicSignupMode`) | Runtime. Change it in the runtime env and restart the API. |
| `NEXT_PUBLIC_SIGNUP_MODE` | Web (`apps/web`, `normalizePublicSignupMode`) | **Build time.** Next.js inlines it into the browser bundle; it is a Docker build arg (`infrastructure/docker/Dockerfile.web`, `docker-compose.yml` `web.build.args`) and is also part of the signed public-build contract. Changing it requires a new web image. |

Because they are read at different times, a mismatch is possible. It is blocked in three places:
`scripts/check-production-env.mjs` and `scripts/validate-production-launch.mjs` reject unequal values before deploy, and
`validateProductionEnvironment()` in `apps/api/src/common/bootstrap-security.ts` refuses API startup if the API sees both and they differ.

## Legal gate (applies to every mode except closed_beta)

Production is code-locked to `closed_beta` until counsel approval is recorded in the single legal config,
`packages/config/legal-launch.json` (`approval.approved: true` plus `termsVersion` / `privacyVersion` equal to the current
document versions). While that switch is off:

- the API reports `closed_beta` regardless of `PUBLIC_SIGNUP_MODE` (`hasCurrentSelfServiceLegalApproval()`),
- the web normalizes to `closed_beta` regardless of `NEXT_PUBLIC_SIGNUP_MODE`,
- API startup **fails** if `PUBLIC_SIGNUP_MODE` is `invite_only` or `open`.

An unset `PUBLIC_SIGNUP_MODE` means `closed_beta` in production (it only defaults to `open` for local development).

## `closed_beta` (default, safe)

- No self-service workspace creation. `/onboarding` shows the closed state; the landing page links to `/auth/login`.
- API rejects any public workspace signup request with 403 ("Public workspace signup is not available.").
- Accounts are created only by an operator or by a tenant admin inviting staff into an existing workspace.
- Needs no extra prerequisites and no counsel approval.

## `invite_only`

- `/onboarding` is available but requires a signup code.
- API accepts a signup only when the supplied code matches one entry of `PUBLIC_SIGNUP_INVITE_CODES` (comma separated, constant-time compare).
- Terms and Privacy assent (current versions) is required before a workspace is created.
- Startup prerequisites: counsel approval recorded in `legal-launch.json`; `PUBLIC_SIGNUP_INVITE_CODES` has at least one code; Stripe live key/webhook and the `STRIPE_PRICE_STARTER|GROWTH|ENTERPRISE` prices; Resend key/webhook/`EMAIL_FROM` (OTP emails).
- No bot challenge is applied. Treat the codes as secrets and rotate them by editing the runtime env and restarting the API.

## `open`

- Anyone can create a workspace from `/onboarding`.
- Terms and Privacy assent is required, and every OTP request must carry a Cloudflare Turnstile token verified server-side.
- Startup prerequisites (API refuses to start otherwise): counsel approval in `legal-launch.json`; `TURNSTILE_SECRET_KEY`; the three `STRIPE_PRICE_*` plan prices; Stripe and Resend credentials (always required in production). The web build additionally needs `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, enforced by `scripts/check-production-env.mjs` and the CI build.
- Without `TURNSTILE_SECRET_KEY` the API would answer 503 to signup requests in production; the startup gate catches this earlier.

## Switching modes

1. Decide the mode (owner decision) and, for anything but `closed_beta`, finish counsel review (`docs/launch/legal-review-packet.md`) and set `approval` in `packages/config/legal-launch.json`.
2. Set both variables identically in the runtime env.
3. Run `node scripts/check-production-env.mjs <runtime.env>`.
4. Build a new web image (the mode is compile-time), then restart the API.

Known stale copy: the landing page primary button still reads "Open beta workspace" while signup is closed; change it with the launch copy review.
