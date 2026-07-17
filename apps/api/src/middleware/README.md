# API middleware

## Files

- `README.md`: this middleware folder guide.
- `correlation-id.middleware.spec.ts`: bounded safe correlation-ID, generated fallback, query omission, log-injection, and network-identifier privacy tests.
- `correlation-id.middleware.ts`: request correlation middleware with bounded header validation, server-generated fallback IDs, control-safe paths, and IP-free log/trace continuity.
- `csrf.ts`: double-submit CSRF middleware and CSRF cookie helper for routes that do not use `JwtAuthGuard`.
- `host-validation.middleware.spec.ts`: allowed-host middleware tests.
- `host-validation.middleware.ts`: allowed-host validation middleware for inbound HTTP requests.
- `security-headers.middleware.ts`: security response headers and browser hardening middleware.

## Notes

`JwtAuthGuard` is the primary CSRF enforcement path for cookie-authenticated state-changing API requests. `csrf.ts` honors `COOKIE_SECURE` when used by standalone middleware integrations. The private HTTP dev deployment sets `COOKIE_SECURE=false` so browsers accept CSRF cookies on `http://` routes; HTTPS production should keep secure cookies enabled. Correlation logs omit query values and network addresses, bound and strip control characters from paths, and accept client correlation/request IDs only when they match the 1-64 character safe token grammar.
