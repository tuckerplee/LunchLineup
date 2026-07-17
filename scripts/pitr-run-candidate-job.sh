#!/usr/bin/env bash
# Executes a systemd one-shot against one retained candidate release and binds its exact image.
set -euo pipefail
umask 077

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ "$#" == 1 ]] || fail "Usage: pitr-run-candidate-job.sh <lunchlineup-backup.service|lunchlineup-pitr-base-backup.service>"
unit="$1"
case "$unit" in
  lunchlineup-backup.service) compose_service=backup ;;
  lunchlineup-pitr-base-backup.service) compose_service=pitr-base-backup ;;
  *) fail "Candidate job must be lunchlineup-backup.service or lunchlineup-pitr-base-backup.service." ;;
esac

IMAGE_PREFIX="${IMAGE_PREFIX:?IMAGE_PREFIX is required}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
COMPOSE_SERVICE_ENV_FILE="${COMPOSE_SERVICE_ENV_FILE:?COMPOSE_SERVICE_ENV_FILE is required}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required}"
PRODUCTION_RUNTIME_ENV_SHA256="${PRODUCTION_RUNTIME_ENV_SHA256:?PRODUCTION_RUNTIME_ENV_SHA256 is required}"
INVOCATION_ID="${INVOCATION_ID:?systemd INVOCATION_ID is required}"
CANDIDATE_RELEASE_ROOT="${CANDIDATE_RELEASE_ROOT:-/opt/lunchlineup/releases}"

