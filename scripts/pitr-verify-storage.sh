#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/lunchlineup}"
COMPOSE_SERVICE_ENV_FILE="${COMPOSE_SERVICE_ENV_FILE:?COMPOSE_SERVICE_ENV_FILE is required}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
COMPOSE_PROJECT_DIRECTORY="${COMPOSE_PROJECT_DIRECTORY:?COMPOSE_PROJECT_DIRECTORY is required}"
COMPOSE_FILE="${COMPOSE_FILE:?COMPOSE_FILE is required}"
IMAGE_PREFIX="${IMAGE_PREFIX:?IMAGE_PREFIX is required}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
export IMAGE_PREFIX IMAGE_TAG
[[ "$COMPOSE_PROJECT_NAME" == "lunchlineup" ]] \
  || { echo "ERROR: COMPOSE_PROJECT_NAME must remain lunchlineup." >&2; exit 1; }
[[ "$COMPOSE_PROJECT_DIRECTORY" == "$APP_DIR" ]] \
  || { echo "ERROR: COMPOSE_PROJECT_DIRECTORY must equal APP_DIR." >&2; exit 1; }
[[ "$COMPOSE_FILE" == "$APP_DIR/docker-compose.yml" && -f "$COMPOSE_FILE" && ! -L "$COMPOSE_FILE" ]] \
  || { echo "ERROR: COMPOSE_FILE must be the exact retained candidate Compose file." >&2; exit 1; }

compose_run() {
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" COMPOSE_FILE="$COMPOSE_FILE" COMPOSE_PROFILES="" \
  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    --project-directory "$COMPOSE_PROJECT_DIRECTORY" \
    --profile ops \
    --env-file "$COMPOSE_SERVICE_ENV_FILE" \
    --file "$COMPOSE_FILE" \
    "$@"
}

runtime_env_value() {
  node --input-type=module - "$COMPOSE_SERVICE_ENV_FILE" "$APP_DIR" "$1" <<'NODE'
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [envPath, appDir, key] = process.argv.slice(2);
const policyModule = await import(
  pathToFileURL(resolve(appDir, 'scripts/production-launch-policy-shared.mjs')).href
);
const collector = policyModule.createErrorCollector();
const env = policyModule.parseEnvFile(envPath, collector);
if (collector.errors.length > 0) {
  throw new Error('Runtime environment is invalid: ' + collector.errors.join('; '));
}
const value = String(env[key] ?? '').trim();
if (!value) throw new Error(key + ' is required.');
process.stdout.write(value);
NODE
}

lifecycle_audit_dir="$(runtime_env_value PITR_LIFECYCLE_AUDIT_OBJECT_STORE_SECRETS_DIR)"
lifecycle_proof_file="$(runtime_env_value PITR_LIFECYCLE_POLICY_PROOF_FILE)"
lifecycle_policy_sha256="$(runtime_env_value PITR_LIFECYCLE_POLICY_SHA256)"
lifecycle_maximum_days="$(runtime_env_value PITR_LIFECYCLE_MAX_RETENTION_DAYS)"
pitr_endpoint="$(runtime_env_value PITR_S3_ENDPOINT)"
pitr_bucket="$(runtime_env_value PITR_S3_BUCKET)"
pitr_prefix="$(runtime_env_value PITR_S3_PREFIX)"
immutable_days="$(runtime_env_value PITR_OBJECT_LOCK_RETENTION_DAYS)"
restore_dir="$(runtime_env_value PITR_RESTORE_OBJECT_STORE_SECRETS_DIR)"
authorization_simulator="$(runtime_env_value PITR_AUTHORIZATION_SIMULATOR_FILE)"
authorization_simulator_sha256="$(runtime_env_value PITR_AUTHORIZATION_SIMULATOR_SHA256)"
authorization_simulator_timeout="$(runtime_env_value PITR_AUTHORIZATION_SIMULATOR_TIMEOUT_SECONDS)"

