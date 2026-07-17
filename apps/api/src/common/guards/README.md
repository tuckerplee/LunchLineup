# API common guards

## Files

- `README.md`: this common guards folder guide.
- `rate-limits.guard.ts`: NestJS throttler guard that applies plan-aware per-principal API quotas with a bounded shared tenant ceiling, session-aware auth limits, layered source-IP plus hashed-identifier pre-auth limits, normalized IP tracking, hashed refresh-credential tracking, and an injected lifecycle-owned tenant database service.

## Notes

Auth-attempt throttles are opt-in with named `@Throttle(...)` metadata. Authenticated auth-attempt routes key limits by tenant, user, and session so MFA retries do not consume the whole tenant API quota. Login resolution, password, PIN, OTP, and password-reset routes use a five-attempt bucket combining the trusted Express client IP with a normalized, hashed tenant/identifier or reset token. A separate thirty-attempt source-IP bucket per endpoint constrains enumeration. This keeps users behind one NAT on separate low-limit budgets and prevents traffic from another IP from exhausting a victim's low-limit bucket. The guard relies on `req.ip` through the configured Express trusted-proxy contract and canonicalizes IPv4, IPv4-mapped IPv6, and IPv6 forms; it does not parse forwarding headers itself.

Refresh throttling is independent from login throttling. Each endpoint receives a 100-attempt source-IP ceiling per 15 minutes and a separate five-attempt bucket keyed by a SHA-256 digest of the refresh cookie. The digest prevents the bearer credential from appearing in throttler storage or logs while keeping separate office-NAT sessions on separate credential budgets.

All buckets use the atomic Redis storage documented in the parent `common/README.md` when `REDIS_URL` is configured. Production refuses missing or unavailable shared storage at startup and denies requests if Redis fails at runtime; process-local storage is permitted only as a development/test fallback.

Paid API quotas require a canonical non-`FREE` plan snapshot with `Tenant.status = ACTIVE`, a nonblank Stripe subscription ID, and `Tenant.stripeSubscriptionCurrentPeriodEnd` strictly in the future. Missing, malformed, or expired paid-through state falls back to the free quota, and a paid cache entry expires no later than its authoritative period end.
