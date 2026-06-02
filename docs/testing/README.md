# Testing And Migration Controls

This document maps the first rebuild test layer. It covers SaaS behavior, legacy parity, security hygiene, operations hygiene, and deploy discipline before the platform is pushed to a server.

## Files

- `README.md`: this testing and migration control map.

## Test Commands

Run the fast migration guardrails:

```bash
npm run test:migration
```

Run the full workspace test suite:

```bash
npm test
```

Run browser smoke tests from the web app when the stack is available:

```bash
npm --workspace @lunchlineup/web run test:e2e
```

## Required Parity Workflows

The migration is not ready for staging until these legacy workflows are covered by tests or captured parity evidence:

- login
- schedule edit/save
- print
- PDF import
- admin
- superadmin
- backup/restore

## SaaS Behavior

The earliest API and Playwright tests must prove:

- tenant scoping for every schedule, staff, store, user, admin, and settings request
- company/store users cannot read or mutate another tenant
- role enforcement is centralized through guards or policy middleware
- superadmin access is explicit and audited
- audit logging is created for admin and superadmin mutations

## Hygiene Behavior

The rebuild must keep these checks green:

- no `.env`, key, token, or secret files are tracked
- no backup payloads are stored under public web paths
- raw error traces are not returned to browsers
- logs live outside public paths
- `/health` exists before route or uptime monitoring is trusted
- CI runs migration hygiene before Docker image build or deploy stages

## Deploy-Source Verification

Before any server deploy, run one of:

```bash
scripts/verify-deploy-source.sh
```

```powershell
scripts\verify-deploy-source.ps1
```

The script must confirm:

- local Git state is clean
- the current commit exists on the upstream GitHub branch
- the target server reports the same `DEPLOYED_GIT_SHA` or the operator explicitly records the first deploy
- the deploy artifact comes from Git, not direct server edits
