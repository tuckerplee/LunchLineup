# Runbook: Deployment Rollback

## Symptom

Production smoke tests fail after a deployment, health checks regress, or users report broken functionality tied to the latest deploy.

## Automatic Rollback

The VM217 deploy helper fails before writing `DEPLOYED_GIT_SHA` when public health, backup/PITR proof, or a required service fails. Before mutation, CI dynamically resolves the immediately previous successful SHA from `PRODUCTION_RELEASE_REGISTRY_URI`, validates its immutable bundle, proves that old release against candidate schema on an isolated clone, binds the exact candidate inputs, and completes a dedicated rollback-arm step. Only the following step may invoke the remote mutating command. Because rollback eligibility is already durable and does not depend on remote output, runner or transport loss as `docker compose up` starts still routes to centralized rollback; a failure after arming but before mutation conservatively redeploys the retained baseline. For an empty registry, the manual bootstrap first imports an independently retained secret-free bundle for the exact SHA freshly served by both production API and web endpoints, then follows the same resolve, materialize, verification, and compatibility path. The centralized rollback job executes from isolated `PREVIOUS_DEPLOYMENT_APP_DIR`; current checkout files are not rollback inputs. A candidate bundle becomes authoritative only after production smoke publishes its immutable object and advances the registry index.

## Manual Rollback

Use this path only after the automatic rollback fails or is unavailable.

Do not run raw `docker compose pull`, `docker compose up`, `docker compose build`, or server-local source rebuilds for production rollback. Roll back by redeploying the previous immutable release manifest and proving the resulting runtime.

1. Resolve the previous successful retained bundle:

   ```bash
   node scripts/release-bundle-registry.mjs resolve \
     --registry-uri "$PRODUCTION_RELEASE_REGISTRY_URI" \
     --output /tmp/lunchlineup-previous-release.json
   ```

2. Materialize the validated immutable bundle into a new isolated directory. It contains `PREVIOUS_RUNTIME_SECRET_DESCRIPTOR` with the immutable AWS Secrets Manager reference, VersionId, and SHA-256; rehydrate it only inside the protected rollback step and verify the SHA before use:

   ```bash
   node scripts/materialize-rollback-state.mjs \
     --state-file /tmp/lunchlineup-previous-release.json \
     --output-dir /tmp/lunchlineup-manual-rollback \
     --github-env /tmp/lunchlineup-rollback.env
   set -a
   . /tmp/lunchlineup-rollback.env
   set +a
   export RELEASE_MANIFEST_PATH="$PREVIOUS_RELEASE_MANIFEST_PATH"
   export RELEASE_SOURCE_SHA="$PREVIOUS_RELEASE_SOURCE_SHA"
   export LAUNCH_PROOF_ARTIFACT_SHA256="$(sha256sum .release/launch-proof.json | awk '{print $1}')"
   export LAUNCH_PROOF_MAX_AGE_SECONDS=86400
   ```

3. Verify the manifest, source SHA, and retained launch proof before mutation:

   ```bash
   node "$PREVIOUS_DEPLOYMENT_APP_DIR/scripts/verify-release-artifacts.mjs" "$RELEASE_MANIFEST_PATH" \
     --source-sha "$RELEASE_SOURCE_SHA" \
     --deployment-root "$PREVIOUS_DEPLOYMENT_APP_DIR" \
     --launch-proof-file .release/launch-proof.json \
     --launch-proof-mode rollback \
     --rollback-command-env PRODUCTION_ROLLBACK_COMMAND \
     --post-deploy-proof-command-env PRODUCTION_POST_DEPLOY_PROOF_COMMAND
   ```

4. Transfer the verified isolated application root to a separate rollback path on the server. Run the previous helper from that path, not `/opt/lunchlineup` current files. Historical migration digests must match. Additive candidate SQL requires exact classifier approval; all other SQL requires a digest-bound expand/contract record and the retained old-release compatibility proof. Rollback retains candidate schema and then runs the read-only Prisma diff before Compose mutation:

   ```bash
   cd "/opt/lunchlineup-rollback/$RELEASE_SOURCE_SHA"
   RELEASE_MANIFEST_PATH="$PWD/.release/release-manifest.json" \
   RELEASE_SOURCE_SHA="$RELEASE_SOURCE_SHA" \
   COMPOSE_SERVICE_ENV_FILE=/opt/lunchlineup-secrets/runtime.env \
   PRODUCTION_RUNTIME_ENV_SHA256="$PRODUCTION_RUNTIME_ENV_SHA256" \
   PRODUCTION_API_HEALTH_URL="$PRODUCTION_API_HEALTH_URL" \
   PRODUCTION_WEB_URL="$PRODUCTION_WEB_URL" \
   LAUNCH_PROOF_MANIFEST_URI="$LAUNCH_PROOF_MANIFEST_URI" \
   LAUNCH_PROOF_ARTIFACT_SHA256="$LAUNCH_PROOF_ARTIFACT_SHA256" \
   LAUNCH_PROOF_MAX_AGE_SECONDS="$LAUNCH_PROOF_MAX_AGE_SECONDS" \
   VM217_DEPLOY_OPERATION=rollback \
   ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM="verified-compatible-with-current-schema:$RELEASE_SOURCE_SHA" \
   "$PWD/scripts/deploy-vm217-remote.sh"
   ```

5. Do not edit application files directly on the server. Direct server edits break release-manifest and `DEPLOYED_GIT_SHA` proof.

## Migration Handling

Rollback never applies the older release schema. Normal deploys apply owner DDL only through the `migrate` service using `MIGRATION_DATABASE_URL`; the deploy helper does not rerun SQL through the restricted `api` service. If the read-only compatibility preflight fails, keep the current release running and review the reported destructive diff. If a migration itself must be repaired:

Known-good rollback launch proof may be days or weeks old. Verify it with `--launch-proof-mode rollback`; this preserves checksum, source-SHA, bundle, evidence, and timestamp-order checks without applying the new-candidate freshness TTL. Candidate launch evidence still uses the normal 86,400-second limit.

```bash
docker compose run --rm migrate npx prisma migrate resolve --rolled-back MIGRATION_NAME
```

Only run destructive migration repair after confirming a current encrypted backup and approval from the incident owner.

## Post-Rollback

```bash
cat /opt/lunchlineup/DEPLOYED_GIT_SHA
docker compose ps
curl -fsS https://lunchlineup.com/health
curl -fsS https://lunchlineup.com/api/v1/health
docker inspect --format '{{.State.Health.Status}}' $(docker compose ps -q worker engine webhook-replay prometheus alertmanager)
test -s /var/lib/lunchlineup/proofs/deploy-$(cat /opt/lunchlineup/DEPLOYED_GIT_SHA).json
```

Expected result: the retained rollback proof is written first, then `DEPLOYED_GIT_SHA` matches `PREVIOUS_RELEASE_SOURCE_SHA`; public health and worker, engine, webhook replay, Prometheus, and Alertmanager health pass, the post-deploy proof JSON exists, and no critical Prometheus alerts remain active. A failed proof must leave the prior `DEPLOYED_GIT_SHA` and backup release pointer unchanged.

## Follow-Up

Record the failed SHA, rolled-back SHA, migration status, customer impact, and alert timeline in the incident record.
