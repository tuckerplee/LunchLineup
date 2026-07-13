# API middleware

## Files

- `README.md`: this middleware folder guide.
- `correlation-id.middleware.spec.ts`: request correlation ID and redacted URL logging tests.
- `correlation-id.middleware.ts`: request correlation ID middleware for log and trace continuity.
- `csrf.ts`: double-submit CSRF middleware and CSRF cookie helper for routes that do not use `JwtAuthGuard`.
- `host-validation.middleware.spec.ts`: allowed-host middleware tests.
- `host-validation.middleware.ts`: allowed-host validation middleware for inbound HTTP requests.
- `security-headers.middleware.ts`: security response headers and browser hardening middleware.

## Notes

`JwtAuthGuard` is the primary CSRF enforcement path for cookie-authenticated state-changing API requests. `csrf.ts` honors `COOKIE_SECURE` when used by standalone middleware integrations. The private HTTP dev deployment sets `COOKIE_SECURE=false` so browsers accept CSRF cookies on `http://` routes; HTTPS production should keep secure cookies enabled. Correlation logs redact sensitive query values before writing request URLs.
