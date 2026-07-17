# Web E2E Tests

## Files

- `README.md`: this E2E test folder guide.
- `authenticated-mobile-layout.spec.ts`: 375px authenticated regression covering document width, all dashboard routes, scroll-contained staff controls, horizontal navigation, and shell controls.
- `authenticated-readiness.spec.ts`: default authenticated readiness gate with bounded/exact location fixtures, scoped scheduling, resumable solve polling, shift-update response-loss replay, lunch/break idempotency, time cards, paid-subscription plus separate-credit billing, settings recovery, deletion receipts, and MFA coverage.
- `core-flows.spec.ts`: public entrypoint, onboarding, login, and unauthenticated redirect smoke tests.
- `frontend-accessibility.spec.ts`: rendered Enter-submit onboarding, deterministic error focus, notification-dialog focus trap/Escape restoration, roving settings tabs, pack-specific purchase names, and fixed-size mobile sign-out coverage.
- `lunch-break-recovery.spec.ts`: focused mock-backed Chromium proof for generation A-to-B-to-A plus response loss/reload with one A key/debit, and shared-origin two-page identical setup and generation races with one deterministic key/debit each.
- `mock-api.mjs`: local Playwright API with bounded location lists, exact location reads, count summaries, payroll permissions, scheduling fixtures, metered actions requiring an active paid subscription plus separate credits, and idempotent shift updates and lunch/break generation.
- `month-volume-workflows.spec.ts`: opt-in full-stack 10-person monthly schedule with distinct shift-create keys, schedule deletion, keyed lunch/break setup volume, and generation idempotency contract test.
- `onboarding-recovery.spec.ts`: rendered closed-beta access-state coverage plus desktop/mobile direct, lost-response, and post-MFA first-location recovery with stable idempotency keys, verified-workspace binding, and no OTP resubmission.
- `operations-workflows.spec.ts`: opt-in full-stack staff, schedule, drag/drop, and lunch/break workflow test.
- `payroll-control-surface.spec.ts`: mock-backed payroll lifecycle smoke proving immutable evidence, separate subscription/credit export denial without POST, exact-cost idempotent export, rejected/all-accepted reconciliation correction, exact policy/amendment replay after ambiguous `503` readback, responsive containment, raw sensitive-marker exclusion, logout cleanup, and no cross-user replay.
- `public-launch-accessibility-responsive.spec.ts`: mock-backed desktop/mobile Chromium gate for public, authenticated workspace, and platform-admin document overflow plus serious/critical WCAG violations.
- `public-status-accessibility.spec.ts`: public status page automated-health smoke, login error-announcement coverage, plus automated axe accessibility smoke for public pages.
- `public-web-p1.spec.ts`: focused Chromium regressions for reject-then-success JSON login modes, reset-token URL/history/cookie/Referer containment and retry classes, unknown-route 404s, delayed-hydration branded fallbacks, dashboard boot, and per-widget endpoint failure rendering.
- `public-launch-workflow.spec.ts`: rendered count-summary zero-location recovery/setup routing, bounded location lifecycle/idempotency with explicit timezone payloads, persisted edit resets, open-form 375px overflow coverage, deactivation focus trap/Escape/trigger restoration, keyboard staff invitation, and focused password-recovery states.
- `public-metadata.spec.ts`: real HTTP coverage for public robots, sitemap, and generated social-image status, content, cache/security headers, and absence of login redirects.
- `staff-admin-safety.spec.ts`: manager scheduling-profile workflow with authoritative PDF-import cost preflight and settlement, fail-closed read recovery, skills and overnight availability, Staff-default invitation, destructive-action confirmation, capability separation, and responsive platform-admin coverage.
- `stress-workflows.spec.ts`: mock-backed lunch guided-screen H1/Axe, Strict Mode scoped-read count, 503 stale-row invalidation, delayed setup/scheduled/manual A cleanup versus newer B busy ownership through exactly-once B success, active-location rows/banners/previews/planner/guide fencing, committed-response-loss A-to-B-to-A exact-once setup recovery, and idempotent setup/save coverage plus opt-in full-stack A/B stress flows.
- `support.ts`: shared Playwright helpers for disposable tenant seeding, PIN login, CSRF and per-request headers, and API requests.
- `tenant-admin-workflows.spec.ts`: opt-in full-stack tenant admin and super-admin access workflow coverage.

## Full-stack seed contract

The full-stack specs are skipped unless `E2E_FULL_STACK=1` and `E2E_SEED_COMMAND` are set. `scripts/seed-e2e.mjs` seeds both a tenant admin (`E2E_ADMIN_USERNAME` / `E2E_ADMIN_PIN`) and a super admin (`E2E_SUPER_ADMIN_USERNAME` / `E2E_SUPER_ADMIN_PIN`) so tests can prove normal tenant dashboard access and platform-admin-only routes separately.

Normal local and CI E2E runs start `mock-api.mjs` unless `BASE_URL`, `E2E_FULL_STACK=1`, or `E2E_MOCK_API=0` is set. That default mock layer keeps the Playwright gate from passing with only public smoke: the Chromium readiness spec logs in with the seeded PIN user, opens scheduling, creates a shift, generates breaks, writes a time card, and proves credit-pack Checkout initiation/return without contacting Stripe or changing the server-reported balance. Mock billable access always requires both an active paid subscription and a positive separately purchased or granted credit balance; plans and trials grant no credits. Use `E2E_PUBLIC_SMOKE_ONLY=1` only when intentionally running unauthenticated public smoke.

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
