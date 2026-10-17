# PostgreSQL point-in-time recovery

Point-in-time recovery for LunchLineup is an **estate system**: pgBackRest with its repository on the NAS over SFTP, plus the host restic online backup for files. Both are configured and operated outside this repository by estate-infra. This repository contains no S3 or object-store PITR tooling, no `backup`/`pitr-*` Compose services and no in-container dump; do not recreate them.

## What the application provides

- A Postgres container whose WAL archiving is **off by default** and attaches to pgBackRest through two runtime env variables, `POSTGRES_ARCHIVE_MODE` and `POSTGRES_ARCHIVE_COMMAND` (defaults `off` and the fail-closed `/bin/false`). See `infrastructure/postgres/README.md` for the contract and the pieces estate-infra must supply (binary, config, spool path, route to the NAS).
- `wal_level = replica` and `archive_timeout = 60s` in `infrastructure/postgres/postgresql.conf`.
- Database and queue DSNs that target the `postgres` Compose service, so one pgBackRest stanza protects the authoritative database.

## Attaching or verifying PITR (estate-infra)

1. Estate-infra provides the pgBackRest stanza, the NAS repository and schedules, and a Compose override for the `postgres` service that supplies the binary, configuration and network path.
2. Set `POSTGRES_ARCHIVE_MODE=on` and `POSTGRES_ARCHIVE_COMMAND=pgbackrest --stanza=<stanza> archive-push %p` in the runtime env, then recreate `postgres` through the normal deploy (`scripts/deploy-release.sh`, which takes no backup of its own).
3. Estate monitoring (not this repository's alert rules) reports archive and backup freshness. Record the estate drill evidence under `LAUNCH_PROOF_DR_DRILL_URI`.

## Restoring

Restores are run by estate-infra with pgBackRest (`pgbackrest restore --type=time --target=<timestamp>` into a stopped `postgres_data`), following the estate runbook. For the application:

1. Put the stack in maintenance: restore the launch hold file, stop `web`, `api`, `api-v2`, `worker`, `webhook-replay` and `proxy`; keep `postgres` stopped for the restore.
2. Estate-infra performs the pgBackRest restore into the `postgres_data` volume and starts `postgres`.
3. Re-run migrations with `docker compose run --rm --pull never migrate` (forward-only, idempotent) and start the stack with `scripts/deploy-release.sh` or the rollback path in `deployment-rollback.md`.
4. Verify tenant data counts, login, and the queue state (`docs/runbooks/database-failover.md`), then lift the hold.

File data (uploads and secrets) is restored from the host restic repository by estate-infra.