[[ "$IMAGE_TAG" =~ ^[a-f0-9]{40}$ ]] || fail "IMAGE_TAG must be the candidate 40-character source SHA."
[[ "$COMPOSE_PROJECT_NAME" == "lunchlineup" ]] || fail "COMPOSE_PROJECT_NAME must remain lunchlineup."
[[ "$PRODUCTION_RUNTIME_ENV_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail "PRODUCTION_RUNTIME_ENV_SHA256 must be lowercase SHA-256."
[[ "$INVOCATION_ID" =~ ^[A-Fa-f0-9]{32}$ ]] || fail "systemd INVOCATION_ID must be 32 hexadecimal characters."
[[ "$CANDIDATE_RELEASE_ROOT" == /* && "$CANDIDATE_RELEASE_ROOT" != *[[:space:]]* ]] \
  || fail "CANDIDATE_RELEASE_ROOT must be an absolute path without whitespace."
[[ "$COMPOSE_SERVICE_ENV_FILE" == /* && -f "$COMPOSE_SERVICE_ENV_FILE" && ! -L "$COMPOSE_SERVICE_ENV_FILE" ]] \
  || fail "COMPOSE_SERVICE_ENV_FILE must be an absolute regular file and not a symlink."

candidate_path="$CANDIDATE_RELEASE_ROOT/$IMAGE_TAG"
candidate_compose_project="$COMPOSE_PROJECT_NAME"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
candidate_from_script="$(cd "$script_dir/.." && pwd -P)"
[[ -d "$candidate_path" && ! -L "$candidate_path" ]] || fail "Candidate release path is missing or is a symlink."
[[ "$(cd "$candidate_path" && pwd -P)" == "$candidate_path" ]] || fail "Candidate release path is not canonical."
[[ "$candidate_from_script" == "$candidate_path" ]] || fail "Candidate job is not executing from the exact retained candidate release."
[[ -f "$candidate_path/docker-compose.yml" && ! -L "$candidate_path/docker-compose.yml" ]] \
  || fail "Candidate Compose file is missing or is a symlink."

runtime_sha256="$(sha256sum -- "$COMPOSE_SERVICE_ENV_FILE" | awk '{print tolower($1)}')"
[[ "$runtime_sha256" == "$PRODUCTION_RUNTIME_ENV_SHA256" ]] \
  || fail "Candidate runtime environment digest does not match the staged release binding."
runtime_compose_project="$(node --input-type=module - "$COMPOSE_SERVICE_ENV_FILE" <<'NODE'
import { readFileSync } from 'node:fs';

const values = {};
for (const rawLine of readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
  let line = rawLine.trim();
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  if (line.startsWith('export ')) line = line.slice(7).trimStart();
  const separator = line.indexOf('=');
  const key = line.slice(0, separator).trim();
  let value = line.slice(separator + 1).trim();
  if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) value = value.slice(1, -1);
  values[key] = value;
}
process.stdout.write(values.COMPOSE_PROJECT_NAME ?? '');
NODE
)"
[[ -z "$runtime_compose_project" || "$runtime_compose_project" == "$COMPOSE_PROJECT_NAME" ]] \
  || fail "Candidate runtime environment conflicts with the stable production Compose project."
export COMPOSE_PROFILES=""

config_json="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-candidate-compose.XXXXXX.json")"
immutable_config_json="$(mktemp "${TMPDIR:-/tmp}/lunchlineup-candidate-compose-immutable.XXXXXX.json")"
container_id=""
cleanup_failed=false

remove_candidate_container() {
  local target_id="$container_id"
  local remaining_ids
  [[ -n "$target_id" ]] || return 0
  if ! docker rm -f "$target_id" >/dev/null 2>&1; then
    cleanup_failed=true
  fi
  if ! remaining_ids="$(docker ps -a --no-trunc --filter "id=$target_id" --format '{{.ID}}')"; then
    cleanup_failed=true
    return 1
  fi
  if [[ -n "$remaining_ids" ]]; then
    cleanup_failed=true
    return 1
  fi
  container_id=""
}

cleanup() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  set +e
  remove_candidate_container
  rm -f -- "$config_json" "$immutable_config_json"
  if [[ "$cleanup_failed" == true ]]; then
    echo "ERROR: Candidate job container cleanup could not be proven complete." >&2
    exit 70
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

compose_config=(
  docker compose
  --project-name "$candidate_compose_project"
  --project-directory "$candidate_path"
  --profile ops
  --env-file "$COMPOSE_SERVICE_ENV_FILE"
  --file "$candidate_path/docker-compose.yml"
)
"${compose_config[@]}" config --format json >"$config_json"
image_ref="$(node --input-type=module - "$config_json" "$compose_service" <<'NODE'
import { readFileSync } from 'node:fs';

const [configPath, service] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const image = String(config?.services?.[service]?.image ?? '');
if (!image || /\s/.test(image) || image.startsWith('-')) process.exit(1);
process.stdout.write(image);
NODE
)" || fail "Could not resolve the exact candidate service image from rendered Compose."
image_digest="$(docker image inspect --format '{{.Id}}' "$image_ref")" \
  || fail "Candidate service image is not present locally: $image_ref"
[[ "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]] \
  || fail "Candidate service image did not resolve to an immutable local digest."
node --input-type=module - "$config_json" "$immutable_config_json" "$compose_service" "$image_ref" "$image_digest" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [sourcePath, outputPath, service, expectedImage, imageDigest] = process.argv.slice(2);
const config = JSON.parse(readFileSync(sourcePath, 'utf8'));
if (!config?.services?.[service] || config.services[service].image !== expectedImage) process.exit(1);
config.services[service].image = imageDigest;
writeFileSync(outputPath, JSON.stringify(config));
NODE
[[ -s "$immutable_config_json" && ! -L "$immutable_config_json" ]] \
  || fail "Could not snapshot the candidate service with its immutable image digest."

compose_run=(
  docker compose
  --project-name "$candidate_compose_project"
  --project-directory "$candidate_path"
  --profile ops
  --env-file "$COMPOSE_SERVICE_ENV_FILE"
  --file "$immutable_config_json"
)

export CANDIDATE_SYSTEMD_INVOCATION_ID="$INVOCATION_ID"
export CANDIDATE_RELEASE_PATH="$candidate_path"
export CANDIDATE_SOURCE_SHA="$IMAGE_TAG"
export CANDIDATE_IMAGE_DIGEST="$image_digest"
export CANDIDATE_COMPOSE_PROJECT="$candidate_compose_project"
export PITR_REQUIRE_CANDIDATE_BINDING=true

printf 'candidate_release_job_start service=%s invocation_id=%s candidate_path=%s source_sha=%s image_ref=%s image_digest=%s\n' \
  "$unit" "$INVOCATION_ID" "$candidate_path" "$IMAGE_TAG" "$image_ref" "$image_digest"
container_id="$("${compose_run[@]}" run --detach --no-deps --pull never "$compose_service")" \
  || fail "Could not create the candidate job container."
[[ "$container_id" =~ ^[a-f0-9]{64}$ ]] \
  || fail "Candidate job did not return one exact full container ID."
container_status="$(docker wait "$container_id")" \
  || fail "Could not wait for the exact candidate job container."
[[ "$container_status" =~ ^[0-9]+$ && "$container_status" -le 255 ]] \
  || fail "Candidate job returned an invalid container exit status."
docker logs "$container_id" \
  || fail "Could not read logs from the exact candidate job container."
[[ "$container_status" -eq 0 ]] \
  || fail "Candidate job container failed with exit status $container_status."
remove_candidate_container \
  || fail "Candidate job container removal could not be proven."
printf 'candidate_release_job_ok service=%s invocation_id=%s candidate_path=%s source_sha=%s image_ref=%s image_digest=%s\n' \
  "$unit" "$INVOCATION_ID" "$candidate_path" "$IMAGE_TAG" "$image_ref" "$image_digest"
