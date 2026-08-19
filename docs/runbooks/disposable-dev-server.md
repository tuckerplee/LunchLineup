# Disposable Dev Server

## Purpose

VM107 is disposable. If the VM is broken or intentionally removed, restore access by creating a fresh Debian VM on a healthy Proxmox1 host, assigning the same private IP shape, bootstrapping from GitHub, restoring already-available data, and validating private routes. Target restore time is 15 minutes after the VM exists and the data dump is available.

Do not use this runbook for current public production ProxmoxS VM4014. VM106 is the historical legacy PHP source identity, not the production target; VM107 remains disposable development only. VM217 is the repository's future production architecture identifier, not a current live VM.

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
- Runtime provider secrets are already in `/opt/lunchlineup-secrets/runtime.env`. Private-dev placeholders are acceptable only for private development origins; `beta.lunchlineup.com` requires a valid Resend API key and a provider-verified `EMAIL_FROM` sender.

Recovery objective:

- Restore HTTP access to `dev.lunchlineup.com` and `lunchlineup-dev.proxmox1.lan` within 15 minutes after VM availability and data availability.
- Leave `/opt/lunchlineup/DEPLOYED_GIT_SHA` matching the GitHub branch used for bootstrap.
- Leave the guest hostname set to `lunchlineup-dev` unless `VM_HOSTNAME` is intentionally overridden.
- Provision every required Compose value with distinct disposable-development secrets, validate the rendered Compose configuration, build each unique runtime image serially, start with `--no-build`, and write `DEPLOYED_GIT_SHA` only after health succeeds.
- Keep `/opt/lunchlineup-secrets` root-only while making only the files explicitly mounted as Compose secrets readable inside their authorized non-root containers.
- Reconcile the configured owner and existing application-role passwords through PostgreSQL's local socket before migrations. This preserves a reused VM107 data volume when its original initialization credentials differ from the current runtime env.

## Fresh VM Steps

On the fresh VM:

```bash
curl -fsSL https://raw.githubusercontent.com/tuckerplee/LunchLineup/migration-testing-baseline/scripts/bootstrap-vm107-dev.sh -o /tmp/bootstrap-vm107-dev.sh
chmod +x /tmp/bootstrap-vm107-dev.sh
sudo env \
  BRANCH=migration-testing-baseline \
  HOST_HEADER=beta.lunchlineup.com \
  PUBLIC_APP_ORIGIN=https://beta.lunchlineup.com \
  BACKUP_FILE=/path/to/lunchlineup.sql.zst.gpg \
  BACKUP_ENCRYPTION_KEY="$(sudo cat /run/secrets/lunchlineup-dev-backup-key)" \
  /tmp/bootstrap-vm107-dev.sh
```

If the data volume is intentionally empty, omit `BACKUP_FILE` and import dev data later.

`PUBLIC_APP_ORIGIN` is the exact browser-visible origin used by CORS, CSRF, redirects, and secure-cookie policy. The bootstrap derives `COOKIE_SECURE=true` for HTTPS. Leave it unset for the private `http://dev.lunchlineup.com` default; set it to `https://beta.lunchlineup.com` when VM107 is the beta origin behind Cloudflare.

Before bootstrapping `beta.lunchlineup.com`, securely provision a valid `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and provider-verified `EMAIL_FROM` in the root-only runtime environment. Do not rely on the disposable-development placeholder values for a browser-visible beta host; email OTP and password-reset delivery require real provider credentials.

## Validation

On the VM:

```bash
cd /opt/lunchlineup
cat DEPLOYED_GIT_SHA
hostname
docker compose ps
curl -fsS http://127.0.0.1/health
curl -fsS -H 'Host: dev.lunchlineup.com' http://127.0.0.1/health
curl -fsS -H 'Host: beta.lunchlineup.com' http://127.0.0.1/api/v2/live
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

The bootstrap does not delete an existing Postgres volume to repair credential drift. It starts only Postgres, reconciles disposable-development role passwords locally, and then reruns the normal migration and health gates. If local socket administration fails or the configured role names are invalid, stop and inspect the volume rather than removing it.
