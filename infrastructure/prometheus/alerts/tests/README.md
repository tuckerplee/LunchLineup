# Prometheus Rule Tests

## Files

- `README.md`: this promtool fixture inventory.
- `lunchlineup.test.yml`: solver single-poison DLQ/terminal-transition, delivery dead-letter, and application-data retention alert fixtures.
- `tenant-deletion-billing.test.yml`: deletion-billing successful-sweep freshness fixtures proving fresh failed-sweep telemetry cannot mask absent or stale success.

## Command

Run both fixtures, the production rules, and the credential-file-aware Prometheus config check from the repository root with the digest-pinned image:

```bash
node scripts/verify-observability-configs.mjs --root . --tool-mode container
```
