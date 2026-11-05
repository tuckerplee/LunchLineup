# Production cutover and rollback: legacy PHP to LunchLineup 2.0

This is the current plan for replacing the legacy PHP/MariaDB app at
`lunchlineup.com` with LunchLineup 2.0. It supersedes the VM217, GitHub
OIDC/Sigstore and admission-window procedures in
[production-readiness](production-readiness.md),
[deployment-rollback](deployment-rollback.md) and
[production-release-trust](production-release-trust.md); keep those for history only.

**Status: prepared source and plan. Nothing here has been executed.** No server
was contacted while writing it. Every step marked **OWNER** needs the owner's
decision or credentials; every command is to be run by a human operator on the
named host, after the go/no-go in section 5.

Scope decisions already made by the owner: no release signing, attestation or
admission-window machinery. Integrity is the sha256 plus image-ID verification
built into `scripts/deploy-release.sh`.

## 1. Architecture and deploy path

```
Browser -> Cloudflare (TLS ends) -> Cloudflare Tunnel -> nginx CT940 10.231.10.30
        -> new app VM <PROD_BIND_IP>:80 (Caddy) -> web / api-v2 / worker ...
```

- Public routing is only via the Tunnel and CT940. The new VM binds Caddy to its
  private IP, never `0.0.0.0`. Caddy trusts only `10.231.10.30/32`
  by default (`infrastructure/caddy/Caddyfile.production`; override with the runtime-env key
  `CADDY_TRUSTED_PROXIES`, e.g. `10.1.20.20/32` once CT940 is renumbered to `p1-proxy01.int.tuckerl.ee`), so nginx must send
  `X-Forwarded-Proto https` and `X-Forwarded-For`.
- `www.lunchlineup.com` is redirected (301) to `https://lunchlineup.com` at nginx
  and never reaches the app; `ALLOWED_HOSTS` is the apex only.
- Deploy: `scripts/deploy-release.sh --target production <image-dir>` with
  `PROD_BIND_IP=<vm private ip>` (and `PROD_EXPECTED_HOSTNAME` if the hostname is not
  `lunchlineup-prod`). Overlay: `infrastructure/production/compose.production-proxy.yml`.
  The pilot keeps working through `--target pilot` or the unchanged
  `scripts/deploy-private-pilot.sh`.
- The script refuses unless: run as root on the expected host; no
  `/etc/lunchlineup/production-launch.hold`; origin is exactly
  `https://lunchlineup.com`; no dev/beta/staging/localhost reference in the runtime
  env; `COOKIE_SECURE=true`; explicit-CIDR `TRUST_PROXY`; `DATA_TARGET_ENV=production`
  with `NODE_ENV=production` and the migration confirmation string; a 40-hex
  `DEPLOY_RELEASE_SHA`. It holds `/run/lock/lunchlineup-deploy.lock`, verifies each
  archive sha256 and loaded image ID, refuses a production deploy that has no
  postgres volume (unless `DEPLOY_FIRST_INSTALL=yes`), runs migrations, starts
  the stack with `--no-build --pull never`, and checks `/health` plus that the served
  `X-LunchLineup-Release` equals `DEPLOY_RELEASE_SHA`. It takes no backup: the
  recovery point is the estate pgBackRest PITR (configured by estate-infra), so
  confirm a current pgBackRest backup exists before a risky deploy.
- Previous images stay on the VM as `lunchlineup-rollback/<name>:previous` and
  `lunchlineup-rollback/<name>:before-<release-id>`; nothing is pruned.
- Receipt: `/var/lib/lunchlineup/deploy/receipts/<UTC>-<tag>/receipt.json` (status
  started/ok/failed, release SHA, image IDs and archive sha256, previous image IDs,
  migration list shipped in the checkout, start/finish times).
  Copy it off the VM after every deploy.
- The very first install on an empty VM needs `DEPLOY_FIRST_INSTALL=yes` (no
  postgres volume exists yet). Never set it on a VM that holds data.

## 2. Pre-requisites checklist

