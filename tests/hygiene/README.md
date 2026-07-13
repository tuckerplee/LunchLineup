# Hygiene Tests

## Files

- `README.md`: this hygiene test folder guide.
- `dependency-audit-gate.test.mjs`: unit fixtures for the production npm audit allowlist and blocker classification.
- `production-launch-env.test.mjs`: checks the strict public launch validator enforces the production closed-beta Terms gate and rejects malformed or duplicate managed MFA keys, smoke-only domains, test provider keys, local secret paths, missing or blank `APP_ORIGIN`, unsafe public API/OIDC config, and missing retained launch-proof references.
- `repository-hygiene.test.mjs`: fast repo-level checks for tracked secrets, public backup payloads, Caddy security headers, ignore rules, CI wiring, migration test documentation, and tracked plus untracked README sibling inventories.

## Purpose

These tests catch rebuild hygiene failures before Docker builds, database migrations, or server deploys run.
