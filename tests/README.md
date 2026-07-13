# Migration Test Suite

This folder contains repo-level tests for the LunchLineup rebuild. These tests run without the full Docker stack and are intended to fail early when migration hygiene, SaaS tenant isolation, parity coverage, or deploy-source discipline drifts.

## Files

- `README.md`: this test folder guide.
- `hygiene/production-launch-env.test.mjs`: verifies public launch runtime env validation rejects smoke-only domains, test payment keys, insecure public URLs, unsafe public API/OIDC launch config, and local secret paths.
- `hygiene/repository-hygiene.test.mjs`: checks secret-file hygiene, public backup exposure, generated artifact ignore rules, CI wiring, and documentation coverage.
- `migration/legacy-parity-inventory.test.mjs`: verifies the legacy PHP source and TypeScript platform expose the required migration workflows and SaaS controls.
- `deploy/deploy-source.test.mjs`: verifies deploy-source guard scripts exist and enforce GitHub/upstream SHA discipline before server rollout.
- `deploy/production-compose.test.mjs`: verifies Compose isolation, public port exposure, proxy hardening, smoke CI env generation, and fail-fast example secrets.
- `integration/README.md`: explains service-backed integration smoke tests and their runtime requirements.
- `integration/ephemeral-stack.test.mjs`: checks ephemeral Postgres and Redis availability plus Prisma schema sync in CI.

## Command

Run the suite from the repo root:

```bash
npm run test:migration
```

These tests are intentionally separate from API, web, Playwright, and service-backed integration tests. They protect the rebuild contract before heavier suites start.
