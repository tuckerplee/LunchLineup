# Internal Beta Operations

## Scope

This is the VM107-only launch, verification, pause, and resume contract for `https://beta.lunchlineup.com`. VM106 and every production target are out of scope and must not be changed.

VM107 may remain powered off while no beta work is happening. Keep the Proxmox guest at `onboot: 0`; launching the beta is an explicit operator action. The application lifecycle scripts do not call `qm`, change guest boot policy, enable a new host service, delete Docker volumes, or remove rollback images.

## Files

- `docs/runbooks/internal-beta-operations.md`: this VM107 internal-beta lifecycle runbook.
- `scripts/bootstrap-vm107-dev.sh`: exact-candidate checkout, build, and bootstrap owner.
- `scripts/internal-beta-lifecycle.sh`: fail-closed `launch`, `verify`, and resource-saving `pause` owner.
- `scripts/internal-beta-backup-restore-proof.sh`: bounded encrypted logical snapshot and isolated temporary-database restore proof.
- `scripts/verify-resend-readiness.mjs`: candidate-bound live Resend credential/sender acceptance probe.
- `tests/deploy/internal-beta-lifecycle.test.mjs`: source, safety, proof, monitoring, and documentation contract tests.

## Release Inputs

Before VM107 is started, choose one pushed commit and a dedicated remote branch whose head is that exact commit:

```bash
candidate_sha='<40-character-lowercase-sha>'
candidate_branch='<github-branch-pointing-at-the-sha>'
```

The candidate must be committed and pushed. `bootstrap-vm107-dev.sh` fetches the branch, refuses a dirty checkout, requires the branch head to equal the candidate, and checks out that exact SHA in detached mode. The lifecycle gate independently refreshes the remote and repeats the clean-checkout and exact-head proof.

Provision these VM107 secrets before launch:

- `/opt/lunchlineup-secrets/runtime.env`, owned by root and not group- or world-readable.
- A real Resend API key, provider webhook secret, provider-verified `EMAIL_FROM`, and internal `RESEND_PREFLIGHT_RECIPIENT`; disposable values are rejected and published-schedule email must be enabled.
- A real HTTPS Alertmanager notification target in the file selected by `ALERTMANAGER_WEBHOOK_URL_FILE`; loopback and placeholder sinks are rejected.
- The backup encryption key selected by `BACKUP_ENCRYPTION_KEY_SECRET_FILE`.
- Optional complete Cloudflare Access service-token pair for a protected beta edge. Pass the pair only in the launch process environment; the lifecycle script writes a mode-`0600` temporary curl config so credentials do not enter curl arguments or proof output.

## Start VM107

On the Proxmox1 host, confirm the target and preserve the resource-saving boot policy:

```bash
qm config 107 | grep -E '^(name|onboot|memory|net0):'
test "$(qm config 107 | awk -F': ' '$1 == "onboot" { print $2 }')" = '0'
qm start 107
timeout 180 bash -c 'until test "$(qm status 107)" = "status: running"; do sleep 3; done'
```

If VM107 is already running, `qm start 107` is unnecessary. Do not change `onboot` merely to run a beta session.

## Bootstrap One Exact Candidate

On VM107, run the checked-in bootstrap from the pushed branch. Supplying `CANDIDATE_SHA` is mandatory for the browser-visible beta origin:

```bash
sudo env \
  BRANCH="$candidate_branch" \
  CANDIDATE_SHA="$candidate_sha" \
  HOST_HEADER=beta.lunchlineup.com \
  PUBLIC_APP_ORIGIN=https://beta.lunchlineup.com \
  BETA_DEMO_MFA_BYPASS_ENABLED=false \
  /opt/lunchlineup/scripts/bootstrap-vm107-dev.sh
```

For a replacement VM, fetch the bootstrap script from the same candidate branch first, following `disposable-dev-server.md`. Restoring an existing dump still requires `VM107_DESTRUCTIVE_CONFIRM=replace-and-restore-disposable-vm107` and the documented backup inputs.

## Launch Gate

After bootstrap, run the idempotent launch gate as root:

```bash
sudo env \
  BETA_CANDIDATE_SHA="$candidate_sha" \
  BETA_CANDIDATE_REF="origin/$candidate_branch" \
  BETA_BUILD_IMAGES=false \
  BETA_RUN_BACKUP_RESTORE_PROOF=true \
  bash /opt/lunchlineup/scripts/internal-beta-lifecycle.sh launch
```

Set `BETA_BUILD_IMAGES=true` only when bootstrap did not already build the exact candidate images. Launch success requires all of the following:

