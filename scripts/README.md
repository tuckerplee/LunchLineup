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
- `load-test.sh`: load test helper.
- `production-tuning.sh`: production tuning helper.
- `pull-vm217-logs.sh`: VM217 log pull helper.
- `restore.sh`: restore script for platform operations.
- `rsync-vm217.sh`: legacy VM217 rsync helper.
- `run-dast.sh`: DAST scan helper.
- `setup-vm217.sh`: legacy VM217 setup helper.
- `verify-deploy-source.ps1`: Windows deploy-source verification script.
- `verify-deploy-source.sh`: Linux deploy-source verification script.

## Deploy Rule

Run `verify-deploy-source.ps1` or `verify-deploy-source.sh` before server rollout. A server deploy must match a clean GitHub-pushed SHA and should leave or verify `DEPLOYED_GIT_SHA`.
