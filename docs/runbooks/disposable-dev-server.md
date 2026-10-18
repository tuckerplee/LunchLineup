# Disposable Dev Server (VM107 private pilot)

> **Operating hold:** VM107 stays stopped and under its launch hold until the owner lifts it. Nothing here starts it. `scripts/bootstrap-vm107-dev.sh` is retired (it builds from source and refuses to run). Never build images on VM107.

## Purpose

VM107 (10.231.10.108) serves the private pilot at `https://dev.lunchlineup.com`. TLS terminates at the CT940 nginx proxy (10.231.10.30), which forwards plain HTTP to Caddy on VM107 with `X-Forwarded-Proto: https` and `X-Forwarded-Host: dev.lunchlineup.com`. VM107 is disposable development only; it is not production (ProxmoxS VM4014) and never serves `lunchlineup.com`, `www`, or `beta`.

## Files

- `scripts/deploy-private-pilot.sh`: the deploy step (load verified images, backup, migrate, `up --no-build`, health).
- `scripts/export-internal-ci-release-images.sh`: runs on the VM218 builder; writes `<name>.tar.gz` + `<name>.image.json` per image.
- `infrastructure/development-admission/compose.private-proxy.yml`: overlay publishing Caddy only on `${PILOT_BIND_IP:-10.231.10.108}` (ports 80 and 9180).
- `infrastructure/caddy/Caddyfile.private-pilot`: trusts only `${CADDY_TRUSTED_PROXIES:-10.231.10.30/32}` as a proxy so `X-Forwarded-Proto https` survives.
- `scripts/apply-db-migrations.mjs`: used through the compose `migrate` service.

## Required runtime env (`/opt/lunchlineup-secrets/runtime.env`, root-only, 0600)

`APP_ORIGIN`, `NEXT_PUBLIC_APP_ORIGIN`, `NEXT_PUBLIC_APP_URL`, `ALLOWED_ORIGINS` = `https://dev.lunchlineup.com`; `PRIVATE_APP_HOST`, `DOMAIN`, `ALLOWED_HOSTS` = `dev.lunchlineup.com`; `CADDY_SITE_ADDRESSES=http://dev.lunchlineup.com`; `COOKIE_SECURE=true`; `PROXY_HTTP_BIND=10.231.10.108` (or `PILOT_BIND_IP`, see Renumbering), `PROXY_HTTP_PORT=80`; `DATA_TARGET_ENV=disposable`; `IMAGE_TAG` = the release tag the images were built with; `TRUST_PROXY` = explicit `/32` list of the Caddy address(es) on the compose network (not the default `loopback,linklocal,uniquelocal`). The deploy script refuses to run if any of these differ.

## Deploy to private pilot

Images are built on the VM218 builder only, then copied to VM107.

1. On VM218, build and export with the CI flow, ending with
   `scripts/export-internal-ci-release-images.sh --source-context ... --inventory ... --image-directory <dir>`.
2. Copy `<dir>` (all `*.tar.gz` and `*.image.json`) to VM107, e.g. `/opt/lunchlineup-release/images/`. Update the `/opt/lunchlineup` checkout to the matching commit and set `IMAGE_TAG` in the runtime env.
3. Start VM107 from Proxmox **only after** the owner lifts the hold (the pre-start hook and `/etc/lunchlineup/vm107-launch.hold` enforce it; do not bypass them).
4. On VM107: `sudo /opt/lunchlineup/scripts/deploy-private-pilot.sh /opt/lunchlineup-release/images`

The script, holding `/run/lock/lunchlineup-deploy.lock` for the whole run:

1. checks hostname `lunchlineup-dev`, the env above, and that neither hold file exists;
2. verifies each archive's size and sha256 against its metadata, `docker load`s it, checks the loaded image ID equals `localImageId`, and tags first-party images `${IMAGE_PREFIX:-lunchlineup}/<name>:$IMAGE_TAG`; refuses on any mismatch. The previously tagged image is kept as `lunchlineup-rollback/<name>:previous` and listed in `/var/lib/lunchlineup/deploy/previous-images.tsv`;
3. takes no backup (recovery is the estate pgBackRest; take a restic/pgBackRest snapshot first if the data matters);
4. starts postgres, runs the `migrate` service, then `compose up -d --no-build --pull never` with the private-proxy overlay;
5. polls `http://$PILOT_BIND_IP/health` (default `10.231.10.108`) with `Host: dev.lunchlineup.com` until `"status":"ok"` (default 300 s).

It never builds, prunes, removes volumes, or touches production routes.

## Renumbering (VM107 to 10.1.50.10, CT940 to 10.1.20.20)

The Proxmox1 network is being renumbered: VM107 `10.231.10.108` -> `10.1.50.10` (`p1-lunchlineup-dev01.int.tuckerl.ee`), CT940 nginx `10.231.10.30` -> `10.1.20.20` (`p1-proxy01.int.tuckerl.ee`), VM218 CI `10.231.10.80` -> `10.1.20.41`. The own-IP pins are runtime env keys whose defaults are the old addresses, so nothing changes until the env is edited. After the move set exactly these lines in `/opt/lunchlineup-secrets/runtime.env` (each once):

```
PILOT_BIND_IP=10.1.50.10
PROXY_HTTP_BIND=10.1.50.10
CADDY_TRUSTED_PROXIES=10.1.20.20/32
```

`PILOT_BIND_IP` must equal `PROXY_HTTP_BIND`; `deploy-private-pilot.sh` and `deploy-release.sh --target pilot` refuse otherwise and poll `http://$PILOT_BIND_IP/health`. `CADDY_TRUSTED_PROXIES` is space-separated IPv4/CIDR; during a cutover it may list both CT940 addresses. Estate owner: point the scrape target at `10.1.50.10:9180` (`docs/estate/lunchlineup-targets.yml`) and the CT940 upstream at `10.1.50.10:80`.

## Rollback

Migrations are forward-only, so restore data too if the schema changed.

```bash
cd /opt/lunchlineup
# 1. previous images back under the compose tag (names/targets in previous-images.tsv)
while IFS=$'\t' read -r name target id; do sudo docker tag "$id" "$target"; done < /var/lib/lunchlineup/deploy/previous-images.tsv
# 2. restart on those images (set IMAGE_TAG in runtime.env back if it changed)
sudo docker compose --project-name lunchlineup --env-file /opt/lunchlineup-secrets/runtime.env \
  -f docker-compose.yml -f infrastructure/development-admission/compose.private-proxy.yml up -d --no-build --pull never
# 3. only if the schema/data must go back: ask estate-infra for a pgBackRest restore (docs/runbooks/postgres-pitr-recovery.md)
```

`previous-images.tsv` is overwritten on each deploy, so only one step back is kept.

## Validation

On VM107: `curl -fsS -H 'Host: dev.lunchlineup.com' http://<PILOT_BIND_IP>/health` (10.231.10.108 today, 10.1.50.10 after the move). From a private client: `curl.exe -H "Host: dev.lunchlineup.com" http://10.231.10.30/health` and browse `https://dev.lunchlineup.com` (cookies must be `Secure`).

## Failure handling

Check `docker compose ps` and `docker compose logs --tail=120`, and `df -h /`. Do not delete the Postgres volume to repair credential drift. If the VM reports QMP `prelaunch` or `io-error`, hard stop/start from Proxmox once; if it does not recover, stop and escalate to the Proxmox1 owner.
