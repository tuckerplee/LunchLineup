# PostgreSQL runtime

## Files

- `README.md`: this Postgres runtime and pgBackRest guide.
- `pg_hba.conf`: checked-in client authentication used by the Compose postgres service (`hba_file`, mounted through `/opt/lunchlineup/postgres`). Password (`scram-sha-256`) authentication only; there is no replication entry. The container-local socket is trusted, which is how pgBackRest connects.
- `pg_hba.conf.template`: generated client-authentication template.
- `postgresql.conf`: checked-in Compose Postgres runtime configuration with WAL archiving off by default.
- `postgresql.conf.template`: generated Postgres tuning template with the same archive default.
- `lunchlineup-postgres-entrypoint.sh`: wrapper entrypoint baked into the postgres image (see below).
- `compose.pgbackrest.yml`: Compose overlay that turns pgBackRest on (named volumes, key/known_hosts/passphrase mounts, dedicated egress network).
- `compose.pgbackrest-repo3.yml`: optional overlay for the offsite repo3 (GCS); added by the deploy scripts only when `PGBACKREST_REPO3_ENABLED=true`.

## Postgres PITR: pgBackRest inside the postgres container

Point-in-time recovery is pgBackRest running **inside the `postgres` container**, with its repository (`repo2`, type `sftp`) on the NAS. The image (`infrastructure/docker/Dockerfile.postgres`) is the digest-pinned `postgres:16-alpine` plus the exact Alpine package `pgbackrest=2.58.0-r0` (`ARG PGBACKREST_VERSION`; bump it with the base digest) and the wrapper entrypoint. No secret is in the image or the repository. File backups (uploads, secrets, runtime env) remain host restic, owned by estate-infra. Do not add `pg_dump` jobs, containers that upload to object storage, or other `archive_command` scripts.

### Default is OFF

Without `PGBACKREST_ENABLED=true` in the runtime env nothing changes: the wrapper entrypoint `exec`s the stock entrypoint, `archive_mode=off`, `archive_command=/bin/false`, no config is rendered, nothing contacts the NAS, and `postgres` stays on the internal `data` network only. `POSTGRES_ARCHIVE_MODE` / `POSTGRES_ARCHIVE_COMMAND` (defaults `off`, `/bin/false`) remain for a manual, non-pgBackRest hook; leave them unset when pgBackRest is enabled because the wrapper overrides them.

### Turning it on

`scripts/deploy-release.sh` and `scripts/deploy-private-pilot.sh` add `infrastructure/postgres/compose.pgbackrest.yml` automatically when `PGBACKREST_ENABLED=true` (production requires it; `scripts/check-production-env.mjs` requires the keys). With the overlay:

- `archive_mode=on` and `archive_command=pgbackrest --stanza=<stanza> archive-push %p` are forced (asynchronous archive, spool on the `pgbackrest_spool` volume, logs on `pgbackrest_log`).
- The config is rendered on every container start into the postgres-owned tmpfs `/run/pgbackrest` (`pgbackrest.conf`, a 0600 copy of the SFTP key, `known_hosts`, lock directory) from the runtime env and the three mounted host files. `PGBACKREST_CONFIG=/run/pgbackrest/pgbackrest.conf` is set on the container, so `docker compose exec`/`run` find it.
- `postgres` additionally joins the dedicated `pgbackrest-egress` network (non-internal bridge, `enable_icc=false`, same shape as `outbound-egress`; only `postgres` is attached). Restrict it in the VM or estate firewall to `PGBACKREST_SFTP_HOST:PGBACKREST_SFTP_PORT` (Compose cannot filter destinations). The SFTP host name must resolve from the VM's DNS; use the IP address as `PGBACKREST_SFTP_HOST` otherwise (and put that IP in the known_hosts file).
- **Fail closed:** the deploy script verifies every key and file on the host before touching containers, and the entrypoint refuses to start postgres if a required value or file is missing, empty, or the known_hosts file has no entry for the SFTP host. A broken setup never silently runs with archiving disabled.
- After postgres is healthy the deploy runs `pgbackrest stanza-create` (idempotent) and `pgbackrest check` (forces a WAL switch and proves `archive-push` reaches the repository).

