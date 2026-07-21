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
- `integration/lunch-break-generation-recovery.test.mjs`: proves recoverable generation failures reclaim the unchanged intent exactly once in real PostgreSQL.
- `integration/schedule-revision-fencing.test.mjs`: proves all scheduled-shift mutation paths invalidate stale publish preflights without publish settlement side effects.

## Command

Run the suite from the repo root. The runner executes every file in sorted order with
one Node test worker, prints the active file, and terminates an entire timed-out child
process tree. Ordinary
files have a 120-second deadline. The signed backup/restore recovery suite has a
separate 600-second bounded deadline because it runs multiple serial process-tree
simulations; the VM217 transport, initial cutover, and durable-runtime suites
each have a separate 240-second bounded deadline, and retained rollback transport
has a five-minute deadline, because they run complete Git Bash process-tree and
external-recovery contracts. The transport 45-second timeout fixtures stop within
20 seconds on Windows; cutover's rollback/reconciliation fixture stops within 25
seconds. Set
`LUNCHLINEUP_MIGRATION_TEST_FILE_TIMEOUT_MS` only to a bounded value
from 10,000 through 600,000 milliseconds when a constrained runner needs one explicit
per-file budget. The complete run also has a one-hour aggregate deadline, configurable
only through `LUNCHLINEUP_MIGRATION_TEST_TOTAL_TIMEOUT_MS` from 60,000 through
7,200,000 milliseconds.

```bash
npm run test:migration
```

These tests are intentionally separate from API, web, Playwright, and service-backed integration tests. They protect the rebuild contract before heavier suites start.