case "$lifecycle_audit_dir" in
  /*) ;;
  *) echo "ERROR: PITR lifecycle audit credential directory must be absolute." >&2; exit 1 ;;
esac
case "$restore_dir" in
  /*) ;;
  *) echo "ERROR: PITR restore credential directory must be absolute." >&2; exit 1 ;;
esac
case "$lifecycle_proof_file" in
  /*) ;;
  *) echo "ERROR: PITR lifecycle proof file must be absolute." >&2; exit 1 ;;
esac
test -r "$lifecycle_proof_file" \
  || { echo "ERROR: PITR lifecycle proof file is not readable." >&2; exit 1; }
test -f "$authorization_simulator" -a ! -L "$authorization_simulator" -a -x "$authorization_simulator" \
  || { echo "ERROR: PITR authorization simulator must be an executable regular file and not a symlink." >&2; exit 1; }
[[ "$authorization_simulator_sha256" =~ ^[a-f0-9]{64}$ ]] \
  || { echo "ERROR: PITR authorization simulator SHA-256 is invalid." >&2; exit 1; }
[[ "$authorization_simulator_timeout" =~ ^[1-9][0-9]*$ ]] \
  && (( authorization_simulator_timeout <= 300 )) \
  || { echo "ERROR: PITR authorization simulator timeout must be from 1 through 300 seconds." >&2; exit 1; }
actual_simulator_sha256="$(sha256sum "$authorization_simulator" | awk '{print tolower($1)}')"
[[ "$actual_simulator_sha256" == "$authorization_simulator_sha256" ]] \
  || { echo "ERROR: PITR authorization simulator digest does not match the validated runtime binding." >&2; exit 1; }

readiness_tmp="$(mktemp -d "${TMPDIR:-/tmp}/lunchlineup-pitr-readiness.XXXXXX")"
live_policy="$readiness_tmp/lifecycle.json"
cleanup() {
  rm -rf "$readiness_tmp"
}
trap cleanup EXIT HUP INT TERM

run_authorization_simulation() {
  local role="$1"
  local credential_dir="$2"
  local allowed_actions="$3"
  local denied_actions="$4"
  local request_file="$readiness_tmp/$role-request.json"
  local response_file="$readiness_tmp/$role-response.json"

  test -d "$credential_dir" -a ! -L "$credential_dir" \
    || { echo "ERROR: PITR $role credential directory must exist and not be a symlink." >&2; exit 1; }
  node --input-type=module - \
    "$role" "$pitr_endpoint" "$pitr_bucket" "$pitr_prefix" \
    "$allowed_actions" "$denied_actions" >"$request_file" <<'NODE'
import { randomBytes } from 'node:crypto';

const [role, endpoint, bucket, prefix, allowedText, deniedText] = process.argv.slice(2);
const split = (value) => value.split(',').filter(Boolean);
process.stdout.write(`${JSON.stringify({
  version: 1,
  kind: 'lunchlineup-pitr-provider-authorization-request',
  requestId: randomBytes(24).toString('hex'),
  generatedAt: new Date().toISOString(),
  role,
  scope: { endpoint, bucket, prefix },
  requiredAllowedActions: split(allowedText),
  requiredDeniedActions: split(deniedText),
})}\n`);
NODE

  if ! PITR_AUTHORIZATION_CREDENTIALS_DIR="$credential_dir" \
    timeout --foreground --signal=TERM --kill-after=5s "${authorization_simulator_timeout}s" \
      "$authorization_simulator" <"$request_file" >"$response_file"
  then
    echo "ERROR: Provider authorization simulation failed or timed out for the $role identity." >&2
    exit 1
  fi
  node "$APP_DIR/scripts/pitr-verify-authorization-simulation.mjs" \
    --request-file "$request_file" \
    --response-file "$response_file" \
    --simulator-sha256 "$authorization_simulator_sha256" \
    --maximum-age-seconds 120
}

denied_mutations='s3:PutObject,s3:DeleteObject,s3:DeleteObjectVersion,s3:PutObjectRetention,s3:BypassGovernanceRetention,s3:PutLifecycleConfiguration,s3:PutBucketPolicy,s3:DeleteBucket'
run_authorization_simulation \
  restore "$restore_dir" \
  's3:ListBucket,s3:GetObject,s3:GetObjectVersion,s3:GetObjectRetention' \
  "$denied_mutations"
run_authorization_simulation \
  lifecycle-audit "$lifecycle_audit_dir" \
  's3:GetLifecycleConfiguration,s3:GetBucketVersioning,s3:GetObjectLockConfiguration' \
  "$denied_mutations"

compose_run run --rm --no-deps --pull never --entrypoint /bin/sh pitr-wal-provider \
  /opt/lunchlineup/infrastructure/postgres/pitr-verify-object-store.sh wal
compose_run run --rm --no-deps --pull never --entrypoint /bin/sh pitr-base-backup \
  /opt/lunchlineup/infrastructure/postgres/pitr-verify-object-store.sh base-backup

compose_run run --rm --no-deps --pull never \
  --entrypoint /bin/sh \
  pitr-lifecycle-audit \
  /opt/lunchlineup/infrastructure/postgres/pitr-export-lifecycle-policy.sh \
  >"$live_policy"

node "$APP_DIR/scripts/verify-pitr-lifecycle-policy.mjs" \
  --policy-file "$live_policy" \
  --proof-file "$lifecycle_proof_file" \
  --expected-sha256 "$lifecycle_policy_sha256" \
  --endpoint "$pitr_endpoint" \
  --bucket "$pitr_bucket" \
  --prefix "$pitr_prefix" \
  --immutable-days "$immutable_days" \
  --maximum-days "$lifecycle_maximum_days"

printf 'pitr_storage_readiness_ok writers=wal,base-backup delete=denied object_lock=compliance lifecycle=bounded restore=provider-simulated-read-only lifecycle_audit=provider-simulated-read-only policy_sha256=%s\n' \
  "$lifecycle_policy_sha256"