### Runtime env keys

| Key | Required when enabled | Meaning |
| --- | --- | --- |
| `PGBACKREST_ENABLED` | yes (`true`; unset/`false` = off) | Master switch. Production requires `true`. |
| `PGBACKREST_STANZA` | yes | Stanza name, for example `lunchlineup`. |
| `PGBACKREST_SFTP_HOST` | yes | NAS SFTP host (`p0-nas01`). |
| `PGBACKREST_SFTP_PORT` | no (22) | NAS SFTP port. |
| `PGBACKREST_SFTP_USER` | yes | NAS chroot SFTP account. |
| `PGBACKREST_REPO_PATH` | yes | Absolute repository path inside the chroot (the oedev pattern uses `/repo`). |
| `PGBACKREST_SFTP_KEY_FILE` | yes | Host path of the SFTP private key (mode 0600). Mounted read-only. |
| `PGBACKREST_SFTP_KNOWN_HOSTS_FILE` | yes | Host path of an OpenSSH `known_hosts` file with the NAS host keys (`ssh-keyscan -t ed25519,ecdsa,rsa p0-nas01`). Host key checking is `strict`. |
| `PGBACKREST_CIPHER_PASS_FILE` | yes | Host path of the repository encryption passphrase (mode 0600; `[A-Za-z0-9_.@%+=,:/-]` only, for example `openssl rand -hex 32`). Losing it loses the backups: keep an independent copy. |
| `PGBACKREST_RETENTION_FULL` / `PGBACKREST_RETENTION_DIFF` | no (4 / 7) | `repo2-retention-full` / `repo2-retention-diff` (count). |

The rendered global config also sets `repo2-type=sftp`, `repo2-sftp-host-key-check-type=strict`, `repo2-sftp-host-key-hash-type=sha256`, `repo2-cipher-type=aes-256-cbc`, `compress-type=zst`, `archive-async=y`, `start-fast=y`, `process-max=2`, and for the stanza `pg1-path`, `pg1-socket-path` and `pg1-user=$POSTGRES_USER`.

### Optional offsite repository: repo3 (GCS)

An OPTIONAL second repository `repo3` (type `gcs`, Google Cloud Storage, native GCS rather than S3 mode) gives an offsite copy beside repo2 (the NAS). With both configured pgBackRest writes every WAL segment (`archive-push`) and every backup to both repositories; each repository has its own retention and its own cipher passphrase. Default is OFF: without `PGBACKREST_REPO3_ENABLED=true` nothing repo3-related is rendered, mounted or checked and the rendered config is identical to the repo2-only config.

Enable it by setting the keys below next to `PGBACKREST_ENABLED=true`. The deploy scripts then also add `infrastructure/postgres/compose.pgbackrest-repo3.yml` (Compose cannot make a bind mount conditional, so the two extra read-only binds live in this separate overlay, always after `compose.pgbackrest.yml`). The postgres image changes (the entrypoint is baked in), so rebuild and redeploy the postgres image before the first enable.

