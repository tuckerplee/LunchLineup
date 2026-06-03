# Scripts

## Files

- `README.md`: this scripts folder guide.
- `backup.sh`: backup script for platform operations.
- `chaos-experiment.sh`: destructive or resilience experiment helper.
- `deploy-vm217-remote.sh`: legacy VM217 deploy helper.
- `download-assets.sh`: asset download helper.
- `dr-drill.sh`: disaster recovery drill helper.
- `final-migration.sh`: final migration helper.
- `generate-sbom.sh`: software bill of materials generation helper.
- `import-legacy-users.mjs`: imports legacy PHP `users` and `staff` export JSON into the Prisma tenant/user/RBAC schema and writes a private login-method report.
- `load-test.sh`: load test helper.
- `production-tuning.sh`: production tuning helper.
- `pull-vm217-logs.sh`: VM217 log pull helper.
- `restore.sh`: restore script for platform operations.
- `rsync-vm217.sh`: legacy VM217 rsync helper.
- `run-dast.sh`: DAST scan helper.
- `setup-vm217.sh`: legacy VM217 setup helper.
- `verify-deploy-source.ps1`: Windows deploy-source verification script.
- `verify-deploy-source.sh`: Linux deploy-source verification script.

## Legacy User Import

`import-legacy-users.mjs` reads the VM106 legacy user export JSON, creates tenants, locations, users, preserved legacy password hashes, and RBAC assignments in the Prisma/Postgres schema, and writes the login-method report outside the repo by default. Run it only against an isolated dev/staging database unless production cutover has been explicitly approved.

Example:

```bash
node scripts/import-legacy-users.mjs /tmp/legacy-users-20260603.json --report /tmp/imported-user-credentials-20260603.csv
```

## Deploy Rule

Run `verify-deploy-source.ps1` or `verify-deploy-source.sh` before server rollout. A server deploy must match a clean GitHub-pushed SHA and should leave or verify `DEPLOYED_GIT_SHA`.
