# Hygiene Tests

## Files

- `README.md`: this hygiene test folder guide.
- `repository-hygiene.test.mjs`: fast repo-level checks for tracked secrets, public backup payloads, ignore rules, CI wiring, and migration test documentation.

## Purpose

These tests catch rebuild hygiene failures before Docker builds, database migrations, or server deploys run.
