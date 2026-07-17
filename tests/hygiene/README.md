# Hygiene Tests

## Files

- `README.md`: this hygiene test folder guide.
- `dependency-audit-gate.test.mjs`: proves the production npm audit gate blocks every direct or transitive advisory and fails closed on malformed, incomplete, or inconsistent reports.
- `container-runtime-hygiene.test.mjs`: rejects privileged services, unscoped root users, Docker socket and host-PID drift, and unsafe or unbounded Compose tmpfs exceptions.
- `production-launch-env.test.mjs`: exercises all 33 strict public launch cases through the thin CLI and policy owners, including rendered production Compose, blank optional MFA overlap, exact Compose/PITR secret sources, distinct lifecycle-audit credentials, bounded lifecycle proof metadata, path and credential reuse, loopback Caddy health, HTTPS-only launch manifests, the paid legal and closed-beta Terms gates, provider keys, public API/OIDC config, and retained proof references.
- `privacy-data-governance.test.mjs`: prevents tenant/session retention windows, public privacy copy, paid-period cancellation semantics, export confidentiality, retained-record minimization, and stale metadata purge coverage from drifting apart.
- `repository-hygiene.test.mjs`: fast repo-level checks for tracked secrets, public backup payloads, Caddy security headers, ignore rules, CI wiring, migration test documentation, and tracked plus untracked README sibling inventories.
- `security-automation.test.mjs`: validates least-privilege workflow permissions, immutable actions, mandatory CodeQL and Semgrep SARIF uploads, fail-closed release dependencies, and Dependabot ecosystem coverage.

## Purpose

These tests catch rebuild hygiene failures before Docker builds, database migrations, or server deploys run.