| # | Item | Who |
| --- | --- | --- |
| 1 | Production app VM provisioned (size, disk, hostname, private IP); hostname set into `PROD_EXPECTED_HOSTNAME` | OWNER |
| 2 | Estate backups: pgBackRest (NAS repository over SFTP) attached to the production Postgres by estate-infra and host restic covering uploads and secrets; no app keys needed | estate-infra |
| 3 | Estate alerting: estate Prometheus scraping `docs/estate/lunchlineup-targets.yml`, rules loaded, route proven through the estate Alertmanager | estate-infra |
| 4 | Runtime env (`/opt/lunchlineup-secrets/runtime.env`, root, 0600) with production values; no dev/test secrets reused | OWNER |
| 5 | Stripe live keys, webhook secrets and live price/meter configuration; Resend production sender domain verified (SPF/DKIM/DMARC) | OWNER |
| 6 | Cloudflare access to edit the Tunnel public hostnames and DNS for `lunchlineup.com` and `www`; CT940 nginx access | OWNER |
| 7 | Decision: maintenance window date/length and customer notice wording | OWNER |
| 8 | Decision: rollback data policy after new writes (section 6.2, option A/B/C) | OWNER |
| 9 | Decision: legacy retention (how long the PHP VM and its DB stay intact after cutover; recommended at least 30 days) | OWNER |
| 10 | Release images built on the VM218 builder and exported with `scripts/export-internal-ci-release-images.sh`; archives copied to the VM | operator |
| 11 | Legacy import tooling reviewed and rehearsed: [legacy-import-exact-replay](legacy-import-exact-replay.md) (another workstream is extending it; follow that document for the importer contract, descriptors and receipts) | operator |
| 12 | Rehearsal on `dev.lunchlineup.com` completed with a copy of a recent real dump (section 3), including a timed pgBackRest restore drill run by estate-infra | operator + OWNER sign-off |
| 13 | nginx CT940 vhost for the new VM prepared but not enabled; `proxy_set_header X-Forwarded-Proto https`, `Host`, `X-Forwarded-For`; `www` to apex 301 | operator |
| 14 | Cloudflare Tunnel public-hostname edit rehearsed on a throwaway hostname; TTL/propagation known | operator |
| 15 | Legacy side: current PHP VM health confirmed by its owner; its full backup taken and restore-tested; the PHP VM left untouched | OWNER |
| 16 | The legacy hostname/IP the Tunnel currently points at is written down (the VM4014 `10.224.40.30` record in [production-qualification-bridge](production-qualification-bridge.md) must be freshly verified by the owner, not assumed) | OWNER |
| 17 | Production hold file `/etc/lunchlineup/production-launch.hold` exists until go; removing it is the owner's explicit go for deploys | OWNER |
| 18 | Support contact and on-call for the monitoring window named | OWNER |

## 3. Rehearsal on dev.lunchlineup.com

Run the whole sequence in sections 4.2 to 4.7 against the pilot (`--target pilot`)
using a private copy of a recent legacy dump, with these differences: no
Cloudflare change for `lunchlineup.com`, tunnel switch exercised against a
test hostname, and the dump handled only on approved private storage. Record
wall-clock time per step; the sum plus 50 percent is the maintenance window.
Also rehearse: a failed migration, a failed health check, an image rollback
(`--rollback`) and a pgBackRest restore into a scratch database.
Delete the dump copy afterwards per [data-retention-delete-export](data-retention-delete-export.md).

## 4. Cutover steps

Times are relative to T0 (maintenance start). Two people: operator and OWNER.

### 4.1 T-7 to T-1 days

1. Complete the checklist above; hold file still present.
2. Deploy the exact release to production in staging posture (VM up, tunnel not
   switched): remove the hold, run `deploy-release.sh --target production <dir>`
   with `DEPLOY_FIRST_INSTALL=yes`, confirm the receipt, restore the hold.
   Hit `http://<PROD_BIND_IP>/health` with `Host: lunchlineup.com` from CT940.
3. Announce the maintenance window to users (banner on the PHP app and email, OWNER).

### 4.2 T0: freeze legacy writes

1. OWNER puts the PHP app in maintenance mode (read-only or a static page) so no new
   rows are written. Record the exact time.
2. Verify no writes: row counts and `MAX(updated_at)` style markers on the main
   legacy tables are stable across two reads a minute apart.

### 4.3 Final dump (OWNER)

