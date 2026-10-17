# Backup and restore drill

Backups are an estate system: pgBackRest for Postgres (repository on the NAS over SFTP) and host restic for files, both configured by estate-infra. The previous in-repository drill harness (`scripts/drills/`, encrypted logical dumps, MinIO/S3 object-lock simulation) was removed together with the `backup` and `pitr-*` Compose services.

## Running the drill

1. Estate-infra restores the latest pgBackRest backup (plus WAL to a chosen timestamp) into a scratch Postgres on a non-production host, and the latest restic snapshot of the uploads volume into a scratch directory.
2. Point a disposable copy of the stack at the scratch database using the disposable runbook (`disposable-dev-server.md`) and run `docker compose run --rm --pull never migrate`.
3. Compare row counts for the critical tables and exercise login; record the elapsed restore time against the recovery objectives in `service-level-objectives.md`.
4. Store the drill record where the estate keeps drill evidence and reference it from `LAUNCH_PROOF_DR_DRILL_URI` in the runtime env.

Never run a drill against the live `postgres_data` volume. Findings that need application changes (for example a migration that cannot run on restored data) are application defects and belong in this repository; everything about repositories, retention, encryption keys and schedules belongs to estate-infra.
