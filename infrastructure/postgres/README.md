# PostgreSQL runtime

## Files

- `README.md`: this Postgres runtime and WAL-archiving hook guide.
- `pg_hba.conf`: checked-in client authentication used by the Compose postgres service (`hba_file`, mounted through `/opt/lunchlineup/postgres`). Password (`scram-sha-256`) authentication only; there is no replication entry.
- `pg_hba.conf.template`: generated client-authentication template.
- `postgresql.conf`: checked-in Compose Postgres runtime configuration with WAL archiving off by default.
- `postgresql.conf.template`: generated Postgres tuning template with the same archive default.

## Backups and point-in-time recovery are an estate system

This application stack contains no backup, dump, WAL-upload or object-store tooling and no S3 offsite target. Recovery is provided by the estate:

- **Postgres PITR**: pgBackRest, repository on the NAS over SFTP. pgBackRest (stanza, repository, retention, schedules, restore drills) is configured outside this repository by estate-infra.
- **Files** (uploads, secrets, runtime env): host restic online backup, also owned by estate-infra.

Do not add `pg_dump` jobs, containers that upload to object storage, or `archive_command` scripts to this repository.

## Attaching pgBackRest later (archive hook)

`docker-compose.yml` starts Postgres with these two settings, both taken from the runtime env:

| Variable | Default | Meaning |
| --- | --- | --- |
| `POSTGRES_ARCHIVE_MODE` | `off` | PostgreSQL `archive_mode` (`off`, `on`, `always`). |
| `POSTGRES_ARCHIVE_COMMAND` | `/bin/false` | PostgreSQL `archive_command`. Only used when `archive_mode` is not `off`. |

With the defaults Postgres runs normally with archiving disabled. The default command is deliberately `/bin/false`: if someone sets `POSTGRES_ARCHIVE_MODE=on` without a command, archiving fails loudly and WAL is retained instead of being silently acknowledged and lost.

To attach the estate pgBackRest, estate-infra sets both values in the runtime env, for example:

```
POSTGRES_ARCHIVE_MODE=on
POSTGRES_ARCHIVE_COMMAND=pgbackrest --stanza=lunchlineup archive-push %p
```

`archive_command` runs inside the `postgres` container. The container is read-only, has no `pgbackrest` binary and sits on the internal `data` network with no route to the NAS, so estate-infra must also provide, through a compose override owned by the estate (not part of this repository): the pgBackRest binary and config, writable spool/log paths, and a path to the SFTP repository. `wal_level = replica` and `archive_timeout = 60s` are already set in `postgresql.conf`. A restore is performed with pgBackRest from the estate runbooks; the application is stopped first and `postgres_data` is replaced.