| Key | Required when repo3 is enabled | Meaning |
| --- | --- | --- |
| `PGBACKREST_REPO3_ENABLED` | `true` to enable (unset/`false` = off) | Master switch; only meaningful with `PGBACKREST_ENABLED=true`. |
| `PGBACKREST_REPO3_GCS_BUCKET` | yes | GCS bucket (`^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$`), for example `substance-proxmox-dr-pgbackrest`. |
| `PGBACKREST_REPO3_PATH` | yes | Absolute prefix inside the bucket, for example `/p1-lunchlineup-dev01`. |
| `PGBACKREST_REPO3_GCS_KEY_FILE` | yes | Host path of the GCS service-account JSON key, for example `/opt/lunchlineup-secrets/pgbackrest/gcs_dr_key.json` (root:root 0600). Mounted read-only at `/run/pgbackrest-src/gcs_key`, copied 0600 for uid 70 into the tmpfs. Must parse as JSON with `"type":"service_account"`; its content is never printed. |
| `PGBACKREST_REPO3_CIPHER_PASS_FILE` | yes | Separate passphrase file (same charset as repo2, mode 0600), for example `/opt/lunchlineup-secrets/pgbackrest/repo3_cipher_pass`. Must differ from repo2's. Escrow it in the estate DR kit: losing it loses the offsite backups. |
| `PGBACKREST_REPO3_RETENTION_FULL` / `PGBACKREST_REPO3_RETENTION_DIFF` | no (2 / 7) | `repo3-retention-full` / `repo3-retention-diff` (count). |
| `PGBACKREST_REPO3_GCS_ENDPOINT` | no (`storage.googleapis.com`) | Override host[:port], only for tests. |
| `PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX` | no (`4GiB` with repo3; not rendered without repo3 unless set) | Global `archive-push-queue-max` for the async spool. |

The credential is a per-host service account limited to its bucket/prefix, installed root-only by estate-infra; no key is in the image or this repository. Rendered extra `[global]` lines: `repo3-type=gcs`, `repo3-path`, `repo3-gcs-bucket`, `repo3-gcs-key=/run/pgbackrest/gcs_key`, `repo3-gcs-key-type=service`, `repo3-retention-full-type=count`, `repo3-retention-full`, `repo3-retention-diff`, `repo3-cipher-type=aes-256-cbc`, `repo3-cipher-pass` (plus `repo3-gcs-endpoint` only when set, and `archive-push-queue-max`).

- **Egress:** GCS uses the existing `pgbackrest-egress` network. The VM/router flow must allow HTTPS 443 from it to `storage.googleapis.com` (or the `PGBACKREST_REPO3_GCS_ENDPOINT` host if overridden).
- **Fail closed:** `check_pgbackrest` in both deploy scripts verifies the repo3 settings and both host files (exist, non-empty, not symlinks, not group/world accessible, key is a service-account JSON) before any container change; the entrypoint refuses to start postgres on any missing or invalid repo3 value or file. `pgbackrest stanza-create` and `check` run by `pgbackrest_setup` cover both repositories.
- **Outage behaviour:** `archive-push-queue-max` (default 4GiB with repo3) bounds the `pgbackrest_spool` volume. If a repository stays unreachable until the queue is full, pgBackRest drops WAL it could not push and records a gap instead of letting the disk fill; point-in-time recovery across the gap is lost until the next full backup, so alert on `pgbackrest check` and `info` and take a fresh full backup after an outage.
- **Scheduling:** `infrastructure/systemd` carries independent weekly full and daily diff timers per repository (`--repo=2`, `--repo=3`) driven by `run-pgbackrest-backup.sh` under the deploy flock; `install-pgbackrest-schedule.sh` installs and verifies them without enabling anything (see `infrastructure/systemd/README.md`).
- **Restore:** `pgbackrest restore --repo=3 ...` restores from the offsite copy; run it through the same overlays so the `repo3-*` config is rendered.

### Operations

Run as the `postgres` user (the stanza value is `PGBACKREST_STANZA`):

```
docker compose exec -T -u postgres postgres pgbackrest --stanza=lunchlineup check
docker compose exec -T -u postgres postgres pgbackrest info
# manual full backup (the deploy scripts never take one)
docker compose exec -T -u postgres postgres pgbackrest --stanza=lunchlineup --type=full backup
```

Backup schedules belong to the application: `infrastructure/systemd` carries the weekly full and daily diff timers per repository (`--repo=2`, `--repo=3`; see its README), installed and verified by `install-pgbackrest-schedule.sh` and enabled by the owner. Estate-infra only alerts on backup freshness (`pgbackrest info`) and exit status. Restores follow `docs/runbooks/postgres-pitr-recovery.md`.
