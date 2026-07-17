# Runbook: Deployment Rollback

## Symptom

Production smoke tests fail after a deployment, health checks regress, or users report broken functionality tied to the latest deploy.

## Automatic Rollback

The VM217 deploy helper fails before writing `DEPLOYED_GIT_SHA` when public health, backup/PITR proof, or a required service fails. Before mutation, CI resolves and authenticates the current registry pointer and binds it to independently served API/public HTML identity. Registry publication and rollback repoint both run S3 versioning/Object Lock/active-safe lifecycle/delete-denial protection preflight. Provider-side conditional pointer/signature writes repair split pairs only from authenticated immutable material, retry unknown pre-pointer state once, accept an already-target pointer idempotently, and reject a competing pointer. CI proves the old release against candidate schema on an isolated clone, signs that evidence, and arms rollback before mutation. Centralized rollback executes from the retained root identified by `PREVIOUS_RELEASE_MANIFEST_PATH` and `PREVIOUS_RELEASE_SOURCE_SHA`, verifies post-deploy identity, then authenticates the registry pointer and accepts only the candidate SHA or already-restored previous SHA as the conditional repoint expectation; it never assumes the candidate became current.

The centralized job also requires `PRODUCTION_POST_DEPLOY_PROOF_COMMAND` and materializes it in a private temporary file as a fail-closed compatibility contract. It does not execute that arbitrary command text: the checked-in rollback transport invokes the retained VM217 entrypoint, which writes the post-deploy proof JSON, and CI independently verifies API and public-web release identity before registry reconciliation.

## Protected Emergency Rollback

Use this path only after automatic rollback fails or when a previously successful release later proves unsafe. "Manual" means dispatching the protected GitHub workflow; it never means running rollback commands from an operator laptop or directly on VM217. The VM217 host/user variables, pinned known-hosts and private-key secrets, registry credentials, and runtime-secret credentials must be available only to the protected `production` environment. `PRODUCTION_ROLLBACK_COMMAND` remains a validated compatibility declaration and is never executed.

Before launch, configure the GitHub `production` environment with all of the following external protections:

- At least two required reviewers from the production incident-owner group.
- `Prevent self-review` enabled, so the dispatcher cannot approve the rollback.
- A nonzero wait timer appropriate for the incident policy.
- A deployment branch policy restricted to `main`.
- Production variables and secrets scoped to this environment rather than repository-wide or organization-wide credentials.

GitHub environment reviewer and wait-timer settings are not created by workflow YAML. Verify them in repository settings and retain a screenshot or API export with launch evidence. Without those external settings, emergency rollback is not launch-ready.

The workflow-level concurrency group serializes every `main` push and `main` dispatch for this workflow with `cancel-in-progress: false`. Do not create another production mutation workflow with a different concurrency group.

1. Identify the exact 40-character SHA of the retained successful release to restore. Use the incident record and retained release history; do not accept a branch, tag, mutable pointer, or shortened SHA.
2. Dispatch the checked-in workflow from `main`:

   ```bash
   gh workflow run .github/workflows/ci.yml --ref main \
     -f bootstrap_release_registry=false \
     -f emergency_production_rollback=true \
     -f emergency_rollback_source_sha="$ROLLBACK_SOURCE_SHA" \
     -f emergency_rollback_confirmation="rollback-production-to:$ROLLBACK_SOURCE_SHA"
   ```

