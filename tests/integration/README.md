# Integration Tests

This folder contains service-backed smoke tests for the rebuild CI ephemeral stack. These tests require the GitHub Actions Postgres and Redis services and are intentionally separate from the fast migration hygiene suite.

## Files

- `README.md`: this integration test folder guide.
- `ephemeral-stack.test.mjs`: checks that CI service URLs are present, Postgres and Redis accept connections, and Prisma migrations are current against the ephemeral database.

## Command

Run from the repo root after starting compatible Postgres and Redis services:

```bash
npm run test:integration
```
