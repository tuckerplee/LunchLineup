# PostgreSQL point-in-time recovery

Point-in-time recovery for LunchLineup is **pgBackRest running inside the `postgres` container**, with its repository (`repo2`, type `sftp`) on the NAS. Scheduling of backups and the restore drills belong to the estate (estate-infra); file backups are the host restic online backup. This repository contains no S3 or object-store PITR tooling, no `backup`/`pitr-*` Compose services and no in-container dump; do not recreate them.

## What the application provides

- A pinned `pgbackrest` package in the postgres image and a wrapper entrypoint that is a no-op unless `PGBACKREST_ENABLED=true` (default OFF: `archive_mode=off`, no pgBackRest activity, no network path to the NAS).
- `infrastructure/postgres/compose.pgbackrest.yml`, added by the deploy scripts when enabled: `archive_mode=on` with `archive_command=pgbackrest --stanza=<stanza> archive-push %p`, spool/log volumes, mounted SFTP key, `known_hosts` and passphrase files, and the dedicated `pgbackrest-egress` network used by `postgres` only. Contract and env keys: `infrastructure/postgres/README.md`.
- Deploy steps (`scripts/deploy-release.sh`, `scripts/deploy-private-pilot.sh`) that fail closed on missing files, then run `pgbackrest stanza-create` (idempotent) and `pgbackrest check` once postgres is healthy.
- `wal_level = replica` and `archive_timeout = 60s` in `infrastructure/postgres/postgresql.conf`.
- Database and queue DSNs that target the `postgres` Compose service, so one stanza protects the authoritative database.

## Enabling and verifying PITR

1. The estate owner provides the NAS chroot user, its private key file, the NAS host keys (`known_hosts`) and a cipher passphrase file on the VM (key list in `infrastructure/postgres/README.md`). Set the `PGBACKREST_*` keys in the runtime env (`infrastructure/production/runtime.env.example`, section 9). Allow `postgres` egress to the NAS SFTP port only (VM/estate firewall, network `pgbackrest-egress`).
2. Deploy with `scripts/deploy-release.sh` (or the pilot script). It stops before changing containers if a key or file is missing, recreates `postgres` with the overlay, then runs `stanza-create` and `check`.
3. Take the first full backup and confirm it:

   ```
   docker compose exec -T -u postgres postgres pgbackrest --stanza=lunchlineup --type=full backup
   docker compose exec -T -u postgres postgres pgbackrest info
   ```

   `status: ok`, the new full backup and a current `wal archive min/max` prove archiving. `select archived_count, failed_count, last_archived_wal from pg_stat_archiver;` should show `failed_count` not increasing.
4. The application schedules `pgbackrest --stanza=lunchlineup --repo=N --type=full|diff backup` (`infrastructure/systemd` timers, `docker exec -u postgres`); estate-infra monitors freshness (see `docs/estate/README.md`). Record the estate drill evidence under `LAUNCH_PROOF_DR_DRILL_URI`.

## Restoring

The application is stopped, `postgres_data` is replaced, then postgres is started again. The command below was exercised against a throwaway SFTP repository (full backup plus archived WAL, restore into an empty volume with a `--type=time` target, promote, data after the target absent).

1. Put the stack in maintenance: restore the launch hold file and stop `web`, `api`, `api-v2`, `worker`, `webhook-replay` and `proxy`. Stop `postgres` (`docker compose stop postgres`).
2. Restore into the data volume. Use `--type=immediate` (end of the backup), `--type=time --target='<UTC timestamp>'` (PITR) or omit `--type` for the latest archived WAL. The pgBackRest overlay must be in the compose file list (the deploy scripts add it; use the same `-f` list manually). `run` renders the config through the wrapper entrypoint and runs `pgbackrest` as the `postgres` user:

   ```
   # same -f files and --env-file the deploy uses, plus the overlay
   docker compose -f docker-compose.yml -f <proxy overlay> -f infrastructure/postgres/compose.pgbackrest.yml \
     --env-file <runtime.env> run --rm --no-deps -T postgres \
     pgbackrest --stanza=lunchlineup --delta --type=time --target='2026-10-17 02:09:44+00' --target-action=promote restore
   ```

   `--delta` replaces a damaged but existing `postgres_data` in place; on an empty or freshly created volume pgBackRest ignores it with a harmless warning. Do not delete `postgres_data` by hand: restore over it with `--delta` (or restore into a new volume and repoint) so the previous data stays recoverable until the restored data is verified.
3. Start `postgres` (`docker compose ... up -d --no-build --pull never postgres`). With `--target-action=promote` it recovers to the target and opens read-write on a new timeline. Confirm `select pg_is_in_recovery();` is `f`, run `pgbackrest check` and take a fresh full backup so the new timeline has a base.
4. Re-run migrations with `docker compose run --rm --pull never migrate` (forward-only, idempotent) and start the stack with `scripts/deploy-release.sh` or the rollback path in `deployment-rollback.md`.
5. Verify tenant data counts, login, and the queue state (`docs/runbooks/database-failover.md`), then lift the hold.

File data (uploads and secrets) is restored from the host restic repository by estate-infra.