3. The dispatch policy rejects simultaneous registry bootstrap and rollback. The emergency job cannot run from another branch and enters the protected `production` environment before it can read production variables or secrets.
4. Required reviewers verify the incident, target SHA, customer impact, current backup/PITR status, and rollback window. The job starts only after reviewer approval and the configured wait timer.
5. CI resolves the exact target SHA from immutable `indexes/<sha>.json` and `releases/<sha>.json` objects and separately resolves the signed current pointer. Cosign must verify both index and bundle signatures against the trusted `ci.yml@refs/heads/main` identity and GitHub OIDC issuer. Source-SHA, object-path, and bundle-digest mismatches fail before runtime-secret rehydration.
6. CI materializes both releases into isolated runner-temp roots from the signed version-2 archive. Exact-root preflight requires every manifested byte and no extra byte, including package/lock/workspace manifests, Python requirements, Prisma schema/migrations, integration owners, rollback scripts, Compose/infrastructure inputs, and the four backup/PITR systemd units. The immutable provider copies only contract-bound bytes to its writable tmpfs, then runs two separately bounded offline `npm ci` operations and one bounded offline requirements install from root-owned image caches. Those hostile lifecycle/build hooks receive a scrubbed environment; no production runtime path/file or clone-command variable is mounted or forwarded. Clone provision, environment inspection, provider dependency preparation/execution, post-provider inspection, clone teardown, and compatibility proof finalization share the absolute pre-mutation cutoff; teardown completes before the compatibility-complete marker is exported.
7. Only then may the protected job invoke `scripts/rollback-vm217-transport.sh` with the exact retained root, runtime descriptor, launch proof, compatibility proof/signature/digest, and pinned VM217 identity. The declared 1,800-second aggregate mutation budget owns all remote staging and activation. CI checks the cutoff immediately before invocation, and the transport independently refuses its first remote mutation after that cutoff. During mutation, INT/TERM performs one bounded authenticated exact-state reconciliation before staging cleanup and preserves signal status unless the target release is proven active; activation is never blindly retried.
8. The retained VM217 entrypoint writes and verifies the post-deploy proof. CI then independently probes API health and strict canonical public HTML with both release headers equal to the target SHA. Only after both pass does it invoke the explicit `repoint-current-to:<target-sha>` registry operation and authenticated exact-SHA readback.
9. Cleanup runs on every outcome and removes both runtime env files, compatibility proof/signature files, protected URI channels, and materialized release roots. The machine-checked 6,000-second job budget is exactly 3,000 seconds pre-mutation, 1,800 seconds mutation, 770 seconds post-mutation, and 430 seconds runner reserve.

Do not run raw `docker compose pull`, `docker compose up`, or `docker compose build`. Do not run `release-bundle-registry.mjs`, `materialize-rollback-state.mjs`, `rollback-vm217-transport.sh`, or server-local source rebuilds outside this protected job. Read-only diagnostics are allowed, but production mutation outside the environment gate is an incident and invalidates rollback evidence.
Do not run raw `docker compose pull`; rollback must consume the already verified digest-pinned retained manifest through the checked-in rollback transport. Do not replace that transport with protected shell text, even when the legacy command validator accepts it.

## Migration Handling

Rollback never applies the older release schema. Normal deploys apply owner DDL only through the `migrate` service using `MIGRATION_DATABASE_URL`; the deploy helper does not rerun SQL through the restricted `api` service. Production rollback requires the exact signed compatibility proof to remain attached through transport, activation, and `verify-raw-migration-rollback.mjs`; a missing file, changed digest, detached signature, candidate mismatch, or signer mismatch blocks before rollback mutation. If the read-only compatibility preflight fails, keep the current release running and review the reported destructive diff. If a migration itself must be repaired:

Known-good rollback launch proof may be days or weeks old. Verify it with `--launch-proof-mode rollback`; this preserves checksum, source-SHA, bundle, evidence, and timestamp-order checks without applying the new-candidate freshness TTL. Candidate launch evidence still uses the normal 86,400-second limit.

```bash
docker compose run --rm migrate npx prisma migrate resolve --rolled-back MIGRATION_NAME
```

Only run destructive migration repair after confirming a current encrypted backup and approval from the incident owner.

## Post-Rollback

```bash
cat /opt/lunchlineup/DEPLOYED_GIT_SHA
release_sha="$(cat /opt/lunchlineup/DEPLOYED_GIT_SHA)"
release_root="/opt/lunchlineup/releases/$release_sha"
runtime_env="$(readlink -f /var/lib/lunchlineup/runtime-env/current)"
docker compose --project-name lunchlineup --project-directory "$release_root" --env-file "$runtime_env" -f "$release_root/docker-compose.yml" ps
curl -fsS https://lunchlineup.com/health
curl -fsS https://lunchlineup.com/api/v1/health
docker inspect --format '{{.State.Health.Status}}' $(docker compose --project-name lunchlineup --project-directory "$release_root" --env-file "$runtime_env" -f "$release_root/docker-compose.yml" ps -q worker engine webhook-replay prometheus alertmanager)
test -s /var/lib/lunchlineup/proofs/deploy-$(cat /opt/lunchlineup/DEPLOYED_GIT_SHA).json
```

Expected result: the retained rollback proof is written first, then `DEPLOYED_GIT_SHA` matches `PREVIOUS_RELEASE_SOURCE_SHA`; API health and strict canonical public HTML pass with that exact release header; worker, engine, webhook replay, Prometheus, and Alertmanager health pass; the post-deploy proof JSON exists; the authenticated registry current pointer resolves to the same rollback SHA; and no critical Prometheus alerts remain active. A failed proof must leave the prior `DEPLOYED_GIT_SHA` and backup release pointer unchanged and must not advance the registry pointer.

## Follow-Up

Record the failed SHA, rolled-back SHA, migration status, customer impact, and alert timeline in the incident record.
