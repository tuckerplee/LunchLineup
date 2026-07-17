# API common utilities

## Files

- `README.md`: this common API utilities guide.
- `bounded-pagination.spec.ts`: tests strict UTC windows, bounded limits, opaque cursor validation, and continuation metadata.
- `bounded-pagination.ts`: shared strict UTC window, hard-limit, opaque keyset cursor, and page metadata contract for public list endpoints.
- `bootstrap-security.spec.ts`: tests for API bootstrap security policy, including auth-debug rejection, OTP HMAC configuration, MFA overlap, and dedicated availability-import and staff-invitation exact-key startup.
- `bootstrap-security.ts`: CORS, body-limit, raw-body, proxy, auth-secret, MFA key-set, dedicated payload-key isolation, and production fail-fast helpers.
- `health.service.spec.ts`: tests for API dependency health reporting, shared rate-limit script readiness, bounded RabbitMQ failures, probe coalescing/cache expiry, dependency-free liveness, dependency metrics, and degraded HTTP status.
- `health.service.ts`: coalesced and briefly cached database, Redis including the shared rate-limit script, and RabbitMQ readiness checks for `/health` plus dependency metric updates; container autoheal uses the dependency-free `/live` controller route.
- `logger.ts`: Winston logger setup.
- `location-timezone.spec.ts`: regression coverage for DST boundaries, local dates, and overnight local-day splitting.
- `location-timezone.ts`: IANA timezone validation, local-date boundary conversion, formatting, and local-day range splitting.
- `metrics.controller.spec.ts`: tests for protected metrics access.
- `metrics.controller.ts`: Prometheus metrics endpoint controller.
- `metrics.interceptor.spec.ts`: tests for global HTTP request metric recording and unmatched-path privacy/cardinality protection.
- `metrics.interceptor.ts`: global HTTP request metric interceptor with bounded route-template labels and a constant unmatched-route label.
- `metrics.service.spec.ts`: verifies notification outbox, tenant-cancellation, and deletion-billing reconciliation metrics expose only bounded outcomes, backlog, age, and freshness values with distinct names, and that the API does not export a false local solver queue gauge.
- `metrics.service.ts`: Prometheus metric registry and API-owned custom metrics, including notification outbox, tenant-cancellation, and deletion-billing outcome/backlog/age/sweep-freshness signals; solver broker telemetry is owned by the worker.
- `plan-tier-compatibility.spec.ts`: tests for legacy plan-tier compatibility.
- `production-exception.filter.spec.ts`: tests for sanitized production errors.
- `production-exception.filter.ts`: production-safe global exception filter.
- `rate-limits.guard.spec.ts`: tests for plan-aware per-principal API quotas, shared tenant ceilings, spoof-resistant authenticated trackers, and explicit auth-attempt throttling.
- `redis-throttler.storage.integration.spec.ts`: opt-in real-Redis proof for cross-instance atomic counters, TTL expiry, shared blocking, and clean post-block reset.
- `redis-throttler.storage.spec.ts`: focused contract, production failure, startup, and non-production fallback tests for shared rate-limit storage.
- `redis-throttler.storage.ts`: atomic Redis-backed Nest throttler storage with cluster-slot-safe hashed keys, bounded operations, production fail-closed behavior, startup/readiness script proof, and a local-only fallback.
- `runtime-error-diagnostic.spec.ts`: tests that operational error diagnostics expose only allowlisted classes, codes, statuses, and categories.
- `runtime-error-diagnostic.ts`: secret-free operational error classification and correlation-ID validation helpers.
- `schedulable-user.spec.ts`: tests the locked active manager/staff eligibility predicate used before value-producing scheduling and time-card writes.
- `schedulable-user.ts`: canonical tenant-scoped, unsuspended, non-deleted manager/staff predicate, transaction lock boundary, and editable-shift cleanup used when an account becomes ineligible for scheduling.
- `secure-http-client.spec.ts`: SSRF-hardening plus total DNS/socket deadline tests for outbound HTTP.
- `secure-http-client.ts`: SSRF-hardened outbound HTTP client with one bounded DNS-through-response deadline so shutdown-facing handlers can drain.
- `shutdown-deadline.spec.ts`: verifies the bounded, single-arm process shutdown watchdog.
- `shutdown-deadline.ts`: installs a SIGINT/SIGTERM watchdog that forces failed process exit when lifecycle cleanup exceeds the configured deadline.
- `sensitive-redaction.spec.ts`: tests complete query, fragment, credential, bearer, and secret-field removal.
- `sensitive-redaction.ts`: shared log redaction helpers for tokens, credentials, signatures, and secret-bearing URLs.
- `telemetry.spec.ts`: API OTLP configuration plus Node HTTP and Undici fetch trace query-redaction tests.
- `telemetry.ts`: early API OpenTelemetry bootstrap with queued OTLP trace export, query-safe Node HTTP and Undici fetch span attributes, and Node auto-instrumentation.
- `guards/`: global and shared API guards.
- `pipes/`: shared request validation pipes.

## Notes

`bootstrap-security.ts` refuses production startup when origins, secure cookies, auth secrets, payload encryption, or metrics protection are unsafe. Production requires `STAFF_INVITATION_OUTBOX_ENABLED=true`, dedicated `OTP_HMAC_SECRET`, exact 32-byte `MFA_SECRET_ENCRYPTION_KEY_CURRENT`, exact 32-byte `AVAILABILITY_IMPORT_ENCRYPTION_KEY`, and exact 32-byte `STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY`; payload keys must not resolve to reused MFA, webhook, password-reset, availability-import, or invitation key material. Blank optional MFA overlap values remain absent inputs. `main.ts` installs explicit body limits while preserving signed-webhook `rawBody`; API and webhook-replay processes force a failed exit when lifecycle cleanup exceeds `PROCESS_SHUTDOWN_DEADLINE_MS`; and `/metrics` remains token-only.
