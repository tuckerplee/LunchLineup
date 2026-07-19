# LunchLineup API Surface Map

This is the source-of-truth map for the HTTP and RPC boundaries serving `beta.lunchlineup.com`. It distinguishes the new public contract from retained compatibility code so a browser-facing feature cannot quietly add another legacy endpoint.

## Request Path

```text
browser
  -> Cloudflare DNS/proxy
  -> Caddy on VM107
       /api/v2/* -> api-v2:3002 (Fastify, new public contract)
       /api/v1/* -> api:3000    (NestJS, retained application API)
       /api/health and /health -> api:3000
       everything else -> web:3000

api-v2
  -> PostgreSQL with tenant RLS for native v2 scheduling reads/writes
  -> api:3000/v1/auth/me for temporary session validation
  -> selected private v1 scheduling operations for billing, notification,
     solver-queue, and break-generation compatibility

worker -> RabbitMQ, PostgreSQL, engine:50051 gRPC, parser Unix socket
control -> private operator status/health/metrics only
```

The browser never receives a v1 database identifier from a v2 scheduling response. Users, locations, schedules, shifts, and solve jobs have stable UUID public identifiers. Strings such as `demo-shift-05-casey-v1` were legacy fixture shift resource IDs, not separate APIs per person. The broken behavior came from the old calendar issuing one mutable request per shift and colliding with schedule state; v2 replaces that fan-out with one aggregate change set.

## Public API v2

External paths include `/api`; the service receives the same path after Caddy removes that prefix.

| Method | Public path | Resource/operation | Concurrency and replay |
| --- | --- | --- | --- |
| GET | `/api/v2/live` | process liveness | none |
| GET | `/api/v2/ready` | database readiness | none |
| GET | `/api/v2/version` | service and release SHA | none |
| GET | `/api/v2/openapi.json` | generated OpenAPI 3.1 contract | five-minute public cache |
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

API v2 uses shared TypeBox schemas for server validation, OpenAPI generation, and the generated browser client. Errors are bounded RFC 9457 Problem Details with stable machine codes. Contract failures use `422`; missing preconditions use `428`; stale schedule revisions use `412` and return `currentEtag`; state conflicts use `409`. Unsafe cookie-authenticated requests require an allowed `Origin` and double-submit CSRF proof. Shift updates are partial: omitted fields retain their exact saved values, including custom role labels, while explicitly supplied role labels are trimmed without case normalization.

For revision-fenced mutations, `If-Match` rejects a genuinely stale first attempt. Once an idempotency key has committed, replaying the same operation returns that stored result even if the caller has since refreshed to a newer ETag. Response-loss recovery therefore cannot manufacture a second write or a false conflict.

Native v2 ownership:

- schedule board read model;
- schedule creation;
- atomic shift change sets and revision ledger;
- demand-window replacement;
- schedule reopening.

Bounded compatibility ownership during the strangler migration:

- current-session validation;
- publication billing and notifications;
- solver queue submission/status;
- charged break generation.

The compatibility adapter accepts only hard-coded internal route shapes, translates public UUIDs to tenant-scoped internal IDs, bounds request time and response size, sanitizes errors, and translates results back to the v2 contract. It is not a general v1 proxy.

## Retained Application API v1

These routes remain external under `/api/v1` until their owning screens move to a v2 module. All controller paths below are tenant/session scoped unless explicitly noted.

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

The beta scheduling calendar and print view no longer call these legacy schedule/shift endpoints directly. Other retained screens may still use lunch-break or roster endpoints until their own v2 slice is built.

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

New browser work must use `/api/v2`, add its schema to `@lunchlineup/api-contract`, regenerate the client, and use an aggregate resource boundary. It may not construct a per-person or per-row endpoint in a page component. A v1 dependency is permitted only behind a named, bounded server-side compatibility adapter with an owner and removal target; it is never exposed as a generic pass-through route.