1. OWNER takes the final MySQL/MariaDB dump of the legacy database and the
   exporter output required by the import contract; computes and records its
   sha256; stores a second copy on the legacy side. Nothing is written to the legacy
   database.
2. Transfer the exact files to the operator's private storage; re-check sha256.

### 4.4 Import into the new database

1. Follow [legacy-import-exact-replay](legacy-import-exact-replay.md): reviewed
   descriptor (source SHA, target generation, role plan, timezone, company slugs),
   production confirmation `LEGACY_IMPORT_PRODUCTION_CONFIRM` and
   `LEGACY_SOURCE_EXPORT_SHA256`, `DATA_TARGET_ENV=production-cutover`.
2. Deploy the release if not already current (`deploy-release.sh --target production`).
3. Have estate-infra take a labelled pgBackRest backup immediately **before** the import and confirm it is listed. This is the point-in-time "empty but migrated" restore
   point used by the pre-write rollback.
4. Run the import; keep the report and receipts privately.

### 4.5 Verification (before any traffic)

Run from the VM against the private bind with the production Host header, and with
read-only SQL as the operator. Replace table names with the real ones from the
reviewed import report.

- Counts match the legacy export for companies, locations, users, staff, schedules,
  shifts, availability, balances and billing records; every difference explained.
- Zero users without a usable credential unless the report lists them as expected;
  spot-check 10 users including bcrypt `$2y$` legacy-password users.
- No duplicate tenant slugs; each company maps to exactly one tenant.
- Migration ledger lists every shipped migration (compare with `receipt.json`).
- Latest pgBackRest backup exists and is listed by the estate.
- `/health` ok, `X-LunchLineup-Release` equals the release SHA.

### 4.6 Smoke checklist (staff-visible, via a private route)

Use a temporary nginx vhost/hosts-file override to `https`-like access (or the
bind IP with a Host header and a browser extension) for the OWNER before switching.

1. Login with a legacy-password user (bcrypt) succeeds; wrong password fails.
2. Login with a new-flow account; logout; session cookie is `Secure`.
3. PIN reset flow for a staff user end to end (email delivered through Resend).
4. Schedule view for current and next week; print view renders and prints.
5. Publish a schedule on a test location; staff notification is queued/delivered.
6. Availability and time-off views load for a manager and a staff user.
7. Billing view for a paying company shows the correct plan and no Stripe errors;
   no live charge is created by the smoke test.
8. Stripe and Resend webhook endpoints return the expected status for a signed
   test event (provider test tooling, not live customers).

### 4.7 Switch

1. Enable the CT940 vhost for `lunchlineup.com` -> `http://<PROD_BIND_IP>:80`, plus
   `www` -> 301 to the apex. `nginx -t`, reload.
2. In Cloudflare, change the Tunnel public hostnames `lunchlineup.com` and `www` to
   the nginx CT940 origin that serves the new vhost (or, if the Tunnel already
   points at CT940, switch the nginx upstream; record which one is used and keep the
   old setting written down for rollback). Purge Cloudflare cache.
3. Remove the PHP maintenance page only after the new site is serving (the PHP VM
   stays read-only and unrouted).
4. External check: `curl -sI https://lunchlineup.com/` shows the release header and
   HSTS; repeat the login smoke test through the public URL.
5. Record T-switch. Remove no data from the PHP VM.

### 4.8 Monitoring window (first 72 hours; first 2 hours attended)

- Attended 2 hours: error rate, login failures, `/health`, queue depth, outbound
  email delivery, Stripe webhook success, DB connections, disk, memory, CPU.
- Hourly for 24 hours, then every 4 hours to 72 hours. Check the nightly encrypted
  pgBackRest backup completed and is verifiable.
- Support inbox watched; log every user-reported data discrepancy against the
  legacy export.
- At 72 hours without Sev-1/2 issues, OWNER signs the end of the window. The PHP
  VM stays intact for the retention period chosen in checklist item 9.

## 5. Go / no-go criteria

Go requires **all** of:

- Checklist complete; rehearsal passed and timed; restore from pgBackRest proven.
- Legacy dump sha256 recorded; import report reviewed with no unexplained row-count
  differences; all section 4.5 checks pass.
- All section 4.6 smoke items pass, including a legacy-password login, PIN reset,
  schedule print, publish and billing view.
