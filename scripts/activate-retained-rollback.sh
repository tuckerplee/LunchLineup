#!/usr/bin/env bash
set -euo pipefail
umask 077

SERVICE_GROUP_NAME="${LUNCHLINEUP_SERVICE_GROUP:-lunchlineup}"
SERVICE_GROUP_GID=""
SERVICE_USER_NAME="lunchlineup"

fail() {
  echo "$1" >&2
  exit 1
}

sha256_file() {
  local path="$1"
  local digest
  digest="$(sha256sum -- "$path" | awk '{print $1}')"
  [[ "$digest" =~ ^[a-fA-F0-9]{64}$ ]] || fail "Could not hash a retained rollback input."
  printf '%s' "${digest,,}"
}

require_sha() {
  local path="$1"
  local expected="$2"
  local label="$3"
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || fail "$label is missing from remote staging."
  [[ "$(sha256_file "$path")" == "$expected" ]] || fail "$label changed in rollback transport."
}

decode_required() {
  local encoded="$1"
  local label="$2"
  local value
  value="$(printf '%s' "$encoded" | base64 --decode)" || fail "$label is not valid base64."
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
    || fail "$label must decode to a non-empty single-line value."
  printf '%s' "$value"
}

require_normalized_absolute_path() {
  local path="$1"
  local label="$2"
  [[ "$path" == /* && "$path" != *"//"* && "$path" != *"/../"* && "$path" != */.. \
    && "$path" != *"/./"* && "$path" != */. ]] \
    || fail "$label must be a normalized absolute path."
}

require_safe_relative_path() {
  local path="$1"
  local label="$2"
  [[ "$path" =~ ^[A-Za-z0-9._/-]+$ && "$path" != /* && "$path" != *"//"* \
    && "$path" != *"/../"* && "$path" != ../* && "$path" != */.. \
    && "$path" != *"/./"* && "$path" != ./* && "$path" != */. ]] \
    || fail "$label must be a normalized repository-relative path."
}

