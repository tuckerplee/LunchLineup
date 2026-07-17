#!/usr/bin/env bash
trap '' TERM
cd "$ROLLBACK_DEPLOYMENT_APP_DIR"
node scripts/verify-release-artifacts.mjs "$PREVIOUS_RELEASE_MANIFEST_PATH" \
  --source-sha "$PREVIOUS_RELEASE_SOURCE_SHA" \
  --post-deploy-proof-command-env PRODUCTION_POST_DEPLOY_PROOF_COMMAND
VM217_DEPLOY_OPERATION=rollback \
  ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM="verified-compatible-with-current-schema:$PREVIOUS_RELEASE_SOURCE_SHA" \
  printf '%s\n' "$PRODUCTION_API_HEALTH_URL" "$LAUNCH_PROOF_MANIFEST_URI"
sleep 3600