- Pre-import pgBackRest backup present.
- Rollback owner and rollback decision point named (below), and the PHP VM healthy.
- OWNER says "go" in writing.

No-go (stay on PHP, section 6.1) on any of: failed import checks, any data
discrepancy not explained, login failures for legacy users, backup not proven
estate-side, TLS/redirect/cookie problems (`Secure` flag, redirect loops), or the window
overrunning by more than 50 percent of the rehearsed time.

## 6. Rollback plan

### 6.1 Before any new writes on the new system (preferred, lossless)

New writes include any user login that creates a session record that matters, any
schedule edit, publish, billing change or email-driven action in the new app. Until
the OWNER opens the new site to users, none exist.

1. Flip the Cloudflare Tunnel public hostnames (or the nginx upstream) back to the
   recorded original PHP origin; reload nginx; purge cache.
2. OWNER takes the PHP app out of maintenance mode. The legacy database was never
   written, so no data is lost.
3. Confirm `https://lunchlineup.com` serves the PHP app, run its own smoke test,
   keep the new VM up but unrouted for analysis.
4. Restore `/etc/lunchlineup/production-launch.hold` on the new VM.

Decision point: the OWNER commits to "no rollback without data policy" at the first
moment real users are admitted. Keep the interval between switch and the first
attended 15 minutes as the "before writes" window by running the public smoke test
yourself first.

### 6.2 After new writes (OWNER chooses one policy in advance)

- **A. Forward-fix only.** Stay on the new system, fix and redeploy (6.3). Lowest
  risk of data loss. Recommended default once users have written data.
- **B. Roll back and accept loss.** Flip the tunnel back to PHP and un-freeze it.
  All data written in the new app after T-switch is not in the PHP database and is
  lost to users unless replayed. Before flipping, take and verify a pgBackRest backup
  of the new database and export the post-cutover changes so they can be re-keyed
  manually or replayed later. Announce the loss window to users.
- **C. Roll back with manual reconciliation.** As B, but the OWNER assigns the
  exact set of post-cutover changes (schedules published, time-off decisions,
  billing events) to be re-entered into PHP by support from the exported report.
  There is no automatic reverse sync from 2.0 to the PHP schema, and dual-running
  (both systems accepting writes) is **not supported**; do not run the PHP app
  writable while the new one is routed.

Whichever is chosen, Stripe state (subscriptions, invoices) is external and must be
reconciled by the OWNER; webhooks must point at only one live system.

### 6.3 Image and config rollback for later deploys

1. Fast path (images only, no schema or data change):
   `sudo PROD_BIND_IP=<ip> scripts/deploy-release.sh --target production --rollback <receipt-id>`
   where `<receipt-id>` is the directory name of the **bad** deploy under
   `/var/lib/lunchlineup/deploy/receipts/`. It retags each image to the previous
   image ID recorded in that receipt, verifies those IDs still exist, starts the
   stack with `--no-build --pull never` and checks `/health`. It does not run
   migrations and does not restore data.
2. Then set `DEPLOY_RELEASE_SHA` in `runtime.env` back to the previous release's
   `releaseSha` (from its receipt) and recreate the proxy so the served release
   header matches; keep a dated copy of every `runtime.env` change.
3. A bad config-only change: restore the previous `runtime.env` copy and
   `docker compose ... up -d --no-build --pull never` through the same wrapper.
4. A failed deploy leaves a receipt with `status: failed`; a failure before the
   migrate step has changed nothing, since the backup and image load come first.

### 6.4 Schema is forward-only

Migrations are applied forward and are not reversed by image rollback. Rolling
images back to a release older than the applied schema is safe only if that
release is compatible with the newer schema (the project's rollback compatibility
checks, `scripts/verify-rollback-schema-compatibility.py`, are the reference).
Never roll back across a migration that dropped or rewrote data. If a bad
migration reached production the options are: roll forward with a corrective
migration (default), or restore a pgBackRest backup (estate-infra) into a new database
(loses everything written since that backup) following
[postgres-pitr-recovery](postgres-pitr-recovery.md). The
receipt's migration list shows exactly what the deploy shipped; the
estate pgBackRest backup list identifies the restore point.
