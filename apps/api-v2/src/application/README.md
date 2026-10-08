# Application API v2

## Files

- `admin-credit-grant-input-http.test.ts`: Registered credit-grant HTTP input, capacity-refusal projection, opaque tenant identity and CSRF ordering regressions.

- `README.md`: this module guide.
- `routes.ts`: exact API-01 browser operation registration; `GET /auth/me` is native here, while other native API-02 modules register their own marked catalog operations and retained operations remain behind explicit compatibility ownership.
- `retention.routes.ts`: the v2-only, bearer-token retention operator ingress; it accepts no browser session and is intentionally separate from the browser operation catalog.

The route catalog is shared from `@lunchlineup/api-contract`. There is no wildcard or caller-supplied upstream path. Scheduling calendar mutations are deliberately absent because the native scheduling module owns them as revision-fenced aggregate change sets.
- `auth-retained-http.test.ts`: retained authentication transport, refusal, redirect and cookie-cleanup regressions.
- `retained-auth-owner-http.test.ts`: controlled retained authentication owner and native HTTP transport contract regressions.
