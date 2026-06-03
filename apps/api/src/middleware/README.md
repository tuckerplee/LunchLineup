# API middleware

## Files

- `README.md`: this middleware folder guide.
- `csrf.ts`: double-submit CSRF middleware and CSRF cookie helper.
- `security-headers.middleware.ts`: security response headers and browser hardening middleware.

## Notes

`csrf.ts` honors `COOKIE_SECURE`. The private HTTP dev deployment sets `COOKIE_SECURE=false` so browsers accept CSRF cookies on `http://` routes; HTTPS production should keep secure cookies enabled.
