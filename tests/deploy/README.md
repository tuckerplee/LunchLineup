# Deploy Tests

## Files

- `README.md`: this deploy test folder guide.
- `deploy-source.test.mjs`: verifies deploy-source scripts exist and enforce clean Git state, upstream push proof, and `DEPLOYED_GIT_SHA` checks.

## Purpose

These tests keep server deploys tied to GitHub state and built artifacts instead of direct VM edits.
