# Web E2E Tests

## Files

- `README.md`: this E2E test folder guide.
- `authenticated-mobile-layout.spec.ts`: 375px authenticated regression covering document width, all dashboard routes, horizontal navigation, and shell controls.
- `authenticated-readiness.spec.ts`: default authenticated readiness gate using the local mock API plus existing PIN login helper, including containing weekly-draft IDs on overnight manual shift creation, linked-location scheduling, reload-resumable auto-schedule polling without duplicate requests, lunch/break idempotency, delayed Uptown-to-Downtown load isolation, billing recovery controls, fail-closed settings read recovery, and mandatory MFA enrollment plus announced verification errors and support-backed factor recovery coverage.
- `core-flows.spec.ts`: public entrypoint, onboarding, login, and unauthenticated redirect smoke tests.
- `mock-api.mjs`: local mock API process started by Playwright for non-full-stack authenticated readiness coverage, including containing-draft manual shifts, complete overnight fallback windows, draft demand setup, no-demand auto-schedule rejection, and mandatory lunch/break generation idempotency.
- `month-volume-workflows.spec.ts`: opt-in full-stack 10-person monthly schedule, schedule deletion, lunch/break setup volume, and generation idempotency contract test.
- `onboarding-recovery.spec.ts`: desktop/mobile regression coverage for direct, lost-response, and post-MFA first-location recovery with stable idempotency keys and no OTP resubmission.
- `operations-workflows.spec.ts`: opt-in full-stack staff, schedule, drag/drop, and lunch/break workflow test.
- `public-status-accessibility.spec.ts`: public status page automated-health smoke, login error-announcement coverage, plus automated axe accessibility smoke for public pages.
- `staff-admin-safety.spec.ts`: manager scheduling-profile workflow with fail-closed read recovery, skills and location-scoped overnight availability, delegable-only Staff-default invitation, explicit staff and custom-role destructive-action confirmation, manager/admin capability separation, assignment-aware deletion blocking, and responsive platform-admin sign-out coverage.
- `stress-workflows.spec.ts`: opt-in full-stack A/B stress coverage for messy schedule interactions, lunch setup recovery, and time-card mistakes.
- `support.ts`: shared Playwright helpers for disposable tenant seeding, PIN login, CSRF and per-request headers, and API requests.
- `tenant-admin-workflows.spec.ts`: opt-in full-stack tenant admin and super-admin access workflow coverage.

## Full-stack seed contract

The full-stack specs are skipped unless `E2E_FULL_STACK=1` and `E2E_SEED_COMMAND` are set. `scripts/seed-e2e.mjs` seeds both a tenant admin (`E2E_ADMIN_USERNAME` / `E2E_ADMIN_PIN`) and a super admin (`E2E_SUPER_ADMIN_USERNAME` / `E2E_SUPER_ADMIN_PIN`) so tests can prove normal tenant dashboard access and platform-admin-only routes separately.

Normal local and CI E2E runs start `mock-api.mjs` unless `BASE_URL`, `E2E_FULL_STACK=1`, or `E2E_MOCK_API=0` is set. That default mock layer keeps the Playwright gate from passing with only public smoke: the Chromium readiness spec logs in with the seeded PIN user, opens scheduling, creates a shift, generates breaks, and writes a time card. Use `E2E_PUBLIC_SMOKE_ONLY=1` only when intentionally running unauthenticated public smoke.

## Shared checkout execution

Default local and CI Playwright runs pick per-run high ports, start the mock API, and launch the web app with `next dev` and `NODE_ENV=development`. Mock runs use one worker with `fullyParallel` disabled because every spec shares the same resettable mock state. This keeps mock signup and onboarding coverage non-production without weakening the production `closed_beta` normalization.

`BASE_URL` still targets an already running environment without starting local servers. `E2E_FULL_STACK=1` still disables the mock API, and non-mock runs retain their existing production build/start fallback unless `E2E_USE_NEXT_DEV=1` or `E2E_WEB_COMMAND` explicitly overrides it. The mock-only development and serialization settings do not apply to those paths.

Run the authenticated readiness spec:

```powershell
npm.cmd run test:e2e --workspace @lunchlineup/web -- --project=chromium authenticated-readiness.spec.ts
```

Use explicit free ports only when needed:

```powershell
$env:PLAYWRIGHT_PORT='4310'
$env:PLAYWRIGHT_API_PORT='4311'
npm.cmd run test:e2e --workspace @lunchlineup/web -- --project=chromium authenticated-readiness.spec.ts
```
