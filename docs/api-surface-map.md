# LunchLineup API Surface Map

This is the source-of-truth map for the HTTP and RPC boundaries serving `beta.lunchlineup.com`. It distinguishes the new public contract from retained compatibility code so a browser-facing feature cannot quietly add another legacy endpoint.

## Request Path

```text
browser (application traffic uses /api/v2 only)
  -> Cloudflare DNS/proxy
  -> Caddy on VM107
       /api/v2/* -> api-v2:3002 (Fastify, new public contract)
       /api/v1/* -> api:3000    (NestJS, retained application API)
       /api/health and /health -> api:3000
       everything else -> web:3000

api-v2
  -> PostgreSQL with tenant RLS for native v2 session, location, scheduling, and Operations reads/writes
  -> Redis for bounded MFA session-marker validation
  -> selected private v1 scheduling operations for publication billing/notification
     and solver-queue compatibility
  -> exact 89-operation API-01 compatibility catalog for remaining browser domains

worker -> RabbitMQ, PostgreSQL, engine:50051 gRPC, parser Unix socket
control -> private operator status/health/metrics only
```

The browser no longer targets `/api/v1`. It cannot address an undeclared API-01 path, and API v2 does not expose the old row-at-a-time schedule/shift mutation routes. Native v2 scheduling responses contain only stable public UUIDs for users, locations, schedules, shifts, and solve jobs. Strings such as `demo-shift-05-casey-v1` were legacy fixture shift resource IDs, not separate APIs per person. The broken behavior came from the old calendar issuing one mutable request per shift and colliding with schedule state; v2 replaces that fan-out with one aggregate change set.

## Public API v2

External paths include `/api`; the service receives the same path after Caddy removes that prefix.

| Method | Public path | Resource/operation | Concurrency and replay |
| --- | --- | --- | --- |
| GET | `/api/v2/live` | process liveness | none |
| GET | `/api/v2/ready` | database readiness | none |
| GET | `/api/v2/version` | service and release SHA | none |
| GET | `/api/v2/openapi.json` | generated OpenAPI 3.1 contract | five-minute public cache |
| GET | `/api/v2/locations` | list active locations by opaque public-ID cursor | private, no-store |
| POST | `/api/v2/locations` | create a location | optional `Idempotency-Key` durable replay |
| GET | `/api/v2/locations/summary` | count active locations | private, no-store |
| GET | `/api/v2/locations/{locationId}` | read one location by public UUID | private, no-store |
| PUT | `/api/v2/locations/{locationId}` | update a location and fence affected draft schedules | private, no-store |
| DELETE | `/api/v2/locations/{locationId}` | soft-delete a location and fence affected draft schedules | private, no-store |
| GET | `/api/v2/schedules` | bounded operational schedule summaries | opaque public-ID cursor |
| GET | `/api/v2/shifts/staff-roster` | bounded schedulable staff roster | opaque public-ID cursor |
| GET | `/api/v2/shifts` | bounded operational shift summaries | opaque public-ID cursor |
| GET | `/api/v2/lunch-breaks` | bounded lunch/break planning rows | opaque public-ID cursor |
| GET | `/api/v2/lunch-breaks/policy` | read lunch/break planning policy | private, no-store |
| PUT | `/api/v2/lunch-breaks/policy` | update lunch/break planning policy | same-origin CSRF |
| POST | `/api/v2/lunch-breaks/generate` | generate a preview or persist a bounded plan | `Idempotency-Key` for durable request replay |
| POST | `/api/v2/lunch-breaks/setup-shifts` | atomically create/update manual setup shifts | `Idempotency-Key` |
| PUT | `/api/v2/lunch-breaks/shift/{shiftId}` | replace one draft shift's break plan | `Idempotency-Key` |
| GET | `/api/v2/schedule-board` | bounded screen read model for one date/view/location | private, no-store |
| POST | `/api/v2/locations/{locationId}/schedules` | create a draft schedule | `Idempotency-Key` |
| POST | `/api/v2/schedules/{scheduleId}/change-sets` | atomically create/update/delete up to 100 shifts | `If-Match` plus `Idempotency-Key` |
| GET | `/api/v2/schedules/{scheduleId}/demand-windows` | read schedule demand | private, no-store |
| PUT | `/api/v2/schedules/{scheduleId}/demand-windows` | replace demand as one aggregate revision | `If-Match` plus `Idempotency-Key` |
| GET | `/api/v2/schedules/{scheduleId}/publish-plan` | authoritative publish cost/readiness | private, no-store |
| POST | `/api/v2/schedules/{scheduleId}/publications` | publish using an accepted cost contract | `Idempotency-Key` |
| POST | `/api/v2/schedules/{scheduleId}/reopenings` | reopen a published schedule | `If-Match` plus `Idempotency-Key` |
| POST | `/api/v2/schedules/{scheduleId}/solve-jobs` | queue an automatic scheduling job | `Idempotency-Key` |
| GET | `/api/v2/schedules/{scheduleId}/solve-jobs/{jobId}` | read one solve job | private, no-store |
| POST | `/api/v2/break-generations` | generate and persist breaks for selected shifts | `Idempotency-Key` |

