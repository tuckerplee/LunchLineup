# API common utilities

## Files

- `README.md`: this common API utilities guide.
- `bootstrap-security.spec.ts`: tests for API bootstrap security policy, including current-only and overlap MFA key startup.
- `bootstrap-security.ts`: CORS, body-limit, raw-body, proxy, MFA key-set validation, and production fail-fast helpers.
- `health.service.spec.ts`: tests for API dependency health reporting, bounded RabbitMQ failures, dependency metrics, and degraded HTTP status.
- `health.service.ts`: bounded database, Redis, and RabbitMQ readiness checks for `/health` plus dependency metric updates.
- `logger.ts`: Winston logger setup.
- `location-timezone.spec.ts`: regression coverage for DST boundaries, local dates, and overnight local-day splitting.
- `location-timezone.ts`: IANA timezone validation, local-date boundary conversion, formatting, and local-day range splitting.
- `metrics.controller.spec.ts`: tests for protected metrics access.
- `metrics.controller.ts`: Prometheus metrics endpoint controller.
- `metrics.interceptor.spec.ts`: tests for global HTTP request metric recording.
- `metrics.interceptor.ts`: global HTTP request metric interceptor with bounded route labels.
- `metrics.service.ts`: Prometheus metric registry and custom metrics.
- `plan-tier-compatibility.spec.ts`: tests for legacy plan-tier compatibility.
- `production-exception.filter.spec.ts`: tests for sanitized production errors.
- `production-exception.filter.ts`: production-safe global exception filter.
- `rate-limits.guard.spec.ts`: tests for plan-aware API quotas and explicit auth-attempt throttling.
- `secure-http-client.spec.ts`: SSRF-hardening tests for outbound HTTP.
- `secure-http-client.ts`: SSRF-hardened outbound HTTP client.
- `sensitive-redaction.ts`: shared log redaction helpers for tokens, credentials, signatures, and secret-bearing URLs.
- `telemetry.spec.ts`: API OTLP endpoint and service metadata configuration tests.
- `telemetry.ts`: early API OpenTelemetry bootstrap with queued OTLP trace export and Node auto-instrumentation.
- `guards/`: global and shared API guards.
- `pipes/`: shared request validation pipes.

## Notes

`bootstrap-security.ts` refuses production startup when the effective reset-link app origin is not public HTTPS, browser origins, secure cookies, auth secrets, or metrics protection are unsafe. Production requires `MFA_SECRET_ENCRYPTION_KEY_CURRENT` as a managed key that decodes to exactly 32 bytes. `MFA_SECRET_ENCRYPTION_KEY_PREVIOUS` and deprecated `MFA_SECRET_ENCRYPTION_KEY` are optional rotation overlap inputs; malformed, placeholder, or duplicate overlap keys fail startup. `main.ts` installs explicit JSON and URL-encoded body limits while preserving `rawBody` for signed webhooks. The version-neutral `/metrics` endpoint is token-only for Prometheus scrapes, refreshes required-dependency checks, and exposes dependency, per-tenant retention outcome, and tenant-export job outcome metrics. `MetricsInterceptor` records bounded HTTP request metrics.