- Clean Git checkout at the pushed candidate and exact `IMAGE_TAG`, `DEPLOY_RELEASE_SHA`, and `MIGRATION_SOURCE_SHA` runtime binding.
- Successful candidate migration container.
- Required application, dependency, delivery, monitoring, logging, tracing, and dashboard containers running; every healthchecked container healthy and every first-party runtime image SHA-tagged.
- Candidate-bound Resend readiness probe accepted for the configured sender and internal preflight recipient without exposing either in proof output.
- Direct Caddy health and public beta health returning HTTP 200 with `X-LunchLineup-Release` equal to the candidate.
- Direct and public Next.js roots returning candidate-bound LunchLineup HTML.
- Ready password-reset and staff-invitation sweeps, ready worker queue telemetry, zero durable outbox/DLQ backlog requiring operator attention, and no beta launch-critical pending or firing Prometheus alert.
- A bounded AES-256 encrypted logical snapshot restored into a new temporary database, schema/migration/critical-table and critical-row inventories matched, and both plaintext material and the temporary database removed.

Only after every gate passes does the script atomically write `/opt/lunchlineup/DEPLOYED_GIT_SHA` and `/var/lib/lunchlineup/proofs/internal-beta-readiness.json`. The terminal success line is:

```text
internal_beta_readiness_ok action=launch sha=<candidate> proof=/var/lib/lunchlineup/proofs/internal-beta-readiness.json vm_onboot_unchanged=true
```

Any missing proof, stale backup/restore proof, placeholder provider value, service failure, wrong header, wrong SHA, alert, or outbox debt exits nonzero and prints `internal_beta_readiness_failed`. A successful Compose command by itself is not launch proof.

The Resend probe proves that the provider accepted the exact candidate's sender request; it does not prove final inbox placement. Before inviting testers, confirm that the preflight message reached the internal recipient and independently read back the signed Resend webhook registration. Trigger and resolve one bounded test alert and confirm it reaches the configured Alertmanager receiver. These live provider/receiver checks must not be inferred from the readiness JSON.

## Independent Recheck

Run the same checks again without rebuilding or recreating the stack:

```bash
sudo env \
  BETA_CANDIDATE_SHA="$candidate_sha" \
  BETA_CANDIDATE_REF="origin/$candidate_branch" \
  BETA_RUN_BACKUP_RESTORE_PROOF=false \
  bash /opt/lunchlineup/scripts/internal-beta-lifecycle.sh verify
```

With `BETA_RUN_BACKUP_RESTORE_PROOF=false`, verification accepts only a passed, candidate-bound backup/restore proof no older than `BETA_BACKUP_PROOF_MAX_AGE_SECONDS` (one hour by default). Set it to `true` to perform a new isolated drill.

Also retain these operator readbacks with the candidate:

```bash
cat /opt/lunchlineup/DEPLOYED_GIT_SHA
cat /var/lib/lunchlineup/proofs/internal-beta-readiness.json
docker compose --env-file /opt/lunchlineup-secrets/runtime.env ps
curl -fsSI https://beta.lunchlineup.com/health | grep -i '^x-lunchlineup-release:'
```

## Pause And Power Off

Pause the Compose project before powering off the guest:

```bash
sudo env \
  BETA_CANDIDATE_SHA="$candidate_sha" \
  bash /opt/lunchlineup/scripts/internal-beta-lifecycle.sh pause
```

The pause path is deliberately recovery-friendly: after verifying the VM107 hostname and checkout SHA, it stops every running container labeled with Compose project `lunchlineup`. It does not require healthy email, alert, public-edge, or runtime-env state, and it never removes containers, volumes, images, proofs, or the database. Success is:

```text
internal_beta_paused_ok sha=<candidate> data_preserved=true vm_onboot_unchanged=true
```

Then, on the Proxmox1 host:

```bash
qm shutdown 107 --timeout 60
timeout 90 bash -c 'until test "$(qm status 107)" = "status: stopped"; do sleep 3; done'
test "$(qm config 107 | awk -F': ' '$1 == "onboot" { print $2 }')" = '0'
```

A timeout means the final power state is unknown. Re-read `qm status 107` before any retry. Do not hard-stop, reboot, or change VM107 configuration without explicit approval.

## Resume

Start VM107, wait for the guest to become reachable, and rerun `internal-beta-lifecycle.sh launch` with the same candidate. Compose operations are idempotent; migrations and exact service/readiness checks are repeated. Use a new candidate only after it is pushed and the runtime image/release/migration SHA values are updated by bootstrap.

## Backup Boundary

The launch drill proves that a freshly encrypted VM107 logical snapshot can be decrypted and restored without touching the live database. The temporary snapshot is intentionally removed after proof. This drill does not replace a retained off-host backup: before external testers create irreplaceable data, configure the existing encrypted offsite backup path and retain its independent version/checksum readback according to `production-readiness.md`.