The 121 browser operations are registered explicitly from `packages/api-contract/src/application.ts`. Thirty-two are native (`GET /auth/me`, six location operations, sixteen people/access operations, and nine Operations resources); the remaining 89 compatibility operations cover authentication (16), the temporary user-deletion lifecycle (1), time cards (6), payroll (17), notifications (3), settings (4), billing (9), availability imports (2), and administration/account lifecycle (31). The same catalog validates browser path/method pairs. There is no `/v2/*` catch-all handler and no caller-supplied upstream path.

API v2 uses shared TypeBox schemas for server validation, OpenAPI generation, and the generated browser client. Every v2 response exposes the server-generated `X-Correlation-ID` used for downstream retained-service calls. Errors are bounded RFC 9457 Problem Details with stable machine codes. Contract failures use `422`; missing preconditions use `428`; stale schedule revisions use `412` and return `currentEtag`; state conflicts use `409`. Unsafe cookie-authenticated requests require an allowed `Origin` and double-submit CSRF proof. Shift updates are partial: omitted fields retain their exact saved values, including custom role labels, while explicitly supplied role labels are trimmed without case normalization.

For revision-fenced mutations, `If-Match` rejects a genuinely stale first attempt. Once an idempotency key has committed, replaying the same operation returns that stored result even if the caller has since refreshed to a newer ETag. Response-loss recovery therefore cannot manufacture a second write or a false conflict.

Native v2 ownership:

- schedule board read model;
- schedule creation;
- atomic shift change sets and revision ledger;
- demand-window replacement;
- schedule reopening.
- current-session validation and `GET /auth/me`;
- session-bound RBAC, tenant status, session timeout, MFA, and PIN-rotation enforcement for native scheduling.
- tenant location list/create/read/update/delete with public UUIDs, bounded pagination, capacity/idempotency rules, and draft-schedule revision fencing.
- tenant people, staff access, role, invitation, password-reset, profile, and self-suspension resources with public UUIDs; invite delivery uses the durable staff-invitation outbox.
- bounded schedule, shift, and roster read models plus lunch/break policy, generation, setup, and individual replacement with public UUIDs, tenant-RLS, idempotency, credit settlement, and draft revision fencing.

Bounded compatibility ownership during the strangler migration:

- publication billing and notifications;
- solver queue submission/status;
- the frozen 89-operation API-01 application catalog while API-02 replaces each domain implementation.

The scheduling compatibility adapter accepts only hard-coded internal route shapes and translates public UUIDs to tenant-scoped internal IDs. The API-01 application compatibility owner is reachable only through the exact shared catalog, uses a fixed internal authority, bounds request time/body/response size, forwards only approved headers, replaces spoofable forwarding values with the trusted client address and canonical `APP_ORIGIN` host/protocol, permits redirects only for the two declared OIDC operations, and sanitizes errors into Problem Details. Its location and people seams apply only to declared retained domains and exact `locationId`/`locationIds` and `userId`/`userIds` fields; requests translate public UUIDs inward and retained responses translate storage IDs outward. Neither boundary exposes a wildcard route. API-02 is the required removal owner.

## Retained Application API v1

The browser has moved off these routes under API-01. They remain as internal compatibility implementations and as public non-browser ingress until API-02 and API-03 close. Caddy still exposes `/api/v1/*`, so this inventory is not a security boundary or a claim of retirement. All controller paths below are tenant/session scoped unless explicitly noted.

