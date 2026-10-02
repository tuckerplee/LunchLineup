# Prometheus Rule Tests

## Files

- `README.md`: this promtool fixture inventory.
- `lunchlineup.test.yml`: solver single-poison DLQ/terminal-transition, delivery dead-letter, and application-data retention alert fixtures.
- `tenant-deletion-billing.test.yml`: deletion-billing successful-sweep freshness fixtures proving fresh failed-sweep telemetry cannot mask absent or stale success.
- `native-api.test.yml`: native scrape failure/missing job/instrumentation, eligible response ownership, paired burn windows, counter reset, sparse traffic, and seconds-based histogram controls. It has 24 proposed test groups, 61 alert expectations, and 22 expression expectations.

## Command

After the infrastructure owner clears the incident and admits the reviewed candidate, run all three fixtures, the rules, and the credential-file-aware Prometheus config check from the isolated candidate root with the digest-pinned image:

```bash
node scripts/verify-observability-configs.mjs --root . --tool-mode container
```

The native fixture is included in `PROMETHEUS_RULE_TEST_FILES`, shared by the host and container commands. Fixtures stay below `alerts/tests/` so the non-recursive runtime rule glob cannot load their test syntax.

The native controls and changed rules are source-only proposals until the exact pinned tool checks them. Expectation counts do not certify PromQL parsing, rule behavior, a live scrape, Alertmanager delivery, historical coverage, or application readiness. No test command here changes the incident or launch hold. The native response SLI excludes 4xx and non-application scopes; service-death and abort observation remain separate gates. Neither a successful current scrape nor counter-reset controls establish a complete 30-day SLO history or months of private testing.
