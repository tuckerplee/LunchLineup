# Load smoke (k6)

`small-business-smoke.k6.js` models a small business: 50 concurrent users,
each logging in once, then reading the schedule board (day/week) every 3-6
seconds with a health probe every fifth read. Roughly 10-17 requests/second
overall. It is read-only apart from the login.

This is separate from the candidate-bound Artillery gate (`scripts/load-test.sh`).

## Run against dev (later)

Use a dedicated, seeded load-test account on a non-production tenant. Do not
run it against production or beta. Note the per-principal API rate limit
(free plan: 60 req/min) and the pre-auth session ceiling (3000/min); with the
default think time one VU makes about 10-20 req/min, which is under the free limit.

```bash
k6 run \
  -e BASE_URL=https://dev.lunchlineup.com \
  -e LOGIN_IDENTIFIER='<load-test username>' \
  -e LOGIN_PASSWORD="$LOADTEST_PASSWORD" \
  -e TENANT_SLUG='<workspace slug>' \
  tests/load/small-business-smoke.k6.js
```

Because all VUs share one account, they share one principal quota bucket and
one tenant ceiling. For a realistic 50-user run use a plan or tenant with a
higher limit, or several accounts. If 429s dominate, that is the rate limiter
working, not a capacity result.

Optional environment: `VUS` (50), `DURATION` (steady state, 2m), `THINK_MIN_S`/`THINK_MAX_S`
(3/6), `LOGIN_PATH` (`/api/v2/auth/password/verify`), `HEALTH_PATH` (`/api/health`).

Default thresholds: error rate under 1%, login under 2s p95, board under 1.5s p95 /
3s p99, health under 300ms p95. MFA-enrolled accounts cannot complete this login;
use an account without MFA on the dev tenant.

Run locally with `docker run --rm -i grafana/k6 run - < tests/load/small-business-smoke.k6.js`
only against a local stack.

- `README.md`: this file.
