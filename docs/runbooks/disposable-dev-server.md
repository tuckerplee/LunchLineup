# Disposable Dev Server

## Purpose

VM107 is disposable. If the VM is broken or intentionally removed, restore access by creating a fresh Debian VM on a healthy Proxmox1 host, assigning the same private IP shape, bootstrapping from GitHub, restoring already-available data, and validating private routes. Target restore time is 15 minutes after the VM exists and the data dump is available.

Do not use this runbook for production VM106.

## Files

- `docs/runbooks/disposable-dev-server.md`: this VM107 disposable-server restore runbook.
- `scripts/bootstrap-vm107-dev.sh`: fresh-VM bootstrap and optional Postgres restore helper.
- `scripts/verify-deploy-source.sh`: verifies clean GitHub-pushed deploy source and `DEPLOYED_GIT_SHA` alignment.
- `scripts/backup.sh`: encrypted Postgres backup helper for creating compatible `.sql.zst.gpg` dumps.
- `scripts/restore.sh`: generic Postgres restore helper; use the VM107 bootstrap script for full fresh-host recovery.

## Restore Contract

Assumptions:

- Proxmox host is healthy.
- A fresh Debian VM is reachable by SSH as root or sudo-capable user.
- The VM has or will receive `10.231.10.108/24`, gateway `10.231.10.1`, and DNS `10.231.10.20`.
- DNS on CT930 and proxy routing on CT940 still target `10.231.10.108`.
- Existing data is already available as `.sql`, `.sql.zst`, or `.sql.zst.gpg`.
- Runtime provider secrets are either already in `/opt/lunchlineup-secrets/runtime.env` or acceptable as private-dev placeholders.

Recovery objective:

- Restore HTTP access to `dev.lunchlineup.com` and `lunchlineup-dev.proxmox1.lan` within 15 minutes after VM availability and data availability.
- Leave `/opt/lunchlineup/DEPLOYED_GIT_SHA` matching the GitHub branch used for bootstrap.

## Fresh VM Steps

On the fresh VM:

```bash
curl -fsSL https://raw.githubusercontent.com/tuckerplee/LunchLineup/migration-testing-baseline/scripts/bootstrap-vm107-dev.sh -o /tmp/bootstrap-vm107-dev.sh
chmod +x /tmp/bootstrap-vm107-dev.sh
sudo BRANCH=migration-testing-baseline BACKUP_FILE=/path/to/lunchlineup.sql.zst.gpg BACKUP_ENCRYPTION_KEY='...' /tmp/bootstrap-vm107-dev.sh
```

If the data volume is intentionally empty, omit `BACKUP_FILE` and import dev data later.

## Validation

On the VM:

```bash
cd /opt/lunchlineup
cat DEPLOYED_GIT_SHA
docker compose ps
curl -fsS http://127.0.0.1/health
curl -fsS -H 'Host: dev.lunchlineup.com' http://127.0.0.1/health
```

From a private network client:

```powershell
curl.exe http://10.231.10.108/health
curl.exe -H "Host: dev.lunchlineup.com" http://10.231.10.30/health
curl.exe -H "Host: lunchlineup-dev.proxmox1.lan" http://10.231.10.30/health
```

Expected result: each health response contains `"status":"ok"`, and `DEPLOYED_GIT_SHA` matches a pushed GitHub commit.

## Failure Handling

If the VM reports QMP `prelaunch` or `io-error`, do not spend time debugging in place. Hard stop/start from Proxmox once; if networking or guest agent does not return, replace the VM and rerun this runbook.

If the bootstrap fails before health is restored, keep the VM disposable:

```bash
cd /opt/lunchlineup
docker compose logs --tail=120
docker compose ps
df -h /
```

Fix the GitHub branch or runtime env, then rerun `scripts/bootstrap-vm107-dev.sh`.
