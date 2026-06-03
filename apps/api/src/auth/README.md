# API Auth

## Files

- `README.md`: this auth folder guide.
- `auth.controller.spec.ts`: controller tests for login flow resolution, PIN login, password login, redirects, and cookie setting.
- `auth.controller.ts`: NestJS auth routes for OIDC, email OTP, username/PIN, migrated username/password, refresh, MFA, logout, and session context.
- `auth.module.ts`: NestJS auth module wiring.
- `auth.service.spec.ts`: service tests for OIDC, email OTP, PIN, migrated password, lockout, and PIN rotation behavior.
- `auth.service.ts`: auth business logic, session token creation, login method resolution, legacy password verification, PIN verification, lockout, and session context.
- `email.service.ts`: outbound OTP email delivery.
- `jwt-auth.guard.ts`: JWT request guard.
- `jwt.service.ts`: access token, refresh token, and CSRF token helper.
- `otp.service.ts`: one-time passcode generation and verification.
- `rbac-policy.spec.ts`: Casbin policy matrix tests.
- `rbac.guard.ts`: permission guard for protected routes.
- `rbac.service.ts`: permission catalog, tenant role creation, role assignment, and effective access resolution.
- `require-permission.decorator.ts`: route metadata decorator for required permissions.

## Notes

Migrated legacy users authenticate with `username` plus preserved PHP `password_hash` values. PIN login remains available for accounts without a migrated password hash.

Session cookie writers honor `COOKIE_SECURE`. The private HTTP dev deployment sets `COOKIE_SECURE=false` so browsers accept `access_token`, `refresh_token`, and `csrf_token`; HTTPS production should keep secure cookies enabled.