resolve_service_group() {
  local record
  local resolved_name
  local password
  local resolved_gid
  local members
  local extra
  local user_record
  local resolved_user
  local user_password
  local resolved_uid
  local primary_gid
  local gecos
  local home
  local shell
  local user_extra

  [[ "$SERVICE_GROUP_NAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] \
    || fail "LUNCHLINEUP_SERVICE_GROUP must be a bounded local group name."
  record="$(getent group "$SERVICE_GROUP_NAME")" \
    || fail "LunchLineup service group '$SERVICE_GROUP_NAME' does not exist."
  [[ -n "$record" && "$record" != *$'\n'* ]] \
    || fail "LunchLineup service group resolution was ambiguous."
  IFS=':' read -r resolved_name password resolved_gid members extra <<< "$record"
  [[ "$resolved_name" == "$SERVICE_GROUP_NAME" && "$resolved_gid" =~ ^[0-9]+$ \
    && "$resolved_gid" != "0" && -z "$extra" ]] \
    || fail "LunchLineup service group must resolve exactly to a non-root numeric GID."
  user_record="$(getent passwd "$SERVICE_USER_NAME")" \
    || fail "LunchLineup service account '$SERVICE_USER_NAME' does not exist."
  [[ -n "$user_record" && "$user_record" != *$'\n'* ]] \
    || fail "LunchLineup service account resolution was ambiguous."
  IFS=':' read -r resolved_user user_password resolved_uid primary_gid gecos home shell user_extra <<< "$user_record"
  [[ "$resolved_user" == "$SERVICE_USER_NAME" && "$resolved_uid" =~ ^[0-9]+$ \
    && "$resolved_uid" != "0" && "$primary_gid" == "$resolved_gid" && -z "$user_extra" ]] \
    || fail "LunchLineup service group must be the non-root service account's primary group."
  SERVICE_GROUP_GID="$resolved_gid"
}

normalize_managed_directory() {
  local path="$1"
  local label="$2"
  local metadata
  local owner_uid
  local owner_gid
  local mode

  [[ -d "$path" && ! -L "$path" ]] || fail "$label must be a non-symlink directory."
  metadata="$(stat -c '%u:%g:%a' -- "$path" 2>/dev/null)" \
    || fail "Could not inspect $label ownership and permissions."
  IFS=':' read -r owner_uid owner_gid mode <<< "$metadata"
  [[ "$owner_uid" == "0" && "$mode" =~ ^[0-7]{3,4}$ ]] \
    || fail "$label must be root-owned with a valid mode."
  (( (8#$mode & 0022) == 0 )) || fail "$label must not be group- or world-writable."
  chown "root:$SERVICE_GROUP_GID" -- "$path"
  chmod 750 -- "$path"
  [[ "$(stat -c '%u:%g:%a' -- "$path")" == "0:$SERVICE_GROUP_GID:750" ]] \
    || fail "$label must be owned by root:$SERVICE_GROUP_NAME with mode 0750."
}

is_release_directory() {
  local path="$1"
  local name
  name="$(basename "$path")"
  [[ "$(dirname "$path")" == "$release_root" && "$name" =~ ^[a-f0-9]{40}$ \
    && -d "$path" && ! -L "$path" ]]
}

resolve_pointer() {
  local pointer="$1"
  local label="$2"
  local target
  if [[ ! -e "$pointer" && ! -L "$pointer" ]]; then
    return 1
  fi
  [[ -L "$pointer" ]] || fail "$label exists but is not a symlink."
  target="$(readlink -f -- "$pointer")" || fail "$label is dangling."
  is_release_directory "$target" \
    || fail "$label resolves outside the production root's durable releases."
  printf '%s' "$target"
}

pointer_targets() {
  local pointer="$1"
  local expected="$2"
  local actual
  [[ -L "$pointer" ]] || return 1
  actual="$(readlink -f -- "$pointer" 2>/dev/null)" || return 1
  [[ "$actual" == "$expected" ]]
}

# Deliberate no-op seam used by local failure-injection fixtures immediately
# after an atomic rollback pointer write. Production execution never overrides it.
post_rollback_pointer_commit_checkpoint() {
  :
}

restore_active_pointer() {
  local restore_tmp
  if [[ "$had_active_pointer" == "true" ]]; then
    restore_tmp="$live_app/.current.restore.$source_sha.$$"
    rm -f -- "$restore_tmp"
    ln -s -- "$active_before" "$restore_tmp"
    mv -Tf -- "$restore_tmp" "$active_pointer"
    pointer_targets "$active_pointer" "$active_before" \
      || fail "Could not restore the pre-rollback active release pointer."
  elif pointer_targets "$active_pointer" "$rollback_app"; then
    rm -f -- "$active_pointer"
  elif [[ -e "$active_pointer" || -L "$active_pointer" ]]; then
    fail "Refusing to remove an active pointer not owned by this rollback attempt."
  fi
}

finalize_postcommit_pointer_bookkeeping() {
  local marker="$rollback_app/DEPLOYED_GIT_SHA"
  pointer_targets "$active_pointer" "$rollback_app" || return 1
  [[ -f "$marker" && ! -L "$marker" \
    && "$(tr -d '\r\n' < "$marker")" == "$source_sha" \
    && "$(stat -c '%u:%g:%a' -- "$marker" 2>/dev/null)" == "0:$SERVICE_GROUP_GID:440" ]] \
    || return 1
  if [[ -n "$previous_pointer_tmp" ]]; then
    mv -Tf -- "$previous_pointer_tmp" "$previous_pointer" || return 1
    previous_pointer_tmp=""
    pointer_targets "$previous_pointer" "$previous_target" || return 1
    post_rollback_pointer_commit_checkpoint previous
  fi
  activation_committed=true
  echo "vm217_rollback_remote_postcommit_pointer_bookkeeping sha=$source_sha active=$active_pointer full_reconciliation=required" >&2
}

cleanup_on_exit() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ "$activation_started" == "true" && "$activation_committed" != "true" ]]; then
    if finalize_postcommit_pointer_bookkeeping; then
      :
    else
      restore_active_pointer || exit_code=1
    fi
  fi
  if [[ -n "$previous_pointer_tmp" ]]; then
    rm -f -- "$previous_pointer_tmp" || exit_code=1
  fi
  if [[ -n "$incoming_release" && -d "$incoming_release" && ! -L "$incoming_release" ]]; then
    rm -rf -- "$incoming_release" || exit_code=1
  fi
  exit "$exit_code"
}

verify_release_contract() {
  local release="$1"
  local manifest="$release/.release/release-manifest.json"
  local entrypoint="$release/$remote_entrypoint"
  local verifier="$release/scripts/verify-release-artifacts.mjs"

  require_sha "$manifest" "$manifest_sha256" "Retained release manifest"
  require_sha "$entrypoint" "$entrypoint_sha256" "Retained remote rollback entrypoint"
  require_sha "$verifier" "$verifier_sha256" "Retained release verifier"
  node "$verifier" "$manifest" \
    --source-sha "$source_sha" \
    --deployment-root "$release" \
    --launch-proof-file "$launch_proof" \
    --launch-proof-mode rollback \
    --max-proof-age-seconds "$proof_max_age" >/dev/null

  [[ -z "$(find "$release" -mindepth 1 -type l -print -quit)" ]] \
    || fail "Durable rollback release contains a symlink."
  [[ -z "$(find "$release" -mindepth 1 ! -type d ! -type f -print -quit)" ]] \
    || fail "Durable rollback release contains an unsupported file type."
  [[ -z "$(find "$release" -type f \( -name .env -o -name runtime.env -o -name runtime-secret.json \) -print -quit)" ]] \
    || fail "Durable rollback release contains runtime secret material."
}

write_deployed_sha() {
  local release="$1"
  local pointer="$release/DEPLOYED_GIT_SHA"
  local pointer_tmp
  if [[ -f "$pointer" && ! -L "$pointer" && "$(tr -d '\r\n' < "$pointer")" == "$source_sha" ]]; then
    return
  fi
  [[ ! -e "$pointer" && ! -L "$pointer" ]] \
    || fail "Durable rollback release contains an invalid DEPLOYED_GIT_SHA."
  pointer_tmp="$(mktemp "$release/DEPLOYED_GIT_SHA.tmp.XXXXXX")"
  chmod 600 "$pointer_tmp"
  printf '%s\n' "$source_sha" > "$pointer_tmp"
  mv -T -- "$pointer_tmp" "$pointer"
}

lock_release_bytes() {
  local release="$1"
  local invalid

  find "$release" -type d -exec chown "root:$SERVICE_GROUP_GID" -- {} + -exec chmod 550 -- {} +
  find "$release" -type f ! -perm /0111 -exec chown "root:$SERVICE_GROUP_GID" -- {} + -exec chmod 440 -- {} +
  find "$release" -type f -perm /0111 -exec chown "root:$SERVICE_GROUP_GID" -- {} + -exec chmod 550 -- {} +

  invalid="$(find "$release" -type d \( ! -uid 0 -o ! -gid "$SERVICE_GROUP_GID" -o ! -perm 0550 \) -print -quit)"
  [[ -z "$invalid" ]] || fail "Durable rollback release directories are not immutable service-group traversable paths."
  invalid="$(find "$release" -type f \( ! -uid 0 -o ! -gid "$SERVICE_GROUP_GID" \) -print -quit)"
  [[ -z "$invalid" ]] || fail "Durable rollback release files have invalid ownership."
  invalid="$(find "$release" -type f ! -perm 0440 ! -perm 0550 -print -quit)"
  [[ -z "$invalid" ]] || fail "Durable rollback release files have permissions outside 0440/0550."
}

validate_release_identity() {
  local release="$1"
  local marker="$release/DEPLOYED_GIT_SHA"
  [[ -f "$marker" && ! -L "$marker" \
    && "$(tr -d '\r\n' < "$marker")" == "$source_sha" ]] \
    || fail "Durable rollback release identity does not match its source SHA."
  [[ "$(stat -c '%u:%g:%a' -- "$marker")" == "0:$SERVICE_GROUP_GID:440" ]] \
    || fail "Durable rollback release identity is not service-group readable and immutable."
}

prune_inactive_releases() {
  local current_target="$1"
  local previous_target="$2"
  local protected_count=1
  local kept
  local candidate
  local candidate_name
  local current_now
  local previous_now
  local -a inactive=()

  [[ "$current_target" != "$rollback_app" && -n "$current_target" ]] \
    && protected_count=$((protected_count + 1))
  [[ -n "$previous_target" && "$previous_target" != "$rollback_app" && "$previous_target" != "$current_target" ]] \
    && protected_count=$((protected_count + 1))
  (( protected_count <= retention_count )) \
    || fail "Rollback release retention cannot preserve the candidate, current, and previous releases."

  shopt -s nullglob
  for candidate in "$release_root"/*; do
    candidate_name="$(basename "$candidate")"
    [[ "$candidate_name" =~ ^[a-f0-9]{40}$ ]] || continue
    [[ -d "$candidate" && ! -L "$candidate" ]] \
      || fail "Durable release root contains an unsafe SHA-named entry."
    if [[ "$candidate" == "$rollback_app" || "$candidate" == "$current_target" || "$candidate" == "$previous_target" ]]; then
      continue
    fi
    inactive+=("$(stat -c '%Y' -- "$candidate") $candidate_name")
  done
  shopt -u nullglob

  if (( ${#inactive[@]} > 0 )); then
    mapfile -t inactive < <(printf '%s\n' "${inactive[@]}" | sort -k1,1nr -k2,2)
  fi
  kept="$protected_count"
  for candidate in "${inactive[@]}"; do
    candidate_name="${candidate#* }"
    candidate="$release_root/$candidate_name"
    if (( kept < retention_count )); then
      kept=$((kept + 1))
      continue
    fi

    current_now="$(resolve_pointer "$active_pointer" "Active release pointer" 2>/dev/null || true)"
    previous_now="$(resolve_pointer "$previous_pointer" "Previous release pointer" 2>/dev/null || true)"
    [[ "$candidate" != "$rollback_app" && "$candidate" != "$current_now" && "$candidate" != "$previous_now" ]] \
      || fail "Refusing to prune an active or previous durable release."
    [[ "$(dirname "$candidate")" == "$release_root" && "$candidate_name" =~ ^[a-f0-9]{40}$ \
      && -d "$candidate" && ! -L "$candidate" ]] \
      || fail "Refusing to prune an unsafe durable release path."
    rm -rf -- "$candidate"
  done
}

(( $# == 21 )) || fail "Retained rollback activation received an invalid argument count."
stage="$1"
archive="$stage/rollback-app.tar"
runtime_env="$stage/runtime.env"
descriptor="$stage/runtime-secret.json"
launch_proof="$stage/launch-proof.json"
compatibility_proof="$stage/old-release-compatibility.json"
compatibility_signature="$stage/old-release-compatibility.sigstore.json"
archive_sha256="$2"
runtime_env_sha256="$3"
descriptor_sha256="$4"
launch_proof_sha256="$5"
manifest_sha256="$6"
entrypoint_sha256="$7"
verifier_sha256="$8"
compatibility_proof_sha256="$9"
compatibility_signature_sha256="${10}"
source_sha="${11}"
compatibility_candidate_source_sha="${12}"
live_app="${13}"
remote_entrypoint="${14}"
compose_project="${15}"
production_api_health_url="$(decode_required "${16}" PRODUCTION_API_HEALTH_URL)"
production_web_url="$(decode_required "${17}" PRODUCTION_WEB_URL)"
protected_channel="${18}"
protected_channel_sha256="${19}"
proof_max_age="${20}"
retention_count="${21}"

for command_name in awk base64 cat chmod chown find flock getent mkdir mktemp mv node readlink realpath rm sha256sum sort stat tar tr; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required for retained rollback activation."
done

[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]] || fail "Retained rollback source SHA is invalid."
[[ "$compatibility_candidate_source_sha" =~ ^[a-f0-9]{40}$ && "$compatibility_candidate_source_sha" != "$source_sha" ]] \
  || fail "Retained rollback compatibility candidate source SHA is invalid."
[[ "$compose_project" == "lunchlineup" ]] || fail "Compose project name must remain lunchlineup."
[[ "$proof_max_age" =~ ^[1-9][0-9]*$ ]] || fail "Launch proof maximum age must be a positive integer."
[[ "$retention_count" =~ ^[0-9]+$ && "$retention_count" -ge 3 && "$retention_count" -le 20 ]] \
  || fail "Rollback release retention count must be between 3 and 20."
require_safe_relative_path "$remote_entrypoint" "Remote rollback entrypoint"
require_normalized_absolute_path "$stage" "Remote rollback stage"
require_normalized_absolute_path "$live_app" "Production root"
[[ "$protected_channel" == "$stage/protected-channel" ]] \
  || fail "Protected launch-proof channel must remain inside remote staging."
resolve_service_group

[[ -d "$stage" && ! -L "$stage" && "$(realpath -e -- "$stage")" == "$stage" ]] \
  || fail "Remote rollback stage must be a canonical non-symlink directory."
[[ -d "$live_app" && ! -L "$live_app" && "$(realpath -e -- "$live_app")" == "$live_app" ]] \
  || fail "Production root must be a canonical non-symlink directory."

release_root="$live_app/releases"
active_pointer="$live_app/current"
previous_pointer="$live_app/previous"
rollback_app="$release_root/$source_sha"
normalize_managed_directory "$live_app" "Production root"
mkdir -p -- "$release_root"
normalize_managed_directory "$release_root" "Durable release root"
[[ -d "$release_root" && ! -L "$release_root" && "$(realpath -e -- "$release_root")" == "$release_root" ]] \
  || fail "Durable release root must be a canonical non-symlink directory."
[[ "$(stat -c '%d' -- "$live_app")" == "$(stat -c '%d' -- "$release_root")" ]] \
  || fail "Durable release root must share the production root filesystem."

exec 9>"$live_app/.rollback-activation.lock"
chmod 600 "$live_app/.rollback-activation.lock"
flock -n 9 || fail "Another retained rollback activation is already running."

require_sha "$archive" "$archive_sha256" "Retained rollback application archive"
require_sha "$runtime_env" "$runtime_env_sha256" "Rehydrated runtime environment"
require_sha "$descriptor" "$descriptor_sha256" "Runtime secret descriptor"
require_sha "$launch_proof" "$launch_proof_sha256" "Retained launch proof"
require_sha "$compatibility_proof" "$compatibility_proof_sha256" "Signed old-release compatibility proof"
require_sha "$compatibility_signature" "$compatibility_signature_sha256" "Old-release compatibility signature bundle"
require_sha "$protected_channel" "$protected_channel_sha256" "Protected launch-proof channel"
[[ "$(stat -c '%a' -- "$protected_channel")" == "600" ]] \
  || fail "Protected launch-proof channel must have mode 0600."
IFS= read -r launch_proof_manifest_uri < "$protected_channel"
[[ -n "$launch_proof_manifest_uri" && "$launch_proof_manifest_uri" != *$'\n'* && "$launch_proof_manifest_uri" != *$'\r'* ]] \
  || fail "Protected launch-proof URI must be a non-empty single-line value."

had_active_pointer=false
active_before=""
if active_before="$(resolve_pointer "$active_pointer" "Active release pointer")"; then
  had_active_pointer=true
fi
previous_before="$(resolve_pointer "$previous_pointer" "Previous release pointer" 2>/dev/null || true)"

incoming_release=""
previous_pointer_tmp=""
activation_started=false
activation_committed=false
trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -e "$rollback_app" || -L "$rollback_app" ]]; then
  [[ -d "$rollback_app" && ! -L "$rollback_app" ]] \
    || fail "Durable rollback release path is not a regular directory."
  [[ "$(stat -c '%d' -- "$rollback_app")" == "$(stat -c '%d' -- "$release_root")" ]] \
    || fail "Durable rollback release crosses the production root filesystem."
  verify_release_contract "$rollback_app"
  write_deployed_sha "$rollback_app"
  lock_release_bytes "$rollback_app"
  validate_release_identity "$rollback_app"
else
  incoming_release="$release_root/.incoming-$source_sha.$$"
  mkdir -m 700 -- "$incoming_release"
  [[ "$(stat -c '%d' -- "$incoming_release")" == "$(stat -c '%d' -- "$release_root")" ]] \
    || fail "Incoming rollback release crosses the durable release filesystem."
  tar --extract --file "$archive" --directory "$incoming_release" --no-same-owner --no-same-permissions
  verify_release_contract "$incoming_release"
  write_deployed_sha "$incoming_release"
  lock_release_bytes "$incoming_release"
  validate_release_identity "$incoming_release"
  mv -T -- "$incoming_release" "$rollback_app"
  incoming_release=""
fi

previous_target="$previous_before"
if [[ -n "$active_before" && "$active_before" != "$live_app" && "$active_before" != "$rollback_app" ]]; then
  previous_target="$active_before"
elif [[ "$active_before" == "$rollback_app" ]]; then
  previous_target="$previous_before"
fi
[[ "$previous_target" != "$rollback_app" ]] || previous_target=""

[[ -n "$active_before" ]] \
  || fail "Rollback activation requires an existing durable current release."
candidate_deployment_root="$release_root/$compatibility_candidate_source_sha"
is_release_directory "$candidate_deployment_root" \
  || fail "The failed candidate is not retained at its exact releases/<source SHA> path."
candidate_manifest="$candidate_deployment_root/.release/release-manifest.json"
[[ -f "$candidate_manifest" && ! -L "$candidate_manifest" ]] \
  || fail "The failed candidate retained release is missing its release manifest."
node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (manifest.sourceSha !== process.argv[2]) process.exit(1);
' "$candidate_manifest" "$compatibility_candidate_source_sha" \
  || fail "The failed candidate retained release manifest does not match the compatibility proof SHA."

if [[ -n "$previous_target" ]]; then
  previous_pointer_tmp="$live_app/.previous.$source_sha.$$"
  rm -f -- "$previous_pointer_tmp"
  ln -s -- "$previous_target" "$previous_pointer_tmp"
fi

remote_env=(
  "APP_DIR=$rollback_app"
  "ROLLBACK_DEPLOYMENT_APP_DIR=$rollback_app"
  "ROLLBACK_CANDIDATE_DEPLOYMENT_ROOT=$candidate_deployment_root"
  "ROLLBACK_CANDIDATE_RELEASE_MANIFEST_PATH=$candidate_deployment_root/.release/release-manifest.json"
  "ROLLBACK_CANDIDATE_SOURCE_SHA=$compatibility_candidate_source_sha"
  "OLD_RELEASE_COMPATIBILITY_PROOF_PATH=$compatibility_proof"
  "OLD_RELEASE_COMPATIBILITY_PROOF_SHA256=$compatibility_proof_sha256"
  "OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_PATH=$compatibility_signature"
  "OLD_RELEASE_COMPATIBILITY_SIGNATURE_BUNDLE_SHA256=$compatibility_signature_sha256"
  "ACTIVE_RELEASE_POINTER=$active_pointer"
  "LUNCHLINEUP_SERVICE_GROUP=$SERVICE_GROUP_NAME"
  "COMPOSE_PROJECT_NAME=$compose_project"
  "COMPOSE_PROJECT_DIRECTORY=$rollback_app"
  "COMPOSE_FILE=$rollback_app/docker-compose.yml"
  "RELEASE_SOURCE_SHA=$source_sha"
  "RELEASE_MANIFEST_PATH=$rollback_app/.release/release-manifest.json"
  "PRODUCTION_RUNTIME_ENV_PATH=$runtime_env"
  "COMPOSE_SERVICE_ENV_FILE=$runtime_env"
  "PRODUCTION_RUNTIME_ENV_SHA256=$runtime_env_sha256"
  "LAUNCH_PROOF_PATH=$launch_proof"
  "LAUNCH_PROOF_ARTIFACT_SHA256=$launch_proof_sha256"
  "LAUNCH_PROOF_MAX_AGE_SECONDS=$proof_max_age"
  "LAUNCH_PROOF_MANIFEST_URI=$launch_proof_manifest_uri"
  "PRODUCTION_API_HEALTH_URL=$production_api_health_url"
  "PRODUCTION_WEB_URL=$production_web_url"
  "TRANSPORT_RELEASE_MANIFEST_SHA256=$manifest_sha256"
  "VM217_DEPLOY_OPERATION=rollback"
  "DEPLOY_MIGRATION_MODE=skip"
  "ROLLBACK_SCHEMA_COMPATIBILITY_CONFIRM=verified-compatible-with-current-schema:$source_sha"
)

activation_started=true
(
  cd "$rollback_app"
  env "${remote_env[@]}" bash "$rollback_app/$remote_entrypoint"
)

[[ -f "$rollback_app/DEPLOYED_GIT_SHA" && ! -L "$rollback_app/DEPLOYED_GIT_SHA" \
  && "$(tr -d '\r\n' < "$rollback_app/DEPLOYED_GIT_SHA")" == "$source_sha" ]] \
  || fail "Remote rollback entrypoint did not retain the expected source SHA."
pointer_targets "$active_pointer" "$rollback_app" \
  || fail "Remote rollback entrypoint did not atomically activate the durable retained release."
post_rollback_pointer_commit_checkpoint active
lock_release_bytes "$rollback_app"
validate_release_identity "$rollback_app"
[[ "$(tr -d '\r\n' < "$active_pointer/DEPLOYED_GIT_SHA")" == "$source_sha" ]] \
  || fail "Active release identity marker is stale after rollback."
if [[ -n "$previous_pointer_tmp" ]]; then
  mv -Tf -- "$previous_pointer_tmp" "$previous_pointer"
  previous_pointer_tmp=""
  pointer_targets "$previous_pointer" "$previous_target" \
    || fail "Previous release pointer did not preserve the pre-rollback release."
  post_rollback_pointer_commit_checkpoint previous
fi
activation_committed=true

prune_inactive_releases "$rollback_app" "$previous_target"
echo "vm217_rollback_remote_ok sha=$source_sha active=$active_pointer release=$rollback_app retention=$retention_count"