### Authentication

- `POST /api/v1/auth/login/resolve`
- `POST /api/v1/auth/password/verify`
- `POST /api/v1/auth/password/reset/request`
- `POST /api/v1/auth/password/reset/confirm`
- `GET /api/v1/auth/login`
- `GET /api/v1/auth/callback`
- `POST /api/v1/auth/email/send-otp`
- `POST /api/v1/auth/email/verify-otp`
- `POST /api/v1/auth/pin/verify`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/mfa/enroll`
- `GET|POST|PUT|DELETE /api/v1/auth/mfa/enrollment`
- `POST /api/v1/auth/mfa/enroll/confirm`
- `POST /api/v1/auth/mfa/verify`
- `POST /api/v1/auth/mfa/disable`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

### Locations, users, roles, and invitations

- `GET|POST /api/v1/locations`
- `GET /api/v1/locations/summary`
- `GET|PUT|DELETE /api/v1/locations/{id}`
- `GET /api/v1/users`
- `GET /api/v1/users/access/catalog`
- `GET|PUT /api/v1/users/{id}/scheduling-profile`
- `GET|DELETE /api/v1/users/{id}`
- `POST /api/v1/users/invite`
- `GET /api/v1/users/{id}/invitation`
- `POST /api/v1/users/{id}/invitation/retry`
- `POST /api/v1/users/{id}/invitation/reissue`
- `PUT /api/v1/users/{id}/role`
- `POST /api/v1/users/{id}/pin/reset`
- `PUT /api/v1/users/me/pin`
- `GET|PUT /api/v1/users/{id}/access`
- `POST /api/v1/users/roles`
- `PUT|DELETE /api/v1/users/roles/{roleId}`

### Legacy scheduling and breaks

- `GET|POST /api/v1/schedules`
- `GET|DELETE /api/v1/schedules/{id}`
- `GET|PUT /api/v1/schedules/{id}/demand-windows`
- `GET /api/v1/schedules/{id}/auto-schedule/jobs/{jobId}`
- `GET /api/v1/schedules/{id}/publish/preflight`
- `POST /api/v1/schedules/{id}/publish`
- `POST /api/v1/schedules/{id}/auto-schedule`
- `POST /api/v1/schedules/{id}/reopen`
- `GET|POST /api/v1/shifts`
- `GET /api/v1/shifts/staff-roster`
- `GET|PUT|DELETE /api/v1/shifts/{id}`
- `POST /api/v1/shifts/bulk-assign`
- `GET /api/v1/lunch-breaks`
- `GET|PUT /api/v1/lunch-breaks/policy`
- `POST /api/v1/lunch-breaks/generate`
- `POST /api/v1/lunch-breaks/setup-shifts`
- `PUT /api/v1/lunch-breaks/shift/{shiftId}`

No browser screen calls these v1 paths directly. Lunch-break and roster screens use their direct API-v2 Operations resources; the retained v1 paths remain public only until API-03 closes, not as a v2 compatibility dependency.

### Time cards and payroll

- `GET /api/v1/time-cards`
- `GET /api/v1/time-cards/active`
- `GET /api/v1/time-cards/{id}`
- `POST /api/v1/time-cards/clock-in`
- `POST /api/v1/time-cards/{id}/clock-out`
- `PATCH /api/v1/time-cards/{id}/correction`
- `GET /api/v1/payroll/export-entitlement`
- `GET /api/v1/payroll/policies`
- `GET|PUT /api/v1/payroll/policy`
- `GET|POST /api/v1/payroll/periods`
- `GET /api/v1/payroll/periods/{id}`
- `POST /api/v1/payroll/periods/{id}/adopt`
- `POST /api/v1/payroll/periods/{id}/review`
- `POST /api/v1/payroll/periods/{id}/decisions`
- `POST /api/v1/payroll/periods/{id}/lock`
- `POST /api/v1/payroll/entries/{id}/amendments`
- `POST /api/v1/payroll/amendments/{id}/decision`
- `POST /api/v1/payroll/periods/{id}/exports`
- `GET /api/v1/payroll/exports/{id}`
- `GET /api/v1/payroll/exports/{id}/download`
- `POST /api/v1/payroll/exports/{id}/reconciliation`

### Notifications, availability, settings, billing, and webhooks

- `GET /api/v1/notifications`
- `POST /api/v1/notifications/read`
- `POST /api/v1/notifications/read-all`
- `POST /api/v1/availability-imports/users/{userId}`
- `GET /api/v1/availability-imports/{id}`
- `GET /api/v1/settings`
- `PUT /api/v1/settings/general`
- `PUT /api/v1/settings/team`
- `PUT /api/v1/settings/security`
- `GET /api/v1/billing/features`
- `GET /api/v1/billing/subscription-recovery-action`
- `GET /api/v1/billing/price-options`
- `GET /api/v1/billing/credit-packs`
- `POST /api/v1/billing/credit-packs/checkout`
- `POST /api/v1/billing/subscribe`
- `POST /api/v1/billing/portal`
- `POST /api/v1/billing/change-plan`
- `POST /api/v1/billing/resume`
- `POST /api/v1/billing/webhook`
- `POST /api/v1/billing/meter-errors/webhook`
- `GET|POST /api/v1/webhooks/endpoints`
- `PUT|DELETE /api/v1/webhooks/endpoints/{id}`
- `POST /api/v1/webhooks/endpoints/{id}/rotate-secret`
- `POST /api/v1/email-delivery/provider-events`

### Platform administration

- `GET /api/v1/admin/stats`
- `GET|POST /api/v1/admin/tenants`
- `PUT|DELETE /api/v1/admin/tenants/{id}`
- `POST /api/v1/admin/tenants/{id}/suspend`
- `POST /api/v1/admin/tenants/{id}/activate`
- `POST /api/v1/admin/tenants/{id}/archive`
- `POST /api/v1/admin/tenants/{id}/restore`
- `PUT|DELETE /api/v1/admin/tenants/{id}/retention-legal-hold`
- `POST /api/v1/admin/retention/purge-expired`
- `POST /api/v1/admin/account/export`
- `GET /api/v1/admin/account/exports`
- `GET /api/v1/admin/account/exports/{jobId}`
- `GET /api/v1/admin/account/exports/{jobId}/download`
- `GET /api/v1/admin/account/status`
- `POST /api/v1/admin/account/cancel`
- `DELETE /api/v1/admin/account`
- `GET /api/v1/admin/users`
- `PUT /api/v1/admin/users/{id}`
- `POST /api/v1/admin/users/{id}/mfa/reset`
- `POST /api/v1/admin/users/{id}/lock`
- `POST /api/v1/admin/users/{id}/unlock`
- `POST /api/v1/admin/users/{id}/suspend`
- `POST /api/v1/admin/users/{id}/activate`
- `GET /api/v1/admin/audit`
- `GET /api/v1/admin/credits`
- `POST /api/v1/admin/credits/grant`
- `GET|POST /api/v1/admin/plans`
- `PUT|DELETE /api/v1/admin/plans/{codeOrId}`
- `GET /api/v1/admin/health`

### Unversioned service routes

- `GET /live`
- `GET /health`
- `GET /metrics` (private scrape path)

Caddy exposes `/health` and `/api/health`; metrics stay on the private service network.

## Other Runtime Interfaces

| Owner | Interface | Exposure |
| --- | --- | --- |
| Next.js web | `GET|POST /auth/logout` | public same-origin route; bounded logout/revocation adapter |
| Scheduling engine | `GET /health`, `GET /metrics`, optional non-production `POST /solve` | private `engine:8000` |
| Scheduling engine | `SolverService.CalculateSchedule` | private gRPC `engine:50051`; worker is the client |
| Worker | Prometheus metrics HTTP server | private `worker:3003` |
| Control plane | `GET /api/status`, `GET /api/health`, `GET /api/metrics` | loopback/private management network; status and metrics require their configured tokens |

## Migration Rule

New browser work must use `/api/v2`, add its specific TypeBox schema to `@lunchlineup/api-contract`, regenerate the client where applicable, and use an aggregate resource boundary. It may not expand the frozen API-01 compatibility catalog or construct a per-person/per-row scheduling mutation in a page component. A retained dependency is permitted only behind a named, bounded server-side compatibility owner with an API-02 removal target; wildcard and caller-selected passthrough routes are forbidden.
